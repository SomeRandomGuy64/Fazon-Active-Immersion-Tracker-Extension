// Settings view (#settings): day/week, tracking, fazon.nexus sync, overrides, data.
import { send, originPattern } from '../ui/api.js';
import { h, $, setText } from '../ui/dom.js';
import { hm, ago, dateTime, dateOnly, maskKey, weekdayName } from '../ui/format.js';

const DEFAULT_BASE = 'https://api.fazon.nexus';
let ctx = { refresh: async () => {}, showError: () => {}, getStats: () => null };
let settings = null;        // last settings seen from the background
let formFilled = false;     // fill inputs once (and after saves), never under the user's cursor
let editingKey = false;

function msg(el, text, kind = '') {
    el = typeof el === 'string' ? $(el) : el;
    el.className = 'db-msg' + (kind ? ' ' + kind : '');
    setText(el, text || '');
}
function flashSaved(id) {
    const el = $(id);
    setText(el, 'Saved ✓');
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 1600);
}
async function save(patch, savedId) {
    try {
        const res = await send('setSettings', { patch });
        settings = res.settings || { ...settings, ...patch };
        if (savedId) flashSaved(savedId);
        ctx.refresh();
        return true;
    } catch (e) {
        ctx.showError(`Couldn’t save: ${e.message}`);
        return false;
    }
}
function apiBase() { return (settings && settings.apiBase) || DEFAULT_BASE; }
function apiHost() { try { return new URL(apiBase()).host; } catch { return 'the API'; } }

/** chrome.permissions.request for the API origin. MUST be the first await of a click handler. */
function requestApiPermission(base = apiBase()) {
    const pattern = originPattern(base);
    if (!pattern) return Promise.reject(new Error('Invalid API base URL'));
    return chrome.permissions.request({ origins: [pattern] });
}

// ---------------- days & weeks / tracking ----------------
function fillTimezones(current) {
    const sel = $('#timezone');
    let local = 'local';
    try { local = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'; } catch { /* ignore */ }
    let zones = [];
    try { zones = Intl.supportedValuesOf('timeZone'); } catch { /* old browser: just UTC / local / current */ }
    if (current && current !== 'UTC' && current !== 'local' && !zones.includes(current)) zones = [current, ...zones];
    sel.replaceChildren(
        h('option', { value: 'UTC' }, 'UTC (same as fazon.nexus Track)'),
        h('option', { value: 'local' }, `Browser local (${local})`),
        zones.length ? h('optgroup', { label: 'Time zones' }, ...zones.filter((z) => z !== 'UTC').map((z) => h('option', { value: z }, z.replace(/_/g, ' ')))) : null,
    );
    sel.value = current || 'UTC';
}
function fillWeekStart(current) {
    const sel = $('#weekStart');
    if (!sel.options.length) {
        for (const d of [1, 2, 3, 4, 5, 6, 0]) sel.append(h('option', { value: String(d) }, weekdayName(d, true)));
    }
    sel.value = String(current ?? 1);
}

function fillForm() {
    if (!settings) return;
    const rt = $('#resetTime');
    if (document.activeElement !== rt) rt.value = settings.resetTime || '03:00';
    fillTimezones(settings.timezone || 'UTC');
    fillWeekStart(settings.weekStart);
    $('#countMuted').checked = !!settings.countMuted;
    const dt = $('#dailyTarget');
    if (document.activeElement !== dt) dt.value = settings.dailyTargetMinutes ? String(Math.round((settings.dailyTargetMinutes / 60) * 100) / 100) : '';
    renderTargetNote();
    $('#apiBase').value = settings.apiBase || DEFAULT_BASE;
    renderKey();
    $('#syncEnabled').checked = !!settings.syncEnabled;
    formFilled = true;
}

function wireDays() {
    $('#resetTime').addEventListener('change', (e) => {
        const v = e.target.value;
        if (!/^\d{2}:\d{2}$/.test(v)) { e.target.value = settings?.resetTime || '03:00'; return; }
        save({ resetTime: v }, '#savedDays');
    });
    $('#timezone').addEventListener('change', (e) => save({ timezone: e.target.value }, '#savedDays'));
    $('#weekStart').addEventListener('change', (e) => save({ weekStart: Number(e.target.value) }, '#savedDays'));
    $('#countMuted').addEventListener('change', (e) => save({ countMuted: e.target.checked }, '#savedTracking'));
    $('#dailyTarget').addEventListener('change', (e) => {
        const v = e.target.value.trim();
        const hrs = v === '' ? null : Number(v);
        if (hrs != null && !(hrs > 0 && hrs <= 24)) { e.target.value = settings?.dailyTargetMinutes ? String(settings.dailyTargetMinutes / 60) : ''; return; }
        save({ dailyTargetMinutes: hrs == null ? null : Math.round(hrs * 60) }, '#savedTarget');
    });
    $('#dailyTargetClear').addEventListener('click', () => { $('#dailyTarget').value = ''; save({ dailyTargetMinutes: null }, '#savedTarget'); });
}

/** Which target is in effect right now (getStats.target), under the input. */
function renderTargetNote() {
    const st = ctx.getStats();
    const t = st && st.target;
    let el = $('#targetNow');
    if (!el) { el = h('p', { class: 'db-hint', id: 'targetNow' }); $('#targetNote').after(el); }
    if (!t || !t.daily) { el.replaceChildren('No target in effect.'); return; }
    el.replaceChildren('In effect: ', h('b', null, `${hm(t.daily)} a day`), ` (${hm(t.weekly)} a week) — `,
        t.source === 'track' ? 'from your fazon.nexus Track goal.' : 'your own target.');
}

// ---------------- API key ----------------
function renderKey() {
    const has = !!(settings && settings.apiKey);
    const showEdit = !has || editingKey;
    $('#keySaved').hidden = showEdit;
    $('#keyEdit').hidden = !showEdit;
    $('#keySave').hidden = !showEdit;
    $('#keyCancel').hidden = !(has && editingKey);
    setText($('#keyMask'), has ? maskKey(settings.apiKey) : '');
    $('#syncEnabled').disabled = !has;
    $('#syncNow').disabled = !(has && settings.syncEnabled);
}

function showTestResult(r) {
    if (r.valid && r.canWrite !== false) msg('#keyMsg', '✓ ' + (r.message || 'Key works'), 'ok');
    else if (r.valid) msg('#keyMsg', r.message || 'This key is read-only — create a Read & write key.', 'bad');
    else msg('#keyMsg', r.message || 'The key was rejected.', 'bad');
}

function wireKey() {
    const input = $('#apiKey');
    $('#keyShow').addEventListener('click', () => {
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        $('#keyShow').setAttribute('aria-pressed', String(show));
        setText($('#keyShow'), show ? 'Hide' : 'Show');
        $('#keyShow').title = show ? 'Hide key' : 'Show key';
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#keySave').click(); });

    $('#keySave').addEventListener('click', async () => {
        const key = input.value.trim();
        if (!key) { msg('#keyMsg', 'Paste your key first.', 'bad'); input.focus(); return; }
        if (!/^fz_\S{8,}$/.test(key)) { msg('#keyMsg', 'That doesn’t look like a fazon.nexus key (they start with fz_).', 'bad'); return; }
        let granted = false;
        try { granted = await requestApiPermission(); } catch (e) { msg('#keyMsg', `Permission request failed: ${e.message}`, 'bad'); }
        msg('#keyMsg', 'Saving…', 'muted');
        if (!(await save({ apiKey: key }))) { msg('#keyMsg', '', ''); return; }
        input.value = '';
        input.type = 'password';
        setText($('#keyShow'), 'Show');
        editingKey = false;
        renderKey();
        if (!granted) {
            msg('#keyMsg', `Saved — but without access to ${apiHost()} sync can’t run. Press “Test key” to grant it.`, 'bad');
            return;
        }
        msg('#keyMsg', 'Saved. Testing…', 'muted');
        try { showTestResult(await send('testApiKey', { apiKey: key, apiBase: apiBase() })); } catch (e) { msg('#keyMsg', e.message, 'bad'); }
    });

    $('#keyTest').addEventListener('click', async () => {
        const key = input.value.trim() || (settings && settings.apiKey) || '';
        if (!key) { msg('#keyMsg', 'Paste a key to test.', 'bad'); return; }
        let granted = false;
        try { granted = await requestApiPermission(); } catch (e) { msg('#keyMsg', `Permission request failed: ${e.message}`, 'bad'); return; }
        if (!granted) { msg('#keyMsg', `The extension needs access to ${apiHost()} to test the key.`, 'bad'); return; }
        msg('#keyMsg', 'Testing…', 'muted');
        try { showTestResult(await send('testApiKey', { apiKey: key, apiBase: apiBase() })); } catch (e) { msg('#keyMsg', e.message, 'bad'); }
    });

    $('#keyReplace').addEventListener('click', () => { editingKey = true; renderKey(); msg('#keyMsg', ''); input.focus(); });
    $('#keyCancel').addEventListener('click', () => { editingKey = false; input.value = ''; renderKey(); msg('#keyMsg', ''); });
    $('#keyRemove').addEventListener('click', async () => {
        if (await save({ apiKey: '', syncEnabled: false })) {
            editingKey = false; renderKey(); fillForm();
            msg('#keyMsg', 'Key removed from this browser. (Revoke it on fazon.nexus too if you no longer need it.)', 'muted');
        }
    });
}

// ---------------- sync ----------------
const STATE_TEXT = { off: 'Off', ok: 'Up to date', pending: 'Pending', error: 'Error', 'auth-error': 'Key rejected' };
const STATE_DOT = { off: '', ok: 'ok', pending: 'warn', error: 'bad', 'auth-error': 'bad' };

function renderSyncStatus(st) {
    const sync = st.sync || { state: 'off' };
    const s = settings || st.settings || {};
    const state = s.syncEnabled ? (sync.state || 'pending') : 'off';
    const badge = $('#syncBadge');
    setText(badge, STATE_TEXT[state] || state);
    badge.className = 'fz-tag' + (state === 'ok' ? ' accent' : state === 'error' || state === 'auth-error' ? ' bad' : '');

    const rows = [];
    const row = (dt, ...dd) => rows.push(h('dt', null, dt), h('dd', null, ...dd));
    row('Status', h('span', { class: 'db-state' }, h('span', { class: 'fz-dot ' + (STATE_DOT[state] || '') }),
        state === 'off' ? (s.apiKey ? 'Sync is off' : 'Add a key to turn sync on') : STATE_TEXT[state] || state));
    if (s.apiKey || sync.lastSyncAt) row('Last sync', sync.lastSyncAt ? `${ago(sync.lastSyncAt, st.now)} (${dateTime(sync.lastSyncAt)})` : 'never');
    if (s.syncEnabled || (s.apiKey && sync.pendingSeconds)) row('Waiting to send', hm(sync.pendingSeconds || 0), h('span', { class: 'fz-muted' }, '  · sent in 36-second steps'));
    if (sync.lastError) { rows.push(h('dt', null, 'Last error'), h('dd', { class: 'bad' }, sync.lastError)); }
    if (state === 'auth-error') rows.push(h('dt', null, ''), h('dd', null, 'Check the key is a Read & write key that hasn’t been revoked, then save it again.'));
    if (sync.subcats && sync.subcats.length) row('Sub-categories', ...sync.subcats.map((n) => h('span', { class: 'fz-tag' }, n)));
    const dl = $('#syncStatus');
    const sig = JSON.stringify([state, sync.lastError, sync.pendingSeconds, sync.subcats, Math.floor((st.now - (sync.lastSyncAt || 0)) / 30000), !!s.apiKey]);
    if (dl.dataset.sig !== sig) { dl.dataset.sig = sig; dl.replaceChildren(...rows); }
}

function wireSync() {
    const box = $('#syncEnabled');
    // `click`, not `change`, so the permission prompt runs inside the user gesture in Firefox too
    box.addEventListener('click', async () => {
        const on = box.checked;
        if (on && !(settings && settings.apiKey)) { box.checked = false; msg('#syncMsg', 'Save an API key first.', 'bad'); return; }
        if (on) {
            let granted = false;
            try { granted = await requestApiPermission(); } catch (e) { msg('#syncMsg', `Permission request failed: ${e.message}`, 'bad'); }
            if (!granted) { box.checked = false; msg('#syncMsg', `Sync needs access to ${apiHost()}.`, 'bad'); return; }
        }
        if (await save({ syncEnabled: on })) {
            renderKey();
            msg('#syncMsg', on ? 'Sync on.' : 'Sync off.', 'muted');
            if (on) { try { const r = await send('syncNow'); renderSyncStatus({ ...(ctx.getStats() || {}), sync: r.sync, now: Date.now() }); } catch { /* status line shows it */ } }
        } else box.checked = !on;
    });
    $('#syncNow').addEventListener('click', async () => {
        const btn = $('#syncNow');
        btn.disabled = true;
        msg('#syncMsg', 'Syncing…', 'muted');
        try {
            const r = await send('syncNow');
            renderSyncStatus({ ...(ctx.getStats() || {}), sync: r.sync, now: Date.now() });
            const st = r.sync && r.sync.state;
            msg('#syncMsg', st === 'ok' ? 'Done ✓' : st === 'error' || st === 'auth-error' ? 'Sync failed — see below.' : 'Queued.', st === 'ok' ? 'ok' : st && st.includes('error') ? 'bad' : 'muted');
        } catch (e) { msg('#syncMsg', e.message, 'bad'); }
        btn.disabled = false;
        ctx.refresh();
    });

    $('#apiBaseSave').addEventListener('click', async () => {
        const raw = $('#apiBase').value.trim().replace(/\/+$/, '');
        let url;
        try { url = new URL(raw); } catch { msg('#apiBaseMsg', 'Not a valid URL.', 'bad'); return; }
        if (!/^https?:$/.test(url.protocol)) { msg('#apiBaseMsg', 'Use an http(s) URL.', 'bad'); return; }
        let granted = false;
        try { granted = await requestApiPermission(raw); } catch (e) { msg('#apiBaseMsg', `Can’t get access to ${url.host}: ${e.message}`, 'bad'); return; }
        if (await save({ apiBase: raw })) msg('#apiBaseMsg', granted ? 'Saved ✓' : `Saved, but access to ${url.host} wasn’t granted.`, granted ? 'ok' : 'bad');
    });
    $('#apiBaseReset').addEventListener('click', async () => {
        $('#apiBase').value = DEFAULT_BASE;
        if (await save({ apiBase: DEFAULT_BASE })) msg('#apiBaseMsg', 'Back to the default ✓', 'ok');
    });
}

// ---------------- overrides ----------------
async function loadOverrides() {
    const list = $('#overrides');
    let ovs;
    try { ovs = (await send('getOverrides')).overrides || []; } catch (e) {
        list.replaceChildren(h('li', { class: 'db-ov-empty' }, `Couldn’t load overrides: ${e.message}`));
        return;
    }
    setText($('#ovCount'), ovs.length ? `${ovs.length} marked` : '');
    if (!ovs.length) {
        list.replaceChildren(h('li', { class: 'db-ov-empty', style: { border: '0', background: 'none', padding: '0' } }, 'None yet. Use “Mark as Japanese / Non-Japanese” in the popup on a video.'));
        return;
    }
    ovs.sort((a, b) => (b.at || 0) - (a.at || 0));
    const names = (ctx.getStats() && ctx.getStats().byPlatform) || {};
    list.replaceChildren(...ovs.map((o) => h('li', null,
        h('div', { class: 'db-ov-main' },
            h('span', { class: 'db-ov-label', title: o.label || o.id }, o.label || o.id),
            h('span', { class: 'db-ov-meta' },
                h('span', { class: 'fz-tag' }, o.scope === 'channel' ? 'Channel' : 'Video'),
                h('span', { class: 'fz-tag' + (o.value === 'ja' ? ' accent' : '') }, o.value === 'ja' ? 'Japanese' : 'Non-Japanese'),
                h('span', null, (names[o.platform] && names[o.platform].name) || o.platform),
                o.at ? h('span', null, '· ' + dateOnly(o.at)) : null)),
        h('button', {
            type: 'button', class: 'db-ov-rm', title: 'Remove (back to auto-detection)', 'aria-label': `Remove override for ${o.label || o.id}`,
            onclick: async (e) => {
                e.currentTarget.disabled = true;
                try { await send('setOverride', { scope: o.scope, platform: o.platform, id: o.id, label: o.label, value: null }); }
                catch (err) { ctx.showError(err.message); }
                loadOverrides();
            },
        }, '×'),
    )));
}

// ---------------- data ----------------
/** Inline "are you sure" under `anchor`; resolves true/false. */
function confirmInline(anchor, text, yes) {
    return new Promise((resolve) => {
        const old = anchor.parentElement.querySelector('.db-confirm');
        if (old) old.remove();
        const done = (v) => { box.remove(); resolve(v); };
        const box = h('div', { class: 'db-confirm', role: 'alertdialog' },
            h('p', null, text),
            h('div', { class: 'db-row' },
                h('button', { type: 'button', class: 'fz-btn danger solid', onclick: () => done(true) }, yes),
                h('button', { type: 'button', class: 'fz-btn', onclick: () => done(false) }, 'Cancel')));
        anchor.after(box);
        box.querySelector('.fz-btn:not(.danger)').focus();
    });
}

function readFile(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error || new Error('Could not read the file'));
        r.readAsText(file);
    });
}

function parseJson(text) {
    try { return JSON.parse(text); } catch { throw new Error('That isn’t valid JSON.'); }
}

function looksLikeMikan(d) {
    if (!d || typeof d !== 'object') return false;
    const wd = d.watchData && typeof d.watchData === 'object' ? d.watchData : d;
    return Object.keys(wd).some((k) => /^\d{4}-\d{2}-\d{2}$/.test(k));
}

function wireData() {
    $('#exportBtn').addEventListener('click', async () => {
        try {
            const { data } = await send('exportData');
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const day = (ctx.getStats() && ctx.getStats().todayKey) || new Date().toISOString().slice(0, 10);
            const a = h('a', { href: url, download: `fazon-immersion-${day}.json` });
            document.body.append(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            msg('#dataMsg', 'Exported ✓', 'ok');
        } catch (e) { msg('#dataMsg', `Export failed: ${e.message}`, 'bad'); }
    });

    const file = $('#importFile');
    $('#importBtn').addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
        const f = file.files && file.files[0];
        file.value = '';
        if (!f) return;
        const mode = document.querySelector('input[name="importMode"]:checked').value;
        let data;
        try { data = parseJson(await readFile(f)); } catch (e) { msg('#dataMsg', e.message, 'bad'); return; }
        if (mode === 'replace' && !(await confirmInline($('#importBtn').closest('.db-row'), `Replace all history in this browser with “${f.name}”?`, 'Replace'))) return;
        msg('#dataMsg', 'Importing…', 'muted');
        try { await send('importData', { data, mode }); msg('#dataMsg', `Imported “${f.name}” ✓`, 'ok'); ctx.refresh(); loadOverrides(); }
        catch (e) { msg('#dataMsg', `Import failed: ${e.message}`, 'bad'); }
    });

    // Mikan
    $('#mikanCopy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText($('#mikanCmd').textContent); msg('#mikanMsg', 'Command copied ✓', 'ok'); }
        catch { msg('#mikanMsg', 'Select the command and copy it.', 'muted'); }
    });
    const importMikan = async (text, source) => {
        let data;
        try { data = parseJson(text.trim()); } catch (e) { msg('#mikanMsg', e.message, 'bad'); return; }
        if (!looksLikeMikan(data)) { msg('#mikanMsg', 'That doesn’t look like Mikan data (expected {"watchData": {"2026-06-30": …}}).', 'bad'); return; }
        msg('#mikanMsg', 'Importing…', 'muted');
        try {
            await send('importData', { data, mode: 'merge' });
            const wd = data.watchData || data;
            const n = Object.keys(wd).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)).length;
            msg('#mikanMsg', `Imported ${n} day${n === 1 ? '' : 's'} from Mikan${source ? ` (${source})` : ''} ✓`, 'ok');
            $('#mikanText').value = '';
            ctx.refresh();
        } catch (e) { msg('#mikanMsg', `Import failed: ${e.message}`, 'bad'); }
    };
    $('#mikanImport').addEventListener('click', () => {
        const t = $('#mikanText').value;
        if (!t.trim()) { msg('#mikanMsg', 'Paste the copied data into the box first.', 'bad'); $('#mikanText').focus(); return; }
        importMikan(t);
    });
    const mf = $('#mikanFile');
    $('#mikanFileBtn').addEventListener('click', () => mf.click());
    mf.addEventListener('change', async () => {
        const f = mf.files && mf.files[0];
        mf.value = '';
        if (!f) return;
        try { importMikan(await readFile(f), f.name); } catch (e) { msg('#mikanMsg', e.message, 'bad'); }
    });

    $('#resetBtn').addEventListener('click', async () => {
        const ok = await confirmInline($('#resetRow'), 'Delete all recorded immersion time and overrides from this browser? This can’t be undone.', 'Delete everything');
        if (!ok) return;
        try { await send('resetData'); msg('#resetMsg', 'All data deleted.', 'muted'); ctx.refresh(); loadOverrides(); }
        catch (e) { msg('#resetMsg', `Reset failed: ${e.message}`, 'bad'); }
    });
}

// ---------------- entry points ----------------
export function initSettings(c) {
    ctx = { ...ctx, ...c };
    wireDays();
    wireKey();
    wireSync();
    wireData();
}

export async function onSettingsShown() {
    try {
        const r = await send('getSettings');
        settings = r.settings;
    } catch (e) { ctx.showError(`Couldn’t load settings: ${e.message}`); }
    fillForm();
    const st = ctx.getStats();
    if (st) renderSyncStatus(st);
    loadOverrides();
}

export function updateSettingsFromStats(st) {
    if (!st || !st.settings) return;
    const prevKey = settings && settings.apiKey, prevSync = settings && settings.syncEnabled;
    settings = { ...(settings || {}), ...st.settings };
    if (!formFilled && !$('#viewSettings').hidden) fillForm();
    if (prevKey !== settings.apiKey || prevSync !== settings.syncEnabled) {
        if (document.activeElement !== $('#syncEnabled')) $('#syncEnabled').checked = !!settings.syncEnabled;
        renderKey();
    }
    if (!$('#viewSettings').hidden) { renderSyncStatus(st); renderTargetNote(); }
}
