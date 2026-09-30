import { authorized, denied, json } from './_auth.js';
import { readUsage, addUsage, overCap } from './_usage.js';
import { ask, youtubeFacts } from './_ai.js';

/* Find the team: the people credited on an ad (creatives, strategists, director…).
   A wrong name is worse than no name, so every person the AI suggests is checked against the pages it
   cited (and the YouTube description): if the name really appears there, it comes back verified with
   that page as its source; if not, it comes back flagged as unconfirmed. */

const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/&nbsp;|&#160;/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

async function readPage(url) {
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36', 'accept-language': 'en' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const html = (await r.text()).slice(0, 2_000_000);
    const title = (html.match(/<title[^>]*>([^<]*)/i) || [])[1] || '';
    const text = fold(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '));
    return { url: r.url || url, title: title.trim().slice(0, 120), text };
  } catch { return null; }
}
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

export async function POST(request) {
  if (!authorized(request)) return denied();
  let q;
  try { q = await request.json(); } catch { return json({ error: 'not JSON' }, 400); }
  const vid = String(q.vid || '');
  if (!/^[A-Za-z0-9_-]{11}$/.test(vid)) return json({ error: 'bad id' }, 400);

  const usage = await readUsage();
  if (overCap(usage)) return json({ error: `monthly search limit reached (${usage.ads})`, usage }, 429);

  const yt = await youtubeFacts(vid);
  const known = [['Brand', q.brand], ['Ad / campaign', q.campaign], ['Agency', q.agency], ['Year', q.year], ['Market', q.market]]
    .filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');
  const prompt = `You research advertising credits for an advertising professional.

Ad: https://www.youtube.com/watch?v=${vid}
YouTube title: ${q.title || '(unknown)'}
YouTube channel: ${q.channel || '(unknown)'}
${known}
YouTube description:
${yt.description || '(none)'}

Search the web for the published credits of THIS ad (LBBOnline, Shots, Ads of the World, Campaign, Campaign Brief,
The Drum, Adweek, Cannes Lions / D&AD / One Show / Effie entries, the agency's or production company's own site).
List the people credited at the agency (chief creative officer, executive creative director, creative director,
copywriter, art director, strategy / planning), plus the director and the production company.
At most 12 people, most senior creative first. Skip client-side marketing staff and crew below heads of department.
Only include people you actually saw credited for this specific ad. Never guess.

Write one person per line, exactly:
Name | Role | Company
No other text. If you can't find published credits, write: NONE`;

  let res;
  try { res = await ask(prompt, request, 4000, false); }
  catch (e) { console.error('team search failed', e.message, e.detail || ''); return json({ error: e.message, usage }, 502); }
  const now = await addUsage(usage, res.usd, res.searches);

  const listed = String(res.text || '').split('\n').map(l => l.replace(/^[\s*•\-\d.]+/, '').split('|').map(x => x.trim()))
    .filter(c => c.length >= 2 && c[0] && !/^name$/i.test(c[0])).map(c => ({ name: c[0], role: c[1], company: c[2] || '' }));
  const cites = [...String(res.text || '').matchAll(/https?:\/\/[^\s"'<>)\]|]+/g)].map(m => m[0]);
  const people = listed
    .map(p => ({ name: String(p.name || '').trim().slice(0, 60), role: String(p.role || '').trim().slice(0, 60),
      company: String(p.company || '').trim().slice(0, 60) }))
    .filter(p => p.name.split(/\s+/).length >= 2 && !/unknown|n\/a/i.test(p.name));

  /* read what was cited, plus the YouTube description (agencies often put credits there) */
  const urls = [...new Set([...(res.sources || []).map(s => s.url), ...cites].filter(u => /^https?:\/\//.test(u)))].slice(0, 8);
  const pages = (await Promise.all(urls.map(readPage))).filter(Boolean);
  if (yt.description) pages.push({ url: `https://www.youtube.com/watch?v=${vid}`, title: 'YouTube description', text: fold(yt.description) });

  const seen = new Set();
  const team = [];
  for (const p of people) {
    const key = fold(p.name);
    if (seen.has(key)) continue;
    seen.add(key);
    const hit = pages.find(pg => pg.text.includes(key));
    team.push({
      name: p.name, role: p.role, company: p.company, verified: !!hit,
      source: hit ? { url: hit.url, title: host(hit.url) === 'youtube.com' ? 'YouTube description' : host(hit.url) } : null,
    });
  }
  team.sort((a, b) => b.verified - a.verified);
  return json({ team, checked: pages.length, searched: res.searches, usage: now });
}
