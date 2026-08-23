const DAY_MS = 24 * 60 * 60 * 1000;

export function overlap(a, b) {
  const sa = new Set((a.files || []).map((f) => f.filename));
  return (b.files || []).some((f) => sa.has(f.filename));
}

export function findSuperseded(prEntries, nowMs = Date.now(), minAgeDays = 3) {
  const byRepo = {};
  for (const e of prEntries) {
    if (!e.repo || !e.number || !e.user === false) continue;
    if (e.state !== "open" || !e.draft) continue;
    (byRepo[e.repo] = byRepo[e.repo] || []).push(e);
  }
  const closed = [];
  for (const repo of Object.keys(byRepo)) {
    const list = byRepo[repo].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const newer = list[i];
        const older = list[j];
        const ageDays = (nowMs - new Date(older.created_at).getTime()) / DAY_MS;
        if (ageDays < minAgeDays) continue;
        if (overlap(newer, older)) {
          closed.push({ repo, number: older.number, supersededBy: newer.number, ageDays: Math.round(ageDays) });
        }
      }
    }
  }
  return closed;
}

export function isStale(prEntry, nowMs = Date.now(), maxAgeDays = 14) {
  if (!prEntry || prEntry.state !== "open" || !prEntry.draft) return false;
  return (nowMs - new Date(prEntry.created_at).getTime()) > maxAgeDays * DAY_MS;
}
