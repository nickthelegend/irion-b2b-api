import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issue, verify } from './session.ts';

test('session: issue + verify round-trip', () => {
  const c = verify(issue({ scope: 'session', sub: 'acct_1' }, 60));
  assert.equal(c?.sub, 'acct_1');
  assert.equal(c?.scope, 'session');
});

test('session: tampered signature is rejected', () => {
  const t = issue({ scope: 'session', sub: 'a' }, 60);
  assert.equal(verify(t.slice(0, -3) + 'xxx'), null);
});

test('session: expired token is rejected', () => {
  assert.equal(verify(issue({ scope: 'session', sub: 'a' }, -1)), null);
});

test('session: malformed input is rejected', () => {
  assert.equal(verify('not.a.token'), null);
  assert.equal(verify(''), null);
  assert.equal(verify(undefined), null);
});

test('session: carries custom claims (challenge, stepup)', () => {
  const c = verify(issue({ scope: 'login', sub: 'a', challenge: 'abc', stepup: true }, 60));
  assert.equal(c?.challenge, 'abc');
  assert.equal(c?.stepup, true);
});
