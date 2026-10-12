#!/usr/bin/env node
// Download the AMO-signed .xpi of a version that was already submitted (used by
// .github/workflows/release.yml when `web-ext sign` refuses with "Version X already exists").
//
//   WEB_EXT_API_KEY=<JWT issuer> WEB_EXT_API_SECRET=<JWT secret> \
//     node scripts/amo-fetch-signed.mjs <dist/firefox/manifest.json> <out.xpi>
//
// AMO API v5: GET /addons/addon/<guid>/versions/v<version>/ (owner-authenticated JWT), then
// file.url once file.status is "public" (= signed). Requires Node 18+ (global fetch).
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [manifestPath, outPath] = process.argv.slice(2);
const { WEB_EXT_API_KEY: iss, WEB_EXT_API_SECRET: secret, AMO_BASE_URL = 'https://addons.mozilla.org/api/v5/' } = process.env;
if (!manifestPath || !outPath) { console.error('usage: amo-fetch-signed.mjs <manifest.json> <out.xpi>'); process.exit(2); }
if (!iss || !secret) { console.error('WEB_EXT_API_KEY / WEB_EXT_API_SECRET are not set'); process.exit(2); }

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const guid = manifest.browser_specific_settings?.gecko?.id;
const version = manifest.version;
if (!guid) { console.error('manifest has no browser_specific_settings.gecko.id'); process.exit(2); }

// AMO JWT: HS256, iss = key, unique jti, exp at most 5 minutes after iat.
function jwt() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss, jti: randomUUID(), iat: now, exp: now + 60 })}`;
  return `JWT ${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}

const detailUrl = new URL(`addons/addon/${encodeURIComponent(guid)}/versions/v${encodeURIComponent(version)}/`, AMO_BASE_URL);
const res = await fetch(detailUrl, { headers: { Authorization: jwt(), Accept: 'application/json' } });
const detail = await res.json().catch(() => null);
if (!res.ok) {
  console.error(`AMO version lookup failed (${res.status}): ${JSON.stringify(detail)}`);
  process.exit(1);
}
const file = detail.file || {};
if (file.status !== 'public' || !file.url) {
  console.error(`Version ${version} exists on AMO but isn't signed yet (file status: ${file.status || 'none'}). Re-run the workflow once it is approved.`);
  process.exit(1);
}
const dl = await fetch(file.url, { headers: { Authorization: jwt() } });
if (!dl.ok) {
  console.error(`Download of ${file.url} failed (${dl.status})`);
  process.exit(1);
}
writeFileSync(outPath, Buffer.from(await dl.arrayBuffer()));
console.log(`Downloaded the signed ${guid} ${version} → ${outPath}`);
