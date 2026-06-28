# Irion B2B API

**The REST engine for Irion — private consumer credit + B2B neobank infrastructure on the [Canton Network](https://www.canton.network/).**

> _Buy Now, Pay Never._ Every position is a Daml contract visible only to its signatory and the operator — never the network.

---

## What it is

`irion-b2b-api` is the REST API and engine that sits over the **Canton JSON Ledger API (v2)**. It holds the **operator party**, mediates every on-ledger call, and exposes three coherent surfaces: a self-custody **consumer wallet** (`/v1/wallet/*`), a passkey-authed **B2B neobank** (`/v1/account/*`), and a **legacy machine API** (`/v1/*`).

Balances, credit lines, loans, FX swaps, payroll and yield all live on the Canton ledger as Daml contracts. This server is a clean façade over real `v2` submissions — **nothing in the money path is faked.**

Runs on **`http://localhost:8088`**, with a wallet-service signing gateway on **`http://localhost:3011`**.

## Why it's different

- **Privacy by construction.** A Daml contract is visible only to its signatory + observer parties; the synchronizer that orders transactions sees only encrypted commitments. A business's cash position, credit line, loans and each employee's salary are private *by design* — not by an after-the-fact proof. This is what replaces ZK.
- **Real on-ledger, no mocks in the money path.** Every endpoint issues real Canton JSON Ledger API v2 submissions. The ledger is the source of truth — treasury, FX, payroll, lending and yield are real Daml contracts, verified by the integration suite against a live ledger.
- **Atomic settlement.** Daml transactions are all-or-nothing across parties — real DvP. The FX swap is a single atomic submission carrying the sell + the mint; no half-settled state.
- **Multi-currency with no template change.** Each currency (USDC / EURC / GBPC) is simply a distinct issuer party in the IOU-pattern `Token` contract.

## Features

| Surface | Auth | What it does |
|---|---|---|
| **Consumer wallet** `/v1/wallet/*` | Self-custody (Carpincho) | Faucet, positions, borrow, repay, lend/withdraw, yield, checkout |
| **B2B neobank** `/v1/account/*` | Passkey → HMAC session | Treasury, FX, payroll, lending, payees, sub-accounts, invoices, scheduled, cards, webhooks, statement |
| **Legacy machine API** `/v1/*` | API key (`irion_sk_…`) | The original single-currency suite, kept for M2M integrators |

### Consumer wallet — self-custody (`/v1/wallet/*`)

The shopper's [Carpincho](../irion-core-canton) wallet signs its own transactions (CIP-0103 `prepare → sign → execute` through the `:3011` gateway); the operator only mediates the protocol side.

- **Faucet & positions** — dev faucet, per-party balances and on-ledger positions.
- **Borrow** — the shopper signs an `UnsecuredRequest`; the operator completes the draw and the pool fronts the funds.
- **Repay** — `Loan_Pay` with disclosed contracts.
- **Lend & withdraw** — fully self-custody `SupplyRequest` / `WithdrawRequest` (two solo signs).
- **Simulate yield** — `Pool_InjectYield` to demonstrate NAV accrual.
- **Checkout** — `direct` (shopper-signed `Token_Transfer` straight to the merchant), `credit`, and `bnpl` flows; hosted pay-links and `/pay/[hash]` resolution.

### B2B neobank — passkey session (`/v1/account/*`)

WebAuthn register/login mints an HMAC **session** token; the platform custodies each business's **operator-allocated** Canton party so automated treasury, FX and payroll can sign **unattended**.

- **Treasury** — per-currency balances (USDC / EURC / GBPC), idle-cash yield sweep/redeem, atomic transfers.
- **FX** — a **live rate oracle** ([frankfurter.dev](https://frankfurter.dev), 10-min cache, static fallback) backing a **real atomic on-ledger swap** authorized by `[business, toIssuer]`.
- **Private payroll** — **each salary is its own per-employee `Token` transfer**, visible only to the employer + that employee. No employee can see another's pay — private payroll *by construction*.
- **Lending** — credit score + limit computed from **real on-ledger signals** (treasury depth + repayment history, in `src/underwriting.ts`), then attested. Not a hardcoded number. Draw + repay working capital against the line.
- **Neobank primitives** — payees, sub-accounts/envelopes, invoices, scheduled/standing payments, virtual cards (issue/freeze), webhooks + event log, and a generated statement.

A full machine-readable spec is served at **`GET /openapi.json`**.

## Architecture

```
consumer /app + /pay ─┐                          passkey (WebAuthn) login
shopping /checkout ───┼─► merchant /api (MongoDB)        ─┐
merchant /dashboard ──┤                                   ├─► irion-b2b-api :8088 ─► Canton JSON Ledger API v2 (:6864) ─► Irion Daml protocol
Meridian (neobank) ───┘──── /v1/account/* (Bearer) ──────┘
Carpincho wallet (self-custody) ─► wallet-service gateway :3011 ─► prepare → user signs → execute
```

- **The b2b-api holds the operator party** and mediates every ledger call — real `v2` submissions, nothing in the money path faked.
- **Two auth models.** Consumer = real self-custody via Carpincho (`prepare → user signs → execute` through the `:3011` gateway). B2B = **passkey login → HMAC session**; the platform custodies each business's operator-allocated party so unattended automation can sign. This replaced the old spoofable `x-wallet-address` header.

It submits to the [Irion Daml protocol](../irion-contracts-canton). The passkey-authed consoles ([merchant `/dashboard`](../irion-merchant-app-canton) and [Meridian](../irion-neobank-frontend)) are thin clients over `/v1/account/*`; the [consumer app](../irion-core-canton) drives `/v1/wallet/*`.

## Getting started

```bash
npm install
npm run bootstrap   # allocates platform parties + inits the lending pool on-ledger (writes .irion-state.json)
npm start           # http://localhost:8088   (tsx src/server.ts)
# npm run dev       # same, with watch
```

Requires a Canton ledger with the Irion DAR uploaded (from [`../irion-contracts-canton`](../irion-contracts-canton); JSON Ledger API on `:6864`). Off-ledger metadata persists to gitignored `.irion-*.json` files (accounts, payroll, payees, sub-accounts, invoices, scheduled, cards, webhooks, events, idempotency keys, encrypted keystore).

### Environment (`.env` — see `.env.example`)

| Var | Purpose |
|---|---|
| `CANTON_JSON_API` | Canton JSON Ledger API base (default `http://localhost:6864`) |
| `PORT` | API port (default `8088`) |
| `IRION_MASTER_KEY` | **AES-256-GCM** master key for the encrypted keystore. Must stay stable — rotating it makes existing keys undecryptable. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. **Production: use a KMS/HSM.** |
| `IRION_SESSION_SECRET` | Signing secret for session + step-up tokens (any long random string). |
| `IRION_RP_NAME` / `IRION_RP_ID` / `IRION_RP_ORIGIN` | WebAuthn relying party. `RP_ID` = site domain (no scheme/port); `RP_ORIGIN` = full origin(s), comma-separated. Allowed origins include the consoles on `:3004`, `:3000`, `:3006`. |

### Ports

| Port | Service |
|---|---|
| `8088` | This REST API |
| `3011` | Wallet-service gateway (CIP-0103 self-custody signing) |
| `6864` | Canton JSON Ledger API v2 (the ledger it submits to) |

## Testing

```bash
npm test          # 33 unit tests (node:test via tsx)
npm run test:e2e  # 36 integration tests vs the live ledger
npm run test:all  # both
npm run verify    # 3 headless ledger proofs
npm run typecheck # tsc --noEmit — clean
```

- **`npm test`** — **33 unit tests** (no new runtime deps): crypto, session HMAC, the live FX oracle, the neobank store, accounts, and underwriting.
- **`npm run test:e2e`** — **36 integration tests** exercising every `/v1/account/*` endpoint against a **live ledger**: multi-currency deposit, a real USDC→EURC on-ledger FX swap, yield sweep/redeem, payees + sub-accounts, invoices, scheduled payments, private payroll, real-signal underwriting, draw/repay, atomic transfers, card issue/freeze, webhooks/events and a generated statement. (The browser-only Touch ID / Windows Hello prompt is the auth layer — verified separately — so the harness mints an authorized session directly; everything else is the real HTTP API hitting real Canton.)
- **`npm run verify`** — **3 headless ledger proofs**: `verify-wallet-bnpl` (consumer BNPL), `verify-wallet-supply` (consumer yield supply on existing templates), and `verify-shim-signing` (a fresh self-custody Ed25519 key onboards an external party and `prepare → sign → execute`s a real `UnsecuredRequest` through the `:3011` gateway — the exact CIP-0103 flow Carpincho uses).

## Project layout

```
src/
├── server.ts            # Express app — all routes (/v1/wallet/*, /v1/account/*, /v1/*)
├── canton.ts            # Canton JSON Ledger API v2 client (the on-ledger submissions)
├── wallet-service.ts    # :3011 self-custody signing gateway (CIP-0103 prepare/execute)
├── underwriting.ts      # on-ledger credit scoring — score/limit from treasury depth + repayment history
├── fx.ts                # live FX oracle (frankfurter.dev, cached, static fallback)
├── passkeys.ts          # WebAuthn register/login/step-up (@simplewebauthn/server)
├── session.ts           # HMAC session + step-up token signing/verification
├── accounts.ts          # B2B account model + operator-party allocation
├── neobank-store.ts     # off-ledger metadata (payees, invoices, cards, schedules, webhooks…)
├── crypto.ts            # AES-256-GCM keystore primitives
├── keystore.ts          # persistent encrypted key custody
├── bootstrap.ts         # one-time party allocation + pool init (writes .irion-state.json)
├── openapi.ts           # the GET /openapi.json spec
├── seed-console.ts      # mint a demo session to open the consoles without the passkey tap
├── *.test.ts            # 33 unit tests (crypto, session, fx, neobank-store, accounts, underwriting)
├── test-b2b-e2e.ts      # the 36 live-ledger integration suite
└── verify-*.ts          # headless ledger proofs (wallet-bnpl, wallet-supply, shim-signing)
```

## Status

**Real and tested.** Every endpoint issues real Canton JSON Ledger API v2 submissions; 33 unit + 36 live-ledger integration tests pass and `typecheck` is clean. Treasury, the atomic on-ledger FX swap, private payroll, on-ledger underwriting and consumer borrow/repay/lend are verified against a live ledger.

**Honest boundaries** (real-world integrations left as the production swap, not fakery):

- **Fiat on-ramp** = the issuer mints the stablecoin on-ledger; a real bank/Circle rail replaces the mint with a custody deposit, but the on-ledger effect is identical.
- **FX rate** = a live oracle (frankfurter.dev, cached, with a static fallback); the swap itself is real and atomic on-ledger. A real on-ledger LP/oracle for the rate is the remaining upgrade.
- **Virtual cards** are modeled (issue / freeze / last4) — a real card-network issuer-processor is the production integration.
- **Underwriting signals** are real but shallow (treasury depth + repayment history); bureau / cashflow data is an external feed.
- **Key custody** = AES-256-GCM encrypted keystore with an env master key; production should use a **KMS/HSM**.

---

Part of **Irion** — `github.com/nickthelegend`. Sibling repos: [`irion-contracts-canton`](../irion-contracts-canton) (the Daml protocol), [`irion-core-canton`](../irion-core-canton) (consumer app), [`irion-merchant-app-canton`](../irion-merchant-app-canton) (merchant / neobank console), [`irion-neobank-frontend`](../irion-neobank-frontend) (Meridian).
