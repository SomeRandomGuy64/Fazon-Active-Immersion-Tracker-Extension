// Video → channel resolution queue (Mikan imports, and tracked videos the page gave no channel for).
//
// The queue lives in storage (`resolve`), so it survives worker restarts: an alarm wakes it every
// minute while anything is queued. A run works through the queue a few requests at a time,
// persisting after each batch, for at most ~25 s, then hands over to the next run. Unresolvable
// videos (deleted, private, …) are marked failed and their time stays under "Unknown channel".

import { getPlatform } from '../platforms/index.js';
import { registerChannel, setVideoChannel, splitVideoKey } from '../shared/channels.js';
import { update, read } from './store.js';

export const RESOLVE_ALARM = 'fait-resolve';
const CONCURRENCY = 4;
const BATCH_PAUSE_MS = 250;
const RUN_BUDGET_MS = 25_000;
const MAX_ATTEMPTS = 5;

let running = null;
let fetchImpl = (...a) => fetch(...a);
let onProgress = () => {};

/** For tests: replace fetch; and a callback after each batch (the router broadcasts statsChanged). */
export function configureResolver({ fetch: f, progress } = {}) {
  if (f) fetchImpl = f;
  if (progress) onProgress = progress;
}

export function resolveProgress(st) {
  return { pending: st.resolve.queue.length, done: st.resolve.done || 0, failed: st.resolve.failed || 0 };
}

/** Start (or join) a resolution run. Resolves when the run ends (queue empty, budget or backoff). */
export function runResolver() {
  running ??= doRun().finally(() => { running = null; });
  return running;
}

async function doRun() {
  const started = Date.now();
  await scheduleAlarm();
  for (;;) {
    const st = await read();
    const q = st.resolve.queue;
    if (!q.length) break;
    if (Date.now() < (st.resolve.nextAt || 0)) break;
    if (Date.now() - started > RUN_BUDGET_MS) {
      setTimeout(() => runResolver(), 1000); // continue soon if the worker stays alive; else the alarm does
      break;
    }
    const batch = q.slice(0, CONCURRENCY);
    const results = await Promise.all(batch.map(async (vk) => {
      const { platform, videoId } = splitVideoKey(vk);
      const p = getPlatform(platform);
      if (!p?.resolveChannel) return { vk, platform, result: null };
      try {
        return { vk, platform, result: await p.resolveChannel(videoId, fetchImpl) };
      } catch (e) {
        return { vk, platform, error: e };
      }
    }));
    await update((s) => {
      const r = s.resolve;
      let backoff = 0;
      for (const { vk, platform, result, error } of results) {
        if (!r.queue.includes(vk)) continue; // resolved meanwhile (e.g. by live tracking)
        if (error) {
          const n = (r.attempts[vk] || 0) + 1;
          if (error.retryAfter) backoff = Math.max(backoff, error.retryAfter * 1000);
          if (n >= MAX_ATTEMPTS) {
            fail(s, vk);
          } else {
            r.attempts[vk] = n;
            r.queue.splice(r.queue.indexOf(vk), 1);
            r.queue.push(vk); // to the back; try the others first
            backoff = Math.max(backoff, 5_000 * n);
          }
        } else if (result) {
          const { key } = registerChannel(s, platform, result.ids, result.name);
          if (key) {
            setVideoChannel(s, vk, key);
            if (result.title && !s.videos[vk].t) s.videos[vk].t = result.title;
            r.done = (r.done || 0) + 1;
            delete r.attempts[vk];
          } else {
            fail(s, vk);
          }
        } else {
          fail(s, vk);
        }
      }
      if (backoff) r.nextAt = Date.now() + backoff;
      return { dirty: ['resolve', 'videos', 'channels', 'aliases'] };
    });
    onProgress();
    await new Promise((res) => setTimeout(res, BATCH_PAUSE_MS));
  }
  await scheduleAlarm();
}

function fail(s, vk) {
  const r = s.resolve;
  const i = r.queue.indexOf(vk);
  if (i >= 0) r.queue.splice(i, 1);
  (s.videos[vk] ||= { ch: null }).failed = true;
  r.failed = (r.failed || 0) + 1;
  delete r.attempts[vk];
}

/** Keep a 1-minute alarm while anything is queued (wakes a stopped worker), none otherwise. */
async function scheduleAlarm() {
  const st = await read();
  const want = st.resolve.queue.length > 0;
  try {
    const have = await chrome.alarms.get(RESOLVE_ALARM);
    if (want && !have) await chrome.alarms.create(RESOLVE_ALARM, { periodInMinutes: 1 });
    if (!want && have) await chrome.alarms.clear(RESOLVE_ALARM);
  } catch { /* alarms unavailable (tests) */ }
}
