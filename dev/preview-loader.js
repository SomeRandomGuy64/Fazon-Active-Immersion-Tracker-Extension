// DEV ONLY. Loads a real extension page (data-page on <html>) into this document with the fake
// `chrome` (mock-chrome.js) installed first, so popup/dashboard can be previewed from
// `python3 -m http.server` run from the repo root or any folder above it. ?theme=light|dark presets the theme.
(async function () {
    const page = document.documentElement.dataset.page;
    const q = new URLSearchParams(location.search);
    const theme = q.get('theme');
    if (theme) {
        try {
            localStorage.setItem('fz-theme', theme);
            const st = JSON.parse(localStorage.getItem('mock-storage') || '{}');
            st.theme = theme;
            localStorage.setItem('mock-storage', JSON.stringify(st));
        } catch (e) { /* ignore */ }
    }
    if (q.get('chrange')) { try { localStorage.setItem('fz-ch-range', q.get('chrange')); } catch (e) { /* ignore */ } }
    // Resolve against the repo root (this file's parent folder), not the server root.
    const root = new URL('../', document.currentScript ? document.currentScript.src : location.href).pathname;
    const html = await (await fetch(root + page, { cache: 'no-store' })).text();
    const base = root + page.replace(/[^/]+$/, '');
    const inject = '<base href="' + base + '"><script src="' + root + 'dev/mock-chrome.js"><\/script>';
    const out = html.replace(/<head>/i, '<head>' + inject);
    document.open();
    document.write(out);
    document.close();
})();
