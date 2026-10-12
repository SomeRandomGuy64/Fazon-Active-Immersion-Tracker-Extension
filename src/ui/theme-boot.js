// Classic (blocking) script loaded in <head> before the stylesheets: applies the last-used theme
// synchronously so the page never flashes the wrong one. The source of truth is
// chrome.storage.local `theme` (theme.js); this reads its localStorage mirror, which popup and
// dashboard share because they are on the same extension origin.
(function () {
    try {
        if (localStorage.getItem('fz-theme') === 'light') document.documentElement.classList.add('light-mode');
    } catch (e) { /* storage blocked: stay on the dark default */ }
})();
