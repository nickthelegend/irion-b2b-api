import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getRate, allRates, isCurrency } from './fx.ts';

test('fx: identity rate is exactly 1', async () => {
  assert.equal((await getRate('USDC', 'USDC')).rate, 1);
});

test('fx: USDC→EURC is a plausible live/fallback rate', async () => {
  const { rate, source } = await getRate('USDC', 'EURC');
  assert.ok(rate > 0.5 && rate < 1.5, `rate=${rate}`);
  assert.ok(source === 'live' || source === 'fallback');
});

test('fx: inverse rates multiply to ~1', async () => {
  const a = (await getRate('USDC', 'EURC')).rate;
  const b = (await getRate('EURC', 'USDC')).rate;
  assert.ok(Math.abs(a * b - 1) < 0.02, `a*b=${a * b}`);
});

test('fx: unknown currency throws', async () => {
  await assert.rejects(() => getRate('USDC', 'XXX'));
});

test('fx: isCurrency', () => {
  assert.ok(isCurrency('usdc') && isCurrency('EURC') && isCurrency('GBPC'));
  assert.ok(!isCurrency('btc') && !isCurrency(''));
});

test('fx: allRates covers all six cross pairs', async () => {
  const { rates } = await allRates();
  for (const p of ['USDC:EURC', 'EURC:USDC', 'USDC:GBPC', 'GBPC:USDC', 'EURC:GBPC', 'GBPC:EURC']) {
    assert.ok(rates[p] > 0, `missing ${p}`);
  }
});
