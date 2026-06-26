// End-to-end test of the B2B API against the LIVE Canton ledger. Exercises every
// account-scoped endpoint (treasury, FX, payroll, lending, transfers) with real
// on-ledger effects + assertions. The passkey ceremony is browser-only, so this
// harness creates the account + session directly (the passkey is the auth layer,
// verified separately); everything else is the real HTTP API hitting real Canton.
//   run: npm run test:e2e   (b2b-api + ledger must be up)
try { process.loadEnvFile(); } catch { /* dev fallback secrets */ }
import * as store from './store.js';
import { Ledger } from './canton.js';
import * as accounts from './accounts.js';
import * as session from './session.js';

const BASE = process.env.B2B_URL ?? 'http://localhost:8088';
let pass = 0, fail = 0;
const log: string[] = [];
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; log.push(`✅ ${name}${detail ? '  ·  ' + detail : ''}`); }
  else { fail++; log.push(`❌ ${name}  ·  ${detail}`); }
};
async function api(method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j: any = null; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
  return { status: r.status, body: j };
}

// ---- set up a passkey-authenticated account (auth layer bypassed; see header) ----
const led = new Ledger(store.cantonConfig(store.loadState()));
for (const [c, p] of Object.entries(store.getCurrencies())) led.setCurrency(c, p);
const email = `e2e+${Date.now().toString(36)}@irion.test`;
const party = await led.allocateParty(email);
await led.openProfile(party);
const account = accounts.createAccount({ name: 'E2E Test Co', email, party, fingerprint: '', publicKey: '' });
const token = session.issue({ scope: 'session', sub: account.id }, 3600);
console.log(`test account ${account.id}  party ${party.slice(0, 30)}…\n`);

// ---- auth ----
check('requireSession rejects missing token (401)', (await api('GET', '/v1/account')).status === 401);
const me = await api('GET', '/v1/auth/me', token);
check('GET /v1/auth/me (session works)', me.status === 200 && me.body?.account?.id === account.id);
const rb = await api('POST', '/v1/auth/register/begin', undefined, { name: 'New Co', email: `new+${Date.now()}@t.co` });
check('register/begin → real WebAuthn options', rb.status === 200 && !!rb.body?.options?.challenge && !!rb.body?.regToken);
const lb = await api('POST', '/v1/auth/login/begin', undefined, { email });
check('login/begin → assertion options', lb.status === 200 && !!lb.body?.options?.challenge);

// ---- treasury: multi-currency + FX ----
const dep = await api('POST', '/v1/account/treasury/deposit', token, { amount: 20000, currency: 'USDC' });
check('deposit 20000 USDC', dep.status === 200 && dep.body?.treasury?.balances?.USDC >= 20000, `USDC=${dep.body?.treasury?.balances?.USDC}`);
const rates = await api('GET', '/v1/account/treasury/rates', token);
check('GET FX rates', rates.status === 200 && rates.body?.rates?.['USDC:EURC'] > 0, `USDC:EURC=${rates.body?.rates?.['USDC:EURC']}`);
const reb = await api('POST', '/v1/account/treasury/rebalance', token, { from: 'USDC', to: 'EURC', amount: 5000 });
check('rebalance 5000 USDC→EURC (real swap)', reb.status === 200 && reb.body?.bought > 0 && reb.body?.treasury?.balances?.EURC >= reb.body.bought - 0.01,
  `sold=${reb.body?.sold} bought=${reb.body?.bought} EURC=${reb.body?.treasury?.balances?.EURC} USDC=${reb.body?.treasury?.balances?.USDC}`);
const reb2 = await api('POST', '/v1/account/treasury/rebalance', token, { from: 'USDC', to: 'GBPC', amount: 1000 });
check('rebalance 1000 USDC→GBPC', reb2.status === 200 && reb2.body?.treasury?.balances?.GBPC > 0, `GBPC=${reb2.body?.treasury?.balances?.GBPC}`);

// ---- treasury: yield ----
const sw = await api('POST', '/v1/account/treasury/sweep', token, { amount: 3000 });
check('sweep 3000 USDC → yield', sw.status === 200 && sw.body?.treasury?.yieldValue > 0, `yieldValue=${sw.body?.treasury?.yieldValue}`);
const rd = await api('POST', '/v1/account/treasury/redeem', token, {});
check('redeem yield → cash', rd.status === 200, `USDC=${rd.body?.treasury?.balances?.USDC}`);

// ---- private payroll ----
const e1 = await api('POST', '/v1/account/employees', token, { name: 'Alice', email: 'alice@co', salary: 3000 });
const e2 = await api('POST', '/v1/account/employees', token, { name: 'Bob', email: 'bob@co', salary: 2500 });
check('add 2 employees (each a Canton party)', e1.status === 201 && e2.status === 201 && !!e1.body?.employee?.party && !!e2.body?.employee?.party);
const run = await api('POST', '/v1/account/payroll/runs', token, { entries: [{ employeeId: e1.body?.employee?.id }, { employeeId: e2.body?.employee?.id }] });
check('payroll run pays 2 (real transfers)', run.status === 201 && run.body?.run?.entries?.length === 2 && run.body.run.entries.every((x: any) => !!x.updateId), `total=${run.body?.run?.total}`);
const runs = await api('GET', '/v1/account/payroll/runs', token);
check('list payroll runs', runs.status === 200 && (runs.body?.runs?.length ?? 0) >= 1);

// ---- lending with REAL underwriting ----
const uw = await api('POST', '/v1/account/credit/underwrite', token, {});
check('underwrite (real on-ledger score)', uw.status === 200 && uw.body?.score >= 600 && uw.body?.limit > 0, `score=${uw.body?.score} limit=${uw.body?.limit} signals=${JSON.stringify(uw.body?.signals)}`);
const loan = await api('POST', '/v1/account/loans', token, { amount: 1000 });
check('draw working-capital loan 1000', loan.status === 201 && !!loan.body?.loanId, loan.body?.error || '');
const loans = await api('GET', '/v1/account/loans', token);
check('list loans', loans.status === 200 && (loans.body?.loans?.length ?? 0) >= 1);
if (loan.body?.loanId) {
  const rp = await api('POST', `/v1/account/loans/${encodeURIComponent(loan.body.loanId)}/repay`, token, { amount: 500 });
  check('repay loan 500', rp.status === 200, rp.body?.error || '');
}

// ---- transfer ----
const recip = await led.allocateParty('e2e-recipient');
const tr = await api('POST', '/v1/account/transfers', token, { to: recip, amount: 100, currency: 'USDC' });
check('transfer 100 USDC (settlement)', tr.status === 200 && !!tr.body?.updateId, tr.body?.error || '');

// ---- events + existing endpoints still work ----
const ev = await api('GET', '/v1/account/events', token);
check('events recorded', ev.status === 200 && (ev.body?.events?.length ?? 0) >= 1, `count=${ev.body?.events?.length}`);
check('GET /v1/health (legacy still ok)', (await api('GET', '/v1/health')).status === 200);

// ---- NEOBANK SURFACE (payees, FX quote, sub-accounts, invoices, scheduled, cards, webhooks, statement) ----
const pe = await api('POST', '/v1/account/payees', token, { name: 'Acme Supplier', party: recip, currency: 'USDC' });
check('add payee', pe.status === 201 && !!pe.body?.payee?.id);
const pl = await api('GET', '/v1/account/payees', token);
check('list payees', pl.status === 200 && (pl.body?.payees?.length ?? 0) >= 1);

const q = await api('GET', '/v1/account/fx/quote?from=USDC&to=EURC&amount=1000', token);
check('FX quote USDC→EURC', q.status === 200 && q.body?.rate > 0 && q.body?.receive === +(1000 * q.body.rate).toFixed(2), `rate=${q.body?.rate} receive=${q.body?.receive}`);

const sa = await api('POST', '/v1/account/sub-accounts', token, { name: 'Payroll pot' });
check('create sub-account', sa.status === 201 && !!sa.body?.subAccount?.id);
const mv = await api('POST', `/v1/account/sub-accounts/${sa.body?.subAccount?.id}/move`, token, { amount: 500, currency: 'USDC', direction: 'in' });
check('move 500 USDC → sub-account (real)', mv.status === 200 && !!mv.body?.updateId, mv.body?.error || '');

const inv = await api('POST', '/v1/account/invoices', token, { amount: 250, currency: 'USDC', counterparty: 'Globex', description: 'Consulting' });
check('create invoice', inv.status === 201 && inv.body?.invoice?.number?.startsWith('INV-'));
const paid = await api('POST', `/v1/account/invoices/${inv.body?.invoice?.id}/pay`, token, {});
check('pay invoice (settled)', paid.status === 200 && paid.body?.invoice?.status === 'paid', paid.body?.error || '');

const sc = await api('POST', '/v1/account/scheduled', token, { type: 'transfer', label: 'Rent', intervalDays: 30, payload: { to: recip, amount: 10, currency: 'USDC' } });
check('create scheduled payment', sc.status === 201 && !!sc.body?.scheduled?.id);
const scr = await api('POST', `/v1/account/scheduled/${sc.body?.scheduled?.id}/run`, token, {});
check('run scheduled (real transfer)', scr.status === 200 && !!scr.body?.updateId, scr.body?.error || '');

const card = await api('POST', '/v1/account/cards', token, { label: 'Ops card', spendLimit: 5000 });
check('issue virtual card', card.status === 201 && /^\d{4}$/.test(card.body?.card?.last4 || ''));
const frz = await api('POST', `/v1/account/cards/${card.body?.card?.id}/freeze`, token, {});
check('freeze card', frz.status === 200 && frz.body?.card?.status === 'frozen');

const wh = await api('POST', '/v1/account/webhooks', token, { url: 'https://example.com/hook', events: ['*'] });
check('add webhook', wh.status === 201 && !!wh.body?.webhook?.id);
check('list webhooks', (await api('GET', '/v1/account/webhooks', token)).body?.webhooks?.length >= 1);
check('delete webhook', (await api('DELETE', `/v1/account/webhooks/${wh.body?.webhook?.id}`, token)).status === 200);

const st = await api('GET', '/v1/account/statement', token);
check('statement', st.status === 200 && !!st.body?.balances && typeof st.body?.activity?.transfers === 'number', `events=${st.body?.totalEvents}`);
const txs = await api('GET', '/v1/account/transactions', token);
check('transactions list', txs.status === 200 && (txs.body?.transactions?.length ?? 0) >= 1);

console.log(log.join('\n'));
console.log(`\n${pass}/${pass + fail} passed${fail ? `  (${fail} FAILED)` : '  — all green'}`);
process.exit(fail ? 1 : 0);
