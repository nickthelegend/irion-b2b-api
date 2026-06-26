// Headless verification of the wallet-service SHIM as a complete wallet↔ledger
// conduit. A simulated self-custody wallet (the @canton-network/wallet-sdk, the
// same Ed25519 prepare→sign→execute flow a browser CIP-0103 wallet uses) is
// pointed at the shim (:3011) — NOT the sandbox directly. If a fresh key can
// onboard an external party AND sign a real Irion `UnsecuredRequest` that lands
// on the ledger, all routed through the shim, then the shim correctly carries the
// real Canton external-party protocol. (Only Carpincho's exact JSON-RPC envelope
// is then the residual — its bodies are the same interactive-submission payloads.)
//
// Run (with the sandbox + shim up): `npx tsx src/verify-shim-signing.ts`
import { SDK } from '@canton-network/wallet-sdk';
import * as store from './store.js';

function staticJwt(sub = 'ledger-api-user') {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000); // far-future expiry; the open sandbox ignores it anyway
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, aud: '', iat: now, exp: now + 31536000 })}.sig`;
}

const SHIM = process.env.SHIM_URL ?? 'http://localhost:3011';
const operator = store.loadState().operator;
console.log('routing the wallet SDK through the shim:', SHIM);

const sdk: any = await SDK.create({ auth: { method: 'static', token: staticJwt() } as any, ledgerClientUrl: SHIM });
await fetch(SHIM + '/v2/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: { id: 'ledger-api-user', identityProviderId: '' }, rights: [] }) }).catch(() => {});

// 1) fresh self-custody key → onboard a Canton external party, THROUGH the shim
const kp = sdk.keys.generate();
const onboard = sdk.party.external.create(kp.publicKey);
const signedTopo = await onboard.sign(kp.privateKey);
await signedTopo.execute();
const fingerprint = String(await sdk.keys.fingerprint(kp.publicKey));
const parties: any = await fetch(SHIM + '/v2/parties').then((r) => r.json());
const party: string | undefined = (parties.partyDetails ?? []).map((p: any) => p.party).find((p: string) => p.includes(fingerprint));
if (!party) throw new Error('external party not found after onboarding through the shim');
console.log('✓ onboarded external party THROUGH the shim:', party);

// 2) the fresh key SIGNS a real Irion UnsecuredRequest — prepare→sign→execute, all via the shim
const prep: any = await sdk.ledger.prepare({
  partyId: party,
  commands: [{ CreateCommand: { templateId: '#irion-model:Irion.Bnpl:UnsecuredRequest', createArguments: { operator, borrower: party, amount: '25.0', termSeconds: String(30 * 86400) } } }],
});
const signedTx: any = await prep.sign(kp.privateKey);
const exec: any = await sdk.ledger.execute(signedTx, { partyId: party });
console.log('✓ prepared + signed + executed through the shim. updateId:', exec?.updateId ?? exec?.completionOffset ?? '(ok)');

// 3) confirm the request is live on the ledger, signed by the fresh party
const { offset }: any = await fetch(SHIM + '/v2/state/ledger-end').then((r) => r.json());
const acs: any[] = await fetch(SHIM + '/v2/state/active-contracts', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ filter: { filtersByParty: { [party]: { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] } } }, verbose: false, activeAtOffset: offset }),
}).then((r) => r.json());
const found = acs.map((e) => e.contractEntry?.JsActiveContract?.createdEvent).filter(Boolean)
  .find((e: any) => e.templateId.endsWith(':UnsecuredRequest') && e.createArgument.borrower === party);

console.log(found
  ? '✅ SHIM VERIFIED — a fresh self-custody key onboarded + signed a real Irion UnsecuredRequest, executed entirely THROUGH the shim, now live on the ledger.'
  : '❌ UnsecuredRequest not found on ledger — shim did not carry the flow.');
