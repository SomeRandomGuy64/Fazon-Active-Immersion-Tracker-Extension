// Display helpers for durations. Pure: safe to import from the popup, dashboard and background.
// All inputs are seconds.

const pad2 = (n) => String(n).padStart(2, '0');

/** 3725 → '1:02:05' (hours are not wrapped at 24: 90000 → '25:00:00'). */
export function formatHMS(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  return `${h}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

/** 3725 → '1h 02m'; under an hour → '2m'; under a minute → '0m'. */
export function formatHM(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${pad2(m)}m` : `${m}m`;
}

/** Compact form for chart labels / tooltips: '1.5h', '45m', '30s'. */
export function formatShort(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s >= 3600) return `${(s / 3600).toFixed(s >= 36000 ? 0 : 1).replace(/\.0$/, '')}h`;
  if (s >= 60) return `${Math.floor(s / 60)}m`;
  return `${s}s`;
}

/** Seconds → decimal hours, rounded to `digits` decimals (as a number). */
export function toHours(seconds, digits = 2) {
  const f = 10 ** digits;
  return Math.round((Number(seconds) || 0) / 3600 * f) / f;
}

/** Seconds → whole hundredths of an hour (36 s each), floored. fazon.nexus Track's unit. */
export const toHundredthsFloor = (seconds) => Math.floor(Math.max(0, Number(seconds) || 0) / 36);

/** Seconds → whole hundredths of an hour, rounded to nearest (how the Track API rounds). */
export const toHundredthsRound = (seconds) => Math.round((Number(seconds) || 0) / 36);

/** Hundredths of an hour → the API's decimal string: 7 → '0.07', 150 → '1.50'. */
export function hundredthsToDecimal(h) {
  const sign = h < 0 ? '-' : '';
  const a = Math.abs(Math.trunc(h));
  return `${sign}${Math.floor(a / 100)}.${pad2(a % 100)}`;
}

/** Relative time for "last synced 2 min ago" style labels. `now` and `then` in epoch ms. */
export function formatAgo(then, now = Date.now()) {
  if (!then) return 'never';
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
