#!/usr/bin/env bash
# Build per-browser packages from the sources:
#   dist/chrome/   + dist/fazon-active-immersion-tracker-chrome-<version>.zip
#   dist/firefox/  + dist/fazon-active-immersion-tracker-firefox-<version>.zip
#
# The code needs no compiling; the browsers only differ in manifest.json:
#   chrome:  background.service_worker only (no "scripts"), no browser_specific_settings
#   firefox: background.scripts only (an event page; Firefox has no MV3 service workers),
#            browser_specific_settings.gecko kept, no minimum_chrome_version
# Requires: bash, python3, zip.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dist="$root/dist"
cd "$root"

version="$(python3 -c 'import json,sys; print(json.load(open("manifest.json"))["version"])')"
rm -rf "$dist"
mkdir -p "$dist"

# What goes into a package (tests, scripts, dev tools and docs stay out).
include=(src icons LICENSE)

for browser in chrome firefox; do
  out="$dist/$browser"
  mkdir -p "$out"
  for item in "${include[@]}"; do
    [[ -e "$item" ]] && cp -R "$item" "$out/"
  done
  # Editor / OS junk never ships.
  find "$out" \( -name '.DS_Store' -o -name '*~' -o -name '*.swp' \) -delete

  python3 - "$browser" "$root/manifest.json" "$out/manifest.json" <<'PY'
import json, sys
browser, src, dst = sys.argv[1:4]
m = json.load(open(src, encoding="utf-8"))
bg = m.get("background", {})
if browser == "chrome":
    m["background"] = {"service_worker": bg["service_worker"], "type": bg.get("type", "module")}
    m.pop("browser_specific_settings", None)
else:
    m["background"] = {"scripts": bg.get("scripts") or [bg["service_worker"]], "type": bg.get("type", "module")}
    m.pop("minimum_chrome_version", None)
with open(dst, "w", encoding="utf-8") as f:
    json.dump(m, f, ensure_ascii=False, indent=2)
    f.write("\n")
PY

  # Every file the manifest references must exist in the package.
  python3 - "$out" <<'PY'
import json, os, sys
out = sys.argv[1]
m = json.load(open(os.path.join(out, "manifest.json"), encoding="utf-8"))
refs = []
refs += m.get("icons", {}).values()
refs += m.get("action", {}).get("default_icon", {}).values()
refs.append(m.get("action", {}).get("default_popup"))
refs.append(m.get("options_ui", {}).get("page"))
bg = m.get("background", {})
refs += bg.get("scripts", []) + ([bg["service_worker"]] if "service_worker" in bg else [])
for cs in m.get("content_scripts", []):
    refs += cs.get("js", []) + cs.get("css", [])
missing = sorted({r for r in refs if r and not os.path.exists(os.path.join(out, r))})
if missing:
    print(f"warning: {os.path.basename(out)}: missing files referenced by manifest.json:", *missing, sep="\n  ", file=sys.stderr)
PY

  zipfile="$dist/fazon-active-immersion-tracker-$browser-$version.zip"
  (cd "$out" && zip -qrX "$zipfile" .)
  echo "built $out  ->  $(basename "$zipfile")"
done
