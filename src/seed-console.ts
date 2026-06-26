// Dev seeder: create (or reuse) a demo neobank account on the live ledger, seed
// it with treasury/FX/payroll/credit activity, and print a session token so the
// merchant console can be opened without the (browser-only) passkey ceremony.
//   run: npx tsx src/seed-console.ts
try { process.loadEnvFile(); } catch { /* dev fallback */ }
import * as store from "./store.js";
import { Ledger } from "./canton.js";
import * as accounts from "./accounts.js";
import * as session from "./session.js";

const led = new Ledger(store.cantonConfig(store.loadState()));
for (const [c, p] of Object.entries(store.getCurrencies())) led.setCurrency(c, p);

const email = "demo@acme.test";
let acct = accounts.getAccountByEmail(email);
if (!acct) {
  const party = await led.allocateParty(email);
  await led.openProfile(party);
  acct = accounts.createAccount({ name: "Acme Inc.", email, party, fingerprint: "", publicKey: "" });
}
const token = session.issue({ scope: "session", sub: acct.id }, 86400);

const BASE = "http://localhost:8088";
const api = (m: string, p: string, b?: unknown) =>
  fetch(BASE + p, { method: m, headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());

await api("POST", "/v1/account/treasury/deposit", { amount: 50000, currency: "USDC" });
await api("POST", "/v1/account/treasury/rebalance", { from: "USDC", to: "EURC", amount: 10000 });
await api("POST", "/v1/account/treasury/sweep", { amount: 5000 });
await api("POST", "/v1/account/credit/underwrite", {});
const emps = (await api("GET", "/v1/account/employees")).employees ?? [];
if (emps.length < 2) {
  await api("POST", "/v1/account/employees", { name: "Alice Chen", email: "alice@acme", salary: 4000 });
  await api("POST", "/v1/account/employees", { name: "Bob Ruiz", email: "bob@acme", salary: 3500 });
}
const all = (await api("GET", "/v1/account/employees")).employees ?? [];
await api("POST", "/v1/account/payroll/runs", { entries: all.slice(0, 2).map((e: any) => ({ employeeId: e.id })) });

console.log("SESSION=" + token);
console.log("PARTY=" + acct.party);
process.exit(0);
