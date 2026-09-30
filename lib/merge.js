/* Two copies of the library become one without losing anything:
   per ad, the most recently edited version wins; a delete wins only over edits older than it. */
const TOMBSTONE_DAYS = 120;

export function mergeLibraries(a, b) {
  a = a || {}; b = b || {};
  const deleted = {};
  for (const d of [a.deleted || {}, b.deleted || {}])
    for (const [id, ts] of Object.entries(d)) deleted[id] = Math.max(deleted[id] || 0, +ts || 0);

  const byVid = new Map();
  for (const it of [...(a.items || []), ...(b.items || [])]) {
    if (!it || !it.vid || !it.id) continue;
    if (deleted[it.id] && deleted[it.id] >= (it.updated || 0)) continue;
    const had = byVid.get(it.vid);
    if (!had || (it.updated || 0) > (had.updated || 0)) byVid.set(it.vid, it);
  }
  const cutoff = Date.now() - TOMBSTONE_DAYS * 864e5;
  for (const id of Object.keys(deleted)) if (deleted[id] < cutoff) delete deleted[id];

  return {
    items: [...byVid.values()].sort((x, y) => (x.created || 0) - (y.created || 0)),
    deleted,
    lastBackup: [a.lastBackup, b.lastBackup].filter(Boolean).sort().pop() || null,
  };
}
