# Fazon Active Immersion Tracker

A Chrome + Firefox extension that tracks your **active immersion time** on Japanese YouTube videos
(Mikan-style), with a dashboard styled like [fazon.nexus](https://fazon.nexus) and optional sync into
your fazon.nexus **Track** (Active immersion → `YouTube - Monday`, `YouTube - Tuesday`, …).

- Counts wall-clock time while a Japanese video is actually playing (not paused, buffering, an ad,
  or muted unless you allow it). Japanese = a Japanese caption track, else kana-heavy title/channel
  (Mikan's rules). Override per video or per channel from the popup.
- Day resets at **03:00 UTC** by default; change the time and time zone in Settings.
- Monthly average = daily average × 30.44, so a partial first month isn't counted as a full one.
- Import your history from Mikan 見間 (Settings → Data). Imported history stays local.
- Sync: paste a **Read & write** API key from your fazon.nexus profile (see
  [fazon.nexus/developers](https://fazon.nexus/developers/)). Missing sub-categories are created for
  you; several browsers on one account add up. Only time tracked while sync is on is sent.

Inspired by [Mikan 見間](https://chromewebstore.google.com/detail/kmjcmgkhjajkhgphmjgocgfdgnooojfc)
by Jouzu Juls, whose Japanese-detection rules this extension follows and whose history it can import.

## Install (unpacked)

Download the Chrome or Firefox zip from
[Releases](https://github.com/SomeRandomGuy64/Fazon-Active-Immersion-Tracker-Extension/releases) and unzip
it, or build both yourself:

```sh
scripts/build.sh            # → dist/chrome, dist/firefox (+ zips)
```

- **Chrome / Chromium:** `chrome://extensions` → Developer mode → *Load unpacked* → the unzipped
  folder (or `dist/chrome`).
- **Firefox (128+):** `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* →
  the Firefox zip (or `dist/firefox/manifest.json`) (temporary until restart; a signed build is needed for permanent
  installs). Firefox may ask you to allow access to youtube.com from the popup.

## Adding a platform

Add `src/platforms/<id>.js` to the registry in `src/platforms/index.js`, a content-script adapter in
`src/content/` (see `youtube.js`, built on `common.js`), and its match patterns in `manifest.json`.
Tracking, stats, sync (`<Name> - <Weekday>` sub-categories) and the UI pick it up automatically.

## Development

- Tests: `deno test tests/`
- UI preview with mock data: `python3 -m http.server 8791 --bind 127.0.0.1`, then open
  `http://127.0.0.1:8791/dev/preview-dashboard.html` or `/dev/preview-popup.html?state=tracking`.
- Design and contracts: [ARCHITECTURE.md](ARCHITECTURE.md).
