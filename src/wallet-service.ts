// Irion wallet-service — a real Carpincho-compatible Canton wallet backend.
//
// Carpincho (the browser extension) is the APPROVAL UI; this service holds the
// Ed25519 key, onboards a Canton external party, and answers Carpincho's
// wallet-service JSON-RPC methods. Carpincho POSTs {id, method, params} to its
// configured walletServiceRpcUrl (this :3011/rpc).
//
// Methods (reverse-engineered from the Carpincho extension bundle):
//   status · connect · disconnect · isConnected · listAccounts ·
//   getPrimaryAccount · getActiveNetwork · prepareExecute ·
//   prepareExecuteAndWait · signMessage · ledgerApi · version
//
// The actual prepare→sign→execute is the SAME flow proven in
// src/verify-rpc-path.ts / src/verify-shim-signing.ts.
//
// Run: `npm run wallet-service`
import express from 'express';
import { SDK } from '@canton-network/wallet-sdk';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';

const LEDGER = process.env.CANTON_JSON_API ?? 'http://localhost:6864';
const PORT = Number(process.env.WALLET_SERVICE_PORT ?? 3011);
const NETWORK = process.env.IRION_NETWORK ?? 'canton:irion-sandbox';

function staticJwt(sub = 'ledger-api-user'): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, aud: '', iat: now, exp: now + 31536000 })}.sig`;
}
const AUTH = 'Bearer ' + staticJwt();

// ── the session wallet: one Ed25519 key + onboarded external party ──────────
interface Wallet { party: string; publicKey: string; fingerprint: string; kp: any }
let sdk: any = null;
let wallet: Wallet | null = null;
// The party Carpincho is acting as. Carpincho holds its OWN key + party and signs
// itself, so we learn the party from the calls it makes (cip56/amulet/actAs).
let lastParty: string | undefined;
// In-flight external-party onboardings: onboardingId → the SDK prep handle.
const onboardings = new Map<string, any>();
let onbCounter = 0;

async function getSdk(): Promise<any> {
  if (sdk) return sdk;
  sdk = await SDK.create({ auth: { method: 'static', token: staticJwt() } as any, ledgerClientUrl: LEDGER });
  await fetch(LEDGER + '/v2/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: { id: 'ledger-api-user', identityProviderId: '' }, rights: [] }) }).catch(() => {});
  return sdk;
}

async function ensureWallet(): Promise<Wallet> {
  if (wallet) return wallet;
  const s = await getSdk();
  const kp = s.keys.generate();
  await (await s.party.external.create(kp.publicKey).sign(kp.privateKey)).execute();
  const fingerprint = String(await s.keys.fingerprint(kp.publicKey));
  const parties: any = await fetch(LEDGER + '/v2/parties').then((r) => r.json());
  const party: string | undefined = (parties.partyDetails ?? []).map((p: any) => p.party).find((p: string) => p.includes(fingerprint));
  if (!party) throw new Error('external party not found after onboarding');
  wallet = { party, publicKey: kp.publicKey, fingerprint, kp };
  console.log(`  ✓ onboarded wallet party ${party.slice(0, 24)}…`);
  return wallet;
}

const account = (w: Wallet) => ({ primary: true, partyId: w.party, publicKey: w.publicKey, networkId: NETWORK, hint: 'irion' });

async function ledger(method: 'GET' | 'POST', path: string, body?: unknown) {
  const r = await fetch(LEDGER + path, { method, headers: { authorization: AUTH, 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let json: any; try { json = t ? JSON.parse(t) : null; } catch { json = t; }
  return { status: r.status, json };
}

const app = express();

// CORS — Carpincho's service worker / injected provider is a different origin.
app.use((req, res, next) => {
  res.set('access-control-allow-origin', '*');
  res.set('access-control-allow-headers', '*');
  res.set('access-control-allow-methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true, ledger: LEDGER, network: NETWORK, connected: !!wallet }));

// ── External-party onboarding (Carpincho "create account") ──────────────────
// Carpincho generates an Ed25519 key, POSTs its publicKeyBase64 here to get the
// topology hash, signs it with its own key, then completes — onboarding the party
// onto THIS gateway's sandbox. (This is why a party created on another gateway
// won't work here: it must be onboarded on the network you connect to.)
app.post('/admin/party/prepare', express.json({ limit: '4mb' }), async (req, res) => {
  try {
    const { publicKeyBase64, partyHint } = req.body || {};
    if (!publicKeyBase64) return res.status(400).json({ error: 'publicKeyBase64 required' });
    const s = await getSdk();
    const prep: any = s.party.external.create(publicKeyBase64);
    const topo: any = await prep.topology();
    const onboardingId = `onb_${Date.now().toString(36)}_${onbCounter++}`;
    onboardings.set(onboardingId, prep);
    console.log(`[admin] party/prepare hint=${partyHint} → ${onboardingId}`);
    res.json({ onboardingId, multiHash: topo.multiHash });
  } catch (e: any) {
    console.error('[admin] party/prepare failed:', e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});
app.post('/admin/party/complete', express.json({ limit: '4mb' }), async (req, res) => {
  try {
    const { onboardingId, signatureBase64 } = req.body || {};
    const prep = onboardings.get(onboardingId);
    if (!prep) return res.status(404).json({ error: 'unknown onboardingId' });
    const created: any = await prep.execute(signatureBase64);
    onboardings.delete(onboardingId);
    console.log(`[admin] party/complete → ${String(created.partyId).slice(0, 28)}…`);
    res.json({ partyId: created.partyId });
  } catch (e: any) {
    console.error('[admin] party/complete failed:', e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Raw Canton JSON Ledger API passthrough (the SDK + `ledgerApi` use this).
app.use('/v2', express.raw({ type: () => true, limit: '16mb' }), async (req, res) => {
  try {
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && Buffer.isBuffer(req.body) && req.body.length > 0;
    const r = await fetch(LEDGER + req.originalUrl, { method: req.method, headers: { authorization: AUTH, 'content-type': 'application/json' }, body: hasBody ? req.body : undefined });
    const text = await r.text();
    res.status(r.status).type(r.headers.get('content-type') ?? 'application/json').send(text);
  } catch (e: any) { res.status(502).json({ error: String(e?.message || e) }); }
});

const trim = (v: unknown, n = 240) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s && s.length > n ? s.slice(0, n) + '…' : s; };

app.post('/rpc', express.json({ limit: '12mb' }), async (req, res) => {
  const { id, method, params } = req.body || {};
  console.log(`\n[rpc] ◀ ${method}  ${trim(params, 160)}`);
  const reply = (result: unknown) => { console.log(`  ▶ ${trim(result)}`); res.json({ id, jsonrpc: '2.0', result }); };
  const fail = (message: string, data?: unknown) => { console.log(`  ✖ ${message} ${trim(data)}`); res.json({ id, jsonrpc: '2.0', error: { code: -32000, message, data } }); };

  // Learn the party Carpincho acts as (it signs with its own key).
  const pp = params as any;
  if (pp?.partyId) lastParty = pp.partyId;
  else if (pp?.receiver) lastParty = pp.receiver;
  else if (Array.isArray(pp?.actAs) && pp.actAs[0]) lastParty = pp.actAs[0];

  try {
    switch (method) {
      case 'status': {
        // Carpincho's settings "Test connection" reads connection.isNetworkConnected.
        // Verify the Canton ledger is actually reachable so we report it truthfully.
        let isNetworkConnected = true;
        let networkReason: string | undefined;
        try {
          const r = await fetch(LEDGER + '/v2/version');
          isNetworkConnected = r.ok;
          if (!r.ok) networkReason = `ledger HTTP ${r.status}`;
        } catch (e: any) {
          isNetworkConnected = false;
          networkReason = `ledger unreachable: ${String(e?.message || e)}`;
        }
        return reply({
          isConnected: !!wallet,
          network: { networkId: NETWORK },
          connection: { isNetworkConnected, networkId: NETWORK, network: { networkId: NETWORK }, networkReason },
          accounts: wallet ? [account(wallet)] : [],
        });
      }
      case 'isConnected':
        return reply({ isConnected: !!wallet });
      case 'connect': {
        const w = await ensureWallet();
        return reply({ isConnected: true, network: { networkId: NETWORK }, accounts: [account(w)], primary: account(w) });
      }
      case 'disconnect':
        wallet = null;
        return reply({ isConnected: false });
      case 'listAccounts': {
        const w = await ensureWallet();
        return reply({ accounts: [account(w)], primary: account(w) });
      }
      case 'getPrimaryAccount': {
        const w = await ensureWallet();
        return reply(account(w));
      }
      case 'getActiveNetwork':
        return reply({ networkId: NETWORK, network: { networkId: NETWORK } });

      // Prepare an interactive-submission tx. Carpincho holds the key and signs the
      // returned preparedTransactionHash ITSELF, then submits via executePrepared.
      // The shim just builds the prepare body (from {commands} + the acting party)
      // and forwards to the ledger — it does NOT sign.
      case 'prepareTransaction':
      case 'prepareExecute':
      case 'prepareExecuteAndWait': {
        const commands = (params?.commands ?? []) as unknown[];
        const actAs: string[] = params?.actAs ?? (params?.partyId ? [params.partyId] : lastParty ? [lastParty] : []);
        if (!actAs.length) return fail('no acting party for prepareTransaction (connect first)');
        let synchronizerId = params?.synchronizerId;
        if (!synchronizerId) {
          const cs = await ledger('GET', '/v2/state/connected-synchronizers');
          synchronizerId = cs.json?.connectedSynchronizers?.[0]?.synchronizerId ?? cs.json?.[0]?.synchronizerId;
        }
        const body = {
          userId: 'ledger-api-user', actAs, readAs: params?.readAs ?? [], commands,
          commandId: params?.commandId ?? `irion-${Date.now()}`,
          synchronizerId, disclosedContracts: params?.disclosedContracts ?? [],
          packageIdSelectionPreference: params?.packageIdSelectionPreference ?? [], verboseHashing: false,
        };
        console.log(`  [prepare] actAs=${actAs[0]?.slice(0, 18)}… sync=${String(synchronizerId).slice(0, 24)}…`);
        const { status, json } = await ledger('POST', '/v2/interactive-submission/prepare', body);
        return status < 300 ? reply(json) : fail('prepare failed', json);
      }
      case 'executePrepared':
      case 'executeTransaction': {
        // Carpincho sends { ...prepareResult, partyId, signatureBase64 } — just its
        // signature. The gateway assembles the full executeAndWait body.
        const party: string | undefined = params?.partyId ?? lastParty;
        const sig: string | undefined = params?.signatureBase64 ?? params?.signature;
        if (!party || !sig) return fail('executePrepared needs partyId + signatureBase64', { keys: Object.keys(params ?? {}) });
        const signedBy = party.includes('::') ? party.split('::')[1] : party; // key fingerprint
        const body = {
          userId: 'ledger-api-user',
          preparedTransaction: params.preparedTransaction,
          hashingSchemeVersion: params.hashingSchemeVersion ?? 'HASHING_SCHEME_VERSION_V2',
          submissionId: `irion-${Date.now()}-${onbCounter++}`,
          deduplicationPeriod: { Empty: {} },
          partySignatures: {
            signatures: [{
              party,
              signatures: [{ signature: sig, signedBy, format: 'SIGNATURE_FORMAT_CONCAT', signingAlgorithmSpec: 'SIGNING_ALGORITHM_SPEC_ED25519' }],
            }],
          },
        };
        const { status, json } = await ledger('POST', '/v2/interactive-submission/executeAndWait', body);
        return status < 300 ? reply(json) : fail('execute failed', json);
      }

      case 'signMessage': {
        const w = await ensureWallet();
        const raw = params?.message ?? params?.[0] ?? params;
        const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : naclUtil.decodeBase64(String(raw));
        const sig = naclUtil.encodeBase64(nacl.sign.detached(bytes, naclUtil.decodeBase64(w.kp.privateKey)));
        return reply({ signature: sig, signedBy: w.fingerprint, signingAlgorithmSpec: 'SIGNING_ALGORITHM_SPEC_ED25519' });
      }

      // raw ledger passthrough requested through the wallet
      case 'ledgerApi': {
        const p: any = params ?? {};
        const httpMethod = (p.method ?? (p.body ? 'POST' : 'GET')).toUpperCase();
        const path = p.path ?? p.url ?? '/v2/version';
        const { status, json } = await ledger(httpMethod, path, p.body);
        return status < 300 ? reply(json) : fail('ledgerApi failed', json);
      }

      case 'version': {
        const { json } = await ledger('GET', '/v2/version');
        return reply(json);
      }

      default:
        // CIP-0056 Token Standard (Carpincho's holdings/balance + transfer UI).
        // Irion's demo `Irion.Token:Token` is NOT a CIP-56 Holding interface, so
        // there are no standard holdings to report — return empty so Carpincho's
        // balance view renders cleanly. (The /pay flow settles via prepareExecute,
        // not via CIP-56 transfers.)
        if (typeof method === 'string' && method.startsWith('cip56.')) {
          if (method.startsWith('cip56.list')) return reply([]);
          // transfer / createTransfer / acceptTransfer — unused in the Irion flow
          return reply({ ok: true });
        }
        // Amulet (Canton Coin) probes — Irion doesn't use Canton Coin.
        if (typeof method === 'string' && method.startsWith('amulet.')) {
          return reply(method.includes('status') ? { isPreapproved: false, preapproved: false } : []);
        }
        return fail(`unhandled method: ${method}`, { params });
    }
  } catch (e: any) {
    return fail(String(e?.message || e));
  }
});

app.listen(PORT, () => {
  console.log(`Irion wallet-service (Carpincho backend) on http://localhost:${PORT}/rpc`);
  console.log(`  ledger : ${LEDGER}`);
  console.log(`  network: ${NETWORK}`);
});
