import { readJSON, writeJSON } from './store.js';
import { authorized, denied, json } from './auth.js';
import { mergeLibraries } from '../lib/merge.js';

/* One JSON doc holds every ad's text fields; thumbnails live beside it in thumbs/.
   Writes are merged into what's already stored, so one device can never wipe another's ads.
   The first write of each day also keeps a dated snapshot of the previous state. */
const MAIN = 'library.json';

export async function GET(request) {
  if (!authorized(request)) return denied();
  const doc = await readJSON(MAIN);
  return json(doc || { items: [], deleted: {}, savedAt: 0 });
}

export async function PUT(request) {
  if (!authorized(request)) return denied();
  let incoming;
  try { incoming = await request.json(); } catch { return json({ error: 'not JSON' }, 400); }
  if (!incoming || !Array.isArray(incoming.items)) return json({ error: 'not a Reel library' }, 400);

  const current = await readJSON(MAIN);
  const day = new Date().toISOString().slice(0, 10);
  const snap = !!(current && current.items && current.items.length && current.snapDay !== day);
  if (snap) await writeJSON(`snapshots/${day}.json`, current);

  const merged = mergeLibraries(current, incoming);
  merged.savedAt = Date.now();
  merged.snapDay = snap ? day : (current && current.snapDay) || null;
  await writeJSON(MAIN, merged);
  return json(merged);
}
