// Dashboard v2 — "how am I doing over time?": cumulative hero with milestones + projection,
// an at-a-glance strip, week-by-week trend, channels, rhythm (heatmap + typical week), platforms.
import { initTheme } from '../ui/theme.js';
import { send, onStatsChanged } from '../ui/api.js';
import { h, $, $$, setText } from '../ui/dom.js';
import { hm, hDec, hLabel, longDay, shortDay, monthName, daysBetween, plural, ago } from '../ui/format.js';
import { pace, milestones, projectDate, streaks, trackDays, trackPace, trackWeekProgress, trackWeekWindow } from '../ui/series.js';
import { renderHero, renderWeeks, renderChannels, renderRhythm, renderPlatforms, setTooltipElement, hideTip } from './charts.js';
import { initSettings, onSettingsShown, updateSettingsFromStats } from './settings.js';

initTheme();
setTooltipElement($('#tip'));
try { setText($('#version'), 'v' + chrome.runtime.getManifest().version); } catch { /* ignore */ }

let stats = null;
let chartSig = '';
let chRange = 'month';
try { const r = localStorage.getItem('fz-ch-range'); if (['week', 'month', 'allTime'].includes(r)) chRange = r; } catch { /* ignore */ }
for (const x of $$('#chRange button')) x.setAttribute('aria-pressed', String(x.dataset.r === chRange));
let chExpanded = false;

export function showError(msg) { const el = $('#err'); el.hidden = !msg; setText(el, msg || ''); }

// ---------------- views (#settings → settings, anything else → overview) ----------------
function currentView() { return location.hash === '#settings' ? 'settings' : 'overview'; }
function applyView() {
    const v = currentView();
    $('#viewOverview').hidden = v !== 'overview';
    $('#viewSettings').hidden = v !== 'settings';
    for (const a of $$('.db-nav a')) {
        if (a.dataset.nav === v) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
    }
    document.title = v === 'settings' ? 'Settings · Active Immersion Tracker' : 'Active Immersion Tracker';
    hideTip();
    if (v === 'settings') onSettingsShown();
    else if (stats) { chartSig = ''; renderOverview(stats); }
}
document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[data-nav]');
    if (!a) return;
    e.preventDefault();
    const v = a.dataset.nav;
    history.pushState(null, '', location.pathname + location.search + (v === 'settings' ? '#settings' : ''));
    applyView();
    const target = a.dataset.scroll && document.getElementById(a.dataset.scroll);
    if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); const d = target.querySelector('details'); if (d) d.open = true; }
    else window.scrollTo(0, 0);
});
window.addEventListener('popstate', applyView);
window.addEventListener('hashchange', applyView);

$('#chRange').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-r]');
    if (!b) return;
    chRange = b.dataset.r;
    chExpanded = false;
    try { localStorage.setItem('fz-ch-range', chRange); } catch { /* ignore */ }
    for (const x of $$('#chRange button')) x.setAttribute('aria-pressed', String(x === b));
    if (stats) drawChannels(stats);
});

// ---------------- overview ----------------
/** getStats.resolve = {pending, done, failed}: channel lookups for imported (channel-less) history. */
function renderResolve(st) {
    const r = st.resolve, el = $('#chResolve');
    if (!r || !(r.pending > 0)) { el.hidden = true; return; }
    const total = (r.pending || 0) + (r.done || 0) + (r.failed || 0);
    const doneN = (r.done || 0) + (r.failed || 0);
    el.hidden = false;
    el.title = `Imported history has no channel data; the extension is looking up each video's channel (${(r.failed || 0).toLocaleString('en')} couldn't be found).`;
    el.replaceChildren(h('span', { class: 'fz-dot warn' }),
        h('span', null, `Looking up channels for imported history… ${doneN.toLocaleString('en')}/${total.toLocaleString('en')}`));
}

function drawChannels(st) {
    const names = Object.fromEntries(Object.entries(st.byPlatform || {}).map(([id, p]) => [id, p.name]));
    renderChannels($('#channels'), st.channels || [], chRange, chExpanded, () => { chExpanded = !chExpanded; drawChannels(st); }, names);
}

/**
 * getStats.track = {state, activeAllTime, pendingSeconds, fetchedAt, error}: the user's all-time
 * Active immersion on fazon.nexus Track. Shown next to (never mixed into) this tracker's own total.
 */
function renderTrackTotal(st) {
    const t = st.track || { state: 'off' };
    const has = t.activeAllTime != null && (t.state === 'ok' || t.state === 'error');
    $('.db-hero-totals').classList.toggle('two', has);
    $('#trackFig').hidden = !has;
    const cap = $('#heroCap');
    cap.hidden = !has;
    setText(cap, hasTrack(st)
        ? 'Chart, milestones and projection: fazon.nexus Track active hours (weekly totals, spread over each week; projection at your pace over the last 4 complete Track weeks). Everything below: this tracker’s own recordings.'
        : 'Chart, milestones, projection and the figures below use this tracker’s own recordings.');
    setText($('#hTotal'), has ? 'Recorded by this tracker' : 'Active immersion, all time');
    if (has) {
        const pend = t.pendingSeconds || 0;
        setText($('#trackTotal'), hm(t.activeAllTime + pend));
        const bits = [];
        if (pend > 0) bits.push(`incl. ${hm(pend)} not yet synced`);
        if (t.fetchedAt) bits.push(`updated ${ago(t.fetchedAt)}`);
        setText($('#trackSub'), bits.join(' · '));
        $('#trackFig').title = `All-time Active immersion on your fazon.nexus Track${pend ? `, plus ${hm(pend)} tracked here and not synced yet` : ''}. Includes hours logged by hand or from other sources.`;
    }
    const note = $('#trackNote');
    let sig = '';
    if (t.state === 'error') sig = 'e|' + (t.error || '');
    else if (t.state === 'loading') sig = 'l';
    if (note.dataset.sig === sig) return;
    note.dataset.sig = sig;
    note.hidden = !sig;
    if (t.state === 'error') {
        note.replaceChildren(`Couldn’t read your Track total — ${t.error || 'unknown error'} · `,
            h('a', { href: '#settings', 'data-nav': 'settings', 'data-scroll': 'secSync' }, 'Settings'));
    } else if (t.state === 'loading') {
        note.replaceChildren('Reading your fazon.nexus Track total…');
    }
}

const hasTrack = (st) => {
    const t = st.track;
    return !!t && t.activeAllTime != null && (t.state === 'ok' || t.state === 'error') && Array.isArray(t.weeks) && t.weeks.length > 0;
};

/**
 * What the hero chart, milestones and projection are about: fazon.nexus Track's cumulative active
 * hours when available (weekly totals spread over each week's days, unsynced seconds on today,
 * pace = last 4 complete Track weeks), else this tracker's own days (30-day pace).
 */
function heroModel(st) {
    const milestonesH = st.settings && st.settings.milestonesH;
    if (hasTrack(st)) {
        const t = st.track;
        const pend = t.pendingSeconds || 0;
        const { days, firstDay } = trackDays(t.weeks, st.todayKey, pend);
        const p = trackPace(t.weeks, st.todayKey);
        return {
            source: 'track', days, firstDay, todayKey: st.todayKey, total: t.activeAllTime + pend, paceSec: p.pace, milestonesH,
            basis: p.weeks ? `Track pace over the last ${plural(p.weeks, 'complete week')}` : 'Track pace this week',
        };
    }
    const span = st.firstDay ? daysBetween(st.firstDay, st.todayKey) + 1 : 0;
    return {
        source: 'tracker', days: st.days || {}, firstDay: st.firstDay, todayKey: st.todayKey, total: st.allTime, milestonesH,
        paceSec: pace(st.days || {}, st.todayKey, st.firstDay), basis: span < 30 ? `${plural(span, 'day')} so far` : '30-day pace',
    };
}

function renderHeroHead(st, model) {
    renderTrackTotal(st);
    setText($('#allTime'), hm(st.allTime));
    const span = st.firstDay ? daysBetween(st.firstDay, st.todayKey) + 1 : 0;
    const active = Object.values(st.days || {}).filter((v) => v > 0).length;
    setText($('#since'), st.firstDay ? `since ${longDay(st.firstDay)} · ${plural(active, 'active day')} of ${span}` : 'Your first session will start the count.');

    const total = model.total, paceSec = model.paceSec;
    const ms = milestones(total, model.milestonesH);
    const box = $('#nextMs');
    if (ms.next == null) {
        box.replaceChildren(h('span', { class: 'db-kicker' }, 'Every milestone passed'), h('b', null, `${hLabel(ms.passed[ms.passed.length - 1])} ✓`));
        $('#heroNote').replaceChildren();
        return;
    }
    // Progress towards the milestone from zero, so the bar matches the total shown beside it.
    const pct = (total / 3600 / ms.next) * 100;
    const fill = h('span'); fill.style.width = Math.max(0, Math.min(100, pct)).toFixed(1) + '%';
    box.replaceChildren(
        h('span', { class: 'db-kicker' }, model.source === 'track' ? 'Next Track milestone' : 'Next milestone'),
        h('b', { class: 'db-next-v' }, hLabel(ms.next)),
        h('div', { class: 'fz-bar', title: `${hm(total)} of ${hLabel(ms.next)} (${Math.round(pct)}%)` }, fill),
        h('span', { class: 'db-hero-sub' }, `${hm(ms.next * 3600 - total)} to go`));

    // projection sentence
    const when = projectDate(total, paceSec, ms.next, st.todayKey);
    const note = $('#heroNote');
    if (!total) { note.replaceChildren(); return; }
    const basis = model.basis;
    if (!when) {
        note.replaceChildren(model.source === 'track'
            ? `No Track hours in the last 4 weeks — log some to get a projection for ${hLabel(ms.next)}.`
            : `No time in the last 30 days — play something to get a projection for ${hLabel(ms.next)}.`);
        return;
    }
    note.replaceChildren(
        h('span', { class: 'db-proj-key', 'aria-hidden': 'true' }),
        h('b', null, hLabel(ms.next)), ' around ', h('b', null, longDay(when)),
        ` at your ${basis} (${hDec(paceSec)}/day)`,
        daysBetween(st.todayKey, when) > 0 ? h('span', { class: 'fz-muted' }, ` · in ${plural(daysBetween(st.todayKey, when), 'day')}`) : null);
}

function stat(label, value, sub, extra) {
    return h('div', { class: 'db-stat', title: extra && extra.title }, h('span', { class: 'db-stat-l' }, label, extra && extra.info), h('b', { class: 'db-stat-v' }, value), extra && extra.bar, sub ? h('span', { class: 'db-stat-s' }, sub) : null, extra && extra.foot);
}
function bar(v, t) {
    if (!t) return null;
    const f = h('span'); f.style.width = Math.min(100, (v / t) * 100).toFixed(1) + '%';
    return h('div', { class: 'fz-bar' + (v >= t ? ' met' : '') }, f);
}
function renderStrip(st) {
    const t = st.target || {};
    const src = t.source === 'track' ? 'Track goal' : 'target';
    const sk = streaks(st.days || {}, st.todayKey);
    const info = h('span', { class: 'db-info-wrap' },
        h('button', { type: 'button', class: 'db-info', 'aria-describedby': 'monthlyTip', 'aria-label': 'How the monthly average is worked out' }, 'i'),
        h('span', { class: 'db-info-tip', id: 'monthlyTip', role: 'tooltip' }, 'Daily average × 30.44 (the average month length). A month you only tracked part of isn’t counted as a whole month.'));
    const tw = trackWeekProgress(st);   // Track-sourced weekly goal → measure the week on Track's own total
    const sig = [hm(st.today), hm(st.week), hm(st.month), hm(st.dailyAverage), t.daily, t.weekly, t.source, sk.current, sk.longest, sk.activeToday, st.todayKey,
        tw && [tw.key, hm(tw.seconds), Math.floor(tw.expected / 600), tw.stale]].join('|');
    const box = $('#strip');
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    const todaySub = t.daily ? (st.today >= t.daily ? `✓ ${src} met` : `${hm(t.daily - st.today)} to go`) : null;
    const weekSub = t.weekly ? (st.week >= t.weekly ? `✓ ${src} met` : `${hm(t.weekly - st.week)} to go`) : null;
    let todayCell, weekCell;
    if (tw) {
        // Track keeps weekly totals only, so today stays on this tracker's time — and says so
        todayCell = stat('Today · tracker', hm(st.today), t.daily ? (st.today >= t.daily ? '✓ daily share met' : `${hm(t.daily - st.today)} to go`) : null,
            { bar: bar(st.today, t.daily), title: `${hm(st.today)} recorded by this tracker today${t.daily ? ` · daily share of your Track goal: ${hm(t.daily)}` : ''}. Track only stores weekly totals, so hours you log on fazon.nexus by hand aren't in this figure.` });
        const met = tw.seconds >= tw.target;
        const ahead = tw.seconds >= tw.expected;
        const paceTag = met ? null : h('span', { class: 'db-pace' + (ahead ? ' ok' : '') }, ahead ? 'on pace' : `${hm(tw.expected - tw.seconds)} behind`);
        weekCell = stat('Track week', hm(tw.seconds), met ? `✓ Track goal met (+${hm(tw.seconds - tw.target)})` : `${hm(tw.target - tw.seconds)} to go`, {
            bar: bar(tw.seconds, tw.target), foot: paceTag, // under the figures, so the values stay aligned across cells
            title: `Track week ${trackWeekWindow(tw)}: ${hm(tw.synced)} of Active immersion on fazon.nexus${tw.pending ? ` + ${hm(tw.pending)} not yet synced` : ''}${tw.stale ? ' (last value read; Track is unreachable right now)' : ''} — of your ${hm(tw.target)} weekly Track goal. ${met ? '' : ahead ? 'On pace' : `${hm(tw.expected - tw.seconds)} behind the pace`} for ${hm(t.daily || tw.target / 7)} a day.`,
        });
    } else {
        todayCell = stat('Today', hm(st.today), todaySub, { bar: bar(st.today, t.daily), title: t.daily ? `${hm(st.today)} of your ${hm(t.daily)} daily ${src}` : null });
        weekCell = stat('This week', hm(st.week), weekSub, { bar: bar(st.week, t.weekly), title: t.weekly ? `${hm(st.week)} of your ${hm(t.weekly)} weekly ${src}` : null });
    }
    $('#strip').replaceChildren(
        todayCell,
        weekCell,
        stat(monthName(st.todayKey), hm(st.month), 'this month'),
        stat('Daily average', hm(st.dailyAverage), st.firstDay ? `since ${shortDay(st.firstDay)}` : null),
        stat('Monthly average', hm(st.monthlyAverage), 'daily avg × 30.44', { info }),
        stat('Streak', plural(sk.current, 'day'), sk.longest ? `best ${plural(sk.longest, 'day')}${sk.current && !sk.activeToday ? ' · today still open' : ''}` : null),
    );
}

function renderOverview(st) {
    $('#welcome').hidden = st.allTime > 0;
    const model = heroModel(st);
    renderHeroHead(st, model);
    renderStrip(st);
    renderResolve(st);
    // charts change at most once a minute while something plays
    const sig = [st.todayKey, st.settings?.weekStart, Math.floor(st.allTime / 60), st.target?.weekly, (st.channels || []).length, Object.keys(st.byPlatform || {}).length,
        model.source, Math.floor(model.total / 60), st.track?.weeks?.length || 0, String(model.milestonesH || '')].join('|');
    if (sig === chartSig) return;
    chartSig = sig;
    renderHero($('#heroChart'), model);
    renderWeeks($('#weeksChart'), st);
    const t = st.target || {};
    $('#weeksLegend').replaceChildren(...[
        h('span', null, h('i', { class: 'lg-bar' }), 'hours per week'),
        h('span', null, h('i', { class: 'lg-line' }), '4-week average'),
        t.weekly ? h('span', null, h('i', { class: 'lg-target' }), t.source === 'track' ? 'Track goal' : 'target') : null].filter(Boolean));
    drawChannels(st);
    renderRhythm($('#heat'), $('#heatLegend'), $('#profile'), st);
    const sk = streaks(st.days || {}, st.todayKey);
    setText($('#rhythmSub'), st.firstDay ? `longest streak ${plural(sk.longest, 'day')}` : '');
    renderPlatforms($('#platformCard'), $('#platforms'), st.byPlatform);
}

export async function refresh() {
    try { stats = await send('getStats'); showError(''); }
    catch (e) { showError(`Couldn’t load your stats: ${e.message}`); return; }
    if (currentView() === 'overview') renderOverview(stats);
    updateSettingsFromStats(stats);
}
export function forceRedraw() { chartSig = ''; return refresh(); }

initSettings({ refresh: forceRedraw, showError, getStats: () => stats });
applyView();
refresh();
setInterval(refresh, 1000);
onStatsChanged(refresh);
