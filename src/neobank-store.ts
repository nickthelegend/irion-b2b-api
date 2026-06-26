// Neobank object stores (JSON-backed, per-account) for the B2B API:
// payees, sub-accounts, invoices/payment-requests, scheduled payments, virtual
// cards, and account-scoped webhooks. The CANTON LEDGER remains the source of
// truth for money; these hold the neobank's own metadata (the way a bank keeps
// its own objects while value moves on rails).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const file = (n: string) => resolve(process.cwd(), n);
const read = <T>(p: string, d: T): T => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : d);
const write = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 2));
const id = (pfx: string) => `${pfx}_${randomBytes(7).toString('hex')}`;
const now = () => new Date().toISOString();

// ---- payees (saved beneficiaries) ----
const PAYEES = file('.irion-payees.json');
export interface Payee { id: string; accountId: string; name: string; party: string; currency: string; createdAt: string }
export const listPayees = (a: string): Payee[] => read<Payee[]>(PAYEES, []).filter((p) => p.accountId === a);
export const getPayee = (a: string, pid: string): Payee | undefined => read<Payee[]>(PAYEES, []).find((p) => p.id === pid && p.accountId === a);
export const addPayee = (p: Omit<Payee, 'id' | 'createdAt'>): Payee => {
  const all = read<Payee[]>(PAYEES, []); const rec = { ...p, id: id('payee'), createdAt: now() }; all.push(rec); write(PAYEES, all); return rec;
};
export const removePayee = (a: string, pid: string): boolean => {
  const all = read<Payee[]>(PAYEES, []); const next = all.filter((p) => !(p.id === pid && p.accountId === a));
  if (next.length === all.length) return false; write(PAYEES, next); return true;
};

// ---- sub-accounts (pots): each is its own operator-allocated Canton party ----
const SUBS = file('.irion-subaccounts.json');
export interface SubAccount { id: string; accountId: string; name: string; party: string; createdAt: string }
export const listSubs = (a: string): SubAccount[] => read<SubAccount[]>(SUBS, []).filter((s) => s.accountId === a);
export const getSub = (a: string, sid: string): SubAccount | undefined => read<SubAccount[]>(SUBS, []).find((s) => s.id === sid && s.accountId === a);
export const addSub = (s: Omit<SubAccount, 'id' | 'createdAt'>): SubAccount => {
  const all = read<SubAccount[]>(SUBS, []); const rec = { ...s, id: id('sub'), createdAt: now() }; all.push(rec); write(SUBS, all); return rec;
};

// ---- invoices / payment requests ----
const INV = file('.irion-invoices.json');
export interface Invoice { id: string; accountId: string; number: string; counterparty: string; amount: number; currency: string; description: string; status: 'open' | 'paid'; createdAt: string; paidAt?: string; txHash?: string }
export const listInvoices = (a: string): Invoice[] => read<Invoice[]>(INV, []).filter((i) => i.accountId === a).reverse();
export const getInvoice = (a: string, iid: string): Invoice | undefined => read<Invoice[]>(INV, []).find((i) => i.id === iid && i.accountId === a);
export const addInvoice = (i: Omit<Invoice, 'id' | 'number' | 'status' | 'createdAt'>): Invoice => {
  const all = read<Invoice[]>(INV, []); const n = all.filter((x) => x.accountId === i.accountId).length + 1;
  const rec: Invoice = { ...i, id: id('inv'), number: `INV-${String(n).padStart(4, '0')}`, status: 'open', createdAt: now() };
  all.push(rec); write(INV, all); return rec;
};
export const markInvoicePaid = (a: string, iid: string, txHash: string): Invoice | undefined => {
  const all = read<Invoice[]>(INV, []); const inv = all.find((i) => i.id === iid && i.accountId === a);
  if (!inv) return undefined; inv.status = 'paid'; inv.paidAt = now(); inv.txHash = txHash; write(INV, all); return inv;
};

// ---- scheduled payments (standing orders + recurring payroll) ----
const SCHED = file('.irion-scheduled.json');
export interface Scheduled {
  id: string; accountId: string; type: 'transfer' | 'payroll'; label: string;
  intervalDays: number; nextRun: string; status: 'active' | 'paused';
  payload: any; createdAt: string; lastRun?: string; runs: number;
}
export const listScheduled = (a: string): Scheduled[] => read<Scheduled[]>(SCHED, []).filter((s) => s.accountId === a);
export const getScheduled = (a: string, sid: string): Scheduled | undefined => read<Scheduled[]>(SCHED, []).find((s) => s.id === sid && s.accountId === a);
export const dueScheduled = (): Scheduled[] => { const t = now(); return read<Scheduled[]>(SCHED, []).filter((s) => s.status === 'active' && s.nextRun <= t); };
export const addScheduled = (s: Omit<Scheduled, 'id' | 'status' | 'createdAt' | 'runs'>): Scheduled => {
  const all = read<Scheduled[]>(SCHED, []); const rec: Scheduled = { ...s, id: id('sched'), status: 'active', createdAt: now(), runs: 0 };
  all.push(rec); write(SCHED, all); return rec;
};
export const advanceScheduled = (sid: string) => {
  const all = read<Scheduled[]>(SCHED, []); const s = all.find((x) => x.id === sid); if (!s) return;
  s.lastRun = now(); s.runs += 1; s.nextRun = new Date(Date.now() + s.intervalDays * 86400_000).toISOString(); write(SCHED, all);
};
export const setScheduledStatus = (a: string, sid: string, status: 'active' | 'paused'): boolean => {
  const all = read<Scheduled[]>(SCHED, []); const s = all.find((x) => x.id === sid && x.accountId === a); if (!s) return false;
  s.status = status; write(SCHED, all); return true;
};

// ---- virtual cards (modeled; card-network issuance is a real-world integration) ----
const CARDS = file('.irion-cards.json');
export interface Card { id: string; accountId: string; label: string; last4: string; brand: string; status: 'active' | 'frozen'; spendLimit?: number; currency: string; subAccountId?: string; createdAt: string }
export const listCards = (a: string): Card[] => read<Card[]>(CARDS, []).filter((c) => c.accountId === a);
export const addCard = (c: Omit<Card, 'id' | 'last4' | 'brand' | 'status' | 'createdAt'>): Card => {
  const all = read<Card[]>(CARDS, []);
  const rec: Card = { ...c, id: id('card'), last4: String(1000 + (parseInt(randomBytes(2).toString('hex'), 16) % 9000)), brand: 'Irion Virtual', status: 'active', createdAt: now() };
  all.push(rec); write(CARDS, all); return rec;
};
export const setCardStatus = (a: string, cid: string, status: 'active' | 'frozen'): Card | undefined => {
  const all = read<Card[]>(CARDS, []); const c = all.find((x) => x.id === cid && x.accountId === a); if (!c) return undefined;
  c.status = status; write(CARDS, all); return c;
};

// ---- account-scoped webhooks ----
const HOOKS = file('.irion-account-webhooks.json');
export interface AccountWebhook { id: string; accountId: string; url: string; events: string[]; createdAt: string }
export const listWebhooks = (a: string): AccountWebhook[] => read<AccountWebhook[]>(HOOKS, []).filter((w) => w.accountId === a);
export const addWebhook = (w: Omit<AccountWebhook, 'id' | 'createdAt'>): AccountWebhook => {
  const all = read<AccountWebhook[]>(HOOKS, []); const rec = { ...w, id: id('wh'), createdAt: now() }; all.push(rec); write(HOOKS, all); return rec;
};
export const removeWebhook = (a: string, wid: string): boolean => {
  const all = read<AccountWebhook[]>(HOOKS, []); const next = all.filter((w) => !(w.id === wid && w.accountId === a));
  if (next.length === all.length) return false; write(HOOKS, next); return true;
};
/** fire all of an account's webhooks for an event (best-effort). */
export const deliverWebhooks = (accountId: string, type: string, data: unknown) => {
  for (const w of listWebhooks(accountId)) {
    if (w.events.length && !w.events.includes(type) && !w.events.includes('*')) continue;
    fetch(w.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, data, createdAt: now() }) }).catch(() => {});
  }
};
