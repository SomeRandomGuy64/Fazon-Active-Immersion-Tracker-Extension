import { assertEquals } from './assert.js';
import { trackDays, trackPace, cumulative } from '../src/ui/series.js';

// Track week K (a Saturday) covers the days K+1 … K+7. Today = Wednesday 2026-10-14.
const W = (week, h) => ({ week, start: Date.parse(week + 'T03:00:00Z') + 86400e3, active: h * 3600 });

Deno.test('trackDays spreads weeks over their days (current week over elapsed days) + pending today', () => {
  const weeks = [W('2026-09-26', 0), W('2026-10-03', 7), W('2026-10-10', 4)];
  const { days, firstDay } = trackDays(weeks, '2026-10-14', 600);
  assertEquals(firstDay, '2026-10-04'); // leading empty week trimmed
  assertEquals(days['2026-10-04'], 3600);
  assertEquals(days['2026-10-10'], 3600);
  // Current week: Sun 11 … Wed 14 = 4 elapsed days → 1 h each, plus 10 min pending today.
  assertEquals([days['2026-10-11'], days['2026-10-14']], [3600, 3600 + 600]);
  assertEquals(days['2026-10-15'], undefined);
  const series = cumulative(days, firstDay, '2026-10-14');
  assertEquals(series.at(-1).total, 11 * 3600 + 600);
});

Deno.test('trackPace: last 4 complete weeks, else the current week so far', () => {
  const weeks = [W('2026-09-05', 99), W('2026-09-12', 7), W('2026-09-19', 14), W('2026-09-26', 21), W('2026-10-03', 28), W('2026-10-10', 1)];
  assertEquals(trackPace(weeks, '2026-10-14'), { pace: (70 * 3600) / 28, weeks: 4 });
  assertEquals(trackPace([W('2026-10-03', 14), W('2026-10-10', 1)], '2026-10-14'), { pace: 2 * 3600, weeks: 1 });
  assertEquals(trackPace([W('2026-10-10', 4)], '2026-10-14'), { pace: 3600, weeks: 0 });
  assertEquals(trackPace([], '2026-10-14'), { pace: 0, weeks: 0 });
});
