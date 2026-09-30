import { authorized, denied, json } from './_auth.js';
import { readUsage, addUsage, overCap } from './_usage.js';
import { ask, youtubeFacts } from './_ai.js';

/* Given a YouTube ad, find brand, campaign, agency, year, market and category.
   Reads what YouTube says about the video, then has an AI search the web (trade press,
   Ads of the World, agency sites). Only fields it is reasonably sure of come back.
   The engine behind it lives in _ai.js. */

export const CATEGORIES = [
  'Automotive', 'Beverages', 'Alcohol', 'Food & Restaurants', 'Tech & Electronics', 'Telecom',
  'Retail & E-commerce', 'Fashion & Apparel', 'Beauty & Personal care', 'Finance & Insurance',
  'Travel & Hospitality', 'Sports', 'Media & Entertainment', 'Gaming', 'Health & Pharma',
  'Home & Household', 'Public service & NGO', 'Other',
];
const FIELDS = ['brand', 'campaign', 'agency', 'year', 'market', 'category', 'line'];

export async function POST(request) {
  if (!authorized(request)) return denied();
  let q;
  try { q = await request.json(); } catch { return json({ error: 'not JSON' }, 400); }
  const vid = String(q.vid || '');
  if (!/^[A-Za-z0-9_-]{11}$/.test(vid)) return json({ error: 'bad id' }, 400);

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
  try { res = await ask(prompt, request); }
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
  if (res.note) out.note = res.note;
  out.usage = now;
  return json(out);
}
