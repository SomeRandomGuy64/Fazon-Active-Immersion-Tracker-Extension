// fazon.nexus Track sync ledger. Pure.
//
// The ledger counts seconds per (Track week, sub-category name):
//   { '<weekKey>': { '<subcat name>': { credited: s, synced: s } } }
// `credited` grows as time is tracked; `synced` is what the server has acknowledged. A sync sends
// `add` = the unsynced delta floored to whole hundredths of an hour (36 s), so the sub-36 s
// remainder carries over to the next sync instead of being rounded away (or up) every 2 minutes.
// Once a week is over (plus a grace period for late reports) its last remainder is rounded to the
// nearest hundredth — the API's own rounding — so nothing is systematically lost.

import { trackWeekEnd } from './time.js';
import { hundredthsToDecimal } from './format.js';

export const HUNDREDTH_S = 36;
export const CLOSE_GRACE_MS = 15 * 60_000;
export const MAX_ENTRIES = 100; // the API's per-request limit
export const CATEGORY = 'active';

export function addToLedger(ledger, week, subcat, seconds) {
  if (!(seconds > 0)) return ledger;
  const w = (ledger[week] ??= {});
  const row = (w[subcat] ??= { credited: 0, synced: 0 });
  row.credited += seconds;
  return ledger;
}

const isClosed = (week, now) => now >= trackWeekEnd(week) + CLOSE_GRACE_MS;

/**
 * What to send now: [{ week, entries: [{subcat, hundredths}] }], at most MAX_ENTRIES per item,
 * oldest week first. Rows with nothing to send are left out.
 */
export function planSync(ledger, now) {
  const plans = [];
  for (const week of Object.keys(ledger).sort()) {
    const closed = isClosed(week, now);
    const entries = [];
    for (const [subcat, row] of Object.entries(ledger[week])) {
      const unsynced = row.credited - row.synced;
      const h = closed ? Math.round(unsynced / HUNDREDTH_S) : Math.floor(unsynced / HUNDREDTH_S);
      if (h > 0) entries.push({ subcat, hundredths: h });
    }
    entries.sort((x, y) => x.subcat.localeCompare(y.subcat));
    for (let i = 0; i < entries.length; i += MAX_ENTRIES) {
      plans.push({ week, entries: entries.slice(i, i + MAX_ENTRIES) });
    }
  }
  return plans;
}

/** The PATCH body for one plan item. */
export function patchBody(plan) {
  return {
    entries: plan.entries.map((e) => ({ category: CATEGORY, subcat: e.subcat, add: hundredthsToDecimal(e.hundredths) })),
  };
}

/** Record a plan item the server accepted. */
export function markSynced(ledger, plan) {
  const w = ledger[plan.week];
  if (!w) return ledger;
  for (const e of plan.entries) {
    if (w[e.subcat]) w[e.subcat].synced += e.hundredths * HUNDREDTH_S;
  }
  return ledger;
}

/** Drop finished weeks: closed and nothing (meaningful) left to send. */
export function pruneLedger(ledger, now) {
  for (const week of Object.keys(ledger)) {
    if (!isClosed(week, now)) continue;
    const done = Object.values(ledger[week]).every((r) => Math.round((r.credited - r.synced) / HUNDREDTH_S) <= 0);
    if (done) delete ledger[week];
  }
  return ledger;
}

/** Seconds tracked but not yet on the server. */
export function pendingSeconds(ledger) {
  let t = 0;
  for (const w of Object.values(ledger)) for (const r of Object.values(w)) t += Math.max(0, r.credited - r.synced);
  return t;
}

/** The sub-category names a plan needs. */
export const planSubcats = (plans) => [...new Set(plans.flatMap((p) => p.entries.map((e) => e.subcat)))];
