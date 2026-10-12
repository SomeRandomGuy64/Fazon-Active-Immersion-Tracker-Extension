// Formatting for the UI, in fazon.nexus Track's vocabulary: totals as "40h 24m", decimals as
// "4.2 h", dates in fixed English ("Sat 10 Oct 2026" — Intl's en-GB output varies: "Sept").
// Seconds appear only on live counters. They only format — they never decide what a day/week is.
import { formatHMS } from '../shared/format.js';

const pad2 = (n) => String(n).padStart(2, '0');

/** Live counter: 4521 → "1:15:21", 754 → "12:34". */
export function clock(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    return s >= 3600 ? formatHMS(s) : `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}
export { formatHMS as hms };

/** Totals: 145440 → "40h 24m", 14400 → "4h", 2520 → "42m", 30 → "<1m", 0 → "0m". */
export function hm(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    if (s > 0 && s < 60) return '<1m';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (!h) return `${m}m`;
    return m ? `${h.toLocaleString('en')}h ${pad2(m)}m` : `${h.toLocaleString('en')}h`;
}

/** Whole hours for axes/milestones: 1000 → "1,000 h". */
export function hLabel(hours) { return `${Math.round(hours).toLocaleString('en')} h`; }

/** Decimal hours: 15120 → "4.2 h" (digits default 1). */
export function hDec(seconds, digits = 1) {
    return `${(Math.max(0, Number(seconds) || 0) / 3600).toFixed(digits)} h`;
}

/** Compact chart label: 25200 → "7h", 9000 → "2.5h", 2520 → "42m", 0 → "". */
export function short(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    if (!s) return '';
    if (s >= 3600) { const h = s / 3600; return (h >= 10 ? Math.round(h) : Math.round(h * 10) / 10) + 'h'; }
    if (s >= 60) return Math.floor(s / 60) + 'm';
    return '<1m';
}

// ---- calendar keys (UTC arithmetic only, never local time) ----
export function keyToMs(key) { return Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10)); }
export function msToKey(ms) { return new Date(ms).toISOString().slice(0, 10); }
export function keyToDate(key) { return new Date(keyToMs(key)); }
export function addDays(key, n) { return msToKey(keyToMs(key) + n * 864e5); }
export function daysBetween(a, b) { return Math.round((keyToMs(b) - keyToMs(a)) / 864e5); }
export function weekdayOf(key) { return new Date(keyToMs(key)).getUTCDay(); }
/** First day (key) of the week containing `key`, weeks starting on `weekStart` (0=Sun). */
export function weekStartOf(key, weekStart) { return addDays(key, -((weekdayOf(key) - weekStart + 7) % 7)); }

export const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WD_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MO_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function parts(key) { const d = new Date(keyToMs(key)); return { wd: d.getUTCDay(), d: d.getUTCDate(), m: d.getUTCMonth(), y: d.getUTCFullYear() }; }
/** "Sat 10 Oct 2026" */
export function longDay(key) { const p = parts(key); return `${WD[p.wd]} ${p.d} ${MO[p.m]} ${p.y}`; }
/** "10 Oct" (+ " 2026" when withYear) */
export function shortDay(key, withYear = false) { const p = parts(key); return `${p.d} ${MO[p.m]}${withYear ? ' ' + p.y : ''}`; }
/** "Oct" */
export function monthAbbr(key) { return MO[parts(key).m]; }
export function monthName(key) { return MO_LONG[parts(key).m]; }
export function weekdayName(i, long = false) { return (long ? WD_LONG : WD)[((i % 7) + 7) % 7]; }

/** epoch ms → "10 Oct 2026, 14:05" (local time, fixed English). */
export function dateTime(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    return `${d.getDate()} ${MO[d.getMonth()]} ${d.getFullYear()}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
/** epoch ms → "10 Oct 2026" (local). */
export function dateOnly(ms) {
    const d = new Date(ms);
    return `${d.getDate()} ${MO[d.getMonth()]} ${d.getFullYear()}`;
}

/** Relative time for "last synced": "just now", "3 min ago", "2 h ago", then a date. */
export function ago(ms, now = Date.now()) {
    if (!ms) return 'never';
    const d = Math.max(0, now - ms) / 1000;
    if (d < 45) return 'just now';
    if (d < 3600) return `${Math.round(d / 60)} min ago`;
    if (d < 86400) return `${Math.round(d / 3600)} h ago`;
    return dateTime(ms);
}

/** "fz_ab12…" — never the whole key. */
export function maskKey(key) { return key ? key.slice(0, 7) + '…' : ''; }

export function plural(n, one, many = one + 's') { return `${n.toLocaleString('en')} ${n === 1 ? one : many}`; }
