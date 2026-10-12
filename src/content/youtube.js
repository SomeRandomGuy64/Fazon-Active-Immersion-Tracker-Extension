// YouTube adapter (isolated-world content script; loaded after src/content/common.js).
//
// Finds the video that is on screen (watch page, Shorts, embeds, the miniplayer), reads its
// playback state from the <video> element and the player's CSS classes, and classifies it as
// Japanese or not from the player data posted by src/content/youtube-main.js (caption languages
// first, Mikan-style), falling back to the DOM title / channel name after ~3 s.

(() => {
  if (globalThis.__faitYouTube) return;
  globalThis.__faitYouTube = true;

  const FROM_MAIN = 'fait:yt-player-data';
  const REQUEST = 'fait:yt-request';
  const DOM_FALLBACK_MS = 3000;

  const playerData = new Map(); // videoId → {title, author, channelId, captionLanguages}
  let currentByPlayer = {};      // {movie_player: videoId, 'shorts-player': videoId}
  const firstSeen = new Map();   // videoId → ms
  const listeners = [];
  const notify = () => listeners.forEach((fn) => fn());

  const ID_RE = /^[\w-]{11}$/;
  const s = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== FROM_MAIN) return;
    if (e.data.current && typeof e.data.current === 'object') {
      currentByPlayer = {};
      for (const [k, v] of Object.entries(e.data.current)) if (ID_RE.test(v)) currentByPlayer[k] = v;
    }
    const d = e.data.data;
    if (d && ID_RE.test(d.videoId)) {
      playerData.set(d.videoId, {
        title: s(d.title), author: s(d.author, 200),
        channelId: /^UC[\w-]{22}$/.test(d.channelId) ? d.channelId : '',
        captionLanguages: Array.isArray(d.captionLanguages) ? d.captionLanguages.map((l) => s(l, 20)).filter(Boolean) : null,
      });
      if (playerData.size > 100) playerData.delete(playerData.keys().next().value);
    }
    notify();
  });
  // Ask the MAIN-world script to (re)post, in case it ran before we were listening.
  window.postMessage({ source: REQUEST }, location.origin);
  for (const ev of ['yt-navigate-finish', 'yt-page-data-updated']) document.addEventListener(ev, () => notify());

  const isShortsPage = () => location.pathname.startsWith('/shorts/');

  function urlVideoId() {
    if (location.pathname === '/watch') {
      const v = new URLSearchParams(location.search).get('v');
      return v && ID_RE.test(v) ? v : null;
    }
    const m = /^\/(?:shorts|embed|live|v)\/([\w-]{11})/.exec(location.pathname);
    return m ? m[1] : null;
  }

  function miniplayerActive() {
    return !!document.querySelector('ytd-app[miniplayer-is-active], ytd-miniplayer[active]');
  }

  function findVideo() {
    if (isShortsPage()) {
      return document.querySelector('#shorts-player video, ytd-reel-video-renderer[is-active] video')
        || document.querySelector('ytd-shorts video');
    }
    return document.querySelector('#movie_player video.html5-main-video')
      || document.querySelector('.html5-video-player video.html5-main-video')
      || document.querySelector('.html5-video-player video');
  }

  function text(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      const t = el?.textContent?.trim();
      if (t) return t;
    }
    return '';
  }

  function domTitle() {
    if (isShortsPage()) {
      const t = text(['ytd-reel-video-renderer[is-active] h2', 'ytd-reel-video-renderer[is-active] .ytShortsVideoTitleViewModelShortsVideoTitle',
        '.ytShortsVideoTitleViewModelShortsVideoTitle']);
      if (t) return t;
    } else {
      const t = text(['ytd-watch-metadata h1 yt-formatted-string', 'h1.ytd-watch-metadata', '#title h1 yt-formatted-string', '.ytp-title-link']);
      if (t) return t;
    }
    const dt = document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/, '').trim();
    return dt === 'YouTube' ? '' : dt;
  }

  function domChannel() {
    const sels = isShortsPage()
      ? ['ytd-reel-video-renderer[is-active] ytd-channel-name a', '.ytReelChannelBarViewModelChannelName a', 'ytd-reel-video-renderer[is-active] a[href^="/@"]']
      : ['ytd-watch-metadata ytd-channel-name a', '#owner ytd-channel-name a', '#upload-info ytd-channel-name a', '.ytp-title-channel-name', '.ytp-title-expanded-title a'];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      const name = el?.textContent?.trim();
      if (!name) continue;
      const href = el.getAttribute?.('href') || '';
      let alias = null;
      const h = /\/(@[^/?#]+)/.exec(href);
      const c = /\/channel\/(UC[\w-]{22})/.exec(href);
      if (h) alias = decodeURIComponent(h[1]);
      else if (c) alias = c[1];
      return { name, alias };
    }
    return { name: '', alias: null };
  }

  // On watch pages the metadata DOM lags behind SPA navigation; trust it only once it is about
  // the video in the URL.
  function domIsCurrent(videoId) {
    if (location.pathname !== '/watch') return true;
    const flexy = document.querySelector('ytd-watch-flexy');
    return !flexy || flexy.getAttribute('video-id') === videoId;
  }

  function getMedia() {
    let videoId = urlVideoId();
    const fromUrl = !!videoId;
    if (!videoId && miniplayerActive()) videoId = currentByPlayer.movie_player || null;
    if (!videoId) return null;
    const element = findVideo();
    if (!element) return null;

    const now = Date.now();
    if (!firstSeen.has(videoId)) {
      firstSeen.set(videoId, now);
      if (firstSeen.size > 200) firstSeen.delete(firstSeen.keys().next().value);
    }

    const pd = playerData.get(videoId);
    const dom = domIsCurrent(videoId) && fromUrl ? { title: domTitle(), ...domChannel() } : { title: '', name: '', alias: null };
    const title = pd?.title || dom.title;
    const channel = pd?.author || dom.name;
    const aliases = [pd?.channelId, dom.alias].filter(Boolean);

    let detection = null;
    if (pd && pd.captionLanguages !== null) {
      detection = FaitContent.detectJapanese({ title, channel, captionLanguages: pd.captionLanguages });
    } else if (now - firstSeen.get(videoId) >= DOM_FALLBACK_MS && (title || now - firstSeen.get(videoId) >= 10_000)) {
      detection = FaitContent.detectJapanese({ title, channel, captionLanguages: [] });
      detection.reason += ' (page text only)';
    }

    const player = element.closest('.html5-video-player');
    const ad = !!(player?.classList.contains('ad-showing') || player?.classList.contains('ad-interrupting')
      || player?.querySelector('.ytp-ad-player-overlay, .ytp-ad-player-overlay-layout'));
    const buffering = !element.paused && (element.readyState < 3 || element.seeking
      || !!player?.classList.contains('buffering-mode'));

    return {
      element, videoId, title, channel,
      channelId: aliases[0] || null, channelAliases: aliases,
      url: fromUrl ? location.href : `https://www.youtube.com/watch?v=${videoId}`,
      paused: element.paused, ended: element.ended, buffering, ad,
      muted: element.muted || element.volume === 0,
      detection,
    };
  }

  FaitContent.start({
    platform: 'youtube',
    getMedia,
    subscribe: (fn) => listeners.push(fn),
  });
})();
