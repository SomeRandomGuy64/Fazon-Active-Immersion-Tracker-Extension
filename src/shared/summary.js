// Watched videos in the Track week's summary. Pure.
//
// While sync and the `summaryVideos` setting are on, every video with at least MIN_SECONDS of
// counted time in a Track week gets one Markdown line in that week's summary, under a
// "**Videos watched**" list the extension starts at the end of the summary (or finds again, so
// new lines go under the existing ones even after the user has written below it):
//   - [<title>](<url>) — <channel>
// Each video is posted once per week (state `summaryLog`), so a line the user deletes on the site
// stays deleted; a video whose ID is already anywhere in the summary is never added again.
//
// State:
//   summaryLog { from: '<weekKey>', base, key, weeks: { '<weekKey>': ['<platform>:<videoId>', …] } }
// `from` is the Track week the setting was turned on in (or the key changed): earlier weeks are
// never touched, the `from` week is filled in from the local per-video data.

import { dayStart, trackWeekKey, addDays } from './time.js';

export const MIN_SECONDS = 60;
export const HEADING = '**Videos watched**';
export const MAX_SUMMARY_RUNES = 10_000; // the API's limit

export const emptySummaryLog = () => ({ from: null, base: null, key: null, weeks: {} });

/** The Track weeks to look at now: the previous one (late reports) and the current one, ≥ from. */
export function summaryWeeks(log, now) {
  const cur = trackWeekKey(now);
  return [addDays(cur, -7), cur].filter((w) => log.from && w >= log.from);
}

/**
 * Videos with ≥ MIN_SECONDS in Track week `week`, from the per-day data (a user day goes to the
 * Track week its start lies in), in the order first watched, then most watched:
 * [{ vk, seconds, firstDay }].
 */
export function weekVideos(videoDays, week, settings) {
  const per = new Map();
  for (const day of Object.keys(videoDays).sort()) {
    if (trackWeekKey(dayStart(day, settings)) !== week) continue;
    for (const [vk, s] of Object.entries(videoDays[day])) {
      const v = per.get(vk);
      if (v) v.seconds += s;
      else per.set(vk, { vk, seconds: s, firstDay: day });
    }
  }
  return [...per.values()].filter((v) => v.seconds >= MIN_SECONDS)
    .sort((a, b) => (a.firstDay < b.firstDay ? -1 : a.firstDay > b.firstDay ? 1 : b.seconds - a.seconds));
}

/** Videos of `week` not posted yet. */
export function unposted(log, videoDays, week, settings) {
  const done = new Set(log.weeks[week] || []);
  return weekVideos(videoDays, week, settings).filter((v) => !done.has(v.vk));
}

/** Markdown-escape text for a link label / plain text (titles are untrusted). */
export function escapeMd(s) {
  return String(s).replace(/\s+/g, ' ').trim().replace(/[\\`*_[\]<>#|~!]/g, (c) => '\\' + c);
}

export function videoLine({ title, channel, url }) {
  const label = escapeMd(title || url);
  return `- [${label}](${url})` + (channel ? ` — ${escapeMd(channel)}` : '');
}

const runes = (s) => [...s].length;

/**
 * `summary` with `lines` added at the end of its "Videos watched" list (started at the end if
 * there is none), taking lines in order while the result stays within the API's limit.
 * Returns { summary, added } (added = how many lines fit).
 */
export function appendVideoLines(summary, lines) {
  const text = String(summary || '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
  const ls = text ? text.split('\n') : [];
  let h = ls.findIndex((l) => l.trim() === HEADING);
  if (h < 0) {
    if (ls.length) ls.push('');
    ls.push(HEADING);
    h = ls.length - 1;
  }
  let end = h + 1;
  while (end < ls.length && /^\s*[-*+] /.test(ls[end])) end++;
  let added = 0;
  for (const line of lines) {
    const next = [...ls.slice(0, end), line, ...ls.slice(end)];
    if (runes(next.join('\n')) > MAX_SUMMARY_RUNES) break;
    ls.splice(end, 0, line);
    end++;
    added++;
  }
  return { summary: added ? ls.join('\n') : text, added };
}
