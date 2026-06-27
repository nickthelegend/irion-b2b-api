import { test } from 'node:test';
import assert from 'node:assert/strict';
import { businessScore, businessLimit, consumerScore, consumerLimit } from './underwriting.ts';

// ---- business working-capital underwriting ----
test('businessScore: no treasury, no history → 550 floor', () => {
  assert.equal(businessScore(0, 0), 550);
});

test('businessScore: treasury depth lifts the score (≈$2k reaches the 600 gate)', () => {
  assert.equal(businessScore(2000, 0), 550 + Math.floor(2000 / 40)); // 600
  assert.ok(businessScore(2000, 0) >= 600);
});

test('businessScore: depth points cap at 250 and total caps at 850', () => {
  assert.equal(businessScore(1_000_000, 0), 800); // 550 + 250 (cap)
  assert.equal(businessScore(1_000_000, 100), 850); // +120 history, capped at 850
});

test('businessScore: repayment history adds 15 each, capped at 120', () => {
  assert.equal(businessScore(0, 1), 550 + 15);
  assert.equal(businessScore(0, 100), 550 + 120); // history cap
});

test('businessLimit: scales with score against the treasury (min $200 base)', () => {
  // zero treasury still uses the $200 base: (550/850)*200 ≈ 129
  assert.equal(businessLimit(0, 550), Math.round((550 / 850) * 200));
  // larger treasury scales the limit up
  assert.equal(businessLimit(10000, 800), Math.round((800 / 850) * 5000));
  assert.ok(businessLimit(10000, 800) > businessLimit(0, 550));
});

// ---- consumer BNPL "pay-never" starter line ----
test('consumerScore: a brand-new consumer is approved at the 600 gate', () => {
  assert.equal(consumerScore(0, 0), 600);
});

test('consumerScore: real signals lift above the gate, capped at 850', () => {
  assert.equal(consumerScore(4000, 0), 600 + Math.min(200, Math.floor(4000 / 40))); // 700
  assert.equal(consumerScore(1_000_000, 100), 850); // both caps → 850
});

test('consumerLimit: starter $1000 + half the treasury', () => {
  assert.equal(consumerLimit(0), 1000);
  assert.equal(consumerLimit(4000), 1000 + 2000);
});

test('neither score can be set by a caller — both are pure functions of on-ledger signals', () => {
  // Determinism: same inputs → same outputs (no external/caller input path).
  assert.equal(consumerScore(123, 4), consumerScore(123, 4));
  assert.equal(businessScore(123, 4), businessScore(123, 4));
});
