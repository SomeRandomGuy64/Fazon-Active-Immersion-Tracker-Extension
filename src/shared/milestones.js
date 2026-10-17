// Hour milestones on the dashboard hero (settings.milestonesH). Pure: shared by the background
// (validation) and the UI (parsing the Settings field, drawing).

export const DEFAULT_MILESTONES_H = Object.freeze([100, 250, 500, 1000, 1500, 2000, 3000, 5000, 10000]);
export const MAX_MILESTONES = 50;
export const MAX_MILESTONE_H = 100000;

/**
 * Normalise milestones: an array of hours, or a string like "100, 250 500". Whole hours,
 * 1–100,000, deduplicated and sorted ascending. null / '' → the defaults. Throws Error(message).
 */
export function parseMilestones(v) {
    if (v == null || (typeof v === 'string' && !v.trim())) return [...DEFAULT_MILESTONES_H];
    const parts = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,;]+/).filter(Boolean) : null;
    if (!parts) throw new Error('milestones must be a list of hours');
    const out = new Set();
    for (const p of parts) {
        const n = typeof p === 'number' ? p : Number(String(p).trim().replace(/h$/i, ''));
        if (!Number.isInteger(n) || n < 1 || n > MAX_MILESTONE_H) {
            throw new Error(`“${p}” isn’t a milestone: use whole hours from 1 to ${MAX_MILESTONE_H.toLocaleString('en')}`);
        }
        out.add(n);
    }
    if (!out.size) throw new Error('add at least one milestone');
    if (out.size > MAX_MILESTONES) throw new Error(`at most ${MAX_MILESTONES} milestones`);
    return [...out].sort((a, b) => a - b);
}
