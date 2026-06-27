// LIVE FX oracle. The stablecoins are treated as their fiat peg
// (USDC≈USD, EURC≈EUR, GBPC≈GBP); cross rates are derived from live USD-based
// rates fetched from a public FX API (frankfurter.dev) and cached for 10 min.
// Falls back to a static table only if the upstream is unreachable — so the rate
// is REAL market data, not a hardcoded constant.
const PEG: Record<string, string> = { USDC: 'USD', EURC: 'EUR', GBPC: 'GBP' };
const FALLBACK: Record<string, number> = { USD: 1, EUR: 0.92, GBP: 0.79 };
const TTL = 10 * 60_000;

let cache: { at: number; rates: Record<string, number>; live: boolean } | null = null;

async function usdRates(): Promise<{ rates: Record<string, number>; live: boolean }> {
  if (cache && Date.now() - cache.at < TTL) return cache;
  try {
    const r = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,GBP', { signal: AbortSignal.timeout(8000) });
    const j: any = await r.json();
    if (j?.rates?.EUR && j?.rates?.GBP) {
      cache = { at: Date.now(), rates: { USD: 1, EUR: Number(j.rates.EUR), GBP: Number(j.rates.GBP) }, live: true };
      return cache;
    }
  } catch { /* fall through to fallback */ }
  cache = { at: Date.now(), rates: { ...FALLBACK }, live: false };
  return cache;
}

export const isCurrency = (c: string): boolean => !!PEG[c?.toUpperCase?.()];

/** Live rate for `from`→`to` (amount of `to` per 1 `from`). */
export async function getRate(from: string, to: string): Promise<{ rate: number; source: 'live' | 'fallback' }> {
  const f = PEG[from?.toUpperCase()]; const t = PEG[to?.toUpperCase()];
  if (!f || !t) throw new Error(`unknown currency '${from}' or '${to}'`);
  if (f === t) return { rate: 1, source: 'live' };
  const { rates, live } = await usdRates();
  return { rate: +(rates[t] / rates[f]).toFixed(6), source: live ? 'live' : 'fallback' };
}

/** All cross rates between the supported currencies. */
export async function allRates(): Promise<{ rates: Record<string, number>; source: 'live' | 'fallback' }> {
  const curs = Object.keys(PEG);
  const { rates: usd, live } = await usdRates();
  const out: Record<string, number> = {};
  for (const a of curs) for (const b of curs) if (a !== b) out[`${a}:${b}`] = +(usd[PEG[b]] / usd[PEG[a]]).toFixed(6);
  return { rates: out, source: live ? 'live' : 'fallback' };
}
