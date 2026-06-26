// FULL bridge: a Canton external party whose key is held by PRIVY.
// Onboard (Privy signs the topology) + sign a real transfer (Privy signs the tx
// hash), then verify on-ledger. Run: npx tsx src/privy-canton-spike.ts
import { SDK } from '@canton-network/wallet-sdk';
import { readFileSync } from 'node:fs';

process.loadEnvFile?.('.env');
const LEDGER = process.env.CANTON_JSON_API ?? 'http://localhost:6864';
const APP_ID = process.env.PRIVY_APP_ID!;
const SECRET = process.env.PRIVY_APP_SECRET!;
const PH = { Authorization: 'Basic ' + Buffer.from(`${APP_ID}:${SECRET}`).toString('base64'), 'privy-app-id': APP_ID, 'content-type': 'application/json' };
const privy = (p: string, b?: unknown) => fetch('https://api.privy.io' + p, { method: 'POST', headers: PH, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
const privySign = async (walletId: string, hashB64: string) => (await privy(`/v1/wallets/${walletId}/rpc`, { method: 'signMessage', params: { message: hashB64, encoding: 'base64' } }))?.data?.signature as string;

function b58decode(str: string): Uint8Array {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; const bytes: number[] = [];
  for (const ch of str) { let c = A.indexOf(ch); if (c < 0) throw new Error('bad b58'); for (let j = 0; j < bytes.length; j++) { c += bytes[j] * 58; bytes[j] = c & 0xff; c >>= 8; } while (c > 0) { bytes.push(c & 0xff); c >>= 8; } }
  for (const ch of str) { if (ch !== '1') break; bytes.push(0); } return Uint8Array.from(bytes.reverse());
}
function staticJwt() { const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url'); const n = Math.floor(Date.now() / 1000); return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'ledger-api-user', aud: '', iat: n, exp: n + 31536000 })}.c2ln`; }

async function main() {
  const state = JSON.parse(readFileSync('.irion-state.json', 'utf8'));
  const sdk: any = await SDK.create({ auth: { method: 'static', token: staticJwt() } as any, ledgerClientUrl: LEDGER });
  await fetch(LEDGER + '/v2/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: { id: 'ledger-api-user', identityProviderId: '' }, rights: [] }) }).catch(() => {});

  console.log('1) Privy creates a Solana (Ed25519) wallet — Privy holds the key');
  const w = await privy('/v1/wallets', { chain_type: 'solana' });
  const pubB64 = Buffer.from(b58decode(w.address)).toString('base64');
  console.log('   privy wallet', w.id, '| pubkey', pubB64);

  console.log('2) onboard a Canton external party with that key — PRIVY signs the topology');
  const prep: any = sdk.party.external.create(pubB64);
  const topo: any = await prep.topology();
  const topoSig = await privySign(w.id, topo.multiHash);
  const created: any = await prep.execute(topoSig);
  const alice = created.partyId;
  console.log('   onboarded external party ->', alice);

  console.log('3) issuer mints 10 USDC to the Privy-backed party');
  const mint: any = await fetch(LEDGER + '/v2/commands/submit-and-wait-for-transaction-tree', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId: 'mint-' + Date.now(), userId: 'ledger-api-user', actAs: [state.usdcIssuer], readAs: [], commands: [{ CreateCommand: { templateId: '#irion-model:Irion.Token:Token', createArguments: { issuer: state.usdcIssuer, owner: alice, amount: '10.0' } } }] }) }).then((r) => r.json());
  const tok: any = Object.values(mint.transactionTree?.eventsById ?? {}).map((e: any) => e.CreatedTreeEvent?.value).filter(Boolean)[0];
  console.log('   token', tok.contractId.slice(0, 16) + '…');

  console.log('4) PRIVY signs a Token_Transfer (prepare -> Privy sign hash -> execute)');
  const prepared: any = await sdk.ledger.prepare({ partyId: alice, commands: [{ ExerciseCommand: { templateId: '#irion-model:Irion.Token:Token', contractId: tok.contractId, choice: 'Token_Transfer', choiceArgument: { newOwner: state.operator } } }] });
  const { response }: any = await prepared.toJSON();
  const txSig = await privySign(w.id, response.preparedTransactionHash);
  const signed: any = sdk.ledger.fromSignature(response, txSig);
  await sdk.ledger.execute(signed, { partyId: alice });

  const end: any = await fetch(LEDGER + '/v2/state/ledger-end').then((r) => r.json());
  const acs: any = await fetch(LEDGER + '/v2/state/active-contracts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filter: { filtersByParty: { [state.operator]: { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] } } }, verbose: false, activeAtOffset: end.offset }) }).then((r) => r.json());
  const got = (acs as any[]).map((e) => e.contractEntry?.JsActiveContract?.createdEvent).some((e: any) => e?.templateId.endsWith(':Token') && e.createArgument.owner === state.operator && Number(e.createArgument.amount) === 10);
  console.log('5) VERIFY on-ledger: operator received the 10 USDC:', got ? 'YES ✓' : 'NO ✗');
  console.log(got ? '\n🔑 PRIVY-SIGNED CANTON TRANSACTION: PROVEN ✓ — Privy held the key, Privy signed, Canton accepted.' : '\n❌ investigate');
}
main().catch((e) => console.error('ERR', e?.message ?? e, e?.stack?.split('\n').slice(0, 4).join('\n')));
