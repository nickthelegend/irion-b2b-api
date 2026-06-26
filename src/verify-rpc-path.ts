// Definitive headless validation of the shim's /rpc JSON-RPC path — the EXACT
// methods Carpincho uses (version, prepareTransaction, executePrepared), with the
// exact body shapes (captured from a real SDK run) and a real Ed25519 signature
// (tweetnacl, the same primitive the Canton signing lib uses). If this lands a
// real Irion UnsecuredRequest via /rpc, the wallet→shim→ledger JSON-RPC contract
// is proven end-to-end. Only Carpincho's choice of param NAMES could differ — the
// shim forwards verbatim, so a 1-line tweak covers that.
//
// Run (sandbox + shim up): `npx tsx src/verify-rpc-path.ts`
import { SDK } from '@canton-network/wallet-sdk';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { randomUUID } from 'node:crypto';
import * as store from './store.js';

function staticJwt(sub = 'ledger-api-user') {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, aud: '', iat: now, exp: now + 31536000 })}.sig`;
}

const SHIM = process.env.SHIM_URL ?? 'http://localhost:3011';
const RPC = SHIM + '/rpc';
const operator = store.loadState().operator;

async function rpc(method: string, params: unknown): Promise<any> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: Date.now(), jsonrpc: '2.0', method, params }) });
  const j: any = await r.json();
  if (j.error) throw new Error(`/rpc ${method} → ${JSON.stringify(j.error).slice(0, 220)}`);
  return j.result;
}

// 0) version via /rpc
console.log('✓ /rpc version →', (await rpc('version', undefined)).version);

// 1) onboard a fresh self-custody party (SDK via the shim's /v2 proxy)
const sdk: any = await SDK.create({ auth: { method: 'static', token: staticJwt() } as any, ledgerClientUrl: SHIM });
await fetch(SHIM + '/v2/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: { id: 'ledger-api-user', identityProviderId: '' }, rights: [] }) }).catch(() => {});
const kp = sdk.keys.generate();
await (await sdk.party.external.create(kp.publicKey).sign(kp.privateKey)).execute();
const fingerprint = String(await sdk.keys.fingerprint(kp.publicKey));
const parties: any = await fetch(SHIM + '/v2/parties').then((r) => r.json());
const party: string = (parties.partyDetails ?? []).map((p: any) => p.party).find((p: string) => p.includes(fingerprint));
console.log('✓ onboarded party:', party);

const cs: any = await fetch(SHIM + '/v2/state/connected-synchronizers').then((r) => r.json());
const synchronizerId: string | undefined = cs?.connectedSynchronizers?.[0]?.synchronizerId ?? (Array.isArray(cs) ? cs[0]?.synchronizerId : undefined);
if (!synchronizerId) throw new Error('no synchronizerId from ' + JSON.stringify(cs).slice(0, 160));

// 2) PREPARE — through /rpc prepareTransaction (Carpincho's exact method)
const prepared = await rpc('prepareTransaction', {
  userId: 'ledger-api-user', synchronizerId, commandId: randomUUID(), verboseHashing: false,
  actAs: [party], readAs: [], disclosedContracts: [], packageIdSelectionPreference: [],
  commands: [{ CreateCommand: { templateId: '#irion-model:Irion.Bnpl:UnsecuredRequest', createArguments: { operator, borrower: party, amount: '25.0', termSeconds: '2592000' } } }],
});
console.log('✓ /rpc prepareTransaction → preparedTransactionHash (len', String(prepared.preparedTransactionHash).length, ')');

// 3) SIGN the hash with the fresh key (Ed25519, exactly as core-signing-lib does)
const signature = naclUtil.encodeBase64(nacl.sign.detached(naclUtil.decodeBase64(prepared.preparedTransactionHash), naclUtil.decodeBase64(kp.privateKey)));

// 4) EXECUTE — through /rpc executePrepared (Carpincho's exact method)
await rpc('executePrepared', {
  userId: 'ledger-api-user', preparedTransaction: prepared.preparedTransaction,
  hashingSchemeVersion: prepared.hashingSchemeVersion ?? 'HASHING_SCHEME_VERSION_V2',
  submissionId: randomUUID(), deduplicationPeriod: { Empty: {} },
  partySignatures: { signatures: [{ party, signatures: [{ signature, signedBy: fingerprint, format: 'SIGNATURE_FORMAT_CONCAT', signingAlgorithmSpec: 'SIGNING_ALGORITHM_SPEC_ED25519' }] }] },
});
console.log('✓ /rpc executePrepared → submitted');

// 5) confirm it landed on the ledger
const { offset }: any = await fetch(SHIM + '/v2/state/ledger-end').then((r) => r.json());
const acs: any[] = await fetch(SHIM + '/v2/state/active-contracts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filter: { filtersByParty: { [party]: { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] } } }, verbose: false, activeAtOffset: offset }) }).then((r) => r.json());
const found = acs.map((e) => e.contractEntry?.JsActiveContract?.createdEvent).filter(Boolean).find((e: any) => e.templateId.endsWith(':UnsecuredRequest') && e.createArgument.borrower === party);
console.log(found
  ? '✅ /rpc JSON-RPC PATH VERIFIED — version + prepareTransaction + executePrepared (Carpincho\'s exact methods) signed + landed a real Irion UnsecuredRequest on the ledger.'
  : '❌ UnsecuredRequest not found — /rpc path did not land the tx.');
