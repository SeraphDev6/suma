#!/usr/bin/env node
/**
 * Phase 2, step 5: render validated.json as
 *   <reportDir>/comment.md   pull request comment (GitHub markdown, under 65k characters)
 *   <reportDir>/report.html  self-contained report with screenshots embedded
 *
 *   node render-report.mjs [--image-base https://.../] [--artifact-url URL] [--run-url URL]
 *                          [--sha TESTED_SHA] [--current-sha PR_HEAD_SHA]
 * --image-base: public URL prefix where the screenshots directory was published; without it
 * the comment names the files and links the artifact instead of embedding images.
 */
import fs from "node:fs";
import path from "node:path";
import { HEADING, MARKER, short, statusBlock, TEST_LABEL, testedShaMarker } from "./lib/comment.mjs";
import { criterion, loadConfig, mdEscape, parseArgs, readJson, reportDir } from "./lib/common.mjs";

const args = parseArgs();
const config = loadConfig();
const out = reportDir(config);
const SEV = { critical: 0, high: 1, medium: 2, low: 3 };
const LEVEL = { A: 0, AA: 1, AAA: 2 };

const v = readJson(path.join(out, "validated.json"));
const impact = fs.existsSync(path.join(out, "impact.json")) ? readJson(path.join(out, "impact.json")) : null;
const findings = [...v.findings].sort((a, b) => SEV[a.severity] - SEV[b.severity] || LEVEL[a.level] - LEVEL[b.level] || a.id.localeCompare(b.id));
const scLink = (s) => {
  const c = criterion(s);
  return c ? `[${s} ${c.title}](${c.url}) (${c.level})` : s;
};
const routesOf = (x) => (Array.isArray(x.route) ? x.route : [x.route]);

function measurementLine(f) {
  const m = f.measurement;
  if (!m) return null;
  if (typeof m.ratio === "number" && m.foreground) return `Measured contrast ${m.ratio}:1 (${m.foreground} on ${m.background}, ${m.fontSizePx}px${m.large ? ", large" : ""}); needs ${f.sc.map((s) => m.required?.[s]).filter(Boolean).join(" / ")}:1.`;
  if (m.verdict && m.property) return `Measured ${m.property} ${m.color}: ${m.ratioOutside}:1 against ${m.outside}${m.ratioInside != null ? `, ${m.ratioInside}:1 against ${m.inside}` : ""}; needs 3:1.`;
  if (typeof m.width === "number" && m.spacingExceptionChecked) return `Measured target ${m.width} x ${m.height} px${m.conflicts?.length ? `; too close to ${m.conflicts.map((c) => c.element).join(", ")}` : ""}.`;
  if (typeof m.coveredFraction === "number") return `Focused element ${Math.round(m.coveredFraction * 100)}% covered by ${m.coveredBy.join(", ")}.`;
  if (m.pageScrollsHorizontally !== undefined) return `At ${m.viewportWidth}px wide the page is ${m.documentScrollWidth}px wide${m.offenders?.length ? `; widest: ${m.offenders.slice(0, 3).map((o) => o.element).join(", ")}` : ""}.`;
  return null;
}

function image(p, caption) {
  if (args["image-base"]) return `<img src="${args["image-base"].replace(/\/$/, "")}/${p}" alt="${caption.replace(/"/g, "&quot;")}" width="640">`;
  return `\`${p}\``;
}

function markdown() {
  const lines = [MARKER, HEADING, ""];
  if (args.sha) {
    const stale = args["current-sha"] && args["current-sha"] !== args.sha;
    lines.push(
      testedShaMarker(args.sha),
      statusBlock(
        stale
          ? [`> [!WARNING]`, `> Tested commit \`${short(args.sha)}\`; newer commits were pushed during the test (latest \`${short(args["current-sha"])}\`). Add the \`${TEST_LABEL}\` label to test again.`]
          : [`> [!NOTE]`, `> Tested commit \`${short(args.sha)}\`. After pushing more commits, add the \`${TEST_LABEL}\` label to test again.`],
      ),
      "",
    );
  }
  lines.push(v.summary || "", "");
  const byLevel = { A: 0, AA: 0, AAA: 0 };
  for (const f of findings) byLevel[f.level]++;
  const passCount = (v.passes || []).length;
  const tested = (v.routes || []).filter((r) => r.status === "tested").length;
  lines.push("| Confirmed failures | Level A | Level AA | Level AAA | Passed checks | Routes tested | Needs a human |", "|---|---|---|---|---|---|---|");
  lines.push(`| **${findings.length}** | ${byLevel.A} | ${byLevel.AA} | ${byLevel.AAA} | ${passCount} | ${tested} of ${(v.routes || []).length} | ${(v.needsHuman || []).length} |`, "");
  const calls = v.validation?.browserCalls;
  if (calls) {
    const c = (t) => calls[t] || 0;
    lines.push(`Browser actions by the agent: ${c("browser_navigate")} page loads, ${c("browser_press_key")} key presses, ${c("browser_click")} clicks, ${c("browser_type") + c("browser_fill_form")} text entries, ${c("browser_snapshot")} accessibility snapshots, ${c("browser_take_screenshot")} screenshots.`, "");
  }
  if (v.validation?.errors?.length) {
    lines.push(`> [!WARNING]`, `> The agent's report did not pass validation (${v.validation.errors.length} problems). Results below are incomplete; see the artifact.`, "");
  }

  if (findings.length) lines.push("### Confirmed failures", "");
  for (const f of findings) {
    lines.push(`#### ${f.id} · ${f.title}`, "");
    lines.push(`**WCAG:** ${f.sc.map(scLink).join(", ")} · **Severity:** ${f.severity}${f.introducedByDiff ? ` · **Introduced by this PR:** ${f.introducedByDiff}` : ""}`, "");
    lines.push(`**Why it matters:** ${f.why}`, "");
    for (const s of f.sc) lines.push(`> ${s} ${criterion(s).title}: ${criterion(s).why}`);
    lines.push("");
    lines.push(`**Where:** \`${f.route}\`${f.state ? ` (${f.state})` : ""}${f.locale && f.locale !== "en" ? `, locale ${f.locale}` : ""}, element \`${mdEscape(f.element.selector)}\`${f.element.name ? ` "${mdEscape(f.element.name)}"` : ""}${f.source?.file ? `, source \`${f.source.file}${f.source.line ? ":" + f.source.line : ""}\`` : ""}`, "");
    lines.push("**Steps to reproduce:**", ...f.steps.map((s, i) => `${i + 1}. ${s}`), "");
    lines.push(`**Expected:** ${f.expected}`, "", `**Actual:** ${f.actual}`, "");
    const m = measurementLine(f);
    if (m) lines.push(`**Measurement:** ${m}`, "");
    if (f.recheck?.length) {
      const say = { confirmed: "confirmed", skipped: "not re-measured" };
      lines.push(`**Re-measured independently:** ${f.recheck.map((r) => `${r.sc} ${say[r.status] || r.status}${r.status === "skipped" && r.detail ? ` (${mdEscape(r.detail)})` : ""}`).join("; ")}`, "");
    }
    for (const s of f.screenshots) lines.push(image(s.path, s.caption), `<sub>${s.caption}</sub>`, "");
    if (f.suggestedFix) lines.push(`<details><summary>Suggested fix</summary>\n\n${f.suggestedFix}\n\n</details>`, "");
  }
  if (!findings.length) lines.push("No confirmed failures on the tested pages.", "");

  // Passes grouped by criterion.
  const passBy = new Map();
  for (const p of v.passes || []) {
    if (!passBy.has(p.sc)) passBy.set(p.sc, []);
    passBy.get(p.sc).push(p);
  }
  if (passBy.size) {
    lines.push(`<details><summary>Passed (${passBy.size} criteria, ${passCount} checks)</summary>`, "", "| Criterion | Routes | How it was tested | What was observed |", "|---|---|---|---|");
    for (const [sc, list] of [...passBy].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
      for (const p of list) lines.push(`| ${scLink(sc)} | ${routesOf(p).map((r) => `\`${r}\``).join(" ")} | ${mdEscape(p.method)} | ${mdEscape(p.evidence)} |`);
    }
    lines.push("", "</details>", "");
  }
  const section = (title, list, row) => {
    if (!list?.length) return;
    lines.push(`<details><summary>${title} (${list.length})</summary>`, "", ...list.map(row), "", "</details>", "");
  };
  // One line per page and reason: unreachable pages otherwise repeat the same reason for every criterion.
  const groups = new Map();
  for (const n of v.needsHuman || []) {
    const key = [routesOf(n).join(" "), n.downgraded ? "unverified" : n.blocker || "", n.reason].join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }
  const tag = (n) => (n.downgraded ? " (**not verified**)" : n.blocker ? ` (${n.blocker})` : "");
  if (groups.size) {
    lines.push(`<details><summary>Needs a human (${(v.needsHuman || []).length} across ${groups.size} items)</summary>`, "");
    for (const list of groups.values()) {
      const n = list[0];
      const where = routesOf(n).map((r) => `\`${r}\``).join(" ");
      if (list.length === 1) lines.push(`- ${scLink(n.sc)} on ${where}${tag(n)}: ${mdEscape(n.reason)}`);
      else lines.push(`- ${where}${tag(n)}, ${list.length} criteria (${list.map((x) => x.sc).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join(", ")}): ${mdEscape(n.reason)}`);
    }
    lines.push("", "</details>", "");
  }
  section("Not applicable", v.notApplicable, (n) => `- ${scLink(n.sc)} on ${routesOf(n).map((r) => `\`${r}\``).join(" ")}: ${mdEscape(n.reason)}`);
  section("Automated leads dismissed after live testing", v.dismissedLeads, (d) => `- ${d.leadId}: ${mdEscape(d.reason)} Evidence: ${mdEscape(d.evidence)}`);
  section("Claims rejected by the validator (not reported as failures)", v.rejected, (r) => `- ${r.id} ${mdEscape(r.title)} (${(r.sc || []).join(", ")}): ${mdEscape(r.rejectedBecause.join("; "))}`);
  const untested = (v.routes || []).filter((r) => r.status !== "tested");
  section("Routes not tested", untested, (r) => `- \`${r.path}\` ${r.status}: ${mdEscape(r.notes)}`);
  if (impact) {
    const skipped = Object.values(impact.apps).flatMap((a) => a.notTested);
    if (skipped.length) lines.push(`<sub>Out of scope for this run (wide change, capped at ${config.impact.maxRoutesPerApp} routes per app): ${skipped.map((p) => `\`${p}\``).join(", ")}</sub>`, "");
  }
  const links = [args["run-url"] && `[workflow run](${args["run-url"]})`, args["artifact-url"] && `[full report and screenshots](${args["artifact-url"]})`].filter(Boolean);
  lines.push(`<sub>Static analysis and axe-core produced leads; a Copilot agent confirmed each in a real browser with Playwright. Failures are listed only with a screenshot, reproduction steps and, for measurable criteria, a measurement that shows the failure. ${links.join(" · ")}</sub>`);
  let md = lines.join("\n") + "\n";
  if (md.length > 64000) md = md.slice(0, 63000) + "\n\n_Truncated; see the full report artifact._\n";
  return md;
}

function html() {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const img = (p, cap) => {
    const abs = path.join(out, p);
    if (!fs.existsSync(abs)) return `<p class="missing">Missing screenshot ${esc(p)}</p>`;
    const mime = p.endsWith(".jpg") || p.endsWith(".jpeg") ? "image/jpeg" : "image/png";
    return `<figure><img src="data:${mime};base64,${fs.readFileSync(abs).toString("base64")}" alt="${esc(cap)}"><figcaption>${esc(cap)}</figcaption></figure>`;
  };
  const cards = findings
    .map((f) => {
      const m = measurementLine(f);
      return `<article class="finding sev-${f.severity}" id="${f.id}">
<h3>${f.id} · ${esc(f.title)}</h3>
<p class="meta">${f.sc.map((s) => `<a href="${criterion(s).url}">${s} ${esc(criterion(s).title)}</a> <span class="lvl">${criterion(s).level}</span>`).join(" ")} · severity ${f.severity}</p>
<p><strong>Why it matters.</strong> ${esc(f.why)}</p>
<p><strong>Where.</strong> <code>${esc(f.route)}</code> ${f.state ? `(${esc(f.state)})` : ""} element <code>${esc(f.element.selector)}</code></p>
<ol>${f.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
<p><strong>Expected.</strong> ${esc(f.expected)}</p><p><strong>Actual.</strong> ${esc(f.actual)}</p>
${m ? `<p><strong>Measurement.</strong> ${esc(m)}</p>` : ""}
${f.screenshots.map((s) => img(s.path, s.caption)).join("")}
</article>`;
    })
    .join("\n");
  const passRows = (v.passes || []).map((p) => `<tr><td>${p.sc} ${esc(criterion(p.sc)?.title)}</td><td>${routesOf(p).map(esc).join(", ")}</td><td>${esc(p.method)}</td><td>${esc(p.evidence)}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Accessibility Impact Report</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--muted:#555;--line:#ddd;--crit:#a40000;--high:#b34700;--med:#7a5d00;--low:#3d5a80}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#eee;--muted:#bbb;--line:#333;--crit:#ff8a80;--high:#ffab70;--med:#e6c96b;--low:#9cc3ff}}
body{background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,sans-serif;margin:0 auto;max-width:960px;padding:16px}
a{color:inherit}.meta{color:var(--muted)}.lvl{border:1px solid var(--line);border-radius:4px;padding:0 4px;font-size:.85em}
.finding{border-left:4px solid var(--line);padding:4px 16px;margin:24px 0}.sev-critical{border-color:var(--crit)}.sev-high{border-color:var(--high)}.sev-medium{border-color:var(--med)}.sev-low{border-color:var(--low)}
figure{margin:12px 0}img{max-width:100%;border:1px solid var(--line)}figcaption{color:var(--muted);font-size:.9em}
table{border-collapse:collapse;width:100%;font-size:.9em}td,th{border:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top}
</style></head><body>
<h1>Accessibility impact report</h1><p>${esc(v.summary)}</p>
<h2>Confirmed failures (${findings.length})</h2>${cards || "<p>None on the tested pages.</p>"}
<h2>Passed checks (${(v.passes || []).length})</h2><table><thead><tr><th>Criterion</th><th>Routes</th><th>Method</th><th>Evidence</th></tr></thead><tbody>${passRows}</tbody></table>
<h2>Needs a human (${(v.needsHuman || []).length})</h2><ul>${(v.needsHuman || []).map((n) => `<li>${n.sc} ${esc(criterion(n.sc)?.title)} on ${routesOf(n).map(esc).join(", ")}: ${esc(n.reason)}</li>`).join("")}</ul>
<h2>Dismissed leads (${(v.dismissedLeads || []).length})</h2><ul>${(v.dismissedLeads || []).map((d) => `<li>${esc(d.leadId)}: ${esc(d.reason)} ${esc(d.evidence)}</li>`).join("")}</ul>
<h2>Rejected claims (${(v.rejected || []).length})</h2><ul>${(v.rejected || []).map((r) => `<li>${esc(r.id)} ${esc(r.title)}: ${esc(r.rejectedBecause.join("; "))}</li>`).join("")}</ul>
</body></html>`;
}

fs.writeFileSync(path.join(out, "comment.md"), markdown());
fs.writeFileSync(path.join(out, "report.html"), html());
console.log(`Wrote ${path.join(out, "comment.md")} and report.html (${findings.length} findings).`);
