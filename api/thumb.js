import { get, put } from '@vercel/blob';
import { authorized, denied, json } from './_auth.js';

const path = request => {
  const vid = new URL(request.url).searchParams.get('vid') || '';
  return /^[A-Za-z0-9_-]{11}$/.test(vid) ? `thumbs/${vid}.jpg` : null;
};

export async function GET(request) {
  if (!authorized(request)) return denied();
  const p = path(request);
  if (!p) return json({ error: 'bad id' }, 400);
  const r = await get(p, { access: 'private', useCache: false });
  if (!r || r.statusCode !== 200) return json({ error: 'not found' }, 404);
  return new Response(r.stream, {
    headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
  });
}

export async function PUT(request) {
  if (!authorized(request)) return denied();
  const p = path(request);
  if (!p) return json({ error: 'bad id' }, 400);
  const body = await request.arrayBuffer();
  if (!body.byteLength || body.byteLength > 400000) return json({ error: 'bad image' }, 400);
  await put(p, Buffer.from(body), {
    access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'image/jpeg',
  });
  return json({ ok: true });
}
