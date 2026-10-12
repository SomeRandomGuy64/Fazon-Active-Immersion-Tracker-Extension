// Theme: 'dark' (default) | 'light', stored in chrome.storage.local `theme` and shared by the
// popup and dashboard. theme-boot.js has already applied the cached value before first paint;
// this reconciles it with storage, wires the toggle(s) and follows changes made in other pages.

const KEY = 'theme';
const MIRROR = 'fz-theme';
let current = document.documentElement.classList.contains('light-mode') ? 'light' : 'dark';
const toggles = new Set();
let fadeTimer;

function apply(theme, animate) {
    theme = theme === 'light' ? 'light' : 'dark';
    const root = document.documentElement;
    if (animate && theme !== current) {
        root.classList.add('theme-fading');
        clearTimeout(fadeTimer);
        fadeTimer = setTimeout(() => root.classList.remove('theme-fading'), 200);
    }
    current = theme;
    root.classList.toggle('light-mode', theme === 'light');
    try { localStorage.setItem(MIRROR, theme); } catch { /* ignore */ }
    for (const btn of toggles) syncButton(btn);
    document.dispatchEvent(new CustomEvent('fz-theme', { detail: { theme } }));
}

function syncButton(btn) {
    const light = current === 'light';
    btn.setAttribute('aria-checked', String(light));
    btn.title = light ? 'Switch to dark mode' : 'Switch to light mode';
}

export function getTheme() { return current; }

export async function setTheme(theme) {
    apply(theme, true);
    try { await chrome.storage.local.set({ [KEY]: current }); } catch { /* ignore */ }
}

/** Wire every `.toggle-button[data-theme-toggle]` on the page and start following storage. */
export async function initTheme() {
    document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
        toggles.add(btn);
        syncButton(btn);
        btn.addEventListener('click', () => setTheme(current === 'light' ? 'dark' : 'light'));
    });
    try {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes[KEY]) apply(changes[KEY].newValue, true);
        });
        const got = await chrome.storage.local.get(KEY);
        apply(got[KEY] || 'dark', false);
    } catch { /* outside an extension page: keep the cached theme */ }
}
