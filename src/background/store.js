// Persistent state in chrome.storage.local, cached in memory for the life of the service worker.
//
// Every change goes through update(), which serialises read-modify-write cycles (messages from
// several tabs arrive concurrently) and writes the changed keys before resolving — so when a
// content script gets its acknowledgement, the credited time is already on disk. The MV3 worker
// can be killed at any moment after that without losing anything.
//
// Keys (schema 2):
//   schema     2
//   settings   see settings.js
//   days       { 'YYYY-MM-DD': { <platformId>: seconds } }            (all time, per platform)
//   vd:YYYY-MM { 'YYYY-MM-DD': { '<platformId>:<videoId>': seconds } } (per video; one key a month,
//              so a heartbeat rewrites one month, not the whole history; in memory: st.videoDays)
//   videos, channels, aliases, resolve   see shared/channels.js
//   overrides  { '<scope>:<platform>:<id>': {scope, platform, id, label, value, at} }
//   credit     { claims: {horizon, spans}, carry: { <platformId>: ms } }   (no-double-count state)
//   ledger     Track sync ledger, see shared/ledger.js
//   syncState  { state, lastSyncAt, lastError, failures, nextAttemptAt, authStatus, known, used }
//   trackGoal  { week, hours, at, base, key } | null   (the current Track week's active goal)
//   trackTotal { base, key, state, hundredths, fetchedAt, triedAt, error } | null  (all-time Track active)
//   imports    { mikan: { 'YYYY-MM-DD': { total, videos: {videoId: s} } } }  (re-import guard)
//
// Schema 1 → 2: adds the per-video / channel keys empty; older time has no video data and shows
// as the "unknown channel" row. Mikan import records that are plain numbers stay valid.
//
// update() callers list dirty keys; 'videoDays:YYYY-MM' writes one month, 'videoDays' all of them.

import { DEFAULT_SETTINGS } from './settings.js';
import { emptyCreditState } from '../shared/credit.js';
import { emptyChannelState } from '../shared/channels.js';

export const SCHEMA = 2;
export const KEYS = ['schema', 'settings', 'days', 'overrides', 'credit', 'ledger', 'syncState', 'imports',
  'videos', 'channels', 'aliases', 'resolve', 'trackGoal', 'trackTotal'];
const VD_PREFIX = 'vd:';

export const emptySyncState = () => ({
  state: 'off', lastSyncAt: null, lastError: null, failures: 0, nextAttemptAt: 0, authStatus: null,
  known: null, used: [],
});

export function defaults() {
  return {
    schema: SCHEMA,
    settings: { ...DEFAULT_SETTINGS },
    days: {},
    videoDays: {},
    overrides: {},
    credit: { claims: emptyCreditState(), carry: {} },
    ledger: {},
    syncState: emptySyncState(),
    trackGoal: null,
    trackTotal: null,
    imports: {},
    ...emptyChannelState(),
  };
}

/** Raw storage contents → state. Fills in missing keys / fields (migrations live here). */
export function migrate(raw) {
  const d = defaults();
  const st = { ...d };
  for (const k of KEYS) if (raw[k] !== undefined) st[k] = raw[k];
  st.settings = { ...d.settings, ...(raw.settings || {}) };
  st.credit = { ...d.credit, ...(raw.credit || {}) };
  st.credit.claims ||= emptyCreditState();
  st.credit.carry ||= {};
  st.syncState = { ...d.syncState, ...(raw.syncState || {}) };
  st.resolve = { ...d.resolve, ...(raw.resolve || {}) };
  st.resolve.attempts ||= {};
  for (const k of ['videos', 'channels', 'aliases', 'imports', 'days', 'overrides', 'ledger']) st[k] ||= {};
  st.videoDays = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith(VD_PREFIX) && v && typeof v === 'object') Object.assign(st.videoDays, v);
  }
  st.schema = SCHEMA;
  return st;
}

let cache = null;
let loading = null;
let chain = Promise.resolve();
let vdMonths = new Set(); // vd:YYYY-MM keys currently in storage

export function load() {
  if (cache) return Promise.resolve(cache);
  loading ??= chrome.storage.local.get(null).then((raw) => {
    const st = migrate(raw);
    vdMonths = new Set(Object.keys(raw).filter((k) => k.startsWith(VD_PREFIX)));
    cache = st;
    const write = Object.fromEntries(KEYS.filter((k) => raw[k] === undefined || (k === 'schema' && raw[k] !== SCHEMA)).map((k) => [k, st[k]]));
    return Object.keys(write).length ? chrome.storage.local.set(write) : null;
  }).then(() => cache, (e) => { loading = null; throw e; });
  return loading;
}

/** The storage writes / removals for a set of dirty keys. */
function persistPlan(st, dirty) {
  const set = {};
  const remove = [];
  const months = new Set();
  let allMonths = false;
  for (const k of dirty) {
    if (k === 'videoDays') allMonths = true;
    else if (k.startsWith('videoDays:')) months.add(k.slice('videoDays:'.length));
    else set[k] = st[k];
  }
  if (allMonths) {
    for (const day of Object.keys(st.videoDays)) months.add(day.slice(0, 7));
    for (const key of vdMonths) if (!months.has(key.slice(VD_PREFIX.length))) remove.push(key);
  }
  for (const m of months) {
    const part = {};
    for (const [day, v] of Object.entries(st.videoDays)) if (day.startsWith(m)) part[day] = v;
    set[VD_PREFIX + m] = part;
  }
  return { set, remove };
}

/**
 * Run fn(state) exclusively. fn mutates state and returns { dirty: [keys], result }; dirty keys
 * are written before the returned promise resolves with `result`.
 */
export function update(fn) {
  const run = chain.then(async () => {
    const st = await load();
    const out = (await fn(st)) || {};
    if (out.dirty?.length) {
      const { set, remove } = persistPlan(st, new Set(out.dirty));
      if (remove.length) {
        await chrome.storage.local.remove(remove);
        for (const k of remove) vdMonths.delete(k);
      }
      if (Object.keys(set).length) await chrome.storage.local.set(set);
      for (const k of Object.keys(set)) if (k.startsWith(VD_PREFIX)) vdMonths.add(k);
    }
    return out.result;
  });
  chain = run.catch(() => {});
  return run;
}

/** Read-only access to the current state (do not mutate). */
export async function read() {
  await chain;
  return load();
}

/** Dirty token for the month of a day key. */
export const vdDirty = (day) => `videoDays:${day.slice(0, 7)}`;
