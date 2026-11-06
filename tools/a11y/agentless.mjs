#!/usr/bin/env node
/**
 * Phase 2 without the agent: build validated.json from what the scripts measured on their own.
 * No Copilot requests, so it can run as often as needed.
 *
 *   node agentless.mjs        reads impact.json, axe.json, previous.json, recheck.json
 *                             writes <reportDir>/validated.json (mode "agentless")
 *
 * Reported as failures, each marked as automated:
 *   - axe-core violations on WCAG criteria (axe reports these only when it is certain),
 *     merged across pages when the same rule fails on the same element;
 *   - show/hide buttons that change the page but do not expose their state (DISC- leads);
 *   - findings carried from the last agent run that the re-check still measures as failing.
 * Listed, not reported as failures:
 *   - axe "needs review" results and non-WCAG rules: axe could not decide them;
 *   - carried findings that now measure as passing, and those that cannot be re-measured
 *     without the agent (they stay open and carry to the next run).
 * There are no passes: a script proves only what it measured, so nothing is claimed beyond that.
 */
import fs from "node:fs";
import path from "node:path";
import { criterion, isMain, loadCatalog, readJson, reportDir, loadConfig, writeJson } from "./lib/common.mjs";
import { findingFromLead } from "./validate-report.mjs";

const SEVERITY = { critical: "critical", serious: "high", moderate: "medium", minor: "low" };
const firstTarget = (t) => (Array.isArray(t) ? t.flat(Infinity)[0] : t) || "";

export function agentlessReport({ impact, axe, previous, recheck, catalog }) {
  const isSc = (s) => !!catalog.criteria[s] && !catalog.obsolete?.[s];
  const findings = [];
  const leadsToReview = [];
  let n = 0;
  const nextId = () => `F-${String(++n).padStart(3, "0")}`;

  // axe violations and show/hide leads, merged when the same problem shows on several pages.
  const groups = new Map();
  for (const l of axe?.leads || []) {
    const sc = (l.sc || []).filter(isSc);
    const automatic = (l.source === "axe" && l.kind === "violation") || l.source === "disclosure-check";
    if (!automatic || !sc.length) {
      leadsToReview.push({ leadId: l.id, rule: l.rule, sc: l.sc || [], app: l.app, route: l.route, help: l.help, summary: l.summary, target: firstTarget(l.target), screenshot: l.screenshot });
      continue;
    }
    const key = `${l.app}|${l.rule}|${firstTarget(l.target)}`;
    if (groups.has(key)) {
      const g = groups.get(key);
      g.leads.push(l);
      continue;
    }
    groups.set(key, { sc, leads: [l] });
  }
  for (const { sc, leads } of groups.values()) {
    const l = leads[0];
    const levels = sc.map((s) => catalog.criteria[s].level);
    const disclosure = l.source === "disclosure-check";
    const selector = firstTarget(l.target);
    const alsoOn = [...new Set([...leads.slice(1).map((x) => x.route), ...leads.flatMap((x) => x.alsoOn || [])])].filter((r) => r !== l.route);
    findings.push({
      id: nextId(),
      sc,
      level: ["A", "AA", "AAA"].find((x) => levels.includes(x)),
      criteria: sc.map((s) => criterion(s)),
      app: l.app,
      route: l.route,
      url: l.url,
      locale: l.locale,
      title: disclosure ? "A show/hide button does not say whether its content is open" : l.help,
      why: sc.map((s) => criterion(s).why).join(" "),
      expected: disclosure ? "The button has aria-expanded, and it changes between false and true as the content opens and closes." : `The element passes the axe-core rule \`${l.rule}\`.`,
      actual: disclosure ? l.help : String(l.summary || "").replace(/\s+/g, " ").trim() || l.help,
      severity: disclosure ? "high" : SEVERITY[l.impact] || "medium",
      steps: disclosure
        ? [`Open ${l.url}`, `Click \`${l.html || selector}\``, `Content appears (${l.summary}), but the button's aria-expanded does not report it`]
        : [`Open ${l.url}`, `Run axe-core; rule \`${l.rule}\` fails on \`${selector}\``],
      element: { selector, html: l.html },
      screenshots: leads.filter((x) => x.screenshot).slice(0, 1).map((x) => ({ path: x.screenshot, caption: `${x.route}: the failing element is outlined.` })),
      leadIds: leads.map((x) => x.id),
      ...(alsoOn.length ? { alsoOn } : {}),
      automated: { source: disclosure ? "show/hide check" : "axe-core", rule: l.rule },
    });
  }

  // Findings carried from the last agent run, judged only by the independent re-measurement.
  const carriedFixed = [];
  const carriedOpen = [];
  for (const lead of previous?.leads || []) {
    const rs = (recheck || []).filter((r) => r.id === lead.id);
    const still = rs.filter((r) => r.status === "confirmed");
    if (still.length) {
      findings.push({ ...findingFromLead(lead, { id: nextId(), results: still, catalog, previous }), carriedFrom: { leadId: lead.id, previousId: lead.previousId, fromSha: previous.fromSha } });
    } else if (rs.length && rs.every((r) => r.status === "refuted")) {
      carriedFixed.push({ leadId: lead.id, previousId: lead.previousId, title: lead.title, sc: lead.sc, route: lead.route, detail: rs.map((r) => `${r.sc}: ${r.detail}`).join("; ") });
    } else {
      const why = rs.length ? rs.map((r) => `${r.sc}: ${r.detail || r.status}`).join("; ") : `${(lead.sc || []).join(", ")} cannot be re-measured without the agent`;
      carriedOpen.push({ lead, reason: why });
    }
  }

  const routes = Object.entries(impact?.apps || {}).flatMap(([app, a]) => a.routes.map((r) => {
    const page = (axe?.pages || []).find((p) => p.app === app && p.path === r.path);
    return { app, path: r.path, status: page ? "scanned" : "not-scanned", ...(page ? {} : { notes: "the axe sweep did not load this page" }) };
  }));
  const summary = `Automated scan only: axe-core and the show/hide check on ${routes.filter((r) => r.status === "scanned").length} pages, and an independent re-measurement of ${(previous?.leads || []).length} findings carried from the last live test. No agent ran, so keyboard use, flows and anything needing judgement were not tested.`;
  return { mode: "agentless", summary, routes, findings, rejected: [], passes: [], notApplicable: [], needsHuman: [], dismissedLeads: [], leadsToReview, carriedFixed, carriedOpen };
}

if (isMain(import.meta.url)) {
  const out = reportDir(loadConfig());
  const load = (f) => (fs.existsSync(path.join(out, f)) ? readJson(path.join(out, f)) : null);
  const report = agentlessReport({ impact: load("impact.json"), axe: load("axe.json"), previous: load("previous.json"), recheck: load("recheck.json")?.results || null, catalog: loadCatalog() });
  writeJson(path.join(out, "validated.json"), { ...report, validation: { errors: [], warnings: [], validatedAt: new Date().toISOString() } });
  console.log(`${report.findings.length} automated failures, ${report.leadsToReview.length} leads to review, ${report.carriedFixed.length} carried findings now pass, ${report.carriedOpen.length} still open.`);
}
