// Dashboard v2 charts — hand-written SVG/HTML, drawn to the container's width (like fazon.nexus
// Track's fazon-charts.js) and redrawn on resize. Colours are CSS variables, so a theme switch
// needs no redraw. All labels are set as text (channel names/titles are untrusted).
import { h, s } from '../ui/dom.js';
import { hm, hLabel, hDec, short, longDay, shortDay, monthAbbr, addDays, daysBetween, keyToMs, weekdayOf, weekdayName, WD } from '../ui/format.js';
import { cumulative, milestones, projectDate, weeks as weekBuckets, heatRange, weekdayProfile } from '../ui/series.js';

// ---------------- tooltip ----------------
let tipEl = null;
export function setTooltipElement(el) { tipEl = el; }
/** rows: [title, ...lines]; a line may be [label, value] */
export function showTip(x, y, rows) {
    if (!tipEl) return;
    tipEl.replaceChildren(...rows.map((r, i) => i === 0
        ? h('span', { class: 't' }, r)
        : Array.isArray(r) ? h('span', { class: 'r' }, h('span', { class: 'k', style: r[2] ? { background: r[2] } : null }), h('b', null, r[1]), ' ', h('span', { class: 'fz-muted' }, r[0])) : h('span', { class: 'r' }, r)));
    tipEl.hidden = false;
    const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
    let left = Math.max(8, Math.min(x - tw / 2, window.innerWidth - tw - 8));
    let top = y - th - 12;
    if (top < 8) top = y + 16;
    tipEl.style.left = left + 'px';
    tipEl.style.top = top + 'px';
}
export function hideTip() { if (tipEl) tipEl.hidden = true; }

/** Draw `draw(width)` into box now and whenever its width changes. */
const observed = new WeakMap();
export function responsive(box, draw) {
    observed.set(box, draw);
    if (!box._fzRO) {
        let lastW = 0;
        box._fzRO = new ResizeObserver(() => {
            const w = Math.floor(box.clientWidth);
            if (w && w !== lastW) { lastW = w; observed.get(box)(w); }
        });
        box._fzRO.observe(box);
    }
    const w = Math.floor(box.clientWidth);
    if (w) draw(w);
}

function niceStep(max, count) {
    const raw = Math.max(max, 1) / count, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
}
const fix = (n) => Math.round(n * 10) / 10;

// =====================================================================================
// Hero: cumulative hours, milestone lines, dashed projection at the 30-day pace
// =====================================================================================
/**
 * model = { source: 'tracker'|'track', days: {key: s}, firstDay, todayKey, total, paceSec }:
 * this tracker's own days, or fazon.nexus Track's weeks spread over their days (dashboard.js).
 */
export function renderHero(box, model) {
    responsive(box, (W) => drawHero(box, W, model));
}

function drawHero(box, W, m) {
    const st = m, paceSec = m.paceSec, isTrack = m.source === 'track';
    const H = W < 520 ? 200 : 250;
    const P = { l: W < 520 ? 44 : 52, r: W < 520 ? 14 : 22, t: 18, b: 26 };
    const total = m.total || 0;
    const ms = milestones(total);
    const svg = s('svg', { class: 'ch', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img' });
    const defs = s('defs', null, s('linearGradient', { id: 'heroFill', x1: 0, y1: 0, x2: 0, y2: 1 },
        s('stop', { offset: '0', style: 'stop-color: var(--fz-accent); stop-opacity: 0.32' }),
        s('stop', { offset: '1', style: 'stop-color: var(--fz-accent); stop-opacity: 0.02' })));
    svg.append(defs);
    const iw = W - P.l - P.r, ih = H - P.t - P.b;

    if (!total || !st.firstDay) {
        // brand-new: an empty frame with the first milestone waiting
        const y = P.t + ih * 0.18;
        svg.append(
            s('line', { class: 'ch-base', x1: P.l, x2: W - P.r, y1: P.t + ih, y2: P.t + ih }),
            s('line', { class: 'ch-ms next', x1: P.l, x2: W - P.r, y1: y, y2: y }),
            s('text', { class: 'ch-ms-l next', x: P.l - 8, y: y + 4, 'text-anchor': 'end' }, '100 h'),
            s('text', { class: 'ch-empty', x: P.l + iw / 2, y: P.t + ih * 0.6, 'text-anchor': 'middle' }, 'Your line starts with the first Japanese video you play.'),
        );
        box.replaceChildren(svg);
        return;
    }

    const series = cumulative(st.days || {}, st.firstDay, st.todayKey);
    const proj = ms.next != null ? projectDate(total, paceSec, ms.next, st.todayKey) : null;
    const span = series.length;
    const cap = addDays(st.todayKey, Math.max(21, Math.round(span * 0.6)));
    const endKey = proj ? (proj < cap ? proj : cap) : addDays(st.todayKey, Math.max(3, Math.round(span * 0.04)));
    const x0 = keyToMs(st.firstDay), x1 = keyToMs(endKey);
    const X = (key) => P.l + ((keyToMs(key) - x0) / Math.max(1, x1 - x0)) * iw;
    const topH = Math.max(ms.next || 0, total / 3600) * 1.06;
    const Y = (sec) => P.t + ih - (sec / 3600 / topH) * ih;

    // month ticks along the bottom
    const multiYear = st.firstDay.slice(0, 4) !== endKey.slice(0, 4);
    let lastX = -99;
    for (let k = st.firstDay.slice(0, 8) + '01'; k <= endKey; k = addDays(k, 32).slice(0, 8) + '01') {
        if (k < st.firstDay) continue;
        const x = X(k);
        if (x - lastX < 38) continue;
        lastX = x;
        svg.append(s('line', { class: 'ch-tick', x1: x, x2: x, y1: P.t + ih, y2: P.t + ih + 4 }),
            s('text', { class: 'ch-x', x, y: H - 8, 'text-anchor': 'middle' }, monthAbbr(k) + (multiYear ? ' ' + k.slice(2, 4) : '')));
    }
    svg.append(s('line', { class: 'ch-base', x1: P.l, x2: W - P.r, y1: P.t + ih, y2: P.t + ih }),
        s('text', { class: 'ch-ms-l', x: P.l - 8, y: P.t + ih + 4, 'text-anchor': 'end' }, '0'));

    // milestone lines: passed ones (with the day they were crossed) + the next one
    for (const m of ms.passed) {
        const y = Y(m * 3600);
        const hit = series.find((p) => p.total >= m * 3600);
        svg.append(s('line', { class: 'ch-ms', x1: P.l, x2: W - P.r, y1: y, y2: y }),
            s('text', { class: 'ch-ms-l', x: P.l - 8, y: y + 4, 'text-anchor': 'end' }, hLabel(m)));
        if (hit) {
            const x = X(hit.key);
            svg.append(s('circle', { class: 'ch-ms-dot', cx: x, cy: y, r: 3.5 }),
                s('text', { class: 'ch-ms-d', x: x - 6, y: y - 6, 'text-anchor': 'end' }, shortDay(hit.key)));
        }
    }
    if (ms.next != null) {
        const y = Y(ms.next * 3600);
        svg.append(s('line', { class: 'ch-ms next', x1: P.l, x2: W - P.r, y1: y, y2: y }),
            s('text', { class: 'ch-ms-l next', x: P.l - 8, y: y + 4, 'text-anchor': 'end' }, hLabel(ms.next)));
    }

    // area + line
    let d = '';
    series.forEach((p, i) => { d += (i ? 'L' : 'M') + fix(X(p.key)) + ',' + fix(Y(p.total)); });
    const lastPt = series[series.length - 1];
    svg.append(
        s('path', { class: 'ch-area', d: `${d}L${fix(X(lastPt.key))},${P.t + ih}L${fix(X(series[0].key))},${P.t + ih}Z`, fill: 'url(#heroFill)' }),
        s('path', { class: 'ch-line', d }),
    );

    // projection to the next milestone (clipped at the right edge if it's far)
    if (proj && paceSec > 0) {
        const endSec = Math.min(ms.next * 3600, total + paceSec * daysBetween(st.todayKey, endKey));
        const px = X(endKey), py = Y(endSec);
        svg.append(s('line', { class: 'ch-proj', x1: X(lastPt.key), y1: Y(lastPt.total), x2: px, y2: py }));
        if (proj <= endKey) {
            svg.append(s('circle', { class: 'ch-proj-dot', cx: px, cy: py, r: 4 }),
                s('text', { class: 'ch-proj-l', x: px - 6, y: py - 8, 'text-anchor': 'end' }, `~${shortDay(proj)}`));
        }
    }
    svg.append(s('circle', { class: 'ch-now', cx: X(lastPt.key), cy: Y(lastPt.total), r: 4.5 }));

    // hover: crosshair + tooltip
    const cross = s('line', { class: 'ch-cross', y1: P.t, y2: P.t + ih, visibility: 'hidden' });
    const dot = s('circle', { class: 'ch-hover', r: 4, visibility: 'hidden' });
    const hit = s('rect', { class: 'ch-hit', x: P.l, y: 0, width: iw, height: H });
    svg.append(cross, dot, hit);
    const move = (e) => {
        const r = svg.getBoundingClientRect();
        const mx = e.clientX - r.left;
        const t = x0 + ((mx - P.l) / iw) * (x1 - x0);
        const i = Math.max(0, Math.min(series.length - 1, Math.round((t - x0) / 864e5)));
        const p = series[i];
        const cx = X(p.key), cy = Y(p.total);
        cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
        dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.setAttribute('visibility', 'visible');
        showTip(r.left + cx, r.top + cy, [longDay(p.key), [isTrack ? 'Track total' : 'total', hm(p.total)], [isTrack ? 'that day (week ÷ days)' : 'that day', p.day ? hm(p.day) : '—']]);
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); hideTip(); });
    svg.setAttribute('aria-label', `Cumulative ${isTrack ? 'fazon.nexus Track active immersion' : 'immersion recorded by this tracker'}: ${hm(total)} since ${longDay(st.firstDay)}.`);
    box.replaceChildren(svg);
}

// =====================================================================================
// Week by week: weekly bars + a calm trend (trailing 4-week average, one point per week,
// h/day on the right axis) + the weekly target
// =====================================================================================
export function renderWeeks(box, st) {
    responsive(box, (W) => drawWeeks(box, W, st));
}

function drawWeeks(box, W, st) {
    const ws = Number(st.settings?.weekStart ?? 0);
    const days = st.days || {};
    const H = W < 520 ? 190 : 220;
    const P = { l: 40, r: 40, t: 16, b: 26 };
    const weeksOfData = st.firstDay ? Math.floor(daysBetween(st.firstDay, st.todayKey) / 7) + 1 : 1;
    const fit = Math.floor((W - P.l - P.r) / 26);
    const n = Math.max(4, Math.min(16, fit, Math.max(8, weeksOfData)));
    const all = weekBuckets(days, st.todayKey, ws, n + 3);   // 3 extra weeks feed the first trend points
    const wk = all.slice(3);
    // days that count towards an average: from the first tracked day, up to today
    const counted = (w) => {
        if (!st.firstDay || w.end < st.firstDay) return 0;
        const from = w.start < st.firstDay ? st.firstDay : w.start;
        const to = w.end > st.todayKey ? st.todayKey : w.end;
        return Math.max(0, daysBetween(from, to) + 1);
    };
    const trend = wk.map((_, i) => {
        const win = all.slice(i, i + 4);
        const d = win.reduce((a, w) => a + counted(w), 0);
        return d ? win.reduce((a, w) => a + w.seconds, 0) / d : null;   // seconds per day
    });
    const target = st.target?.weekly || 0;
    const maxV = Math.max(target * 1.08, ...wk.map((w) => w.seconds), ...trend.map((t) => (t || 0) * 7), 14 * 3600) / 3600;
    // weekly ticks in multiples of 7 h so the right-hand h/day labels are whole numbers too
    const dayStep = Math.max(1, niceStep(maxV / 7, 4));
    const step = dayStep * 7;
    const top = Math.ceil(maxV / step - 1e-9) * step;
    const iw = W - P.l - P.r, ih = H - P.t - P.b;
    const Y = (hrs) => P.t + ih - (hrs / top) * ih;
    const slot = iw / n, bw = Math.min(34, slot * 0.62);
    const svg = s('svg', { class: 'ch', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img' });

    for (let v = 0; v <= top + 1e-9; v += step) {
        const y = Y(v);
        svg.append(s('line', { class: v ? 'ch-grid' : 'ch-base', x1: P.l, x2: W - P.r, y1: y, y2: y }),
            s('text', { class: 'ch-y', x: P.l - 7, y: y + 4, 'text-anchor': 'end' }, `${fix(v)}h`),
            s('text', { class: 'ch-y r', x: W - P.r + 7, y: y + 4 }, String(fix(v / 7))));
    }
    svg.append(s('text', { class: 'ch-unit', x: P.l - 7, y: 9, 'text-anchor': 'end' }, 'h/week'),
        s('text', { class: 'ch-unit', x: W - P.r + 7, y: 9 }, 'h/day'));

    // layers: bars → target → trend → value labels → hover targets
    const gBars = s('g'), gTrend = s('g'), gLabels = s('g'), gHit = s('g');
    const labelEvery = slot < 34 ? 2 : 1;
    const cx = (i) => P.l + slot * i + slot / 2;
    wk.forEach((w, i) => {
        const x = cx(i) - bw / 2;
        const y = Y(w.seconds / 3600);
        const g = s('g', { class: 'ch-col' + (w.partial ? ' partial' : '') + (target && w.seconds >= target ? ' met' : '') });
        if (w.seconds > 0) g.append(s('path', { class: 'ch-bar', d: colPath(x, bw, y, P.t + ih) }));
        gBars.append(g);
        if ((n - 1 - i) % labelEvery === 0) gLabels.append(s('text', { class: 'ch-x', x: cx(i), y: H - 8, 'text-anchor': 'middle' }, shortDay(w.start)));
        if (bw >= 22 && P.t + ih - y > 20) gLabels.append(s('text', { class: 'ch-v in' + (w.partial ? ' partial' : ''), x: cx(i), y: y + 13, 'text-anchor': 'middle' }, short(w.seconds)));
        const hitR = s('rect', { class: 'ch-hit', x: P.l + slot * i, y: P.t, width: slot, height: ih });
        const show = () => {
            const r = svg.getBoundingClientRect();
            const rows = [`Week of ${longDay(w.start)}${w.partial ? ' · so far' : ''}`, ['this week', hm(w.seconds), 'var(--fz-accent)'], ['per day', hDec(w.seconds / Math.max(1, counted(w) || w.daysElapsed))]];
            if (trend[i] != null) rows.push(['4-week average', `${hDec(trend[i])}/day`, 'var(--fz-ink-2)']);
            if (target) rows.push(w.seconds >= target ? `✓ target met (+${hm(w.seconds - target)})` : `${hm(target - w.seconds)} short of ${hm(target)}`);
            showTip(r.left + cx(i), r.top + Math.min(y, P.t + ih - 10), rows);
            g.classList.add('on');
        };
        hitR.addEventListener('pointerenter', show);
        hitR.addEventListener('pointerdown', show);
        hitR.addEventListener('pointerleave', () => { hideTip(); g.classList.remove('on'); });
        gHit.append(hitR);
    });
    svg.append(gBars);
    if (target) { const y = Y(target / 3600); svg.append(s('line', { class: 'ch-target', x1: P.l, x2: W - P.r, y1: y, y2: y })); }

    // trend: straight segments through week midpoints, a dot per week
    let d = '';
    trend.forEach((t, i) => {
        if (t == null) return;
        const x = cx(i), y = Y((t * 7) / 3600);
        d += (d ? 'L' : 'M') + fix(x) + ',' + fix(y);
        gTrend.append(s('circle', { class: 'ch-trend-dot', cx: fix(x), cy: fix(y), r: 2.6 }));
    });
    if (d) gTrend.prepend(s('path', { class: 'ch-trend', d }));
    svg.append(gTrend, gLabels, gHit);
    if (!wk.some((w) => w.seconds > 0)) svg.append(s('text', { class: 'ch-empty', x: P.l + iw / 2, y: P.t + ih / 2, 'text-anchor': 'middle' }, 'Your weeks fill in here as you watch.'));
    svg.setAttribute('aria-label', `Hours per week for the last ${n} weeks, with the 4-week average.`);
    box.replaceChildren(svg);
}

function colPath(x, w, yTop, yBot) {
    const r = Math.min(4, w / 2, yBot - yTop);
    return `M${fix(x)},${fix(yBot)}V${fix(yTop + r)}Q${fix(x)},${fix(yTop)} ${fix(x + r)},${fix(yTop)}H${fix(x + w - r)}Q${fix(x + w)},${fix(yTop)} ${fix(x + w)},${fix(yTop + r)}V${fix(yBot)}Z`;
}

// =====================================================================================
// Channels: who you're listening to
// =====================================================================================
export function renderChannels(box, channels, range, expanded, onToggle, platformNames) {
    const list = (channels || []).map((c) => ({ ...c, v: c[range] || 0 })).filter((c) => c.v > 0).sort((a, b) => b.v - a.v);
    if (!list.length) {
        box.replaceChildren(h('p', { class: 'db-empty' }, range === 'allTime' ? 'Channels you watch will show up here.' : 'Nothing yet in this period.'));
        return;
    }
    const total = list.reduce((a, c) => a + c.v, 0);
    // channel-less time (imported history) goes last and doesn't set the bar scale, so a big
    // import can't flatten every real channel's bar
    const isUnknown = (c) => !c.id && !c.name;
    const known = list.filter((c) => !isUnknown(c));
    const unknown = list.filter(isUnknown);
    const max = (known[0] || list[0]).v;
    const LIMIT = 8;
    const shown = [...(expanded ? known : known.slice(0, LIMIT)), ...unknown];
    const rest = known.slice(LIMIT);
    const multiPlatform = new Set(list.map((c) => c.platform)).size > 1;
    const rows = shown.map((c) => {
        const unk = isUnknown(c);
        const fill = h('span');
        fill.style.width = Math.min(100, Math.max(1, (c.v / max) * 100)).toFixed(2) + '%';
        return h('li', { class: 'db-ch' + (unk ? ' unknown' : '') },
            h('div', { class: 'db-ch-h' },
                h('span', { class: 'db-ch-n', title: unk ? 'Time imported without channel data (e.g. from Mikan)' : c.name },
                    unk ? 'Unknown channel' : c.name,
                    unk ? h('span', { class: 'db-ch-note' }, ' · imported history') : null,
                    multiPlatform ? h('span', { class: 'fz-tag', style: { marginLeft: '6px' } }, (platformNames[c.platform] || c.platform)) : null),
                h('span', { class: 'db-ch-v' }, h('b', null, hm(c.v)), h('span', null, `${Math.round((c.v / total) * 100)}%`))),
            h('div', { class: 'fz-bar' }, fill));
    });
    const more = rest.length
        ? h('li', { class: 'db-ch-more' }, h('button', { type: 'button', class: 'fz-linkbtn', onclick: onToggle },
            expanded ? 'Show top 8' : `+ ${rest.length} more channel${rest.length === 1 ? '' : 's'} · ${hm(rest.reduce((a, c) => a + c.v, 0))}`))
        : null;
    if (unknown.length && rows.length > unknown.length) rows[rows.length - unknown.length].classList.add('sep');
    if (more) rows.splice(rows.length - unknown.length, 0, more);
    box.replaceChildren(h('ul', { class: 'db-chs' }, ...rows));
}

// =====================================================================================
// Rhythm: heatmap from the first tracked week + typical week
// =====================================================================================
export function renderRhythm(box, legendBox, profileBox, st) {
    responsive(box, (W) => drawHeat(box, W, st));
    drawLegend(legendBox, st);
    drawProfile(profileBox, st);
}

function heatThresholds(st, keys) {
    const v = keys.map((k) => (st.days || {})[k] || 0).filter((x) => x > 0).sort((a, b) => a - b);
    if (!v.length) return [1, 2, 3, 4];
    const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
    return [q(0.2), q(0.4), q(0.6), q(0.8)];
}
let heatT = [1, 2, 3, 4];

function drawHeat(box, W, st) {
    const ws = Number(st.settings?.weekStart ?? 0);
    const { first, weeks } = heatRange(st.firstDay, st.todayKey, ws, 12, 53);
    const LEFT = 28, TOP = 16;
    const pitch = Math.max(11, Math.min(20, Math.floor((W - LEFT) / weeks)));
    const cell = pitch - 3;
    const days = st.days || {};
    const keys = [];
    for (let k = first; k <= st.todayKey; k = addDays(k, 1)) keys.push(k);
    heatT = heatThresholds(st, keys);
    const Wd = LEFT + weeks * pitch - 3, Hd = TOP + 7 * pitch - 3;
    const svg = s('svg', { class: 'hm', width: Wd, height: Hd, viewBox: `0 0 ${Wd} ${Hd}`, role: 'img' });
    for (const r of [0, 2, 4, 6]) svg.append(s('text', { class: 'hm-w', x: 0, y: TOP + r * pitch + cell - 2 }, weekdayName((ws + r) % 7)));
    let lastLabel = -9;
    for (let c = 0; c < weeks; c++) {
        const colStart = addDays(first, c * 7);
        for (let r = 0; r < 7; r++) {
            const k = addDays(colStart, r);
            if (k > st.todayKey) break;
            const sec = days[k] || 0;
            if (k.endsWith('-01') && c - lastLabel >= 3) {
                svg.append(s('text', { class: 'hm-m', x: LEFT + c * pitch, y: TOP - 5 }, monthAbbr(k)));
                lastLabel = c;
            }
            const before = !st.firstDay || k < st.firstDay;
            if (before && k !== st.todayKey) {
                // not tracked yet (padding before the first day): a small dot, not an empty day
                const d = Math.max(3, Math.round(cell / 3.5));
                svg.append(s('rect', { class: 'hm-pre', x: LEFT + c * pitch + (cell - d) / 2, y: TOP + r * pitch + (cell - d) / 2, width: d, height: d, rx: d / 2 }));
                continue;
            }
            svg.append(s('rect', {
                class: `hm-c l${level(sec)}${k === st.todayKey ? ' today' : ''}`,
                x: LEFT + c * pitch, y: TOP + r * pitch, width: cell, height: cell, rx: 2, 'data-k': k,
            }));
        }
        if (c === 0 && lastLabel < 0) {   // label the first column too, if the next month label is far enough
            svg.append(s('text', { class: 'hm-m', x: LEFT, y: TOP - 5 }, monthAbbr(colStart)));
            lastLabel = 0;
        }
    }
    svg.addEventListener('pointerover', (e) => {
        const el = e.target.closest && e.target.closest('.hm-c');
        if (!el) return;
        const k = el.getAttribute('data-k'), sec = days[k] || 0;
        const r = el.getBoundingClientRect();
        showTip(r.left + r.width / 2, r.top, [longDay(k) + (k === st.todayKey ? ' · today' : ''), sec ? hm(sec) : 'No immersion']);
    });
    svg.addEventListener('pointerleave', hideTip);
    const wrap = h('div', { class: 'db-heat-scroll' }, svg);
    box.replaceChildren(wrap);
    wrap.scrollLeft = wrap.scrollWidth;
}
function level(sec) {
    if (!sec) return 0;
    let l = 1;
    for (const x of heatT) if (sec > x) l++;
    return Math.min(l, 5);
}
function drawLegend(box, st) {
    const t = heatT;
    const rng = ['No time', `up to ${short(t[0])}`, `${short(t[0])}–${short(t[1])}`, `${short(t[1])}–${short(t[2])}`, `${short(t[2])}–${short(t[3])}`, `over ${short(t[3])}`];
    const pre = st.firstDay ? h('span', { class: 'db-legend-pre' }, h('b', { 'aria-hidden': 'true' }), 'before your first day') : null;
    box.replaceChildren(...[pre, h('span', null, 'Less'), ...[0, 1, 2, 3, 4, 5].map((l) => h('i', { class: 'l' + l, title: rng[l] })), h('span', null, 'More')].filter(Boolean));
}

function drawProfile(box, st) {
    const ws = Number(st.settings?.weekStart ?? 0);
    const prof = weekdayProfile(st.days || {}, st.firstDay, st.todayKey);
    const max = Math.max(...prof, 1);
    const order = Array.from({ length: 7 }, (_, i) => (ws + i) % 7);
    const best = prof.indexOf(Math.max(...prof));
    box.replaceChildren(...order.map((wd) => {
        const bar = h('span', { class: 'db-wd-bar' });
        bar.style.height = prof[wd] ? `${Math.max(6, (prof[wd] / max) * 100)}%` : '2px';
        return h('span', { class: 'db-wd' + (wd === best && prof[wd] ? ' best' : ''), title: `${weekdayName(wd, true)}s: ${hm(prof[wd])} on average` },
            h('span', { class: 'db-wd-plot' }, bar),
            h('span', { class: 'db-wd-v' }, prof[wd] ? (prof[wd] / 3600).toFixed(1) : '0'),
            h('span', { class: 'db-wd-l' }, WD[wd].slice(0, 2)));
    }));
}

// =====================================================================================
// Platforms (only when more than one has time)
// =====================================================================================
export function renderPlatforms(card, table, byPlatform) {
    const rows = Object.entries(byPlatform || {}).filter(([, p]) => p.allTime > 0).sort((a, b) => b[1].allTime - a[1].allTime);
    card.hidden = rows.length < 2;
    if (rows.length < 2) return;
    const total = rows.reduce((a, [, p]) => a + p.allTime, 0) || 1;
    table.replaceChildren(
        h('thead', null, h('tr', null, ...['Platform', 'All time', 'This month', 'This week', 'Today', 'Share'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, ...rows.map(([, p]) => {
            const share = h('span'); share.style.width = ((p.allTime / total) * 100).toFixed(1) + '%';
            return h('tr', null, h('td', null, p.name), h('td', null, hm(p.allTime)), h('td', null, hm(p.month)), h('td', null, hm(p.week)), h('td', null, hm(p.today)),
                h('td', null, h('span', { class: 'db-share' }, share), Math.round((p.allTime / total) * 100) + '%'));
        })),
    );
}
