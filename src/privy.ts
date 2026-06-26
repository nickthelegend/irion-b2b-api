// Privy-backed Canton wallets: Privy (Solana / Ed25519) holds the user's key,
// and signs both the external-party onboarding topology AND each transaction
// hash. Canton accepts the signatures (Ed25519 is the same curve). The key never
// leaves Privy — true embedded-wallet custody, on Canton.
import { SDK } from '@canton-network/wallet-sdk';
import { randomBytes } from 'node:crypto';

function staticJwt() {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const n = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'ledger-api-user', aud: '', iat: n, exp: n + 31536000 })}.c2ln`;
}
function b58decode(str: string): Uint8Array {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; const bytes: number[] = [];
  for (const ch of str) { let c = A.indexOf(ch); if (c < 0) throw new Error('bad base58'); for (let j = 0; j < bytes.length; j++) { c += bytes[j] * 58; bytes[j] = c & 0xff; c >>= 8; } while (c > 0) { bytes.push(c & 0xff); c >>= 8; } }
  for (const ch of str) { if (ch !== '1') break; bytes.push(0); } return Uint8Array.from(bytes.reverse());
}

export interface PrivyWallet { id: string; name: string; party: string; fingerprint: string; privyWalletId: string; privyAddress: string; provider: 'privy' }

export class PrivyWalletService {
  private sdk: any = null;
  private initPromise: Promise<any> | null = null;
  private wallets = new Map<string, { id: string; name: string; party: string; fingerprint: string; privyWalletId: string; privyAddress: string }>();
  private readonly headers: Record<string, string>;

  constructor(private ledgerUrl: string, appId: string, appSecret: string, private packageName = 'irion-model') {
    this.headers = { Authorization: 'Basic ' + Buffer.from(`${appId}:${appSecret}`).toString('base64'), 'privy-app-id': appId, 'content-type': 'application/json' };
  }

  private privy(path: string, body?: unknown): Promise<any> {
    return fetch('https://api.privy.io' + path, { method: 'POST', headers: this.headers, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
  }
  /** Privy signs `hashB64` (base64 of the raw hash bytes) with the wallet's Ed25519 key. */
  private async privySign(privyWalletId: string, hashB64: string): Promise<string> {
    const r = await this.privy(`/v1/wallets/${privyWalletId}/rpc`, { method: 'signMessage', params: { message: hashB64, encoding: 'base64' } });
    if (!r?.data?.signature) throw new Error('privy sign failed: ' + JSON.stringify(r).slice(0, 160));
    return r.data.signature as string;
  }
  private async init(): Promise<any> {
    if (this.sdk) return this.sdk;
    if (!this.initPromise) this.initPromise = (async () => {
      const sdk = await SDK.create({ auth: { method: 'static', token: staticJwt() } as any, ledgerClientUrl: this.ledgerUrl });
      await fetch(this.ledgerUrl + '/v2/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: { id: 'ledger-api-user', identityProviderId: '' }, rights: [] }) }).catch(() => {});
      this.sdk = sdk; return sdk;
    })();
    return this.initPromise;
  }

  /** Create a Privy wallet and onboard a Canton external party for it (Privy signs the topology). */
  async create(name: string): Promise<PrivyWallet> {
    const sdk = await this.init();
    const w = await this.privy('/v1/wallets', { chain_type: 'solana' });
    if (!w?.address) throw new Error('privy wallet creation failed: ' + JSON.stringify(w).slice(0, 200));
    const pubB64 = Buffer.from(b58decode(w.address)).toString('base64');
    const prep: any = sdk.party.external.create(pubB64);
    const topo: any = await prep.topology();
    const topoSig = await this.privySign(w.id, topo.multiHash);
    const created: any = await prep.execute(topoSig);
    const id = 'pw_' + randomBytes(8).toString('hex');
    this.wallets.set(id, { id, name, party: created.partyId, fingerprint: String(created.publicKeyFingerprint), privyWalletId: w.id, privyAddress: w.address });
    return { id, name, party: created.partyId, fingerprint: String(created.publicKeyFingerprint), privyWalletId: w.id, privyAddress: w.address, provider: 'privy' };
  }

  get(id: string): PrivyWallet | undefined {
    const w = this.wallets.get(id);
    return w && { ...w, provider: 'privy' };
  }

  /** Privy signs a Token_Transfer (prepare → Privy signs hash → execute). */
  async signTokenTransfer(walletId: string, tokenCid: string, newOwner: string): Promise<string> {
    const w = this.wallets.get(walletId);
    if (!w) throw new Error('privy wallet not found');
    const sdk = await this.init();
    const prepared: any = await sdk.ledger.prepare({ partyId: w.party, commands: [{ ExerciseCommand: { templateId: `#${this.packageName}:Irion.Token:Token`, contractId: tokenCid, choice: 'Token_Transfer', choiceArgument: { newOwner } } }] });
    const { response }: any = await prepared.toJSON();
    const sig = await this.privySign(w.privyWalletId, response.preparedTransactionHash);
    const signed: any = sdk.ledger.fromSignature(response, sig);
    const exec: any = await sdk.ledger.execute(signed, { partyId: w.party });
    return String(exec?.updateId ?? exec?.completionOffset ?? 'executed');
  }
}
