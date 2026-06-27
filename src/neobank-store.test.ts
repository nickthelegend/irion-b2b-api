import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// stores write .irion-*.json relative to cwd — isolate to a temp dir, then import.
process.chdir(mkdtempSync(join(tmpdir(), 'irion-nbtest-')));
const nb = await import('./neobank-store.ts');
const A = 'acct_test';

test('payees: add / list / get / remove', () => {
  const p = nb.addPayee({ accountId: A, name: 'Acme', party: 'p::1', currency: 'USDC' });
  assert.ok(p.id.startsWith('payee_'));
  assert.equal(nb.listPayees(A).length, 1);
  assert.equal(nb.getPayee(A, p.id)?.name, 'Acme');
  assert.ok(nb.removePayee(A, p.id));
  assert.equal(nb.listPayees(A).length, 0);
});

test('sub-accounts: add / get / list', () => {
  const s = nb.addSub({ accountId: A, name: 'Payroll pot', party: 's::1' });
  assert.equal(nb.getSub(A, s.id)?.name, 'Payroll pot');
  assert.ok(nb.listSubs(A).length >= 1);
});

test('invoices: sequential number, create + mark paid', () => {
  const i = nb.addInvoice({ accountId: A, amount: 100, currency: 'USDC', counterparty: 'Globex', description: 'd' });
  assert.match(i.number, /^INV-\d{4}$/);
  assert.equal(i.status, 'open');
  const paid = nb.markInvoicePaid(A, i.id, 'tx-1');
  assert.equal(paid?.status, 'paid');
  assert.equal(paid?.txHash, 'tx-1');
});

test('scheduled: due detection, advance, pause', () => {
  const past = new Date(Date.now() - 1000).toISOString();
  const s = nb.addScheduled({ accountId: A, type: 'transfer', label: 'Rent', intervalDays: 7, nextRun: past, payload: {} });
  assert.ok(nb.dueScheduled().some((x) => x.id === s.id));
  nb.advanceScheduled(s.id);
  const after = nb.getScheduled(A, s.id)!;
  assert.equal(after.runs, 1);
  assert.ok(after.nextRun > past, 'nextRun advanced');
  assert.ok(nb.setScheduledStatus(A, s.id, 'paused'));
  assert.equal(nb.getScheduled(A, s.id)?.status, 'paused');
});

test('cards: issue (4-digit last4) + freeze/unfreeze', () => {
  const c = nb.addCard({ accountId: A, label: 'Ops', currency: 'USDC' });
  assert.match(c.last4, /^\d{4}$/);
  assert.equal(c.status, 'active');
  assert.equal(nb.setCardStatus(A, c.id, 'frozen')?.status, 'frozen');
  assert.equal(nb.setCardStatus(A, c.id, 'active')?.status, 'active');
});

test('webhooks: add / list / remove', () => {
  const w = nb.addWebhook({ accountId: A, url: 'https://x.co/hook', events: ['*'] });
  assert.equal(nb.listWebhooks(A).length, 1);
  assert.ok(nb.removeWebhook(A, w.id));
  assert.equal(nb.listWebhooks(A).length, 0);
});
