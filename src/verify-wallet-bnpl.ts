// Headless end-to-end verification of the wallet BNPL completion path.
// Simulates the user's wallet-signed UnsecuredRequest (what the dApp does via
// Carpincho), then runs the operator completion (ensureCredit + acceptUnsecuredFor,
// the same code the /v1/wallet/bnpl/complete endpoint calls) and checks a real
// Loan disburses USDC to the borrower. Run: `npx tsx src/verify-wallet-bnpl.ts`.
import { Ledger } from './canton.js';
import * as store from './store.js';

const led: any = new Ledger(store.cantonConfig(store.loadState()));

const borrower = await led.allocateParty('walletborrower');
console.log('borrower party:', borrower);

// Fund the borrower so they can later repay principal + the unsecured premium.
await led.fund(borrower, 100);

// (1) The dApp does this via Carpincho — here the borrower party signs the create.
await led.submit([borrower], [led.create(led.tid('Irion.Bnpl', 'UnsecuredRequest'), {
  operator: led.cfg.operator, borrower, amount: '25.0', termSeconds: String(30 * 86400),
})]);
console.log('✓ borrower signed an UnsecuredRequest (25 USDC)');

// (2) Operator completes it (the path behind /v1/wallet/bnpl/complete) — score is
// computed on-ledger (NOT caller-supplied) via ensureConsumerCredit.
const cr = await led.ensureConsumerCredit(borrower);
console.log(`✓ operator opened credit profile + attested computed score ${cr.score} / limit ${cr.limit}`);

const loan = await led.acceptUnsecuredFor(borrower);
console.log('✓ Loan disbursed:', loan);

const bal = await led.usdcBalance(borrower);
console.log('borrower USDC balance after disbursal:', bal);

// (3) Repay the loan (the path behind /v1/wallet/repay). Loan_Pay references the
// operator-signatory ProtocolConfig + LendingPool, so the operator co-signs — a
// wallet-only signature can't see those contracts ("prepare failed"). The
// borrower's own token still pays.
const [open] = await led.listLoans(borrower);
console.log(`✓ repaying loan ${open.id.slice(0, 16)}… outstanding ${open.outstanding} USDC`);
await led.repayLoan(borrower, open.id, open.outstanding);
const stillOpen = (await led.listLoans(borrower)).filter((l: any) => l.outstanding > 0).length;
console.log('open loans after repay:', stillOpen);

console.log(bal >= 25 && stillOpen === 0
  ? '✅ END-TO-END BNPL VERIFIED (borrow + repay, operator co-signed)'
  : '❌ borrow/repay did not settle correctly');
