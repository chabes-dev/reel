import { readBin, writeBin } from './store.js';
import { authorized, denied, json } from './auth.js';

const path = request => {
  const vid = new URL(request.url).searchParams.get('vid') || '';
  return /^[A-Za-z0-9_-]{11}$/.test(vid) ? `thumbs/${vid}.jpg` : null;
};

export async function GET(request) {
  if (!authorized(request)) return denied();
  const p = path(request);
  if (!p) return json({ error: 'bad id' }, 400);
  const bytes = await readBin(p);
  if (!bytes) return json({ error: 'not found' }, 404);
  return new Response(bytes, {
    headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
  });
}

export async function PUT(request) {
  if (!authorized(request)) return denied();
  const p = path(request);
  if (!p) return json({ error: 'bad id' }, 400);
  const body = await request.arrayBuffer();
  if (!body.byteLength || body.byteLength > 400000) return json({ error: 'bad image' }, 400);
  await writeBin(p, body);
  return json({ ok: true });
}
