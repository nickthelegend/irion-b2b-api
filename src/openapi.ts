// OpenAPI 3.0 description of the Irion B2B API, served at GET /openapi.json.
const ok = (description: string) => ({ '200': { description } });
const body = (props: Record<string, unknown>, required: string[] = []) => ({
  required: true,
  content: { 'application/json': { schema: { type: 'object', required, properties: props } } },
});
const N = { type: 'number' };
const S = { type: 'string' };

export const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'Irion B2B API',
    version: '0.1.0',
    description:
      'Programmable **Treasury · Credit · Lending · Settlement** on Canton — "Stripe Treasury + Modern Treasury + Embedded Credit". ' +
      'One integration gives any internet-native business idle-cash yield, instant working capital, global atomic settlement, and embedded financial products (BNPL). ' +
      'Balances, credit, loans and yield all live on the Canton ledger; privacy is by construction.',
  },
  servers: [{ url: 'http://localhost:8088' }],
  security: [{ apiKey: [] }],
  components: {
    securitySchemes: {
      apiKey: { type: 'http', scheme: 'bearer', description: 'Your irion_sk_… key from POST /v1/businesses (legacy machine API)' },
      session: { type: 'http', scheme: 'bearer', description: 'Passkey session token from /v1/auth/login|register/finish (B2B console)' },
    },
  },
  tags: [
    { name: 'Auth' }, { name: 'Accounts' }, { name: 'Payroll' },
    { name: 'Onboarding' }, { name: 'Treasury' }, { name: 'Credit' }, { name: 'Lending' }, { name: 'Settlement' }, { name: 'Products' }, { name: 'Wallets' },
  ],
  paths: {
    '/v1/health': { get: { security: [], summary: 'Health + ledger connectivity', responses: ok('healthy') } },
    '/v1/businesses': {
      post: {
        tags: ['Onboarding'], security: [], summary: 'Onboard a business (returns an API key + its Canton party)',
        requestBody: body({ name: S }, ['name']), responses: { '201': { description: 'created' } },
      },
    },
    '/v1/businesses/me': { get: { tags: ['Onboarding'], summary: 'Current business', responses: ok('business') } },

    '/v1/treasury': { get: { tags: ['Treasury'], summary: 'Cash + yield position + total', responses: ok('treasury') } },
    '/v1/treasury/deposit': { post: { tags: ['Treasury'], summary: 'Fund treasury (USDC on-ramp)', requestBody: body({ amount: N }, ['amount']), responses: ok('balance') } },
    '/v1/treasury/sweep': { post: { tags: ['Treasury'], summary: 'Sweep idle cash into the yield pool', requestBody: body({ amount: N }, ['amount']), responses: ok('treasury') } },
    '/v1/treasury/auto-sweep': { post: { tags: ['Treasury'], summary: 'Treasury automation: sweep all cash above a buffer', requestBody: body({ buffer: N }), responses: ok('treasury') } },
    '/v1/treasury/redeem': { post: { tags: ['Treasury'], summary: 'Redeem the yield position back to cash', responses: ok('treasury') } },

    '/v1/credit': { get: { tags: ['Credit'], summary: 'Credit profile (limit, score, available, outstanding)', responses: ok('profile') } },
    '/v1/credit/request': { post: { tags: ['Credit'], summary: 'Request a credit line (platform underwrites + issues a privacy-native attestation)', requestBody: body({ approvedLimit: N, score: N }, ['approvedLimit']), responses: ok('profile') } },

    '/v1/loans': {
      get: { tags: ['Lending'], summary: 'List loans', responses: ok('loans') },
      post: { tags: ['Lending'], summary: 'Draw unsecured working capital against the credit line', requestBody: body({ amount: N, termDays: N }, ['amount']), responses: { '201': { description: 'loan' } } },
    },
    '/v1/loans/{id}/repay': { post: { tags: ['Lending'], summary: 'Repay a loan', parameters: [{ name: 'id', in: 'path', required: true, schema: S }], requestBody: body({ amount: N }, ['amount']), responses: ok('loans') } },

    '/v1/settlements': {
      get: { tags: ['Settlement'], summary: 'List settlements', responses: ok('settlements') },
      post: { tags: ['Settlement'], summary: 'Settle: move USDC to any counterparty (instant, atomic, global)', requestBody: body({ to: S, amount: N, memo: S }, ['to', 'amount']), responses: { '201': { description: 'settlement' } } },
    },

    '/v1/products/bnpl': {
      get: { tags: ['Products'], summary: 'List BNPL plans where this business is the merchant', responses: ok('plans') },
      post: { tags: ['Products'], summary: 'Offer embedded BNPL to a customer (merchant is paid up front)', requestBody: body({ customerName: S, amount: N, collateral: N, termDays: N }, ['amount', 'collateral']), responses: { '201': { description: 'plan' } } },
    },
    '/wallets': { post: { tags: ['Wallets'], security: [], summary: 'Create a REAL self-custody wallet — a Canton external party whose Ed25519 key signs its own transactions (used by /pay "Pay Directly")', requestBody: body({ name: S }), responses: { '201': { description: 'wallet (id, party, fingerprint)' } } } },

    // ---- Passkey auth (public begin/finish) ----
    '/v1/auth/register/begin': { post: { tags: ['Auth'], security: [], summary: 'Begin passkey registration → WebAuthn options + regToken', requestBody: body({ name: S, email: S }, ['name', 'email']), responses: ok('options + regToken') } },
    '/v1/auth/register/finish': { post: { tags: ['Auth'], security: [], summary: 'Finish registration: verify passkey, create the Canton-backed account, return a session', requestBody: body({ regToken: S, response: { type: 'object' } }, ['regToken', 'response']), responses: { '201': { description: 'session + account' } } } },
    '/v1/auth/login/begin': { post: { tags: ['Auth'], security: [], summary: 'Begin passkey login → assertion options + loginToken', requestBody: body({ email: S }, ['email']), responses: ok('options + loginToken') } },
    '/v1/auth/login/finish': { post: { tags: ['Auth'], security: [], summary: 'Finish login: verify the passkey assertion, return a session', requestBody: body({ loginToken: S, response: { type: 'object' } }, ['loginToken', 'response']), responses: ok('session + account') } },
    '/v1/auth/me': { get: { tags: ['Auth'], security: [{ session: [] }], summary: 'Current account', responses: ok('account') } },
    '/v1/auth/stepup/begin': { post: { tags: ['Auth'], security: [{ session: [] }], summary: 'Begin a passkey step-up for a high-value action', responses: ok('options + stepupToken') } },
    '/v1/auth/stepup/finish': { post: { tags: ['Auth'], security: [{ session: [] }], summary: 'Finish step-up → short-lived approval token', requestBody: body({ stepupToken: S, response: { type: 'object' } }, ['stepupToken', 'response']), responses: ok('approval') } },

    // ---- Account treasury (passkey session) ----
    '/v1/account': { get: { tags: ['Accounts'], security: [{ session: [] }], summary: 'Current account', responses: ok('account') } },
    '/v1/account/treasury': { get: { tags: ['Accounts'], security: [{ session: [] }], summary: 'Multi-currency balances + yield + total', responses: ok('treasury') } },
    '/v1/account/treasury/deposit': { post: { tags: ['Accounts'], security: [{ session: [] }], summary: 'Deposit (on-ramp) a currency into the treasury', requestBody: body({ amount: N, currency: S }, ['amount']), responses: ok('treasury') } },
    '/v1/account/treasury/rates': { get: { tags: ['Accounts'], security: [{ session: [] }], summary: 'FX rates (operator-quoted)', responses: ok('rates') } },
    '/v1/account/treasury/rebalance': { post: { tags: ['Accounts'], security: [{ session: [] }], summary: 'FX rebalance: swap one currency into another (real on-ledger)', requestBody: body({ from: S, to: S, amount: N }, ['from', 'to', 'amount']), responses: ok('treasury') } },
    '/v1/account/treasury/sweep': { post: { tags: ['Accounts'], security: [{ session: [] }], summary: 'Sweep USDC into the yield pool', requestBody: body({ amount: N }, ['amount']), responses: ok('treasury') } },
    '/v1/account/treasury/redeem': { post: { tags: ['Accounts'], security: [{ session: [] }], summary: 'Redeem the yield position to cash', responses: ok('treasury') } },
    '/v1/account/transfers': { post: { tags: ['Accounts'], security: [{ session: [] }], summary: 'Transfer a currency to any counterparty (atomic settlement)', requestBody: body({ to: S, amount: N, currency: S }, ['to', 'amount']), responses: ok('updateId') } },
    '/v1/account/events': { get: { tags: ['Accounts'], security: [{ session: [] }], summary: 'Account event log', responses: ok('events') } },

    // ---- Employees + PRIVATE payroll ----
    '/v1/account/employees': {
      get: { tags: ['Payroll'], security: [{ session: [] }], summary: 'List employees', responses: ok('employees') },
      post: { tags: ['Payroll'], security: [{ session: [] }], summary: 'Add an employee (allocates a Canton payee party)', requestBody: body({ name: S, email: S, currency: S, salary: N }, ['name']), responses: { '201': { description: 'employee' } } },
    },
    '/v1/account/payroll/runs': {
      get: { tags: ['Payroll'], security: [{ session: [] }], summary: 'List payroll runs', responses: ok('runs') },
      post: { tags: ['Payroll'], security: [{ session: [] }], summary: 'Run payroll — each salary is a private Token transfer (no employee sees another’s pay)', requestBody: body({ entries: { type: 'array' } }, ['entries']), responses: { '201': { description: 'run' } } },
    },

    // ---- Account credit + lending (REAL underwriting) ----
    '/v1/account/credit': { get: { tags: ['Lending'], security: [{ session: [] }], summary: 'Credit profile', responses: ok('credit') } },
    '/v1/account/credit/underwrite': { post: { tags: ['Lending'], security: [{ session: [] }], summary: 'Underwrite from real on-ledger signals + attest a score/limit', responses: ok('credit') } },
    '/v1/account/loans': {
      get: { tags: ['Lending'], security: [{ session: [] }], summary: 'List loans', responses: ok('loans') },
      post: { tags: ['Lending'], security: [{ session: [] }], summary: 'Draw working capital against the credit line', requestBody: body({ amount: N, termDays: N }, ['amount']), responses: { '201': { description: 'loan' } } },
    },
    '/v1/account/loans/{id}/repay': { post: { tags: ['Lending'], security: [{ session: [] }], summary: 'Repay a loan', parameters: [{ name: 'id', in: 'path', required: true, schema: S }], requestBody: body({ amount: N }, ['amount']), responses: ok('ok') } },
  },
} as const;
