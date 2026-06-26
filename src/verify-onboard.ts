// Simulate Carpincho's "create account" against the gateway: generate an Ed25519
// key, /admin/party/prepare → sign the multiHash → /admin/party/complete → party
// onboarded on THIS sandbox. Then prepareTransaction for it must succeed.
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';

const SHIM = 'http://localhost:3011';
const post = (p: string, b: unknown) => fetch(SHIM + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());

const kp = nacl.sign.keyPair();
const publicKeyBase64 = naclUtil.encodeBase64(kp.publicKey);

const prep: any = await post('/admin/party/prepare', { publicKeyBase64, partyHint: 'testacct' });
console.log('prepare →', prep.onboardingId ? `onboardingId=${prep.onboardingId} multiHash(${String(prep.multiHash).length})` : `ERROR ${JSON.stringify(prep)}`);
if (!prep.multiHash) process.exit(1);

const signatureBase64 = naclUtil.encodeBase64(nacl.sign.detached(naclUtil.decodeBase64(prep.multiHash), kp.secretKey));
const done: any = await post('/admin/party/complete', { onboardingId: prep.onboardingId, signatureBase64 });
console.log('complete →', done.partyId ? `✅ party ${done.partyId}` : `ERROR ${JSON.stringify(done)}`);
if (!done.partyId) process.exit(1);

const operator = await fetch('http://localhost:8088/v1/health').then((r) => r.json()).then((h: any) => h.operator);
const pt: any = await post('/rpc', { id: 1, jsonrpc: '2.0', method: 'prepareTransaction', params: { partyId: done.partyId, commands: [{ CreateCommand: { templateId: '#irion-model:Irion.Bnpl:UnsecuredRequest', createArguments: { operator, borrower: done.partyId, amount: '10.0', termSeconds: '2592000' } } }] } });
if (pt.error) { console.log('prepareTransaction → ❌', JSON.stringify(pt.error).slice(0, 160)); process.exit(1); }
console.log('prepareTransaction → ✅ prepared (hash', String(pt.result?.preparedTransactionHash).length, ')');

// Carpincho signs the hash, then executePrepared with just its signature.
const txSig = naclUtil.encodeBase64(nacl.sign.detached(naclUtil.decodeBase64(pt.result.preparedTransactionHash), kp.secretKey));
const ex: any = await post('/rpc', { id: 2, jsonrpc: '2.0', method: 'executePrepared', params: { ...pt.result, partyId: done.partyId, signatureBase64: txSig } });
console.log('executePrepared →', ex.error ? `❌ ${JSON.stringify(ex.error).slice(0, 200)}` : `✅ ${JSON.stringify(ex.result).slice(0, 100)}`);
console.log(ex.error ? '' : '🎉 FULL FLOW WORKS: onboard → prepare → sign → execute landed a real tx on the ledger');
