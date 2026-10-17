// fazon.nexus Track sync engine.
//
// Tracked seconds are added to a ledger per (Track week, "<Platform> - <Weekday>") while sync is
// enabled (tracker.js). A sync run sends each week's unsynced delta — floored to hundredths of an
// hour, the remainder carried — as one PATCH of `add` entries, creating missing sub-categories
// first. The ledger is updated (and persisted) right after each accepted PATCH, so a worker that
// dies mid-run never re-sends an acknowledged delta.

import { planSync, patchBody, markSynced, pruneLedger, pendingSeconds, planSubcats, CATEGORY } from '../shared/ledger.js';
import { trackWeekKey, trackWeekStart, addDays } from '../shared/time.js';
import { update, read, emptySyncState } from './store.js';
import { apiOriginPattern } from './settings.js';
import { hasSyncDataConsent } from '../shared/consent.js';
import { syncActive } from './tracker.js';
import { summaryWeeks, unposted, videoLine, appendVideoLines } from '../shared/summary.js';
import { canonicalOf, splitVideoKey } from '../shared/channels.js';
import { getPlatform } from '../platforms/index.js';

const TIMEOUT_MS = 20_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;
export const ALARM = 'fait-sync';
export const ALARM_MINUTES = 2;

class HttpError extends Error {
  constructor(status, message, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** fetch() against the Track API. Resolves {status, body}; rejects only on network errors. */
async function api(settingsLike, method, path, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(settingsLike.apiBase + '/v1/api/track' + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + settingsLike.apiKey,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty / not JSON */ }
    return { status: res.status, body: json, retryAfter: Number(res.headers.get('Retry-After')) || null };
  } finally {
    clearTimeout(t);
  }
}

const errText = (r) => r.body?.error || `HTTP ${r.status}`;

/**
 * Why the API can't be called yet, or null: the optional host permission for `apiBase`, and on
 * Firefox 140+ the optional data-collection consent (shared/consent.js). Both are requested
 * together when a key is saved / sync is turned on.
 */
async function apiAccessProblem(apiBase) {
  const host = new URL(apiBase).host;
  let origin = false;
  try {
    origin = await chrome.permissions.contains({ origins: [apiOriginPattern(apiBase)] });
  } catch { /* treated as not granted */ }
  if (!origin) return `No permission to reach ${host}. Save the API key again in Settings to grant it.`;
  if (!(await hasSyncDataConsent())) {
    return `Firefox's data-collection consent for sync isn't granted. Save the API key again in Settings to allow it.`;
  }
  return null;
}

/** The public `sync` object for getStats / syncNow. */
export function publicSync(st) {
  const s = st.syncState;
  const names = new Set(s.used || []);
  for (const w of Object.values(st.ledger)) for (const n of Object.keys(w)) names.add(n);
  return {
    state: syncActive(st.settings) ? (s.state === 'off' ? 'pending' : s.state) : 'off',
    lastSyncAt: s.lastSyncAt,
    lastError: s.lastError,
    pendingSeconds: pendingSeconds(st.ledger),
    subcats: [...names].sort(subcatOrder),
    nextAttemptAt: s.nextAttemptAt || null,
  };
}

// "YouTube - Monday" … in weekday order within each platform.
const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
function subcatOrder(a, b) {
  const [pa, da] = a.split(' - '), [pb, db] = b.split(' - ');
  return pa.localeCompare(pb) || DAY_ORDER.indexOf(da) - DAY_ORDER.indexOf(db) || a.localeCompare(b);
}

async function setSyncState(patch) {
  await update((st) => {
    Object.assign(st.syncState, patch);
    return { dirty: ['syncState'] };
  });
}

let running = null;
let queued = null;

/**
 * Run a sync. `manual` (Sync now / settings change) ignores backoff and auth-error pauses.
 * Resolves to the public sync object.
 */
export function runSync({ manual = false } = {}) {
  if (running) {
    // A manual run must see data credited after the in-flight run took its snapshot.
    if (!manual) return running;
    queued ??= running.then(() => {
      queued = null;
      return runSync({ manual: true });
    });
    return queued;
  }
  // Never overlap with a Track-total read: a PATCH landing mid-read would be counted twice/never.
  running = (totalRunning || Promise.resolve()).catch(() => {}).then(() => doSync(manual))
    .finally(() => { running = null; });
  return running;
}

async function doSync(manual) {
  const st0 = await read();
  const settings = { ...st0.settings };
  const now = Date.now();
  if (!syncActive(settings)) {
    if (st0.syncState.state !== 'off') await setSyncState({ state: 'off', lastError: null, nextAttemptAt: 0, failures: 0 });
    // A key without sync still shows the Track total.
    if (settings.apiKey) await refreshTotal(settings, { force: manual });
    return publicSync(await read());
  }
  if (!manual) {
    if (st0.syncState.state === 'auth-error') return publicSync(st0);
    if (now < (st0.syncState.nextAttemptAt || 0)) return publicSync(st0);
  }
  const accessProblem = await apiAccessProblem(settings.apiBase);
  if (accessProblem) {
    await setSyncState({ state: 'error', lastError: accessProblem });
    return publicSync(await read());
  }

  const plans = await update((st) => {
    pruneLedger(st.ledger, now);
    return { dirty: ['ledger'], result: planSync(st.ledger, now) };
  });

  try {
    await refreshGoal(settings, manual);
    if (plans.length) {
      await ensureSubcats(settings, planSubcats(plans), false);
      for (const plan of plans) await sendPlan(settings, plan);
    }
    if (settings.summaryVideos) await syncSummaries(settings);
    await update((st) => {
      pruneLedger(st.ledger, Date.now());
      Object.assign(st.syncState, {
        state: 'ok', lastError: null, failures: 0, nextAttemptAt: 0, authStatus: null,
        ...(plans.length ? { lastSyncAt: Date.now() } : {}),
      });
      return { dirty: ['ledger', 'syncState'] };
    });
  } catch (e) {
    await recordFailure(e);
  }
  // After sending, re-read the exact total (sendPlan already added the sent hours to the cache,
  // so the figure never dips meanwhile); otherwise refresh at most every ~10 min.
  await refreshTotal(settings, { force: manual || plans.length > 0 });
  return publicSync(await read());
}

async function recordFailure(e) {
  await update((st) => {
    const s = st.syncState;
    if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
      Object.assign(s, {
        authStatus: e.status,
        state: 'auth-error',
        lastError: e.status === 401
          ? `API key rejected (${e.message}). Check or replace the key in Settings.`
          : `This API key can't write (${e.message}). Create a "Read & write" key on your fazon.nexus profile.`,
        nextAttemptAt: 0,
      });
    } else if (e instanceof HttpError && e.status === 429) {
      const wait = Math.max(1, e.retryAfter || 60) * 1000;
      Object.assign(s, { state: 'pending', lastError: `Rate limited; retrying in ${Math.ceil(wait / 1000)} s`, nextAttemptAt: Date.now() + wait });
    } else {
      s.failures = (s.failures || 0) + 1;
      const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (s.failures - 1));
      const what = e instanceof HttpError ? `${e.message} (HTTP ${e.status})` : `Network error: ${e.message || e}`;
      Object.assign(s, { state: 'error', lastError: what, nextAttemptAt: Date.now() + wait });
    }
    return { dirty: ['syncState'] };
  });
}

/** Throw HttpError for anything but the expected statuses. */
function check(r, ok) {
  if (ok.includes(r.status)) return r;
  throw new HttpError(r.status, errText(r), r.retryAfter);
}

/**
 * Make sure every name exists as an active `active` sub-category on the server. Uses the cached
 * list unless `refresh`; creates what is missing (409 = someone else just made it → fine).
 */
async function ensureSubcats(settings, names, refresh) {
  const st = await read();
  const known = st.syncState.known;
  const cacheOk = !refresh && known && known.base === settings.apiBase && known.key === fingerprint(settings.apiKey);
  let have = new Set(cacheOk ? known.names : []);
  const missing = () => names.filter((n) => !have.has(n.toLowerCase()));
  if (!cacheOk || missing().length) {
    const r = check(await api(settings, 'GET', '/subcats'), [200]);
    have = new Set((r.body?.subcats || []).filter((c) => c.category === CATEGORY && !c.archived).map((c) => String(c.name).toLowerCase()));
  }
  for (const name of missing()) {
    const r = await api(settings, 'POST', '/subcats', { category: CATEGORY, name });
    if (r.status === 409 && /already/i.test(errText(r))) { have.add(name.toLowerCase()); continue; }
    check(r, [200, 201]);
    have.add(name.toLowerCase());
  }
  await update((s) => {
    s.syncState.known = { base: settings.apiBase, key: fingerprint(settings.apiKey), names: [...have] };
    s.syncState.used = [...new Set([...(s.syncState.used || []), ...names])];
    return { dirty: ['syncState'] };
  });
}

async function sendPlan(settings, plan) {
  for (let attempt = 0; ; attempt++) {
    const r = await api(settings, 'PATCH', `/weeks/${plan.week}/hours`, patchBody(plan));
    if (r.status === 200) {
      await update((st) => {
        markSynced(st.ledger, plan);
        st.syncState.lastSyncAt = Date.now();
        // Moved from "pending" into Track: keep activeAllTime + pending continuous.
        const t = st.trackTotal;
        if (t && t.hundredths != null && t.base === settings.apiBase && t.key === fingerprint(settings.apiKey)) {
          const sent = plan.entries.reduce((a, e) => a + e.hundredths, 0);
          t.hundredths += sent;
          if (Array.isArray(t.weeks)) {
            const row = t.weeks.find((w) => w[0] === plan.week);
            if (row) row[1] += sent;
            else { t.weeks.push([plan.week, sent]); t.weeks.sort((a, b) => (a[0] < b[0] ? -1 : 1)); }
          }
        }
        return { dirty: ['ledger', 'syncState', 'trackTotal'] };
      });
      return;
    }
    // A sub-category was archived / renamed / deleted on the site since we cached the list.
    if (r.status === 400 && /no sub-category named/i.test(errText(r)) && attempt === 0) {
      await ensureSubcats(settings, plan.entries.map((e) => e.subcat), true);
      continue;
    }
    throw new HttpError(r.status, `week ${plan.week}: ${errText(r)}`, r.retryAfter);
  }
}

// ---- watched videos in the week's summary (shared/summary.js) ----

let titleFetch = (...a) => fetch(...a);
/** For tests: replace the fetch used for oEmbed title lookups. */
export function configureSummaryFetch(f) { titleFetch = f; }

/**
 * Add the videos not listed yet to the summaries of the previous and current Track week: one
 * GET + PUT per week, and only when there is something new (so a quiet sync costs nothing).
 */
async function syncSummaries(settings) {
  const fp = fingerprint(settings.apiKey);
  await update((st) => {
    const log = st.summaryLog;
    if (log.base === settings.apiBase && log.key === fp && log.from) return {};
    // First run, or another account: start at the current week, nothing posted there yet.
    st.summaryLog = { from: log.from && log.base == null ? log.from : trackWeekKey(Date.now()), base: settings.apiBase, key: fp, weeks: {} };
    return { dirty: ['summaryLog'] };
  });
  const st0 = await read();
  const weeks = summaryWeeks(st0.summaryLog, Date.now());
  await update((st) => {
    for (const w of Object.keys(st.summaryLog.weeks)) if (!weeks.includes(w)) delete st.summaryLog.weeks[w];
    return { dirty: ['summaryLog'] };
  });
  for (const week of weeks) {
    const todo = unposted(st0.summaryLog, st0.videoDays, week, st0.settings);
    if (todo.length) await syncSummary(settings, week, todo);
  }
}

async function syncSummary(settings, week, todo) {
  const r = check(await api(settings, 'GET', `/weeks/${week}`), [200]);
  const current = typeof r.body?.summary === 'string' ? r.body.summary : '';
  const st = await read();
  const lines = [];
  const listed = [];  // already in the summary (written by hand, another browser…): just record
  const retry = new Set();
  for (const { vk } of todo) {
    const { platform: pid, videoId } = splitVideoKey(vk);
    const p = getPlatform(pid);
    if (!p || current.includes(videoId)) { listed.push(vk); continue; }
    const v = st.videos[vk] || {};
    let title = v.t || '';
    let channel = st.channels[canonicalOf(st, v.ch)]?.name || '';
    if (!title && p.resolveChannel) {
      try {
        const res = await p.resolveChannel(videoId, titleFetch);
        title = res?.title || '';
        channel ||= res?.name || '';
        if (title) {
          await update((s) => {
            (s.videos[vk] ||= { ch: null }).t = title;
            return { dirty: ['videos'] };
          });
        }
      } catch {
        retry.add(vk); // rate limited / offline: try again on a later sync
        continue;
      }
    }
    lines.push({ vk, line: videoLine({ title, channel, url: p.mediaUrl(videoId) }) });
  }
  const { summary, added } = appendVideoLines(current, lines.map((l) => l.line));
  if (added) check(await api(settings, 'PUT', `/weeks/${week}/summary`, { summary }), [200]);
  // Lines that didn't fit under the 10,000-character limit are recorded too: they never will.
  const done = [...listed, ...lines.map((l) => l.vk)].filter((vk) => !retry.has(vk));
  await update((s) => {
    const w = (s.summaryLog.weeks[week] ||= []);
    for (const vk of done) if (!w.includes(vk)) w.push(vk);
    return { dirty: ['summaryLog'] };
  });
}

// ---- the Track goal (for getStats.target) ----

const GOAL_MAX_AGE_MS = 10 * 60_000;

/**
 * Cache the current Track week's `active` goal (GET /weeks/{current}). Goals are write-once per
 * week, so a goal once seen is final for that week; without one we look again every ~10 min
 * (sync runs every 2 min), and on manual syncs.
 */
async function refreshGoal(settings, manual) {
  const st = await read();
  const week = trackWeekKey(Date.now());
  const fp = fingerprint(settings.apiKey);
  const g = st.trackGoal;
  const same = g && g.week === week && g.base === settings.apiBase && g.key === fp;
  if (same && (g.hours > 0 || (!manual && Date.now() - g.at < GOAL_MAX_AGE_MS))) return;
  const r = await api(settings, 'GET', `/weeks/${week}`);
  if (r.status !== 200) {
    if (r.status === 401 || r.status === 429 || r.status >= 500) throw new HttpError(r.status, errText(r), r.retryAfter);
    return; // anything else: no goal info this time
  }
  const hours = Number(r.body?.goals?.active) > 0 ? Number(r.body.goals.active) : null;
  await update((s) => {
    s.trackGoal = { week, hours, at: Date.now(), base: settings.apiBase, key: fp };
    return { dirty: ['trackGoal'] };
  });
}

/**
 * The target in effect: the Track week's active goal when syncing with a working key, else the
 * manual daily target, else none. Seconds; a weekly goal's daily share is goal ÷ 7.
 */
export function currentTarget(st, now = Date.now()) {
  const g = st.trackGoal;
  const set = st.settings;
  if (syncActive(set) && g && g.hours > 0 && g.week === trackWeekKey(now) && g.base === set.apiBase
    && g.key === fingerprint(set.apiKey) && st.syncState.authStatus !== 401) {
    const weekly = Math.round(g.hours * 3600);
    return { daily: Math.round(weekly / 7), weekly, source: 'track' };
  }
  const m = Number(set.dailyTargetMinutes);
  if (m > 0) {
    const daily = Math.round(m * 60);
    return { daily, weekly: daily * 7, source: 'manual' };
  }
  return { daily: null, weekly: null, source: null };
}

// ---- all-time Track `active` total (for getStats.track) ----

const TOTAL_MAX_AGE_MS = 10 * 60_000;
export const CHUNK_WEEKS = 260;        // the API's per-request maximum
export const FIRST_WEEK = '2000-01-01'; // the oldest Track week
let totalRunning = null;

/**
 * Sum `totals.active` of every Track week, in hundredths of an hour (exact). Pages backwards from
 * the current week in 260-week chunks and stops after a chunk without any logged week, or at the
 * first Track week. Returns { sum, weeks: [[weekKey, hundredths], …] } — weeks oldest → newest,
 * from the first week with active hours (or the current week if none) to the current week.
 */
export async function fetchActiveAllTime(settings, now = Date.now()) {
  const current = trackWeekKey(now);
  let to = current;
  let sum = 0;
  const per = new Map();
  for (let guard = 0; guard < 20 && to >= FIRST_WEEK; guard++) {
    let from = addDays(to, -7 * (CHUNK_WEEKS - 1));
    if (from < FIRST_WEEK) from = FIRST_WEEK;
    const r = await api(settings, 'GET', `/weeks?from=${from}&to=${to}`);
    if (r.status !== 200) throw new HttpError(r.status, errText(r), r.retryAfter);
    let logged = 0;
    for (const w of r.body?.weeks || []) {
      const h = Math.round((Number(w?.totals?.active) || 0) * 100);
      if (w?.logged || h) logged++;
      sum += h;
      if (typeof w?.week === 'string') per.set(w.week, (per.get(w.week) || 0) + h);
    }
    if (!logged || from === FIRST_WEEK) break;
    to = addDays(from, -7);
  }
  const keys = [...per.keys()].filter((k) => per.get(k) > 0).sort();
  const first = keys[0] && keys[0] < current ? keys[0] : current;
  const weeks = [];
  for (let k = first; k <= current; k = addDays(k, 7)) weeks.push([k, per.get(k) || 0]);
  return { sum, weeks };
}

const totalIsFor = (t, settings) => !!t && t.base === settings.apiBase && t.key === fingerprint(settings.apiKey);

/**
 * Re-read the Track total if it's missing, for another key/base, older than ~10 min, or `force`.
 * Never throws; errors go into the cached state. Returns when done (or immediately if fresh).
 */
export async function refreshTrackTotal({ force = false } = {}) {
  if (running) await running.catch(() => {}); // a sync run refreshes the total itself
  const { settings } = await read();
  if (!settings.apiKey) return;
  return refreshTotal(settings, { force });
}

function refreshTotal(settings, { force }) {
  if (totalRunning) return totalRunning;
  totalRunning = (async () => {
    const st = await read();
    const t = st.trackTotal;
    if (!force && totalIsFor(t, settings) && Date.now() - (t.fetchedAt || t.triedAt || 0) < TOTAL_MAX_AGE_MS) return;
    const base = { base: settings.apiBase, key: fingerprint(settings.apiKey) };
    const prev = totalIsFor(t, settings) ? t : null;
    let next;
    const accessProblem = await apiAccessProblem(settings.apiBase);
    if (accessProblem) {
      next = { ...base, state: 'error', hundredths: prev?.hundredths ?? null, weeks: prev?.weeks ?? null, fetchedAt: prev?.fetchedAt ?? null, triedAt: Date.now(),
        error: accessProblem };
    } else {
      try {
        const { sum, weeks } = await fetchActiveAllTime(settings);
        next = { ...base, state: 'ok', hundredths: sum, weeks, fetchedAt: Date.now(), triedAt: Date.now(), error: null };
      } catch (e) {
        const status = e instanceof HttpError ? e.status : null;
        const msg = status === 401 ? 'the API key was rejected (revoked or mistyped)'
          : status === 429 ? 'rate limited; retrying shortly'
            : status ? `${e.message} (HTTP ${status})` : `network error: ${e.message || e}`;
        next = { ...base, state: 'error', error: msg, triedAt: Date.now(),
          hundredths: status === 401 ? null : prev?.hundredths ?? null, weeks: status === 401 ? null : prev?.weeks ?? null,
          fetchedAt: status === 401 ? null : prev?.fetchedAt ?? null };
      }
    }
    await update((s) => {
      s.trackTotal = next;
      return { dirty: ['trackTotal'] };
    });
    onTotalChange();
  })().finally(() => { totalRunning = null; });
  return totalRunning;
}

let onTotalChange = () => {};
export function onTrackTotalChange(fn) { onTotalChange = fn; }

/** getStats.track */
export function publicTrack(st) {
  const set = st.settings;
  const pending = syncActive(set) ? pendingSeconds(st.ledger) : 0;
  if (!set.apiKey) return { state: 'off', activeAllTime: null, pendingSeconds: 0, fetchedAt: null, error: null, weeks: [] };
  const t = st.trackTotal;
  if (!totalIsFor(t, set) || (totalRunning && t.hundredths == null)) {
    return { state: 'loading', activeAllTime: null, pendingSeconds: pending, fetchedAt: null, error: null, weeks: [] };
  }
  return {
    state: t.state, activeAllTime: t.hundredths == null ? null : t.hundredths * 36, pendingSeconds: pending,
    fetchedAt: t.fetchedAt || null, error: t.error || null,
    // Per Track week (oldest → newest, first week with active hours → current week), seconds.
    weeks: t.hundredths == null || !Array.isArray(t.weeks) ? []
      : t.weeks.map(([week, h]) => ({ week, start: trackWeekStart(week), active: h * 36 })),
  };
}

/** True if the cached total is missing or older than the refresh interval (getStats kicks a read). */
export function trackTotalStale(st) {
  const t = st.trackTotal;
  return !!st.settings.apiKey && !totalRunning
    && (!totalIsFor(t, st.settings) || Date.now() - (t.fetchedAt || t.triedAt || 0) >= TOTAL_MAX_AGE_MS);
}

// Not a secret-preserving hash; only tells "same key as when the cache was filled".
export function fingerprint(key) {
  let h = 0;
  for (const c of String(key)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return `${String(key).length}:${h}`;
}

/**
 * testApiKey: GET /subcats proves the key is valid. Write access is probed with
 * PATCH /weeks/<current>/hours {"entries":[]}: the server checks the key's scope before reading
 * the body, so a read-only key gets 403 while a read & write key gets 400 ("send 1-100 entries")
 * — and nothing is changed either way.
 */
export async function testApiKey({ apiKey, apiBase }) {
  const settings = { apiKey: String(apiKey || '').trim(), apiBase };
  if (!settings.apiKey) return { valid: false, canWrite: null, message: 'Enter an API key.' };
  const accessProblem = await apiAccessProblem(apiBase);
  if (accessProblem) return { valid: false, canWrite: null, message: accessProblem };
  let r;
  try {
    r = await api(settings, 'GET', '/subcats');
  } catch (e) {
    return { valid: false, canWrite: null, message: `Couldn't reach ${new URL(apiBase).host}: ${e.message || e}` };
  }
  if (r.status === 401) return { valid: false, canWrite: null, message: `Key rejected: ${errText(r)}` };
  if (r.status === 429) return { valid: false, canWrite: null, message: `Rate limited; try again in ${r.retryAfter || 60} s.` };
  if (r.status !== 200) return { valid: false, canWrite: null, message: `Unexpected answer: ${errText(r)}` };

  let canWrite = null;
  try {
    const p = await api(settings, 'PATCH', `/weeks/${trackWeekKey(Date.now())}/hours`, { entries: [] });
    if (p.status === 403) canWrite = false;
    else if (p.status === 400) canWrite = true;
  } catch { /* leave null */ }
  const message = canWrite === false
    ? 'This key is read-only. Create a "Read & write" key to sync.'
    : canWrite ? 'Key works and can log hours.' : 'Key works (write access not confirmed).';
  return { valid: true, canWrite, message };
}

/** After an API key / base / enable change: forget cached server state and errors. */
export async function resetSyncConnection() {
  await update((st) => {
    const used = st.syncState.used;
    st.syncState = { ...emptySyncState(), used, lastSyncAt: st.syncState.lastSyncAt };
    return { dirty: ['syncState'] };
  });
}

export async function ensureAlarm() {
  const a = await chrome.alarms.get(ALARM);
  if (!a) await chrome.alarms.create(ALARM, { periodInMinutes: ALARM_MINUTES, delayInMinutes: 1 });
}
