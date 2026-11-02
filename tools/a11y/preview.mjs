#!/usr/bin/env node
/**
 * Phase 2 preview, run on every push: from impact.json, say which member pages the PR affects
 * and how to start the live test, without starting Suma or the agent.
 *
 *   node preview.mjs --sha <head sha> [--existing body.md] [--out comment.md]
 *
 * With --existing (the current sticky comment), earlier test results are kept and only the status
 * block is rewritten, so it says whether they still describe the latest commit.
 */
import fs from "node:fs";
import path from "node:path";
import { isMain, loadConfig, mdEscape, parseArgs, readJson, reportDir } from "./lib/common.mjs";
import { HEADING, MARKER, replaceStatus, short, statusBlock, TEST_LABEL, testedSha } from "./lib/comment.mjs";

export function scopeLines(impact, max = 15) {
  const routes = Object.values(impact.apps).flatMap((a) => a.routes);
  if (!routes.length) return { count: 0, lines: [] };
  const lines = ["| Page | Why it is in scope |", "|---|---|"];
  for (const r of routes.slice(0, max)) {
    const why = r.reasons.slice(0, 2).map((x) => x.why).join("; ") + (r.reasons.length > 2 ? `; +${r.reasons.length - 2} more` : "");
    lines.push(`| \`${r.path}\`${r.locales.length > 1 ? ` (${r.locales.join(", ")})` : ""} | ${mdEscape(why)} |`);
  }
  if (routes.length > max) lines.push(`| … | ${routes.length - max} more |`);
  const notTested = Object.values(impact.apps).flatMap((a) => a.notTested || []);
  if (notTested.length) lines.push("", `${notTested.length} more pages are reachable from shared code but are past the per-run cap and would not be tested.`);
  return { count: routes.length, lines };
}

export function previewBody({ impact, sha, existing }) {
  const { count, lines } = scopeLines(impact);
  const tested = testedSha(existing);
  const scope = count
    ? `This PR currently affects **${count} member app page${count === 1 ? "" : "s"}**.`
    : "This PR currently affects **no member app pages**.";
  const start = count ? `Add the \`${TEST_LABEL}\` label to run the live test on commit \`${short(sha)}\`.` : "There is nothing to test in the browser.";

  if (tested) {
    const current = sha.startsWith(tested) || tested.startsWith(sha);
    const status = current
      ? [`> [!NOTE]`, `> Results below are for \`${short(tested)}\`, the latest commit.`]
      : [`> [!WARNING]`, `> Results below are for \`${short(tested)}\`. Newer commits have been pushed (latest \`${short(sha)}\`), so they may be out of date. ${scope} ${start}`];
    const details = count && !current ? ["", "<details><summary>Pages in scope now</summary>", "", ...lines, "", "</details>"] : [];
    return replaceStatus(existing, statusBlock([...status, ...details]));
  }
  return [MARKER, HEADING, "", statusBlock([`Not tested yet. ${scope} ${start}`, ...(count ? ["", ...lines] : [])]), ""].join("\n");
}

if (isMain(import.meta.url)) {
  const args = parseArgs();
  if (!args.sha) throw new Error("--sha is required");
  const out = reportDir(loadConfig());
  const impact = readJson(path.join(out, "impact.json"));
  const existing = args.existing && fs.existsSync(args.existing) ? fs.readFileSync(args.existing, "utf8") : "";
  const body = previewBody({ impact, sha: args.sha, existing: existing.trim() ? existing : null });
  fs.writeFileSync(args.out || path.join(out, "comment.md"), body);
  console.log(body);
}
