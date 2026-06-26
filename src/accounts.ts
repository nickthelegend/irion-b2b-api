// B2B account store (JSON-backed, like store.ts). One account = one business
// with a Canton party (its key lives encrypted in keystore.ts) and one or more
// passkeys. This is the passkey-authenticated identity that REPLACES the
// spoofable x-wallet-address header.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const FILE = resolve(process.cwd(), '.irion-accounts.json');

export interface StoredPasskey { id: string; publicKey: string; counter: number; transports?: string[]; createdAt: string }
export interface Account {
  id: string; name: string; email: string;
  party: string; fingerprint: string; publicKey: string;
  createdAt: string; passkeys: StoredPasskey[];
}
type Store = Account[];
const read = (): Store => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : []);
const write = (s: Store) => writeFileSync(FILE, JSON.stringify(s, null, 2));

export const listAccounts = (): Account[] => read();
export const getAccount = (id: string): Account | undefined => read().find((a) => a.id === id);
export const getAccountByEmail = (email: string): Account | undefined =>
  read().find((a) => a.email.toLowerCase() === email.toLowerCase());

export function createAccount(a: { name: string; email: string; party: string; fingerprint: string; publicKey: string }): Account {
  const all = read();
  const acct: Account = {
    id: 'acct_' + randomBytes(8).toString('hex'),
    name: a.name, email: a.email, party: a.party, fingerprint: a.fingerprint, publicKey: a.publicKey,
    createdAt: new Date().toISOString(), passkeys: [],
  };
  all.push(acct); write(all); return acct;
}

export function addPasskey(accountId: string, pk: Omit<StoredPasskey, 'createdAt'>): void {
  const all = read(); const a = all.find((x) => x.id === accountId); if (!a) return;
  a.passkeys.push({ ...pk, createdAt: new Date().toISOString() }); write(all);
}

export function updatePasskeyCounter(accountId: string, credId: string, counter: number): void {
  const all = read(); const a = all.find((x) => x.id === accountId); if (!a) return;
  const pk = a.passkeys.find((p) => p.id === credId); if (pk) { pk.counter = counter; write(all); }
}

/** Safe view for API responses (no key material — though none is secret here). */
export const publicView = (a: Account) => ({ id: a.id, name: a.name, email: a.email, party: a.party, createdAt: a.createdAt, passkeys: a.passkeys.length });
