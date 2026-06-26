// Decisive test: is a Privy (Solana/Ed25519) signature Canton-compatible?
// If verifySignedTxHash(hash, privyPubKey, privySig) === true, the bridge works.
import { createKeyPair, signTransactionHash, verifySignedTxHash } from '@canton-network/core-signing-lib';
import { randomBytes } from 'node:crypto';

process.loadEnvFile?.('.env');
const APP_ID = process.env.PRIVY_APP_ID!;
const SECRET = process.env.PRIVY_APP_SECRET!;
const PH = { Authorization: 'Basic ' + Buffer.from(`${APP_ID}:${SECRET}`).toString('base64'), 'privy-app-id': APP_ID, 'content-type': 'application/json' };
const privy = (p: string, b?: unknown) => fetch('https://api.privy.io' + p, { method: 'POST', headers: PH, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());

function b58decode(str: string): Uint8Array {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const bytes: number[] = [];
  for (const ch of str) {
    let c = A.indexOf(ch);
    if (c < 0) throw new Error('bad base58');
    for (let j = 0; j < bytes.length; j++) { c += bytes[j] * 58; bytes[j] = c & 0xff; c >>= 8; }
    while (c > 0) { bytes.push(c & 0xff); c >>= 8; }
  }
  for (const ch of str) { if (ch !== '1') break; bytes.push(0); }
  return Uint8Array.from(bytes.reverse());
}

async function main() {
  // A) learn the SDK signing format with a local keypair (round-trip)
  const kp = createKeyPair();
  console.log('A) SDK keypair: pub', kp.publicKey.length, 'chars, priv', kp.privateKey.length, 'chars');
  const hash = randomBytes(32);
  let hashEnc = 'hex';
  for (const enc of ['hex', 'base64'] as const) {
    const h = hash.toString(enc);
    try {
      const sig = signTransactionHash(h, kp.privateKey);
      const ok = verifySignedTxHash(h, kp.publicKey, sig);
      console.log(`   hash=${enc}: sign+verify -> ${ok}`);
      if (ok) hashEnc = enc;
    } catch (e: any) { console.log(`   hash=${enc}: ERR ${e.message}`); }
  }

  // B) Privy wallet signs the SAME hash; check Canton verifies it
  console.log('B) Privy Solana wallet signs a Canton hash');
  const w = await privy('/v1/wallets', { chain_type: 'solana' });
  const pubB64 = Buffer.from(b58decode(w.address)).toString('base64');
  console.log('   privy pubkey -> base64:', pubB64, '(len', b58decode(w.address).length, 'bytes)');
  const sigResp = await privy(`/v1/wallets/${w.id}/rpc`, { method: 'signMessage', params: { message: hash.toString('base64'), encoding: 'base64' } });
  const privySig = sigResp?.data?.signature;
  console.log('   privy signature:', String(privySig).slice(0, 24) + '…');
  let pass = false;
  for (const enc of ['hex', 'base64'] as const) {
    try {
      const ok = verifySignedTxHash(hash.toString(enc), pubB64, privySig);
      console.log(`   verifySignedTxHash(hash=${enc}, privyPub, privySig) -> ${ok}`);
      pass = pass || ok;
    } catch (e: any) { console.log(`   verify ${enc}: ERR ${e.message}`); }
  }
  console.log(pass ? '\n✅ PRIVY SIGNATURES ARE CANTON-COMPATIBLE — the bridge works.' : '\n❌ signature mismatch — needs format adjustment.');
}
main().catch((e) => console.error('ERR', e?.message ?? e));
