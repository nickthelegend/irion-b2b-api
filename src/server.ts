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
const idem = new Map<string, { status: number; body: unknown }>();
app.use((req, res, next) => {
  const k = req.method === 'POST' ? (req.headers['idempotency-key'] as string) : '';
  if (k && idem.has(k)) { const c = idem.get(k)!; return res.status(c.status).json(c.body); }
  if (k) { const orig = res.json.bind(res); (res as any).json = (b: unknown) => { idem.set(k, { status: res.statusCode, body: b }); return orig(b as any); }; }
  next();
});

// emit an event + deliver to the business's webhook (fire-and-forget)
function emit(businessId: string, type: string, data: unknown) {
  store.addEvent(businessId, type, data);
  const url = store.getWebhook(businessId);
  if (url) fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, data, createdAt: new Date().toISOString() }) }).catch(() => {});
}

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

// public: settle a storefront checkout the customer authorized in their wallet.
//   mode 'credit' | 'bnpl' → the customer already signed an UnsecuredRequest;
//     operator ensures credit + accepts it (customer owes a PRIVATE loan), and
//     the MERCHANT is paid `amount` on-ledger.
//   mode 'direct' → pay-in-full; the MERCHANT is paid `amount` on-ledger.
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
  if (mode === 'bnpl' || mode === 'credit') {
    await led.ensureCredit(party, Math.max(1000, amount), 780);
    const loan = await led.acceptUnsecuredFor(party);
    loanId = loan.loanId;
  }
  // Pay the merchant on-ledger (the pool/customer settles `amount` to the merchant
  // party). Best-effort: a seeded/demo merchant whose party isn't onboarded on the
  // ledger (UNKNOWN_INFORMEES) shouldn't fail the customer's checkout.
  let merchantPaid = false;
  if (merchant) {
    try { await led.fund(merchant, amount); merchantPaid = true; }
    catch (e) { console.log(`merchant payout skipped (${merchant.slice(0, 20)}…): ${String((e as any)?.message || e).slice(0, 80)}`); }
  }

  const txHash = loanId ?? `direct-${Date.now().toString(36)}`;
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

app.listen(PORT, () => console.log(`irion-b2b-api on http://localhost:${PORT}  (ledger ${LEDGER_URL})`));
