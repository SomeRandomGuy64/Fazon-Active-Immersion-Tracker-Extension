// Settings: defaults and validation. (Pure apart from Intl; imported by the store.)

import { isValidTimeZone, parseResetTime } from '../shared/time.js';

export const DEFAULT_API_BASE = 'https://api.fazon.nexus';

export const DEFAULT_SETTINGS = Object.freeze({
  resetTime: '03:00',
  timezone: 'UTC',          // 'UTC' | 'local' | IANA zone
  weekStart: 0,             // 0 = Sunday … 6 = Saturday (Sunday, like fazon.nexus Track weeks)
  countMuted: false,        // a muted video isn't listening, so it doesn't count by default
  dailyTargetMinutes: null, // manual daily target (used when there's no Track goal); null = none
  apiKey: '',
  syncEnabled: false,
  summaryVideos: false,     // list watched videos in the Track week's summary (while syncing)
  apiBase: DEFAULT_API_BASE,
});

/** Settings whose change affects the sync connection. */
export const SYNC_KEYS = ['apiKey', 'syncEnabled', 'apiBase'];

/** Normalise an API base: http(s) origin + optional path, no trailing slash. Throws if invalid. */
export function normaliseApiBase(v) {
  const raw = String(v ?? '').trim() || DEFAULT_API_BASE;
  let u;
  try { u = new URL(raw); } catch { throw new Error('API base must be a URL like https://api.fazon.nexus'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new Error('API base must use https (http only for localhost)');
  }
  if (u.username || u.password || u.search || u.hash) throw new Error('API base must not contain credentials, a query or a fragment');
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

/** The host-permission pattern needed to call `apiBase` (match patterns ignore the port). */
export function apiOriginPattern(apiBase) {
  const u = new URL(apiBase);
  return `${u.protocol}//${u.hostname}/*`;
}

/** Merge a patch into settings, validating each field. Throws Error(message) on bad input. */
export function applySettingsPatch(current, patch) {
  const next = { ...DEFAULT_SETTINGS, ...current };
  if (!patch || typeof patch !== 'object') throw new Error('patch must be an object');
  for (const [k, v] of Object.entries(patch)) {
    switch (k) {
      case 'resetTime': {
        const m = parseResetTime(v);
        if (m === null) throw new Error('resetTime must be HH:MM');
        next.resetTime = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        break;
      }
      case 'timezone':
        if (typeof v !== 'string' || !isValidTimeZone(v)) throw new Error(`unknown timezone ${v}`);
        next.timezone = v;
        break;
      case 'weekStart': {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n > 6) throw new Error('weekStart must be 0 (Sunday) … 6 (Saturday)');
        next.weekStart = n;
        break;
      }
      case 'dailyTargetMinutes': {
        if (v === null || v === '' || v === 0 || v === '0') { next.dailyTargetMinutes = null; break; }
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 1440) throw new Error('dailyTargetMinutes must be 0–1440 minutes or null');
        next.dailyTargetMinutes = Math.round(n * 100) / 100;
        break;
      }
      case 'countMuted':
      case 'syncEnabled':
      case 'summaryVideos':
        next[k] = !!v;
        break;
      case 'apiKey':
        if (typeof v !== 'string' || v.length > 200) throw new Error('apiKey must be a string');
        next.apiKey = v.trim();
        break;
      case 'apiBase':
        next.apiBase = normaliseApiBase(v);
        break;
      default:
        break; // unknown keys are ignored
    }
  }
  return next;
}
