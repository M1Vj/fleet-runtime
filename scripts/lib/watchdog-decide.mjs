export function decideStale(lastRunUtc, nowMs = Date.now(), thresholdMs = 90 * 60 * 1000) {
  if (!lastRunUtc) return { stale: true, ageMinutes: null, reason: "no-heartbeat" };
  const last = Date.parse(lastRunUtc);
  if (Number.isNaN(last)) return { stale: true, ageMinutes: null, reason: "bad-heartbeat" };
  const ageMinutes = Math.round(((nowMs - last) / 60000) * 10) / 10;
  return { stale: ageMinutes * 60000 > thresholdMs, ageMinutes, reason: ageMinutes * 60000 > thresholdMs ? "stale" : "fresh" };
}
