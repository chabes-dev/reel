/* Reel's storage on Cloudflare: rows in the shared D1 database "study-apps", table docs, app = 'reel'.
   Same file names as the old Vercel Blob store (library.json, snapshots/…, thumbs/<id>.jpg, usage/YYYY-MM.json). */
const APP = 'reel';
let DB = null;
export const useDB = db => { DB = db; };

export async function readJSON(key) {
  const row = await DB.prepare('SELECT body FROM docs WHERE app = ?1 AND key = ?2').bind(APP, key).first();
  return row && row.body ? JSON.parse(row.body) : null;
}
export async function writeJSON(key, doc) {
  await DB.prepare(
    'INSERT INTO docs (app, key, body, bin, updated_at) VALUES (?1, ?2, ?3, NULL, ?4) ON CONFLICT(app, key) DO UPDATE SET body = excluded.body, bin = NULL, updated_at = excluded.updated_at'
  ).bind(APP, key, JSON.stringify(doc), Date.now()).run();
}
export async function readBin(key) {
  const row = await DB.prepare('SELECT bin FROM docs WHERE app = ?1 AND key = ?2').bind(APP, key).first();
  return row && row.bin ? new Uint8Array(row.bin) : null;
}
export async function writeBin(key, bytes) {
  await DB.prepare(
    'INSERT INTO docs (app, key, body, bin, updated_at) VALUES (?1, ?2, NULL, ?3, ?4) ON CONFLICT(app, key) DO UPDATE SET body = NULL, bin = excluded.bin, updated_at = excluded.updated_at'
  ).bind(APP, key, bytes, Date.now()).run();
}
