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

// (1) The dApp does this via Carpincho — here the borrower party signs the create.
await led.submit([borrower], [led.create(led.tid('Irion.Bnpl', 'UnsecuredRequest'), {
  operator: led.cfg.operator, borrower, amount: '25.0', termSeconds: String(30 * 86400),
})]);
console.log('✓ borrower signed an UnsecuredRequest (25 USDC)');

// (2) Operator completes it (the new path behind /v1/wallet/bnpl/complete).
await led.ensureCredit(borrower, 1000, 780);
console.log('✓ operator opened credit profile + attested score 780 / limit 1000');

const loan = await led.acceptUnsecuredFor(borrower);
console.log('✓ Loan disbursed:', loan);

const bal = await led.usdcBalance(borrower);
console.log('borrower USDC balance after disbursal:', bal);
console.log(bal >= 25 ? '✅ END-TO-END BNPL VERIFIED' : '❌ disbursal did not credit the borrower');
