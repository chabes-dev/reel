import { estimate, gatewayToken } from './_usage.js';

/* The AI + web search plumbing shared by auto-fill (/api/enrich) and Find the team (/api/team).
   Google Gemini with Google Search when GEMINI_API_KEY is set (free); otherwise Claude via Vercel AI Gateway. */
const MODEL = process.env.ENRICH_MODEL || 'anthropic/claude-haiku-4.5';

export async function youtubeFacts(vid) {
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

export function parseAnswer(msg) {
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

/* Google Gemini with Google Search grounding — free tier, no card. Free keys only get search on some
   models (and Google moves that line), so try stable Flash models newest-first and remember the first that
   answers with search on. If none will search, fall back to the newest one answering from what it knows. */
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
let geminiWorks = process.env.GEMINI_MODEL || '';
async function geminiCandidates(key) {
  const r = await fetch(`${GEMINI}/models?pageSize=1000`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw failure(r.status, await r.text(), 'Google');
  const names = ((await r.json()).models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace(/^models\//, ''));
  const ver = n => +(n.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1];
  const stable = names.filter(n => /^gemini-[\d.]+-flash$/.test(n)).sort((x, y) => ver(y) - ver(x));
  return [...new Set([...stable, ...names.filter(n => n === 'gemini-flash-latest')])];
}
/* the free tier is sometimes "overloaded" for a few seconds — retry those twice before giving up */
async function geminiCall(key, model, prompt, search, maxTokens) {
  for (let k = 0; ; k++) {
    const r = await geminiOnce(key, model, prompt, search, maxTokens);
    if ((r.status !== 503 && r.status !== 500) || k === 2) return r;
    await new Promise(res => setTimeout(res, 1500 * (k + 1)));
  }
}
async function geminiOnce(key, model, prompt, search, maxTokens) {
  return fetch(`${GEMINI}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      ...(search ? { tools: [{ google_search: {} }] } : {}),
      generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens || 2000, thinkingConfig: { thinkingBudget: 512 } },
    }),
    signal: AbortSignal.timeout(75000),
  }).catch(e => { throw new Error(e.name === 'TimeoutError' ? 'Google took too long — try again' : e.message); });
}
async function askGemini(prompt, key, maxTokens, memoryOk = true) {
  const models = geminiWorks ? [geminiWorks] : await geminiCandidates(key);
  let r, last, search = true;
  for (const m of models) {
    r = await geminiCall(key, m, prompt, true, maxTokens);
    if (r.ok) { geminiWorks = m; break; }
    last = failure(r.status, await r.text(), 'Google');
    if (r.status !== 429 && r.status !== 403 && r.status !== 404) throw last;
    r = null;
  }
  if (!r && geminiWorks) { geminiWorks = ''; return askGemini(prompt, key, maxTokens, memoryOk); }   /* remembered model stopped working */
  const daily = last && /PerDay/.test(last.detail || '');
  if (!r && !memoryOk) throw new Error(daily
    ? "Google's free daily searches (20 a day) are used up — they reset at midnight Pacific time"
    : "Google's free search is busy — try again in a minute");
  if (!r && models[0]) {
    search = false;
    r = await geminiCall(key, models[0], prompt, false, maxTokens);
    if (!r.ok) throw failure(r.status, await r.text(), 'Google');
  }
  if (!r) throw last || new Error('no Gemini Flash model available to this key');
  const j = await r.json();
  const c = (j.candidates || [])[0] || {};
  const text = ((c.content && c.content.parts) || []).map(p => p.text || '').join('\n');
  const g = c.groundingMetadata || {};
  const sources = (g.groundingChunks || []).filter(x => x.web && x.web.uri)
    .map(x => ({ url: x.web.uri, title: x.web.title || '' }));
  return { found: parseAnswer({ content: [{ type: 'text', text }] }), text, sources, usd: 0,
    searches: (g.webSearchQueries || []).length,
    note: search ? '' : daily ? "Google's 20 free searches today are used up — answered from memory, check it" : 'no web search right now — answered from memory, check it' };
}

/* Claude through Vercel AI Gateway — needs a card on the Vercel account to unlock its free credit */
async function askGateway(prompt, token, maxTokens) {
  const r = await fetch('https://ai-gateway.vercel.sh/v1/messages', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens || 1500,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(80000),
  });
  if (!r.ok) throw failure(r.status, await r.text(), 'AI Gateway');
  const msg = await r.json();
  const u = msg.usage || {};
  return { found: parseAnswer(msg), text: (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n'), sources: [], usd: estimate(u), searches: (u.server_tool_use && u.server_tool_use.web_search_requests) || 0 };
}

/* one call: the prompt goes to whichever engine is set up; returns { found, sources, usd, searches, note } */
/* memoryOk=false: fail rather than let the model answer without searching (used for people's names) */
export async function ask(prompt, request, maxTokens, memoryOk = true) {
  const geminiKey = process.env.GEMINI_API_KEY || '';
  if (geminiKey) return askGemini(prompt, geminiKey, maxTokens, memoryOk);
  const token = gatewayToken(request);
  if (!token) throw new Error('no search engine set up — add GEMINI_API_KEY in Vercel');
  return askGateway(prompt, token, maxTokens);
}
