import { authorized, denied, json } from './_auth.js';
import { readUsage, gatewayCredits, gatewayToken } from './_usage.js';

export async function GET(request) {
  if (!authorized(request)) return denied();
  const provider = process.env.GEMINI_API_KEY ? 'gemini' : 'gateway';
  const [usage, credits] = await Promise.all([readUsage(), provider === 'gateway' ? gatewayCredits(request) : null]);
  /* ?probe=1 sends a one-word request (a tiny fraction of a cent) to show whether the AI Gateway accepts us, and why not */
  let probe;
  if (new URL(request.url).searchParams.get('probe') && provider === 'gemini') {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${process.env.GEMINI_API_KEY}`)
      .catch(e => ({ status: 0, text: async () => String(e) }));
    const t = await r.text();
    let flash = [];
    try { flash = JSON.parse(t).models.map(m => m.name).filter(n => /flash/.test(n)); } catch {}
    probe = { status: r.status, flash, body: r.status === 200 ? undefined : t.slice(0, 600) };
  } else if (new URL(request.url).searchParams.get('probe')) {
    const r = await fetch('https://ai-gateway.vercel.sh/v1/messages', {
      method: 'POST',
      headers: { authorization: `Bearer ${gatewayToken(request)}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.ENRICH_MODEL || 'anthropic/claude-haiku-4.5', max_tokens: 5, messages: [{ role: 'user', content: 'Say ok' }] }),
    }).catch(e => ({ status: 0, text: async () => String(e) }));
    probe = { status: r.status, body: (await r.text()).slice(0, 600) };
  }
  return json({ ...usage, provider, credits, probe });
}
