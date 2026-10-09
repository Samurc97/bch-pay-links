/**
 * BCH/USD spot price via CoinGecko (public, no key needed).
 * Cached for 60s to avoid hammering the API on every link creation.
 */
const URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash&vs_currencies=usd';
const CACHE_MS = 60_000;

let cached = null;

export async function getBchUsdRate() {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.rate;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(URL, { signal: ctrl.signal, headers: { 'User-Agent': 'bch-pay-links/0.1' } });
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const j = await res.json();
    const rate = j?.['bitcoin-cash']?.usd;
    if (!rate || rate <= 0) throw new Error('Invalid rate in CoinGecko response');
    cached = { rate, at: Date.now() };
    return rate;
  } finally {
    clearTimeout(t);
  }
}
