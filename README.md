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

## Install

Downloads are on [Releases](https://github.com/SomeRandomGuy64/Fazon-Active-Immersion-Tracker-Extension/releases).

- **Firefox (128+):** download `fazon-active-immersion-tracker-firefox-<version>.xpi` (signed by
  Mozilla) and drag it onto a Firefox window, or open it with *File → Open File* / from
  `about:addons` → ⚙ → *Install Add-on From File…*. It installs permanently and updates itself
  when a new release is out. Firefox may ask you to allow access to youtube.com from the popup.
- **Chrome / Chromium:** unzip `fazon-active-immersion-tracker-chrome-<version>.zip`, then
  `chrome://extensions` → Developer mode → *Load unpacked* → the unzipped folder.

Or build both yourself:

```sh
scripts/build.sh            # → dist/chrome, dist/firefox (+ zips)
```

`dist/chrome` loads unpacked as above. An unsigned Firefox build only loads temporarily
(`about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → `dist/firefox/manifest.json`,
gone after a restart).

**Data:** nothing leaves your browser unless you turn on sync. Sync sends your tracked hours per
day (`YouTube - Monday` …) with your API key to fazon.nexus — plus, if you tick *List watched
videos in the week's summary*, a link to each video you watched (title and channel) in that
Track week's summary, which is public unless you made the week's summary private; Firefox 140+ asks for this
("browsing activity", "authentication information") when you save the key. To find channel names,
the extension looks up video IDs on YouTube's public oEmbed endpoint (no cookies).

## Adding a platform

Add `src/platforms/<id>.js` to the registry in `src/platforms/index.js`, a content-script adapter in
`src/content/` (see `youtube.js`, built on `common.js`), and its match patterns in `manifest.json`.
Tracking, stats, sync (`<Name> - <Weekday>` sub-categories) and the UI pick it up automatically.

## Releasing

1. Bump `"version"` in `manifest.json` (Mozilla never signs the same version twice) and commit.
2. Tag and push the tag:

   ```sh
   git tag v0.1.1 && git push origin main v0.1.1
   ```

[`.github/workflows/release.yml`](.github/workflows/release.yml) checks the tag matches the
manifest, builds, lints, signs the Firefox build on addons.mozilla.org (unlisted, i.e.
self-distributed), uploads the Chrome zip, the Firefox zip and the signed `.xpi` to the release,
and adds the version to `updates.json` on the `updates` branch (where installed copies look for
updates — don't delete that branch). To re-run it for an existing tag: *Actions → Release → Run
workflow* with the tag. It needs the repository secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`
(an API key from <https://addons.mozilla.org/developers/addon/api/key/>).

## Development

- Tests: `deno test tests/`
- Lint the Firefox build like AMO does for unlisted add-ons: `npx web-ext lint --source-dir
  dist/firefox --self-hosted` (without node: `deno run -A npm:web-ext lint …`).
- UI preview with mock data: `python3 -m http.server 8791 --bind 127.0.0.1`, then open
  `http://127.0.0.1:8791/dev/preview-dashboard.html` or `/dev/preview-popup.html?state=tracking`.
- Design and contracts: [ARCHITECTURE.md](ARCHITECTURE.md).
