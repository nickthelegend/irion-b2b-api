// One-time bootstrap: allocate the Irion platform parties (operator + the two
// trusted issuers) on the ledger, initialise the ProtocolConfig + LendingPool,
// and persist everything to .irion-state.json for the server to load.
import { Ledger } from './canton.js';
import { saveState, cantonConfig, isBootstrapped, clearData, type LedgerState } from './store.js';

async function main() {
  if (isBootstrapped() && !process.argv.includes('--force')) {
    console.log('already bootstrapped (.irion-state.json exists). Use --force to re-bootstrap.');
    return;
  }
  const placeholder = { operator: 'x', usdcIssuer: 'x', creditIssuer: 'x' };
  const boot = new Ledger(cantonConfig(placeholder));

  console.log('allocating platform parties…');
  const operator = await boot.allocateParty('irionoperator');
  const usdcIssuer = await boot.allocateParty('irionusdc');
  const creditIssuer = await boot.allocateParty('irioncredit');

  clearData(); // fresh demo: clear businesses/settlements/links from any prior bootstrap

  const led = new Ledger(cantonConfig({ operator, usdcIssuer, creditIssuer }));
  console.log('initialising ProtocolConfig + LendingPool…');
  const configCid = await led.initConfig();
  const poolCid = await led.initPool();
  console.log('seeding pool liquidity (so BNPL / split work)…');
  await led.seedPool(5_000_000);

  const state: LedgerState = { operator, usdcIssuer, creditIssuer, configCid, poolCid };
  saveState(state);
  console.log('\n✓ Irion B2B platform bootstrapped:');
  console.log('  operator    ', operator);
  console.log('  usdcIssuer  ', usdcIssuer);
  console.log('  creditIssuer', creditIssuer);
  console.log('\nState written to .irion-state.json — now run `npm start`.');
}
main().catch((e) => { console.error('bootstrap failed:', e); process.exit(1); });
