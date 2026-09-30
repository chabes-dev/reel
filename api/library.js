import { get, put } from '@vercel/blob';
import { authorized, denied, json } from './_auth.js';
import { mergeLibraries } from '../lib/merge.js';

/* One JSON file holds every ad's text fields; thumbnails live beside it in thumbs/.
   Writes are merged into what's already stored, so one device can never wipe another's ads.
   The first write of each day also keeps a dated snapshot of the previous state. */
const MAIN = 'library.json';

async function readMain() {
  const r = await get(MAIN, { access: 'private', useCache: false });
  if (!r || r.statusCode !== 200) return null;
  return JSON.parse(await new Response(r.stream).text());
}
const write = (path, doc) =>
  put(path, JSON.stringify(doc), {
    access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/json',
  });

export async function GET(request) {
  if (!authorized(request)) return denied();
  const doc = await readMain();
  return json(doc || { items: [], deleted: {}, savedAt: 0 });
}

export async function PUT(request) {
  if (!authorized(request)) return denied();
  let incoming;
  try { incoming = await request.json(); } catch { return json({ error: 'not JSON' }, 400); }
  if (!incoming || !Array.isArray(incoming.items)) return json({ error: 'not a Reel library' }, 400);

  const current = await readMain();
  const day = new Date().toISOString().slice(0, 10);
  const snap = !!(current && current.items && current.items.length && current.snapDay !== day);
  if (snap) await write(`snapshots/${day}.json`, current);

  const merged = mergeLibraries(current, incoming);
  merged.savedAt = Date.now();
  merged.snapDay = snap ? day : (current && current.snapDay) || null;
  await write(MAIN, merged);
  return json(merged);
}
