#!/usr/bin/env node
/**
 * Carry the last run's confirmed findings into this run as leads the agent must resolve, so a
 * failure found before is either shown to still fail or shown, with evidence, to be fixed.
 *
 *   node carry.mjs --existing a11y-report/existing.md     writes <reportDir>/previous.json
 *
 * The findings come from the hidden a11y-findings marker that render-report.mjs puts in the PR
 * comment.
 */
import fs from "node:fs";
import path from "node:path";
import { isMain, loadConfig, parseArgs, reportDir, writeJson } from "./lib/common.mjs";
import { readFindingsMarker } from "./lib/comment.mjs";

export function previousLeads(body) {
  const data = readFindingsMarker(body);
  if (!data?.findings?.length) return { fromSha: data?.sha || null, leads: [] };
  const leads = data.findings.map((f, i) => ({
    id: `PREV-${String(i + 1).padStart(3, "0")}`,
    source: "previous-run",
    previousId: f.id,
    sc: f.sc,
    level: f.level,
    app: f.app,
    route: f.route,
    url: f.url,
    locale: f.locale,
    state: f.state,
    replay: f.replay,
    title: f.title,
    actual: f.actual,
    target: [f.element?.selector].filter(Boolean),
    help: `Confirmed as a failure in the run on ${data.sha ? data.sha.slice(0, 8) : "an earlier commit"}: ${f.title}`,
  }));
  return { fromSha: data.sha || null, leads };
}

if (isMain(import.meta.url)) {
  const args = parseArgs();
  const out = reportDir(loadConfig());
  const body = args.existing && fs.existsSync(args.existing) ? fs.readFileSync(args.existing, "utf8") : "";
  const prev = previousLeads(body);
  writeJson(path.join(out, "previous.json"), prev);
  console.log(`${prev.leads.length} findings carried forward from ${prev.fromSha ? prev.fromSha.slice(0, 8) : "no earlier run"}.`);
}
