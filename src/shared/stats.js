// Statistics over stored day totals. Pure.
//
// `days` is the stored shape: { 'YYYY-MM-DD': { <platformId>: seconds } }.

import {
  addDays, addMonths, daysBetween, dayKey, isDayKey, MEAN_MONTH_DAYS, monthKeyOf, monthLabel,
  nextDayStart, weekdayOf, weekStartKey, WEEKDAYS_SHORT,
} from './time.js';
import { channelTotals } from './channels.js';

const sumValues = (o) => Object.values(o || {}).reduce((a, b) => a + (Number(b) || 0), 0);

/**
 * Daily average = total ÷ days from the first day with time through today (inclusive).
 * Monthly average = daily average × mean month length, so a first partial month never counts
 * as a whole month (start on 30 June with 4 h → 2 days at 2 h/day → ~60.9 h/month).
 */
export function averages(totalSeconds, firstDay, todayKey) {
  if (!firstDay || !totalSeconds) return { dailyAverage: 0, monthlyAverage: 0, daysTracked: 0 };
  const span = Math.max(1, daysBetween(firstDay, todayKey) + 1);
  const dailyAverage = totalSeconds / span;
  return {
    dailyAverage: Math.round(dailyAverage),
    monthlyAverage: Math.round(dailyAverage * MEAN_MONTH_DAYS),
    daysTracked: span,
  };
}

/**
 * Build the `getStats` payload (without `settings` / `sync`).
 * @param {object} p
 * @param {object} p.days       stored day totals
 * @param {number} p.now        epoch ms
 * @param {object} p.settings   resetTime / timezone / weekStart
 * @param {object} p.platformNames  { youtube: 'YouTube' }
 * @param {object} [p.live]     uncredited seconds of a session running right now: { youtube: 3 }
 * @param {object} [p.liveVideos]  the same per video key: { 'youtube:<id>': 3 }
 * @param {object} [p.channelData] { videoDays, videos, channels, aliases } → adds `channels`
 */
export function computeStats({ days = {}, now, settings = {}, platformNames = {}, live = {}, liveVideos = {}, channelData = null }) {
  const todayKey = dayKey(now, settings);
  const weekKey = weekStartKey(todayKey, settings.weekStart ?? 0);
  const monthKey = monthKeyOf(todayKey);

  // Fold live (not yet credited) seconds into today so counters tick smoothly.
  const merged = {};
  for (const [k, per] of Object.entries(days)) if (isDayKey(k)) merged[k] = { ...per };
  for (const [pid, s] of Object.entries(live)) {
    if (s > 0) (merged[todayKey] ??= {})[pid] = (merged[todayKey][pid] || 0) + s;
  }

  const totals = {};
  const byPlatform = {};
  const ids = new Set(Object.keys(platformNames));
  for (const per of Object.values(merged)) for (const pid of Object.keys(per)) ids.add(pid);
  for (const pid of ids) {
    byPlatform[pid] = { name: platformNames[pid] || pid, today: 0, week: 0, month: 0, allTime: 0 };
  }

  let today = 0, week = 0, month = 0, allTime = 0;
  let firstDay = null;
  for (const [k, per] of Object.entries(merged)) {
    const s = sumValues(per);
    if (s <= 0) continue;
    totals[k] = s;
    if (firstDay === null || k < firstDay) firstDay = k;
    const inToday = k === todayKey;
    const inWeek = k >= weekKey && k <= todayKey;
    const inMonth = monthKeyOf(k) === monthKey;
    allTime += s;
    if (inToday) today += s;
    if (inWeek) week += s;
    if (inMonth) month += s;
    for (const [pid, v] of Object.entries(per)) {
      const b = byPlatform[pid];
      b.allTime += v;
      if (inToday) b.today += v;
      if (inWeek) b.week += v;
      if (inMonth) b.month += v;
    }
  }

  // A first day after today can only come from a clock / reset change; ignore it for the span.
  const spanStart = firstDay && firstDay <= todayKey ? firstDay : todayKey;
  const { dailyAverage, monthlyAverage, daysTracked } = averages(allTime, firstDay && spanStart, todayKey);

  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const key = addDays(todayKey, -i);
    last7.push({ key, label: i === 0 ? 'Today' : WEEKDAYS_SHORT[weekdayOf(key)], seconds: totals[key] || 0 });
  }

  const months = [];
  if (firstDay) {
    const byMonth = {};
    for (const [k, s] of Object.entries(totals)) byMonth[monthKeyOf(k)] = (byMonth[monthKeyOf(k)] || 0) + s;
    const first = monthKeyOf(spanStart);
    for (let m = first, guard = 0; m <= monthKey && guard < 1200; m = addMonths(m, 1), guard++) {
      months.push({ key: m, label: monthLabel(m), seconds: byMonth[m] || 0 });
    }
  }

  const channels = channelData
    ? channelTotals({
      ...channelData, days: merged, liveVideos, todayKey,
      windows: (k) => ({ today: k === todayKey, week: k >= weekKey && k <= todayKey, month: monthKeyOf(k) === monthKey }),
    })
    : [];

  return {
    now, todayKey,
    today, week, month, allTime,
    dailyAverage, monthlyAverage,
    firstDay,
    days: totals,
    byPlatform,
    last7,
    months,
    channels,
    // Extras (not required by the protocol, handy for the UI):
    weekStartKey: weekKey,
    daysTracked,
    nextResetAt: nextDayStart(now, settings),
  };
}
