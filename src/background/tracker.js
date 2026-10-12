// Tracking: turns content-script reports into credited seconds, and keeps per-tab media state for
// the popup (getStatus), the live counters and the toolbar icon.

import { getPlatform, platformForUrl, publicPlatform, PLATFORMS } from '../platforms/index.js';
import { claim } from '../shared/credit.js';
import { dayKey, splitInterval, weekdayOf, WEEKDAYS } from '../shared/time.js';
import { addToLedger } from '../shared/ledger.js';
import { addVideoSeconds, ensureVideo, registerChannel, setVideoChannel, videoKey } from '../shared/channels.js';
import { update, read, vdDirty } from './store.js';

const FRESH_MS = 15_000;            // a tab state older than this (without updates) is stale
const MAX_SEGMENT_MS = 6 * 3_600_000;

// ---- overrides ----

export const overrideKey = (scope, platform, id) => `${scope}:${platform}:${id}`;

/** { video: 'ja'|'non-ja'|null, channel: … } for a piece of media. */
export function overridesFor(overrides, platform, videoId, channelIds = []) {
  const video = overrides[overrideKey('video', platform, videoId)]?.value ?? null;
  let channel = null;
  for (const c of channelIds) {
    const o = overrides[overrideKey('channel', platform, c)];
    if (o) { channel = o.value; break; }
  }
  return { video, channel };
}

/** Video override beats channel override beats auto-detection. */
export function decideJapanese(ov, detected) {
  const v = ov.video ?? ov.channel;
  return v ? v === 'ja' : !!detected;
}

export const subcatName = (platform, dayKey) => `${platform.name} - ${WEEKDAYS[weekdayOf(dayKey)]}`;
export const syncActive = (settings) => !!(settings.syncEnabled && settings.apiKey);

// ---- per-tab state (memory, mirrored to storage.session so a restarted worker still knows) ----

let tabs = null; // { [tabId]: { [frameId]: {platform, media, at, creditedUntil, counted} } }
const session = () => globalThis.chrome?.storage?.session;

async function loadTabs() {
  if (tabs) return tabs;
  try {
    tabs = (await session()?.get('tabs'))?.tabs || {};
  } catch {
    tabs = {};
  }
  return tabs;
}

let saveTimer = null;
function saveTabs() {
  if (!session() || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    session().set({ tabs }).catch(() => {});
  }, 250);
}

export async function forgetTab(tabId) {
  await loadTabs();
  if (tabs[tabId]) {
    delete tabs[tabId];
    saveTabs();
  }
  iconState.delete(tabId);
}

// ---- crediting ----

function creditPiece(st, platform, piece, vk, dirty) {
  const pid = platform.id;
  const total = (st.credit.carry[pid] || 0) + (piece.end - piece.start);
  const secs = Math.floor(total / 1000);
  st.credit.carry[pid] = total - secs * 1000;
  if (secs <= 0) return 0;
  const day = (st.days[piece.dayKey] ??= {});
  day[pid] = (day[pid] || 0) + secs;
  addVideoSeconds(st.videoDays, piece.dayKey, vk, secs);
  dirty.add(vdDirty(piece.dayKey));
  if (syncActive(st.settings)) addToLedger(st.ledger, piece.trackWeek, subcatName(platform, piece.dayKey), secs);
  return secs;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

/**
 * Handle {type:'mediaState', platform, media, segments, videos} from a content script.
 * Returns { credited: seconds }.
 */
export async function handleMediaState(msg, sender) {
  const platform = getPlatform(msg.platform);
  if (!platform) throw new Error(`unknown platform ${msg.platform}`);
  const tabId = sender.tab?.id;
  const frameId = sender.frameId ?? 0;
  const now = Date.now();
  const segments = Array.isArray(msg.segments) ? msg.segments.slice(0, 1000) : [];
  const videos = msg.videos && typeof msg.videos === 'object' ? msg.videos : {};
  const media = sanitiseMedia(msg.media);

  const result = await update((st) => {
    let credited = 0;
    let queued = false;
    const dirty = new Set();
    const seen = new Set();
    for (const seg of segments) {
      const start = num(seg?.start), end = num(seg?.end);
      if (!(end > start) || end - start > MAX_SEGMENT_MS || typeof seg.videoId !== 'string' || seg.videoId.length > 100) continue;
      const v = videos[seg.videoId] || {};
      const ids = channelIdsOf(v);
      const ja = decideJapanese(overridesFor(st.overrides, platform.id, seg.videoId, ids), v.detected === true);
      if (!ja || (seg.muted && !st.settings.countMuted)) continue;
      const vk = videoKey(platform.id, seg.videoId);
      if (!seen.has(vk)) {
        seen.add(vk);
        // Remember the video's channel (or queue it for resolution when the page gave none).
        const name = typeof v.channel === 'string' ? v.channel.slice(0, 200) : '';
        const reg = registerChannel(st, platform.id, ids, name);
        if (reg.key) {
          if (setVideoChannel(st, vk, reg.key) || reg.changed) dirty.add('videos').add('channels').add('aliases').add('resolve');
        } else if (ensureVideo(st, vk, { resolvable: !!platform.resolveChannel })) {
          dirty.add('videos').add('resolve');
          queued = true;
        }
      }
      const r = claim(st.credit.claims, start, end, now);
      st.credit.claims = r.state;
      ['credit', 'days', 'ledger'].forEach((k) => dirty.add(k));
      for (const [a, b] of r.pieces) {
        for (const piece of splitInterval(a, b, st.settings)) credited += creditPiece(st, platform, piece, vk, dirty);
      }
    }
    // Live-counter bookkeeping for this frame.
    let counted = false;
    if (media) {
      const ov = overridesFor(st.overrides, platform.id, media.videoId, channelIdsOf(media));
      counted = media.playing && decideJapanese(ov, media.detected === true) && (!media.muted || st.settings.countMuted);
    }
    return { dirty: [...dirty], result: { credited, counted, queued } };
  });

  if (tabId !== undefined && tabId >= 0) {
    await loadTabs();
    const t = (tabs[tabId] ??= {});
    const prevUntil = t[frameId]?.creditedUntil || 0;
    const lastEnd = segments.reduce((m, s) => Math.max(m, num(s?.end) || 0), 0);
    if (media) {
      t[frameId] = {
        platform: platform.id, media, at: now, counted: result.counted,
        // Live counting resumes from the end of what was just reported (or now).
        creditedUntil: result.counted ? Math.max(prevUntil, lastEnd || now) : now,
      };
    } else {
      delete t[frameId];
      if (!Object.keys(t).length) delete tabs[tabId];
    }
    saveTabs();
    refreshIcon(tabId).catch(() => {});
  }
  return { credited: result.credited, queued: result.queued };
}

function channelIdsOf(v) {
  const ids = [];
  if (typeof v?.channelId === 'string' && v.channelId) ids.push(v.channelId);
  if (Array.isArray(v?.channelAliases)) for (const a of v.channelAliases) if (typeof a === 'string' && a && !ids.includes(a)) ids.push(a);
  return ids.slice(0, 5);
}

function sanitiseMedia(m) {
  if (!m || typeof m !== 'object' || typeof m.videoId !== 'string' || !m.videoId) return null;
  const s = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
  return {
    videoId: s(m.videoId, 100), title: s(m.title), channel: s(m.channel, 200),
    channelId: s(m.channelId, 100) || null, channelAliases: channelIdsOf(m).slice(0, 5),
    url: s(m.url, 2000),
    playing: !!m.playing, paused: !!m.paused, ended: !!m.ended, buffering: !!m.buffering, ad: !!m.ad, muted: !!m.muted,
    detected: m.detected === null ? null : !!m.detected, reason: s(m.reason, 200),
  };
}

/** Pick the most relevant frame of a tab: playing first, then the newest. */
function frameOf(tabId, { embedsOnly = false } = {}) {
  const frames = Object.entries(tabs?.[tabId] || {})
    .filter(([frameId]) => !embedsOnly || Number(frameId) !== 0)
    .map(([, f]) => f);
  frames.sort((a, b) => (b.media.playing - a.media.playing) || (b.at - a.at));
  return frames[0] || null;
}

/** Response for {type:'getStatus', tabId}. */
export async function getStatus(tabId) {
  await loadTabs();
  const st = await read();
  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch { /* closed */ }
  // The tab's URL is only visible for sites we have host access to. On a platform page use any
  // frame's state; elsewhere only embedded players (iframes) can be relevant — a stored top-frame
  // state there is left over from a page the tab has navigated away from.
  const pagePlatform = platformForUrl(tab?.url);
  const f = frameOf(tabId, { embedsOnly: !pagePlatform });
  const platform = pagePlatform || (f ? getPlatform(f.platform) : null);

  const origins = (platform ? [platform] : PLATFORMS).flatMap((p) => p.matches);
  let hasSitePermission = false;
  try { hasSitePermission = await chrome.permissions.contains({ origins }); } catch { /* ignore */ }

  let media = null;
  let tracking = false;
  if (f) {
    const m = f.media;
    const ov = overridesFor(st.overrides, f.platform, m.videoId, channelIdsOf(m));
    const japanese = decideJapanese(ov, m.detected === true);
    const vk = videoKey(f.platform, m.videoId);
    const todayKey = dayKey(Date.now(), st.settings);
    const live = (await liveSeconds(st)).video[vk] || 0;
    media = {
      videoId: m.videoId, title: m.title, channel: m.channel, channelId: m.channelId, url: m.url,
      playing: m.playing, japanese, detected: m.detected === true, override: ov,
      sessionSeconds: (st.videoDays[todayKey]?.[vk] || 0) + live,
      // extras (not in the protocol table)
      checking: m.detected === null, reason: m.reason, muted: m.muted, ad: m.ad, paused: m.paused,
      buffering: m.buffering, countMuted: !!st.settings.countMuted, platform: f.platform,
    };
    tracking = Date.now() - f.at < FRESH_MS && m.playing && japanese && (!m.muted || st.settings.countMuted);
  }
  return { platform: publicPlatform(platform), hasSitePermission, media, tracking };
}

/**
 * Seconds being played right now but not credited yet (for smooth counters):
 * { platform: { youtube: s }, video: { 'youtube:<id>': s } }. Platform = sum of its videos.
 */
export async function liveSeconds(st) {
  await loadTabs();
  const now = Date.now();
  let claims = st.credit.claims;
  const platform = {};
  const video = {};
  for (const frames of Object.values(tabs)) {
    for (const f of Object.values(frames)) {
      if (!f.counted || now - f.at > 10_000) continue;
      const r = claim(claims, f.creditedUntil, now, now);
      claims = r.state;
      const secs = Math.floor(r.pieces.reduce((t, [a, b]) => t + b - a, 0) / 1000);
      if (secs <= 0) continue;
      const vk = videoKey(f.platform, f.media.videoId);
      video[vk] = (video[vk] || 0) + secs;
      platform[f.platform] = (platform[f.platform] || 0) + secs;
    }
  }
  return { platform, video };
}

/** Recompute `counted` for every tab after an override / settings change. */
export async function recomputeTabs() {
  await loadTabs();
  const st = await read();
  for (const [tabId, frames] of Object.entries(tabs)) {
    for (const f of Object.values(frames)) {
      const ov = overridesFor(st.overrides, f.platform, f.media.videoId, channelIdsOf(f.media));
      const counted = f.media.playing && decideJapanese(ov, f.media.detected === true) && (!f.media.muted || st.settings.countMuted);
      if (counted && !f.counted) f.creditedUntil = Date.now();
      f.counted = counted;
    }
    refreshIcon(Number(tabId)).catch(() => {});
  }
  saveTabs();
}

// ---- toolbar icon ----
// active   = counting Japanese right now
// inactive = media on the page that isn't being counted (non-Japanese, paused, muted, ad…)
// default  = nothing to track
// Uses icons/icon-active-N.png / icons/icon-inactive-N.png; if those can't be loaded, falls back
// to a coloured badge dot.

const iconState = new Map();
let useBadge = false;
const SIZES = [16, 32];
const iconPaths = (suffix) => Object.fromEntries(SIZES.map((n) => [n, `/icons/icon${suffix}-${n}.png`]));

async function refreshIcon(tabId) {
  const f = frameOf(tabId);
  let state = 'default';
  if (f) state = f.counted && Date.now() - f.at < FRESH_MS ? 'active' : 'inactive';
  if (iconState.get(tabId) === state) return;
  iconState.set(tabId, state);
  if (!chrome.action) return;
  if (!useBadge) {
    try {
      await chrome.action.setIcon({ tabId, path: iconPaths(state === 'default' ? '' : `-${state}`) });
      return;
    } catch (e) {
      if (/tab/i.test(String(e?.message))) return; // tab gone
      useBadge = true; // icon files missing: use the badge from now on
    }
  }
  try {
    await chrome.action.setBadgeText({ tabId, text: state === 'default' ? '' : '●' });
    if (state !== 'default') {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: state === 'active' ? '#e8833a' : '#6b7280' });
    }
  } catch { /* tab gone */ }
}

export async function refreshAllIcons() {
  await loadTabs();
  for (const tabId of Object.keys(tabs)) refreshIcon(Number(tabId)).catch(() => {});
}
