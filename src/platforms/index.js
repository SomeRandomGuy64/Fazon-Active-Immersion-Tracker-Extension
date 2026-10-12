// Platform registry. Adding a platform (Netflix, Crunchyroll, …) = a descriptor module here, a
// content script in src/content/, and its match patterns in manifest.json. Nothing else in the
// tracker, stats, sync or UI knows about specific platforms.
//
// Descriptor: { id, name, matches: [match patterns], mediaUrl?(id), channelUrl?(id) }.

import youtube from './youtube.js';

export const PLATFORMS = [youtube];

const byId = new Map(PLATFORMS.map((p) => [p.id, p]));

export const getPlatform = (id) => byId.get(id) || null;

/** { youtube: 'YouTube', … } */
export const platformNames = () => Object.fromEntries(PLATFORMS.map((p) => [p.id, p.name]));

/** Public {id, name} of a platform (what messages carry). */
export const publicPlatform = (p) => (p ? { id: p.id, name: p.name } : null);

/** Does `url` match a WebExtension match pattern ('*://*.youtube.com/*')? Ports are ignored. */
export function matchesPattern(pattern, url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (pattern === '<all_urls>') return /^(https?|wss?|file|ftp):$/.test(u.protocol);
  const m = /^(\*|https?|wss?|file|ftp):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (!m) return false;
  const [, scheme, host, path] = m;
  const proto = u.protocol.slice(0, -1);
  if (scheme === '*' ? !['http', 'https', 'ws', 'wss'].includes(proto) : scheme !== proto) return false;
  if (host !== '*') {
    if (host.startsWith('*.')) {
      const base = host.slice(2);
      if (u.hostname !== base && !u.hostname.endsWith('.' + base)) return false;
    } else if (u.hostname !== host) return false;
  }
  const re = new RegExp('^' + path.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(u.pathname + u.search);
}

/** The platform whose match patterns cover `url`, or null. */
export function platformForUrl(url) {
  if (!url) return null;
  return PLATFORMS.find((p) => p.matches.some((pat) => matchesPattern(pat, url))) || null;
}
