// Shared content-script runtime (a classic script, loaded before each platform's adapter).
//
// The adapter (src/content/<platform>.js) only answers "what is on screen right now?"; this file
// turns that into playback intervals and reports them to the background, which owns all clocks,
// storage, settings (e.g. countMuted) and the final Japanese/override decision.
//
// Adapter interface — FaitContent.start(adapter):
//   adapter.platform            'youtube'
//   adapter.getMedia()          → null | {
//       element,                the HTMLMediaElement (used to sanity-check long gaps)
//       videoId, title, channel, channelId, channelAliases: [], url,
//       paused, ended, buffering, ad, muted,   booleans
//       detection,              null while undecided, else { japanese: bool, reason: string }
//     }
//   adapter.subscribe?(fn)      call fn() whenever something changed (SPA navigation, …)
//
// Accounting: every tick (1 s, plus media events) is compared with the previous one. If the
// media was playing (not paused / ended / buffering / an ad) at the previous tick, the wall time
// since then is credited to that video. A gap over 2.5 s (timers throttled, machine asleep) is
// only credited as far as the media itself advanced. Intervals carry the muted flag (the
// background decides whether muted time counts) and are sent every ~5 s; the background
// de-duplicates overlaps, so re-sending after a failed delivery (service worker restarting) is safe.

(() => {
  if (globalThis.FaitContent) return;

  const TICK_MS = 1000;
  const HEARTBEAT_MS = 5000;
  const TRUST_GAP_MS = 2500;          // longer gaps between ticks are checked against media time
  const HOLD_UNDECIDED_MS = 30_000;   // keep intervals of a not-yet-classified video this long

  const KANA_RE = /[぀-ゟ゠-ヿ]/g;
  const KANJI_RE = /[一-龯]/g;
  const count = (s, re) => (String(s || '').match(re) || []).length;

  /**
   * Mikan-compatible Japanese detection:
   *  1. a Japanese caption track (manual or auto-generated) → Japanese;
   *  2. title has kana and (kana + kanji) / title length > 0.3 → Japanese;
   *  3. channel name has kana and that title ratio > 0.1 → Japanese;
   *  4. otherwise not.
   */
  function detectJapanese({ title = '', channel = '', captionLanguages = [] }) {
    const ja = captionLanguages.filter((l) => /^ja(-|$)/i.test(l));
    if (ja.length) return { japanese: true, reason: 'Japanese captions' };
    const kana = count(title, KANA_RE);
    const ratio = title.length ? (kana + count(title, KANJI_RE)) / title.length : 0;
    const pct = Math.round(ratio * 100);
    if (kana > 0 && ratio > 0.3) return { japanese: true, reason: `Japanese title (${pct}% Japanese characters)` };
    if (count(channel, KANA_RE) > 0 && ratio > 0.1) {
      return { japanese: true, reason: `Japanese channel name, title ${pct}% Japanese` };
    }
    const caps = captionLanguages.length ? `captions: ${captionLanguages.slice(0, 4).join(', ')}` : 'no Japanese captions';
    return { japanese: false, reason: `${caps}; title ${pct}% Japanese` };
  }

  function start(adapter) {
    let last = null;            // the previous tick
    let segments = [];          // [{start, end, videoId, muted}] (immutable; replaced on extend)
    const videos = new Map();   // videoId → {channelId, channelAliases, detection}
    let lastSig = '';
    let lastSentAt = 0;
    let sending = false;
    let resend = false;
    let timer = null;

    const alive = () => {
      try { return !!chrome.runtime?.id; } catch { return false; }
    };

    function addSegment(startMs, endMs, videoId, muted) {
      const prev = segments[segments.length - 1];
      if (prev && prev.videoId === videoId && prev.muted === muted && Math.abs(prev.end - startMs) < 2) {
        segments[segments.length - 1] = { ...prev, end: endMs };
      } else {
        segments.push({ start: startMs, end: endMs, videoId, muted });
      }
    }

    function snapshot(m) {
      if (!m || !m.videoId) return null;
      return {
        videoId: m.videoId, title: m.title || '', channel: m.channel || '',
        channelId: m.channelId || null, channelAliases: m.channelAliases || [],
        url: m.url || location.href,
        playing: !m.paused && !m.ended && !m.buffering && !m.ad,
        paused: !!m.paused, ended: !!m.ended, buffering: !!m.buffering, ad: !!m.ad, muted: !!m.muted,
        detected: m.detection ? m.detection.japanese : null,
        reason: m.detection ? m.detection.reason : 'checking…',
      };
    }

    function tick() {
      if (!alive()) return stop();
      const now = Date.now();
      let m = null;
      try { m = adapter.getMedia(); } catch (e) { console.debug('[fait] getMedia failed', e); }
      const snap = snapshot(m);

      if (snap) {
        const v = videos.get(snap.videoId) || {};
        v.channelId = snap.channelId || v.channelId || null;
        v.channel = snap.channel || v.channel || '';
        v.title = snap.title || v.title || '';
        v.channelAliases = [...new Set([...(v.channelAliases || []), ...snap.channelAliases])];
        if (m.detection) v.detection = m.detection;
        videos.set(snap.videoId, v);
      }

      if (last?.playing) {
        const gap = now - last.t;
        let credit = gap;
        if (gap > TRUST_GAP_MS) {
          // Throttled timers or a sleeping machine: credit only what the media actually played.
          const same = m && m.element === last.element && m.videoId === last.videoId;
          const played = same ? (m.element.currentTime - last.mediaTime) / (m.element.playbackRate || 1) * 1000 : 0;
          credit = Math.max(0, Math.min(gap, played));
        }
        if (credit > 0) addSegment(last.t, last.t + Math.round(credit), last.videoId, last.muted);
      }
      last = {
        t: now, playing: !!snap?.playing, muted: !!snap?.muted, videoId: snap?.videoId,
        element: m?.element, mediaTime: m?.element?.currentTime ?? 0,
      };

      const sig = JSON.stringify(snap);
      const due = now - lastSentAt >= HEARTBEAT_MS && (segments.length > 0 || snap?.playing);
      if (sig !== lastSig || due) send(snap, sig);
    }

    async function send(snap, sig) {
      if (sending) { resend = true; return; }
      sending = true;
      const now = Date.now();
      lastSentAt = now;
      // Hold back intervals of videos not classified yet (metadata still loading), for a while.
      const ready = segments.filter((s) => videos.get(s.videoId)?.detection || now - s.end > HOLD_UNDECIDED_MS);
      const payloadVideos = {};
      for (const s of ready) {
        const v = videos.get(s.videoId) || {};
        payloadVideos[s.videoId] = {
          detected: v.detection ? v.detection.japanese : false,
          channelId: v.channelId || null,
          channelAliases: v.channelAliases || [],
          channel: v.channel || '',
          title: v.title || '',
        };
      }
      try {
        const res = await chrome.runtime.sendMessage({
          type: 'mediaState', platform: adapter.platform, media: snap,
          segments: ready.map(({ start, end, videoId, muted }) => ({ start, end, videoId, muted })),
          videos: payloadVideos,
          sentAt: now,
        });
        if (res?.ok) {
          lastSig = sig;
          segments = segments.filter((s) => !ready.includes(s));
          for (const id of videos.keys()) {
            if (id !== snap?.videoId && !segments.some((s) => s.videoId === id)) videos.delete(id);
          }
        }
      } catch {
        if (!alive()) stop();
        // Otherwise the background was busy / restarting; the next heartbeat retries.
      } finally {
        sending = false;
        if (resend) { resend = false; setTimeout(tick, 0); }
      }
    }

    function stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }

    timer = setInterval(tick, TICK_MS);
    // Media events make state changes (pause, mute, seek, end) count to the millisecond.
    for (const ev of ['play', 'playing', 'pause', 'ended', 'waiting', 'stalled', 'seeked', 'volumechange', 'emptied', 'loadedmetadata']) {
      document.addEventListener(ev, () => tick(), { capture: true, passive: true });
    }
    adapter.subscribe?.(() => tick());
    addEventListener('pagehide', () => tick());
    tick();
  }

  globalThis.FaitContent = { start, detectJapanese };
})();
