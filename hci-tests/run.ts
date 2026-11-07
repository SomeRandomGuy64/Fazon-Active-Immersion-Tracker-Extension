// HCI / usability checks for the extension's pages, each tied to the literature in LITERATURE.md.
// A port of fazon.nexus's hci-tests (Blog repo): same probe, same checks, same citations. The pages
// are the dev previews (dev/preview-*.html, real page + mock chrome), served from the repo root.
//
//   deno run -A hci-tests/run.ts                 full sweep, report in hci-tests/out/
//   deno run -A hci-tests/run.ts --quick         desktop + mobile + popup only
//   deno run -A hci-tests/run.ts --pages settings
//
// Exit code 1 when any check fails. api.fazon.nexus is blocked; the mock answers everything.
import { launch, type Browser, type Page } from "jsr:@astral/astral@0.5.3";
import { serveDir } from "jsr:@std/http@1.0.10/file-server";
import axe from "npm:axe-core@4.10.2";
import { fromFileUrl } from "jsr:@std/path@1.1.6/from-file-url";
import { CHECKS } from "./checks.ts";

const HERE = fromFileUrl(new URL(".", import.meta.url));
const REPO = fromFileUrl(new URL("..", import.meta.url));
const OUT = HERE + "out/";
const args = Deno.args;
const flag = (n: string) => args.includes(n);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const PROBE = await Deno.readTextFile(HERE + "probe.js");

type Severity = "fail" | "warn";
type Finding = { check: string; severity: Severity; page: string; profile: string; detail: string };
const findings: Finding[] = [];
const ran = new Map<string, number>();
const note = (check: string) => ran.set(check, (ran.get(check) || 0) + 1);
const add = (check: string, severity: Severity, page: string, profile: string, detail: string) => findings.push({ check, severity, page, profile, detail });

type Profile = { name: string; w: number; h: number; layout: "standard" | "wide"; mobile?: boolean; theme?: "light" | "dark" | null; scheme?: "light" | "dark"; reduce?: boolean };
const MOBILE: Profile = { name: "mobile 375×812", w: 375, h: 812, layout: "standard", mobile: true };
const REFLOW: Profile = { name: "reflow 320×640", w: 320, h: 640, layout: "standard", mobile: true };
const DESKTOP: Profile = { name: "standard 1366×768", w: 1366, h: 768, layout: "standard" };
const DESKTOP_LIGHT: Profile = { ...DESKTOP, name: "standard 1366×768 light", theme: "light" };
const REDUCE: Profile = { ...DESKTOP, name: "standard 1366×768 reduced-motion", reduce: true };
const WIDE: Profile[] = [[1920, 1080], [2560, 1440], [2560, 1080], [3440, 1440]].map(([w, h]) => ({ name: `wide ${w}×${h}`, w, h, layout: "wide" as const }));
const WIDE_LIGHT: Profile = { ...WIDE[0], name: "wide 1920×1080 light", theme: "light" };
// the toolbar popup is a fixed-width panel (popup.css), so it only gets its own size
const POPUP: Profile = { name: "popup 360×600", w: 360, h: 600, layout: "standard" };
const POPUP_LIGHT: Profile = { ...POPUP, name: "popup 360×600 light", theme: "light" };

// dashboard pages (both views, plus the empty first-run state) and the popup
const DASH = ["/dev/preview-dashboard.html", "/dev/preview-dashboard.html#settings", "/dev/preview-dashboard.html?empty=1"];
const POP = ["/dev/preview-popup.html", "/dev/preview-popup.html?state=idle"];
let pages = [...DASH, ...POP];
const only = opt("--pages");
if (only) pages = pages.filter((p) => only.split(",").some((s) => p.includes(s)));
const isPopup = (p: string) => p.includes("popup");

// ---------- serve the repo root ----------
const port = (() => { const l = Deno.listen({ port: 0, hostname: "127.0.0.1" }); const p = (l.addr as Deno.NetAddr).port; l.close(); return p; })();
const base = `http://127.0.0.1:${port}`;
const server = Deno.serve({ port, hostname: "127.0.0.1", onListen() {} }, (req) => serveDir(req, { fsRoot: REPO, quiet: true }));
console.log(`${pages.length} pages, base ${base}`);

const browser: Browser = await launch({ args: ["--mute-audio", "--autoplay-policy=user-gesture-required", "--hide-scrollbars"] });

const INIT = (p: Profile) => `
  // each tab gets its own in-memory localStorage (the mock keeps chrome.storage in it too), so
  // parallel passes can't flip each other's theme or layout
  (() => {
    const m = new Map();
    const store = {
      getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
      setItem: (k, v) => { m.set(String(k), String(v)); },
      removeItem: (k) => { m.delete(String(k)); },
      clear: () => m.clear(),
      key: (i) => [...m.keys()][i] ?? null,
      get length() { return m.size; },
    };
    Object.defineProperty(window, "localStorage", { value: store, configurable: true });
    store.setItem("fz-layout", ${JSON.stringify(p.layout)});
    ${p.theme === null ? "" : `store.setItem("fz-theme", ${JSON.stringify(p.theme || "dark")}); store.setItem("mock-storage", JSON.stringify({ theme: ${JSON.stringify(p.theme || "dark")} }));`}
  })();
  window.__hciPerf = { cls: 0, lcp: 0, raf: 0 };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) __hciPerf.cls += e.value; }).observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver((l) => { const e = l.getEntries().at(-1); if (e) __hciPerf.lcp = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch (e) {}
  const raf = window.requestAnimationFrame;
  window.requestAnimationFrame = function (f) { __hciPerf.raf++; return raf.call(window, f); };
  HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
  if (window.AudioContext) { AudioContext.prototype.resume = function () { return Promise.resolve(); }; }
  if (window.speechSynthesis) { speechSynthesis.speak = function () {}; }
`;

async function ev<T = unknown>(page: Page, expression: string): Promise<T> {
  const c = page.unsafelyGetCelestialBindings();
  const r = await c.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value as T;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function open(path: string, p: Profile): Promise<Page> {
  const page = await browser.newPage();
  const c = page.unsafelyGetCelestialBindings();
  await c.Network.enable({});
  await c.Network.setBlockedURLs({ urls: ["*api.fazon.nexus*"] });
  await c.Emulation.setDeviceMetricsOverride({ width: p.w, height: p.h, deviceScaleFactor: 1, mobile: !!p.mobile });
  if (p.mobile) await c.Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
  const features = [{ name: "prefers-reduced-motion", value: p.reduce ? "reduce" : "no-preference" }];
  if (p.scheme) features.push({ name: "prefers-color-scheme", value: p.scheme });
  await c.Emulation.setEmulatedMedia({ features });
  await c.Page.addScriptToEvaluateOnNewDocument({ source: INIT(p) });
  await page.goto(base + path, { waitUntil: "load" });
  await sleep(1200);   // the loader fetches the real page, then the mock answers getStats
  await ev(page, `Promise.race([Promise.all(document.getAnimations().filter(a => a.effect && a.effect.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))), new Promise(r => setTimeout(r, 3000))])`);
  await ev(page, PROBE);
  return page;
}

async function key(page: Page, k: string, code: string, vk: number, mods = 0) {
  const c = page.unsafelyGetCelestialBindings();
  const b = { key: k, code, windowsVirtualKeyCode: vk, modifiers: mods };
  await c.Input.dispatchKeyEvent({ type: "keyDown", ...b, text: k.length === 1 && !(mods & 2) ? k : undefined });
  await c.Input.dispatchKeyEvent({ type: "keyUp", ...b });
}

// ---------- passes (as in the site's suite) ----------
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
async function axeRun(page: Page, path: string, p: Profile, contrastOnly = false) {
  await ev(page, axe.source);
  const runOnly = contrastOnly ? { type: "rule", values: ["color-contrast", "link-in-text-block"] } : { type: "tag", values: [...WCAG_TAGS, "best-practice"] };
  const v = await ev<{ id: string; impact: string; help: string; tags: string[]; nodes: { target: string[]; ratio: string }[] }[]>(page,
    `axe.run(document, { runOnly: ${JSON.stringify(runOnly)}, resultTypes: ["violations"] }).then(r => r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, tags: v.tags, nodes: v.nodes.map(n => { const d = (n.any[0] || {}).data || {}; return { target: n.target, ratio: !d.contrastRatio ? "" : !d.fgColor ? d.contrastRatio + ":1 against the surrounding text, no underline" : d.fgColor + " on " + d.bgColor + " = " + d.contrastRatio + ":1 (needs " + d.expectedContrastRatio + ")" }; }) })))`);
  note("axe-wcag"); if (!contrastOnly) note("axe-best-practice");
  for (const x of v) {
    const wcag = x.tags.some((t) => WCAG_TAGS.includes(t));
    const where = x.nodes.slice(0, 3).map((n) => n.target.join(" ") + (n.ratio ? ` [${n.ratio}]` : "")).join("; ") + (x.nodes.length > 3 ? ` (+${x.nodes.length - 3} more)` : "");
    add(wcag ? "axe-wcag" : "axe-best-practice", wcag ? "fail" : "warn", path, p.name, `${x.id} (${x.impact}): ${x.help} — ${where}`);
  }
}
async function sideways(page: Page, path: string, p: Profile, check: string) {
  const o = await ev<{ vw: number; sw: number; off: { sel: string; right: number }[] }>(page, "__hci.overflow()");
  note(check);
  if (o.sw > o.vw + 1) add(check, "fail", path, p.name, `page is ${o.sw}px wide in a ${o.vw}px viewport; sticks out: ${o.off.map((x) => `${x.sel} (to ${x.right}px)`).join(", ") || "?"}`);
}
async function targetSize(page: Page, path: string, p: Profile) {
  const t = await ev<{ sel: string; label: string; w: number; h: number }[]>(page, "__hci.targets()");
  note("target-size");
  for (const x of t) add("target-size", "fail", path, p.name, `${x.w}×${x.h}px "${x.label}" — ${x.sel}`);
}
async function typography(page: Page, path: string, p: Profile) {
  const ps = await ev<{ sel: string; fs: number; lh: number; cpl: number; family: string }[]>(page, "__hci.typography()");
  if (!ps.length) return;
  note("body-text-size"); note("line-height"); note("line-length");
  const seen = new Set<string>();
  for (const x of ps) {
    const k = `${x.fs}|${x.lh}|${x.cpl}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (x.fs < 14) add("body-text-size", "fail", path, p.name, `${x.fs}px ${x.family} — ${x.sel}`);
    else if (x.fs < 16) add("body-text-size", "warn", path, p.name, `${x.fs}px ${x.family} — ${x.sel}`);
    if (x.lh < 1.4) add("line-height", "warn", path, p.name, `line-height ${x.lh} — ${x.sel}`);
    if (x.cpl > 100) add("line-length", "fail", path, p.name, `${x.cpl} characters per line — ${x.sel}`);
    else if (x.cpl > 80) add("line-length", "warn", path, p.name, `${x.cpl} characters per line — ${x.sel}`);
    else if (x.cpl < 35 && !p.mobile && !isPopup(path)) add("line-length", "warn", path, p.name, `only ${x.cpl} characters per line on a ${p.w}px screen — ${x.sel}`);
  }
}
const stops = new Map<string, number>();
async function focusTour(page: Page, path: string, p: Profile) {
  note("focus-visible"); note("focus-not-obscured");
  const seen = new Set<string>();
  for (let i = 0; i < 80; i++) {
    await key(page, "Tab", "Tab", 9);
    const f = await ev<{ none?: boolean; id: string; sel: string; label: string; indicator: boolean; onScreen: boolean; covered: boolean; by: string }>(page, "__hci.focusState()");
    if (f.none) continue;
    if (seen.has(f.id)) break;
    seen.add(f.id);
    if (!f.indicator) add("focus-visible", "fail", path, p.name, `no visible focus change on "${f.label}" — ${f.sel}`);
    stops.set(`${path} (${p.name})`, seen.size);
    if (!f.onScreen) add("focus-not-obscured", "fail", path, p.name, `focus went off screen to "${f.label}" — ${f.sel}`);
    else if (f.covered) add("focus-not-obscured", "fail", path, p.name, `"${f.label}" is hidden under ${f.by} when focused — ${f.sel}`);
  }
}
const titles = new Map<string, string>();
const navs = new Map<string, string[]>();
async function structure(page: Page, path: string, p: Profile) {
  const [ptr, nav, links, heads, clip, title] = await Promise.all([
    ev<{ sel: string; label: string }[]>(page, "__hci.pointerOnly()"),
    ev<{ text: string; href: string; current: string | null }[]>(page, "__hci.nav()"),
    ev<{ vague: { sel: string; text: string }[]; ambiguous: { text: string; targets: number }[] }>(page, "__hci.links()"),
    ev<{ h1: string[]; skips: string[] }>(page, "__hci.headings()"),
    ev<{ sel: string; text: string }[]>(page, "__hci.textSpacing()"),
    ev<string>(page, "document.title"),
  ]);
  note("keyboard-reachable"); note("link-purpose"); note("headings"); note("text-spacing");
  for (const x of ptr) add("keyboard-reachable", "fail", path, p.name, `"${x.label}" looks clickable but can't be reached by Tab — ${x.sel}`);
  if (!isPopup(path)) {
    note("where-am-i");
    navs.set(path, nav.map((n) => `${n.text} → ${n.href}`));
    if (nav.length && !nav.some((n) => n.current === "page")) add("where-am-i", "fail", path, p.name, `nav has no link marked aria-current`);
    titles.set(path.replace(/\?.*$/, ""), title);
  }
  for (const x of links.vague) add("link-purpose", "fail", path, p.name, `link text "${x.text}" — ${x.sel}`);
  for (const x of links.ambiguous) add("link-purpose", "warn", path, p.name, `"${x.text}" leads to ${x.targets} different pages`);
  if (heads.h1.length !== 1) add("headings", "warn", path, p.name, `${heads.h1.length} visible h1s: ${heads.h1.map((t) => `"${t}"`).join(", ") || "none"}`);
  for (const s of heads.skips) add("headings", "warn", path, p.name, `skipped level: ${s}`);
  for (const x of clip) add("text-spacing", "fail", path, p.name, `"${x.text}" clipped — ${x.sel}`);
}
async function perf(page: Page, path: string, p: Profile) {
  await sleep(500);
  const r = await ev<{ cls: number; lcp: number }>(page, "__hciPerf");
  note("layout-stability");
  if (r.cls > 0.25) add("layout-stability", "fail", path, p.name, `CLS ${r.cls.toFixed(3)}`);
  else if (r.cls > 0.1) add("layout-stability", "warn", path, p.name, `CLS ${r.cls.toFixed(3)}`);
}
async function motion(page: Page, path: string, p: Profile) {
  const before = await ev<number>(page, "__hciPerf.raf");
  await sleep(1000);
  const [after, anims] = await Promise.all([ev<number>(page, "__hciPerf.raf"), ev<{ sel: string; name: string; duration: number; iterations: number }[]>(page, "__hci.animations()")]);
  note("reduced-motion");
  if (after - before > 20) add("reduced-motion", "fail", path, p.name, `requestAnimationFrame ran ${after - before}×/s with reduced motion on`);
  for (const a of anims) if (a.iterations === Infinity || a.duration > 1000) add("reduced-motion", "fail", path, p.name, `${a.name} still running (${a.iterations === Infinity ? "infinite" : a.duration + "ms"}) — ${a.sel}`);
}
async function layoutStatus(page: Page, path: string, p: Profile, saved: string) {
  const s = await ev<{ wide: boolean; pressed: string | null; segVisible: boolean }>(page, "__hci.layoutState()");
  note("layout-status");
  if (s.segVisible && s.pressed !== (s.wide ? "wide" : "standard"))
    add("layout-status", "warn", path, p.name, `saved "${saved}", switch shows "${s.pressed}" pressed, page is ${s.wide ? "wide" : "standard"}`);
}

// ---------- run ----------
const quick = flag("--quick");
type Job = () => Promise<void>;
const jobs: Job[] = [];
const visit = (path: string, p: Profile, fn: (page: Page) => Promise<void>) => jobs.push(async () => {
  let page: Page | undefined;
  try { page = await open(path, p); await fn(page); }
  catch (e) { add("harness", "warn", path, p.name, `couldn't test: ${(e as Error).message.split("\n")[0]}`); }
  finally { await page?.close().catch(() => {}); }
});

for (const path of pages) {
  if (isPopup(path)) {
    visit(path, POPUP, async (pg) => {
      await structure(pg, path, POPUP);
      await typography(pg, path, POPUP);
      await targetSize(pg, path, POPUP);
      await sideways(pg, path, POPUP, "no-sideways-scroll");
      await axeRun(pg, path, POPUP);
      await focusTour(pg, path, POPUP);
    });
    visit(path, POPUP_LIGHT, (pg) => axeRun(pg, path, POPUP_LIGHT, true));
    visit(path, { ...POPUP, name: "popup reduced-motion", reduce: true }, (pg) => motion(pg, path, { ...POPUP, name: "popup reduced-motion", reduce: true }));
    continue;
  }
  visit(path, DESKTOP, async (pg) => {
    await perf(pg, path, DESKTOP);
    await structure(pg, path, DESKTOP);
    await typography(pg, path, DESKTOP);
    await targetSize(pg, path, DESKTOP);
    await sideways(pg, path, DESKTOP, "no-sideways-scroll");
    await axeRun(pg, path, DESKTOP);
    await focusTour(pg, path, DESKTOP);
  });
  visit(path, DESKTOP_LIGHT, (pg) => axeRun(pg, path, DESKTOP_LIGHT, true));
  visit(path, MOBILE, async (pg) => {
    await typography(pg, path, MOBILE);
    await targetSize(pg, path, MOBILE);
    await sideways(pg, path, MOBILE, "no-sideways-scroll");
    await axeRun(pg, path, MOBILE);
  });
  if (quick) continue;
  visit(path, REFLOW, (pg) => sideways(pg, path, REFLOW, "reflow-320"));
  visit(path, REDUCE, (pg) => motion(pg, path, REDUCE));
  for (const w of WIDE) visit(path, w, async (pg) => {
    await layoutStatus(pg, path, w, "wide");
    await sideways(pg, path, w, "no-sideways-scroll");
    await typography(pg, path, w);
    await targetSize(pg, path, w);
    if (w === WIDE[0]) { await structure(pg, path, w); await axeRun(pg, path, w); await focusTour(pg, path, w); }
  });
  visit(path, WIDE_LIGHT, (pg) => axeRun(pg, path, WIDE_LIGHT, true));
}

const home = DASH[0];
for (const p of [{ ...MOBILE, name: "mobile 375×812, wide saved", layout: "wide" as const }, { ...DESKTOP, name: "1366×768, wide saved", layout: "wide" as const }])
  visit(home, p, (pg) => layoutStatus(pg, home, p, "wide"));
for (const scheme of ["light", "dark"] as const) for (const path of [home, POP[0]]) {
  const p: Profile = { ...(isPopup(path) ? POPUP : DESKTOP), name: `first visit, OS prefers ${scheme}`, theme: null, scheme };
  visit(path, p, async (pg) => {
    note("colour-scheme");
    const s = await ev<{ light: boolean }>(pg, "__hci.layoutState()");
    if (s.light !== (scheme === "light")) add("colour-scheme", "warn", path, p.name, `shows the ${s.light ? "light" : "dark"} theme`);
  });
}
if (!quick) visit(home, WIDE[0], async (pg) => {
  note("char-key-shortcuts");
  await ev(pg, "document.activeElement && document.activeElement.blur()");
  await key(pg, "?", "Slash", 191, 8);
  await sleep(200);
  let sheet = await ev<string | null>(pg, `(document.getElementById("wKeys") || {}).textContent || null`);
  if (!sheet) {   // Ctrl+/ should open it whatever the single-key setting
    await key(pg, "/", "Slash", 191, 2);
    await sleep(200);
    sheet = await ev<string | null>(pg, `(document.getElementById("wKeys") || {}).textContent || null`);
  }
  if (!sheet) return;
  const keys = await ev<string[]>(pg, `[...document.querySelectorAll("#wKeys kbd")].map(k => k.textContent)`);
  const single = keys.filter((k) => /^\S$/.test(k));
  if (single.length && !/turn off|disable|shortcuts off/i.test(sheet))
    add("char-key-shortcuts", "warn", home, WIDE[0].name, `global single-key shortcuts (${single.join(" ")}) with no off switch other than leaving Wide`);
});

const N = +(opt("--jobs") || 4);
let done = 0;
await Promise.all(Array.from({ length: N }, async () => {
  while (jobs.length) {
    const j = jobs.shift()!;
    await j();
    if (++done % 25 === 0) console.log(`  ${done} passes…`);
  }
}));

// cross-page checks: the two dashboard views need different titles and the same nav
note("page-titles");
const byTitle = new Map<string, string[]>();
for (const [pth, t] of titles) byTitle.set(t, [...(byTitle.get(t) || []), pth]);
for (const [t, ps] of byTitle) if (ps.length > 1) add("page-titles", "fail", ps.join(", "), DESKTOP.name, `${ps.length} views share the title "${t}"`);
note("consistent-nav");
const navCounts = new Map<string, string[]>();
for (const [pth, n] of navs) { const k = n.join(" | "); navCounts.set(k, [...(navCounts.get(k) || []), pth]); }
if (navCounts.size > 1) {
  const sorted = [...navCounts].sort((a, b) => b[1].length - a[1].length);
  for (const [k, ps] of sorted.slice(1)) add("consistent-nav", "fail", ps.join(", "), DESKTOP.name, `nav differs from the other ${sorted[0][1].length} views: ${k}`);
}

await browser.close();
await server.shutdown();

// ---------- report ----------
await Deno.mkdir(OUT, { recursive: true });
const lit = await Deno.readTextFile(HERE + "LITERATURE.md");
const anchors = new Map([...lit.matchAll(/\*\*\[([^\]]+)\]\*\* <a id=/g)].map((m) => [m[1], m[1].toLowerCase()]));
const cite = (k: string) => anchors.has(k) ? `[${k}](../LITERATURE.md#${anchors.get(k)})` : k;
const lines = [`# HCI check report: extension`, ``, `${new Date().toISOString().slice(0, 16).replace("T", " ")} · ${pages.length} pages${quick ? " · quick" : ""}`, ``];
const order = [...Object.keys(CHECKS), "harness"];
const summary: string[] = [];
const sections: string[] = [];
let fails = 0, warns = 0;
for (const id of order) {
  const c = CHECKS[id] || { title: "Test harness problems", rule: "Pages that couldn't be loaded or probed.", sources: [] };
  const fs = findings.filter((f) => f.check === id);
  if (!ran.get(id) && !fs.length) continue;
  const nf = fs.filter((f) => f.severity === "fail").length, nw = fs.length - nf;
  fails += nf; warns += nw;
  const status = nf ? "❌ fail" : nw ? "⚠️ warn" : "✅ pass";
  summary.push(`| ${status} | [${c.title}](#${id}) | ${nf} | ${nw} | ${c.sources.map(cite).join(", ")} |`);
  sections.push(`<a id="${id}"></a>`, `## ${status} — ${c.title}`, ``, `${c.rule}`, ``, `Sources: ${c.sources.map(cite).join(", ") || "—"}`, ``);
  const merged = new Map<string, { sev: Severity; where: Set<string> }>();
  for (const f of fs) {
    const k = `${f.severity}|${f.detail}`;
    const m = merged.get(k) || { sev: f.severity, where: new Set<string>() };
    m.where.add(`${f.page} (${f.profile})`);
    merged.set(k, m);
  }
  const rows = [...merged].sort((a, b) => (a[1].sev === b[1].sev ? b[1].where.size - a[1].where.size : a[1].sev === "fail" ? -1 : 1));
  for (const [k, m] of rows.slice(0, 60)) {
    const w = [...m.where];
    sections.push(`- **${m.sev}** ${k.split("|").slice(1).join("|")}  \n  ${w.length > 4 ? `${w.length} places, e.g. ${w.slice(0, 4).join(", ")}` : w.join(", ")}`);
  }
  if (rows.length > 60) sections.push(`- … ${rows.length - 60} more in report.json`);
  sections.push("");
}
const zero = pages.filter((pth) => !stops.get(`${pth} (${isPopup(pth) ? POPUP.name : DESKTOP.name})`));
if (zero.length) sections.push(`Focus tour reached nothing on: ${zero.join(", ")}`, "");
lines.push(`**${fails} failures, ${warns} warnings.**`, ``, `| | Check | Fail | Warn | Literature |`, `|---|---|---|---|---|`, ...summary, ``, ...sections);
await Deno.writeTextFile(OUT + "report.md", lines.join("\n"));
await Deno.writeTextFile(OUT + "report.json", JSON.stringify({ base, pages, findings }, null, 1));
console.log(`\n${fails} failures, ${warns} warnings → ${OUT}report.md`);
Deno.exit(fails ? 1 : 0);
