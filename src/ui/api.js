// Thin wrapper over the UI ⇄ background message protocol (ARCHITECTURE.md).

export class ApiError extends Error {}

/** Send `{type, ...payload}` to the background; resolves to the response, throws ApiError on ok:false. */
export async function send(type, payload = {}) {
    let res;
    try {
        res = await chrome.runtime.sendMessage({ type, ...payload });
    } catch (e) {
        throw new ApiError(e && e.message ? e.message : String(e));
    }
    if (!res) throw new ApiError('No response from the extension background.');
    if (res.ok === false) throw new ApiError(res.error || 'Unknown error');
    return res;
}

/** Call cb on the background's `statsChanged` broadcast. */
export function onStatsChanged(cb) {
    try {
        chrome.runtime.onMessage.addListener((msg) => {
            if (msg && msg.type === 'statsChanged') cb();
        });
    } catch { /* ignore */ }
}

export async function getActiveTab() {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return tab || null;
    } catch { return null; }
}

export function extUrl(path) {
    try { return chrome.runtime.getURL(path); } catch { return '/' + path; }
}

/** Open an extension page in a tab (re-using one that's already open) and optionally close the popup. */
export async function openExtensionPage(path, { closeWindow = false } = {}) {
    const url = extUrl(path);
    const base = url.split('#')[0];
    try {
        const tabs = await chrome.tabs.query({});
        const existing = tabs.find((t) => t.url && t.url.split('#')[0] === base);
        if (existing && existing.id != null) {
            await chrome.tabs.update(existing.id, { active: true, url });
            if (existing.windowId != null && chrome.windows && chrome.windows.update) {
                try { await chrome.windows.update(existing.windowId, { focused: true }); } catch { /* ignore */ }
            }
        } else {
            await chrome.tabs.create({ url });
        }
    } catch {
        window.open(url, '_blank');
    }
    if (closeWindow) window.close();
}

/** Host match pattern (no port: Chrome and Firefox both reject or ignore ports) for an API base URL. */
export function originPattern(base) {
    try {
        const u = new URL(base);
        return `${u.protocol}//${u.hostname}/*`;
    } catch { return null; }
}

// --- match patterns (for "Grant access" without hard-coding any site) ---
function patternToRegex(p) {
    if (p === '<all_urls>') return /^(https?|wss?|file|ftp):\/\//;
    const m = /^(\*|https?|wss?|file|ftp):\/\/(\*|\*\.[^/*]+|[^/*]+)?(\/.*)$/.exec(p);
    if (!m) return null;
    const [, scheme, host = '', path] = m;
    const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const sch = scheme === '*' ? 'https?' : esc(scheme);
    let h;
    if (host === '*') h = '[^/]*';
    else if (host.startsWith('*.')) h = '(?:[^/]*\\.)?' + esc(host.slice(2));
    else h = esc(host);
    return new RegExp('^' + sch + ':\\/\\/' + h + '(?::\\d+)?' + esc(path).replace(/\\\*|\*/g, '.*') + '$');
}

/** Every match pattern the manifest declares for content scripts / host permissions. */
export function manifestPatterns() {
    try {
        const m = chrome.runtime.getManifest();
        const out = new Set();
        (m.content_scripts || []).forEach((cs) => (cs.matches || []).forEach((p) => out.add(p)));
        (m.host_permissions || []).forEach((p) => out.add(p));
        (m.optional_host_permissions || []).forEach((p) => out.add(p));
        (m.permissions || []).forEach((p) => { if (/:\/\//.test(p)) out.add(p); });
        return [...out];
    } catch { return []; }
}

/** Patterns to request for the site of `url`: the content-script matches covering it, else its origin. */
export function patternsForUrl(url, preferred) {
    if (preferred && preferred.length) return preferred;
    let csMatches = [];
    try {
        const m = chrome.runtime.getManifest();
        for (const cs of m.content_scripts || []) {
            const hit = (cs.matches || []).some((p) => { const r = patternToRegex(p); return r && r.test(url); });
            if (hit) csMatches.push(...cs.matches);
        }
    } catch { /* ignore */ }
    csMatches = [...new Set(csMatches)].filter((p) => p !== '<all_urls>');
    if (csMatches.length) return csMatches;
    try { const u = new URL(url); return [`${u.protocol}//${u.hostname}/*`]; } catch { return []; }
}

/** Short host list ("youtube.com") of the sites the extension supports, from the manifest. */
export function supportedHosts() {
    // the first match of each content-script entry (one per platform), e.g. "youtube.com"
    let pats = [];
    try { pats = (chrome.runtime.getManifest().content_scripts || []).map((cs) => (cs.matches || [])[0]).filter(Boolean); } catch { /* ignore */ }
    const hosts = new Set();
    for (const p of pats) {
        const m = /^[^:]+:\/\/(?:\*\.)?([^/:]+)/.exec(p);
        if (m && m[1] !== '*') hosts.add(m[1].replace(/^(www|m)\./, ''));
    }
    return [...hosts];
}
