import { authorized, denied, json } from './_auth.js';
import { readUsage, addUsage, overCap, estimate, gatewayToken } from './_usage.js';

/* Given a YouTube ad, find brand, campaign, agency, year, market and category.
   Reads what YouTube says about the video, then lets Claude search the web (trade press,
   Ads of the World, agency sites) through Vercel AI Gateway. Only fields it is reasonably sure of come back. */

export const CATEGORIES = [
  'Automotive', 'Beverages', 'Alcohol', 'Food & Restaurants', 'Tech & Electronics', 'Telecom',
  'Retail & E-commerce', 'Fashion & Apparel', 'Beauty & Personal care', 'Finance & Insurance',
  'Travel & Hospitality', 'Sports', 'Media & Entertainment', 'Gaming', 'Health & Pharma',
  'Home & Household', 'Public service & NGO', 'Other',
];
const FIELDS = ['brand', 'campaign', 'agency', 'year', 'market', 'category', 'line'];
const MODEL = process.env.ENRICH_MODEL || 'anthropic/claude-haiku-4.5';

async function youtubeFacts(vid) {
  try {
    const r = await fetch(`https://www.youtube.com/watch?v=${vid}&hl=en`, {
      headers: { 'accept-language': 'en-US,en;q=0.9', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36' },
      signal: AbortSignal.timeout(8000),
    });
    const html = await r.text();
    const pick = re => { const m = html.match(re); if (!m) return ''; try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; } };
    return {
      description: pick(/"shortDescription":"((?:[^"\\]|\\.)*)"/).slice(0, 2500),
      published: pick(/"(?:uploadDate|publishDate)":"([^"]+)"/).slice(0, 10),
    };
  } catch { return { description: '', published: '' }; }
}

function parseAnswer(msg) {
  const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const m = text.match(/\{[\s\S]*\}/g);
  if (!m) return null;
  for (const cand of m.reverse()) { try { return JSON.parse(cand); } catch {} }
  return null;
}

export async function POST(request) {
  if (!authorized(request)) return denied();
  let q;
  try { q = await request.json(); } catch { return json({ error: 'not JSON' }, 400); }
  const vid = String(q.vid || '');
  if (!/^[A-Za-z0-9_-]{11}$/.test(vid)) return json({ error: 'bad id' }, 400);

  const token = gatewayToken(request);
  if (!token) return json({ error: 'AI Gateway not available on this deployment' }, 503);

  const usage = await readUsage();
  if (overCap(usage))
    return json({ error: `monthly auto-fill limit reached (${usage.ads} ads, ~$${usage.usd.toFixed(2)})`, usage }, 429);

  const yt = await youtubeFacts(vid);
  const prompt = `You catalogue TV and online ads for an advertising professional's personal library.

Video: https://www.youtube.com/watch?v=${vid}
YouTube title: ${q.title || '(unknown)'}
YouTube channel: ${q.channel || '(unknown)'}
Published on YouTube: ${yt.published || '(unknown)'}
Description:
${yt.description || '(none)'}

Identify this ad. Search the web (Ads of the World, Campaign, Adweek, Ad Age, LBBOnline, Shots, The Drum, Cannes Lions, agency sites, press releases) for the credits.

Answer with ONLY a JSON object, no prose, with these keys:
- "brand": the advertiser (e.g. "Apple", "Heineken")
- "campaign": the ad or campaign name as the industry calls it (e.g. "Shot on iPhone — Relay")
- "agency": the lead creative agency (e.g. "Wieden+Kennedy"); not the production company
- "year": the year the ad launched, 4 digits
- "market": the country it ran in, or "Global"
- "category": exactly one of ${CATEGORIES.map(c => `"${c}"`).join(', ')}
- "line": the tagline or end line, if you find it
- "sources": up to 3 URLs you relied on
Use "" for anything you can't find with reasonable confidence. Never guess an agency.`;

  const r = await fetch('https://ai-gateway.vercel.sh/v1/messages', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(80000),
  }).catch(e => ({ ok: false, status: 504, text: async () => String(e) }));

  if (!r.ok) {
    const detail = (await r.text()).slice(0, 600);
    console.error('AI Gateway refused', r.status, detail);
    let why = '';
    try { const e = JSON.parse(detail).error; why = (e && (e.message || e)) || ''; } catch {}
    return json({ error: `search failed (${r.status})${why ? ': ' + String(why).slice(0, 220) : ''}`, detail }, 502);
  }
  const msg = await r.json();
  const found = parseAnswer(msg) || {};
  const u = msg.usage || {};
  const now = await addUsage(usage, estimate(u), (u.server_tool_use && u.server_tool_use.web_search_requests) || 0);

  const out = {};
  for (const f of FIELDS) {
    const v = typeof found[f] === 'string' || typeof found[f] === 'number' ? String(found[f]).trim() : '';
    if (v && !/^(unknown|n\/a|none)$/i.test(v)) out[f] = v.slice(0, 200);
  }
  if (out.year && !/^(19|20)\d\d$/.test(out.year)) delete out.year;
  if (!out.year && yt.published) out.year = yt.published.slice(0, 4);
  if (out.category && !CATEGORIES.includes(out.category)) out.category = 'Other';
  out.sources = (Array.isArray(found.sources) ? found.sources : []).filter(u => /^https?:\/\//.test(u)).slice(0, 3);
  out.usage = now;
  return json(out);
}
