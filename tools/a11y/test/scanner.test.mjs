import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { tagToSc } from "../axe-sweep.mjs";
import { MARKER, replaceStatus, statusBlock, testedSha, testedShaMarker } from "../lib/comment.mjs";
import { loadCatalog, reportDir } from "../lib/common.mjs";
import { parseImports, resolveImport } from "../lib/graph.mjs";
import { parseImportBindings, parseRoutes } from "../lib/routes.mjs";
import { checkSession, enforceCoverage, enforceKeyboardCoverage, keyPressesByPath, pageEvidence } from "../lib/session.mjs";
import { previewBody } from "../preview.mjs";
import { previousLeads } from "../carry.mjs";
import { findingsMarker } from "../lib/comment.mjs";
import { spreadsChildren } from "../static-scan.mjs";
import { MEASURED, validate } from "../validate-report.mjs";

test("catalog has all 86 active WCAG 2.2 criteria and marks 4.1.1 obsolete", () => {
  const c = loadCatalog();
  const levels = Object.values(c.criteria).map((x) => x.level);
  assert.equal(levels.length, 86);
  assert.equal(levels.filter((l) => l === "A").length, 31);
  assert.equal(levels.filter((l) => l === "AA").length, 24);
  assert.equal(levels.filter((l) => l === "AAA").length, 31);
  assert.ok(!c.criteria["4.1.1"]);
  assert.ok(c.obsolete["4.1.1"]);
  for (const [sc, v] of Object.entries(c.criteria)) assert.ok(v.why.length > 40, `${sc} needs a why`);
});

test("axe tags map to criteria", () => {
  assert.equal(tagToSc("wcag143"), "1.4.3");
  assert.equal(tagToSc("wcag1411"), "1.4.11");
  assert.equal(tagToSc("wcag258"), "2.5.8");
  assert.equal(tagToSc("wcag2aa"), null);
});

test("import parsing covers JS forms and SCSS", () => {
  const js = `import A from "./a";\nimport { b as c } from '../b';\nimport "./x.scss";\nexport { d } from "./d";\nconst L = import("./lazy");`;
  assert.deepEqual(parseImports("f.jsx", js).sort(), ["../b", "./a", "./d", "./lazy", "./x.scss"]);
  assert.deepEqual(parseImports("s.scss", `@import "vars", "mixins";\n@use 'theme' as t;`), ["vars", "mixins", "theme"]);
  assert.equal(resolveImport("webapp/src/App.jsx", "react"), null);
  assert.equal(resolveImport("webapp/src/App.jsx", "./pages/Dashboard"), "webapp/src/pages/Dashboard.jsx");
});

test("import bindings", () => {
  const b = parseImportBindings(`import X, { y, z as Q } from "./m";\nimport * as NS from "./n";`);
  assert.equal(b.get("X"), "./m");
  assert.equal(b.get("y"), "./m");
  assert.equal(b.get("Q"), "./m");
  assert.equal(b.get("NS"), "./n");
});

test("member app routes parse with auth and page files", () => {
  const { routes } = parseRoutes("webapp/src/App.jsx");
  const dash = routes.find((r) => r.path === "/dashboard");
  assert.ok(dash.needsAuth);
  assert.equal(dash.identifiers.at(-1).file, "webapp/src/pages/Dashboard.jsx");
  assert.ok(dash.endLine > dash.line);
  const start = routes.find((r) => r.path === "/start");
  assert.equal(start.needsAuth, false);
  assert.ok(routes.find((r) => r.path === "/food/:id").hasParams);
});

test("spread wrappers are not flagged for missing content", () => {
  assert.equal(spreadsChildren(["  return <a href={u} {...anchorProps} />;"], 1, 10), true);
  assert.equal(spreadsChildren(["<Link", "  to={to}", "  {...rest}", "/>"], 1, 1), true);
  assert.equal(spreadsChildren(["<a href={u} {...p}>", "</a>"], 1, 1), false);
  assert.equal(spreadsChildren(['<a href="/x" />'], 1, 1), false);
});

test("measurement checks reject failures the numbers do not support", () => {
  assert.match(MEASURED["1.4.3"]({ ratio: 4.6, required: { "1.4.3": 4.5 } }), /meets/);
  assert.equal(MEASURED["1.4.3"]({ ratio: 2.26, required: { "1.4.3": 4.5 } }), null);
  assert.match(MEASURED["1.4.3"]({ indeterminate: true }), /needsHuman/);
  assert.match(MEASURED["1.4.11"]({ verdict: "ambiguous" }), /needsHuman/);
  assert.equal(MEASURED["1.4.11"]({ verdict: "fail" }), null);
  assert.match(MEASURED["2.5.8"]({ spacingExceptionChecked: true, passes: { "2.5.8": true } }), /passes/);
  assert.match(MEASURED["2.4.11"]({ coveredFraction: 0.4 }), /entirely/);
  assert.equal(MEASURED["2.4.11"]({ coveredFraction: 1 }), null);
  assert.match(MEASURED["1.4.10"]({ pageScrollsHorizontally: false, offenders: [] }), /no horizontal/);
});

test("validator accepts proven findings and rejects unproven ones", () => {
  // The validator resolves screenshots against the report directory; write a PNG there.
  const out = reportDir();
  fs.mkdirSync(path.join(out, "screenshots"), { recursive: true });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4000)]);
  const shot = `screenshots/test-${process.pid}.png`;
  fs.writeFileSync(path.join(out, shot), png);
  try {
    const base = { app: "webapp", route: "/funding", url: "http://localhost:22001/app/funding", element: { selector: "#x" }, steps: ["open"], expected: "readable", actual: "faint", severity: "medium", why: "People with low vision cannot read this label because it is too faint against the background." };
    const report = {
      routes: [{ app: "webapp", path: "/funding", status: "tested" }],
      findings: [
        { ...base, id: "F-001", sc: ["1.4.3"], title: "Faint label", measurement: { ratio: 2.26, required: { "1.4.3": 4.5 } }, screenshots: [{ path: shot, caption: "label" }], leadIds: ["AXE-001"] },
        { ...base, id: "F-002", sc: ["1.4.3"], title: "Not actually faint", measurement: { ratio: 5.1, required: { "1.4.3": 4.5 } }, screenshots: [{ path: shot, caption: "x" }] },
        { ...base, id: "F-003", sc: ["4.1.1"], title: "Parsing", screenshots: [{ path: shot, caption: "x" }] },
        { ...base, id: "F-004", sc: ["2.1.1"], title: "No screenshot file", screenshots: [{ path: "screenshots/missing.png", caption: "x" }] },
      ],
      passes: [{ sc: "2.1.1", app: "webapp", route: ["/funding"], method: "Tabbed through every control", evidence: "All controls reachable and operable" }],
      notApplicable: [],
      needsHuman: [],
      dismissedLeads: [],
    };
    const impact = { apps: { webapp: { routes: [{ path: "/funding" }, { path: "/trips" }] } }, leads: [{ id: "S-1", onChangedLine: true }] };
    const axe = { leads: [{ id: "AXE-001" }, { id: "AXE-002" }] };
    const res = validate(report, { impact, axe, catalog: loadCatalog(), checklist: ["1.4.3", "2.1.1", "2.4.7"] });
    assert.deepEqual(res.findings.map((f) => f.id), ["F-001"]);
    assert.equal(res.findings[0].level, "AA");
    assert.deepEqual(res.rejected.map((f) => f.id).sort(), ["F-002", "F-003", "F-004"]);
    const errs = res.errors.join("\n");
    assert.match(errs, /AXE-002 is neither confirmed/);
    assert.match(errs, /S-1 is neither confirmed/);
    assert.match(errs, /\/trips is in scope but missing/);
    assert.match(errs, /no outcome recorded for 2\.4\.7/);
    assert.doesNotMatch(errs, /AXE-001/);
  } finally {
    fs.rmSync(path.join(out, shot), { force: true });
  }
});

test("preview says what is in scope and keeps earlier results when commits are pushed", () => {
  const route = { path: "/funding", locales: ["en", "es"], reasons: [{ why: "changed webapp/src/pages/Funding.jsx" }] };
  const impact = { apps: { webapp: { routes: [route], notTested: [] } } };
  const fresh = previewBody({ impact, sha: "aaaaaaaa1111", existing: null });
  assert.ok(fresh.startsWith(MARKER));
  assert.match(fresh, /Not tested yet/);
  assert.match(fresh, /`\/funding` \(en, es\)/);
  assert.match(fresh, /a11y-test/);

  const tested = [MARKER, "## h", "", testedShaMarker("aaaaaaaa1111"), statusBlock(["Tested commit aaaaaaaa."]), "", "### Confirmed failures", "F-001"].join("\n");
  assert.equal(testedSha(tested), "aaaaaaaa1111");
  const same = previewBody({ impact, sha: "aaaaaaaa1111", existing: tested });
  assert.match(same, /latest commit/);
  const stale = previewBody({ impact, sha: "bbbbbbbb2222", existing: tested });
  assert.match(stale, /Newer commits have been pushed \(latest `bbbbbbbb`\)/);
  assert.match(stale, /### Confirmed failures\nF-001/, "earlier results are kept");
  assert.equal(stale.match(/a11y-status:start/g).length, 1, "status block is replaced, not added");

  const none = previewBody({ impact: { apps: { webapp: { routes: [], notTested: [] } } }, sha: "cccccccc", existing: null });
  assert.match(none, /no member app pages/);
  assert.doesNotMatch(none, /Add the/);
  assert.match(replaceStatus("x", statusBlock(["s"])), /^<!-- a11y-status:start -->/);
});

test("session check rejects scripted browsing and accepts step-by-step use", () => {
  const call = (t) => `### \`playwright-${t}\`\n\nresult\n`;
  const scripted = call("browser_navigate") + call("browser_run_code_unsafe") + "### `bash`\n\n$ node -e \"require('playwright').chromium.launch()\"\n";
  const bad = checkSession(scripted, { routesTested: 2 });
  assert.equal(bad.counts.browser_run_code_unsafe, 1);
  assert.match(bad.errors.join("\n"), /browser_run_code_unsafe 1 times/);
  assert.match(bad.errors.join("\n"), /from the shell/);
  assert.match(bad.errors.join("\n"), /browser_press_key was never called/);
  const good = checkSession(call("browser_navigate") + call("browser_snapshot") + call("browser_press_key") + "### `bash`\n\n$ node tools/a11y/validate-report.mjs\n", { routesTested: 1 });
  assert.deepEqual(good.errors, []);
  assert.deepEqual(checkSession("", { routesTested: 0 }).errors, []);
});

test("Tab presses are counted per page and per browser", () => {
  const nav = (srv, url) => `### \`${srv}-browser_navigate\`\n\n\`\`\`json\n{ "url": "${url}" }\n\`\`\`\n- Page URL: ${url}\n`;
  const key = (srv, k) => `### \`${srv}-browser_press_key\`\n\n\`\`\`json\n{ "key": "${k}" }\n\`\`\`\n`;
  const log = [
    nav("playwright", "http://localhost:22001/app/funding"),
    nav("playwright-anon", "http://localhost:22001/app/sitemap/"),
    key("playwright", "Tab"), key("playwright", "Shift+Tab"), key("playwright", "Enter"),
    key("playwright-anon", "Tab"),
    "### `playwright-browser_click`\n\n- Page URL: http://localhost:22001/app/food/12\n",
    key("playwright", "Tab"),
  ].join("\n");
  assert.deepEqual(keyPressesByPath(log), { "/funding": 2, "/sitemap": 1, "/food/12": 1 });
});

test("keyboard passes without a full Tab pass move to needsHuman", () => {
  const report = { passes: [
    { sc: "2.1.1", app: "webapp", route: ["/funding", "/sitemap", "/food/:id"], method: "m", evidence: "e" },
    { sc: "1.4.3", app: "webapp", route: "/funding", method: "m", evidence: "e" },
  ] };
  const { passes, moved } = enforceKeyboardCoverage(report, { keys: { "/funding": 12, "/sitemap": 2, "/food/7": 10 }, tabbables: { "/funding": 12, "/sitemap": 30 } });
  assert.deepEqual(passes.map((p) => [p.sc, p.route]), [["2.1.1", ["/funding", "/food/:id"]], ["1.4.3", "/funding"]]);
  assert.equal(moved.length, 1);
  assert.match(moved[0].reason, /2 Tab presses on a page with 30 Tab stops/);
  const home = enforceKeyboardCoverage({ passes: [{ sc: "2.4.3", app: "webapp", route: "/" }] }, { keys: { "/": 4, "/funding": 9 }, tabbables: { "/": 4 } });
  assert.equal(home.moved.length, 0, "the home page gets credit for its own presses");
});

test("resize, motion, spacing and snapshots are tracked per page and back passes", () => {
  const blk = (srv, tool, args = "", url = "") => `### \`${srv}-${tool}\`\n\n\`\`\`json\n{ ${args} }\n\`\`\`\n</details>\n${url ? `- Page URL: ${url}\n` : ""}`;
  const log = [
    blk("playwright", "browser_navigate", `"url": "http://localhost:22001/app/funding"`, "http://localhost:22001/app/funding"),
    blk("playwright", "browser_snapshot", "", "http://localhost:22001/app/funding"),
    blk("playwright", "browser_resize", `"width": 320, "height": 640`),
    blk("playwright", "browser_evaluate", `"function": "() => window.__a11y.textSpacing(true)"`),
    blk("playwright", "browser_emulate_media", `"reducedMotion": "reduce"`),
    blk("playwright", "browser_navigate", `"url": "http://localhost:22001/app/trips"`, "http://localhost:22001/app/trips"),
  ].join("\n");
  const ev = pageEvidence(log);
  assert.deepEqual(ev["/funding"], { tabs: 0, snapshots: 1, widths: [1280, 320], reducedMotion: true, textSpacing: true, tabStops: null });
  assert.deepEqual(ev["/trips"].widths, [320], "the viewport carries over to the next page");
  assert.equal(ev["/trips"].snapshots, 0);
  const pass = (sc) => ({ sc, app: "webapp", route: ["/funding", "/trips"], method: "m", evidence: "e" });
  const { passes, moved } = enforceCoverage({ passes: ["1.4.10", "1.4.12", "4.1.2", "1.4.3"].map(pass) }, { evidence: ev });
  assert.deepEqual(passes.map((p) => [p.sc, p.route]), [["1.4.10", ["/funding", "/trips"]], ["1.4.12", ["/funding"]], ["4.1.2", ["/funding"]], ["1.4.3", ["/funding", "/trips"]]]);
  assert.deepEqual(moved.map((m) => [m.sc, m.route, m.downgraded]), [["1.4.12", "/trips", true], ["4.1.2", "/trips", true]]);
});

test("procedural needsHuman entries need a blocker", () => {
  const report = { routes: [], findings: [], passes: [], notApplicable: [], dismissedLeads: [], needsHuman: [
    { sc: "1.4.10", app: "webapp", route: "/trips", reason: "only tested on /sitemap" },
    { sc: "1.4.10", app: "webapp", route: "/order/:id", blocker: "unreachable", reason: "no orders in the demo data" },
    { sc: "3.1.5", app: "webapp", route: "/trips", reason: "reading level needs judgement" },
    { sc: "2.1.1", app: "webapp", route: "/x", downgraded: true, reason: "agent set this" },
  ] };
  const errs = validate(report, { impact: null, axe: null, catalog: loadCatalog(), checklist: [] }).errors.join("\n");
  assert.match(errs, /1\.4\.10 on \/trips is in needsHuman without a blocker/);
  assert.doesNotMatch(errs, /order\/:id/);
  assert.doesNotMatch(errs, /3\.1\.5/);
  assert.match(errs, /"downgraded" is set by the validator only/);
});

test("independent re-measurement drops refuted criteria and measured findings need replay for states", () => {
  const out = reportDir();
  fs.mkdirSync(path.join(out, "screenshots"), { recursive: true });
  const shot = `screenshots/rc-${process.pid}.png`;
  fs.writeFileSync(path.join(out, shot), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4000)]));
  try {
    const base = { app: "webapp", route: "/sitemap", url: "http://x/app/sitemap", element: { selector: "#s" }, steps: ["open"], expected: "e", actual: "a", severity: "medium", why: "People with low vision cannot see where this switch is because its border is too faint.", screenshots: [{ path: shot, caption: "c" }] };
    const nt = { property: "borderTopColor", verdict: "fail", ratioOutside: 2.2 };
    const report = { routes: [{ app: "webapp", path: "/sitemap", status: "tested" }], passes: [], notApplicable: [], needsHuman: [], dismissedLeads: [], findings: [
      { ...base, id: "F-001", sc: ["1.4.11"], title: "Faint switch", measurement: nt, state: "menu open", replay: [{ action: "click", target: ".toggler" }] },
      { ...base, id: "F-002", sc: ["1.4.11", "4.1.2"], title: "Faint and unnamed", measurement: nt },
      { ...base, id: "F-003", sc: ["1.4.11"], title: "No replay", measurement: nt, state: "menu open" },
      { ...base, id: "F-004", sc: ["4.1.2"], title: "Unnamed in open menu", state: "menu open", element: { selector: "#other" } },
    ] };
    const recheck = [
      { id: "F-001", sc: "1.4.11", status: "refuted", detail: "verdict is pass" },
      { id: "F-002", sc: "1.4.11", status: "refuted", detail: "verdict is pass" },
    ];
    const res = validate(report, { impact: null, axe: null, catalog: loadCatalog(), checklist: [], recheck });
    assert.deepEqual(res.findings.map((f) => [f.id, f.sc]), [["F-002", ["4.1.2"]], ["F-004", ["4.1.2"]]]);
    assert.match(res.rejected.find((f) => f.id === "F-001").rejectedBecause.join(), /re-measurement of 1\.4\.11 shows a pass/);
    assert.match(res.rejected.find((f) => f.id === "F-003").rejectedBecause.join(), /no replay steps/);
    assert.equal(res.findings[0].recheck[0].status, "refuted");
  } finally {
    fs.rmSync(path.join(out, shot), { force: true });
  }
});

test("confirmed findings carry into the next run as leads that need proof to dismiss", () => {
  const body = ["<!-- suma-a11y-impact-report -->", findingsMarker([{ id: "F-001", sc: ["4.1.2"], level: "A", app: "webapp", route: "/sitemap", url: "http://x/app/sitemap", title: "Menu state", actual: "no aria-expanded", element: { selector: "button.navbar-toggler" }, replay: [{ action: "click", target: "button.navbar-toggler" }] }], "abc123456789"), "text"].join("\n");
  const prev = previousLeads(body);
  assert.equal(prev.fromSha, "abc123456789");
  assert.deepEqual(prev.leads.map((l) => [l.id, l.previousId, l.sc[0], l.target[0]]), [["PREV-001", "F-001", "4.1.2", "button.navbar-toggler"]]);
  assert.equal(previousLeads("no marker").leads.length, 0);

  const base = { routes: [], findings: [], passes: [], notApplicable: [], needsHuman: [] };
  const open = validate({ ...base, dismissedLeads: [] }, { impact: null, axe: null, catalog: loadCatalog(), checklist: [], previous: prev }).errors.join("\n");
  assert.match(open, /PREV-001 is neither confirmed/);
  const noShot = validate({ ...base, dismissedLeads: [{ leadId: "PREV-001", reason: "fixed", evidence: "snapshot shows expanded" }] }, { impact: null, axe: null, catalog: loadCatalog(), checklist: [], previous: prev }).errors.join("\n");
  assert.match(noShot, /add a screenshot showing it is fixed/);
});

test("Tab stops come from the agent's own probe calls when the sweep has none", () => {
  const log = [
    "### `playwright-browser_navigate`\n\n```json\n{ \"url\": \"http://localhost:22001/app/cart/1\" }\n```\n</details>\n- Page URL: http://localhost:22001/app/cart/1\n",
    "### `playwright-browser_evaluate`\n\n```json\n{ \"function\": \"() => window.__a11y.tabbables()\" }\n```\n</details>\n### Result\n{ \"count\": 12, \"elements\": [] }\n",
    ...Array.from({ length: 12 }, () => "### `playwright-browser_press_key`\n\n```json\n{ \"key\": \"Tab\" }\n```\n"),
  ].join("\n");
  const ev = pageEvidence(log);
  assert.equal(ev["/cart/1"].tabStops, 12);
  const { moved } = enforceCoverage({ passes: [{ sc: "2.1.1", app: "webapp", route: "/cart/:id", method: "m", evidence: "e" }] }, { evidence: ev });
  assert.equal(moved.length, 0);
  const short = pageEvidence(log.replace("\"count\": 12", "\"count\": 20"));
  assert.match(enforceCoverage({ passes: [{ sc: "2.1.1", app: "webapp", route: "/cart/:id" }] }, { evidence: short }).moved[0].reason, /12 Tab presses on a page with 20 Tab stops/);
});
