import { assertEquals, assert, assertThrows } from './assert.js';
import { computeStats, averages } from '../src/shared/stats.js';
import { claim, emptyCreditState, KEEP_MS } from '../src/shared/credit.js';
import {
  addToLedger, planSync, patchBody, markSynced, pruneLedger, pendingSeconds, CLOSE_GRACE_MS,
} from '../src/shared/ledger.js';
import { formatHMS, formatHM, hundredthsToDecimal, toHundredthsFloor } from '../src/shared/format.js';
import { trackWeekEnd } from '../src/shared/time.js';
import { applySettingsPatch, normaliseApiBase, apiOriginPattern, DEFAULT_SETTINGS } from '../src/background/settings.js';
import { applyImport, exportState, detectFormat } from '../src/background/datafmt.js';
import { defaults } from '../src/background/store.js';
import { platformForUrl, matchesPattern } from '../src/platforms/index.js';
import { milestones } from '../src/ui/series.js';

const T = (iso) => Date.parse(iso);
const H = 3600;

// ---- averages ----

Deno.test('monthly average: starting on 30 June with 4 h is 2 days at 2 h/day, not a 4 h month', () => {
  const now = T('2026-07-01T12:00:00Z'); // day key 2026-07-01 (reset 03:00 UTC)
  const s = computeStats({ days: { '2026-06-30': { youtube: 4 * H } }, now, settings: {} });
  assertEquals(s.todayKey, '2026-07-01');
  assertEquals(s.firstDay, '2026-06-30');
  assertEquals(s.daysTracked, 2);
  assertEquals(s.dailyAverage, 2 * H);
  assertEquals(s.monthlyAverage, Math.round(2 * H * 30.436875)); // ≈ 60.9 h
  assert(s.monthlyAverage !== 4 * H);
  assertEquals(s.months.map((m) => [m.key, m.label, m.seconds]), [['2026-06', 'Jun 2026', 4 * H], ['2026-07', 'Jul 2026', 0]]);
});

Deno.test('averages: empty and single day', () => {
  assertEquals(averages(0, null, '2026-07-01'), { dailyAverage: 0, monthlyAverage: 0, daysTracked: 0 });
  assertEquals(averages(H, '2026-07-01', '2026-07-01').dailyAverage, H);
});

Deno.test('stats: today / week / month / last7 / byPlatform', () => {
  const days = {
    '2026-10-05': { youtube: 100 },             // Monday (week start)
    '2026-10-04': { youtube: 50 },              // Sunday before: previous week
    '2026-10-11': { youtube: 30, netflix: 20 }, // today (Sunday)
    '2026-09-30': { youtube: 7 },
  };
  const s = computeStats({ days, now: T('2026-10-11T12:00:00Z'), settings: { weekStart: 1 }, platformNames: { youtube: 'YouTube' } });
  assertEquals(s.today, 50);
  assertEquals(s.week, 150);
  assertEquals(s.month, 200);
  assertEquals(s.allTime, 207);
  assertEquals(s.byPlatform.youtube, { name: 'YouTube', today: 30, week: 130, month: 180, allTime: 187 });
  assertEquals(s.byPlatform.netflix.name, 'netflix');
  assertEquals(s.last7.map((d) => d.label), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Today']);
  assertEquals(s.last7[0], { key: '2026-10-05', label: 'Mon', seconds: 100 });
  assertEquals(s.days['2026-10-11'], 50);
  // Sunday-start weeks: only today.
  assertEquals(computeStats({ days, now: T('2026-10-11T12:00:00Z'), settings: { weekStart: 0 } }).week, 50);
});

Deno.test('stats: live seconds are folded into today', () => {
  const s = computeStats({ days: {}, now: T('2026-10-11T12:00:00Z'), settings: {}, live: { youtube: 4 } });
  assertEquals([s.today, s.allTime, s.firstDay], [4, 4, '2026-10-11']);
});

// ---- double counting ----

Deno.test('credit: overlapping reports from two tabs count once', () => {
  const now = 1_000_000_000;
  let st = emptyCreditState();
  let r = claim(st, now - 10_000, now - 5_000, now); // tab A: 5 s
  assertEquals(r.pieces, [[now - 10_000, now - 5_000]]);
  st = r.state;
  r = claim(st, now - 8_000, now - 2_000, now); // tab B overlaps 3 s of it
  assertEquals(r.pieces, [[now - 5_000, now - 2_000]]);
  st = r.state;
  r = claim(st, now - 10_000, now - 2_000, now); // a re-sent heartbeat: nothing new
  assertEquals(r.pieces, []);
  r = claim(r.state, now - 12_000, now, now); // covers a hole on each side
  assertEquals(r.pieces, [[now - 12_000, now - 10_000], [now - 2_000, now]]);
  assertEquals(r.state.spans, [[now - 12_000, now]]);
});

Deno.test('credit: future and ancient reports are clamped', () => {
  const now = 10 * KEEP_MS;
  let r = claim(emptyCreditState(), now, now + 60_000, now);
  assertEquals(r.pieces, [[now, now + 5_000]]);
  r = claim(r.state, 0, 1000, now + 1);
  assertEquals(r.pieces, []); // before the horizon
  assert(r.state.horizon > 0);
});

// ---- sync ledger ----

Deno.test('ledger: floors to 36 s hundredths and carries the remainder', () => {
  const now = T('2026-10-12T12:00:00Z');
  const L = {};
  addToLedger(L, '2026-10-10', 'YouTube - Monday', 100); // 2 hundredths + 28 s
  let plan = planSync(L, now);
  assertEquals(plan, [{ week: '2026-10-10', entries: [{ subcat: 'YouTube - Monday', hundredths: 2 }] }]);
  assertEquals(patchBody(plan[0]), { entries: [{ category: 'active', subcat: 'YouTube - Monday', add: '0.02' }] });
  markSynced(L, plan[0]);
  assertEquals(L['2026-10-10']['YouTube - Monday'], { credited: 100, synced: 72 });
  assertEquals(pendingSeconds(L), 28);
  assertEquals(planSync(L, now), []); // 28 s: nothing to send yet
  addToLedger(L, '2026-10-10', 'YouTube - Monday', 10); // 38 s pending → 1 hundredth, 2 s carried
  plan = planSync(L, now);
  assertEquals(plan[0].entries, [{ subcat: 'YouTube - Monday', hundredths: 1 }]);
  markSynced(L, plan[0]);
  assertEquals(pendingSeconds(L), 2);
});

Deno.test('ledger: a closed week rounds its last remainder and is pruned', () => {
  const L = {};
  addToLedger(L, '2026-10-03', 'YouTube - Friday', 36 * 5 + 20); // 5 hundredths + 20 s
  const open = trackWeekEnd('2026-10-03') - 1;
  assertEquals(planSync(L, open)[0].entries[0].hundredths, 5);
  const closed = trackWeekEnd('2026-10-03') + CLOSE_GRACE_MS;
  const plan = planSync(L, closed);
  assertEquals(plan[0].entries[0].hundredths, 6); // 20 s rounds up to a hundredth
  markSynced(L, plan[0]);
  pruneLedger(L, closed);
  assertEquals(L, {});
});

Deno.test('ledger: one PATCH per week, split at 100 entries', () => {
  const L = {};
  addToLedger(L, '2026-10-03', 'A', 3600);
  addToLedger(L, '2026-10-10', 'B', 3600);
  addToLedger(L, '2026-10-10', 'C', 3600);
  for (let i = 0; i < 120; i++) addToLedger(L, '2026-09-26', `X${i}`, 36);
  const plans = planSync(L, T('2026-10-12T00:00:00Z'));
  assertEquals(plans.map((p) => [p.week, p.entries.length]), [['2026-09-26', 100], ['2026-09-26', 20], ['2026-10-03', 1], ['2026-10-10', 2]]);
});

// ---- formatting ----

Deno.test('format helpers', () => {
  assertEquals(formatHMS(3725), '1:02:05');
  assertEquals(formatHMS(90000), '25:00:00');
  assertEquals(formatHMS(0), '0:00:00');
  assertEquals(formatHM(3725), '1h 02m');
  assertEquals(formatHM(125), '2m');
  assertEquals(hundredthsToDecimal(7), '0.07');
  assertEquals(hundredthsToDecimal(150), '1.50');
  assertEquals(toHundredthsFloor(71), 1);
});

// ---- settings ----

Deno.test('settings validation', () => {
  const s = applySettingsPatch(DEFAULT_SETTINGS, { resetTime: '4:05', timezone: 'Asia/Tokyo', weekStart: '0', countMuted: 1 });
  assertEquals([s.resetTime, s.timezone, s.weekStart, s.countMuted], ['04:05', 'Asia/Tokyo', 0, true]);
  assertThrows(() => applySettingsPatch(DEFAULT_SETTINGS, { resetTime: '25:00' }), /HH:MM/);
  assertThrows(() => applySettingsPatch(DEFAULT_SETTINGS, { timezone: 'Mars/Base' }), /timezone/);
  assertThrows(() => applySettingsPatch(DEFAULT_SETTINGS, { weekStart: 7 }), /weekStart/);
  assertEquals(normaliseApiBase('http://localhost:8091/'), 'http://localhost:8091');
  assertEquals(normaliseApiBase(''), 'https://api.fazon.nexus');
  assertThrows(() => normaliseApiBase('http://example.com'), /https/);
  assertEquals(apiOriginPattern('http://127.0.0.1:8091'), 'http://127.0.0.1/*');
});

Deno.test('settings: milestones are whole hours, deduplicated and sorted; empty means defaults', () => {
  assertEquals(DEFAULT_SETTINGS.milestonesH, [100, 250, 500, 1000, 1500, 2000, 3000, 5000, 10000]);
  assertEquals(applySettingsPatch(DEFAULT_SETTINGS, { milestonesH: '500, 50 50;2000h' }).milestonesH, [50, 500, 2000]);
  assertEquals(applySettingsPatch(DEFAULT_SETTINGS, { milestonesH: [300, 100] }).milestonesH, [100, 300]);
  assertEquals(applySettingsPatch({ milestonesH: [7] }, { milestonesH: null }).milestonesH, DEFAULT_SETTINGS.milestonesH);
  assertEquals(applySettingsPatch(DEFAULT_SETTINGS, { milestonesH: ' ' }).milestonesH, DEFAULT_SETTINGS.milestonesH);
  assertThrows(() => applySettingsPatch(DEFAULT_SETTINGS, { milestonesH: '100, 2.5' }), /whole hours/);
  assertThrows(() => applySettingsPatch(DEFAULT_SETTINGS, { milestonesH: '0' }), /whole hours/);
  assertThrows(() => applySettingsPatch(DEFAULT_SETTINGS, { milestonesH: 'abc' }), /whole hours/);
  assertThrows(() => applySettingsPatch(DEFAULT_SETTINGS, { milestonesH: [] }), /at least one/);
  assertThrows(() => applySettingsPatch(DEFAULT_SETTINGS, { milestonesH: Array.from({ length: 51 }, (_, i) => i + 1) }), /at most 50/);
});

Deno.test('series: milestones() uses the given list, else the defaults', () => {
  assertEquals(milestones(120 * H, [50, 100, 200]), { passed: [50, 100], next: 200 });
  assertEquals(milestones(120 * H), { passed: [100], next: 250 });
  assertEquals(milestones(300 * H, [50, 100, 200]), { passed: [50, 100, 200], next: null });
});

// ---- import / export ----

Deno.test('Mikan import: adds days, re-import never double-counts, newer export adds the increase', () => {
  const st = defaults();
  st.days['2026-07-02'] = { youtube: 100 };
  const mikan = { watchData: { '2026-07-01': { totalSeconds: 3600, videos: { a: 3600 } }, '2026-07-02': { totalSeconds: 50, videos: {} } } };
  assertEquals(detectFormat(mikan), 'mikan');
  assertEquals(applyImport(st, mikan, 'merge'), { format: 'mikan', days: 2, seconds: 3650, queued: 0 });
  assertEquals(st.days, { '2026-07-01': { youtube: 3600 }, '2026-07-02': { youtube: 150 } });
  assertEquals(applyImport(st, mikan, 'merge').seconds, 0); // same file again
  assertEquals(applyImport(st, mikan.watchData, 'merge').seconds, 0); // bare object form
  mikan.watchData['2026-07-02'].totalSeconds = 80;
  assertEquals(applyImport(st, mikan, 'merge').seconds, 30);
  assertEquals(st.days['2026-07-02'].youtube, 180);
  assertEquals(st.ledger, {}); // never synced
});

Deno.test('native export → import round trip; merge takes the max', () => {
  const a = defaults();
  a.settings.apiKey = 'fz_secret';
  a.days = { '2026-07-01': { youtube: 10 } };
  a.overrides = { 'video:youtube:x': { scope: 'video', platform: 'youtube', id: 'x', label: 'X', value: 'non-ja', at: 5 } };
  const exp = exportState(a);
  assert(!('apiKey' in exp.settings), 'the API key is never exported');
  const b = defaults();
  b.days = { '2026-07-01': { youtube: 20 }, '2026-07-03': { youtube: 1 } };
  applyImport(b, JSON.parse(JSON.stringify(exp)), 'merge');
  assertEquals(b.days, { '2026-07-01': { youtube: 20 }, '2026-07-03': { youtube: 1 } });
  assertEquals(b.overrides['video:youtube:x'].value, 'non-ja');
  applyImport(b, exp, 'replace');
  assertEquals(b.days, { '2026-07-01': { youtube: 10 } });
  assertThrows(() => applyImport(b, { hello: 1 }, 'merge'), /Unrecognised/);
});

// ---- platforms ----

Deno.test('platform registry URL matching', () => {
  assertEquals(platformForUrl('https://www.youtube.com/watch?v=abc')?.id, 'youtube');
  assertEquals(platformForUrl('https://www.youtube-nocookie.com/embed/abc')?.id, 'youtube');
  assertEquals(platformForUrl('https://example.com/'), null);
  assertEquals(platformForUrl(undefined), null);
  assert(matchesPattern('*://*.example.com/*', 'http://a.b.example.com/x?y'));
  assert(!matchesPattern('*://*.example.com/*', 'https://badexample.com/'));
});
