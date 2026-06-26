// Lightweight JSON-backed store: ledger state, businesses (API keys), and a
// settlement log. The CANTON LEDGER is the source of truth for balances, credit,
// loans, and yield — this store only holds the API's own mapping + metadata
// (the way Stripe keeps its own objects while money moves on rails).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { CantonConfig } from './canton.js';

const file = (n: string) => resolve(process.cwd(), n);
const STATE = file('.irion-state.json');
const BIZ = file('.irion-businesses.json');
const SETTLE = file('.irion-settlements.json');

export interface LedgerState { operator: string; usdcIssuer: string; creditIssuer: string; configCid: string; poolCid: string }
export interface Business { id: string; name: string; party: string; apiKey: string; createdAt: string }
export interface SettlementRecord { id: string; businessId: string; from: string; to: string; amount: number; memo: string; updateId: string; createdAt: string }

const readJson = <T>(p: string, dflt: T): T => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : dflt);
const writeJson = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 2));

export const isBootstrapped = (): boolean => existsSync(STATE);
export const loadState = (): LedgerState => {
  if (!existsSync(STATE)) throw new Error('not bootstrapped — run `npm run bootstrap` first');
  return readJson<LedgerState>(STATE, {} as LedgerState);
};
export const saveState = (s: LedgerState) => writeJson(STATE, s);

export const cantonConfig = (s: Pick<LedgerState, 'operator' | 'usdcIssuer' | 'creditIssuer'>): CantonConfig => ({
  ledgerUrl: process.env.CANTON_JSON_API ?? 'http://localhost:6864',
  packageName: process.env.IRION_PACKAGE ?? 'irion-model',
  userId: 'irion-b2b-api',
  operator: s.operator, usdcIssuer: s.usdcIssuer, creditIssuer: s.creditIssuer,
});

export const listBusinesses = (): Business[] => readJson<Business[]>(BIZ, []);
export const getByKey = (key: string): Business | undefined => listBusinesses().find((b) => b.apiKey === key);
export const getById = (id: string): Business | undefined => listBusinesses().find((b) => b.id === id);
export const addBusiness = (name: string, party: string): Business => {
  const all = listBusinesses();
  const biz: Business = { id: 'biz_' + randomBytes(6).toString('hex'), name, party, apiKey: 'irion_sk_' + randomBytes(18).toString('hex'), createdAt: new Date().toISOString() };
  all.push(biz);
  writeJson(BIZ, all);
  return biz;
};

export const listSettlements = (businessId: string): SettlementRecord[] => readJson<SettlementRecord[]>(SETTLE, []).filter((s) => s.businessId === businessId);
export const addSettlement = (r: Omit<SettlementRecord, 'id' | 'createdAt'>): SettlementRecord => {
  const all = readJson<SettlementRecord[]>(SETTLE, []);
  const rec: SettlementRecord = { ...r, id: 'stl_' + randomBytes(6).toString('hex'), createdAt: new Date().toISOString() };
  all.push(rec);
  writeJson(SETTLE, all);
  return rec;
};

// ---- payment links (Stripe-style hosted checkout) ----
const LINKS = file('.irion-paymentlinks.json');
export interface PaymentLink {
  id: string; businessId: string; amount: number; currency: string; description: string; customer: string;
  methods: string[]; status: 'open' | 'paid'; createdAt: string; paidAt?: string; payer?: string; method?: string;
}
export const listLinks = (businessId: string): PaymentLink[] => readJson<PaymentLink[]>(LINKS, []).filter((l) => l.businessId === businessId).reverse();
export const getLink = (id: string): PaymentLink | undefined => readJson<PaymentLink[]>(LINKS, []).find((l) => l.id === id);
export const addLink = (l: Omit<PaymentLink, 'id' | 'createdAt' | 'status'>): PaymentLink => {
  const all = readJson<PaymentLink[]>(LINKS, []);
  const link: PaymentLink = { ...l, id: 'pl_' + randomBytes(8).toString('hex'), status: 'open', createdAt: new Date().toISOString() };
  all.push(link);
  writeJson(LINKS, all);
  return link;
};
export const markLinkPaid = (id: string, by: { payer: string; method: string }): PaymentLink | undefined => {
  const all = readJson<PaymentLink[]>(LINKS, []);
  const l = all.find((x) => x.id === id);
  if (!l) return undefined;
  l.status = 'paid'; l.paidAt = new Date().toISOString(); l.payer = by.payer; l.method = by.method;
  writeJson(LINKS, all);
  return l;
};

// ---- webhooks + events ----
const HOOKS = file('.irion-webhooks.json');
const EVENTS = file('.irion-events.json');
export interface WebhookEvent { id: string; businessId: string; type: string; data: unknown; createdAt: string }
export const getWebhook = (businessId: string): string | undefined => readJson<Record<string, string>>(HOOKS, {})[businessId];
export const setWebhook = (businessId: string, url: string) => { const all = readJson<Record<string, string>>(HOOKS, {}); all[businessId] = url; writeJson(HOOKS, all); };
export const listEvents = (businessId: string): WebhookEvent[] => readJson<WebhookEvent[]>(EVENTS, []).filter((e) => e.businessId === businessId).reverse().slice(0, 50);
export const addEvent = (businessId: string, type: string, data: unknown): WebhookEvent => {
  const all = readJson<WebhookEvent[]>(EVENTS, []);
  const ev: WebhookEvent = { id: 'evt_' + randomBytes(6).toString('hex'), businessId, type, data, createdAt: new Date().toISOString() };
  all.push(ev); writeJson(EVENTS, all); return ev;
};

// ---- currency issuers (multi-currency treasury) ----
const CCY = file('.irion-currencies.json');
export const getCurrencies = (): Record<string, string> => readJson<Record<string, string>>(CCY, {});
export const setCurrencyIssuer = (cur: string, party: string) => { const all = getCurrencies(); all[cur.toUpperCase()] = party; writeJson(CCY, all); };

// ---- employees (private payroll) ----
const EMP = file('.irion-employees.json');
export interface Employee { id: string; accountId: string; name: string; email: string; party: string; currency: string; salary?: number; createdAt: string }
export const listEmployees = (accountId: string): Employee[] => readJson<Employee[]>(EMP, []).filter((e) => e.accountId === accountId);
export const getEmployee = (accountId: string, id: string): Employee | undefined => readJson<Employee[]>(EMP, []).find((e) => e.id === id && e.accountId === accountId);
export const addEmployee = (e: Omit<Employee, 'id' | 'createdAt'>): Employee => {
  const all = readJson<Employee[]>(EMP, []);
  const emp: Employee = { ...e, id: 'emp_' + randomBytes(6).toString('hex'), createdAt: new Date().toISOString() };
  all.push(emp); writeJson(EMP, all); return emp;
};

// ---- payroll runs ----
const PAYROLL = file('.irion-payroll.json');
export interface PayrollEntry { employeeId: string; name: string; party: string; amount: number; currency: string; updateId: string }
export interface PayrollRun { id: string; accountId: string; entries: PayrollEntry[]; total: number; currency: string; createdAt: string }
export const listPayrollRuns = (accountId: string): PayrollRun[] => readJson<PayrollRun[]>(PAYROLL, []).filter((p) => p.accountId === accountId).reverse();
export const addPayrollRun = (r: Omit<PayrollRun, 'id' | 'createdAt'>): PayrollRun => {
  const all = readJson<PayrollRun[]>(PAYROLL, []);
  const run: PayrollRun = { ...r, id: 'pay_' + randomBytes(6).toString('hex'), createdAt: new Date().toISOString() };
  all.push(run); writeJson(PAYROLL, all); return run;
};

/** wipe API metadata (used by `bootstrap --force` for a clean demo). Currency
 * issuers persist (they're ledger parties). */
export const clearData = () => {
  for (const f of [BIZ, SETTLE, LINKS, EVENTS, EMP, PAYROLL]) if (existsSync(f)) writeJson(f, []);
  if (existsSync(HOOKS)) writeJson(HOOKS, {});
};
