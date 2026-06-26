// AES-256-GCM encryption for at-rest custody of Canton private keys.
// The platform holds each business's operational key encrypted (see keystore.ts)
// so automated treasury rebalancing + scheduled payroll can sign unattended.
// Master key from IRION_MASTER_KEY. PRODUCTION: replace with a KMS/HSM — an
// env-held symmetric key is demo-grade only.
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

let warned = false;
function masterKey(): Buffer {
  const env = process.env.IRION_MASTER_KEY;
  if (env) {
    const raw = Buffer.from(env, 'base64');
    if (raw.length === 32) return raw;
    return createHash('sha256').update(env).digest(); // any string → 32 bytes
  }
  if (!warned) {
    console.warn('⚠️  IRION_MASTER_KEY not set — using an INSECURE dev key. Set it (base64, 32 bytes) for any real use.');
    warned = true;
  }
  return createHash('sha256').update('irion-dev-master-key-do-not-use-in-prod').digest();
}

/** Encrypt a UTF-8 string → "iv.tag.ciphertext" (all base64). */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ct.toString('base64')}`;
}

/** Decrypt "iv.tag.ciphertext" → the original UTF-8 string (throws if tampered). */
export function decrypt(blob: string): string {
  const [ivB64, tagB64, ctB64] = blob.split('.');
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}
