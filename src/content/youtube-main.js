// Runs in the page's MAIN world (manifest content script with "world": "MAIN"), because YouTube's
// player data (caption languages, channel id, the video actually loaded in the player) is only
// reachable through page JavaScript. It only READS: ytInitialPlayerResponse on first load and
// the player's getPlayerResponse() / getVideoData() afterwards (SPA navigation, Shorts, the
// miniplayer). Results go to the isolated content script (src/content/youtube.js) via
// window.postMessage. No network interception, no page modification.

(() => {
  if (window.__faitYouTubeMain) return;
  window.__faitYouTubeMain = true;

  const OUT = 'fait:yt-player-data';
  const REQUEST = 'fait:yt-request';
  const posted = new Map(); // videoId → JSON of what we last posted

  const str = (v) => (typeof v === 'string' ? v : '');

  function fromResponse(r, playerId) {
    const d = r?.videoDetails;
    if (!d?.videoId) return null;
    const tracks = r?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    return {
      videoId: str(d.videoId),
      title: str(d.title),
      author: str(d.author),
      channelId: str(d.channelId),
      captionLanguages: Array.isArray(tracks) ? tracks.map((t) => str(t?.languageCode)).filter(Boolean) : null,
      playerId,
    };
  }

  function collect() {
    const found = [];
    const current = {};
    for (const p of document.querySelectorAll('#movie_player, #shorts-player')) {
      let data = null;
      try {
        if (typeof p.getPlayerResponse === 'function') data = fromResponse(p.getPlayerResponse(), p.id);
      } catch { /* player not ready */ }
      if (!data) {
        try {
          const v = typeof p.getVideoData === 'function' ? p.getVideoData() : null;
          if (v?.video_id) {
            data = { videoId: str(v.video_id), title: str(v.title), author: str(v.author), channelId: '', captionLanguages: null, playerId: p.id };
          }
        } catch { /* ignore */ }
      }
      if (data) {
        found.push(data);
        current[p.id] = data.videoId;
      }
    }
    // First page load: the response is embedded in the HTML before the player has it.
    const initial = fromResponse(window.ytInitialPlayerResponse, null);
    if (initial && !found.some((d) => d.videoId === initial.videoId)) found.push(initial);
    return { found, current };
  }

  let lastCurrent = '';
  function publish(force = false) {
    const { found, current } = collect();
    for (const d of found) {
      const prev = posted.get(d.videoId);
      // Don't let a poorer record (no captions known yet) replace a richer one.
      if (prev && !force) {
        const old = JSON.parse(prev);
        if (d.captionLanguages === null && old.captionLanguages !== null) continue;
      }
      const json = JSON.stringify(d);
      if (!force && prev === json) continue;
      posted.set(d.videoId, json);
      if (posted.size > 100) posted.delete(posted.keys().next().value);
      window.postMessage({ source: OUT, data: d }, location.origin);
    }
    const cur = JSON.stringify(current);
    if (force || cur !== lastCurrent) {
      lastCurrent = cur;
      window.postMessage({ source: OUT, current }, location.origin);
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source === window && e.data?.source === REQUEST) publish(true);
  });
  for (const ev of ['yt-navigate-finish', 'yt-player-updated', 'yt-page-data-updated', 'loadeddata']) {
    window.addEventListener(ev, () => setTimeout(publish, 0), true);
  }
  setInterval(publish, 1000);
  publish();
})();
