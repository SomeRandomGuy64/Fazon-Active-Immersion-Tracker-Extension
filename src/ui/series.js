// Pure derivations from getStats.days ({'YYYY-MM-DD': seconds}) for the dashboard and popup:
// cumulative series, rolling averages, streaks, pace, milestones, week buckets, weekday profile.
// No DOM, no chrome.* — could move to src/shared/ unchanged if core ever needs them.
import { addDays, daysBetween, weekStartOf, keyToMs, msToKey, WD, MO } from './format.js';
import { trackWeekKey, trackWeekStart, trackWeekEnd } from '../shared/time.js';
import { DEFAULT_MILESTONES_H } from '../shared/milestones.js';

/** [{key, day, total}] from firstDay → today (every calendar day, zero days included). */
export function cumulative(days, firstDay, todayKey) {
    const out = [];
    if (!firstDay) return out;
    let total = 0;
    for (let k = firstDay; k <= todayKey; k = addDays(k, 1)) {
        const day = days[k] || 0;
        total += day;
        out.push({ key: k, day, total });
    }
    return out;
}

/** Mean seconds/day over the `n` days ending at `endKey` (inclusive), never before firstDay. */
export function windowAverage(days, endKey, n, firstDay) {
    if (!firstDay || endKey < firstDay) return 0;
    const span = Math.min(n, daysBetween(firstDay, endKey) + 1);
    let sum = 0;
    for (let i = 0; i < span; i++) sum += days[addDays(endKey, -i)] || 0;
    return span ? sum / span : 0;
}

/** Recent pace in seconds/day: the last 30 days ending today (shorter if the history is). */
export function pace(days, todayKey, firstDay, n = 30) { return windowAverage(days, todayKey, n, firstDay); }

/** {passed: [h…], next: h|null} for an all-time total in seconds, over ascending hour milestones. */
export function milestones(totalSeconds, list) {
    const ms = list && list.length ? list : DEFAULT_MILESTONES_H;
    const h = totalSeconds / 3600;
    return { passed: ms.filter((m) => m <= h), next: ms.find((m) => m > h) ?? null };
}

/** Day key on which `targetH` is reached at `paceSec`/day from `totalSec` on `todayKey`, or null. */
export function projectDate(totalSec, paceSec, targetH, todayKey) {
    if (!(paceSec > 0) || targetH == null) return null;
    const need = targetH * 3600 - totalSec;
    if (need <= 0) return todayKey;
    const n = Math.ceil(need / paceSec);
    return n > 365 * 30 ? null : addDays(todayKey, n);
}

/**
 * Where a goal {h, by} stands for an all-time `total` (s) on `todayKey`, at `paceSec`/day, over the
 * cumulative `series` (for the day it was reached). `by` is inclusive: today counts as a day left.
 * { state: 'reached'|'active'|'missed', pct, left (s), reachedOn, daysLeft, needSec (s/day),
 *   projected (key|null), early (days; < 0 = late, null if no projection) }
 */
export function goalStatus(goal, total, paceSec, todayKey, series = []) {
    const target = goal.h * 3600;
    const pct = Math.min(100, (total / target) * 100);
    const left = Math.max(0, target - total);
    if (left <= 0) {
        const hit = series.find((p) => p.total >= target);
        const reachedOn = hit ? hit.key : todayKey;
        return { state: 'reached', pct, left, reachedOn, early: daysBetween(reachedOn, goal.by), daysLeft: 0, needSec: 0, projected: reachedOn };
    }
    const projected = projectDate(total, paceSec, goal.h, todayKey);
    const early = projected ? daysBetween(projected, goal.by) : null;
    if (goal.by < todayKey) return { state: 'missed', pct, left, reachedOn: null, early, daysLeft: 0, needSec: null, projected };
    const daysLeft = daysBetween(todayKey, goal.by) + 1;
    return { state: 'active', pct, left, reachedOn: null, early, daysLeft, needSec: left / daysLeft, projected };
}

/** Current streak (days in a row with time, ending today — or yesterday if today is still 0) and the longest. */
export function streaks(days, todayKey) {
    const keys = Object.keys(days).filter((k) => days[k] > 0).sort();
    let longest = 0, run = 0, prev = null;
    for (const k of keys) {
        run = prev && addDays(prev, 1) === k ? run + 1 : 1;
        longest = Math.max(longest, run);
        prev = k;
    }
    let current = 0;
    let k = days[todayKey] > 0 ? todayKey : addDays(todayKey, -1);
    while (days[k] > 0) { current++; k = addDays(k, -1); }
    return { current, longest, activeToday: days[todayKey] > 0 };
}

/** The last `count` weeks (oldest first) ending with the week of today: [{start, end, seconds, days, partial}]. */
export function weeks(days, todayKey, weekStart, count) {
    const cur = weekStartOf(todayKey, weekStart);
    const out = [];
    for (let i = count - 1; i >= 0; i--) {
        const start = addDays(cur, -7 * i);
        let s = 0;
        for (let d = 0; d < 7; d++) s += days[addDays(start, d)] || 0;
        const end = addDays(start, 6);
        out.push({ start, end, seconds: s, partial: end > todayKey, daysElapsed: Math.min(7, daysBetween(start, todayKey) + 1) });
    }
    return out;
}

/** Rolling 7-day mean (seconds/day) for every day in [fromKey, toKey]. */
export function rolling7(days, fromKey, toKey, firstDay) {
    const out = [];
    for (let k = fromKey; k <= toKey; k = addDays(k, 1)) {
        out.push({ key: k, avg: firstDay && k >= firstDay ? windowAverage(days, k, 7, firstDay) : null });
    }
    return out;
}

/** Average seconds per weekday (0=Sun..6) over the days since firstDay (zero days count). */
export function weekdayProfile(days, firstDay, todayKey) {
    const sum = [0, 0, 0, 0, 0, 0, 0], n = [0, 0, 0, 0, 0, 0, 0];
    if (!firstDay) return sum;
    for (let k = firstDay; k <= todayKey; k = addDays(k, 1)) {
        const wd = new Date(keyToMs(k)).getUTCDay();
        sum[wd] += days[k] || 0;
        n[wd]++;
    }
    return sum.map((s, i) => (n[i] ? s / n[i] : 0));
}

/** Heatmap range: from the week of firstDay (padded back to at least `minWeeks`, at most `maxWeeks`) to today's week. */
export function heatRange(firstDay, todayKey, weekStart, minWeeks = 12, maxWeeks = 53) {
    const last = weekStartOf(todayKey, weekStart);
    let first = firstDay ? weekStartOf(firstDay, weekStart) : last;
    let n = daysBetween(first, last) / 7 + 1;
    if (n < minWeeks) n = minWeeks;
    if (n > maxWeeks) n = maxWeeks;
    first = addDays(last, -7 * (n - 1));
    return { first, last, weeks: n };
}

// ---------------- fazon.nexus Track (getStats.track.weeks) ----------------
// Track weeks run Sunday 03:00 UTC → Sunday, keyed by the Saturday before: week K's days are
// K+1 … K+7. Only weekly totals are known, so a week's hours are spread evenly over its days
// (over the days elapsed so far for the current week). Milestone crossings are therefore
// interpolated within the crossing week.

/** {days: {key: seconds}, firstDay} from Track weeks, plus `pendingSec` (unsynced) on today. */
export function trackDays(weeks, todayKey, pendingSec = 0) {
    const days = {};
    let firstDay = null;
    for (const w of weeks || []) {
        const start = addDays(w.week, 1);
        if (start > todayKey) continue;
        const n = Math.max(1, Math.min(7, daysBetween(start, todayKey) + 1));
        if (w.active > 0 && firstDay === null) firstDay = start;
        if (firstDay === null) continue;
        let left = Math.round(w.active);
        for (let i = 0; i < n; i++) {
            const part = i === n - 1 ? left : Math.round(w.active / n);
            left -= part;
            const k = addDays(start, i);
            days[k] = (days[k] || 0) + part;
        }
    }
    if (pendingSec > 0) {
        days[todayKey] = (days[todayKey] || 0) + pendingSec;
        if (firstDay === null || todayKey < firstDay) firstDay = todayKey;
    }
    return { days, firstDay };
}

/**
 * Track pace in seconds/day: active hours of the last 4 complete Track weeks ÷ 28 (fewer complete
 * weeks → over those; none → the current week over its elapsed days). Returns {pace, weeks}.
 */
export function trackPace(weeks, todayKey) {
    const list = (weeks || []).filter((w) => addDays(w.week, 1) <= todayKey);
    const complete = list.filter((w) => addDays(w.week, 7) < todayKey).slice(-4);
    if (complete.length) return { pace: complete.reduce((a, w) => a + w.active, 0) / (7 * complete.length), weeks: complete.length };
    const cur = list[list.length - 1];
    if (!cur) return { pace: 0, weeks: 0 };
    return { pace: cur.active / Math.max(1, daysBetween(addDays(cur.week, 1), todayKey) + 1), weeks: 0 };
}

/**
 * The current Track week against a Track-sourced weekly target, or null when it doesn't apply
 * (target not from Track, or no Track value — state ok, or error with cached weeks).
 * seconds = Track's current-week active (0 if that week isn't listed) + pendingSeconds (unsynced).
 * Also: the UTC window, and the pace expected by now (daily × elapsed days, fractional).
 */
export function trackWeekProgress(st, now = st && st.now) {
    const t = st && st.target, tr = st && st.track;
    if (!t || t.source !== 'track' || !t.weekly || !tr) return null;
    const hasValue = tr.state === 'ok' || (tr.state === 'error' && (tr.weeks || []).length > 0);
    if (!hasValue) return null;
    const key = trackWeekKey(now ?? Date.now());
    const cur = (tr.weeks || []).filter((w) => w.week === key).pop();
    const synced = cur ? cur.active || 0 : 0;
    const pending = tr.pendingSeconds || 0;
    const startMs = trackWeekStart(key), endMs = trackWeekEnd(key);
    const elapsedDays = Math.min(7, Math.max(0, ((now ?? Date.now()) - startMs) / 864e5));
    const daily = t.daily || t.weekly / 7;
    return {
        key, startMs, endMs, synced, pending, seconds: synced + pending, target: t.weekly,
        expected: daily * elapsedDays, stale: tr.state === 'error',
    };
}

/** "Sun 11 Oct 03:00 → Sun 18 Oct 03:00 UTC" for a Track week. */
export function trackWeekWindow(p) {
    const f = (ms) => { const d = new Date(ms); return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MO[d.getUTCMonth()]} 03:00`; };
    return `${f(p.startMs)} → ${f(p.endMs)} UTC`;
}

export { keyToMs, msToKey };
