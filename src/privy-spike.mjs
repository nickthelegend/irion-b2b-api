// Spike: can these Privy creds create a Solana (Ed25519) wallet + raw-sign?
process.loadEnvFile?.('.env');
const APP_ID = process.env.PRIVY_APP_ID;
const SECRET = process.env.PRIVY_APP_SECRET;
const H = { Authorization: 'Basic ' + Buffer.from(`${APP_ID}:${SECRET}`).toString('base64'), 'privy-app-id': APP_ID, 'content-type': 'application/json' };

async function call(path, body, method = 'POST') {
  const r = await fetch('https://api.privy.io' + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, j };
}

async function main() {
  console.log('app id:', APP_ID);
  console.log('\n1) create Solana wallet');
  const w = await call('/v1/wallets', { chain_type: 'solana' });
  console.log('  ', w.status, JSON.stringify(w.j).slice(0, 400));
  if (w.status >= 300) return;
  const id = w.j.id, address = w.j.address;
  console.log('   id:', id, '| address(pubkey):', address);

  console.log('\n2) raw-sign a message with the wallet key');
  for (const params of [
    { method: 'signMessage', params: { message: Buffer.from('hello canton').toString('base64'), encoding: 'base64' } },
    { method: 'signMessage', params: { message: 'hello canton', encoding: 'utf-8' } },
  ]) {
    const s = await call(`/v1/wallets/${id}/rpc`, params);
    console.log('  ', JSON.stringify(params.params).slice(0, 50), '->', s.status, JSON.stringify(s.j).slice(0, 300));
    if (s.status < 300) break;
  }
}
main().catch((e) => console.error('ERR', e?.message ?? e));
