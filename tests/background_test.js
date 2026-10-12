// Runs the real background (message router, tracker, store) against an in-memory chrome shim.
import { assertEquals, assert } from './assert.js';
import { installChrome } from './chrome_shim.js';
import { trackWeekKey, dayKey, weekdayOf, WEEKDAYS } from '../src/shared/time.js';
import { configureResolver, runResolver } from '../src/background/resolver.js';
import { refreshTrackTotal, FIRST_WEEK } from '../src/background/sync.js';
import { addDays } from '../src/shared/time.js';

const env = installChrome({ granted: ['https://www.youtube.com/*', 'https://m.youtube.com/*', 'https://www.youtube-nocookie.com/*'] });
await import('../src/background/main.js');
const { send, tabs } = env;

const YT = 'https://www.youtube.com/watch?v=';
tabs.set(1, { url: YT + 'aaaaaaaaaaa' });
tabs.set(2, { url: YT + 'bbbbbbbbbbb' });

const media = (videoId, extra = {}) => ({
  videoId, title: 't', channel: 'c', channelId: 'UCxxxxxxxxxxxxxxxxxxxxxx', channelAliases: ['@c'], url: YT + videoId,
  playing: true, paused: false, ended: false, buffering: false, ad: false, muted: false, detected: true, reason: 'test', ...extra,
});
const heartbeat = (tabId, videoId, segments, { detected = true, mediaExtra = {} } = {}) => send({
  type: 'mediaState', platform: 'youtube', media: media(videoId, { detected, ...mediaExtra }),
  segments: segments.map(([start, end, muted = false]) => ({ start, end, videoId, muted })),
  videos: { [videoId]: { detected, channelId: 'UCxxxxxxxxxxxxxxxxxxxxxx', channelAliases: ['@c'] } },
}, { tab: { id: tabId }, frameId: 0, url: YT + videoId });

const stats = async () => (await send({ type: 'getStats' }));

Deno.test('background end to end (shim)', async (t) => {
  await t.step('two tabs playing at once count once', async () => {
    const now = Date.now();
    // Keep clear of a day boundary so "today" is one day.
    let r = await heartbeat(1, 'aaaaaaaaaaa', [[now - 20_000, now - 10_000]]);
    assertEquals(r, { ok: true, credited: 10 });
    r = await heartbeat(2, 'bbbbbbbbbbb', [[now - 15_000, now - 5_000]]); // overlaps 5 s
    assertEquals(r.credited, 5);
    r = await heartbeat(1, 'aaaaaaaaaaa', [[now - 20_000, now - 10_000]]); // re-sent after a lost ack
    assertEquals(r.credited, 0);
    const s = await stats();
    assert(s.ok);
    // Live seconds may add a little on top (tabs are "playing"); credited part is exactly 15.
    const st = await send({ type: 'exportData' });
    assertEquals(Object.values(st.data.days).reduce((a, d) => a + d.youtube, 0), 15);
  });

  await t.step('non-Japanese and muted time is not counted; overrides flip it', async () => {
    const now = Date.now();
    let r = await heartbeat(1, 'ccccccccccc', [[now - 4_000, now - 2_000]], { detected: false });
    assertEquals(r.credited, 0);
    r = await heartbeat(1, 'ddddddddddd', [[now - 2_000, now - 1_000, true]]); // muted
    assertEquals(r.credited, 0);
    assert((await send({ type: 'setSettings', patch: { countMuted: true } })).ok);
    r = await heartbeat(1, 'ddddddddddd', [[now - 2_000, now - 1_000, true]]);
    assertEquals(r.credited, 1);
    await send({ type: 'setSettings', patch: { countMuted: false } });
    // Channel override says Japanese → the detected=false video counts.
    assert((await send({ type: 'setOverride', scope: 'channel', platform: 'youtube', id: '@c', label: 'c', value: 'ja' })).ok);
    r = await heartbeat(1, 'eeeeeeeeeee', [[now - 1_000, now]], { detected: false });
    assertEquals(r.credited, 1);
    // Video override beats channel override.
    await send({ type: 'setOverride', scope: 'video', platform: 'youtube', id: 'fffffffffff', label: 'f', value: 'non-ja' });
    r = await heartbeat(1, 'fffffffffff', [[now, now + 1_000]], { detected: true });
    assertEquals(r.credited, 0);
    const ov = await send({ type: 'getOverrides' });
    assertEquals(ov.overrides.map((o) => [o.scope, o.id, o.value]).sort(), [['channel', '@c', 'ja'], ['video', 'fffffffffff', 'non-ja']]);
    await send({ type: 'setOverride', scope: 'channel', platform: 'youtube', id: '@c', value: null });
    assertEquals((await send({ type: 'getOverrides' })).overrides.length, 1);
  });

  await t.step('getStatus reports the tab media and tracking state', async () => {
    tabs.set(3, { url: YT + 'ggggggggggg' });
    await heartbeat(3, 'ggggggggggg', [], { detected: true });
    let s = await send({ type: 'getStatus', tabId: 3 });
    assertEquals(s.platform, { id: 'youtube', name: 'YouTube' });
    assertEquals([s.hasSitePermission, s.tracking, s.media.japanese, s.media.detected], [true, true, true, true]);
    assertEquals(s.media.override, { video: null, channel: null });
    await send({ type: 'setOverride', scope: 'video', platform: 'youtube', id: 'ggggggggggg', label: 'g', value: 'non-ja' });
    s = await send({ type: 'getStatus', tabId: 3 });
    assertEquals([s.tracking, s.media.japanese, s.media.override.video], [false, false, 'non-ja']);
    assertEquals(env.icons.get(3).path[16], '/icons/icon-inactive-16.png');
    // A tab that left YouTube: no media.
    tabs.set(3, { url: 'https://example.com/' });
    s = await send({ type: 'getStatus', tabId: 3 });
    assertEquals([s.platform, s.media], [null, null]);
  });

  await t.step('UI messages from content scripts are refused', async () => {
    const r = await send({ type: 'resetData' }, { tab: { id: 1 }, url: 'https://www.youtube.com/' });
    assertEquals(r, undefined);
  });

  await t.step('the sync ledger only fills while sync is enabled', async () => {
    let ex = await send({ type: 'getStats' });
    assertEquals(ex.sync.state, 'off');
    assertEquals(ex.sync.pendingSeconds, 0);
    const set = await send({ type: 'setSettings', patch: { apiKey: 'fz_test', syncEnabled: true, apiBase: 'http://127.0.0.1:9' } });
    assert(set.ok, JSON.stringify(set));
    const now = Date.now();
    await heartbeat(2, 'bbbbbbbbbbb', [[now + 2_000, now + 4_000]]);
    ex = await send({ type: 'getStats' });
    assertEquals(ex.sync.pendingSeconds, 2);
    const name = `YouTube - ${WEEKDAYS[weekdayOf(dayKey(now + 2_000, ex.settings))]}`;
    assertEquals(ex.sync.subcats, [name]);
    // No host permission for the API base → error state, nothing sent.
    const sync = await send({ type: 'syncNow' });
    assertEquals(sync.sync.state, 'error');
    assert(/permission/i.test(sync.sync.lastError));
    assert(trackWeekKey(now));
  });

  await t.step('Mikan import, export and reset', async () => {
    let r = await send({ type: 'importData', mode: 'merge', data: { watchData: { '2025-01-05': { totalSeconds: 7200, videos: {} } } } });
    assertEquals(r.imported, { format: 'mikan', days: 1, seconds: 7200, queued: 0 });
    r = await send({ type: 'importData', mode: 'merge', data: { watchData: { '2025-01-05': { totalSeconds: 7200, videos: {} } } } });
    assertEquals(r.imported.seconds, 0);
    const s = await stats();
    assertEquals(s.firstDay, '2025-01-05');
    assertEquals(s.days['2025-01-05'], 7200);
    assertEquals(s.sync.pendingSeconds, 2); // imported time is not synced
    assert((await send({ type: 'resetData' })).ok);
    const after = await stats();
    assertEquals([after.firstDay, after.sync.pendingSeconds], [null, 0]);
    // Old reports re-sent after a reset are not credited again.
    const now = Date.now();
    assertEquals((await heartbeat(1, 'aaaaaaaaaaa', [[now - 20_000, now - 10_000]])).credited, 0);
  });

  await t.step('bad requests answer ok:false', async () => {
    assertEquals((await send({ type: 'setSettings', patch: { resetTime: '99:99' } })).ok, false);
    assertEquals((await send({ type: 'setOverride', scope: 'nope' })).ok, false);
    assertEquals((await send({ type: 'importData', data: [1, 2] })).ok, false);
  });

  await t.step('Mikan import with videos → oEmbed resolution → channels; re-import; live merge', async () => {
    assert((await send({ type: 'resetData' })).ok);
    await send({ type: 'setSettings', patch: { apiKey: '', syncEnabled: false } });
    const calls = [];
    const OEMBED = {
      HWn71wysV00: { author_name: '樋口楓【にじさんじ所属】', author_url: 'https://www.youtube.com/@HiguchiKaede' },
      HWn71wysV01: { author_name: '樋口楓【にじさんじ所属】', author_url: 'https://www.youtube.com/@HiguchiKaede' },
      hikaru00000: { author_name: 'ヒカル（Hikaru）', author_url: 'https://www.youtube.com/@hikaru' },
    };
    let flaky = 1;
    configureResolver({
      fetch: (url) => {
        const id = new URL(url).searchParams.get('url').split('v=')[1];
        calls.push(id);
        if (id === 'hikaru00000' && flaky-- > 0) return Promise.reject(new TypeError('network down'));
        const body = OEMBED[id];
        return Promise.resolve({ status: body ? 200 : 404, ok: !!body, json: async () => body, headers: { get: () => null } });
      },
    });
    const mikan = { watchData: {
      '2026-10-01': { totalSeconds: 3000, videos: { HWn71wysV00: 1000, hikaru00000: 1500, deleted0000: 500 } },
      '2026-10-02': { totalSeconds: 600, videos: { HWn71wysV01: 600 } },
    } };
    let r = await send({ type: 'importData', mode: 'merge', data: mikan });
    assertEquals(r.imported, { format: 'mikan', days: 2, seconds: 3600, queued: 4 });
    // Let the queue drain (the import already kicked a run; the transient failure is retried).
    for (let i = 0; i < 40; i++) {
      await runResolver();
      const st = await stats();
      if (st.resolve.pending === 0) break;
      await new Promise((res) => setTimeout(res, 100));
      (await import('../src/background/store.js')).update((s) => { s.resolve.nextAt = 0; return {}; }); // skip backoff
    }
    let s = await stats();
    assertEquals(s.resolve, { pending: 0, done: 3, failed: 1 });
    const by = Object.fromEntries(s.channels.map((c) => [c.name, c.allTime]));
    assertEquals(by, { '樋口楓【にじさんじ所属】': 1600, 'ヒカル（Hikaru）': 1500, null: 500 });
    assertEquals(s.allTime, 3600);
    assert(calls.filter((c) => c === 'hikaru00000').length === 2, 'transient failure retried');
    // Re-importing the same data changes nothing and queues nothing.
    r = await send({ type: 'importData', mode: 'merge', data: mikan });
    assertEquals(r.imported, { format: 'mikan', days: 0, seconds: 0, queued: 0 });
    assertEquals((await stats()).allTime, 3600);
    assertEquals((await stats()).sync.pendingSeconds, 0); // never synced

    // Live tracking with the UC id + handle merges with the handle-only channel from oEmbed.
    tabs.set(9, { url: YT + 'livevideo01' });
    const now = Date.now();
    r = await send({
      type: 'mediaState', platform: 'youtube', media: media('livevideo01', { channel: '樋口楓', channelId: 'UCsg-YqdqQ-KFF0LNk23BY4A' }),
      // After a reset, only time after it can be credited: report the next 4 s (future end is clamped to now + 5 s).
      segments: [{ start: now, end: now + 4_000, videoId: 'livevideo01', muted: false }],
      videos: { livevideo01: { detected: true, channelId: 'UCsg-YqdqQ-KFF0LNk23BY4A', channelAliases: ['@higuchikaede'], channel: '樋口楓' } },
    }, { tab: { id: 9 }, frameId: 0 });
    assertEquals(r.credited, 4);
    s = await stats();
    const kaede = s.channels.filter((c) => c.id === 'UCsg-YqdqQ-KFF0LNk23BY4A');
    assertEquals(kaede.length, 1);
    assertEquals([kaede[0].name, kaede[0].allTime - kaede[0].today, kaede[0].today >= 4], ['樋口楓', 1600, true]);
    assert(!s.channels.some((c) => c.id === '@HiguchiKaede'), 'handle row merged away');
    // Session seconds for the video playing in tab 9 (credited today + live).
    const status = await send({ type: 'getStatus', tabId: 9 });
    assert(status.media.sessionSeconds >= 4 && status.media.sessionSeconds <= 10, `session ${status.media.sessionSeconds}`);
    // Per-video seconds are stored one key per month.
    const raw = await env.chrome.storage.local.get(null);
    assert(Object.keys(raw).some((k) => /^vd:\d{4}-\d{2}$/.test(k)), 'vd:YYYY-MM keys');
    assertEquals(raw['vd:2026-10']['2026-10-01']['youtube:HWn71wysV00'], 1000);

    // A tracked video without channel info gets queued and resolved by oEmbed.
    OEMBED.nochannel01 = { author_name: 'Somebody', author_url: 'https://www.youtube.com/@somebody' };
    r = await send({
      type: 'mediaState', platform: 'youtube', media: media('nochannel01', { channelId: null, channelAliases: [] }),
      segments: [{ start: now + 4_000, end: now + 5_000, videoId: 'nochannel01', muted: false }],
      videos: { nochannel01: { detected: true, channelId: null, channelAliases: [] } },
    }, { tab: { id: 9 }, frameId: 0 });
    await runResolver();
    s = await stats();
    assertEquals(s.channels.find((c) => c.name === 'Somebody')?.allTime, 1);

    // Export → replace import keeps channel attribution.
    const ex = (await send({ type: 'exportData' })).data;
    await send({ type: 'resetData' });
    await send({ type: 'importData', mode: 'replace', data: ex });
    s = await stats();
    assertEquals(Object.fromEntries(s.channels.map((c) => [c.name, c.allTime]))['ヒカル（Hikaru）'], 1500);
  });

  await t.step('target: manual daily target from settings', async () => {
    let s = await stats();
    assertEquals(s.target, { daily: null, weekly: null, source: null });
    assert((await send({ type: 'setSettings', patch: { dailyTargetMinutes: 150 } })).ok);
    s = await stats();
    assertEquals(s.target, { daily: 9000, weekly: 63000, source: 'manual' });
    assertEquals(s.settings.dailyTargetMinutes, 150);
    await send({ type: 'setSettings', patch: { dailyTargetMinutes: null } });
    assertEquals((await stats()).target.source, null);
  });

  await t.step('Track all-time active total: paging, stop condition, pending, errors', async () => {
    const realFetch = globalThis.fetch;
    const cur = trackWeekKey(Date.now());
    let loggedSince = addDays(cur, -7 * 299); // 300 logged weeks: spans two 260-week chunks
    let status = 200;
    const reqs = [];
    globalThis.fetch = (url, opts) => {
      const u = new URL(url);
      reqs.push(u.pathname + u.search);
      assertEquals(opts.headers.Authorization, 'Bearer fz_total');
      if (status !== 200) return Promise.resolve(new Response(JSON.stringify({ error: 'invalid or revoked API key' }), { status }));
      if (u.pathname !== '/v1/api/track/weeks') return Promise.resolve(new Response('{"error":"nope"}', { status: 404 }));
      const from = u.searchParams.get('from'), to = u.searchParams.get('to');
      const weeks = [];
      for (let w = from; w <= to; w = addDays(w, 7)) {
        const logged = w >= loggedSince;
        weeks.push({ week: w, logged, totals: { active: logged ? 1.25 : 0 } });
      }
      assert(weeks.length <= 260, `chunk of ${weeks.length} weeks`);
      return Promise.resolve(new Response(JSON.stringify({ from, to, weeks }), { status: 200 }));
    };
    try {
      await send({ type: 'setSettings', patch: { apiKey: '', syncEnabled: false } });
      let s = await stats();
      assertEquals(s.track, { state: 'off', activeAllTime: null, pendingSeconds: 0, fetchedAt: null, error: null, weeks: [] });

      env.grant('http://127.0.0.1/*');
      await send({ type: 'setSettings', patch: { apiKey: 'fz_total', apiBase: 'http://127.0.0.1:9', syncEnabled: false } });
      await refreshTrackTotal();
      s = await stats();
      assertEquals([s.track.state, s.track.activeAllTime, s.track.pendingSeconds, s.track.error], ['ok', 300 * 1.25 * 3600, 0, null]);
      assert(s.track.fetchedAt > 0);
      // Weekly series: first week with active hours → current week, summing to the total.
      assertEquals(s.track.weeks.length, 300);
      assertEquals(s.track.weeks[0], { week: loggedSince, start: Date.parse(addDays(loggedSince, 1) + 'T03:00:00Z'), active: 4500 });
      assertEquals(s.track.weeks.at(-1).week, cur);
      assertEquals(s.track.weeks.reduce((a, w) => a + w.active, 0), s.track.activeAllTime);
      // Chunk 1: 260 weeks to the current one; chunk 2: 40 logged; chunk 3: nothing logged → stop.
      assertEquals(reqs, [
        `/v1/api/track/weeks?from=${addDays(cur, -7 * 259)}&to=${cur}`,
        `/v1/api/track/weeks?from=${addDays(cur, -7 * 519)}&to=${addDays(cur, -7 * 260)}`,
        `/v1/api/track/weeks?from=${addDays(cur, -7 * 779)}&to=${addDays(cur, -7 * 520)}`,
      ]);
      // Cached: a getStats within 10 min doesn't fetch again.
      reqs.length = 0;
      await stats();
      await refreshTrackTotal();
      assertEquals(reqs.length, 0);

      // Everything logged since 2000: paging stops at the first Track week.
      loggedSince = FIRST_WEEK;
      reqs.length = 0;
      await refreshTrackTotal({ force: true });
      const weeksSince2000 = (Date.parse(cur) - Date.parse(FIRST_WEEK)) / (7 * 86400e3) + 1;
      assertEquals(reqs.length, Math.ceil(weeksSince2000 / 260));
      assert(reqs.at(-1).includes(`from=${FIRST_WEEK}`));
      s = await stats();
      assertEquals(s.track.activeAllTime, Math.round(weeksSince2000 * 125) * 36);

      // Sync on: not-yet-sent seconds are reported separately (Track figure unchanged).
      const before = s.track.activeAllTime;
      await send({ type: 'setSettings', patch: { syncEnabled: true } });
      const now = Date.now();
      tabs.set(11, { url: YT + 'pendingvid1' });
      await heartbeat(11, 'pendingvid1', [[now, now + 3_000]]);
      s = await stats();
      assertEquals([s.track.activeAllTime, s.track.pendingSeconds], [before, s.sync.pendingSeconds]);
      assert(s.track.pendingSeconds >= 3, `pending ${s.track.pendingSeconds}`);
      await send({ type: 'setSettings', patch: { syncEnabled: false } });

      // 401 → error, no value.
      status = 401;
      await refreshTrackTotal({ force: true });
      s = await stats();
      assertEquals([s.track.state, s.track.activeAllTime], ['error', null]);
      assert(/rejected/.test(s.track.error), s.track.error);
      // A 5xx keeps the last good value but reports the error.
      status = 200;
      await refreshTrackTotal({ force: true });
      status = 503;
      await refreshTrackTotal({ force: true });
      s = await stats();
      assertEquals([s.track.state, s.track.activeAllTime > 0], ['error', true]);
      // Missing host permission → error with a clear message.
      await send({ type: 'setSettings', patch: { apiBase: 'http://localhost:9' } });
      await refreshTrackTotal();
      s = await stats();
      assertEquals(s.track.state, 'error');
      assert(/permission/i.test(s.track.error), s.track.error);
    } finally {
      globalThis.fetch = realFetch;
      await send({ type: 'setSettings', patch: { apiKey: '', apiBase: 'https://api.fazon.nexus', syncEnabled: false } });
    }
  });
});
