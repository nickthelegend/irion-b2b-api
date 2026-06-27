// Headless proof that a CONSUMER (external / self-custody party) can supply to the
// yield pool using only the EXISTING Daml templates — SupplyRequest +
// SupplyRequest_Accept, the same request/accept pattern BNPL uses. This refutes the
// old "consumer supply needs a SupplyDirect/Token_Pay Daml choice → DAR rebuild"
// boundary. The supplier signs (as the dApp would via Carpincho); the operator
// accepts. Run: `npx tsx src/verify-wallet-supply.ts`.
import { Ledger } from './canton.js';
import * as store from './store.js';

const led: any = new Ledger(store.cantonConfig(store.loadState()));

const supplier = await led.allocateParty('walletsupplier');
console.log('supplier party:', supplier);

await led.fund(supplier, 200);
console.log('✓ supplier funded 200 USDC (faucet)');

// The supplier signs the escrow + SupplyRequest; the operator accepts → PoolShare.
const { shares } = await led.supplyFromWallet(supplier, 100);
console.log('✓ supplied 100 USDC to the pool → PoolShare shares:', shares);

// Confirm the on-ledger yield position belongs to the consumer.
const pos = await led.treasury(supplier);
console.log('supplier yield position:', { shares: pos.yieldShares, value: pos.yieldValue });
console.log(shares > 0 && pos.yieldShares > 0
  ? '✅ CONSUMER SUPPLY VERIFIED (existing templates, no DAR rebuild)'
  : '❌ no PoolShare minted for the supplier');
