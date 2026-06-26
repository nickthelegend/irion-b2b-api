// Encrypted, persistent custody of each account's operational Canton key.
// FIXES the in-memory-Map loss (keys survived only until restart): the private
// key is AES-256-GCM encrypted (crypto.ts) and only ciphertext touches disk.
// The Canton keypair is {publicKey, privateKey} base64 strings (core-signing-lib).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { encrypt, decrypt } from './crypto.js';

const FILE = resolve(process.cwd(), '.irion-keystore.json');
interface StoredKey { accountId: string; party: string; publicKey: string; encPrivateKey: string; fingerprint: string }
type Store = Record<string, StoredKey>;

const read = (): Store => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {});
const write = (s: Store) => writeFileSync(FILE, JSON.stringify(s, null, 2));

export interface CantonKey { party: string; publicKey: string; privateKey: string; fingerprint: string }

export function putKey(accountId: string, k: CantonKey): void {
  const s = read();
  s[accountId] = { accountId, party: k.party, publicKey: k.publicKey, fingerprint: k.fingerprint, encPrivateKey: encrypt(k.privateKey) };
  write(s);
}

/** Returns the DECRYPTED key for in-memory signing, or undefined. */
export function getKey(accountId: string): CantonKey | undefined {
  const k = read()[accountId];
  if (!k) return undefined;
  return { party: k.party, publicKey: k.publicKey, fingerprint: k.fingerprint, privateKey: decrypt(k.encPrivateKey) };
}

export const hasKey = (accountId: string): boolean => !!read()[accountId];
