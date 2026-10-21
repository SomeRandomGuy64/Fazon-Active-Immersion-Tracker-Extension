// Hour goals with a date (settings.goals): "500 h by 2027-03-31". Like milestones they're about the
// all-time total; each also has the day it should be reached by (a user day key, inclusive).
// Pure: shared by the background (validation) and the UI (Settings form, dashboard).

import { MAX_MILESTONE_H } from './milestones.js';

export const MAX_GOALS = 20;
export const MAX_GOAL_LABEL = 40;

const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function isDayKey(s) {
    const m = KEY_RE.exec(s);
    if (!m) return false;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** One goal {h, by, label?} → normalised copy. Throws Error(message). */
export function parseGoal(g) {
    if (!g || typeof g !== 'object') throw new Error('a goal needs hours and a date');
    const h = typeof g.h === 'number' ? g.h : Number(String(g.h ?? '').trim().replace(/h$/i, ''));
    if (!Number.isInteger(h) || h < 1 || h > MAX_MILESTONE_H) {
        throw new Error(`goal hours must be whole hours from 1 to ${MAX_MILESTONE_H.toLocaleString('en')}`);
    }
    const by = String(g.by ?? '').trim();
    if (!isDayKey(by)) throw new Error('a goal needs a date (YYYY-MM-DD)');
    const label = String(g.label ?? '').replace(/\s+/g, ' ').trim();
    if (label.length > MAX_GOAL_LABEL) throw new Error(`goal names can be at most ${MAX_GOAL_LABEL} characters`);
    return label ? { h, by, label } : { h, by };
}

/**
 * Normalise a goal list: [{h, by, label?}], deduplicated on (h, by), sorted by date then hours.
 * null → none. Past dates are kept (the dashboard shows them as reached or missed). Throws Error(message).
 */
export function parseGoals(v) {
    if (v == null) return [];
    if (!Array.isArray(v)) throw new Error('goals must be a list');
    const seen = new Map();
    for (const g of v) {
        const n = parseGoal(g);
        seen.set(`${n.h}|${n.by}`, n);
    }
    if (seen.size > MAX_GOALS) throw new Error(`at most ${MAX_GOALS} goals`);
    return [...seen.values()].sort((a, b) => (a.by < b.by ? -1 : a.by > b.by ? 1 : a.h - b.h));
}
