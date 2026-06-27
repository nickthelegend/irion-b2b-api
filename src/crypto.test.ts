import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt } from './crypto.ts';

test('crypto: round-trips a value', () => {
  const blob = encrypt('hello-canton-key');
  assert.notEqual(blob, 'hello-canton-key');
  assert.equal(decrypt(blob), 'hello-canton-key');
});

test('crypto: same plaintext → distinct ciphertexts (random IV)', () => {
  assert.notEqual(encrypt('x'), encrypt('x'));
});

test('crypto: tampered ciphertext is rejected (AEAD)', () => {
  const [iv, tag] = encrypt('secret').split('.');
  const tampered = `${iv}.${tag}.${Buffer.from('zzzzzzzz').toString('base64')}`;
  assert.throws(() => decrypt(tampered));
});

test('crypto: round-trips a realistic base64 Ed25519 private key', () => {
  const key = Buffer.from('k'.repeat(48)).toString('base64');
  assert.equal(decrypt(encrypt(key)), key);
});
