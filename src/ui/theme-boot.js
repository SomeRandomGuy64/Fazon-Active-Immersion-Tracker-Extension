// Classic (blocking) script loaded in <head> before the stylesheets: applies the last-used theme
// (and the dashboard's layout) synchronously so the page never flashes the wrong one. The source of truth is
// chrome.storage.local `theme` (theme.js); this reads its localStorage mirror, which popup and
// dashboard share because they are on the same extension origin. With no saved theme yet, the OS
// light/dark setting decides (theme.js keeps following it until a theme is picked).
(function () {
    var saved = null;
    try { saved = localStorage.getItem('fz-theme'); } catch (e) { /* storage blocked */ }
    var osLight = !!window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches;
    if (saved === 'light' || (saved !== 'dark' && osLight)) document.documentElement.classList.add('light-mode');
    // Dashboard layout ('standard' | 'wide', dashboard.js) — applied here too so the page doesn't jump.
    // Wide is a desktop layout: it only goes on in a landscape window of 1200px or more.
    try {
        if (localStorage.getItem('fz-layout') === 'wide' && matchMedia('(min-width: 1200px) and (min-aspect-ratio: 1001/1000)').matches)
            document.documentElement.classList.add('layout-wide');
    } catch (e) { /* storage blocked: standard layout */ }
})();
