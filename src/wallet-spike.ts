// Spike: does real EXTERNAL-PARTY signing work on the sandbox via the Wallet SDK?
// Generate an Ed25519 key, onboard an external party (user holds the key),
// then we'll do prepare->sign->execute. Run: npx tsx src/wallet-spike.ts
import { SDK, signTransactionHash } from '@canton-network/wallet-sdk';
import { readFileSync } from 'node:fs';

const LEDGER = process.env.CANTON_JSON_API ?? 'http://localhost:6864';

// The unauthenticated sandbox ignores the token, but the SDK parses it as a JWT
// and checks expiry client-side. So mint a valid, far-future JWT (fake sig is fine).
function staticJwt(sub = 'ledger-api-user') {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64({ sub, aud: '', iat: now, exp: now + 3600 * 24 * 365 });
  return `${header}.${payload}.c2ln`;
}

async function main() {
  console.log('1) SDK.create');
  const sdk: any = await SDK.create({ auth: { method: 'static', token: staticJwt() } as any, ledgerClientUrl: LEDGER });
  console.log('   namespaces:', Object.keys(sdk));

  console.log('2) keys.generate()');
  const kp: any = sdk.keys.generate();
  console.log('   keyPair fields:', Object.keys(kp));
  const fp = await sdk.keys.fingerprint(kp.publicKey);
  console.log('   fingerprint:', String(fp).slice(0, 24) + '…');

  console.log('2.5) ensure ledger user exists (so grantRights works)');
  const ur = await fetch(LEDGER + '/v2/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: { id: 'ledger-api-user', identityProviderId: '' }, rights: [] }) });
  console.log('   create user ->', ur.status, (await ur.text()).slice(0, 100));

  console.log('3) party.external.create(publicKey)');
  const prep: any = sdk.party.external.create(kp.publicKey);
  console.log('   prepared methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(prep)));

  console.log('4) sign(privateKey) + execute() to ONBOARD the external party');
  const signed: any = await prep.sign(kp.privateKey);
  console.log('   after sign:', typeof signed, signed && Object.getOwnPropertyNames(Object.getPrototypeOf(signed)));
  const created: any = await (signed?.execute ? signed.execute() : prep.execute());
  console.log('   onboarded ->', JSON.stringify(created).slice(0, 300));

  const allParties: any = await fetch(LEDGER + '/v2/parties').then((r) => r.json());
  const found = (allParties.partyDetails ?? []).map((p: any) => p.party).find((p: string) => p.includes(String(fp)));
  const alice = String(found ?? created?.partyId ?? prep?.partyId ?? (await sdk.party.list()).slice(-1)[0]);
  console.log('5) EXTERNAL PARTY ONBOARDED ✓ ->', alice);

  const state = JSON.parse(readFileSync('.irion-state.json', 'utf8'));
  console.log('6) issuer mints a 10 USDC Token to the external party');
  const mint: any = await fetch(LEDGER + '/v2/commands/submit-and-wait-for-transaction-tree', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: 'mint-' + Date.now(), userId: 'ledger-api-user', actAs: [state.usdcIssuer], readAs: [], commands: [{ CreateCommand: { templateId: '#irion-model:Irion.Token:Token', createArguments: { issuer: state.usdcIssuer, owner: alice, amount: '10.0' } } }] }),
  }).then((r) => r.json());
  const tok: any = Object.values(mint.transactionTree?.eventsById ?? {}).map((e: any) => e.CreatedTreeEvent?.value).filter(Boolean)[0];
  if (!tok) throw new Error('mint failed: ' + JSON.stringify(mint).slice(0, 200));
  console.log('   token cid:', tok.contractId.slice(0, 16) + '…  amount', tok.createArgument.amount);

  console.log('7) the EXTERNAL KEY signs a Token_Transfer (prepare -> sign -> execute)');
  const prepared: any = await sdk.ledger.prepare({ partyId: alice, commands: [{ ExerciseCommand: { templateId: '#irion-model:Irion.Token:Token', contractId: tok.contractId, choice: 'Token_Transfer', choiceArgument: { newOwner: state.operator } } }] });
  console.log('   prepared methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(prepared)));
  const signedTx: any = await prepared.sign(kp.privateKey);
  const exec: any = await sdk.ledger.execute(signedTx, { partyId: alice });
  console.log('   executed ->', JSON.stringify(exec).slice(0, 120));
  const end: any = await fetch(LEDGER + '/v2/state/ledger-end').then((r) => r.json());
  const acs: any = await fetch(LEDGER + '/v2/state/active-contracts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filter: { filtersByParty: { [state.operator]: { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] } } }, verbose: false, activeAtOffset: end.offset }) }).then((r) => r.json());
  const got = (acs as any[]).map((e) => e.contractEntry?.JsActiveContract?.createdEvent).some((e: any) => e?.templateId.endsWith(':Token') && e.createArgument.owner === state.operator && Number(e.createArgument.amount) === 10);
  console.log('8) VERIFY on-ledger: operator received the 10 USDC from the external party:', got ? 'YES ✓' : 'NO ✗');
  console.log(got ? "\nREAL EXTERNAL SIGNING: PROVEN ✓ — the user's own Ed25519 key authorized a real on-ledger transfer." : '\n(verification failed — investigate)');
}

main().catch((e) => {
  console.error('\nSPIKE ERROR:', e?.message ?? e);
  if (e?.stack) console.error(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
