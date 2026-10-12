// Popup v2 — "what's happening right now?": now playing (+ live counter, reason, overrides),
// today against the daily target, this week as a 7-bar strip, sync status.
import { initTheme } from '../ui/theme.js';
import { send, onStatsChanged, getActiveTab, openExtensionPage, patternsForUrl, supportedHosts } from '../ui/api.js';
import { h, $, setText } from '../ui/dom.js';
import { clock, hm, ago, addDays, weekStartOf, weekdayOf, WD } from '../ui/format.js';
import { trackWeekProgress, trackWeekWindow } from '../ui/series.js';

const DASHBOARD = 'src/dashboard/dashboard.html';
const openDash = (hash = '') => openExtensionPage(DASHBOARD + hash, { closeWindow: true });

initTheme();
$('#openDashboard').addEventListener('click', () => openDash());
$('#openSettings').addEventListener('click', () => openDash('#settings'));
$('#week').addEventListener('click', () => openDash());

let tab = null;
let granted = false;
let nowSig = '';
let stats = null;

function showError(msg) { const el = $('#err'); el.hidden = !msg; setText(el, msg || ''); }

// =============== now playing ===============
async function refreshStatus() {
    if (!tab) tab = await getActiveTab();
    let status = null, error = null;
    if (tab && tab.id != null) {
        try { status = await send('getStatus', { tabId: tab.id }); } catch (e) { error = e.message; }
    }
    // rebuild the card only when something other than the live counter changed
    const m = status && status.media;
    const sig = JSON.stringify([status && { ...status, media: m && { ...m, sessionSeconds: undefined } }, error, granted, tab && tab.url]);
    if (sig !== nowSig) { nowSig = sig; renderNow(status, error); }
    const c = $('#nowCounter');
    if (c && m && m.sessionSeconds != null) setText(c, clock(m.sessionSeconds));
}

function nowCard(cls, stateText, dot, ...body) {
    const el = $('#now');
    el.className = 'pp-now ' + (cls || '');
    el.replaceChildren(
        h('div', { class: 'pp-now-top' }, h('span', { class: 'pp-state' }, h('span', { class: 'fz-dot ' + (dot || '') }), h('span', null, stateText))),
        ...body.filter(Boolean),
    );
}
function hostOf(url) { try { return new URL(url).hostname.replace(/^(www|m)\./, ''); } catch { return ''; } }
function reloadButton() {
    return h('button', { type: 'button', class: 'fz-btn small primary', onclick: async () => { try { await chrome.tabs.reload(tab.id); } catch { /* ignore */ } window.close(); } }, 'Reload tab');
}

function renderNow(status, error) {
    if (error) { nowCard('warn', 'Can’t read this tab', 'warn', h('p', { class: 'pp-msg' }, error)); return; }
    if (!status || !status.platform) {
        const hosts = supportedHosts();
        nowCard('', 'Nothing playing', '', h('p', { class: 'pp-empty-h' }, 'Not a supported site'),
            h('p', { class: 'pp-msg' }, `Open a video on ${hosts.length ? hosts.join(', ') : 'a supported site'} and Japanese time is counted while it plays.`));
        return;
    }
    const platform = status.platform;
    if (!status.hasSitePermission || (granted && !status.media)) {
        const host = hostOf(tab && tab.url) || platform.name;
        if (granted) { nowCard('warn', 'Access granted', 'warn', h('p', { class: 'pp-msg' }, 'Reload the tab so tracking can start.'), h('div', { class: 'pp-ctl' }, reloadButton())); return; }
        nowCard('warn', 'Needs access', 'warn',
            h('p', { class: 'pp-empty-h' }, `Allow access to ${host}`),
            h('p', { class: 'pp-msg' }, `Your browser hasn’t let this extension see ${platform.name} yet, so it can’t tell what’s playing.`),
            h('div', { class: 'pp-ctl' }, h('button', { type: 'button', class: 'fz-btn small primary', onclick: () => grantAccess(platform) }, 'Grant access')));
        return;
    }
    const m = status.media;
    if (!m) {
        nowCard('', 'Nothing playing', '', h('p', { class: 'pp-empty-h' }, `Open a ${platform.name} video`),
            h('p', { class: 'pp-msg' }, 'Japanese videos are counted while they play with sound.'));
        return;
    }

    const ov = m.override || {};
    let state, cls = '', dot = '';
    if (status.tracking) { state = 'Counting'; cls = 'live'; dot = 'on'; }
    else if (m.checking && !ov.video && !ov.channel) state = 'Checking language…';
    else if (!m.japanese) state = 'Not Japanese · not counted';
    else if (m.ad) { state = 'Ad · paused'; cls = 'warn'; dot = 'warn'; }
    else if (m.muted && !m.countMuted) { state = 'Muted · not counted'; cls = 'warn'; dot = 'warn'; }
    else if (m.buffering) state = 'Buffering';
    else if (m.paused || !m.playing) state = 'Paused';
    else state = 'Not counting';

    let source;
    if (ov.video) source = ov.video === 'ja' ? 'You marked this video as Japanese' : 'You marked this video as not Japanese';
    else if (ov.channel) source = ov.channel === 'ja' ? 'Channel set to always Japanese' : 'Channel set to never Japanese';
    else if (m.checking) source = 'Looking at the title, channel and captions…';
    else source = m.detected ? 'Detected as Japanese' : 'No Japanese detected';
    const reason = m.reason ? String(m.reason) : source;

    const counter = m.sessionSeconds != null && (m.japanese || m.sessionSeconds > 0)
        ? h('div', { class: 'pp-counter', title: 'Counted for this video today' }, h('b', { id: 'nowCounter' }, clock(m.sessionSeconds)), h('span', null, 'this video today'))
        : null;

    const setVideo = (value) => override('video', platform, m.videoId, m.title || m.videoId, value);
    const curCh = ov.channel || null;
    const chOpt = (value, label, title) => h('button', {
        type: 'button', 'aria-pressed': String(curCh === value), title,
        onclick: () => override('channel', platform, m.channelId, m.channel || m.channelId, value),
    }, label);

    const el = $('#now');
    el.className = 'pp-now ' + cls;
    el.replaceChildren(
        h('div', { class: 'pp-now-top' },
            h('span', { class: 'pp-state' }, h('span', { class: 'fz-dot ' + dot }), h('span', null, state)),
            counter),
        m.channel ? h('span', { class: 'pp-chan', title: m.channel }, m.channel) : null,
        m.title ? h('div', { class: 'pp-title', title: m.title }, m.title) : null,
        h('div', { class: 'pp-reason' + (m.japanese ? '' : ' no') }, h('i', { 'aria-hidden': 'true' }, m.japanese ? '✓' : '✕'), h('span', { class: 'fz-muted' }, reason)),
        h('div', { class: 'pp-ctl' },
            h('span', null,
                m.japanese
                    ? h('button', { type: 'button', class: 'fz-btn', onclick: () => setVideo('non-ja'), title: 'Stop counting this video' }, 'Not Japanese')
                    : h('button', { type: 'button', class: 'fz-btn primary', onclick: () => setVideo('ja'), title: 'Count this video' }, 'Mark as Japanese'),
                ov.video ? h('button', { type: 'button', class: 'fz-linkbtn', style: { marginLeft: '8px' }, onclick: () => setVideo(null) }, 'Reset') : null),
            m.channelId ? h('span', { class: 'pp-ctl-ch' }, 'Channel',
                h('span', { class: 'fz-seg', role: 'group', 'aria-label': 'Treat this channel as Japanese' },
                    chOpt(null, 'Auto', 'Detect each video automatically'),
                    chOpt('ja', 'Always', 'Always treat this channel as Japanese'),
                    chOpt('non-ja', 'Never', 'Never treat this channel as Japanese'))) : null),
    );
}

async function override(scope, platform, id, label, value) {
    try { await send('setOverride', { scope, platform: platform.id, id, label, value }); showError(''); }
    catch (e) { showError(e.message); }
    nowSig = '';
    await refreshStatus();
    refreshStats();
}

async function grantAccess(platform) {
    // first await of the click handler (user gesture)
    const origins = patternsForUrl(tab && tab.url ? tab.url : '', platform.matches);
    let ok = false;
    try { ok = await chrome.permissions.request({ origins }); } catch (e) { showError(e.message); return; }
    if (ok) granted = true;
    nowSig = '';
    refreshStatus();
}

// =============== today, week, sync ===============
async function refreshStats() {
    try { stats = await send('getStats'); } catch (e) { showError(e.message); return; }
    showError('');
    renderToday(stats);
    renderWeek(stats);
    renderFoot(stats);
}

function renderToday(st) {
    const t = st.target || {};
    const box = $('#today');
    const today = st.today || 0;
    if (!t.daily) {
        box.replaceChildren(h('div', { class: 'pp-today-h' },
            h('span', { class: 'pp-today-l' }, 'Today'),
            h('span', { class: 'pp-today-v' }, h('b', null, hm(today)))),
        h('div', { class: 'pp-today-sub' }, h('span', null, ''),
            h('button', { type: 'button', class: 'fz-linkbtn', onclick: () => openDash('#settings') }, 'Set a daily target')));
        return;
    }
    const pct = Math.min(100, (today / t.daily) * 100);
    const met = today >= t.daily;
    // with a Track goal, today's bar still counts only this tracker's time (Track keeps weekly totals)
    const fromTrack = !!trackWeekProgress(st);
    box.title = fromTrack ? `Today's time recorded by this tracker, against the daily share (${hm(t.daily)}) of your Track weekly goal. Hours you log on fazon.nexus by hand count in the Track week below, not here.` : '';
    const fill = h('span'); fill.style.width = pct.toFixed(1) + '%';
    box.replaceChildren(
        h('div', { class: 'pp-today-h' },
            h('span', { class: 'pp-today-l' }, 'Today'),
            h('span', { class: 'pp-today-v' }, h('b', null, hm(today)), h('span', null, ` of ${hm(t.daily)}`))),
        h('div', { class: 'fz-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)), 'aria-label': 'Daily target' }, fill),
        h('div', { class: 'pp-today-sub' },
            met ? h('span', { class: 'met' }, `✓ target met +${hm(today - t.daily)}`) : h('span', null, `${hm(t.daily - today)} to go`),
            h('span', null, fromTrack ? 'recorded by this tracker' : t.source === 'track' ? 'from your Track goal' : 'your daily target')),
    );
}

function renderWeek(st) {
    const ws = Number(st.settings?.weekStart ?? 0);
    const start = weekStartOf(st.todayKey, ws);
    const days = st.days || {};
    const t = st.target || {};
    const keys = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    const max = Math.max(t.daily || 0, ...keys.map((k) => days[k] || 0), 1);
    const cols = keys.map((k) => {
        const sec = k <= st.todayKey ? days[k] || 0 : 0;
        const bar = h('span', { class: 'pp-wk-bar' + (sec ? '' : ' zero') });
        bar.style.height = sec ? `${Math.max(8, (sec / max) * 100)}%` : '2px';
        if (k > st.todayKey) bar.style.opacity = '0.4';
        const cls = 'pp-wk-col' + (k === st.todayKey ? ' today' : '') + (t.daily && sec >= t.daily ? ' met' : '');
        return h('span', { class: cls, title: `${WD[weekdayOf(k)]}: ${k > st.todayKey ? '—' : hm(sec)}` },
            h('span', { class: 'pp-wk-plot' }, bar),
            h('span', { class: 'pp-wk-d' }, WD[weekdayOf(k)].slice(0, 2)));
    });
    const bars = h('span', { class: 'pp-wk-bars' }, ...cols);
    if (t.daily) {
        const line = h('span', { class: 'pp-wk-target', title: `Daily target ${hm(t.daily)}` });
        line.style.bottom = `calc(${(t.daily / max) * 38}px + 0.64em + 3px)`;
        bars.append(line);
    }
    const wk = st.week || 0;
    const tw = trackWeekProgress(st);
    if (tw) {
        // bars = this tracker's days; the headline = the Track week (incl. hours logged on the site)
        const met = tw.seconds >= tw.target, ahead = tw.seconds >= tw.expected;
        const fill = h('span'); fill.style.width = Math.min(100, (tw.seconds / tw.target) * 100).toFixed(1) + '%';
        $('#week').title = `Track week ${trackWeekWindow(tw)}: ${hm(tw.synced)} on fazon.nexus${tw.pending ? ` + ${hm(tw.pending)} not yet synced` : ''} of your ${hm(tw.target)} weekly goal. Bars: this tracker's days (${hm(wk)} this week).`;
        $('#week').replaceChildren(bars,
            h('span', { class: 'pp-wk-sum' },
                h('span', null, 'Track week'),
                h('b', null, hm(tw.seconds)),
                h('span', null, met ? '✓ goal met' : `of ${hm(tw.target)}`),
                h('span', { class: 'fz-bar pp-wk-bar-t' + (met ? ' met' : '') }, fill),
                met ? null : h('span', { class: 'pp-wk-pace' + (ahead ? ' ok' : '') }, ahead ? 'on pace' : `${hm(tw.expected - tw.seconds)} behind`)));
        return;
    }
    $('#week').title = 'Open the dashboard';
    $('#week').replaceChildren(bars,
        h('span', { class: 'pp-wk-sum' },
            h('span', null, 'This week'),
            h('b', null, hm(wk)),
            t.weekly ? h('span', null, wk >= t.weekly ? '✓ weekly target' : `of ${hm(t.weekly)}`) : null));
}

function renderFoot(st) {
    const s = st.settings || {}, sync = st.sync || {};
    const parts = [];
    if (s.syncEnabled) {
        const map = {
            ok: ['ok', `Synced to fazon.nexus · ${ago(sync.lastSyncAt, st.now)}`],
            pending: ['warn', `Sync pending · ${hm(sync.pendingSeconds || 0)} to send`],
            error: ['bad', 'Sync error — retrying'],
            'auth-error': ['bad', 'fazon.nexus rejected the key'],
        };
        const [dot, text] = map[sync.state] || ['', 'Sync on · waiting for the first sync'];
        parts.push(h('span', { class: 'fz-dot ' + dot }), h('span', null, text));
        if (sync.state === 'error' || sync.state === 'auth-error') parts.push(h('a', { href: '#', onclick: (e) => { e.preventDefault(); openDash('#settings'); } }, 'Fix'));
    } else {
        parts.push(h('a', { href: '#', onclick: (e) => { e.preventDefault(); openDash('#settings'); } }, 'Sync to fazon.nexus Track'));
    }
    let ver = '';
    try { ver = 'v' + chrome.runtime.getManifest().version; } catch { /* ignore */ }
    parts.push(h('span', { class: 'pp-ver' }, ver));
    const el = $('#foot');
    const sig = JSON.stringify([s.syncEnabled, sync.state, Math.floor((st.now - (sync.lastSyncAt || 0)) / 30000), sync.pendingSeconds]);
    if (el.dataset.sig !== sig) { el.dataset.sig = sig; el.replaceChildren(...parts); }
}

// =============== start ===============
refreshStatus();
refreshStats();
setInterval(refreshStats, 1000);
setInterval(refreshStatus, 1000);
onStatsChanged(() => { refreshStats(); refreshStatus(); });
