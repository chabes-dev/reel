import { authorized, denied, json } from './_auth.js';
import { readUsage, addUsage, overCap, estimate, gatewayToken } from './_usage.js';

/* Given a YouTube ad, find brand, campaign, agency, year, market and category.
   Reads what YouTube says about the video, then has an AI search the web (trade press,
   Ads of the World, agency sites). Only fields it is reasonably sure of come back.
   Search runs on Google Gemini when GEMINI_API_KEY is set (free), otherwise on Claude via Vercel AI Gateway. */

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

const failure = (status, body, who) => {
  let why = '';
  try { const e = JSON.parse(body).error; why = (e && (e.message || e)) || ''; } catch {}
  const err = new Error(`${who} said ${status}${why ? ': ' + String(why).slice(0, 220) : ''}`);
  err.detail = String(body).slice(0, 600);
  return err;
};

/* Google Gemini with Google Search grounding — free tier, no card. Picks the newest stable Flash model
   the key can use, unless GEMINI_MODEL says otherwise. */
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
let geminiModel = process.env.GEMINI_MODEL || '';
async function pickGeminiModel(key) {
  if (geminiModel) return geminiModel;
  const r = await fetch(`${GEMINI}/models?pageSize=1000&key=${key}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw failure(r.status, await r.text(), 'Google');
  const names = ((await r.json()).models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace(/^models\//, ''));
  const ver = n => +(n.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1];
  const rank = [/^gemini-[\d.]+-flash$/, /^gemini-[\d.]+-flash-(preview|latest)/, /^gemini-[\d.]+-flash(?!-lite)/, /^gemini-flash-latest$/];
  for (const re of rank) {
    const hit = names.filter(n => re.test(n)).sort((x, y) => ver(y) - ver(x))[0];
    if (hit) return (geminiModel = hit);
  }
  throw new Error('no Gemini Flash model available to this key');
}
async function askGemini(prompt, key) {
  const model = await pickGeminiModel(key);
  const r = await fetch(`${GEMINI}/models/${model}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 1500 },
    }),
    signal: AbortSignal.timeout(80000),
  });
  if (!r.ok) throw failure(r.status, await r.text(), 'Google');
  const j = await r.json();
  const c = (j.candidates || [])[0] || {};
  const text = ((c.content && c.content.parts) || []).map(p => p.text || '').join('\n');
  const g = c.groundingMetadata || {};
  const sources = (g.groundingChunks || []).filter(x => x.web && x.web.uri)
    .map(x => ({ url: x.web.uri, title: x.web.title || '' }));
  return { found: parseAnswer({ content: [{ type: 'text', text }] }), sources, usd: 0, searches: (g.webSearchQueries || []).length };
}

/* Claude through Vercel AI Gateway — needs a card on the Vercel account to unlock its free credit */
async function askGateway(prompt, token) {
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
  });
  if (!r.ok) throw failure(r.status, await r.text(), 'AI Gateway');
  const msg = await r.json();
  const u = msg.usage || {};
  return { found: parseAnswer(msg), sources: [], usd: estimate(u), searches: (u.server_tool_use && u.server_tool_use.web_search_requests) || 0 };
}

export async function POST(request) {
  if (!authorized(request)) return denied();
  let q;
  try { q = await request.json(); } catch { return json({ error: 'not JSON' }, 400); }
  const vid = String(q.vid || '');
  if (!/^[A-Za-z0-9_-]{11}$/.test(vid)) return json({ error: 'bad id' }, 400);

  const geminiKey = process.env.GEMINI_API_KEY || '';
  const token = gatewayToken(request);
  if (!geminiKey && !token) return json({ error: 'no search engine set up — add GEMINI_API_KEY in Vercel' }, 503);

  const usage = await readUsage();
  if (overCap(usage))
    return json({ error: `monthly auto-fill limit reached (${usage.ads} ads)`, usage }, 429);

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

  let res;
  try { res = geminiKey ? await askGemini(prompt, geminiKey) : await askGateway(prompt, token); }
  catch (e) { console.error('auto-fill failed', e.message, e.detail || ''); return json({ error: e.message, usage }, 502); }
  const found = res.found || {};
  const now = await addUsage(usage, res.usd, res.searches);

  const out = {};
  for (const f of FIELDS) {
    const v = typeof found[f] === 'string' || typeof found[f] === 'number' ? String(found[f]).trim() : '';
    if (v && !/^(unknown|n\/a|none)$/i.test(v)) out[f] = v.slice(0, 200);
  }
  if (out.year && !/^(19|20)\d\d$/.test(out.year)) delete out.year;
  if (!out.year && yt.published) out.year = yt.published.slice(0, 4);
  if (out.category && !CATEGORIES.includes(out.category)) out.category = 'Other';
  out.sources = (res.sources && res.sources.length ? res.sources : (Array.isArray(found.sources) ? found.sources : []))
    .filter(u => typeof u === 'string' ? /^https?:\/\//.test(u) : u && /^https?:\/\//.test(u.url)).slice(0, 3);
  out.usage = now;
  return json(out);
}
