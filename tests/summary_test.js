import { assertEquals, assert } from './assert.js';
import {
  weekVideos, appendVideoLines, videoLine, escapeMd, summaryWeeks, unposted, HEADING, MAX_SUMMARY_RUNES,
} from '../src/shared/summary.js';
import { trackWeekKey, addDays } from '../src/shared/time.js';

const T = (iso) => Date.parse(iso);

Deno.test('weekVideos: ≥ 1 min in the Track week, first watched first, then most watched', () => {
  // Track week 2026-10-10 runs Sun 2026-10-11 03:00 UTC → Sun 2026-10-18 03:00 UTC.
  const vd = {
    '2026-10-10': { 'youtube:before00000': 600 },               // previous week
    '2026-10-11': { 'youtube:aaaaaaaaaaa': 40, 'youtube:bbbbbbbbbbb': 300 },
    '2026-10-12': { 'youtube:aaaaaaaaaaa': 30, 'youtube:ccccccccccc': 500, 'youtube:short000000': 59 },
    '2026-10-18': { 'youtube:next0000000': 600 },               // next week
  };
  assertEquals(weekVideos(vd, '2026-10-10', {}).map((v) => [v.vk, v.seconds]), [
    ['youtube:bbbbbbbbbbb', 300], ['youtube:aaaaaaaaaaa', 70], ['youtube:ccccccccccc', 500],
  ]);
  const log = { from: '2026-10-10', weeks: { '2026-10-10': ['youtube:bbbbbbbbbbb'] } };
  assertEquals(unposted(log, vd, '2026-10-10', {}).map((v) => v.vk), ['youtube:aaaaaaaaaaa', 'youtube:ccccccccccc']);
});

Deno.test('summaryWeeks: previous + current week, never before `from`', () => {
  const now = T('2026-10-17T12:00:00Z');
  const cur = trackWeekKey(now);
  assertEquals(cur, '2026-10-10');
  assertEquals(summaryWeeks({ from: cur }, now), [cur]);
  assertEquals(summaryWeeks({ from: '2026-01-03' }, now), [addDays(cur, -7), cur]);
  assertEquals(summaryWeeks({ from: null }, now), []);
});

Deno.test('appendVideoLines: starts a list, extends an existing one, respects the limit', () => {
  assertEquals(appendVideoLines('', ['- a']), { summary: `${HEADING}\n- a`, added: 1 });
  assertEquals(appendVideoLines('Hi.\n\n', ['- a']).summary, `Hi.\n\n${HEADING}\n- a`);
  const mid = `Intro\n\n${HEADING}\n- a\n* b\n\nOutro`;
  assertEquals(appendVideoLines(mid, ['- c', '- d']).summary, `Intro\n\n${HEADING}\n- a\n* b\n- c\n- d\n\nOutro`);
  const big = 'x'.repeat(MAX_SUMMARY_RUNES - HEADING.length - 10);
  const r = appendVideoLines(big, ['- 1234', '- 5678']);
  assertEquals(r.added, 1);
  assert([...r.summary].length <= MAX_SUMMARY_RUNES);
  assertEquals(appendVideoLines(big, ['- ' + 'y'.repeat(50)]), { summary: big, added: 0 });
});

Deno.test('videoLine escapes Markdown in titles and channel names', () => {
  assertEquals(escapeMd(' a  *b*\n[c] <d> #e '), 'a \\*b\\* \\[c\\] \\<d\\> \\#e');
  assertEquals(videoLine({ title: 'T_1', channel: 'C|h', url: 'https://www.youtube.com/watch?v=x' }),
    '- [T\\_1](https://www.youtube.com/watch?v=x) — C\\|h');
  assertEquals(videoLine({ title: '', channel: '', url: 'u' }), '- [u](u)');
});
