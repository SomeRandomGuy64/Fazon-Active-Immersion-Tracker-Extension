#!/usr/bin/env python3
"""Add (or replace) one version in a Firefox self-hosted update manifest (updates.json).

  scripts/update-manifest.py <updates.json> <dist/firefox/manifest.json> <signed.xpi> <update_link>

Used by .github/workflows/release.yml, which publishes the result on the `updates` branch — the
URL that scripts/build.sh puts in the Firefox build's gecko.update_url. Firefox installs the
highest version listed, so older entries are kept (re-signing an old tag never downgrades anyone).
Format: https://extensionworkshop.com/documentation/manage/updating-your-extension/
"""
import hashlib, json, os, sys

updates_path, manifest_path, xpi_path, link = sys.argv[1:5]
m = json.load(open(manifest_path, encoding="utf-8"))
guid = m["browser_specific_settings"]["gecko"]["id"]
version = m["version"]
sha256 = hashlib.sha256(open(xpi_path, "rb").read()).hexdigest()

data = {"addons": {}}
if os.path.exists(updates_path):
    data = json.load(open(updates_path, encoding="utf-8"))
entries = data.setdefault("addons", {}).setdefault(guid, {}).setdefault("updates", [])
entries[:] = [e for e in entries if e.get("version") != version]
entries.append({"version": version, "update_link": link, "update_hash": f"sha256:{sha256}"})
entries.sort(key=lambda e: [int(p) if p.isdigit() else 0 for p in e["version"].split(".")])

with open(updates_path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print(f"{updates_path}: {guid} {version} -> {link}")
