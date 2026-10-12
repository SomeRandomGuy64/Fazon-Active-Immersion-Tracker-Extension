// Calendar math shared by the background and the UI. Pure: no DOM, no chrome.* APIs.
//
// Two calendars live here:
//  - the user's calendar: days that start at a configurable reset time ("03:00") in a
//    configurable timezone ('UTC', 'local' = the browser's zone, or an IANA name). A day's key is
//    the calendar date (in that zone) on which the day window starts.
//  - the fazon.nexus Track calendar: weeks from Sunday 03:00 UTC to the next Sunday 03:00 UTC,
//    keyed by the Saturday before. Fixed, independent of the user's settings.
//
// Day keys are 'YYYY-MM-DD' strings; date arithmetic on them is done in UTC so it is DST-free.

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const MEAN_MONTH_DAYS = 30.436875; // mean Gregorian month: 365.2425 / 12

export const DEFAULT_RESET_TIME = '03:00';
export const DEFAULT_TIMEZONE = 'UTC';

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// ---- reset time / timezone ----

/** 'HH:MM' → minutes after midnight; null if malformed. */
export function parseResetTime(s) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(s ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** The IANA zone to hand to Intl for a timezone setting ('local' → the runtime's zone). */
export function resolveTimeZone(tz) {
  if (!tz || tz === 'local') return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return tz;
}

/** True if Intl knows the zone ('UTC', 'local' and IANA names). */
export function isValidTimeZone(tz) {
  if (tz === 'local' || tz === 'UTC') return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map();
function formatter(zone) {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(zone, f);
  }
  return f;
}

/** Wall-clock fields of the instant `ms` in `zone` (a timezone setting). */
export function zonedParts(ms, tz = 'UTC') {
  const zone = resolveTimeZone(tz);
  if (zone === 'UTC') {
    const d = new Date(ms);
    return {
      year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
      hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(),
    };
  }
  const out = {};
  for (const p of formatter(zone).formatToParts(new Date(ms))) {
    if (p.type !== 'literal' && p.type !== 'era' && p.type !== 'dayPeriod') out[p.type] = Number(p.value);
  }
  if (out.hour === 24) out.hour = 0; // very old engines ignore hourCycle
  return out;
}

/** The zone's UTC offset at instant `ms`, in ms (UTC+9 → +32400000). */
export function zoneOffsetMs(ms, tz = 'UTC') {
  const p = zonedParts(ms, tz);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant at which the wall clock in `tz` reads `key` `minutes` (minutes after midnight).
 * Two-pass offset correction; for a wall time skipped by a DST jump it returns the instant just
 * after the jump, for a repeated one the first occurrence.
 */
export function wallTimeToEpoch(key, minutes, tz = 'UTC') {
  const { y, m, d } = splitKey(key);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  const t1 = guess - zoneOffsetMs(guess, tz);
  const t2 = guess - zoneOffsetMs(t1, tz);
  if (t1 === t2) return t1;
  // Offsets disagree: we are near a transition. Prefer the earlier candidate if its wall time is
  // right (repeated hour); otherwise the later one (skipped hour → first instant after the gap).
  const [lo, hi] = t1 < t2 ? [t1, t2] : [t2, t1];
  const wall = (t) => {
    const p = zonedParts(t, tz);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  };
  if (wall(lo) === guess) return lo;
  if (wall(hi) === guess) return hi;
  // Skipped wall time: the answer is the transition itself, the first instant whose wall
  // clock is past the target. Binary-search it between the two candidates.
  let a = lo, b = hi;
  while (b - a > 1) {
    const mid = Math.floor((a + b) / 2);
    if (wall(mid) >= guess) b = mid; else a = mid;
  }
  return b;
}

// ---- day keys ----

export function splitKey(key) {
  const m = KEY_RE.exec(key);
  if (!m) throw new RangeError(`bad day key ${key}`);
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

export function isDayKey(key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) return false;
  const { y, m, d } = splitKey(key);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function makeKey(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** UTC midnight of a key, as epoch ms (only for arithmetic on keys, not a real instant). */
export function keyToUTC(key) {
  const { y, m, d } = splitKey(key);
  return Date.UTC(y, m - 1, d);
}

export function addDays(key, n) {
  const { y, m, d } = splitKey(key);
  return makeKey(y, m, d + n);
}

/** Whole days from key a to key b (b − a). */
export function daysBetween(a, b) {
  return Math.round((keyToUTC(b) - keyToUTC(a)) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(key) {
  return new Date(keyToUTC(key)).getUTCDay();
}

export const monthKeyOf = (key) => key.slice(0, 7);

/** 'YYYY-MM' → 'Jul 2026'. */
export function monthLabel(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return `${MONTHS_SHORT[m - 1]} ${y}`;
}

export function addMonths(monthKey, n) {
  const [y, m] = monthKey.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}`;
}

/** Normalised day settings from a settings object (missing / bad values → defaults). */
export function daySettings(settings = {}) {
  const minutes = parseResetTime(settings.resetTime) ?? parseResetTime(DEFAULT_RESET_TIME);
  const timezone = settings.timezone && isValidTimeZone(settings.timezone) ? settings.timezone : DEFAULT_TIMEZONE;
  return { minutes, timezone };
}

/**
 * The user's day key for instant `ms`: the zone's calendar date of (wall time − reset). So with
 * reset 03:00, 02:59 on the 5th belongs to the 4th and 03:00 starts the 5th. Using the wall clock
 * keeps this DST-safe: the day still starts when the clock reads the reset time.
 */
export function dayKey(ms, settings) {
  const { minutes, timezone } = daySettings(settings);
  const p = zonedParts(ms, timezone);
  const wall = p.hour * 60 + p.minute;
  return makeKey(p.year, p.month, p.day - (wall < minutes ? 1 : 0));
}

/** Start instant (epoch ms) of the day window with key `key`. */
export function dayStart(key, settings) {
  const { minutes, timezone } = daySettings(settings);
  return wallTimeToEpoch(key, minutes, timezone);
}

/** The first instant after `ms` that belongs to a later day than `ms` does. */
export function nextDayStart(ms, settings) {
  const key = dayKey(ms, settings);
  const next = addDays(key, 1);
  const cand = dayStart(next, settings);
  if (cand > ms && dayKey(cand, settings) !== key && dayKey(cand - 1, settings) === key) return cand;
  // Odd DST edge (e.g. a reset inside a repeated hour): binary-search the boundary.
  let lo = ms, hi = ms + 50 * HOUR_MS;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (dayKey(mid, settings) === key) lo = mid; else hi = mid;
  }
  return hi;
}

/** First day key of the week containing `key`, weeks starting on `weekStart` (0=Sun … 6=Sat). */
export function weekStartKey(key, weekStart = 1) {
  const ws = ((Number(weekStart) % 7) + 7) % 7;
  return addDays(key, -((weekdayOf(key) - ws + 7) % 7));
}

// ---- fazon.nexus Track weeks ----

export const TRACK_OFFSET_MS = 3 * HOUR_MS; // weeks start Sunday 03:00 UTC

/**
 * The Track week key (Saturday label) of the week containing instant `ms`. Mirrors the Python
 * `week_key` in the API docs: shift back 3 h, go back to that date's Sunday, then one more day.
 */
export function trackWeekKey(ms) {
  const t = new Date(ms - TRACK_OFFSET_MS);
  const sinceSunday = t.getUTCDay();
  return makeKey(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate() - sinceSunday - 1);
}

/** Start instant of Track week `key` (the Sunday after the Saturday key, 03:00 UTC). */
export function trackWeekStart(key) {
  return keyToUTC(key) + DAY_MS + TRACK_OFFSET_MS;
}

export function trackWeekEnd(key) {
  return trackWeekStart(key) + 7 * DAY_MS;
}

/**
 * Split [start, end) into pieces that each lie in one user day and one Track week:
 * [{start, end, dayKey, trackWeek}].
 */
export function splitInterval(start, end, settings) {
  const out = [];
  let a = start;
  while (a < end) {
    const day = dayKey(a, settings);
    const week = trackWeekKey(a);
    let b = end;
    if (dayKey(end - 1, settings) !== day) b = Math.min(b, nextDayStart(a, settings));
    if (trackWeekKey(end - 1) !== week) b = Math.min(b, trackWeekEnd(week));
    if (b <= a) b = end; // never loop forever on a pathological zone
    out.push({ start: a, end: b, dayKey: day, trackWeek: week });
    a = b;
  }
  return out;
}
