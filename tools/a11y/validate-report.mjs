#!/usr/bin/env node
/**
 * Phase 2, step 4: check the agent's report against the evidence rules, so only proven
 * failures and real passes reach the pull request.
 *
 * A failure is rejected (moved to "rejected", never shown as a failure) when:
 *   - a criterion is not a WCAG 2.2 success criterion (4.1.1 Parsing is obsolete)
 *   - it lacks reproduction steps, expected/actual, a plain-English why, or an element selector
 *   - a screenshot is missing on disk or is not a PNG/JPEG
 *   - the criterion is measurable and the probe measurement is missing or shows a pass
 * The report as a whole is incomplete (exit 1) when:
 *   - a lead from axe.json, or a static lead on a changed line, is neither confirmed nor dismissed
 *   - a route in impact.json has no entry in routes[]
 *   - a tested route has no outcome for a checklist criterion (fail, pass, n/a or needs human)
 *
 *   node validate-report.mjs [--report a11y-report/report.json] [--report-only]
 * Writes <reportDir>/validated.json. Exit 0 clean, 1 incomplete or rejected findings, 2 unreadable.
 */
import fs from "node:fs";
import path from "node:path";
import { criterion, isMain, loadCatalog, loadConfig, parseArgs, readJson, REPO_ROOT, reportDir, writeJson } from "./lib/common.mjs";
import { checkSession } from "./lib/session.mjs";

const args = parseArgs();
const config = loadConfig();
const out = reportDir(config);

/** Criterion-specific proof: return an error string when the measurement does not show a failure. */
export const MEASURED = {
  "1.4.3": (m) => (m?.indeterminate ? "contrast is indeterminate (image or opacity behind text); move to needsHuman" : typeof m?.ratio !== "number" ? "needs contrast() output with ratio" : !(m.ratio < (m.required?.["1.4.3"] ?? (m.large ? 3 : 4.5))) ? `ratio ${m.ratio} meets the 1.4.3 threshold` : null),
  "1.4.6": (m) => (m?.indeterminate ? "contrast is indeterminate; move to needsHuman" : typeof m?.ratio !== "number" ? "needs contrast() output with ratio" : !(m.ratio < (m.required?.["1.4.6"] ?? (m.large ? 4.5 : 7))) ? `ratio ${m.ratio} meets the 1.4.6 threshold` : null),
  "1.4.11": (m) => (!m ? "needs nonTextContrast() output" : m.verdict === "ambiguous" ? "one side passes and one fails; move to needsHuman" : m.verdict ? (m.verdict !== "fail" ? `verdict is ${m.verdict}` : null) : typeof m.ratio === "number" && m.ratio < 3 ? null : "needs a ratio below 3"),
  "2.5.8": (m) => (!m?.spacingExceptionChecked ? "needs targetSize() output (with the spacing exception checked)" : m.passes?.["2.5.8"] !== false ? "targetSize() reports 2.5.8 passes (size or spacing exception)" : null),
  "2.5.5": (m) => (typeof m?.width !== "number" ? "needs targetSize() output" : m.width >= 44 && m.height >= 44 ? `target is ${m.width}x${m.height}` : null),
  "2.4.11": (m) => (typeof m?.coveredFraction !== "number" ? "needs focusInfo() output" : m.coveredFraction < 1 ? `only ${m.coveredFraction * 100}% covered; 2.4.11 fails only when entirely hidden` : null),
  "2.4.12": (m) => (typeof m?.coveredFraction !== "number" ? "needs focusInfo() output" : m.coveredFraction === 0 ? "focusInfo() shows no part covered" : null),
  "1.4.10": (m) => (!m || (m.pageScrollsHorizontally === undefined && m.contentLost === undefined) ? "needs reflow() output at 320px" : m.pageScrollsHorizontally || m.contentLost ? null : "reflow() shows no horizontal scrolling and contentLost is not set"),
  "1.4.12": (m) => (!m || (!Array.isArray(m.clipped) && m.contentLost === undefined) ? "needs textSpacing() output" : (m.clipped?.length || m.contentLost) ? null : "textSpacing() found no clipped text and contentLost is not set"),
};

function imageOk(p) {
  const abs = path.resolve(out, p);
  if (!abs.startsWith(out + path.sep)) return `screenshot ${p} is outside the report directory`;
  if (!fs.existsSync(abs)) return `screenshot ${p} does not exist`;
  const buf = fs.readFileSync(abs);
  const png = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpg = buf[0] === 0xff && buf[1] === 0xd8;
  if (!png && !jpg) return `screenshot ${p} is not a PNG or JPEG`;
  if (buf.length < 1500) return `screenshot ${p} is suspiciously small (${buf.length} bytes)`;
  return null;
}

export function validate(report, { impact, axe, catalog, checklist }) {
  const errors = [];
  const warnings = [];
  const accepted = [];
  const rejected = [];
  const obsolete = catalog.obsolete || {};
  const isSc = (s) => !!catalog.criteria[s];

  for (const f of report.findings || []) {
    const problems = [];
    const sc = [...new Set(f.sc || [])];
    for (const s of sc) {
      if (obsolete[s]) problems.push(`${s} is obsolete in WCAG 2.2`);
      else if (!isSc(s)) problems.push(`${s} is not a WCAG 2.2 success criterion`);
    }
    for (const k of ["title", "why", "expected", "actual", "route", "url", "app"]) if (!String(f[k] || "").trim()) problems.push(`missing ${k}`);
    if (String(f.why || "").trim().length < 40) problems.push("why must explain the user impact in a full sentence");
    if (!f.element?.selector) problems.push("missing element.selector");
    if (!Array.isArray(f.steps) || !f.steps.length) problems.push("missing reproduction steps");
    if (!Array.isArray(f.screenshots) || !f.screenshots.length) problems.push("no screenshot");
    for (const s of f.screenshots || []) {
      const e = imageOk(s.path || "");
      if (e) problems.push(e);
      if (!String(s.caption || "").trim()) problems.push(`screenshot ${s.path} has no caption`);
    }
    for (const s of sc) {
      const check = MEASURED[s];
      if (!check) continue;
      const e = check(f.measurement);
      if (e) problems.push(`${s}: ${e}`);
    }
    const valid = sc.filter((s) => isSc(s) && !obsolete[s]);
    const levels = valid.map((s) => catalog.criteria[s].level);
    const level = ["A", "AA", "AAA"].find((l) => levels.includes(l));
    if (f.level && level && f.level !== level) warnings.push(`${f.id}: level corrected from ${f.level} to ${level}`);
    const normalized = { ...f, sc: valid, level, criteria: valid.map((s) => criterion(s)) };
    if (problems.length) rejected.push({ ...normalized, rejectedBecause: problems });
    else accepted.push(normalized);
  }

  // Merge duplicates: same criteria, route and selector.
  const seen = new Map();
  const findings = [];
  for (const f of accepted) {
    const key = `${f.app}|${f.route}|${f.sc.slice().sort().join(",")}|${f.element.selector}`;
    if (seen.has(key)) {
      const prev = seen.get(key);
      prev.screenshots.push(...f.screenshots);
      prev.leadIds = [...new Set([...(prev.leadIds || []), ...(f.leadIds || [])])];
      warnings.push(`${f.id} merged into ${prev.id} (duplicate)`);
    } else {
      seen.set(key, f);
      findings.push(f);
    }
  }

  // Every lead must be resolved.
  const resolved = new Set([...findings.flatMap((f) => f.leadIds || []), ...rejected.flatMap((f) => f.leadIds || []), ...(report.dismissedLeads || []).map((d) => d.leadId)]);
  for (const d of report.dismissedLeads || []) {
    if (!String(d.reason || "").trim() || !String(d.evidence || "").trim()) errors.push(`dismissed lead ${d.leadId} needs a reason and evidence`);
    if (d.screenshot) {
      const e = imageOk(d.screenshot);
      if (e) errors.push(`dismissed lead ${d.leadId}: ${e}`);
    }
  }
  const requiredLeads = [...(axe?.leads || []).map((l) => l.id), ...(impact?.leads || []).filter((l) => l.onChangedLine).map((l) => l.id)];
  for (const id of requiredLeads) if (!resolved.has(id)) errors.push(`lead ${id} is neither confirmed (leadIds on a finding) nor dismissed`);

  // Every impacted route must be accounted for, and tested routes need an outcome per checklist criterion.
  const routeKey = (app, p) => `${app}|${p}`;
  const reported = new Map((report.routes || []).map((r) => [routeKey(r.app, r.path), r]));
  for (const [appKey, a] of Object.entries(impact?.apps || {})) {
    for (const r of a.routes) {
      const rr = reported.get(routeKey(appKey, r.path));
      if (!rr) {
        errors.push(`route ${appKey} ${r.path} is in scope but missing from routes[]`);
        continue;
      }
      if (rr.status !== "tested") {
        if (!String(rr.notes || "").trim()) errors.push(`route ${appKey} ${r.path} is ${rr.status} without notes explaining why`);
        continue;
      }
      for (const s of checklist) {
        // route may be one path or a list of paths (one pass entry can cover several routes).
        const onRoute = (x) => x.route === r.path || (Array.isArray(x.route) && x.route.includes(r.path));
        const has = (list) => (list || []).some((x) => x.app === appKey && onRoute(x) && (x.sc === s || (Array.isArray(x.sc) && x.sc.includes(s))));
        if (!has(findings) && !has(rejected) && !has(report.passes) && !has(report.notApplicable) && !has(report.needsHuman)) {
          errors.push(`route ${appKey} ${r.path}: no outcome recorded for ${s} ${catalog.criteria[s].title}`);
        }
      }
    }
  }

  for (const p of report.passes || []) {
    if (!isSc(p.sc) || obsolete[p.sc]) errors.push(`pass for unknown criterion ${p.sc}`);
    if (String(p.method || "").trim().length < 15 || String(p.evidence || "").trim().length < 15) errors.push(`pass ${p.sc} on ${p.route} needs a concrete method and evidence`);
    if (p.screenshot) {
      const e = imageOk(p.screenshot);
      if (e) errors.push(`pass ${p.sc} on ${p.route}: ${e}`);
    }
    const pRoutes = Array.isArray(p.route) ? p.route : [p.route];
    if (findings.some((f) => f.app === p.app && pRoutes.includes(f.route) && f.sc.includes(p.sc) && !p.scope)) {
      warnings.push(`${p.sc} on ${p.route} is both passed and failed; give the pass a "scope" (which elements it covers)`);
    }
  }
  for (const n of [...(report.notApplicable || []), ...(report.needsHuman || [])]) {
    if (!isSc(n.sc)) errors.push(`unknown criterion ${n.sc} in notApplicable/needsHuman`);
    if (!String(n.reason || "").trim()) errors.push(`${n.sc} on ${n.route} needs a reason`);
  }
  for (const f of rejected) errors.push(`finding ${f.id} rejected: ${f.rejectedBecause.join("; ")}`);

  return { findings, rejected, errors, warnings };
}

function main() {
  const reportPath = path.resolve(REPO_ROOT, args.report || path.join(out, "report.json"));
  let report;
  try {
    report = readJson(reportPath);
  } catch (e) {
    console.error(`Cannot read ${reportPath}: ${e.message}`);
    process.exit(2);
  }
  const load = (f) => (fs.existsSync(path.join(out, f)) ? readJson(path.join(out, f)) : null);
  const impact = load("impact.json");
  const axe = load("axe.json");
  const res = validate(report, { impact, axe, catalog: loadCatalog(), checklist: config.agentChecklist });
  let session;
  if (args.session) {
    // The workflow passes the transcript after the agent finishes; the agent's own runs skip this.
    const sessionPath = path.resolve(REPO_ROOT, args.session);
    const routesTested = (report.routes || []).filter((r) => r.status === "tested").length;
    if (fs.existsSync(sessionPath)) {
      session = checkSession(fs.readFileSync(sessionPath, "utf8"), { routesTested });
      res.errors.push(...session.errors.map((e) => `browser use: ${e}`));
    } else if (routesTested) {
      res.errors.push(`browser use: no session transcript at ${args.session}, so live testing cannot be confirmed`);
    }
  }
  const result = { ...report, findings: res.findings, rejected: res.rejected, validation: { errors: res.errors, warnings: res.warnings, browserCalls: session?.counts, validatedAt: new Date().toISOString() } };
  writeJson(path.join(out, "validated.json"), result);
  for (const w of res.warnings) console.log(`warning: ${w}`);
  for (const e of res.errors) console.log(`error: ${e}`);
  console.log(`${res.findings.length} confirmed findings, ${res.rejected.length} rejected, ${(report.passes || []).length} passes, ${res.errors.length} errors.`);
  if (res.errors.length && !args["report-only"]) process.exit(1);
}

if (isMain(import.meta.url)) main();
