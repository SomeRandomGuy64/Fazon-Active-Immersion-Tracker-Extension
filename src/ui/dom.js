// Tiny DOM builder: h('div', {class: 'x', onclick: fn}, 'text', child, [more]) — text is always
// set as text (never parsed as HTML), so titles/labels from pages can't inject markup.
export function h(tag, attrs, ...children) {
    const el = tag === 'svg' || attrs?.__svg
        ? document.createElementNS('http://www.w3.org/2000/svg', tag)
        : document.createElement(tag);
    if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
            if (v == null || v === false || k === '__svg') continue;
            if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
            else if (k === 'class') el.setAttribute('class', v);
            else if (k === 'dataset') Object.assign(el.dataset, v);
            else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
            else if (k in el && typeof v !== 'string' && !(el instanceof SVGElement)) el[k] = v;
            else el.setAttribute(k, v === true ? '' : String(v));
        }
    }
    append(el, children);
    return el;
}

function append(el, children) {
    for (const c of children) {
        if (c == null || c === false) continue;
        if (Array.isArray(c)) append(el, c);
        else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
}

export const SVGNS = 'http://www.w3.org/2000/svg';
export function s(tag, attrs, ...children) {
    const el = document.createElementNS(SVGNS, tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
    append(el, children);
    return el;
}

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

export function setText(el, text) { if (el && el.textContent !== text) el.textContent = text; }
