// No-double-count bookkeeping. Pure.
//
// Content scripts report the wall-clock intervals during which their media was actively playing.
// Several tabs (or a re-sent heartbeat) can report overlapping intervals; only time that no
// earlier report has covered is credited, so two tabs playing at once count once.
//
// State: { horizon, spans: [[start, end], …] } — spans sorted, disjoint, all ending after
// `horizon`. Anything before `horizon` counts as already credited (old spans are pruned into it),
// which bounds the state and also drops reports that arrive absurdly late.

export const KEEP_MS = 6 * 3_600_000;   // remember credited spans this long
export const FUTURE_SLACK_MS = 5_000;   // tolerate this much clock disagreement

export function emptyCreditState() {
  return { horizon: 0, spans: [] };
}

/**
 * Claim [start, end). Returns { pieces, state }: the sub-intervals not credited before (sorted),
 * and the new state including them. Inputs are clamped to (horizon, now + slack].
 */
export function claim(state, start, end, now) {
  const horizon = state?.horizon || 0;
  let a = Math.max(Math.floor(start), horizon);
  const b = Math.min(Math.floor(end), now + FUTURE_SLACK_MS);
  const spans = (state?.spans || []).map((s) => [s[0], s[1]]);
  const pieces = [];
  if (b > a) {
    for (const [s, e] of spans) {
      if (e <= a) continue;
      if (s >= b) break;
      if (s > a) pieces.push([a, Math.min(s, b)]);
      a = Math.max(a, e);
      if (a >= b) break;
    }
    if (a < b) pieces.push([a, b]);
  }
  return { pieces, state: prune({ horizon, spans: merge(spans, pieces) }, now) };
}

function merge(spans, add) {
  const all = spans.concat(add).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [s, e] of all) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

function prune(state, now) {
  const cut = now - KEEP_MS;
  if (cut <= state.horizon) return state;
  return { horizon: cut, spans: state.spans.filter(([, e]) => e > cut).map(([s, e]) => [Math.max(s, cut), e]) };
}

/** Total uncredited ms of [start, end) without changing anything (for live counters). */
export function unclaimedMs(state, start, end, now) {
  return claim(state, start, end, now).pieces.reduce((t, [s, e]) => t + e - s, 0);
}
