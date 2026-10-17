// YouTube platform descriptor. Detection lives in src/content/youtube.js (a content script).

const ID_RE = /^[\w-]{11}$/;

export class TransientError extends Error {
  constructor(message, retryAfter = null) {
    super(message);
    this.retryAfter = retryAfter;
  }
}

export default {
  id: 'youtube',
  name: 'YouTube', // used in Track sub-category names: "YouTube - Monday"
  // Where the content script runs (keep in step with manifest.json content_scripts/host_permissions).
  // youtube-nocookie.com covers privacy-enhanced embeds on other sites.
  matches: ['https://www.youtube.com/*', 'https://m.youtube.com/*', 'https://www.youtube-nocookie.com/*'],
  // Public URL of a piece of media / a channel, for the UI's override lists.
  mediaUrl: (videoId) => `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
  channelUrl: (channelId) => channelId.startsWith('@')
    ? `https://www.youtube.com/${channelId}`
    : `https://www.youtube.com/channel/${encodeURIComponent(channelId)}`,

  /**
   * A video's length in seconds without a page or cookies: the player endpoint the web player
   * itself calls (small JSON), else the public watch page. Resolves 0 when unknown (live now,
   * deleted, private); throws TransientError for rate limits / network trouble.
   */
  async fetchDuration(videoId, fetchFn = fetch) {
    if (!ID_RE.test(videoId)) return 0;
    const len = (text) => Number(/"lengthSeconds":"(\d+)"/.exec(text)?.[1]) || 0;
    const get = async (url, opts) => {
      let r;
      try {
        r = await fetchFn(url, { credentials: 'omit', cache: 'no-store', ...opts });
      } catch (e) {
        throw new TransientError(`network: ${e?.message || e}`);
      }
      if (r.status === 429) throw new TransientError('rate limited', Number(r.headers?.get?.('Retry-After')) || 60);
      if (r.status >= 500) throw new TransientError(`HTTP ${r.status}`);
      return r.ok ? r.text() : '';
    };
    const body = JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.20260101.00.00', hl: 'en' } }, videoId });
    const fromPlayer = len(await get('https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }));
    if (fromPlayer) return fromPlayer;
    return len(await get(`https://www.youtube.com/watch?v=${videoId}`));
  },

  /**
   * Find a video's channel without a page: YouTube's public oEmbed endpoint (covered by the
   * www.youtube.com host permission; it also answers CORS). Resolves { name, ids: ['@handle'], title },
   * or null when the video can't be resolved (deleted, private, not embeddable, bad id). Throws
   * TransientError for rate limits / server or network trouble (retry later).
   */
  async resolveChannel(videoId, fetchFn = fetch) {
    if (!ID_RE.test(videoId)) return null;
    const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
    let r;
    try {
      r = await fetchFn(url, { credentials: 'omit', cache: 'no-store' });
    } catch (e) {
      throw new TransientError(`network: ${e?.message || e}`);
    }
    if ([400, 401, 403, 404, 410].includes(r.status)) return null;
    if (r.status === 429) throw new TransientError('rate limited', Number(r.headers?.get?.('Retry-After')) || 60);
    if (!r.ok) throw new TransientError(`HTTP ${r.status}`);
    let j;
    try { j = await r.json(); } catch { throw new TransientError('bad JSON'); }
    const name = typeof j?.author_name === 'string' ? j.author_name : '';
    const ids = [];
    const u = typeof j?.author_url === 'string' ? j.author_url : '';
    const m = /youtube\.com\/(@[^/?#]+|channel\/(UC[\w-]{22})|(?:c|user)\/[^/?#]+)/.exec(u);
    if (m) ids.push(m[2] || (m[1].startsWith('@') ? m[1] : `/${m[1]}`));
    else if (name) ids.push(`name:${name}`);
    const title = typeof j?.title === 'string' ? j.title.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    return ids.length ? { name, ids, title } : null;
  },
};
