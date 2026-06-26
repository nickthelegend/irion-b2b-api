# Irion B2B API

**Programmable treasury, FX, payroll, credit, lending & settlement — on Canton.**
*Stripe Treasury + Modern Treasury + Embedded Credit + a neobank-in-a-box, in one API.*

---

## What it is

A REST API over the [Irion Daml protocol](../irion-contracts-canton) on the **Canton Network**. One
integration gives any internet-native business a full banking stack: multi-currency balances with
idle-cash yield, on-ledger FX, private payroll, programmable credit + working-capital loans, instant
atomic settlement, and the supporting neobank primitives (payees, sub-accounts, invoices, scheduled
payments, virtual cards, webhooks, statements).

**Balances, credit, loans, FX and yield all live on the Canton ledger** — this server is a clean
façade that holds the **operator party** and mediates real `v2` JSON Ledger API submissions. Nothing
in the money path is faked.

Runs on **`http://localhost:8088`**.

## Why Canton

- **Privacy by construction.** A business's balances, credit line, loans and each employee's salary
  are visible only to the relevant parties — *sub-transaction privacy*, not a public ledger. For B2B
  treasury and payroll this is decisive: public chains leak your cash position, counterparties and
  comp. This replaces ZK.
- **Atomic settlement.** Daml transactions are all-or-nothing across parties — real DvP, no
  half-settled payments.
- **Programmable + real-asset native.** Daml templates; stablecoin holdings as first-class. Each
  currency (USDC / EURC / GBPC) is simply a distinct issuer party — multi-currency with no template
  change.

## Two auth models

| Model | Used by | How |
|---|---|---|
| **Passkey session** — `/v1/account/*` | The B2B / neobank consoles (merchant `/dashboard`, Meridian) | WebAuthn register/login → HMAC **session** token (`Authorization: Bearer <session>`). The platform custodies each business's **operator-allocated** Canton party, so automated treasury/FX/payroll can sign **unattended**. Step-up re-prompts the passkey for high-value actions. |
| **Legacy API key** — `/v1/*` | Machine-to-machine integrators, the original demo | `POST /v1/businesses` → `irion_sk_…` key (`Authorization: Bearer irion_sk_…`). |
| **Public wallet** — `/v1/wallet/*`, `/wallets`, `/pay/*` | The consumer app (`irion-core-canton` `/app` + `/pay`) | Self-custody: the shopper's Carpincho wallet signs its own transactions; no server-held auth. |

The passkey model replaced the old spoofable `x-wallet-address` header.

## Run

```bash
npm install
npm run bootstrap        # allocates platform parties + inits the lending pool on-ledger (writes .irion-state.json)
npm start                # http://localhost:8088   (tsx src/server.ts)
# npm run dev            # same, with watch
```

Requires a Canton ledger with the Irion DAR uploaded (from `../irion-contracts-canton`; JSON Ledger
API on `:6864`). The repo persists its off-ledger metadata to gitignored `.irion-*.json` files
(accounts, employees, payroll, payees, sub-accounts, invoices, scheduled, cards, webhooks, events,
idempotency keys, encrypted keystore).

### Environment (`.env`, see `.env.example`)

| Var | Purpose |
|---|---|
| `CANTON_JSON_API` | Canton JSON Ledger API base (default `http://localhost:6864`) |
| `PORT` | API port (default `8088`) |
| `IRION_MASTER_KEY` | **AES-256-GCM** master key for the encrypted keystore (`.irion-keystore.json`). Must stay stable — rotating it makes existing encrypted keys undecryptable. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. **Production: use a KMS/HSM, not an env key.** |
| `IRION_SESSION_SECRET` | Signing secret for session + step-up tokens (any long random string). |
| `IRION_RP_NAME` / `IRION_RP_ID` / `IRION_RP_ORIGIN` | WebAuthn relying party. `RP_ID` = site domain (no scheme/port); `RP_ORIGIN` = full origin(s), comma-separated. Allowed origins include the consoles on `:3004`, `:3000`, `:3006`. |

### Verify it end-to-end

```bash
npm run test:e2e         # the b2b-api + a Canton ledger must be running
```

Exercises every `/v1/account/*` endpoint against the **live ledger** with assertions — **36/36
green**: multi-currency deposit, a real USDC→EURC FX swap on-ledger, yield sweep/redeem, payees +
sub-accounts, invoices, scheduled payments, **private payroll** (each salary its own per-employee
contract), real-signal underwriting, working-capital draw/repay, atomic transfers, virtual card
issuance + freeze, webhooks/events and a generated statement. The WebAuthn Touch ID / Windows Hello
prompt is browser-only, so the harness mints an authorized session directly (the passkey is the auth
layer, verified separately); everything else is the real HTTP API hitting real Canton.

## API reference

Full machine-readable spec at **`GET /openapi.json`**. The live surface (from `src/server.ts`):

### Passkey auth — public begin/finish
`POST /v1/auth/register/begin · /register/finish` · `login/begin · /login/finish` ·
`stepup/begin · /stepup/finish` · `GET /v1/auth/me`. The `begin` calls return standard WebAuthn
options for `@simplewebauthn/browser`; `finish` posts the credential back. Challenges ride in a
signed token (stateless). `finish` allocates the account's Canton party and returns a session.

### Account — treasury, multi-currency + FX (passkey session)
| Endpoint | Purpose |
|---|---|
| `GET /v1/account` · `GET /v1/auth/me` | current account |
| `GET /v1/account/treasury` | per-currency balances (USDC / EURC / GBPC) + yield + total |
| `POST /v1/account/faucet` | dev faucet — mint test funds |
| `POST /v1/account/treasury/deposit` | `{amount, currency}` on-ramp (issuer mint) |
| `GET /v1/account/treasury/rates` · `GET /v1/account/fx/quote` | FX rates / a quote (operator-quoted) |
| `POST /v1/account/treasury/rebalance` | `{from, to, amount}` — **real on-ledger FX swap** |
| `POST /v1/account/treasury/sweep` · `/redeem` | move idle USDC in/out of the yield pool |
| `POST /v1/account/transfers` | `{to, amount, currency}` atomic settlement |

### Payments — payees & sub-accounts
| Endpoint | Purpose |
|---|---|
| `GET·POST /v1/account/payees`, `DELETE /v1/account/payees/:id` | saved counterparties |
| `GET·POST /v1/account/sub-accounts` | named balances / envelopes |
| `POST /v1/account/sub-accounts/:id/move` | move funds between sub-accounts |

### Invoices
| Endpoint | Purpose |
|---|---|
| `GET·POST /v1/account/invoices` | create / list invoices |
| `POST /v1/account/invoices/:id/pay` | settle an invoice on-ledger |

### Private payroll
| Endpoint | Purpose |
|---|---|
| `GET·POST /v1/account/employees` | manage employees (each gets a Canton payee party) |
| `GET·POST /v1/account/payroll/runs` | run payroll — **each salary is a separate `Token` transfer visible only to the employer + that employee.** No employee can see another's pay: private payroll *by construction* on Canton. |

### Credit + lending — real on-ledger underwriting
| Endpoint | Purpose |
|---|---|
| `GET /v1/account/credit` | credit profile (limit, score, available, outstanding) |
| `POST /v1/account/credit/underwrite` | score + limit computed from **real on-ledger signals** (treasury depth + repayment history), then attested — not a hardcoded number |
| `GET·POST /v1/account/loans`, `POST /v1/account/loans/:id/repay` | draw + repay working capital against the line |

### Scheduled payments
`GET·POST /v1/account/scheduled` · `POST /v1/account/scheduled/run-due` ·
`/:id/run` · `/:id/pause` · `/:id/resume` — recurring/standing transfers the operator-custodied
party executes unattended.

### Virtual cards
`GET·POST /v1/account/cards` · `POST /v1/account/cards/:id/freeze` · `/:id/unfreeze`.

### Webhooks, events, transactions, statement
`GET·POST /v1/account/webhooks`, `DELETE /v1/account/webhooks/:id` ·
`GET /v1/account/events` (account event log) ·
`GET /v1/account/transactions` (unified ledger activity) ·
`GET /v1/account/statement` (generated statement).

### Consumer wallet — public, self-custody (`/v1/wallet/*`)
Used by the consumer `/app` and the hosted `/pay/[hash]` checkout. The shopper's Carpincho wallet
signs its own transactions; the operator only mediates the protocol side.

| Endpoint | Purpose |
|---|---|
| `POST /wallets`, `GET /wallets/:id` | create a **real self-custody wallet** — a Canton external party whose Ed25519 key signs its own txns |
| `GET /v1/wallet/treasury` · `GET /v1/wallet/positions` | balances / on-ledger positions for a party |
| `POST /v1/wallet/faucet` | dev faucet |
| `POST /v1/wallet/direct/prepare` | DIRECT checkout step 1: funds the shopper + returns the token cid they then sign a `Token_Transfer` of, straight to the merchant (a **real self-custody debit**) |
| `POST /v1/wallet/checkout` | settle a storefront checkout: `direct` (shopper-signed transfer) or `credit`/`bnpl` (shopper-signed `UnsecuredRequest` → operator accepts → pool fronts the merchant); optionally marks the merchant bill paid |
| `POST /v1/wallet/bnpl/complete` · `POST /v1/wallet/repay/context` | disburse a BNPL/credit draw · build a repay command |
| `GET /pay-links/:id`, `POST /pay-links/:id/pay` · `GET /pay/:id` | hosted payment links / checkout resolution |

### Legacy machine API (`/v1/*`, `irion_sk_…` key)
The original single-currency suite, kept for M2M integrators:
`POST /v1/businesses`, `GET /v1/businesses/me` · `GET /v1/treasury`, `/deposit`, `/sweep`,
`/auto-sweep`, `/redeem` · `GET /v1/credit`, `POST /v1/credit/request` · `GET·POST /v1/loans`,
`/:id/repay`, `/:id/release` · `GET·POST /v1/settlements` · `GET·POST /v1/products/bnpl` ·
`GET·POST /v1/payment-links` · `GET·POST /v1/webhooks`, `/webhooks/test` · `GET /v1/events` ·
`GET /v1/health`.

## How it fits the system

```
consumer /app + /pay ─┐                          passkey (WebAuthn) login
shopping /checkout ───┼─► merchant /api (MongoDB)        ─┐
merchant /dashboard ──┤                                   ├─► irion-b2b-api :8088 ─► Canton JSON Ledger API v2 (:6864) ─► Irion Daml protocol
Meridian (neobank) ───┘──── /v1/account/* (Bearer) ──────┘
Carpincho wallet (self-custody) ─► /v1/wallet/* (prepare → user signs → execute)
```

The merchant `/dashboard` and **Meridian** (`../irion-neobank-frontend`) are passkey-authed thin
clients over `/v1/account/*`. `../irion-demo-company` narrates the suite end-to-end. The Daml
protocol it submits to is `../irion-contracts-canton`.

## Honest boundaries (not mocks — real-world integrations left as the production swap)

Every endpoint executes real Canton JSON Ledger API submissions; the ledger is the source of truth.
The remaining gaps are external integrations, not fakery:

- **On-ramp** = the issuer mints the stablecoin on-ledger (canonical on a sandbox). A real fiat rail
  (bank / Circle) would replace the mint with a custody deposit; the on-ledger effect is identical.
- **FX rate** = operator-quoted config values (`FX_RATES` in `server.ts`). The swap itself is real
  on-ledger; production would source the rate from a price oracle / liquidity pool. (The swap is two
  txns — an atomic single-tx `FxSwap` needs a new Daml template → DAR rebuild.)
- **Virtual cards** are modeled (issue / freeze / last4) — a real card network (issuer-processor) is
  the production integration.
- **Underwriting** signals are shallow (treasury depth + repayment history); real bureau / cashflow
  data is external. The legacy `/v1/credit/request` still trusts a caller-supplied score — the
  `/v1/account/credit/underwrite` path is the real one.
- **Passkey ceremony** — the WebAuthn verification, options, sessions and step-up are real and
  tested; the actual Touch ID / Windows Hello prompt requires a browser (driven by the console UIs),
  so `test:e2e` mints the authorized session directly.
- **Key custody** = AES-256-GCM encrypted keystore with an env master key. Production should use a
  KMS/HSM.
