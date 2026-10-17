// Background entry point (Chrome: module service worker; Firefox: module event page).
// All listeners are registered synchronously at top level, as MV3 requires.

import { platformNames, getPlatform } from '../platforms/index.js';
import { computeStats } from '../shared/stats.js';
import { emptyCreditState } from '../shared/credit.js';
import { update, read, emptySyncState } from './store.js';
import { applySettingsPatch, SYNC_KEYS, DEFAULT_API_BASE, normaliseApiBase } from './settings.js';
import {
  handleMediaState, getStatus, liveSeconds, recomputeTabs, forgetTab, overrideKey, refreshAllIcons,
} from './tracker.js';
import {
  runSync, publicSync, testApiKey, resetSyncConnection, ensureAlarm, ALARM, currentTarget,
  publicTrack, refreshTrackTotal, trackTotalStale, onTrackTotalChange,
} from './sync.js';
import { exportState, applyImport } from './datafmt.js';
import { runResolver, resolveProgress, configureResolver, RESOLVE_ALARM } from './resolver.js';
import { emptyChannelState } from '../shared/channels.js';
import { trackWeekKey } from '../shared/time.js';

// ---- statsChanged broadcast (coalesced) ----

let broadcastTimer = null;
function broadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    chrome.runtime.sendMessage({ type: 'statsChanged' }).catch(() => { /* no page open */ });
  }, 100);
}

// ---- handlers ----

async function getStats() {
  const st = await read();
  const live = await liveSeconds(st);
  const now = Date.now();
  // Never wait for the network here: kick a background read of the Track total if it's stale.
  if (trackTotalStale(st)) refreshTrackTotal().catch(() => {});
  return {
    ...computeStats({
      days: st.days, now, settings: st.settings, platformNames: platformNames(),
      live: live.platform, liveVideos: live.video,
      channelData: { videoDays: st.videoDays, videos: st.videos, channels: st.channels, aliases: st.aliases },
    }),
    target: currentTarget(st, now),
    resolve: resolveProgress(st),
    track: publicTrack(st),
    settings: { ...st.settings },
    sync: publicSync(st),
  };
}

async function setOverride({ scope, platform, id, label, value }) {
  if (scope !== 'video' && scope !== 'channel') throw new Error("scope must be 'video' or 'channel'");
  if (!getPlatform(platform)) throw new Error(`unknown platform ${platform}`);
  if (typeof id !== 'string' || !id || id.length > 200) throw new Error('id is required');
  if (value !== null && value !== 'ja' && value !== 'non-ja') throw new Error("value must be 'ja', 'non-ja' or null");
  await update((st) => {
    const key = overrideKey(scope, platform, id);
    if (value === null) delete st.overrides[key];
    else st.overrides[key] = { scope, platform, id, label: String(label ?? '').slice(0, 300), value, at: Date.now() };
    return { dirty: ['overrides'] };
  });
  await recomputeTabs();
  return {};
}

async function getOverrides() {
  const st = await read();
  return { overrides: Object.values(st.overrides).sort((a, b) => b.at - a.at) };
}

async function setSettings({ patch }) {
  let syncChanged = false;
  let keyChanged = false;
  let summaryOn = false;
  const settings = await update((st) => {
    const next = applySettingsPatch(st.settings, patch);
    syncChanged = SYNC_KEYS.some((k) => next[k] !== st.settings[k]);
    keyChanged = next.apiKey !== st.settings.apiKey || next.apiBase !== st.settings.apiBase;
    summaryOn = next.summaryVideos && !st.settings.summaryVideos;
    // Turning the video list on starts it at the current Track week (filled in from local data).
    if (summaryOn) st.summaryLog.from = trackWeekKey(Date.now());
    st.settings = next;
    return { dirty: summaryOn ? ['settings', 'summaryLog'] : ['settings'], result: { ...next } };
  });
  if (syncChanged) {
    await resetSyncConnection();
    if (settings.syncEnabled && settings.apiKey) runSync({ manual: true }).then(broadcast, () => {});
    // A key without sync: still read the Track total (a sync run does it otherwise).
    else if (keyChanged && settings.apiKey) refreshTrackTotal({ force: true }).then(broadcast, () => {});
  } else if (summaryOn && settings.syncEnabled && settings.apiKey) runSync({ manual: true }).then(broadcast, () => {});
  await recomputeTabs();
  return { settings };
}

async function importData({ data, mode = 'merge' }) {
  const imported = await update((st) => ({
    dirty: ['days', 'videoDays', 'overrides', 'imports', 'settings', 'videos', 'channels', 'aliases', 'resolve'],
    result: applyImport(st, data, mode),
  }));
  await recomputeTabs();
  runResolver().catch((e) => console.warn('[fait] resolve', e));
  return { imported };
}

async function resetData() {
  await update((st) => {
    st.days = {};
    st.videoDays = {};
    Object.assign(st, emptyChannelState());
    st.overrides = {};
    st.imports = {};
    st.ledger = {};
    st.credit = { claims: { ...emptyCreditState(), horizon: Date.now() }, carry: {} };
    st.syncState = emptySyncState();
    return { dirty: ['days', 'videoDays', 'videos', 'channels', 'aliases', 'resolve', 'overrides', 'imports', 'ledger', 'credit', 'syncState'] };
  });
  await recomputeTabs();
  return {};
}

const UI_HANDLERS = {
  getStatus: (m) => getStatus(Number(m.tabId)),
  setOverride,
  getOverrides,
  getStats,
  getSettings: async () => ({ settings: { ...(await read()).settings } }),
  setSettings,
  testApiKey: (m) => testApiKey({ apiKey: m.apiKey, apiBase: normaliseApiBase(m.apiBase || DEFAULT_API_BASE) }),
  syncNow: async () => ({ sync: await runSync({ manual: true }) }),
  exportData: async () => ({ data: exportState(await read()) }),
  importData,
  resetData,
};
// Handlers whose success changes what the stats / status show.
const CHANGES_STATS = new Set(['setOverride', 'setSettings', 'syncNow', 'importData', 'resetData']);

const extensionOrigin = chrome.runtime.getURL('');

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || msg.type === 'statsChanged') return false;
  let work;
  if (msg.type === 'mediaState') {
    if (!sender.tab) return false;
    work = handleMediaState(msg, sender).then((r) => {
      if (r.credited > 0) broadcast();
      if (r.queued) runResolver().catch(() => {});
      return { credited: r.credited };
    });
  } else if (UI_HANDLERS[msg.type]) {
    // Only extension pages (popup, dashboard) may use the UI API, not content scripts.
    if (!(sender.url || '').startsWith(extensionOrigin)) return false;
    work = UI_HANDLERS[msg.type](msg).then((r) => {
      if (CHANGES_STATS.has(msg.type)) broadcast();
      return r;
    });
  } else {
    return false;
  }
  work.then(
    (r) => sendResponse({ ok: true, ...r }),
    (e) => {
      console.warn('[fait]', msg.type, e);
      sendResponse({ ok: false, error: String(e?.message || e) });
    },
  );
  return true; // async response
});

chrome.tabs.onRemoved.addListener((tabId) => { forgetTab(tabId); });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) {
    // runSync refreshes the Track total too (also with sync off, as long as a key is set).
    runSync().then(broadcast, (e) => console.warn('[fait] sync', e));
  }
  if (alarm.name === RESOLVE_ALARM) runResolver().catch((e) => console.warn('[fait] resolve', e));
});

chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); refreshAllIcons(); });

// Every wake-up: make sure the alarm exists and storage is initialised; resume channel resolution.
configureResolver({ progress: broadcast });
onTrackTotalChange(broadcast);
ensureAlarm().catch(() => {});
read().then((st) => { if (st.resolve.queue.length) runResolver().catch(() => {}); },
  (e) => console.error('[fait] storage load failed', e));
