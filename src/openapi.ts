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
    securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'Your irion_sk_… key from POST /v1/businesses' } },
  },
  tags: [
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
  },
} as const;
