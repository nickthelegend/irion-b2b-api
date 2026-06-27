import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.chdir(mkdtempSync(join(tmpdir(), 'irion-accttest-')));
const accts = await import('./accounts.ts');

test('accounts: create + lookup by id and (case-insensitive) email', () => {
  const a = accts.createAccount({ name: 'Co', email: 'C@O.co', party: 'p::1', fingerprint: 'fp', publicKey: 'pk' });
  assert.ok(a.id.startsWith('acct_'));
  assert.equal(accts.getAccount(a.id)?.email, 'C@O.co');
  assert.equal(accts.getAccountByEmail('c@o.CO')?.id, a.id);
  assert.equal(accts.getAccountByEmail('nope@x.co'), undefined);
});

test('accounts: passkeys add + counter update', () => {
  const a = accts.createAccount({ name: 'Co2', email: 'b@o.co', party: 'p::2', fingerprint: '', publicKey: '' });
  accts.addPasskey(a.id, { id: 'cred1', publicKey: 'PK', counter: 0 });
  assert.equal(accts.getAccount(a.id)?.passkeys.length, 1);
  accts.updatePasskeyCounter(a.id, 'cred1', 7);
  assert.equal(accts.getAccount(a.id)?.passkeys[0].counter, 7);
});

test('accounts: publicView omits nothing secret + counts passkeys', () => {
  const a = accts.createAccount({ name: 'Co3', email: 'c3@o.co', party: 'p::3', fingerprint: '', publicKey: '' });
  accts.addPasskey(a.id, { id: 'c', publicKey: 'p', counter: 0 });
  const v = accts.publicView(accts.getAccount(a.id)!);
  assert.equal(v.passkeys, 1);
  assert.equal(v.email, 'c3@o.co');
});
