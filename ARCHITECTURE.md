# Fazon Active Immersion Tracker — architecture & contracts

A Chrome + Firefox (Manifest V3) extension that tracks **active immersion time** on Japanese
YouTube videos (Mikan-style), shows it in a popup and a dashboard styled like fazon.nexus, and —
if given a fazon.nexus API key — mirrors the time into the user's Track on fazon.nexus under the
`active` category, in per-day sub-categories named `"<Platform> - <Weekday>"` (e.g. `YouTube - Monday`).

No build step for the code itself: plain ES modules, no bundler, no npm dependencies.

## Layout

```
manifest.json                 # shared base manifest (core)
scripts/build.sh              # → dist/chrome/, dist/firefox/ (+ .zip each) (core)
scripts/update-manifest.py, amo-fetch-signed.mjs  # release helpers (.github/workflows/release.yml)
src/background/               # service worker / event page: tracker, storage, stats, sync (core)
src/content/                  # content scripts, one per platform (core)
src/platforms/                # platform registry + one module per platform (core)
src/shared/                   # pure logic shared by background + UI: time math, formatting (core)
src/ui/                       # shared UI: theme.css, theme.js, fonts/ (ui)
src/popup/popup.{html,js,css}         # toolbar popup (ui)
src/dashboard/dashboard.{html,js,css} # full dashboard + settings (#settings) (ui)
icons/icon-{16,32,48,128}.png         # (ui)
tests/                        # deno tests for pure modules (core)
```

## Platforms (extensibility)

Adding a site (Netflix, Crunchyroll, …) must only need: a new `src/platforms/<id>.js` entry in the
registry, a content script for it, and its match pattern in the manifest. Nothing in tracking,
stats, sync or UI may hard-code YouTube.

A platform descriptor: `{ id: 'youtube', name: 'YouTube', matches: ['*://*.youtube.com/*'] }`.
`name` is what appears in Track sub-category names (`YouTube - Monday`).

Content scripts own detection and report to the background via messages (below). The background
owns all clocks, storage and sync.

## Tracking rules (Mikan-like)

- Count wall-clock time while a video is **actually playing** on a supported page: not paused,
  not ended, not buffering/stalled, not an ad, not muted (volume 0 / muted ⇒ not active listening).
- Only when the content is **Japanese**: auto-detected (title / channel name / description
  contain kana; YouTube metadata language when available) unless overridden. Overrides:
  per video (`Mark as Non-Japanese` / `Mark as Japanese`) and per channel (always / never).
  Video override beats channel override beats auto-detection.
- Never credit more time than wall-clock elapsed: two tabs playing at once count once.
- Time is recorded in whole seconds.

## Days, weeks, months

- **Day reset**: default `03:00` in `UTC`; user-configurable time (`HH:MM`) and timezone
  (`UTC`, the browser's local zone, or an IANA zone). A day's **key** is `YYYY-MM-DD` = the
  calendar date (in that timezone) on which the day window *starts*. So with the default,
  Mon 03:00 UTC → Tue 03:00 UTC is `Monday`.
- Stored history is keyed by day key at the moment time is credited; changing the reset only
  affects time recorded afterwards.
- **This week** starts on a user-selectable weekday (default Sunday, matching fazon.nexus Track weeks). **This month** = day keys
  in the current calendar month.
- **Daily average** = all-time total ÷ number of days from the first day with any time through
  today (inclusive).
- **Monthly average** (the fix over Mikan): never treat a partial month as a full month.
  `monthlyAverage = dailyAverage × 30.436875` (mean Gregorian month length). Starting on the
  30th of June with 4 h therefore counts as 2 days at 2 h/day, not as a 4 h month.

## fazon.nexus Track sync

Contract: `website/Blog/content/developers/_index.md` (Blog repo, read it). Key points:
base `https://api.fazon.nexus`, `Authorization: Bearer fz_…` (Read & write key required),
`PATCH /v1/api/track/weeks/{week}/hours` with `add` entries by sub-category **name**,
`POST /v1/api/track/subcats` to create a missing one (409 = already exists → fine),
Track weeks run Sunday 03:00 UTC → Sunday 03:00 UTC keyed by the Saturday before
(`week_key` in the doc), hours are rounded to hundredths (36 s), 30 writes/min, `Retry-After` on 429.
The API sends no CORS headers: calls are made from the background with a host permission.

- Sub-category: category `active`, name `"<platform.name> - <Weekday of the user's day key>"`.
- Week: the Track week containing the moment the time was credited (server calendar, fixed
  03:00 UTC Sunday — independent of the user's reset setting).
- Ledger: accumulate seconds per (trackWeek, subcatName). Sync sends `add` of the unsynced
  delta floored to whole 36-second hundredths, keeps the remainder, one PATCH per week (≤100
  entries). `add` (not `set`) so several browsers/devices on one account add up.
- Auto-create missing sub-categories, then retry. Handle 401/403 (bad / read-only key → stop and
  surface), 429 (wait Retry-After), network errors (retry with backoff). Sync every ~2 min via
  `chrome.alarms`, plus on "Sync now".
- Settings: `apiKey`, `syncEnabled`, advanced `apiBase` (default `https://api.fazon.nexus`, for
  local fazond testing).
- `https://api.fazon.nexus/*` is an **optional** host permission; the UI requests it (with
  `chrome.permissions.request`, called first thing inside the click handler) when a key is saved.
  On Firefox 140+ the same request also asks for the optional data-collection consent
  (`data_collection: ["browsingActivity", "authenticationInfo"]`, `src/shared/consent.js`), and the
  background makes no API call (sync, Track total, key test) until both are granted.

## Message protocol (UI ⇄ background)

`chrome.runtime.sendMessage({type, ...})` → response object. All times in **seconds**.
Every response has `ok: true` or `ok: false, error: string`.

| type | request | response |
|---|---|---|
| `getStatus` | `{tabId}` | `{platform: {id,name}\|null, hasSitePermission, media: null \| {videoId, title, channel, channelId, url, playing, japanese, detected: bool, override: {video: 'ja'\|'non-ja'\|null, channel: 'ja'\|'non-ja'\|null}}, tracking: bool}` |
| `setOverride` | `{scope: 'video'\|'channel', platform, id, label, value: 'ja'\|'non-ja'\|null}` | `{}` (`null` removes) |
| `getOverrides` | `{}` | `{overrides: [{scope, platform, id, label, value, at}]}` |
| `getStats` | `{}` | see below |
| `getSettings` | `{}` | `{settings}` |
| `setSettings` | `{patch}` | `{settings}` |
| `testApiKey` | `{apiKey, apiBase?}` | `{valid: bool, canWrite: bool\|null, message}` |
| `syncNow` | `{}` | `{sync}` |
| `exportData` | `{}` | `{data}` (JSON-serialisable, versioned) |
| `importData` | `{data, mode: 'merge'\|'replace'}` | `{}` |
| `resetData` | `{}` | `{}` |

`getStats` response:

```js
{
  now, todayKey,                    // epoch ms, 'YYYY-MM-DD'
  today, week, month, allTime,      // seconds
  dailyAverage, monthlyAverage,     // seconds
  firstDay,                         // 'YYYY-MM-DD' | null
  days: { 'YYYY-MM-DD': seconds },  // every day with time (all platforms)
  byPlatform: { youtube: { name: 'YouTube', today, week, month, allTime } },
  last7: [{ key, label, seconds }], // oldest → today; label 'Mon'… / 'Today'
  months: [{ key: 'YYYY-MM', label: 'Jul 2026', seconds }], // first month with data → current
  settings,
  sync,
}
```

`settings`: `{ resetTime: '03:00', timezone: 'UTC' | 'local' | IANA, weekStart: 0 /*0=Sun..6*/,
apiKey: '' , syncEnabled: false, apiBase: 'https://api.fazon.nexus' }`.

`sync`: `{ state: 'off'|'ok'|'pending'|'error'|'auth-error', lastSyncAt, lastError, pendingSeconds,
subcats: ['YouTube - Monday', …] }`.

Background → UI broadcast (optional, UI may also poll every 1 s while open):
`{type: 'statsChanged'}`.

Content → background (internal to core): `{type: 'mediaState', platform, media}` on change and a
heartbeat every ~5 s while playing.

## Theme

Matches fazon.nexus (`website/Blog/static/css/style.css`): JetBrains Mono, dark default, light
variant with its own accent, a sun/moon toggle. The choice is stored in `chrome.storage.local`
key `theme` (`'dark'|'light'`) and shared by popup and dashboard; `src/ui/theme.js` applies it.

## Core notes (implementation)

What the core actually does, and where it adds to or differs from the contract above. The message
protocol and response shapes are as documented; everything below is additive.

**Files.** `src/background/main.js` (entry + message router), `store.js` (chrome.storage.local,
schema 1, serialised read-modify-write), `tracker.js` (crediting, per-tab state, toolbar icon),
`sync.js` (Track sync), `settings.js`, `datafmt.js` (export/import). `src/shared/`: `time.js`
(day keys, weeks, Track weeks, DST-safe zone math), `stats.js` (`getStats` payload, averages),
`credit.js` (no-double-count), `ledger.js` (sync ledger), `format.js`. `src/platforms/`
(`index.js` registry, `youtube.js`). `src/content/`: `common.js` (shared runtime), `youtube.js`
(adapter), `youtube-main.js` (MAIN-world reader). `scripts/build.sh`, `tests/` (`deno test tests/`).

**For the UI.** Import formatting from `src/shared/format.js`: `formatHMS` (`H:MM:SS`),
`formatHM` (`1h 05m`), `formatShort` (`1.5h`/`45m`), `toHours`, `formatAgo`. Calendar helpers
(`WEEKDAYS`, `monthLabel`, `weekStartKey`, …) are in `src/shared/time.js`. All are pure.

**Additions to the protocol (all optional for the UI):**
- `settings.countMuted` (default `false`): count time while the video is muted / volume 0.
- `getStats` also returns `weekStartKey`, `daysTracked` (days in the daily-average span) and
  `nextResetAt` (epoch ms of the next day reset). Today/week/month/all-time include a few
  "live" seconds of a session that is playing right now but not yet credited (so counters tick
  every second while the UI polls; the next heartbeat makes them exact).
- `sync.nextAttemptAt` (epoch ms or null). `sync.state`: `off` (sync disabled or no key),
  `pending` (enabled, not yet run, or waiting out a 429), `ok`, `error` (network/5xx/400 or
  missing host permission; retried with backoff 30 s → 30 min), `auth-error` (401/403; alarm runs
  pause until the key/base changes or "Sync now").
- `getStatus.media` also has `checking` (detection still running), `reason` (why it was judged
  Japanese or not, e.g. `Japanese captions`), `muted`, `ad`, `paused`, `buffering`,
  `countMuted`, `platform`. `media.playing` = playing and not paused/ended/buffering/ad (muted
  is reported separately). `hasSitePermission`: for the tab's platform, or — when the tab isn't
  a platform page — whether **all** platforms' host permissions are granted.
- `importData` answers `{imported: {format: 'native'|'mikan', days, seconds}}`.
- UI messages are only accepted from extension pages (sender URL under the extension origin),
  never from content scripts.

**Detection (YouTube), Mikan-compatible.** `youtube-main.js` runs in the MAIN world (manifest
`"world": "MAIN"`, read-only: `ytInitialPlayerResponse`, `movie_player.getPlayerResponse()` /
`getVideoData()`) and posts `{videoId, title, author, channelId, captionLanguages}` to the
isolated adapter. Rules (`FaitContent.detectJapanese`): a `ja` caption track (manual or
auto-generated) → Japanese; else title has kana and (kana+kanji)/length > 0.3; else channel name
has kana and that ratio > 0.1; else not Japanese. Without player data after 3 s it falls back to
the DOM title/channel. Channel overrides are keyed by the `UC…` channel id when known; the
`@handle` from the page is kept as an alias and also matched.

**Counting.** The content script ticks every second (plus media events). Wall time between two
ticks is credited when the video was playing at the earlier one; a gap over 2.5 s (throttled
timers, sleep) is credited only as far as `currentTime` advanced. Intervals carry `muted`; the
background drops muted ones unless `countMuted`. Reports go out every ~5 s and on any state
change; intervals of a video still being classified are held up to 30 s. The background claims
intervals against a set of already-credited spans (kept 6 h), so overlapping tabs and re-sent
heartbeats count once; reports older than 6 h are ignored. Credited time is split exactly at
day resets and Track week boundaries, and persisted before the content script is acknowledged.

**Toolbar icon.** Per tab via `chrome.action.setIcon`: `icons/icon-active-{16,32}.png` while
counting, `icons/icon-inactive-{16,32}.png` when there is media that isn't counted
(non-Japanese, paused, muted, ad), `icons/icon-{16,32}.png` otherwise. If the icon files can't
be loaded it falls back to a badge dot.

**Sync details.**
- The ledger only fills while `syncEnabled` and an API key are set: turning sync on uploads time
  tracked from then on, never older history. Imported data (Mikan or backups) is never synced.
- Each run: one GET `/subcats` when a needed name isn't in the cached list, POST for missing ones
  (409 "already" is fine; 409 "too many" → error), then one PATCH per week (`add` as a decimal
  string, e.g. `"0.07"`). A 400 "no sub-category named" (renamed/archived on the site) refreshes
  the list, re-creates, and retries once. The ledger is written after each accepted PATCH.
- Remainders under 36 s carry over; once a week has ended (+15 min grace) its last remainder is
  rounded to the nearest hundredth and the week is dropped from the ledger, so nothing is lost
  systematically.
- `testApiKey`: GET `/subcats` checks validity; write access is probed with
  `PATCH /weeks/<current>/hours {"entries":[]}` — the server checks the key's scope before the
  body, so read-only → 403 (`canWrite: false`), read & write → 400 "send 1-100 entries"
  (`canWrite: true`); nothing is written either way (one write of the 30/min budget).
- `setSettings` that changes `apiKey`/`apiBase`/`syncEnabled` resets the sync error state and
  starts a sync. `apiBase` is normalised (no trailing slash; https, or http only for
  localhost/127.0.0.1). The host permission to request is `<protocol>//<hostname>/*` (ports are
  ignored); only `https://api.fazon.nexus/*`, `http://localhost/*` and `http://127.0.0.1/*` are
  declared as optional host permissions, so other API hosts can't be granted.
- Known limit: `add` has no idempotency key, so if a PATCH is applied but its response is lost
  (network drop), the next run sends that delta again.

**Import / export.** `exportData` → `{format: 'fazon-active-immersion-tracker', version: 1,
exportedAt, settings (without apiKey), days, overrides: [...], imports}`. `importData` also
accepts Mikan's `watchData` (`{watchData: {...}}` or the bare object): each date's
`totalSeconds` is added to that day key on `youtube`; the seconds imported per date are recorded
(`imports.mikan`), so re-importing the same or a newer Mikan export only adds the increase.
Native merge keeps the larger value per day and platform (idempotent); newer overrides win.
`replace` clears days/overrides/import records first (and for native files applies the day/week
settings, keeping the sync connection). `resetData` clears days, overrides, imports, the ledger
and sync state, keeps settings, and stops old reports from being credited again.

**Manifest / browsers.** Shared `manifest.json` has both `background.service_worker` and
`background.scripts`; `scripts/build.sh` writes per-browser manifests (Chrome: worker only, no
`browser_specific_settings`; Firefox: event-page `scripts` only, no `minimum_chrome_version`)
into `dist/chrome`, `dist/firefox` + zips (`dist/` is git-ignored). Minimums: Chrome 111, Firefox
128 (MAIN-world content scripts, `optional_host_permissions`). Content scripts match
`www.youtube.com`, `m.youtube.com` and `www.youtube-nocookie.com` (embeds on other sites, via
`all_frames`), not `music.youtube.com`. Firefox `data_collection_permissions`:
`required: ["none"]`, `optional: ["browsingActivity", "authenticationInfo"]` — nothing leaves the
browser by default; opt-in sync sends hours per "<Platform> - <Weekday>" (time on YouTube =
browsing activity) with the user's API key (authentication information) to api.fazon.nexus.
Firefox 140+ shows the optional categories in the permission prompt when sync is set up; Chrome and
Firefox 128–139 have no built-in consent (`permissions.getAll()` has no `data_collection` key, which
is how it's detected), so there the explicit key + "Sync" opt-in is the consent. The cookieless
YouTube oEmbed lookups (video ID → channel) go only to the site the video was watched on and are
not declared. The Firefox build also gets `gecko.update_url` (the `updates` branch's
`updates.json`, written by `.github/workflows/release.yml`) so signed installs auto-update. No
`tabs` permission is needed (tab URLs of YouTube pages are visible through the host permission).

**Adding a platform.** `src/platforms/<id>.js` (+ entry in `index.js`), a content adapter
`src/content/<id>.js` that calls `FaitContent.start({platform, getMedia, subscribe})` (see the
interface at the top of `common.js`), and a manifest `content_scripts` entry
(`common.js` + adapter) with its matches in `host_permissions`.

**Day-key edge.** Day keys follow the wall clock, so a reset time inside a DST-repeated hour
(e.g. 01:30 on a fall-back night) briefly maps the repeated half hour back to the previous day.
A reset inside a skipped hour starts the day at the jump.

## UI v2 data needs (proposed by the UI; mocked in `dev/mock-chrome.js`)

The redesigned popup/dashboard read these extra fields. Everything else they show (cumulative
series, milestones, 30-day pace and projection, rolling 7-day average, streaks, week buckets per
`weekStart`, weekday profile, heatmap range) is derived UI-side from `getStats.days` by the pure
functions in `src/ui/series.js` (no DOM/chrome; can move to `src/shared/` unchanged if core wants
them). All times in seconds.

**`getStats` additions**

```js
channels: [               // every channel with any time, unsorted — the UI sorts/truncates
  { platform: 'youtube', id: 'UC…', name: '樋口楓【にじさんじ所属】', today, week, month, allTime },
  { platform: 'youtube', id: null, name: null, today, week, month, allTime },  // time without channel
],                        //   data (Mikan import, …): one row per platform, shown as "Unknown channel"
target: {                 // the daily/weekly target in effect
  daily: seconds | null,
  weekly: seconds | null, // = daily × 7 for a manual target; the Track goal itself for 'track'
  source: 'track' | 'manual' | null,
},
```

- `week`/`month`/`today` per channel use the same windows as the top-level `week`/`month`/`today`.
- The per-channel ledger needs `channelId` + `channel` (display name) recorded with each credited
  second (latest name wins for an id). Imported days have no channel → the `id: null` row.
- `target` precedence: `'track'` when sync is on and the user's current Track week has an
  **Active immersion** weekly goal (`weekly` = that goal, `daily` = goal ÷ 7); else `'manual'`
  from `settings.dailyTargetMinutes` (`daily` = minutes × 60, `weekly` = daily × 7); else all null.
  Core can cache the Track goal from the sync round-trip (GET of the current week).

**`getStatus` additions (`media`)**

```js
sessionSeconds: number,   // seconds credited for this video (videoId) today — the popup's live counter
reason: string | null,    // already sent; short human text, e.g. 'Japanese captions',
                          //   'Kana in the title', 'No Japanese in the title, channel or captions'
```

The popup also uses the extras core already sends: `checking`, `muted`, `ad`, `buffering`,
`paused`, `countMuted` (state line: Counting / Paused / Muted · not counted / Ad · paused /
Buffering / Checking language… / Not Japanese).

**`settings` addition**

```js
dailyTargetMinutes: number | null   // default null; Settings → "Daily target" (hours, step 0.25)
```

## Core v2 notes (implementation of "UI v2 data needs")

All fields in "UI v2 data needs" are implemented with the shapes given there; additions below.

- **Storage schema 2** (migration from 1 is automatic and lossless): per-video seconds per day in
  `vd:YYYY-MM` keys (one key per month, so a heartbeat rewrites one month), plus `videos`
  (video → channel alias), `channels` (`{platform, id, name, at}`), `aliases` (alias → channel),
  `resolve` (queue + counters) and `trackGoal`. Time recorded before v2 has no video data and
  shows as the `{id: null, name: null}` row. Logic is in `src/shared/channels.js` (pure).
- **Channels.** Live tracking records each credited second against its video and the video's
  channel (UC id + `@handle` + display name from the page). Aliases merge: a channel first
  seen by handle (oEmbed) and later by UC id + handle becomes one row keyed by the UC id;
  handles compare case-insensitively; the newest display name wins. `channels[].id` is the UC
  id when known, else the `@handle` (for oEmbed-only channels). Channel rows add up exactly to
  the top-level totals; the unknown row is whatever isn't attributed.
- **`getStats.resolve`** = `{pending, done, failed}`: video → channel lookups still queued,
  resolved, and given up (deleted/private/not embeddable → their time stays "Unknown channel").
  The UI may show "Finding channels… (pending)" while `pending > 0`; `statsChanged` is broadcast
  after every resolved batch.
- **Resolution** (`src/background/resolver.js`): YouTube oEmbed
  (`https://www.youtube.com/oembed?format=json&url=…watch?v=ID` → `author_name`, `author_url`
  with the `@handle`), implemented as `resolveChannel()` on the platform descriptor (a platform
  without it just leaves time unattributed). 4 requests at a time, 250 ms between batches, ≤ 25 s
  per run, progress persisted after each batch; a 1-minute alarm (`fait-resolve`) exists while
  the queue is non-empty, so it resumes after worker restarts. 400/401/403/404/410 → failed;
  network/5xx/429 → retried (Retry-After honoured, back of the queue, up to 5 attempts). Both
  imported videos and live-tracked videos the page gave no channel for are queued. oEmbed is
  covered by the `https://www.youtube.com/*` host permission in both builds, and it also answers
  CORS (`Access-Control-Allow-Origin` echoes the extension origin), so it works even if a
  Firefox user hasn't granted YouTube access yet.
- **Mikan import** now keeps `videos: {id: seconds}` per day as per-video time (queued for
  resolution) and records per-date and per-video imported seconds (`imports.mikan[date] =
  {total, videos}`; old numeric records are still understood), so re-importing adds only
  increases. Fractional Mikan seconds are rounded. `importData` → `imported.queued` = videos
  newly queued. Imported time never enters the Track sync ledger.
- **`getStats.target`**: `track` when sync is enabled with a key, the key isn't rejected (401),
  and the cached goal for the current Track week (read with the same key/base) has an `active`
  goal; `weekly` = goal × 3600, `daily` = round(weekly ÷ 7). The goal is read with
  `GET /v1/api/track/weeks/{current}` during sync runs: once a goal is seen it is never re-read
  that week (write-once); without one it is re-read at most every 10 min (and on "Sync now").
  Else `manual` from `settings.dailyTargetMinutes` (0 < n ≤ 1440, `null`/`0`/`''` clears;
  `daily` = n × 60, `weekly` = daily × 7). Else all null.
- **`getStatus.media.sessionSeconds`** = seconds credited today for that video + the live,
  not-yet-credited seconds.
- **Export format 2** adds `videoDays`, `videos` (channel pointers), `channels`, `aliases`;
  native imports merge them (max per day/video; channels merged by alias). Format-1 files still
  import. `resetData` also clears the per-video and channel data.
- `sync.js` now records `syncState.authStatus` (401/403/null).

## Core v3 notes (fazon.nexus Track total)

**`getStats.track`** = `{state, activeAllTime, pendingSeconds, fetchedAt, error, weeks}`:
- `state`: `off` (no API key), `loading` (no value read yet for this key/base), `ok`, `error`
  (`error` is a short reason; a cached value from the same key is kept on network/5xx/429
  errors and dropped on 401; a missing host permission for `apiBase` is an error too).
- `activeAllTime`: the sum of `totals.active` over all Track weeks, seconds (exact hundredths ×
  36), **excluding** `pendingSeconds` = this tracker's not-yet-synced seconds (sync on only; 0
  otherwise). Show `activeAllTime + pendingSeconds` so the figure moves live.
- `weeks`: `[{week, start, active}]` (Saturday key, start as epoch ms, active seconds), oldest →
  newest, from the first week with active hours to the current week (zero weeks included);
  they sum to `activeAllTime`. `[]` unless a value is available.
- Reading needs only read access and a key — sync doesn't have to be enabled. Read with
  `GET /v1/api/track/weeks?from&to`, paging back from the current week in 260-week chunks and
  stopping after a chunk without logged weeks (or at 2000-01-01). Refreshed when the key/base
  changes, on every sync run (alarm every 2 min; with sync off the alarm still refreshes it) but
  at most every ~10 min unless forced, on "Sync now", and right after a sync that sent hours.
  `getStats` never waits for it: a stale cache only kicks a background read; a `statsChanged`
  broadcast follows when it lands. Sync runs and total reads never overlap, and an accepted
  PATCH adds its hours to the cached total/weeks at once, so `activeAllTime + pendingSeconds`
  doesn't jump when time moves from pending into Track.

**Dashboard (UI, done in this round).** With a Track value (state `ok`, or `error` with a cached
value) the hero shows two figures: "Active immersion · fazon.nexus Track" (`activeAllTime +
pendingSeconds`, "incl. Xm not yet synced", "updated N min ago") and "Recorded by this
tracker" (`allTime`). The hero chart, milestone dots/lines, next-milestone block and projection
then use Track: weekly totals spread evenly over each week's days (the current week over its
elapsed days, pending seconds on today; milestone crossings are thus interpolated within the
week), pace = active hours of the last 4 complete Track weeks ÷ 28 (fewer complete weeks →
those; none → the current week so far). A caption says so. Everything else (strip, averages,
streaks, week by week, channels, rhythm) stays on the tracker's own data. Off/loading/error
without a value → the v2 hero (tracker data); error adds a muted "Couldn't read your Track
total — reason · Settings" line, loading a "Reading your fazon.nexus Track total…" line.
Helpers: `trackDays`, `trackPace` in `src/ui/series.js`. Mock: `?track=ok|loading|error|stale|off`
(`stale` = error with a cached value).
