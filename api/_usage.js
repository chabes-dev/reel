import { get, put } from '@vercel/blob';

/* Auto-fill spend, counted per calendar month in usage/YYYY-MM.json.
   The server refuses to search once either cap is reached, so it can never quietly run past the free credit. */
export const LIMIT_ADS = +(process.env.ENRICH_MONTHLY_LIMIT || 100);
export const LIMIT_USD = +(process.env.ENRICH_MONTHLY_BUDGET || 4.5);
/* Claude Haiku 4.5 list prices: $1 / M input tokens, $5 / M output tokens, $10 per 1,000 web searches */
export const estimate = u =>
  ((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) * 0.1) / 1e6 * 1
  + (u.output_tokens || 0) / 1e6 * 5
  + ((u.server_tool_use && u.server_tool_use.web_search_requests) || 0) * 0.01;

const month = () => new Date().toISOString().slice(0, 7);
const path = m => `usage/${m}.json`;

export async function readUsage() {
  const m = month();
  const r = await get(path(m), { access: 'private', useCache: false }).catch(() => null);
  const u = r && r.statusCode === 200 ? JSON.parse(await new Response(r.stream).text()) : {};
  return { month: m, ads: u.ads || 0, searches: u.searches || 0, usd: u.usd || 0, limitAds: LIMIT_ADS, limitUsd: LIMIT_USD };
}
export async function addUsage(u, usd, searches) {
  const next = { month: u.month, ads: u.ads + 1, searches: u.searches + searches, usd: +(u.usd + usd).toFixed(4) };
  await put(path(u.month), JSON.stringify(next), {
    access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/json',
  });
  return { ...next, limitAds: LIMIT_ADS, limitUsd: LIMIT_USD };
}
export const overCap = u => u.ads >= u.limitAds || u.usd >= u.limitUsd;

/* what Vercel itself reports: remaining AI Gateway credit and lifetime spend, in USD */
export async function gatewayCredits() {
  const token = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN;
  if (!token) return { error: 'no AI Gateway token on this deployment' };
  try {
    const r = await fetch('https://ai-gateway.vercel.sh/v1/credits', {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return { error: `credits check said ${r.status}`, detail: (await r.text()).slice(0, 200) };
    const j = await r.json();
    return { balance: j.balance, used: j.total_used };
  } catch (e) { return { error: String(e).slice(0, 200) }; }
}
