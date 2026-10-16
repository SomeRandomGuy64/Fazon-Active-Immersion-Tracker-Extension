import { assertEquals, assert } from './assert.js';
import {
  emptyChannelState, registerChannel, setVideoChannel, ensureVideo, canonicalOf, channelTotals, addVideoSeconds,
} from '../src/shared/channels.js';
import { computeStats } from '../src/shared/stats.js';
import { migrate, defaults } from '../src/background/store.js';
import { currentTarget, fingerprint } from '../src/background/sync.js';
import { trackWeekKey } from '../src/shared/time.js';
import youtube from '../src/platforms/youtube.js';

const T = (iso) => Date.parse(iso);
const UC = 'UCsg-YqdqQ-KFF0LNk23BY4A';

Deno.test('alias merge: handle-only channel merges into the UC id; handles ignore case', () => {
  const st = emptyChannelState();
  // From oEmbed: only a handle.
  const a = registerChannel(st, 'youtube', ['@HiguchiKaede'], '樋口楓', 1);
  assertEquals(a.key, 'youtube:@higuchikaede');
  assertEquals(st.channels[a.key].id, '@HiguchiKaede');
  setVideoChannel(st, 'youtube:aaaaaaaaaaa', a.key);
  // Live tracking later reports the id and the handle (different case, URL-encoded too).
  const b = registerChannel(st, 'youtube', [UC, '@higuchikaede'], '樋口楓【にじさんじ所属】', 2);
  assertEquals(b.key, `youtube:${UC}`);
  assert(b.changed);
  assertEquals(Object.keys(st.channels), [`youtube:${UC}`]);
  assertEquals(st.channels[b.key], { platform: 'youtube', id: UC, name: '樋口楓【にじさんじ所属】', at: 2 });
  // The old video pointer (to the handle) now resolves to the id-keyed channel.
  assertEquals(canonicalOf(st, st.videos['youtube:aaaaaaaaaaa'].ch), b.key);
  // A handle-only report afterwards joins the same channel; an older name doesn't win.
  const c = registerChannel(st, 'youtube', ['@HIGUCHIKAEDE'], 'old name', 1);
  assertEquals(c.key, b.key);
  assertEquals(st.channels[b.key].name, '樋口楓【にじさんじ所属】');
  // Latest name wins.
  registerChannel(st, 'youtube', [UC], 'New Name', 3);
  assertEquals(st.channels[b.key].name, 'New Name');
  assertEquals(registerChannel(st, 'youtube', [], 'x').key, null);
});

Deno.test('alias merge: an existing handle-keyed and an existing UC-keyed channel merge', () => {
  const st = emptyChannelState();
  // Mikan import resolved via oEmbed (handle only); live tracking reported only the UC id.
  const h = registerChannel(st, 'youtube', ['@HiguchiKaede'], '樋口楓【にじさんじ所属】', 1).key;
  const u = registerChannel(st, 'youtube', [UC], '樋口楓【にじさんじ所属】', 2).key;
  setVideoChannel(st, 'youtube:aaaaaaaaaaa', h);
  setVideoChannel(st, 'youtube:bbbbbbbbbbb', u);
  assertEquals(Object.keys(st.channels).length, 2);
  // The player's ownerProfileUrl now gives both ids together: one channel, both videos on it.
  const m = registerChannel(st, 'youtube', [UC, '@HiguchiKaede'], '樋口楓【にじさんじ所属】', 3);
  assertEquals(m.key, u);
  assert(m.changed);
  assertEquals(Object.keys(st.channels), [u]);
  assertEquals(canonicalOf(st, st.videos['youtube:aaaaaaaaaaa'].ch), u);
  assertEquals(canonicalOf(st, st.videos['youtube:bbbbbbbbbbb'].ch), u);
});

Deno.test('ensureVideo queues once; a known channel dequeues', () => {
  const st = emptyChannelState();
  assert(ensureVideo(st, 'youtube:bbbbbbbbbbb'));
  assert(!ensureVideo(st, 'youtube:bbbbbbbbbbb'));
  assertEquals(st.resolve.queue, ['youtube:bbbbbbbbbbb']);
  const { key } = registerChannel(st, 'youtube', ['@x'], 'X');
  setVideoChannel(st, 'youtube:bbbbbbbbbbb', key);
  assertEquals(st.resolve.queue, []);
});

Deno.test('channel totals: windows, unknown remainder, live seconds', () => {
  const st = emptyChannelState();
  const k1 = registerChannel(st, 'youtube', [UC], 'Kaede').key;
  const k2 = registerChannel(st, 'youtube', ['@hikaru'], 'Hikaru').key;
  setVideoChannel(st, 'youtube:v1v1v1v1v1v', k1);
  setVideoChannel(st, 'youtube:v2v2v2v2v2v', k2);
  ensureVideo(st, 'youtube:v3v3v3v3v3v'); // unresolved
  const videoDays = {};
  addVideoSeconds(videoDays, '2026-10-11', 'youtube:v1v1v1v1v1v', 100);
  addVideoSeconds(videoDays, '2026-10-11', 'youtube:v3v3v3v3v3v', 10);
  addVideoSeconds(videoDays, '2026-10-05', 'youtube:v2v2v2v2v2v', 50);
  addVideoSeconds(videoDays, '2026-09-01', 'youtube:v1v1v1v1v1v', 7);
  const days = {
    '2026-10-11': { youtube: 130 },  // 100 Kaede + 10 unresolved + 20 without video data
    '2026-10-05': { youtube: 50 },
    '2026-09-01': { youtube: 7 },
    '2026-08-01': { youtube: 1000 }, // imported, no video data
  };
  const s = computeStats({
    days, now: T('2026-10-11T12:00:00Z'), settings: { weekStart: 1 },
    live: { youtube: 5 }, liveVideos: { 'youtube:v1v1v1v1v1v': 5 },
    channelData: { videoDays, ...st },
  });
  const by = Object.fromEntries(s.channels.map((c) => [c.id ?? 'null', c]));
  assertEquals(by[UC], { platform: 'youtube', id: UC, name: 'Kaede', today: 105, week: 105, month: 105, allTime: 112 });
  assertEquals(by['@hikaru'], { platform: 'youtube', id: '@hikaru', name: 'Hikaru', today: 0, week: 50, month: 50, allTime: 50 });
  assertEquals(by.null, { platform: 'youtube', id: null, name: null, today: 30, week: 30, month: 30, allTime: 1030 });
  // Channels add up to the totals.
  assertEquals(s.channels.reduce((a, c) => a + c.allTime, 0), s.allTime);
  assertEquals(s.channels.reduce((a, c) => a + c.today, 0), s.today);
});

Deno.test('channelTotals without video data: one unknown row per platform', () => {
  const rows = channelTotals({
    days: { '2026-10-01': { youtube: 10, netflix: 5 } }, todayKey: '2026-10-01',
    windows: () => ({ today: true, week: true, month: true }),
  });
  assertEquals(rows.map((r) => [r.platform, r.id, r.allTime]).sort(), [['netflix', null, 5], ['youtube', null, 10]]);
});

Deno.test('migration: schema 1 storage → schema 2', () => {
  const v1 = {
    schema: 1,
    settings: { resetTime: '04:00', timezone: 'UTC', weekStart: 0 },
    days: { '2026-07-01': { youtube: 3600 } },
    imports: { mikan: { '2026-07-01': 3600 } },
    credit: { claims: { horizon: 5, spans: [] }, carry: { youtube: 10 } },
    syncState: { state: 'ok', lastSyncAt: 1 },
    theme: 'dark', // a UI key: ignored
  };
  const st = migrate(v1);
  assertEquals(st.schema, 2);
  assertEquals(st.settings.resetTime, '04:00');
  assertEquals(st.settings.dailyTargetMinutes, null);
  assertEquals([st.videoDays, st.videos, st.channels, st.aliases, st.trackGoal], [{}, {}, {}, {}, null]);
  assertEquals(st.resolve.queue, []);
  assertEquals(st.syncState.authStatus, null);
  assertEquals(st.credit.carry, { youtube: 10 });
  const s = computeStats({ days: st.days, now: T('2026-07-01T12:00:00Z'), settings: st.settings, channelData: st });
  assertEquals(s.channels, [{ platform: 'youtube', id: null, name: null, today: 3600, week: 3600, month: 3600, allTime: 3600 }]);
  // Month-split per-video storage is reassembled.
  const st2 = migrate({ 'vd:2026-07': { '2026-07-01': { 'youtube:a': 1 } }, 'vd:2026-08': { '2026-08-02': { 'youtube:b': 2 } } });
  assertEquals(st2.videoDays, { '2026-07-01': { 'youtube:a': 1 }, '2026-08-02': { 'youtube:b': 2 } });
});

Deno.test('target precedence: Track goal > manual daily target > none', () => {
  const now = T('2026-10-12T12:00:00Z');
  const st = defaults();
  assertEquals(currentTarget(st, now), { daily: null, weekly: null, source: null });
  st.settings.dailyTargetMinutes = 90;
  assertEquals(currentTarget(st, now), { daily: 5400, weekly: 37800, source: 'manual' });
  // A cached goal only counts while syncing with the key/base it was read with, for this week.
  st.trackGoal = { week: trackWeekKey(now), hours: 35, at: now, base: 'https://api.fazon.nexus', key: null };
  assertEquals(currentTarget(st, now).source, 'manual');
  Object.assign(st.settings, { syncEnabled: true, apiKey: 'fz_k' });
  st.trackGoal.key = fingerprint('fz_k');
  assertEquals(currentTarget(st, now), { daily: 18000, weekly: 126000, source: 'track' });
  assertEquals(currentTarget(st, now + 7 * 86400e3).source, 'manual'); // next week: goal unknown
  st.syncState.authStatus = 401;
  assertEquals(currentTarget(st, now).source, 'manual');
  st.syncState.authStatus = null;
  st.trackGoal.hours = null; // week without an active goal
  assertEquals(currentTarget(st, now).source, 'manual');
  st.settings.dailyTargetMinutes = null;
  assertEquals(currentTarget(st, now).source, null);
});

Deno.test('YouTube oEmbed resolver: parses handle, maps errors', async () => {
  const resp = (status, body, headers = {}) => ({
    status, ok: status >= 200 && status < 300, json: async () => body, headers: { get: (h) => headers[h] ?? null },
  });
  let seen = '';
  const ok = await youtube.resolveChannel('HW-n71wysV0', (url) => { seen = url; return resp(200, { author_name: '樋口楓', author_url: 'https://www.youtube.com/@HiguchiKaede' }); });
  assertEquals(ok, { name: '樋口楓', ids: ['@HiguchiKaede'] });
  assert(seen.startsWith('https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DHW-n71wysV0'));
  assertEquals(await youtube.resolveChannel('HW-n71wysV0', () => resp(200, { author_name: 'A', author_url: 'https://www.youtube.com/channel/' + UC })), { name: 'A', ids: [UC] });
  assertEquals(await youtube.resolveChannel('HW-n71wysV0', () => resp(200, { author_name: 'A', author_url: 'https://www.youtube.com/@%E6%A8%8B%E5%8F%A3' })), { name: 'A', ids: ['@%E6%A8%8B%E5%8F%A3'] });
  for (const st of [400, 401, 403, 404]) assertEquals(await youtube.resolveChannel('HW-n71wysV0', () => resp(st, {})), null);
  assertEquals(await youtube.resolveChannel('bad', () => resp(200, {})), null);
  let err = null;
  try { await youtube.resolveChannel('HW-n71wysV0', () => resp(429, {}, { 'Retry-After': '30' })); } catch (e) { err = e; }
  assertEquals(err?.retryAfter, 30);
  err = null;
  try { await youtube.resolveChannel('HW-n71wysV0', () => { throw new TypeError('offline'); }); } catch (e) { err = e; }
  assert(/network/.test(err?.message));
});
