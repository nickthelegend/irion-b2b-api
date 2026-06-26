// Canton ledger layer for the Irion B2B API.
//
// Maps the four B2B primitives onto the Irion Daml protocol on Canton:
//   Treasury   -> Token holdings + LendingPool/PoolShare (idle cash earns yield)
//   Credit     -> CreditProfile + CreditAttestation (issuer-signed, privacy-native)
//   Lending    -> Loan (unsecured working capital, gated on the credit line)
//   Settlement -> Token transfers between parties (instant, atomic, global)
//
// Every call is a real Canton JSON Ledger API (v2) submission — the ledger is
// the source of truth. The API server holds the operator party and mediates.

export interface CantonConfig {
  ledgerUrl: string;
  packageName: string;
  userId: string;
  operator: string;
  usdcIssuer: string;
  creditIssuer: string;
}

export type Party = string;
export type ContractId = string;

const dec = (n: number | string): string => {
  const s = String(n);
  return s.includes('.') ? s : s + '.0';
};

interface CreatedEvent { contractId: ContractId; templateId: string; createArgument: any }

export class Ledger {
  private nonce = 0;
  /** currency symbol -> issuer party. USDC is the bootstrap issuer; other
   * currencies are distinct on-ledger assets, each with its own issuer party. */
  public currencies: Record<string, Party>;
  constructor(public cfg: CantonConfig) {
    this.currencies = { USDC: cfg.usdcIssuer };
  }
  /** resolve a currency to its issuer party (throws if not configured). */
  currencyIssuer(cur: string): Party {
    const i = this.currencies[cur.toUpperCase()];
    if (!i) throw new LedgerError(`unknown currency '${cur}' — configure its issuer first`, '');
    return i;
  }
  /** register the issuer party for a currency (multi-currency treasury). */
  setCurrency(cur: string, issuer: Party) { this.currencies[cur.toUpperCase()] = issuer; }

  private tid(m: string, e: string) { return `#${this.cfg.packageName}:${m}:${e}`; }
  private cid(p: string) { return `${p}-${Date.now()}-${this.nonce++}`; }

  private async post(path: string, body: unknown): Promise<any> {
    const r = await fetch(this.cfg.ledgerUrl + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const t = await r.text();
    if (!r.ok) throw new LedgerError(`${path} -> ${r.status}`, t);
    return t ? JSON.parse(t) : {};
  }
  private async get(path: string): Promise<any> {
    const r = await fetch(this.cfg.ledgerUrl + path);
    const t = await r.text();
    if (!r.ok) throw new LedgerError(`${path} -> ${r.status}`, t);
    return t ? JSON.parse(t) : {};
  }

  async allocateParty(hint: string): Promise<Party> {
    const safe = hint.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40) || 'party';
    const r = await this.post('/v2/parties', { partyIdHint: `${safe}${Date.now().toString(36)}` });
    return r.partyDetails.party;
  }

  private async submit(actAs: Party[], commands: unknown[], readAs: Party[] = []): Promise<any> {
    return this.post('/v2/commands/submit-and-wait-for-transaction-tree', { commandId: this.cid('cmd'), userId: this.cfg.userId, actAs, readAs, commands });
  }
  private create(t: string, args: unknown) { return { CreateCommand: { templateId: t, createArguments: args } }; }
  private exercise(t: string, c: ContractId, ch: string, arg: unknown = {}) { return { ExerciseCommand: { templateId: t, contractId: c, choice: ch, choiceArgument: arg } }; }

  private createdEvents(tx: any): CreatedEvent[] {
    return Object.values(tx.transactionTree?.eventsById ?? {}).map((e: any) => e.CreatedTreeEvent?.value).filter(Boolean) as CreatedEvent[];
  }
  private archived(tx: any): Set<string> {
    return new Set(Object.values(tx.transactionTree?.eventsById ?? {}).map((e: any) => e.ExercisedTreeEvent?.value).filter((v: any) => v?.consuming).map((v: any) => v.contractId));
  }
  private madeLive(tx: any, entity: string, pred: (a: any) => boolean = () => true): CreatedEvent {
    const gone = this.archived(tx);
    const c = this.createdEvents(tx).find((e) => e.templateId.endsWith(':' + entity) && !gone.has(e.contractId) && pred(e.createArgument));
    if (!c) throw new Error(`expected a live ${entity} in tx`);
    return c;
  }
  async queryActive(party: Party, entity: string, pred: (a: any) => boolean = () => true): Promise<CreatedEvent[]> {
    const { offset } = await this.get('/v2/state/ledger-end');
    const res = await this.post('/v2/state/active-contracts', {
      filter: { filtersByParty: { [party]: { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] } } },
      verbose: false, activeAtOffset: offset,
    });
    return (res as any[]).map((e) => e.contractEntry?.JsActiveContract?.createdEvent)
      .filter((e: any) => e?.templateId.endsWith(':' + entity) && pred(e.createArgument))
      .map((e: any) => ({ contractId: e.contractId, templateId: e.templateId, createArgument: e.createArgument }));
  }

  // ---------------------------------------------------------------- tokens

  /** USDC token helpers. The issuer funds a business (on-ramp); operations split
   * holdings as needed and leave change as new holdings owned by the party. */
  private async tokensOf(party: Party, issuer?: Party): Promise<{ contractId: ContractId; amount: number }[]> {
    const toks = await this.queryActive(party, 'Token', (a) => a.owner === party && (!issuer || a.issuer === issuer));
    return toks.map((t) => ({ contractId: t.contractId, amount: Number(t.createArgument.amount) }));
  }
  /** a holding owned by `party` of EXACTLY `amount` in one currency (splits / merges as needed). */
  private async exactHolding(party: Party, amount: number, issuer?: Party): Promise<ContractId> {
    const iss = issuer ?? this.cfg.usdcIssuer;
    let toks = await this.tokensOf(party, iss);
    let one = toks.find((t) => t.amount >= amount);
    if (!one) {
      // merge everything into the first holding
      if (toks.length < 2) throw new Error('insufficient USDC balance');
      const base = toks[0];
      for (const t of toks.slice(1)) {
        const tx = await this.submit([party], [this.exercise(this.tid('Irion.Token', 'Token'), base.contractId, 'Token_Merge', { otherCid: t.contractId })]);
        base.contractId = this.madeLive(tx, 'Token', (a) => a.owner === party).contractId;
        base.amount += t.amount;
      }
      one = base;
      if (one.amount < amount) throw new Error('insufficient USDC balance');
    }
    if (Math.abs(one.amount - amount) < 1e-9) return one.contractId;
    const tx = await this.submit([party], [this.exercise(this.tid('Irion.Token', 'Token'), one.contractId, 'Token_Split', { splitAmount: dec(amount) })]);
    // the split-off `amount` holding (not the remainder, which is larger)
    const splits = this.createdEvents(tx).filter((e) => e.templateId.endsWith(':Token') && e.createArgument.owner === party);
    const exact = splits.find((e) => Math.abs(Number(e.createArgument.amount) - amount) < 1e-9);
    if (!exact) throw new Error('split failed');
    return exact.contractId;
  }
  private async anyHolding(party: Party, min: number): Promise<ContractId> {
    return this.exactHolding(party, min); // exact is fine; Loan_Pay tolerates >= too
  }

  /** issuer mints `currency` to a party (treasury funding / on-ramp). On the
   * sandbox the issuer-mint IS the canonical on-ramp; a real fiat/Circle rail
   * would replace this with a custody deposit (the on-ledger effect is identical). */
  async fund(party: Party, amount: number, currency = 'USDC'): Promise<void> {
    const issuer = this.currencyIssuer(currency);
    await this.submit([issuer], [this.create(this.tid('Irion.Token', 'Token'), { issuer, owner: party, amount: dec(amount) })]);
  }
  /** USDC balance (kept for back-compat; sums only USDC-issued holdings). */
  async usdcBalance(party: Party): Promise<number> {
    return (await this.tokensOf(party, this.cfg.usdcIssuer)).reduce((s, t) => s + t.amount, 0);
  }
  /** balance of any configured currency. */
  async balanceOf(party: Party, currency: string): Promise<number> {
    return (await this.tokensOf(party, this.currencyIssuer(currency))).reduce((s, t) => s + t.amount, 0);
  }

  /** DIRECT checkout on-ramp: mint exactly `amount` USDC to the shopper and return
   * that token's cid, so the shopper can sign ONE Token_Transfer of it to the
   * merchant — a REAL self-custody debit (no operator mint-to-merchant). The mint
   * is the demo on-ramp; the transfer the shopper signs is the real settlement. */
  async directPrepare(party: Party, amount: number): Promise<ContractId> {
    await this.fund(party, amount, 'USDC');
    const [tok] = await this.queryActive(party, 'Token', (a) => a.owner === party && a.issuer === this.cfg.usdcIssuer && Math.abs(Number(a.amount) - amount) < 1e-9);
    if (!tok) throw new LedgerError('direct prepare: funded token not found', '');
    return tok.contractId;
  }

  // ------------------------------------------------------------- protocol bootstrap

  async initConfig(): Promise<ContractId> {
    const config = { usdcIssuer: this.cfg.usdcIssuer, creditIssuer: this.cfg.creditIssuer, borrowInterestRate: '0.05', uncollatPremiumRate: '0.05', starterLimit: '50.0', maxCreditLimit: '100000000.0', repayRewardRate: '0.10', minScoreUncollat: '600', minimumLiquidity: '1.0' };
    const tx = await this.submit([this.cfg.operator], [this.create(this.tid('Irion.Config', 'ProtocolConfig'), { operator: this.cfg.operator, config })]);
    return this.madeLive(tx, 'ProtocolConfig').contractId;
  }
  async initPool(): Promise<ContractId> {
    const tx = await this.submit([this.cfg.operator], [this.create(this.tid('Irion.Pool', 'LendingPool'), { operator: this.cfg.operator, usdcIssuer: this.cfg.usdcIssuer, totalShares: '0.0', available: '0.0', totalBorrowed: '0.0', minimumLiquidity: '1.0' })]);
    return this.madeLive(tx, 'LendingPool').contractId;
  }
  /** seed the pool with house liquidity so BNPL / split / working-capital work out of the box. */
  async seedPool(amount: number): Promise<void> {
    const lp = await this.allocateParty('houseliquidity');
    await this.fund(lp, amount);
    await this.sweepToYield(lp, amount);
  }
  /** create a throwaway payer party funded with `amount` USDC (testnet checkout sim). */
  async fundedPayer(name: string, amount: number): Promise<Party> {
    const p = await this.allocateParty(name || 'payer');
    await this.fund(p, amount);
    return p;
  }
  /** direct settlement payer -> merchant. */
  async payDirect(payer: Party, merchant: Party, amount: number): Promise<string> {
    return this.settle(payer, merchant, amount);
  }
  private async configCid(): Promise<ContractId> {
    const [c] = await this.queryActive(this.cfg.operator, 'ProtocolConfig');
    if (!c) throw new Error('protocol not bootstrapped');
    return c.contractId;
  }
  async getPool() {
    const [p] = await this.queryActive(this.cfg.operator, 'LendingPool');
    if (!p) throw new Error('pool not initialised');
    const a = p.createArgument;
    const totalAssets = Number(a.available) + Number(a.totalBorrowed);
    return { contractId: p.contractId, available: Number(a.available), totalBorrowed: Number(a.totalBorrowed), totalShares: Number(a.totalShares), totalAssets, utilization: totalAssets ? Number(a.totalBorrowed) / totalAssets : 0 };
  }

  // ------------------------------------------------------------------ TREASURY

  /** business's idle USDC + yield position (pool shares valued at current NAV). */
  async treasury(business: Party) {
    const cash = await this.usdcBalance(business);
    const shares = (await this.queryActive(this.cfg.operator, 'PoolShare', (a) => a.supplier === business)).reduce((s, e) => s + Number(e.createArgument.shares), 0);
    const pool = await this.getPool();
    const yieldValue = pool.totalShares ? (shares * pool.totalAssets) / pool.totalShares : 0;
    return { cash, yieldShares: shares, yieldValue, total: cash + yieldValue };
  }
  /** sweep idle cash into the yield pool (earn yield on treasury). */
  async sweepToYield(business: Party, amount: number): Promise<void> {
    const pool = await this.getPool();
    const tokenCid = await this.exactHolding(business, amount);
    const escrowCid = (await this.submit([business], [this.exercise(this.tid('Irion.Token', 'Token'), tokenCid, 'Token_Transfer', { newOwner: this.cfg.operator })]));
    const escrow = this.madeLive(escrowCid, 'Token', (a) => a.owner === this.cfg.operator).contractId;
    const reqTx = await this.submit([business], [this.create(this.tid('Irion.Pool', 'SupplyRequest'), { operator: this.cfg.operator, supplier: business, usdcIssuer: this.cfg.usdcIssuer, amount: dec(amount), escrowCid: escrow })]);
    const reqCid = this.madeLive(reqTx, 'SupplyRequest').contractId;
    await this.submit([this.cfg.operator], [this.exercise(this.tid('Irion.Pool', 'SupplyRequest'), reqCid, 'SupplyRequest_Accept', { poolCid: pool.contractId })]);
  }
  /** redeem a yield position back to cash (operator pays from custody). */
  async redeemFromYield(business: Party): Promise<void> {
    const shares = await this.queryActive(this.cfg.operator, 'PoolShare', (a) => a.supplier === business);
    for (const s of shares) {
      const pool = await this.getPool();
      const amount = pool.totalShares ? (Number(s.createArgument.shares) * pool.totalAssets) / pool.totalShares : 0;
      const payTokenCid = await this.operatorHolding(amount);
      const reqTx = await this.submit([business], [this.create(this.tid('Irion.Pool', 'WithdrawRequest'), { operator: this.cfg.operator, supplier: business, shareCid: s.contractId })]);
      const reqCid = this.madeLive(reqTx, 'WithdrawRequest').contractId;
      await this.submit([this.cfg.operator], [this.exercise(this.tid('Irion.Pool', 'WithdrawRequest'), reqCid, 'WithdrawRequest_Accept', { poolCid: pool.contractId, payTokenCid })]);
    }
  }
  private async operatorHolding(min: number): Promise<ContractId> {
    const toks = (await this.tokensOf(this.cfg.operator)).filter((t) => t.amount >= min);
    if (!toks.length) throw new Error('operator pool has insufficient liquidity');
    return toks[0].contractId;
  }

  // -------------------------------------------------------------------- CREDIT

  async openProfile(business: Party): Promise<void> {
    const existing = await this.queryActive(this.cfg.operator, 'CreditProfile', (a) => a.borrower === business);
    if (existing.length) return;
    await this.submit([this.cfg.operator], [this.create(this.tid('Irion.Credit', 'CreditProfile'), { operator: this.cfg.operator, borrower: business, creditLimit: '0.0', outstanding: '0.0', repaidTotal: '0.0', repayments: '0', score: '0' })]);
  }
  async getProfile(business: Party) {
    const [p] = await this.queryActive(this.cfg.operator, 'CreditProfile', (a) => a.borrower === business);
    if (!p) return null;
    const a = p.createArgument;
    return { creditLimit: Number(a.creditLimit), outstanding: Number(a.outstanding), available: Number(a.creditLimit) - Number(a.outstanding), score: Number(a.score), repayments: Number(a.repayments) };
  }
  /** the trusted issuer attests creditworthiness — the privacy-native ZK
   * replacement: only the business and Irion ever see the financials. */
  async attest(business: Party, approvedLimit: number, score: number): Promise<void> {
    const [profile] = await this.queryActive(this.cfg.operator, 'CreditProfile', (a) => a.borrower === business);
    if (!profile) throw new Error('no credit profile');
    const attTx = await this.submit([this.cfg.creditIssuer], [this.create(this.tid('Irion.Credit', 'CreditAttestation'), { creditIssuer: this.cfg.creditIssuer, operator: this.cfg.operator, borrower: business, approvedLimit: dec(approvedLimit), score: String(score) })]);
    const attCid = this.madeLive(attTx, 'CreditAttestation').contractId;
    await this.submit([this.cfg.operator], [this.exercise(this.tid('Irion.Credit', 'CreditAttestation'), attCid, 'Attestation_Apply', { configCid: await this.configCid(), profileCid: profile.contractId })]);
  }

  // ------------------------------------------------------------------- LENDING

  /** draw unsecured working capital against the credit line. */
  async drawWorkingCapital(business: Party, amount: number, termDays = 30): Promise<ContractId> {
    const pool = await this.getPool();
    const [profile] = await this.queryActive(this.cfg.operator, 'CreditProfile', (a) => a.borrower === business);
    if (!profile) throw new Error('no credit profile');
    const reqTx = await this.submit([business], [this.create(this.tid('Irion.Bnpl', 'UnsecuredRequest'), { operator: this.cfg.operator, borrower: business, amount: dec(amount), termSeconds: String(termDays * 86400) })]);
    const reqCid = this.madeLive(reqTx, 'UnsecuredRequest').contractId;
    const disburseTokenCid = await this.operatorHolding(amount);
    const tx = await this.submit([this.cfg.operator], [this.exercise(this.tid('Irion.Bnpl', 'UnsecuredRequest'), reqCid, 'UnsecuredRequest_Accept', { poolCid: pool.contractId, profileCid: profile.contractId, configCid: await this.configCid(), disburseTokenCid })]);
    return this.madeLive(tx, 'Loan').contractId;
  }
  /** make a wallet borrower loan-eligible: operator opens a CreditProfile and the
   * issuer attests a score/limit. Idempotent — safe to call before each draw. */
  async ensureCredit(borrower: Party, approvedLimit = 1000, score = 780): Promise<void> {
    await this.openProfile(borrower);
    const prof = await this.getProfile(borrower);
    if (!prof || prof.score < score || prof.creditLimit < approvedLimit) {
      await this.attest(borrower, approvedLimit, score);
    }
  }

  /** accept a borrower's ALREADY-SIGNED UnsecuredRequest (created in their own
   * wallet) → disburse a Loan. The operator is an observer on the request, so it
   * can find + accept it. Used by the wallet dApp to complete a user-signed loan. */
  async acceptUnsecuredFor(borrower: Party): Promise<{ loanId: ContractId; amount: number }> {
    const pool = await this.getPool();
    const [profile] = await this.queryActive(this.cfg.operator, 'CreditProfile', (a) => a.borrower === borrower);
    if (!profile) throw new Error('no credit profile for borrower (call ensureCredit first)');
    const reqs = await this.queryActive(this.cfg.operator, 'UnsecuredRequest', (a) => a.borrower === borrower);
    if (!reqs.length) throw new Error('no pending UnsecuredRequest for this borrower — sign one in the wallet first');
    const req = reqs[0];
    const amount = Number(req.createArgument.amount);
    const disburseTokenCid = await this.operatorHolding(amount);
    const tx = await this.submit([this.cfg.operator], [this.exercise(this.tid('Irion.Bnpl', 'UnsecuredRequest'), req.contractId, 'UnsecuredRequest_Accept', { poolCid: pool.contractId, profileCid: profile.contractId, configCid: await this.configCid(), disburseTokenCid })]);
    return { loanId: this.madeLive(tx, 'Loan').contractId, amount };
  }

  /** The cids a wallet needs to self-sign `Loan_Pay` (repay): the loan, a USDC
   * token the borrower owns covering `amount` (Loan_Pay splits it internally), and
   * the pool/profile/config. */
  async repayContext(borrower: Party, loanCid: ContractId, amount: number) {
    const pool = await this.getPool();
    const [profile] = await this.queryActive(this.cfg.operator, 'CreditProfile', (a) => a.borrower === borrower);
    if (!profile) throw new Error('no credit profile');
    const configCid = await this.configCid();
    const toks = (await this.tokensOf(borrower)).filter((t) => t.amount >= amount).sort((a, b) => a.amount - b.amount);
    if (!toks.length) throw new Error('insufficient USDC to repay — use the faucet first');
    return { loanCid, payTokenCid: toks[0].contractId, poolCid: pool.contractId, profileCid: profile.contractId, configCid };
  }

  async listLoans(business: Party) {
    const ls = await this.queryActive(this.cfg.operator, 'Loan', (a) => a.borrower === business);
    return ls.map((l) => {
      const a = l.createArgument; const collateral = Number(a.collateral);
      return { id: l.contractId, principal: Number(a.principal), principalRepaid: Number(a.principalRepaid), outstanding: Number(a.outstanding), collateral, kind: collateral > 0 ? 'bnpl' : 'unsecured', merchant: a.merchant, dueTime: a.dueTime, status: a.status as string };
    });
  }
  /** BNPL plans where THIS business is the merchant (its customers' purchases). */
  async merchantBnpl(merchant: Party) {
    const ls = await this.queryActive(this.cfg.operator, 'Loan', (a) => a.merchant === merchant && a.borrower !== merchant);
    return ls.map((l) => ({ id: l.contractId, customer: l.createArgument.borrower as string, amount: Number(l.createArgument.principal), outstanding: Number(l.createArgument.outstanding), status: l.createArgument.status as string }));
  }
  async repayLoan(business: Party, loanCid: ContractId, amount: number): Promise<void> {
    const pool = await this.getPool();
    const [profile] = await this.queryActive(this.cfg.operator, 'CreditProfile', (a) => a.borrower === business);
    if (!profile) throw new Error('no credit profile');
    const payTokenCid = await this.anyHolding(business, amount);
    await this.submit([business, this.cfg.operator], [this.exercise(this.tid('Irion.Bnpl', 'Loan'), loanCid, 'Loan_Pay', { payer: business, payTokenCid, amount: dec(amount), poolCid: pool.contractId, profileCid: profile.contractId, configCid: await this.configCid() })]);
  }
  /** reclaim collateral once a (BNPL) loan is fully repaid. */
  async releaseCollateral(borrower: Party, loanCid: ContractId): Promise<void> {
    await this.submit([borrower, this.cfg.operator], [this.exercise(this.tid('Irion.Bnpl', 'Loan'), loanCid, 'Loan_ReleaseCollateral')]);
  }

  // ---------------------------------------------------------------- SETTLEMENT

  /** instant, atomic settlement: move USDC from a business to any counterparty. */
  async settle(from: Party, to: Party, amount: number): Promise<string> {
    const tokenCid = await this.exactHolding(from, amount);
    const tx = await this.submit([from], [this.exercise(this.tid('Irion.Token', 'Token'), tokenCid, 'Token_Transfer', { newOwner: to })]);
    return tx.transactionTree?.updateId ?? '';
  }

  // -------------------------------------------------------------- PRODUCT: BNPL

  /** a business (merchant) offers BNPL to one of its customers. */
  async openBnpl(merchant: Party, customer: Party, amount: number, collateral: number, termDays = 30): Promise<ContractId> {
    const pool = await this.getPool();
    const [profile] = await this.queryActive(this.cfg.operator, 'CreditProfile', (a) => a.borrower === customer);
    if (!profile) throw new Error('customer has no credit profile');
    const collateralTokenCid = await this.exactHolding(customer, collateral);
    const escrowTx = await this.submit([customer], [this.exercise(this.tid('Irion.Token', 'Token'), collateralTokenCid, 'Token_Transfer', { newOwner: this.cfg.operator })]);
    const collateralEscrowCid = this.madeLive(escrowTx, 'Token', (a) => a.owner === this.cfg.operator).contractId;
    const reqTx = await this.submit([customer], [this.create(this.tid('Irion.Bnpl', 'BnplRequest'), { operator: this.cfg.operator, borrower: customer, merchant, amount: dec(amount), collateral: dec(collateral), collateralEscrowCid, termSeconds: String(termDays * 86400) })]);
    const reqCid = this.madeLive(reqTx, 'BnplRequest').contractId;
    const merchantFundTokenCid = await this.operatorHolding(amount);
    const tx = await this.submit([this.cfg.operator], [this.exercise(this.tid('Irion.Bnpl', 'BnplRequest'), reqCid, 'BnplRequest_Accept', { poolCid: pool.contractId, profileCid: profile.contractId, configCid: await this.configCid(), merchantFundTokenCid })]);
    return this.madeLive(tx, 'Loan').contractId;
  }

  // --------------------------------------------------- MULTI-CURRENCY TREASURY

  /** per-currency cash balances + the USDC yield position. */
  async treasuryMulti(business: Party) {
    const balances: Record<string, number> = {};
    for (const cur of Object.keys(this.currencies)) balances[cur] = await this.balanceOf(business, cur);
    const t = await this.treasury(business);
    return { balances, cash: t.cash, yieldShares: t.yieldShares, yieldValue: t.yieldValue, total: t.total };
  }

  /** currency-aware settlement (defaults to USDC). */
  async settleCurrency(from: Party, to: Party, amount: number, currency = 'USDC'): Promise<string> {
    const tokenCid = await this.exactHolding(from, amount, this.currencyIssuer(currency));
    const tx = await this.submit([from], [this.exercise(this.tid('Irion.Token', 'Token'), tokenCid, 'Token_Transfer', { newOwner: to })]);
    return tx.transactionTree?.updateId ?? '';
  }

  /** FX rebalance: swap `amount` of `from` into `to` at `rate` (bought = amount*rate).
   * REAL on-ledger — the business sends `from` to the destination issuer's reserve
   * and that issuer mints `to` back. Two ledger txns; a single-tx atomic FxSwap
   * would need a dedicated Daml template (DAR rebuild). */
  async rebalance(business: Party, from: string, to: string, amount: number, rate: number) {
    const fromIssuer = this.currencyIssuer(from);
    const toIssuer = this.currencyIssuer(to);
    const bought = +(amount * rate).toFixed(2);
    const tokenCid = await this.exactHolding(business, amount, fromIssuer);
    const sellTx = await this.submit([business], [this.exercise(this.tid('Irion.Token', 'Token'), tokenCid, 'Token_Transfer', { newOwner: toIssuer })]);
    const mintTx = await this.submit([toIssuer], [this.create(this.tid('Irion.Token', 'Token'), { issuer: toIssuer, owner: business, amount: dec(bought) })]);
    return { from: from.toUpperCase(), to: to.toUpperCase(), sold: amount, bought, rate, updateId: mintTx.transactionTree?.updateId ?? sellTx.transactionTree?.updateId ?? '' };
  }

  // ------------------------------------------------------------------- PAYROLL

  /** run payroll: pay each employee from the business's holdings. Each payment is
   * a Token transfer visible ONLY to the issuer + that employee — no employee can
   * see another's salary (Canton sub-transaction privacy = private payroll). */
  async payrollRun(business: Party, entries: { party: Party; amount: number; currency?: string }[]) {
    const out: { party: Party; amount: number; currency: string; updateId: string }[] = [];
    for (const e of entries) {
      const cur = (e.currency ?? 'USDC').toUpperCase();
      const tokenCid = await this.exactHolding(business, e.amount, this.currencyIssuer(cur));
      const tx = await this.submit([business], [this.exercise(this.tid('Irion.Token', 'Token'), tokenCid, 'Token_Transfer', { newOwner: e.party })]);
      out.push({ party: e.party, amount: e.amount, currency: cur, updateId: tx.transactionTree?.updateId ?? '' });
    }
    return out;
  }

  // --------------------------------------------------------- REAL UNDERWRITING

  /** compute a credit score + limit from REAL on-ledger signals (treasury depth +
   * repayment history) instead of a hardcoded value, then attest it. Transparent
   * model: base 500 + up to 200 for treasury depth + 15/on-time repayment (cap 150). */
  async underwrite(business: Party) {
    await this.openProfile(business);
    const t = await this.treasury(business);
    const prof = await this.getProfile(business);
    const repayments = prof?.repayments ?? 0;
    const cash = t.total;
    const depthPts = Math.min(250, Math.floor(cash / 40));    // treasury depth (≈$2k clears the 600 floor)
    const historyPts = Math.min(120, repayments * 15);         // on-time repayment history
    const score = Math.max(500, Math.min(850, 550 + depthPts + historyPts));
    const limit = Math.max(50, Math.round((score / 850) * Math.max(cash * 0.5, 200)));
    await this.attest(business, limit, score);
    return { score, limit, signals: { treasuryTotal: cash, repayments, depthPts, historyPts } };
  }
}

export class LedgerError extends Error {
  constructor(msg: string, public detail: string) { super(msg); this.name = 'LedgerError'; }
}
