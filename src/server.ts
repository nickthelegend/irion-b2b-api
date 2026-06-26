// Irion B2B API — programmable Treasury · Credit · Lending · Settlement on Canton.
// "Stripe Treasury + Modern Treasury + Embedded Credit, built on Canton."
//
// Every business is a Canton party; this server holds the operator party and
// mediates. Balances, credit, loans, and yield all live on the Canton ledger —
// the API is a clean façade over the Irion Daml protocol.
import express, { type Request, type Response, type NextFunction } from 'express';
import { Ledger, LedgerError } from './canton.js';
import * as store from './store.js';
import { openapi } from './openapi.js';
import { WalletService } from './wallet.js';
import * as accounts from './accounts.js';
import * as passkeys from './passkeys.js';
import * as session from './session.js';
import * as nbstore from './neobank-store.js';
import { resolve } from 'node:path';

try { process.loadEnvFile?.(resolve(import.meta.dirname, '../.env')); } catch { try { process.loadEnvFile?.('.env'); } catch { /* no .env */ } }
const state = store.loadState();
const led = new Ledger(store.cantonConfig(state));
const LEDGER_URL = process.env.CANTON_JSON_API ?? 'http://localhost:6864';
const PORT = Number(process.env.PORT ?? 8088);
const wallets = new WalletService(LEDGER_URL, process.env.IRION_PACKAGE ?? 'irion-model');
console.log('wallet signer: Canton SDK key (self-custody Ed25519)');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'authorization, content-type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use((req, _res, next) => { console.log(`${req.method} ${req.path}`); next(); });

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res)).catch(next);
const biz = (req: Request) => (req as any).business as store.Business;
const num = (v: unknown, name: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new LedgerError(`'${name}' must be a positive number`, '');
  return n;
};

// idempotency: replay the first response for a repeated Idempotency-Key (POST only)
app.use((req, res, next) => {
  const k = req.method === 'POST' ? (req.headers['idempotency-key'] as string) : '';
  if (k) { const c = store.getIdem(k); if (c) return res.status(c.status).json(c.body as any); }
  if (k) { const orig = res.json.bind(res); (res as any).json = (b: unknown) => { store.setIdem(k, { status: res.statusCode, body: b }); return orig(b as any); }; }
  next();
});

// emit an event + deliver to the business's webhook (fire-and-forget)
function emit(businessId: string, type: string, data: unknown) {
  store.addEvent(businessId, type, data);
  const url = store.getWebhook(businessId);
  if (url) fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, data, createdAt: new Date().toISOString() }) }).catch(() => {});
}

// ---- Passkey auth + B2B accounts ----
// Registered BEFORE the `/v1` apiKey gate below, so /v1/auth/* are public. The
// passkey-authenticated session REPLACES the spoofable x-wallet-address header.
function requireSession(req: Request, res: Response, next: NextFunction) {
  const tok = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const claims = session.verify(tok);
  if (!claims || claims.scope !== 'session') return res.status(401).json({ error: 'unauthorized — sign in with your passkey' });
  const account = accounts.getAccount(claims.sub);
  if (!account) return res.status(401).json({ error: 'account not found' });
  (req as any).account = account;
  next();
}
const acct = (req: Request) => (req as any).account as accounts.Account;
const emitAccount = (a: accounts.Account, type: string, data: unknown) => { store.addEvent(a.id, type, data); nbstore.deliverWebhooks(a.id, type, data); };

/** execute a scheduled payment (standing order or recurring payroll) on-ledger. */
async function runSchedule(a: accounts.Account, s: nbstore.Scheduled): Promise<Record<string, unknown>> {
  if (s.type === 'transfer') {
    const to = String(s.payload?.to ?? ''); const amount = Number(s.payload?.amount ?? 0); const currency = String(s.payload?.currency ?? 'USDC').toUpperCase();
    if (!to || !(amount > 0)) throw new LedgerError('schedule payload needs { to, amount }', '');
    return { type: 'transfer', to, amount, currency, updateId: await led.settleCurrency(a.party, to, amount, currency) };
  }
  const entries: any[] = Array.isArray(s.payload?.entries) ? s.payload.entries : [];
  const resolved = entries.map((e) => { const emp = store.getEmployee(a.id, String(e.employeeId)); if (!emp) throw new LedgerError(`unknown employee ${e.employeeId}`, ''); return { party: emp.party, amount: Number(e.amount ?? emp.salary ?? 0), currency: (emp.currency ?? 'USDC').toUpperCase() }; }).filter((r) => r.amount > 0);
  const paid = await led.payrollRun(a.party, resolved);
  return { type: 'payroll', count: paid.length, total: paid.reduce((n, p) => n + p.amount, 0) };
}

app.post('/v1/auth/register/begin', wrap(async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  if (!name || !email) throw new LedgerError('name and email are required', '');
  if (accounts.getAccountByEmail(email)) throw new LedgerError('an account with that email already exists — sign in instead', '');
  const options = await passkeys.regOptions({ userId: 'pending:' + email, userName: email, displayName: name });
  res.json({ options, regToken: session.issue({ scope: 'register', sub: 'pending:' + email, name, email, challenge: options.challenge }, 300) });
}));

app.post('/v1/auth/register/finish', wrap(async (req, res) => {
  const { regToken, response } = req.body ?? {};
  const claims = session.verify(regToken);
  if (!claims || claims.scope !== 'register') throw new LedgerError('invalid or expired registration token', '');
  const cred = await passkeys.verifyReg(response, String(claims.challenge));
  if (!cred) throw new LedgerError('passkey registration could not be verified', '');
  // Platform-custodied party: operator-allocated, so the platform's ledger authority
  // IS the custody and the passkey gates access (enables unattended automation).
  const party = await led.allocateParty(String(claims.email));
  const account = accounts.createAccount({ name: String(claims.name), email: String(claims.email), party, fingerprint: '', publicKey: '' });
  accounts.addPasskey(account.id, cred);
  await led.openProfile(party).catch(() => {});         // open a credit profile for the new business
  res.status(201).json({ session: session.issue({ scope: 'session', sub: account.id }, 3600), account: accounts.publicView(account) });
}));

app.post('/v1/auth/login/begin', wrap(async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const account = accounts.getAccountByEmail(email);
  if (!account) throw new LedgerError('no account with that email', '');
  const options = await passkeys.authOptions(account.passkeys);
  res.json({ options, loginToken: session.issue({ scope: 'login', sub: account.id, challenge: options.challenge }, 300) });
}));

app.post('/v1/auth/login/finish', wrap(async (req, res) => {
  const { loginToken, response } = req.body ?? {};
  const claims = session.verify(loginToken);
  if (!claims || claims.scope !== 'login') throw new LedgerError('invalid or expired login token', '');
  const account = accounts.getAccount(claims.sub);
  if (!account) throw new LedgerError('account not found', '');
  const pk = account.passkeys.find((p) => p.id === response?.id);
  if (!pk) throw new LedgerError('unknown passkey for this account', '');
  const newCounter = await passkeys.verifyAuth(response, String(claims.challenge), pk);
  if (newCounter === null) throw new LedgerError('passkey authentication failed', '');
  accounts.updatePasskeyCounter(account.id, pk.id, newCounter);
  res.json({ session: session.issue({ scope: 'session', sub: account.id }, 3600), account: accounts.publicView(account) });
}));

app.get('/v1/auth/me', requireSession, wrap(async (req, res) => res.json({ account: accounts.publicView(acct(req)) })));

// step-up: a fresh passkey assertion authorizing a high-value action (returns a short-lived approval)
app.post('/v1/auth/stepup/begin', requireSession, wrap(async (req, res) => {
  const a = acct(req);
  const options = await passkeys.authOptions(a.passkeys);
  res.json({ options, stepupToken: session.issue({ scope: 'login', sub: a.id, challenge: options.challenge, stepup: true }, 180) });
}));
app.post('/v1/auth/stepup/finish', requireSession, wrap(async (req, res) => {
  const a = acct(req);
  const { stepupToken, response } = req.body ?? {};
  const claims = session.verify(stepupToken);
  if (!claims || claims.sub !== a.id || claims.stepup !== true) throw new LedgerError('invalid step-up token', '');
  const pk = a.passkeys.find((p) => p.id === response?.id);
  if (!pk) throw new LedgerError('unknown passkey', '');
  const c = await passkeys.verifyAuth(response, String(claims.challenge), pk);
  if (c === null) throw new LedgerError('step-up verification failed', '');
  accounts.updatePasskeyCounter(a.id, pk.id, c);
  res.json({ approval: session.issue({ scope: 'stepup', sub: a.id }, 120) });
}));

// account-scoped + passkey-authenticated (the operational key is custodied + signs on the account's behalf)
app.get('/v1/account', requireSession, wrap(async (req, res) => res.json({ account: accounts.publicView(acct(req)) })));
app.get('/v1/account/treasury', requireSession, wrap(async (req, res) => res.json(await led.treasuryMulti(acct(req).party))));
app.post('/v1/account/faucet', requireSession, wrap(async (req, res) => {
  const amount = num(req.body?.amount ?? 100, 'amount');
  const currency = String(req.body?.currency ?? 'USDC').toUpperCase();
  await led.fund(acct(req).party, amount, currency);
  res.json({ ok: true, funded: amount, currency, party: acct(req).party });
}));

// ---- B2B treasury: multi-currency deposit, FX rebalance, yield ----
app.post('/v1/account/treasury/deposit', requireSession, wrap(async (req, res) => {
  const amount = num(req.body?.amount, 'amount');
  const currency = String(req.body?.currency ?? 'USDC').toUpperCase();
  await led.fund(acct(req).party, amount, currency);
  res.json({ ok: true, deposited: amount, currency, treasury: await led.treasuryMulti(acct(req).party) });
}));
// operator-quoted FX rates (real config values — swap a price oracle/LP in for production)
const FX_RATES: Record<string, number> = { 'USDC:EURC': 0.92, 'EURC:USDC': 1.087, 'USDC:GBPC': 0.79, 'GBPC:USDC': 1.266, 'EURC:GBPC': 0.86, 'GBPC:EURC': 1.163 };
app.get('/v1/account/treasury/rates', requireSession, wrap(async (_req, res) => res.json({ source: 'operator-quoted', rates: FX_RATES })));
app.post('/v1/account/treasury/rebalance', requireSession, wrap(async (req, res) => {
  const from = String(req.body?.from ?? '').toUpperCase();
  const to = String(req.body?.to ?? '').toUpperCase();
  const amount = num(req.body?.amount, 'amount');
  const rate = FX_RATES[`${from}:${to}`];
  if (!rate) throw new LedgerError(`no FX rate for ${from}->${to}`, '');
  const r = await led.rebalance(acct(req).party, from, to, amount, rate);
  emitAccount(acct(req), 'treasury.rebalanced', r);
  res.json({ ok: true, ...r, treasury: await led.treasuryMulti(acct(req).party) });
}));
app.post('/v1/account/treasury/sweep', requireSession, wrap(async (req, res) => {
  const amount = num(req.body?.amount, 'amount');
  await led.sweepToYield(acct(req).party, amount);
  res.json({ ok: true, swept: amount, treasury: await led.treasuryMulti(acct(req).party) });
}));
app.post('/v1/account/treasury/redeem', requireSession, wrap(async (req, res) => {
  await led.redeemFromYield(acct(req).party);
  res.json({ ok: true, treasury: await led.treasuryMulti(acct(req).party) });
}));

// ---- payments / transfers ----
app.post('/v1/account/transfers', requireSession, wrap(async (req, res) => {
  const to = String(req.body?.to ?? '');
  const amount = num(req.body?.amount, 'amount');
  const currency = String(req.body?.currency ?? 'USDC').toUpperCase();
  if (!to) throw new LedgerError('recipient party `to` is required', '');
  const updateId = await led.settleCurrency(acct(req).party, to, amount, currency);
  emitAccount(acct(req), 'transfer.sent', { to, amount, currency, updateId });
  res.json({ ok: true, to, amount, currency, updateId });
}));

// ---- employees + private payroll ----
app.get('/v1/account/employees', requireSession, wrap(async (req, res) => res.json({ employees: store.listEmployees(acct(req).id) })));
app.post('/v1/account/employees', requireSession, wrap(async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  const email = String(req.body?.email ?? '').trim();
  const currency = String(req.body?.currency ?? 'USDC').toUpperCase();
  const salary = req.body?.salary != null ? num(req.body.salary, 'salary') : undefined;
  if (!name) throw new LedgerError('employee name is required', '');
  const party = await led.allocateParty('emp' + (email || name)); // each employee is a Canton party (payee)
  res.status(201).json({ employee: store.addEmployee({ accountId: acct(req).id, name, email, party, currency, salary }) });
}));
app.post('/v1/account/payroll/runs', requireSession, wrap(async (req, res) => {
  const a = acct(req);
  const reqEntries: any[] = Array.isArray(req.body?.entries) ? req.body.entries : [];
  if (!reqEntries.length) throw new LedgerError('entries[] is required (each { employeeId, amount?, currency? })', '');
  const resolved = reqEntries.map((e) => {
    const emp = store.getEmployee(a.id, String(e.employeeId));
    if (!emp) throw new LedgerError(`unknown employee ${e.employeeId}`, '');
    const amount = e.amount != null ? num(e.amount, 'amount') : (emp.salary ?? 0);
    if (amount <= 0) throw new LedgerError(`no amount or salary set for ${emp.name}`, '');
    return { emp, amount, currency: String(e.currency ?? emp.currency ?? 'USDC').toUpperCase() };
  });
  const paid = await led.payrollRun(a.party, resolved.map((r) => ({ party: r.emp.party, amount: r.amount, currency: r.currency })));
  const entries = paid.map((p, i) => ({ employeeId: resolved[i].emp.id, name: resolved[i].emp.name, party: p.party, amount: p.amount, currency: p.currency, updateId: p.updateId }));
  const total = entries.reduce((s, e) => s + e.amount, 0);
  const run = store.addPayrollRun({ accountId: a.id, entries, total, currency: entries[0]?.currency ?? 'USDC' });
  emitAccount(a, 'payroll.run', { runId: run.id, total, count: entries.length });
  res.status(201).json({ run });
}));
app.get('/v1/account/payroll/runs', requireSession, wrap(async (req, res) => res.json({ runs: store.listPayrollRuns(acct(req).id) })));

// ---- lending / credit (REAL on-ledger underwriting) ----
app.get('/v1/account/credit', requireSession, wrap(async (req, res) => res.json({ credit: await led.getProfile(acct(req).party) })));
app.post('/v1/account/credit/underwrite', requireSession, wrap(async (req, res) => {
  const r = await led.underwrite(acct(req).party);
  emitAccount(acct(req), 'credit.underwritten', r);
  res.json({ ok: true, ...r, credit: await led.getProfile(acct(req).party) });
}));
app.get('/v1/account/loans', requireSession, wrap(async (req, res) => res.json({ loans: await led.listLoans(acct(req).party) })));
app.post('/v1/account/loans', requireSession, wrap(async (req, res) => {
  const amount = num(req.body?.amount, 'amount');
  const termDays = req.body?.termDays != null ? num(req.body.termDays, 'termDays') : 30;
  const loanId = await led.drawWorkingCapital(acct(req).party, amount, termDays);
  emitAccount(acct(req), 'loan.drawn', { loanId, amount });
  res.status(201).json({ loanId, amount, termDays });
}));
app.post('/v1/account/loans/:id/repay', requireSession, wrap(async (req, res) => {
  const amount = num(req.body?.amount, 'amount');
  await led.repayLoan(acct(req).party, req.params.id, amount);
  emitAccount(acct(req), 'loan.repaid', { loanId: req.params.id, amount });
  res.json({ ok: true, loanId: req.params.id, repaid: amount });
}));
app.get('/v1/account/events', requireSession, wrap(async (req, res) => res.json({ events: store.listEvents(acct(req).id) })));

// ---- payees (saved beneficiaries) ----
app.get('/v1/account/payees', requireSession, wrap(async (req, res) => res.json({ payees: nbstore.listPayees(acct(req).id) })));
app.post('/v1/account/payees', requireSession, wrap(async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  const party = String(req.body?.party ?? '').trim();
  const currency = String(req.body?.currency ?? 'USDC').toUpperCase();
  if (!name || !party) throw new LedgerError('payee name and party are required', '');
  res.status(201).json({ payee: nbstore.addPayee({ accountId: acct(req).id, name, party, currency }) });
}));
app.delete('/v1/account/payees/:id', requireSession, wrap(async (req, res) => {
  if (!nbstore.removePayee(acct(req).id, req.params.id)) throw new LedgerError('payee not found', '');
  res.json({ ok: true });
}));

// ---- FX quote (preview a conversion before rebalancing) ----
app.get('/v1/account/fx/quote', requireSession, wrap(async (req, res) => {
  const from = String(req.query.from ?? '').toUpperCase();
  const to = String(req.query.to ?? '').toUpperCase();
  const amount = Number(req.query.amount ?? 0);
  const rate = FX_RATES[`${from}:${to}`];
  if (!rate) throw new LedgerError(`no FX rate for ${from}->${to}`, '');
  res.json({ from, to, amount, rate, receive: +(amount * rate).toFixed(2), source: 'operator-quoted' });
}));

// ---- sub-accounts / pots (each is its own platform-custodied Canton party) ----
app.get('/v1/account/sub-accounts', requireSession, wrap(async (req, res) => {
  const subs = nbstore.listSubs(acct(req).id);
  res.json({ subAccounts: await Promise.all(subs.map(async (s) => ({ ...s, balance: await led.usdcBalance(s.party) }))) });
}));
app.post('/v1/account/sub-accounts', requireSession, wrap(async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) throw new LedgerError('sub-account name required', '');
  const party = await led.allocateParty('sub' + acct(req).id.slice(-6));
  const sub = nbstore.addSub({ accountId: acct(req).id, name, party });
  emitAccount(acct(req), 'subaccount.created', { id: sub.id, name });
  res.status(201).json({ subAccount: { ...sub, balance: 0 } });
}));
app.post('/v1/account/sub-accounts/:id/move', requireSession, wrap(async (req, res) => {
  const a = acct(req);
  const sub = nbstore.getSub(a.id, req.params.id);
  if (!sub) throw new LedgerError('sub-account not found', '');
  const amount = num(req.body?.amount, 'amount');
  const currency = String(req.body?.currency ?? 'USDC').toUpperCase();
  const dir = String(req.body?.direction ?? 'in'); // 'in' = main→pot, 'out' = pot→main
  const [from, to] = dir === 'out' ? [sub.party, a.party] : [a.party, sub.party];
  const updateId = await led.settleCurrency(from, to, amount, currency);
  emitAccount(a, 'subaccount.moved', { id: sub.id, amount, currency, direction: dir, updateId });
  res.json({ ok: true, direction: dir, amount, currency, updateId });
}));

// ---- invoices / payment requests ----
app.get('/v1/account/invoices', requireSession, wrap(async (req, res) => res.json({ invoices: nbstore.listInvoices(acct(req).id) })));
app.post('/v1/account/invoices', requireSession, wrap(async (req, res) => {
  const amount = num(req.body?.amount, 'amount');
  const currency = String(req.body?.currency ?? 'USDC').toUpperCase();
  const counterparty = String(req.body?.counterparty ?? '').trim();
  const description = String(req.body?.description ?? '').trim();
  const inv = nbstore.addInvoice({ accountId: acct(req).id, amount, currency, counterparty, description });
  emitAccount(acct(req), 'invoice.created', { id: inv.id, number: inv.number, amount, currency });
  res.status(201).json({ invoice: inv });
}));
app.post('/v1/account/invoices/:id/pay', requireSession, wrap(async (req, res) => {
  const a = acct(req);
  const inv = nbstore.getInvoice(a.id, req.params.id);
  if (!inv) throw new LedgerError('invoice not found', '');
  if (inv.status === 'paid') throw new LedgerError('invoice already paid', '');
  // a payer party settles to the business; if `from` is given it transfers, else
  // the amount is funded (demo on-ramp = the payer paid in off-platform).
  const from = String(req.body?.from ?? '').trim();
  let txHash: string;
  if (from) txHash = await led.settleCurrency(from, a.party, inv.amount, inv.currency);
  else { await led.fund(a.party, inv.amount, inv.currency); txHash = 'funded'; }
  const paid = nbstore.markInvoicePaid(a.id, inv.id, txHash);
  emitAccount(a, 'invoice.paid', { id: inv.id, number: inv.number, amount: inv.amount, txHash });
  res.json({ ok: true, invoice: paid });
}));

// ---- scheduled payments (standing orders + recurring payroll) ----
app.get('/v1/account/scheduled', requireSession, wrap(async (req, res) => res.json({ scheduled: nbstore.listScheduled(acct(req).id) })));
app.post('/v1/account/scheduled', requireSession, wrap(async (req, res) => {
  const type = String(req.body?.type ?? 'transfer');
  if (type !== 'transfer' && type !== 'payroll') throw new LedgerError("type must be 'transfer' or 'payroll'", '');
  const label = String(req.body?.label ?? type).trim();
  const intervalDays = num(req.body?.intervalDays ?? 30, 'intervalDays');
  const startInDays = Number(req.body?.startInDays ?? 0);
  const nextRun = new Date(Date.now() + startInDays * 86400_000).toISOString();
  res.status(201).json({ scheduled: nbstore.addScheduled({ accountId: acct(req).id, type, label, intervalDays, nextRun, payload: req.body?.payload ?? {} }) });
}));
app.post('/v1/account/scheduled/run-due', requireSession, wrap(async (req, res) => {
  const a = acct(req);
  const now = new Date().toISOString();
  const due = nbstore.listScheduled(a.id).filter((s) => s.status === 'active' && s.nextRun <= now);
  const ran: any[] = [];
  for (const s of due) {
    try { const r = await runSchedule(a, s); nbstore.advanceScheduled(s.id); emitAccount(a, 'scheduled.run', { id: s.id, ...r }); ran.push({ id: s.id, ...r }); }
    catch (e: any) { ran.push({ id: s.id, error: e?.message || 'failed' }); }
  }
  res.json({ ranCount: ran.length, ran });
}));
app.post('/v1/account/scheduled/:id/run', requireSession, wrap(async (req, res) => {
  const a = acct(req);
  const s = nbstore.getScheduled(a.id, req.params.id);
  if (!s) throw new LedgerError('schedule not found', '');
  const r = await runSchedule(a, s);
  nbstore.advanceScheduled(s.id);
  emitAccount(a, 'scheduled.run', { id: s.id, ...r });
  res.json({ ok: true, ...r });
}));
app.post('/v1/account/scheduled/:id/pause', requireSession, wrap(async (req, res) => {
  if (!nbstore.setScheduledStatus(acct(req).id, req.params.id, 'paused')) throw new LedgerError('schedule not found', '');
  res.json({ ok: true });
}));
app.post('/v1/account/scheduled/:id/resume', requireSession, wrap(async (req, res) => {
  if (!nbstore.setScheduledStatus(acct(req).id, req.params.id, 'active')) throw new LedgerError('schedule not found', '');
  res.json({ ok: true });
}));

// ---- virtual cards (modeled; card-network issuance is a real-world integration) ----
app.get('/v1/account/cards', requireSession, wrap(async (req, res) => res.json({ cards: nbstore.listCards(acct(req).id) })));
app.post('/v1/account/cards', requireSession, wrap(async (req, res) => {
  const label = String(req.body?.label ?? 'Virtual card').trim();
  const currency = String(req.body?.currency ?? 'USDC').toUpperCase();
  const spendLimit = req.body?.spendLimit != null ? num(req.body.spendLimit, 'spendLimit') : undefined;
  const subAccountId = req.body?.subAccountId ? String(req.body.subAccountId) : undefined;
  const card = nbstore.addCard({ accountId: acct(req).id, label, currency, spendLimit, subAccountId });
  emitAccount(acct(req), 'card.issued', { id: card.id, last4: card.last4, label });
  res.status(201).json({ card });
}));
app.post('/v1/account/cards/:id/freeze', requireSession, wrap(async (req, res) => {
  const c = nbstore.setCardStatus(acct(req).id, req.params.id, 'frozen'); if (!c) throw new LedgerError('card not found', ''); res.json({ card: c });
}));
app.post('/v1/account/cards/:id/unfreeze', requireSession, wrap(async (req, res) => {
  const c = nbstore.setCardStatus(acct(req).id, req.params.id, 'active'); if (!c) throw new LedgerError('card not found', ''); res.json({ card: c });
}));

// ---- account-scoped webhooks ----
app.get('/v1/account/webhooks', requireSession, wrap(async (req, res) => res.json({ webhooks: nbstore.listWebhooks(acct(req).id) })));
app.post('/v1/account/webhooks', requireSession, wrap(async (req, res) => {
  const url = String(req.body?.url ?? '').trim();
  if (!/^https?:\/\//.test(url)) throw new LedgerError('a valid webhook url is required', '');
  const events = Array.isArray(req.body?.events) ? req.body.events.map(String) : ['*'];
  res.status(201).json({ webhook: nbstore.addWebhook({ accountId: acct(req).id, url, events }) });
}));
app.delete('/v1/account/webhooks/:id', requireSession, wrap(async (req, res) => {
  if (!nbstore.removeWebhook(acct(req).id, req.params.id)) throw new LedgerError('webhook not found', ''); res.json({ ok: true });
}));

// ---- unified transactions + statement ----
app.get('/v1/account/transactions', requireSession, wrap(async (req, res) =>
  res.json({ transactions: store.listEvents(acct(req).id).map((e) => ({ id: e.id, type: e.type, at: e.createdAt, data: e.data })) })));
app.get('/v1/account/statement', requireSession, wrap(async (req, res) => {
  const a = acct(req);
  const t = await led.treasuryMulti(a.party);
  const evs = store.listEvents(a.id);
  const n = (type: string) => evs.filter((e) => e.type === type).length;
  res.json({
    party: a.party, balances: t.balances, cash: t.cash, yieldValue: t.yieldValue, total: t.total,
    activity: { transfers: n('transfer.sent'), rebalances: n('treasury.rebalanced'), payrollRuns: n('payroll.run'), loansDrawn: n('loan.drawn'), invoicesPaid: n('invoice.paid'), scheduledRuns: n('scheduled.run') },
    totalEvents: evs.length,
  });
}));

// ---- public ----
app.get('/', (_req, res) => res.sendFile(resolve(process.cwd(), 'public/home.html')));
app.get('/info', (_req, res) => res.json({ service: 'irion-b2b-api', apps: { home: '/', merchant: '/merchant', consumer: '/app', neobankDemo: '/dashboard', openapi: '/openapi.json' } }));
app.get('/openapi.json', (_req, res) => res.json(openapi));
app.get('/dashboard', (_req, res) => res.sendFile(resolve(process.cwd(), '../irion-demo-company/public/index.html')));

// ---- Canton front-ends ----
// The consumer Canton app is the standalone wallet dApp (Carpincho + dapp-sdk).
const CANTON_DAPP_URL = process.env.CANTON_DAPP_URL ?? 'http://localhost:3015';
const hubPage = (title: string, bodyHtml: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<body style="font-family:system-ui,sans-serif;background:#0b0b14;color:#e8e8f0;max-width:680px;margin:64px auto;padding:0 24px;line-height:1.7">` +
  `<h1 style="color:#a78bfa;letter-spacing:-.02em">${title}</h1>${bodyHtml}</body>`;
const link = (href: string, text: string) => `<a style="color:#a78bfa" href="${href}">${text}</a>`;

app.get('/app', (_req, res) => res.redirect(CANTON_DAPP_URL));
app.get('/merchant', (_req, res) => res.type('html').send(hubPage('Irion — Merchant (Canton)',
  `<p>Merchant tooling runs over the Irion B2B API + the operator dashboard.</p><ul>` +
  `<li>${link('/dashboard', 'Neobank dashboard')}</li>` +
  `<li>${link('/app', 'Consumer wallet dApp (Carpincho)')}</li>` +
  `<li>${link('/openapi.json', 'B2B API — OpenAPI')}</li></ul>`)));
app.get('/pay/:id', wrap(async (req, res) => {
  const l = store.getLink(req.params.id);
  if (!l) return res.status(404).type('html').send(hubPage('Payment link not found', '<p>This link is invalid or expired.</p>'));
  const b = store.getById(l.businessId);
  res.type('html').send(hubPage(`Pay ${l.amount} ${l.currency ?? 'USDC'}`,
    `<p><b>${b?.name ?? 'Merchant'}</b> · ${l.description ?? ''}</p><p>Status: <b>${l.status}</b></p>` +
    `<p>Pay (direct / BNPL / split) via <code>POST /pay-links/${l.id}/pay</code>, or read it at ${link('/pay-links/' + l.id, '/pay-links/' + l.id)}.</p>`));
}));

// real self-custody wallet: a genuine Canton external party + Ed25519 key
app.post('/wallets', wrap(async (req, res) => {
  const signer: any = wallets;
  const w: any = await signer.create(String(req.body?.name ?? 'wallet'));
  res.status(201).json({ ...w, provider: w.provider ?? 'canton-sdk' });
}));
app.get('/wallets/:id', wrap(async (req, res) => {
  const w = wallets.get(req.params.id);
  if (!w) return res.status(404).json({ error: 'wallet not found' });
  res.json(w);
}));

// public: complete a BNPL loan the user signed in their OWN wallet (the dApp's
// "Request BNPL loan"). The operator ensures the borrower is credit-eligible,
// then accepts their pending UnsecuredRequest — disbursing a real Loan on-ledger.
app.post('/v1/wallet/bnpl/complete', wrap(async (req, res) => {
  const party = String(req.body?.party ?? '').trim();
  if (!party) throw new LedgerError("'party' (borrower partyId) required", '');
  const score = Number(req.body?.score ?? 780);
  const limit = Number(req.body?.limit ?? 1000);
  await led.ensureCredit(party, limit, score);
  const loan = await led.acceptUnsecuredFor(party);
  res.json({ status: 'disbursed', borrower: party, loanId: loan.loanId, amount: loan.amount });
}));

// public: DIRECT checkout step 1 — mint the shopper `amount` (demo on-ramp) and
// return the token cid they then sign a Token_Transfer of, straight to the
// merchant. The transfer is a REAL self-custody debit (no operator mint-to-merchant).
app.post('/v1/wallet/direct/prepare', wrap(async (req, res) => {
  const party = String(req.body?.party ?? '').trim();
  const amount = num(req.body?.amount, 'amount');
  if (!party) throw new LedgerError("'party' required", '');
  res.json({ tokenCid: await led.directPrepare(party, amount), amount });
}));

// public: settle a storefront checkout the customer authorized in their wallet.
//   mode 'credit' | 'bnpl' → the customer already signed an UnsecuredRequest;
//     operator ensures credit + accepts it (customer owes a PRIVATE loan), and
//     the pool fronts the MERCHANT `amount` on-ledger.
//   mode 'direct' → the shopper already signed a Token_Transfer of `amount` to the
//     merchant (REAL on-ledger debit); the client passes the resulting txHash.
// Optionally marks the merchant bill paid (billHash + MERCHANT_APP_URL).
app.post('/v1/wallet/checkout', wrap(async (req, res) => {
  const party = String(req.body?.party ?? '').trim();
  const merchant = String(req.body?.merchant ?? '').trim();
  const amount = Number(req.body?.amount ?? 0);
  const mode = String(req.body?.mode ?? 'credit');
  const billHash = req.body?.billHash ? String(req.body.billHash) : undefined;
  if (!party) throw new LedgerError("'party' (customer partyId) required", '');
  if (!(amount > 0)) throw new LedgerError("'amount' must be a positive number", '');

  let loanId: string | null = null;
  let merchantPaid = false;
  let txHash: string;

  if (mode === 'direct') {
    // The shopper already signed a Token_Transfer of `amount` to the merchant in
    // their own wallet (real debit) — trust + record the on-ledger updateId.
    txHash = String(req.body?.txHash ?? '').trim();
    if (!txHash) throw new LedgerError('direct checkout: missing signed-transfer txHash', '');
    merchantPaid = true; // the shopper paid the merchant directly, on-ledger
  } else {
    // credit | bnpl: the borrower signed an UnsecuredRequest; the operator accepts
    // it (a PRIVATE loan the borrower owes) and the pool fronts the merchant.
    await led.ensureCredit(party, Math.max(1000, amount), 780);
    const loan = await led.acceptUnsecuredFor(party);
    loanId = loan.loanId;
    txHash = loanId;
    // Best-effort merchant payout (a placeholder/un-onboarded merchant party must
    // not fail the customer's checkout).
    if (merchant) {
      try { await led.fund(merchant, amount); merchantPaid = true; }
      catch (e) { console.log(`merchant payout skipped (${merchant.slice(0, 20)}…): ${String((e as any)?.message || e).slice(0, 80)}`); }
    }
  }
  // Best-effort: mark the merchant bill paid so it shows in the dashboard.
  if (billHash) {
    const base = process.env.MERCHANT_APP_URL ?? 'http://localhost:3004';
    fetch(`${base}/api/bills/pay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ billHash, txHash, userAddress: party, paymentMode: mode }) }).catch(() => {});
  }
  res.json({ status: 'settled', mode, amount, merchant: merchant || null, merchantPaid, borrower: party, loanId, txHash });
}));

// public: a party's on-ledger USDC treasury (cash + yield NAV). Used by the
// merchant dashboard Treasury view to show settled funds on Canton.
app.get('/v1/wallet/treasury', wrap(async (req, res) => {
  const party = String(req.query.party ?? '').trim();
  if (!party) throw new LedgerError("'party' query param required", '');
  const t = await led.treasury(party);
  res.json({ party, ...t });
}));

// ── consumer wallet (irion-core app): faucet · positions · repay ───────────
// public: mint test USDC to a wallet so it can supply/repay.
app.post('/v1/wallet/faucet', wrap(async (req, res) => {
  const party = String(req.body?.party ?? '').trim();
  const amount = Number(req.body?.amount ?? 100);
  if (!party) throw new LedgerError("'party' required", '');
  if (!(amount > 0)) throw new LedgerError("'amount' must be positive", '');
  await led.fund(party, amount);
  res.json({ party, minted: amount, balance: await led.usdcBalance(party) });
}));

// public: a consumer's full position — USDC balance, yield, loans, credit line.
app.get('/v1/wallet/positions', wrap(async (req, res) => {
  const party = String(req.query.party ?? '').trim();
  if (!party) throw new LedgerError("'party' query param required", '');
  const [t, loans, credit] = await Promise.all([led.treasury(party), led.listLoans(party), led.getProfile(party)]);
  res.json({ party, balance: t.cash, yield: { shares: t.yieldShares, value: t.yieldValue }, loans, credit });
}));

// public: the cids the wallet needs to self-sign Loan_Pay (repay a loan).
app.post('/v1/wallet/repay/context', wrap(async (req, res) => {
  const party = String(req.body?.party ?? '').trim();
  const loanId = String(req.body?.loanId ?? '').trim();
  const amount = Number(req.body?.amount ?? 0);
  if (!party || !loanId) throw new LedgerError("'party' and 'loanId' required", '');
  if (!(amount > 0)) throw new LedgerError("'amount' must be positive", '');
  res.json(await led.repayContext(party, loanId, amount));
}));

// public: read a payment link (for the /pay page)
app.get('/pay-links/:id', wrap(async (req, res) => {
  const l = store.getLink(req.params.id);
  if (!l) return res.status(404).json({ error: 'payment link not found' });
  const b = store.getById(l.businessId);
  res.json({ id: l.id, amount: l.amount, currency: l.currency, description: l.description, merchant: b?.name ?? 'Merchant', status: l.status, methods: l.methods });
}));
// public: pay a link — direct | bnpl | split (executes on the Canton ledger)
app.post('/pay-links/:id/pay', wrap(async (req, res) => {
  const l = store.getLink(req.params.id);
  if (!l) return res.status(404).json({ error: 'payment link not found' });
  if (l.status === 'paid') return res.status(409).json({ error: 'this link is already paid' });
  const b = store.getById(l.businessId);
  if (!b) return res.status(404).json({ error: 'merchant not found' });
  const method = String(req.body?.method ?? 'direct');
  const name = String(req.body?.name ?? 'Payer');
  const A = l.amount;
  let result: Record<string, unknown>;
  if (method === 'direct') {
    // REAL self-custody: the payer's wallet signs with its OWN Ed25519 key
    // (the Canton SDK self-custody key). prepare → sign → execute.
    const signer: any = wallets;
    const w: any = await signer.create(name);
    await led.fund(w.party, A); // USDC on-ramp into the payer's own wallet
    const [tok] = await led.queryActive(w.party, 'Token', (a: any) => a.owner === w.party);
    if (!tok) throw new LedgerError('wallet funding not found', '');
    const updateId = await signer.signTokenTransfer(w.id, tok.contractId, b.party);
    result = { method, settledOnLedger: String(updateId).slice(0, 18) + '…', payerWallet: w.party, provider: 'canton-sdk', signedBy: 'self-custody key ' + w.fingerprint.slice(0, 14) + '…' };
  } else if (method === 'bnpl') {
    const collateral = Math.ceil(A * 1.25);
    const payer = await led.fundedPayer(name, collateral);
    await led.openProfile(payer);
    await led.attest(payer, A, 650);
    const loanId = await led.openBnpl(b.party, payer, A, collateral);
    result = { method, owes: +(A * 1.05).toFixed(2), collateral, loanId: loanId.slice(0, 18) + '…' };
  } else if (method === 'split') {
    const collateral = Math.ceil(A * 1.25);
    const first = +((A * 1.05) / 4).toFixed(2);
    const payer = await led.fundedPayer(name, collateral + first);
    await led.openProfile(payer);
    await led.attest(payer, A, 650);
    const loanId = await led.openBnpl(b.party, payer, A, collateral);
    await led.repayLoan(payer, loanId, first);
    result = { method, plan: 'pay-in-4', paidNow: first, remaining: 3, perInstallment: first };
  } else {
    throw new LedgerError('unknown method — use direct | bnpl | split', '');
  }
  store.markLinkPaid(l.id, { payer: name, method });
  emit(l.businessId, 'payment_link.paid', { linkId: l.id, amount: A, currency: l.currency, method, payer: name });
  res.json({ ok: true, link: l.id, merchant: b.name, amount: A, currency: l.currency, ...result });
}));
app.get('/v1/health', wrap(async (_req, res) => {
  const v = await fetch(LEDGER_URL + '/v2/version').then((r) => r.json()).catch(() => null);
  res.json({ status: 'ok', ledger: { url: LEDGER_URL, connected: !!v, version: v?.version ?? null }, operator: state.operator, walletSigner: 'canton-sdk' });
}));

// onboard a business (neobank tenant) — returns an API key + its Canton party
app.post('/v1/businesses', wrap(async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) throw new LedgerError("'name' required", '');
  const party = await led.allocateParty(name);
  await led.openProfile(party);
  const b = store.addBusiness(name, party);
  res.status(201).json({ id: b.id, name: b.name, party: b.party, apiKey: b.apiKey, note: 'Store apiKey securely; it authenticates every call (Authorization: Bearer <key>).' });
}));

// ---- everything below requires an API key ----
app.use('/v1', (req: Request, res: Response, next: NextFunction) => {
  const key = (req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? (req.headers['x-api-key'] as string)) || '';
  const b = key ? store.getByKey(key) : undefined;
  if (!b) return res.status(401).json({ error: 'invalid or missing API key' });
  (req as any).business = b;
  next();
});

app.get('/v1/businesses/me', wrap(async (req, res) => {
  const b = biz(req);
  res.json({ id: b.id, name: b.name, party: b.party, createdAt: b.createdAt });
}));

// ================= TREASURY =================
app.get('/v1/treasury', wrap(async (req, res) => {
  const t = await led.treasury(biz(req).party);
  const pool = await led.getPool();
  res.json({ ...t, pool: { totalAssets: pool.totalAssets, utilization: pool.utilization } });
}));
app.post('/v1/treasury/deposit', wrap(async (req, res) => {
  const amount = num(req.body?.amount, 'amount');
  await led.fund(biz(req).party, amount); // demo on-ramp (USDC issuer mints in)
  res.json({ deposited: amount, balance: await led.usdcBalance(biz(req).party) });
}));
app.post('/v1/treasury/sweep', wrap(async (req, res) => {
  const amount = num(req.body?.amount, 'amount');
  await led.sweepToYield(biz(req).party, amount);
  res.json({ swept: amount, treasury: await led.treasury(biz(req).party) });
}));
app.post('/v1/treasury/auto-sweep', wrap(async (req, res) => {
  const buffer = Number(req.body?.buffer ?? 0);
  const t = await led.treasury(biz(req).party);
  const idle = Math.floor((t.cash - buffer) * 100) / 100;
  if (idle > 0) await led.sweepToYield(biz(req).party, idle);
  res.json({ sweptToYield: Math.max(idle, 0), treasury: await led.treasury(biz(req).party) });
}));
app.post('/v1/treasury/redeem', wrap(async (req, res) => {
  await led.redeemFromYield(biz(req).party);
  res.json({ treasury: await led.treasury(biz(req).party) });
}));

// ================= CREDIT =================
app.get('/v1/credit', wrap(async (req, res) => {
  res.json((await led.getProfile(biz(req).party)) ?? { creditLimit: 0, outstanding: 0, available: 0, score: 0, repayments: 0 });
}));
// platform underwrites the business and issues a privacy-native credit attestation
app.post('/v1/credit/request', wrap(async (req, res) => {
  const approvedLimit = num(req.body?.approvedLimit, 'approvedLimit');
  const score = Number(req.body?.score ?? 720);
  await led.attest(biz(req).party, approvedLimit, score);
  res.json({ underwritten: true, profile: await led.getProfile(biz(req).party) });
}));

// ================= LENDING (working capital) =================
app.get('/v1/loans', wrap(async (req, res) => res.json(await led.listLoans(biz(req).party))));
app.post('/v1/loans', wrap(async (req, res) => {
  const amount = num(req.body?.amount, 'amount');
  const termDays = Number(req.body?.termDays ?? 30);
  const loanId = await led.drawWorkingCapital(biz(req).party, amount, termDays);
  const loan = (await led.listLoans(biz(req).party)).find((l) => l.id === loanId);
  emit(biz(req).id, 'loan.created', { loanId, amount, kind: 'working_capital' });
  res.status(201).json({ loanId, ...loan });
}));
app.post('/v1/loans/:id/repay', wrap(async (req, res) => {
  const amount = num(req.body?.amount, 'amount');
  await led.repayLoan(biz(req).party, req.params.id, amount);
  emit(biz(req).id, 'loan.repaid', { loanId: req.params.id, amount });
  res.json({ repaid: amount, loans: await led.listLoans(biz(req).party) });
}));
app.post('/v1/loans/:id/release', wrap(async (req, res) => {
  await led.releaseCollateral(biz(req).party, req.params.id);
  res.json({ released: true, loans: await led.listLoans(biz(req).party) });
}));

// ================= SETTLEMENT =================
app.get('/v1/settlements', wrap(async (req, res) => res.json(store.listSettlements(biz(req).id))));
app.post('/v1/settlements', wrap(async (req, res) => {
  const to = String(req.body?.to ?? '').trim();
  const amount = num(req.body?.amount, 'amount');
  if (!to) throw new LedgerError("'to' (counterparty party id) required", '');
  const updateId = await led.settle(biz(req).party, to, amount);
  const rec = store.addSettlement({ businessId: biz(req).id, from: biz(req).party, to, amount, memo: String(req.body?.memo ?? ''), updateId });
  emit(biz(req).id, 'settlement.created', { id: rec.id, to, amount });
  res.status(201).json(rec);
}));

// ================= PRODUCTS: embedded BNPL =================
// the business (merchant) offers BNPL to one of its customers in a single call.
app.post('/v1/products/bnpl', wrap(async (req, res) => {
  const customerName = String(req.body?.customerName ?? 'customer');
  const amount = num(req.body?.amount, 'amount');
  const collateral = num(req.body?.collateral, 'collateral');
  if (collateral < amount) throw new LedgerError('collateral must be >= amount', '');
  const termDays = Number(req.body?.termDays ?? 30);
  const customer = await led.allocateParty(customerName);
  await led.openProfile(customer);
  await led.attest(customer, amount, 650);       // give the customer a line >= amount
  await led.fund(customer, collateral);          // demo: customer funds collateral
  const loanId = await led.openBnpl(biz(req).party, customer, amount, collateral, termDays);
  res.status(201).json({ loanId, customer, amount, collateral, financedToMerchant: amount });
}));
app.get('/v1/products/bnpl', wrap(async (req, res) => res.json(await led.merchantBnpl(biz(req).party))));

// ================= PAYMENT LINKS (hosted checkout) =================
app.post('/v1/payment-links', wrap(async (req, res) => {
  const amount = num(req.body?.amount, 'amount');
  const link = store.addLink({
    businessId: biz(req).id, amount, currency: String(req.body?.currency ?? 'USDC'),
    description: String(req.body?.description ?? ''), customer: String(req.body?.customer ?? ''),
    methods: Array.isArray(req.body?.methods) ? req.body.methods : ['direct', 'bnpl', 'split'],
  });
  res.status(201).json({ id: link.id, url: `/pay/${link.id}`, amount: link.amount, currency: link.currency, status: link.status });
}));
app.get('/v1/payment-links', wrap(async (req, res) => res.json(store.listLinks(biz(req).id))));

// ================= WEBHOOKS + EVENTS =================
app.post('/v1/webhooks', wrap(async (req, res) => {
  const url = String(req.body?.url ?? '').trim();
  if (!/^https?:\/\//.test(url)) throw new LedgerError("'url' must be an http(s) URL", '');
  store.setWebhook(biz(req).id, url);
  res.json({ url, events: ['payment_link.paid', 'settlement.created', 'loan.created', 'loan.repaid'] });
}));
app.get('/v1/webhooks', wrap(async (req, res) => res.json({ url: store.getWebhook(biz(req).id) ?? null })));
app.post('/v1/webhooks/test', wrap(async (req, res) => { emit(biz(req).id, 'ping', { message: 'Test event from Irion' }); res.json({ ok: true, sent: 'ping' }); }));
app.get('/v1/events', wrap(async (req, res) => res.json(store.listEvents(biz(req).id))));

// ---- errors ----
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof LedgerError) {
    let detail: unknown = err.detail;
    try { detail = JSON.parse(err.detail as string); } catch { /* keep string */ }
    return res.status(400).json({ error: err.message, detail });
  }
  console.error(err);
  res.status(500).json({ error: String(err?.message ?? err) });
});

// ensure multi-currency issuers exist (load persisted; allocate EURC/GBPC on first boot)
async function ensureCurrencies() {
  for (const [cur, party] of Object.entries(store.getCurrencies())) led.setCurrency(cur, party);
  for (const cur of ['EURC', 'GBPC']) {
    if (!led.currencies[cur]) {
      const issuer = await led.allocateParty(cur.toLowerCase() + 'issuer');
      store.setCurrencyIssuer(cur, issuer);
      led.setCurrency(cur, issuer);
      console.log(`allocated ${cur} issuer ${issuer.slice(0, 22)}…`);
    }
  }
  console.log('currencies:', Object.keys(led.currencies).join(', '));
}

ensureCurrencies()
  .catch((e) => console.error('currency init failed:', e?.message ?? e))
  .finally(() => app.listen(PORT, () => console.log(`irion-b2b-api on http://localhost:${PORT}  (ledger ${LEDGER_URL})`)));
