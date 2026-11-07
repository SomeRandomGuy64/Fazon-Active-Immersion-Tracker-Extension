# HCI checks

The extension's port of fazon.nexus's `hci-tests/` (Blog repo): the same probe, checks and literature, run against the dev previews instead of the Hugo site.

```
deno run -A hci-tests/run.ts                 # full sweep
deno run -A hci-tests/run.ts --quick         # desktop + mobile + popup only
deno run -A hci-tests/run.ts --pages settings
```

The report goes to `hci-tests/out/report.md` (raw findings in `report.json`). The exit code is 1 when anything fails.

- Pages: the dashboard (overview, `#settings`, and the empty first-run state) and the popup (counting and idle), each through `dev/preview-*.html` with the mock `chrome`. The repo root is served on a free localhost port.
- Dashboard profiles: Standard 1366×768 in dark and light, reduced motion, mobile 375×812, reflow 320×640, and Wide at 1920×1080, 2560×1440, 2560×1080 and 3440×1440. The popup gets 360×600 in dark and light.
- Each tab gets its own in-memory `localStorage`, which also holds the mock's `chrome.storage`, so parallel passes can't change each other's theme or layout.

`probe.js`, `checks.ts` and `LITERATURE.md` are copies of the site's. When one changes there, copy it here. The probe also reads `.db-nav` and the theme class on `<html>`.
