// Real self-custody wallets on Canton via @canton-network/wallet-sdk.
//
// Each wallet is a genuine EXTERNAL party: the user holds an Ed25519 key, and
// transactions are signed by that key via prepare → sign → execute. The
// operator/validator never holds the signing key. This is the embedded-wallet
// model (the provider holds the key on the user's behalf after auth); the same
// flow runs in the browser for true self-custody (the SDK is isomorphic).
import { SDK } from '@canton-network/wallet-sdk';
import { randomBytes } from 'node:crypto';
import * as keystore from './keystore.js';

// The unauthenticated sandbox ignores the token, but the SDK parses it as a JWT
// and checks expiry — so we mint a valid, far-future one.
function staticJwt(sub = 'ledger-api-user') {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, aud: '', iat: now, exp: now + 31536000 })}.c2ln`;
}

export interface Wallet {
  id: string;
  name: string;
  party: string;
  fingerprint: string;
}

export class WalletService {
  private sdk: any = null;
  private initPromise: Promise<any> | null = null;
  private wallets = new Map<string, { id: string; name: string; party: string; fingerprint: string; kp: any }>();

  constructor(private ledgerUrl: string, private packageName = 'irion-model') {}

  private async init(): Promise<any> {
    if (this.sdk) return this.sdk;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const sdk = await SDK.create({ auth: { method: 'static', token: staticJwt() } as any, ledgerClientUrl: this.ledgerUrl });
        // the ledger user the SDK grants party-rights to must exist
        await fetch(this.ledgerUrl + '/v2/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: { id: 'ledger-api-user', identityProviderId: '' }, rights: [] }) }).catch(() => {});
        this.sdk = sdk;
        return sdk;
      })();
    }
    return this.initPromise;
  }

  /** Onboard a fresh external party and RETURN the key material so the caller can
   * encrypt + persist it (keystore.ts). The keypair is {publicKey, privateKey}
   * base64 strings (core-signing-lib) — trivially serializable. */
  async onboardParty(): Promise<{ party: string; fingerprint: string; publicKey: string; privateKey: string }> {
    const sdk = await this.init();
    const kp = sdk.keys.generate();
    const signed = await sdk.party.external.create(kp.publicKey).sign(kp.privateKey); // the user's key signs its own topology
    await signed.execute();
    const fingerprint = String(await sdk.keys.fingerprint(kp.publicKey));
    const parties: any = await fetch(this.ledgerUrl + '/v2/parties').then((r) => r.json());
    const party = (parties.partyDetails ?? []).map((p: any) => p.party).find((p: string) => p.includes(fingerprint));
    if (!party) throw new Error('external party not found after onboarding');
    return { party, fingerprint, publicKey: kp.publicKey, privateKey: kp.privateKey };
  }

  /** Create a real self-custody wallet (kept in-memory; legacy demo path). */
  async create(name: string): Promise<Wallet> {
    const { party, fingerprint, publicKey, privateKey } = await this.onboardParty();
    const id = 'wal_' + randomBytes(8).toString('hex');
    this.wallets.set(id, { id, name, party, fingerprint, kp: { publicKey, privateKey } });
    keystore.putKey(id, { party, publicKey, privateKey, fingerprint }); // persist ENCRYPTED — survives restart
    return { id, name, party, fingerprint };
  }

  get(id: string): Wallet | undefined {
    const w = this.wallets.get(id);
    if (w) return { id: w.id, name: w.name, party: w.party, fingerprint: w.fingerprint };
    const k = keystore.getKey(id); // reload from the encrypted store after a restart
    return k && { id, name: '', party: k.party, fingerprint: k.fingerprint };
  }

  /** The wallet's OWN key signs a Token_Transfer (prepare → sign → execute). */
  async signTokenTransfer(walletId: string, tokenCid: string, newOwner: string): Promise<string> {
    const m = this.wallets.get(walletId);
    const reloaded = m ? undefined : keystore.getKey(walletId); // survive restart
    const party = m?.party ?? reloaded?.party;
    const privateKey = m?.kp.privateKey ?? reloaded?.privateKey;
    if (!party || !privateKey) throw new Error('wallet not found');
    const sdk = await this.init();
    const prepared: any = await sdk.ledger.prepare({
      partyId: party,
      commands: [{ ExerciseCommand: { templateId: `#${this.packageName}:Irion.Token:Token`, contractId: tokenCid, choice: 'Token_Transfer', choiceArgument: { newOwner } } }],
    });
    const signedTx: any = await prepared.sign(privateKey); // self-custody signature
    const exec: any = await sdk.ledger.execute(signedTx, { partyId: party });
    return String(exec?.updateId ?? exec?.completionOffset ?? 'executed');
  }

  /** Sign + execute arbitrary commands with a reloaded (account-custodied) key.
   * The platform decrypts the key from keystore.ts and signs on the business's
   * behalf — this is what lets automated treasury/payroll run unattended. */
  async signCommand(party: string, privateKey: string, commands: unknown[]): Promise<string> {
    const sdk = await this.init();
    const prepared: any = await sdk.ledger.prepare({ partyId: party, commands });
    const signedTx: any = await prepared.sign(privateKey);
    const exec: any = await sdk.ledger.execute(signedTx, { partyId: party });
    return String(exec?.updateId ?? exec?.completionOffset ?? 'executed');
  }
}
