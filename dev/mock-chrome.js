// DEV ONLY — a fake `chrome` for previewing the popup/dashboard in a normal browser tab.
// Loaded by dev/preview-loader.js before the page's own scripts. Not part of the extension build.
//
// Query parameters (on the preview page URL):
//   state=tracking|paused|muted|nonja|override|novideo|unsupported|noperm   (popup status card)
//   empty=1            brand-new install (no history, no overrides, no key)
//   sync=ok|pending|error|auth-error|off   (default ok)
//   platforms=2        also invent some Netflix time (shows the per-platform card)
//   reason=0           getStatus without media.reason (default: a reason is sent)
//   target=track|manual|none   daily/weekly target source (default track; none when empty=1)
//   state=ad|checking|buffering also work (v2 popup states)
//   resolve=1          getStats.resolve: channel lookups for imported history in progress
//   weekstart=0..6     settings.weekStart (default 0 = Sunday)
//   track=ok|loading|error|stale|off   getStats.track: all-time Track active total + weeks (stale = error
//                      with a cached value; default ok when a
//                      key is set — i.e. not empty=1 — else off)
//   goals=0            no goals (default: three — one reached, one on track, one behind)
//   theme=light|dark   (handled by the loader)
(function () {
    const q = new URLSearchParams((window.__fzPreviewSearch || location.search));
    const STATE = q.get('state') || 'tracking';
    const EMPTY = q.get('empty') === '1';
    const SYNC = q.get('sync') || (EMPTY ? 'off' : 'ok');
    const TWO = q.get('platforms') === '2';
    const log = (...a) => console.info('[mock-chrome]', ...a);

    // ---------- fake history: 30 Jun 2026 → today 11 Oct 2026, ≈436 h ----------
    const TODAY = '2026-10-11';
    const pad = (n) => String(n).padStart(2, '0');
    const keyOf = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    const dOf = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
    const add = (k, n) => { const d = dOf(k); d.setUTCDate(d.getUTCDate() + n); return keyOf(d); };
    let seed = 20260630;
    const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

    const TARGET = { '2026-06': 4 * 3600, '2026-07': 151.3 * 3600, '2026-08': 114.2 * 3600, '2026-09': 126.6 * 3600, '2026-10': 40.4 * 3600 };
    const TODAY_BASE = 4521;   // 1:15:21
    const weights = {};
    for (let k = '2026-06-30'; k <= TODAY; k = add(k, 1)) {
        let w = 0.35 + rnd() * 1.4;
        const dow = dOf(k).getUTCDay();
        if (dow === 0 || dow === 6) w *= 1.35;
        if (rnd() < 0.07) w = 0;                                 // random off days
        if (k >= '2026-08-14' && k <= '2026-08-18') w = 0;       // a holiday gap
        if (k >= '2026-09-22' && k <= '2026-09-23') w = 0;
        weights[k] = w;
    }
    const days = {};
    for (const [mon, target] of Object.entries(TARGET)) {
        const ks = Object.keys(weights).filter((k) => k.startsWith(mon) && k !== TODAY);
        const goal = mon === TODAY.slice(0, 7) ? target - TODAY_BASE : target;
        const sum = ks.reduce((a, k) => a + weights[k], 0) || 1;
        for (const k of ks) if (weights[k] > 0) days[k] = Math.round(weights[k] / sum * goal);
    }
    days[TODAY] = TODAY_BASE;
    const netflix = {};
    if (TWO) for (const k of Object.keys(days)) if (k >= '2026-09-01' && rnd() < 0.4) netflix[k] = Math.round(1800 + rnd() * 5400);

    let data = EMPTY ? { youtube: {}, netflix: {} } : { youtube: days, netflix };
    const t0 = Date.now();
    const playing = STATE === 'tracking' || STATE === 'override';

    // ---------- settings / sync / overrides ----------
    const TARGET_SRC = q.get('target') || (EMPTY ? 'none' : 'track');
    const settings = {
        resetTime: '03:00', timezone: 'UTC', weekStart: Number(q.get('weekstart') ?? 0), countMuted: false,
        dailyTargetMinutes: TARGET_SRC === 'manual' ? 180 : TARGET_SRC === 'track' ? 150 : null,
        apiKey: EMPTY || SYNC === 'off' ? '' : 'fz_ab12' + 'x'.repeat(39) + 'Q9z',
        syncEnabled: !EMPTY && SYNC !== 'off',
        apiBase: 'https://api.fazon.nexus',
        goals: EMPTY || q.get('goals') === '0' ? [] : [
            { h: 300, by: '2026-10-01', label: 'Summer block' }, { h: 800, by: '2026-10-25' }, { h: 1000, by: '2027-01-31', label: 'Before JLPT N3' },
        ],
    };
    const sync = {
        state: settings.syncEnabled ? SYNC : 'off',
        lastSyncAt: SYNC === 'off' || EMPTY ? null : Date.now() - (SYNC === 'ok' ? 95e3 : 31 * 60e3),
        lastError: SYNC === 'error' ? 'Network error: Failed to fetch (retrying in 4 min)' : SYNC === 'auth-error' ? '403 Forbidden: this key is read-only' : null,
        pendingSeconds: SYNC === 'pending' ? 754 : SYNC === 'error' || SYNC === 'auth-error' ? 2390 : 21,
        subcats: settings.syncEnabled ? ['YouTube - Monday', 'YouTube - Tuesday', 'YouTube - Wednesday', 'YouTube - Thursday', 'YouTube - Friday', 'YouTube - Saturday', 'YouTube - Sunday'] : [],
    };
    let overrides = EMPTY ? [] : [
        { scope: 'channel', platform: 'youtube', id: 'UCsg-YqdqQ-KFF0LNk23BY4A', label: '樋口楓【にじさんじ所属】', value: 'ja', at: Date.parse('2026-07-02T12:00:00Z') },
        { scope: 'video', platform: 'youtube', id: 'dQw4w9WgXcQ', label: 'ポケモン図鑑を全部埋めるまで終われない配信 #3', value: 'ja', at: Date.parse('2026-09-14T20:11:00Z') },
        { scope: 'video', platform: 'youtube', id: 'xvFZjo5PgG0', label: 'Lo-fi beats to study to — 24/7', value: 'non-ja', at: Date.parse('2026-10-03T08:40:00Z') },
        { scope: 'channel', platform: 'youtube', id: 'UCxxxxEnglishNews', label: 'Some English News Channel', value: 'non-ja', at: Date.parse('2026-08-21T16:02:00Z') },
    ];
    const media = {
        videoId: 'abc123XYZ', title: '【ポケモンSV】はじめてのパルデア地方！ゆっくり冒険するで〜 #1【樋口楓/にじさんじ】',
        channel: '樋口楓【にじさんじ所属】', channelId: 'UCsg-YqdqQ-KFF0LNk23BY4A',
        url: 'https://www.youtube.com/watch?v=abc123XYZ', playing: STATE !== 'paused',
        japanese: STATE !== 'nonja', detected: STATE !== 'nonja',
        override: { video: STATE === 'override' ? 'ja' : null, channel: null },
        // extras core sends (tracker.js)
        checking: STATE === 'checking', muted: STATE === 'muted', paused: STATE === 'paused', ad: STATE === 'ad', buffering: STATE === 'buffering', countMuted: false, platform: 'youtube',
        // v2: seconds counted for this video today (live), why it's (not) Japanese
        sessionSeconds: 2533,
        reason: 'Japanese captions',
    };
    if (STATE === 'nonja') Object.assign(media, { title: 'How I Built a Raycaster in LÖVE2D', channel: 'Some Dev Channel', channelId: 'UCdev' });
    if (STATE === 'nonja') Object.assign(media, { sessionSeconds: 0, reason: 'No Japanese in the title, channel or captions' });
    if (STATE === 'checking') Object.assign(media, { japanese: false, detected: null, reason: null, sessionSeconds: 0 });
    if (STATE === 'override') media.reason = 'You marked this video as Japanese';
    if (EMPTY) media.sessionSeconds = 0;
    if (q.get('reason') === '0') delete media.reason;

    // ---------- v2: per-channel time ----------
    // Days before 20 Sep come from an "imported Mikan history" (no channel data → id/name null);
    // later days are split across real-looking channels.
    const CHANNELS = [
        ['UCsg-YqdqQ-KFF0LNk23BY4A', '樋口楓【にじさんじ所属】', 40],
        ['UCaminwG9MTO4sLYeC3s6udA', 'ヒカル（Hikaru）', 14],
        ['UC1DCedRgGHBdm81E1llLhOQ', 'Pekora Ch. 兎田ぺこら', 11],
        ['UC_4tXjqecqox5Uc05ncxpxg', '椎名唯華 / Shiina Yuika', 9],
        ['UCUKD-uaobj9jiqB-VXt71mA', 'Botan Ch.獅白ぼたん', 7],
        ['UCdaian0000000000000000', 'ダイアン YOUTUBE', 6],
        ['UCnei0000000000000000000', '瀬戸美夜子 / 先斗寧', 4],
        ['UCsasaki000000000000000', '佐々木 咲', 3],
        ['UCkaze000000000000000000', '風真いろは', 2.5],
        ['UCnews000000000000000000', 'NHK NEWS', 2],
        ['UCkoto000000000000000000', 'ことばのチカラ', 1.5],
    ];
    const IMPORT_UNTIL = '2026-09-19';
    function channelStats(d, weekFrom, monthFrom) {
        const acc = new Map();
        const bump = (id, name, k, sec) => {
            const key = id || '(unknown)';
            if (!acc.has(key)) acc.set(key, { platform: 'youtube', id, name, today: 0, week: 0, month: 0, allTime: 0 });
            const c = acc.get(key);
            c.allTime += sec;
            if (k === TODAY) c.today += sec;
            if (k >= weekFrom) c.week += sec;
            if (k >= monthFrom) c.month += sec;
        };
        const yt = { ...data.youtube };
        if (playing) yt[TODAY] = (yt[TODAY] || 0) + Math.floor((Date.now() - t0) / 1000);
        let cs = 7;
        const r = () => { cs = (cs * 16807) % 2147483647; return cs / 2147483647; };
        for (const [k, sec] of Object.entries(yt).sort()) {
            if (!sec) continue;
            if (k <= IMPORT_UNTIL && !EMPTY) { bump(null, null, k, sec); continue; }
            if (k === TODAY) {   // today: what's playing now + one earlier video
                bump(CHANNELS[0][0], CHANNELS[0][1], k, sec - 1650);
                bump(CHANNELS[1][0], CHANNELS[1][1], k, 1650);
                continue;
            }
            const w = CHANNELS.map((c) => c[2] * (0.3 + r() * 1.4) * (r() < 0.35 ? 0 : 1));
            const tot = w.reduce((a, b) => a + b, 0) || 1;
            let left = sec;
            CHANNELS.forEach((c, i) => { const part = i === CHANNELS.length - 1 ? left : Math.round((sec * w[i]) / tot); left -= part; if (part > 0) bump(c[0], c[1], k, part); });
        }
        if (TWO) for (const [k, sec] of Object.entries(data.netflix)) {
            const key = 'nf';
            if (!acc.has(key)) acc.set(key, { platform: 'netflix', id: 'nf-hanzawa', name: '半沢直樹', today: 0, week: 0, month: 0, allTime: 0 });
            const c = acc.get(key); c.allTime += sec; if (k >= weekFrom) c.week += sec; if (k >= monthFrom) c.month += sec;
        }
        return [...acc.values()];
    }
    // ---------- v3: all-time Active immersion on fazon.nexus Track ----------
    const TRACK = q.get('track') || (EMPTY ? 'off' : 'ok');
    function trackStats() {
        if (TRACK === 'off') return { state: 'off', activeAllTime: null, pendingSeconds: 0, fetchedAt: null, error: null };
        const pending = settings.syncEnabled ? 754 + (playing ? Math.floor((Date.now() - t0) / 1000) : 0) : 0;
        if (TRACK === 'loading') return { state: 'loading', activeAllTime: null, pendingSeconds: pending, fetchedAt: null, error: null, weeks: [] };
        if (TRACK === 'error') return { state: 'error', activeAllTime: null, pendingSeconds: pending, fetchedAt: null, error: 'the API key was rejected (revoked or mistyped)', weeks: [] };
        // Track has more than this tracker: hours logged by hand before the extension (from March),
        // then roughly what the tracker recorded. Weeks keyed by the Saturday before (Track calendar).
        const weeks = trackWeeks();
        const activeAllTime = weeks.reduce((a, w) => a + w.active, 0);
        const base = { pendingSeconds: pending, fetchedAt: Date.now() - 4 * 60_000, weeks };
        if (TRACK === 'stale') return { state: 'error', activeAllTime, error: 'network error: Failed to fetch', ...base };
        return { state: 'ok', activeAllTime, error: null, ...base };
    }
    function trackWeeks() {
        const cur = add(TODAY, -((dOf(TODAY).getUTCDay() + 1) % 7));   // Saturday key of the current week
        const out = [];
        let r = 11;
        const rn = () => { r = (r * 16807) % 2147483647; return r / 2147483647; };
        const tracker = allDays();
        for (let k = '2026-02-28'; k <= cur; k = add(k, 7)) {
            let s = 0;
            if (k < '2026-06-27') s = Math.round((12 + rn() * 14) * 3600 / 36) * 36;                   // manual logging
            else for (let i = 1; i <= 7; i++) s += tracker[add(k, i)] || 0;
            if (k === cur) s += 3 * 3600 + 25 * 60;   // logged by hand on the site this Track week (TV, a book…)
            out.push({ week: k, start: Date.parse(add(k, 1) + 'T03:00:00Z'), active: Math.round(s / 36) * 36 });
        }
        return out;
    }
    function target() {
        if (TARGET_SRC === 'track' && settings.syncEnabled) return { daily: 4 * 3600, weekly: 28 * 3600, source: 'track' };
        if (settings.dailyTargetMinutes) return { daily: settings.dailyTargetMinutes * 60, weekly: settings.dailyTargetMinutes * 60 * 7, source: 'manual' };
        return { daily: null, weekly: null, source: null };
    }

    // ---------- stats like core computes them ----------
    const allDays = () => {
        const out = {};
        for (const p of Object.values(data)) for (const [k, v] of Object.entries(p)) out[k] = (out[k] || 0) + v;
        if (playing && !EMPTY) out[TODAY] = (out[TODAY] || 0) + Math.floor((Date.now() - t0) / 1000);
        else if (playing && EMPTY) out[TODAY] = Math.floor((Date.now() - t0) / 1000) || undefined;
        for (const k of Object.keys(out)) if (!out[k]) delete out[k];
        return out;
    };
    const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    function sumRange(map, from, to) { let s = 0; for (const [k, v] of Object.entries(map)) if (k >= from && k <= to) s += v; return s; }
    function stats() {
        const d = allDays();
        const dow = dOf(TODAY).getUTCDay();
        const weekFrom = add(TODAY, -((dow - settings.weekStart + 7) % 7));
        const monthFrom = TODAY.slice(0, 8) + '01';
        const keys = Object.keys(d).sort();
        const firstDay = keys[0] || null;
        const allTime = keys.reduce((a, k) => a + d[k], 0);
        const span = firstDay ? Math.round((dOf(TODAY) - dOf(firstDay)) / 864e5) + 1 : 0;
        const dailyAverage = span ? allTime / span : 0;
        const last7 = [];
        for (let i = 6; i >= 0; i--) { const k = add(TODAY, -i); last7.push({ key: k, label: i === 0 ? 'Today' : WD[dOf(k).getUTCDay()], seconds: d[k] || 0 }); }
        const months = [];
        if (firstDay) {
            let [y, m] = firstDay.split('-').map(Number);
            const [ty, tm] = TODAY.split('-').map(Number);
            while (y < ty || (y === ty && m <= tm)) {
                const mk = `${y}-${pad(m)}`;
                months.push({ key: mk, label: `${MON[m - 1]} ${y}`, seconds: sumRange(d, mk + '-01', mk + '-31') });
                m++; if (m > 12) { m = 1; y++; }
            }
        }
        const byPlatform = {};
        for (const [id, name] of [['youtube', 'YouTube'], ['netflix', 'Netflix']]) {
            const pd = { ...data[id] };
            if (id === 'youtube' && playing) pd[TODAY] = (pd[TODAY] || 0) + Math.floor((Date.now() - t0) / 1000);
            const at = Object.values(pd).reduce((a, b) => a + b, 0);
            if (id === 'netflix' && !at) continue;
            byPlatform[id] = { name, today: pd[TODAY] || 0, week: sumRange(pd, weekFrom, TODAY), month: sumRange(pd, monthFrom, TODAY), allTime: at };
        }
        return {
            ok: true, now: Date.now(), todayKey: TODAY,
            today: d[TODAY] || 0, week: sumRange(d, weekFrom, TODAY), month: sumRange(d, monthFrom, TODAY), allTime,
            dailyAverage, monthlyAverage: dailyAverage * 30.436875, firstDay, days: d, byPlatform, last7, months,
            settings: { ...settings }, sync: { ...sync },
            channels: channelStats(d, weekFrom, monthFrom), target: target(),
            track: trackStats(),
            ...(q.get('resolve') === '1' ? { resolve: (() => { const n = Math.min(1040, 312 + Math.floor((Date.now() - t0) / 1000) * 3), failed = Math.floor(n / 90); return { pending: 1040 - n, done: n - failed, failed }; })() } : {}),
        };
    }

    // ---------- message handlers ----------
    const handlers = {
        getStatus() {
            const platform = { id: 'youtube', name: 'YouTube' };
            if (STATE === 'unsupported') return { platform: null, hasSitePermission: false, media: null, tracking: false };
            if (STATE === 'noperm') return { platform, hasSitePermission: false, media: null, tracking: false };
            if (STATE === 'novideo') return { platform, hasSitePermission: true, media: null, tracking: false };
            const tracking = media.japanese && media.playing && !['muted', 'ad', 'buffering', 'checking'].includes(STATE);
            const m = JSON.parse(JSON.stringify(media));
            if (tracking) m.sessionSeconds += Math.floor((Date.now() - t0) / 1000);
            return { platform, hasSitePermission: true, media: m, tracking };
        },
        setOverride(m) {
            overrides = overrides.filter((o) => !(o.scope === m.scope && o.platform === m.platform && o.id === m.id));
            if (m.value) overrides.unshift({ scope: m.scope, platform: m.platform, id: m.id, label: m.label, value: m.value, at: Date.now() });
            if (m.scope === 'video' && m.id === media.videoId) media.override.video = m.value;
            if (m.scope === 'channel' && m.id === media.channelId) media.override.channel = m.value;
            const v = media.override.video || media.override.channel;
            media.japanese = v ? v === 'ja' : media.detected;
            return {};
        },
        getOverrides() { return { overrides: overrides.slice() }; },
        getStats() { return stats(); },
        getSettings() { return { settings: { ...settings } }; },
        setSettings(m) {
            Object.assign(settings, m.patch || {});
            sync.state = settings.syncEnabled ? (settings.apiKey ? 'pending' : 'error') : 'off';
            if (settings.syncEnabled && !settings.apiKey) sync.lastError = 'No API key';
            return { settings: { ...settings } };
        },
        async testApiKey(m) {
            await new Promise((r) => setTimeout(r, 500));
            const k = m.apiKey || '';
            if (!/^fz_[A-Za-z0-9_-]{20,}$/.test(k)) return { valid: false, canWrite: null, message: '401 Unauthorized: unknown or malformed key' };
            if (/ro/i.test(k.slice(3, 9))) return { valid: true, canWrite: false, message: 'Key works but is read-only — create a Read & write key.' };
            return { valid: true, canWrite: true, message: 'Key OK · Read & write · account “faizan”' };
        },
        async syncNow() {
            await new Promise((r) => setTimeout(r, 700));
            if (!settings.syncEnabled) return { sync: { ...sync } };
            if (sync.state !== 'auth-error') Object.assign(sync, { state: 'ok', lastSyncAt: Date.now(), lastError: null, pendingSeconds: 0 });
            return { sync: { ...sync } };
        },
        exportData() { return { data: { format: 'fazon-immersion', version: 1, exportedAt: Date.now(), days: data, overrides, settings: { ...settings, apiKey: '' } } }; },
        importData(m) {
            const src = m.data && (m.data.watchData || (m.data.days ? null : m.data));
            if (m.mode === 'replace') data = { youtube: {}, netflix: {} };
            if (src) for (const [k, v] of Object.entries(src)) { const s = typeof v === 'number' ? v : v.totalSeconds || 0; data.youtube[k] = (data.youtube[k] || 0) + s; }
            return {};
        },
        resetData() { data = { youtube: {}, netflix: {} }; overrides = []; return {}; },
    };

    // ---------- chrome.* ----------
    const listeners = { message: [], storage: [] };
    const store = (() => { try { return JSON.parse(localStorage.getItem('mock-storage') || '{}'); } catch { return {}; } })();
    if (!store.theme) { try { store.theme = localStorage.getItem('fz-theme') || 'dark'; } catch { /* ignore */ } }
    const pick = (keys) => {
        if (keys == null) return { ...store };
        if (typeof keys === 'string') keys = [keys];
        if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]]));
        return Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in store ? store[k] : d]));
    };
    const mock = {
        runtime: {
            id: 'mock-extension',
            getURL: (p) => new URL('/' + p.replace(/^\//, ''), location.origin).href,
            getManifest: () => ({ version: '0.1.0', name: 'Active Immersion Tracker', content_scripts: [{ matches: ['*://*.youtube.com/*'], js: [] }], optional_host_permissions: ['https://api.fazon.nexus/*'] }),
            async sendMessage(msg) {
                const fn = handlers[msg && msg.type];
                if (!fn) return { ok: false, error: 'mock: unknown message ' + (msg && msg.type) };
                try { const r = await fn(msg); return { ok: true, ...r }; } catch (e) { return { ok: false, error: String(e) }; }
            },
            onMessage: { addListener: (f) => listeners.message.push(f), removeListener() {} },
            openOptionsPage: () => window.open('/dev/preview-dashboard.html#settings'),
        },
        storage: {
            local: {
                async get(keys) { return pick(keys); },
                async set(obj) {
                    const changes = {};
                    for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: store[k], newValue: v }; store[k] = v; }
                    try { localStorage.setItem('mock-storage', JSON.stringify(store)); } catch { /* ignore */ }
                    listeners.storage.forEach((f) => f(changes, 'local'));
                },
                async remove() {},
            },
            onChanged: { addListener: (f) => listeners.storage.push(f), removeListener() {} },
        },
        permissions: {
            async request(p) { log('permissions.request', JSON.stringify(p)); return true; },
            async contains() { return STATE !== 'noperm'; },
        },
        tabs: {
            async query() { return [{ id: 7, windowId: 1, active: true, url: STATE === 'unsupported' ? 'https://fazon.nexus/' : media.url }]; },
            async create(o) { log('tabs.create', o.url); window.open(o.url, '_blank'); return { id: 8 }; },
            async update(id, o) { log('tabs.update', id, o); return {}; },
            async reload(id) { log('tabs.reload', id); },
        },
        windows: { async update() {} },
    };
    window.chrome = mock;
    window.__mockChrome = { handlers, settings, sync, broadcast: () => listeners.message.forEach((f) => f({ type: 'statsChanged' })) };
    log('installed', { STATE, EMPTY, SYNC, TWO });
})();
