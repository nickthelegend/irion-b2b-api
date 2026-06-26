# Irion B2B API

**Programmable treasury, credit, lending & settlement — on Canton.**
*Stripe Treasury + Modern Treasury + Embedded Credit, in one API.*

---

## The problem

Financial infrastructure today is fragmented. To manage treasury, access working capital, move money globally, offer customer financing, or launch a financial product, a business needs **multiple providers, multiple integrations, multiple compliance workflows**.

The result: capital sits idle, credit is slow and restrictive, cross-border payments are expensive, products are hard to launch. Financial infrastructure was built for banks — not for internet-native businesses.

## The solution

Irion turns credit and treasury infrastructure into **programmable APIs**. One integration gives any business four primitives:

| Primitive | What a business gets | Backed on-ledger by |
|---|---|---|
| **Treasury** | hold balances; idle cash auto-earns yield | `LendingPool` shares + USDC `Token` holdings |
| **Credit** | programmable, privacy-native creditworthiness | `CreditProfile` + issuer-signed `CreditAttestation` |
| **Lending** | instant working capital on demand | `Loan` (unsecured, gated on the credit line) |
| **Settlement** | move money anywhere, instantly & atomically | `Token` transfer between Canton parties |

On top of those, businesses launch **products**: embedded **BNPL**, embedded lending, treasury automation.

Every business is a **Canton party**; this API holds the operator party and mediates. **Balances, credit, loans and yield all live on the Canton ledger** — this server is a clean façade over the [Irion Daml protocol](../irion-contracts-canton).

## Why Canton

- **Privacy by construction.** A business's balances, credit line, and loans are visible only to it and Irion — *sub-transaction privacy*, not a public ledger. For B2B treasury this is decisive: public chains leak your cash position and counterparties.
- **Atomic settlement.** Daml transactions are all-or-nothing across parties — real DvP, no half-settled payments.
- **Programmable + real-asset native.** Daml templates; stablecoin/USDC holdings as first-class.

```
  any neobank / internet business
        │  REST + API key (Authorization: Bearer irion_sk_…)
        ▼
  ┌──────────────────────┐   Treasury · Credit · Lending · Settlement
  │     irion-b2b-api     │   + products: BNPL, embedded lending, treasury automation
  │  (operator-mediated)  │
  └──────────────────────┘
        │  Canton JSON Ledger API (v2)
        ▼
  Irion Daml protocol on Canton  ── private by construction, atomic
```

## Quickstart

```bash
# 1. a Canton ledger with the Irion DAR (from ../irion-contracts-canton)
cd ../irion-contracts-canton && dpm sandbox &        # JSON API on :6864
dpm script --dar model-tests/.daml/dist/irion-model-tests-1.0.0.dar \
  --script-name Test.Irion.Token:test_token_lifecycle \
  --ledger-host localhost --ledger-port 6865 --upload-dar true --wall-clock-time   # uploads the DAR

# 2. the B2B API
cd ../irion-b2b-api
npm install
npm run bootstrap     # allocates platform parties + inits the pool on-ledger
npm start             # http://localhost:8088

# 3. see it work
open http://localhost:8088/dashboard          # live neobank dashboard
cd ../irion-demo-company && npm install && npm run demo   # narrated end-to-end story
```

## API reference

Onboard, then pass `Authorization: Bearer <apiKey>` on every call.

```bash
# onboard a business -> { apiKey, party }
curl -s localhost:8088/v1/businesses -H content-type:application/json -d '{"name":"Acme"}'
KEY=irion_sk_...   # from the response

# TREASURY
curl -s localhost:8088/v1/treasury           -H "authorization: Bearer $KEY"
curl -s localhost:8088/v1/treasury/deposit   -H "authorization: Bearer $KEY" -H content-type:application/json -d '{"amount":1000000}'
curl -s localhost:8088/v1/treasury/sweep     -H "authorization: Bearer $KEY" -H content-type:application/json -d '{"amount":800000}'
curl -s localhost:8088/v1/treasury/auto-sweep -H "authorization: Bearer $KEY" -H content-type:application/json -d '{"buffer":200000}'

# CREDIT (platform underwrites + issues a privacy-native attestation)
curl -s localhost:8088/v1/credit/request -H "authorization: Bearer $KEY" -H content-type:application/json -d '{"approvedLimit":250000,"score":780}'

# LENDING (working capital)
curl -s localhost:8088/v1/loans          -H "authorization: Bearer $KEY" -H content-type:application/json -d '{"amount":50000,"termDays":30}'
curl -s localhost:8088/v1/loans/<id>/repay -H "authorization: Bearer $KEY" -H content-type:application/json -d '{"amount":55000}'

# SETTLEMENT
curl -s localhost:8088/v1/settlements -H "authorization: Bearer $KEY" -H content-type:application/json -d '{"to":"<party>","amount":25000,"memo":"invoice 42"}'

# PRODUCT: embedded BNPL (merchant paid up front)
curl -s localhost:8088/v1/products/bnpl -H "authorization: Bearer $KEY" -H content-type:application/json -d '{"customerName":"Jane","amount":400,"collateral":500}'
```

Full machine-readable spec at **`GET /openapi.json`**.

## B2B Console API (passkey-authenticated)

The neobank/B2B console uses **passkeys** (WebAuthn — Mac Touch ID / Windows Hello / any FIDO2, synced across the user's devices) instead of API keys. The passkey is **login + step-up approval**; Irion custodies each business's operational Canton key (operator-allocated party) so **automated treasury rebalancing and scheduled payroll can sign unattended**. Pass `Authorization: Bearer <session>` (from `/v1/auth/login|register/finish`) on every `/v1/account/*` call. This also fixes the legacy spoofable-header auth.

**Auth (passkeys)** — `POST /v1/auth/register/begin·finish`, `login/begin·finish`, `stepup/begin·finish`, `GET /v1/auth/me`. The `begin` calls return standard WebAuthn options for `@simplewebauthn/browser`; `finish` posts the credential back. Challenges ride in a signed token (stateless).

**Treasury — multi-currency + FX**
| Endpoint | Purpose |
|---|---|
| `GET /v1/account/treasury` | per-currency balances (USDC / EURC / GBPC) + yield + total |
| `POST /v1/account/treasury/deposit` | `{amount, currency}` on-ramp |
| `GET /v1/account/treasury/rates` | FX rates (operator-quoted) |
| `POST /v1/account/treasury/rebalance` | `{from, to, amount}` — **real on-ledger FX swap** |
| `POST /v1/account/treasury/sweep` · `redeem` | move idle USDC in/out of the yield pool |
| `POST /v1/account/transfers` | `{to, amount, currency}` atomic settlement |

**Private payroll**
| Endpoint | Purpose |
|---|---|
| `GET·POST /v1/account/employees` | manage employees (each gets a Canton payee party) |
| `GET·POST /v1/account/payroll/runs` | run payroll — **each salary is a separate Token transfer visible only to the employer + that employee.** No employee can see another's pay: private payroll *by construction* on Canton. |

**Lending — real on-ledger underwriting**
| Endpoint | Purpose |
|---|---|
| `POST /v1/account/credit/underwrite` | score + limit computed from **real on-ledger signals** (treasury depth + repayment history), then attested — not a hardcoded number |
| `GET /v1/account/credit` | credit profile |
| `GET·POST /v1/account/loans` · `/{id}/repay` | draw + repay working capital against the line |

### Verify it end-to-end
```bash
npm run test:e2e      # the b2b-api + a Canton ledger must be running
```
Exercises every `/v1/account/*` endpoint against the **live ledger** with assertions — **20/20 green**: deposit 20k USDC · swap 5k USDC→4.6k EURC (real) + 1k→GBPC · sweep/redeem yield · pay 2 employees privately · underwrite (score 762 from treasury) · draw + repay a loan · settle a transfer.

## What's real (not a mock)

Every endpoint executes real Canton JSON Ledger API submissions; the ledger is the source of truth. Verified end-to-end on a live Canton node (`dpm sandbox`):

- deposit 1,000,000 → sweep 800,000 → **799,999 yield shares** (1.0 locked as the donation-attack guard)
- credit line lifted to 200,000 by an attestation, **grew to 205,000** after a repayment reward
- 50,000 working capital drawn (owes 55,000 at the unsecured rate), repaid, 0 open loans
- 25,000 settled to a counterparty (atomic Canton transfer)
- BNPL: customer financed 400 / 500 collateral, merchant paid up front, loan owes 420

See `../irion-demo-company` for the narrated run and the dashboard.

The B2B console suite (`/v1/account/*`) is verified the same way by `npm run test:e2e` (**20/20** against a live ledger): multi-currency deposit, a real USDC→EURC FX swap on-ledger, yield sweep/redeem, **private payroll** (each salary its own per-employee contract), real-signal underwriting, working-capital draw/repay, and atomic transfer.

### Honest boundaries (not mocks — real-world integrations left as the production swap)
- **On-ramp** = the issuer mints the stablecoin on-ledger (canonical on a sandbox). A real fiat rail (bank/Circle) would replace the mint with a custody deposit; the on-ledger effect is identical.
- **FX rate** = operator-quoted config values. The swap itself is real on-ledger; production would source the rate from a price oracle / liquidity pool.
- **Passkey ceremony** — the WebAuthn verification, options, sessions and step-up are real and tested; the actual Touch ID / Windows Hello prompt requires a browser (driven by the merchant console UI), so `test:e2e` mints the authorized session directly.
- **Key custody** = AES-256-GCM encrypted keystore with an env master key. Production should use a KMS/HSM.
