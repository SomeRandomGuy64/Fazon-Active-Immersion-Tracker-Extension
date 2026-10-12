// Export / import formats. Pure functions over the stored state (see store.js).
//
// Accepted imports:
//  - our own export: { format: 'fazon-active-immersion-tracker', version: 1, days, overrides, settings, imports }
//  - Mikan 見間: chrome.storage.local `watchData` = { 'YYYY-MM-DD': { totalSeconds, videos } },
//    as { watchData: {...} } or the bare object. Its dates are local-midnight days; each date's
//    totalSeconds goes to that day key on platform 'youtube', and each video's seconds are kept
//    per day so the time can be attributed to channels once the videos are resolved (resolver.js).
//
// Imported time is history only: it never enters the Track sync ledger.

import { isDayKey } from '../shared/time.js';
import { addVideoSeconds, ensureVideo, registerChannel, setVideoChannel, videoKey } from '../shared/channels.js';
import { applySettingsPatch } from './settings.js';

export const FORMAT = 'fazon-active-immersion-tracker';
export const FORMAT_VERSION = 2; // 2 adds videoDays / videos / channels / aliases (1 still imports)
const MAX_DAY_SECONDS = 90_000; // 25 h: the longest possible (DST) day
const MIKAN_PLATFORM = 'youtube';

const secs = (v) => {
  const n = Math.round(Number(v)); // Mikan stores fractional seconds
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_DAY_SECONDS) : 0;
};

export function exportState(st, now = Date.now()) {
  const settings = { ...st.settings };
  delete settings.apiKey; // never export the key
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    exportedAt: new Date(now).toISOString(),
    settings,
    days: structuredClone(st.days),
    videoDays: structuredClone(st.videoDays),
    videos: Object.fromEntries(Object.entries(st.videos).filter(([, v]) => v.ch).map(([k, v]) => [k, { ch: v.ch }])),
    channels: structuredClone(st.channels),
    aliases: structuredClone(st.aliases),
    overrides: Object.values(st.overrides),
    imports: structuredClone(st.imports || {}),
  };
}

/** What kind of import this is: 'native' | 'mikan' | null. */
export function detectFormat(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.format === FORMAT) return 'native';
  if (data.watchData && typeof data.watchData === 'object') return 'mikan';
  const keys = Object.keys(data);
  if (keys.length && keys.every((k) => isDayKey(k) && data[k] && typeof data[k] === 'object' && 'totalSeconds' in data[k])) {
    return 'mikan';
  }
  if (keys.length === 0) return 'mikan'; // an empty Mikan store
  return null;
}

/**
 * Apply an import to the state in place. Returns { format, days, seconds } (days touched and
 * seconds added). Throws Error on unrecognised data.
 */
export function applyImport(st, data, mode = 'merge') {
  if (mode !== 'merge' && mode !== 'replace') throw new Error("mode must be 'merge' or 'replace'");
  const format = detectFormat(data);
  if (!format) throw new Error('Unrecognised file: expected an export from this extension or Mikan data (watchData).');
  return format === 'mikan' ? importMikan(st, data.watchData || data, mode) : importNative(st, data, mode);
}

const MIKAN_VIDEO_RE = /^[\w-]{11}$/;

function importMikan(st, watchData, mode) {
  if (mode === 'replace') clearHistory(st);
  const done = ((st.imports ||= {}).mikan ||= {});
  const queuedBefore = st.resolve.queue.length;
  let days = 0, seconds = 0;
  for (const [key, rec] of Object.entries(watchData)) {
    if (!isDayKey(key) || !rec || typeof rec !== 'object') continue;
    const vids = rec.videos && typeof rec.videos === 'object' ? rec.videos : {};
    let total = secs(rec.totalSeconds);
    if (!total) total = secs(Object.values(vids).reduce((a, b) => a + (Number(b) || 0), 0));
    // A v1 record is a plain number (the day total, no per-video data).
    const prev = typeof done[key] === 'number' ? { total: done[key], videos: {} } : done[key] || { total: 0, videos: {} };
    // Only the increase since the last import of this date: re-importing never double-counts,
    // and a newer Mikan export adds just what was watched since.
    const add = total - prev.total;
    let touched = false;
    if (add > 0) {
      const d = (st.days[key] ||= {});
      d[MIKAN_PLATFORM] = (d[MIKAN_PLATFORM] || 0) + add;
      seconds += add;
      touched = true;
    }
    const next = { total: Math.max(total, prev.total), videos: { ...prev.videos } };
    for (const [vid, v] of Object.entries(vids)) {
      if (!MIKAN_VIDEO_RE.test(vid)) continue;
      const s = secs(v);
      const inc = s - (prev.videos[vid] || 0);
      if (inc <= 0) continue;
      const vk = videoKey(MIKAN_PLATFORM, vid);
      addVideoSeconds(st.videoDays, key, vk, inc);
      ensureVideo(st, vk);
      next.videos[vid] = s;
      touched = true;
    }
    done[key] = next;
    if (touched) days++;
  }
  return { format: 'mikan', days, seconds, queued: st.resolve.queue.length - queuedBefore };
}

function clearHistory(st) {
  st.days = {};
  st.videoDays = {};
  st.imports = {};
}

function importNative(st, data, mode) {
  if (data.version > FORMAT_VERSION) throw new Error(`This export is from a newer version (format ${data.version}).`);
  const inDays = data.days && typeof data.days === 'object' ? data.days : {};
  if (mode === 'replace') {
    clearHistory(st);
    st.overrides = {};
  }
  let days = 0, seconds = 0;
  for (const [key, per] of Object.entries(inDays)) {
    if (!isDayKey(key) || !per || typeof per !== 'object') continue;
    let touched = false;
    for (const [pid, v] of Object.entries(per)) {
      if (!/^[a-z0-9_-]{1,32}$/.test(pid)) continue;
      const s = secs(v);
      const cur = st.days[key]?.[pid] || 0;
      // Merge takes the larger value per day and platform, so importing a backup twice (or a
      // backup of the same browser) never double-counts.
      if (s > cur) {
        (st.days[key] ||= {})[pid] = s;
        seconds += s - cur;
        touched = true;
      }
    }
    if (touched) days++;
  }
  // Per-video time and channels (format 2): larger value per day and video, channels merged.
  if (data.videoDays && typeof data.videoDays === 'object') {
    for (const [key, per] of Object.entries(data.videoDays)) {
      if (!isDayKey(key) || !per || typeof per !== 'object') continue;
      for (const [vk, v] of Object.entries(per)) {
        if (!/^[a-z0-9_-]{1,32}:[\w-]{1,100}$/.test(vk)) continue;
        const cur = st.videoDays[key]?.[vk] || 0;
        const s = secs(v);
        if (s > cur) addVideoSeconds(st.videoDays, key, vk, s - cur);
      }
    }
  }
  if (data.aliases && typeof data.aliases === 'object') {
    const groups = {};
    for (const [alias, canon] of Object.entries(data.aliases)) {
      if (typeof canon === 'string') (groups[canon] ||= []).push(alias);
    }
    for (const [canon, list] of Object.entries(groups)) {
      const c = data.channels?.[canon];
      const pid = canon.slice(0, canon.indexOf(':'));
      if (!pid) continue;
      const ids = [...new Set([canon, ...list])].map((k) => k.slice(pid.length + 1));
      if (c?.id) ids.unshift(String(c.id));
      registerChannel(st, pid, ids, c?.name || null, Number(c?.at) || 0);
    }
  }
  if (data.videos && typeof data.videos === 'object') {
    for (const [vk, v] of Object.entries(data.videos)) {
      if (typeof v?.ch === 'string' && !st.videos[vk]?.ch && st.aliases[v.ch]) setVideoChannel(st, vk, v.ch);
    }
  }
  // Videos with time but no channel yet go to the resolution queue.
  for (const per of Object.values(st.videoDays)) for (const vk of Object.keys(per)) if (!st.videos[vk]?.ch) ensureVideo(st, vk);

  const list = Array.isArray(data.overrides) ? data.overrides : Object.values(data.overrides || {});
  for (const o of list) {
    if (!o || !['video', 'channel'].includes(o.scope) || !['ja', 'non-ja'].includes(o.value)) continue;
    if (typeof o.platform !== 'string' || typeof o.id !== 'string' || !o.id) continue;
    const key = `${o.scope}:${o.platform}:${o.id}`;
    const cur = st.overrides[key];
    if (!cur || (Number(o.at) || 0) > (cur.at || 0)) {
      st.overrides[key] = {
        scope: o.scope, platform: o.platform, id: o.id.slice(0, 200), label: String(o.label || '').slice(0, 300),
        value: o.value, at: Number(o.at) || Date.now(),
      };
    }
  }
  const mk = data.imports?.mikan;
  if (mk && typeof mk === 'object') {
    const done = ((st.imports ||= {}).mikan ||= {});
    for (const [k, v] of Object.entries(mk)) {
      if (!isDayKey(k)) continue;
      const inV = typeof v === 'number' ? { total: secs(v), videos: {} } : { total: secs(v?.total), videos: v?.videos || {} };
      const cur = typeof done[k] === 'number' ? { total: done[k], videos: {} } : done[k] || { total: 0, videos: {} };
      const videos = { ...cur.videos };
      for (const [vid, s] of Object.entries(inV.videos)) if (MIKAN_VIDEO_RE.test(vid)) videos[vid] = Math.max(videos[vid] || 0, secs(s));
      done[k] = { total: Math.max(cur.total, inV.total), videos };
    }
  }
  if (mode === 'replace' && data.settings && typeof data.settings === 'object') {
    // Day/week preferences come along; the sync connection (key, base, enabled) stays as it is.
    const rest = { ...data.settings };
    for (const k of ['apiKey', 'apiBase', 'syncEnabled']) delete rest[k];
    try { st.settings = applySettingsPatch(st.settings, rest); } catch { /* keep current settings */ }
  }
  return { format: 'native', days, seconds };
}
