// Channels: which channel each video belongs to, alias merging, and per-channel totals. Pure.
//
// State (all keyed with the platform id so platforms never collide):
//   videos:    { 'youtube:<videoId>': { ch: '<alias key>' | null, t?: title } }   ch null = channel unknown
//   channels:  { '<canonical key>': { platform, id, name, at } }
//   aliases:   { '<alias key>': '<canonical key>' }   every known alias, the canonical one included
//   videoDays: { 'YYYY-MM-DD': { 'youtube:<videoId>': seconds } }
//   resolve:   { queue: ['youtube:<videoId>', …], done, failed, attempts: {vk: n}, nextAt }
//
// Alias keys are 'youtube:UC…' (channel ids) or 'youtube:@handle' (lower-cased: handles are
// case-insensitive). A channel seen with both is one channel, keyed by its UC id once known; a
// channel only known by handle (e.g. from oEmbed) is keyed by the handle until the id shows up,
// at which point the two merge. Videos point at any alias and are mapped through `aliases`.

const UC_RE = /^UC[\w-]{22}$/;

export const videoKey = (pid, videoId) => `${pid}:${videoId}`;
export const splitVideoKey = (vk) => {
  const i = vk.indexOf(':');
  return { platform: vk.slice(0, i), videoId: vk.slice(i + 1) };
};

/** Clean up one channel identifier as reported by a page / API; null if unusable. */
export function normaliseAlias(a) {
  if (typeof a !== 'string') return null;
  let s = a.trim();
  try { s = decodeURIComponent(s); } catch { /* keep as is */ }
  if (!s || s.length > 200) return null;
  return s;
}

export function aliasKey(pid, alias) {
  return `${pid}:${alias.startsWith('@') ? alias.toLowerCase() : alias}`;
}

export const isChannelId = (alias) => UC_RE.test(alias);

export function emptyChannelState() {
  return { videos: {}, channels: {}, aliases: {}, resolve: { queue: [], done: 0, failed: 0, attempts: {}, nextAt: 0 } };
}

/** The canonical channel key for an alias key, or null. */
export function canonicalOf(st, key) {
  if (!key) return null;
  const c = st.aliases[key];
  return c && st.channels[c] ? c : st.channels[key] ? key : null;
}

/**
 * Record that `ids` (aliases: 'UC…', '@handle', …) belong to one channel named `name`.
 * Merges channels that turn out to be the same. Returns { key, changed }; key is null if no id.
 */
export function registerChannel(st, pid, ids, name, at = Date.now()) {
  const clean = [...new Set((ids || []).map(normaliseAlias).filter(Boolean))];
  if (!clean.length) return { key: null, changed: false };
  const keys = clean.map((a) => aliasKey(pid, a));
  const existing = [...new Set(keys.map((k) => canonicalOf(st, k)).filter(Boolean))];
  const ucKeys = clean.filter(isChannelId).map((a) => aliasKey(pid, a));
  // Prefer a channel-id key (stable), then a channel we already have, then the first alias.
  const target = existing.find((k) => isChannelId(k.slice(pid.length + 1))) || ucKeys[0] || existing[0] || keys[0];
  let changed = false;

  const rec = st.channels[target] || { platform: pid, id: target.slice(pid.length + 1), name: null, at: 0 };
  // The display id keeps its original case.
  const display = clean[keys.indexOf(target)];
  if (display && rec.id !== display && !st.channels[target]) rec.id = display;
  for (const old of existing) {
    if (old === target) continue;
    const o = st.channels[old];
    if (o && (o.at || 0) > (rec.at || 0) && o.name) { rec.name = o.name; rec.at = o.at; }
    for (const [k, v] of Object.entries(st.aliases)) if (v === old) st.aliases[k] = target;
    st.aliases[old] = target;
    delete st.channels[old];
    changed = true;
  }
  if (name && (at >= (rec.at || 0) || !rec.name) && rec.name !== name) {
    rec.name = String(name).slice(0, 200);
    rec.at = at;
    changed = true;
  }
  if (!st.channels[target]) changed = true;
  st.channels[target] = rec;
  for (const k of [target, ...keys]) {
    if (st.aliases[k] !== target) { st.aliases[k] = target; changed = true; }
  }
  return { key: target, changed };
}

/**
 * Make sure a video is known. If it has no channel yet and isn't queued or failed, queue it for
 * resolution. Returns true if the state changed.
 */
export function ensureVideo(st, vk, { resolvable = true } = {}) {
  let changed = false;
  if (!st.videos[vk]) { st.videos[vk] = { ch: null }; changed = true; }
  const v = st.videos[vk];
  if (!v.ch && !v.failed && resolvable && !st.resolve.queue.includes(vk)) {
    st.resolve.queue.push(vk);
    changed = true;
  }
  return changed;
}

/** Point a video at a channel (key from registerChannel). Returns true if it changed. */
export function setVideoChannel(st, vk, chKey) {
  const v = (st.videos[vk] ||= { ch: null });
  if (v.ch === chKey) return false;
  v.ch = chKey;
  delete v.failed;
  const i = st.resolve.queue.indexOf(vk);
  if (i >= 0) st.resolve.queue.splice(i, 1);
  return true;
}

export function addVideoSeconds(videoDays, day, vk, secs) {
  if (!(secs > 0)) return;
  const d = (videoDays[day] ||= {});
  d[vk] = (d[vk] || 0) + secs;
}

/**
 * Per-channel totals for the windows of getStats. Time on a day that isn't attributed to a
 * known channel (no video data, or a video whose channel is unknown) goes to one
 * `{id: null, name: null}` row per platform.
 * @param {object} p
 * @param {object} p.days        { day: { pid: s } } (live seconds already folded in)
 * @param {object} p.videoDays   { day: { vk: s } }
 * @param {object} p.liveVideos  { vk: s } live seconds for today
 * @param {(day) => {today, week, month}} p.windows
 */
export function channelTotals({ days, videoDays = {}, videos = {}, channels = {}, aliases = {}, liveVideos = {}, todayKey, windows }) {
  const st = { channels, aliases };
  const rows = new Map();
  const row = (pid, key) => {
    const k = `${pid}|${key || ''}`;
    let r = rows.get(k);
    if (!r) {
      const c = key ? channels[key] : null;
      r = { platform: pid, id: c ? c.id : null, name: c ? c.name || c.id : null, today: 0, week: 0, month: 0, allTime: 0 };
      rows.set(k, r);
    }
    return r;
  };
  const add = (r, w, s) => {
    r.allTime += s;
    if (w.today) r.today += s;
    if (w.week) r.week += s;
    if (w.month) r.month += s;
  };
  for (const [day, per] of Object.entries(days)) {
    const w = windows(day);
    const attributed = {};
    const vd = day === todayKey ? mergeLive(videoDays[day], liveVideos) : videoDays[day];
    for (const [vk, s] of Object.entries(vd || {})) {
      if (!(s > 0)) continue;
      const { platform } = splitVideoKey(vk);
      const ch = canonicalOf(st, videos[vk]?.ch);
      if (!ch) continue; // stays in the unknown remainder below
      add(row(platform, ch), w, s);
      attributed[platform] = (attributed[platform] || 0) + s;
    }
    for (const [pid, total] of Object.entries(per)) {
      const rest = total - (attributed[pid] || 0);
      if (rest > 0) add(row(pid, null), w, rest);
    }
  }
  return [...rows.values()].filter((r) => r.allTime > 0);
}

function mergeLive(day, live) {
  if (!Object.keys(live).length) return day;
  const out = { ...(day || {}) };
  for (const [vk, s] of Object.entries(live)) out[vk] = (out[vk] || 0) + s;
  return out;
}
