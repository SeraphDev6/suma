import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { tagToSc } from "../axe-sweep.mjs";
import { MARKER, replaceStatus, statusBlock, testedSha, testedShaMarker } from "../lib/comment.mjs";
import { loadCatalog, reportDir } from "../lib/common.mjs";
import { parseImports, resolveImport } from "../lib/graph.mjs";
import { parseImportBindings, parseRoutes } from "../lib/routes.mjs";
import { checkSession } from "../lib/session.mjs";
import { previewBody } from "../preview.mjs";
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
