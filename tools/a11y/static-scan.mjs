#!/usr/bin/env node
/**
 * Phase 1: full-site static accessibility analysis.
 *
 * Runs eslint-plugin-jsx-a11y (every rule that maps to a WCAG 2.2 criterion) plus Suma-specific
 * checks over both frontends, maps every result to WCAG criteria, and writes:
 *   <reportDir>/static.json   machine-readable findings (read by impact.mjs and the agent)
 *   <reportDir>/static.sarif  for GitHub code scanning annotations
 *   <reportDir>/static.md     human summary (also appended to the Actions step summary)
 *
 * Options:
 *   --app webapp              limit to one app (default: all in config.json)
 *   --fail-on new|violation|none
 *                             new: exit 1 if a finding is not in static-baseline.json (default)
 *                             violation: exit 1 on any 'violation'-confidence finding
 *   --update-baseline         write the current findings as the accepted baseline
 */
import fs from "node:fs";
import path from "node:path";
import { appendStepSummary, criterion, isMain, loadConfig, mdEscape, parseArgs, readJson, REPO_ROOT, reportDir, sha1, TOOL_DIR, writeJson } from "./lib/common.mjs";
import { runCustomChecks, runTranslationChecks } from "./lib/custom-checks.mjs";

const args = parseArgs();
const config = loadConfig();
const rules = readJson(path.join(TOOL_DIR, "rules.json"));
const outDir = reportDir(config);
const baselinePath = path.join(TOOL_DIR, "static-baseline.json");
const failOn = args["fail-on"] || "new";

// Rules about an element's content. On a self-closing element that spreads props, the
// content arrives through the spread (a wrapper component), so the result is not a real defect.
const CONTENT_RULES = new Set(["anchor-has-content", "heading-has-content", "control-has-associated-label"]);

/** Read the opening tag that starts at (line, column) and report whether it is `<X {...rest} />`. */
export function spreadsChildren(lines, line, column) {
  const text = lines.slice(line - 1, line + 30).join("\n").slice(Math.max(0, column - 1));
  let depth = 0;
  for (let i = 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (depth === 0 && ch === ">") {
      const tag = text.slice(0, i + 1);
      return /\/\s*>$/.test(tag) && /\{\s*\.\.\./.test(tag);
    }
  }
  return false;
}

const ignore = (config.staticIgnore || []).map((p) => new RegExp(p));
const isIgnored = (file) => ignore.some((re) => re.test(file));

async function runEslint(app) {
  const { ESLint } = await import("eslint");
  const ruleConfig = {};
  for (const [name, def] of Object.entries(rules.jsxA11y)) {
    ruleConfig[`jsx-a11y/${name}`] = def.options ? ["error", def.options] : "error";
  }
  const components = Object.fromEntries(Object.entries(rules.components).filter(([k]) => !k.startsWith("_")));
  const eslint = new ESLint({
    cwd: REPO_ROOT,
    useEslintrc: false,
    resolvePluginsRelativeTo: TOOL_DIR,
    errorOnUnmatchedPattern: false,
    allowInlineConfig: false, // eslint-disable comments must not hide accessibility failures
    overrideConfig: {
      root: true,
      parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } },
      plugins: ["jsx-a11y"],
      settings: { "jsx-a11y": { components, polymorphicPropName: "as" } },
      rules: ruleConfig,
      ignorePatterns: ["**/node_modules/**", "**/*.test.js", "**/*.test.jsx"],
    },
  });
  const results = await eslint.lintFiles([`${app.srcDir}/**/*.{js,jsx}`]);
  const out = [];
  for (const r of results) {
    const file = path.relative(REPO_ROOT, r.filePath).split(path.sep).join("/");
    const lines = (r.source || fs.readFileSync(r.filePath, "utf8")).split("\n");
    for (const m of r.messages) {
      if (m.fatal) {
        out.push({ rule: "parse-error", file, line: m.line, column: m.column, message: m.message, snippet: "" });
        continue;
      }
      const name = (m.ruleId || "").replace(/^jsx-a11y\//, "");
      if (!rules.jsxA11y[name]) continue;
      if (CONTENT_RULES.has(name) && spreadsChildren(lines, m.line, m.column)) continue;
      const message = m.message.replace(/\s*Learn more:.*$/s, "");
      out.push({ rule: `jsx-a11y/${name}`, file, line: m.line, column: m.column, message, snippet: (lines[m.line - 1] || "").trim() });
    }
  }
  return out;
}

function enrich(raw, appKey) {
  const name = raw.rule.replace(/^jsx-a11y\//, "");
  const def = raw.rule.startsWith("jsx-a11y/") ? rules.jsxA11y[name] : rules.custom[raw.rule];
  if (!def) return { ...raw, app: appKey, sc: [], confidence: "lead", tool: "eslint" };
  return {
    app: appKey,
    tool: raw.rule.startsWith("jsx-a11y/") ? "eslint-plugin-jsx-a11y" : "suma-custom",
    rule: raw.rule,
    sc: def.sc,
    levels: def.sc.map((s) => criterion(s)?.level),
    confidence: def.confidence,
    file: raw.file,
    line: raw.line,
    column: raw.column,
    message: raw.message || def.message + (raw.detail ? ` (${raw.detail})` : ""),
    snippet: raw.snippet,
    ...(raw.key ? { key: raw.key } : {}),
  };
}

/** Fingerprint survives line moves: rule + file + normalized line text + occurrence number. */
function fingerprint(findings) {
  const seen = new Map();
  for (const f of findings) {
    const base = `${f.rule}|${f.file}|${(f.snippet || "").replace(/\s+/g, " ")}|${f.key || ""}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    f.fingerprint = sha1(`${base}|${n}`).slice(0, 16);
    f.id = `S-${f.fingerprint.slice(0, 8)}`;
  }
}

function toSarif(findings) {
  const ruleIds = [...new Set(findings.map((f) => f.rule))];
  const sarifRules = ruleIds.map((id) => {
    const sample = findings.find((f) => f.rule === id);
    const crits = sample.sc.map(criterion).filter(Boolean);
    return {
      id,
      name: id.replace(/[^\w]/g, "_"),
      shortDescription: { text: `${id} (WCAG ${crits.map((c) => `${c.sc} ${c.title} [${c.level}]`).join("; ")})` },
      fullDescription: { text: crits.map((c) => `${c.sc} ${c.title}: ${c.why}`).join("\n") || id },
      helpUri: crits[0]?.url,
      help: { text: crits.map((c) => `WCAG ${c.sc} ${c.title} (Level ${c.level}). ${c.why} ${c.url}`).join("\n\n") },
      properties: { tags: ["accessibility", "WCAG2.2", ...crits.map((c) => `wcag-${c.sc}`), ...crits.map((c) => `level-${c.level}`)], confidence: sample.confidence },
    };
  });
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "suma-a11y-static", informationUri: "https://www.w3.org/TR/WCAG22/", rules: sarifRules } },
        results: findings.map((f) => ({
          ruleId: f.rule,
          ruleIndex: ruleIds.indexOf(f.rule),
          level: f.confidence === "violation" ? "warning" : "note",
          message: { text: `${f.message} [WCAG ${f.sc.join(", ")}; ${f.confidence === "violation" ? "static violation" : "lead, needs live confirmation"}]` },
          partialFingerprints: { primaryLocationLineHash: f.fingerprint },
          locations: [{ physicalLocation: { artifactLocation: { uri: f.file }, region: { startLine: f.line || 1, startColumn: f.column || 1 } } }],
        })),
      },
    ],
  };
}

function toMarkdown(findings, newOnes, appsScanned) {
  const lines = ["## Accessibility phase 1: static analysis", ""];
  lines.push(`Scanned: ${appsScanned.join(", ")}. ${findings.length} results: ${findings.filter((f) => f.confidence === "violation").length} static violations, ${findings.filter((f) => f.confidence === "lead").length} leads that need a live check. ${newOnes.length} not in the baseline.`, "");
  lines.push("Static analysis cannot prove conformance. Violations are certain code defects; leads are patterns that phase 2 confirms or dismisses in the browser.", "");
  const bySc = new Map();
  for (const f of findings) for (const s of f.sc) bySc.set(s, (bySc.get(s) || 0) + 1);
  lines.push("| WCAG criterion | Level | Results |", "|---|---|---|");
  for (const [s, n] of [...bySc].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
    const c = criterion(s);
    lines.push(`| [${s} ${c.title}](${c.url}) | ${c.level} | ${n} |`);
  }
  if (newOnes.length) {
    lines.push("", "### New since baseline", "", "| | Rule | WCAG | Location | Message |", "|---|---|---|---|---|");
    for (const f of newOnes.slice(0, 100)) {
      lines.push(`| ${f.confidence === "violation" ? "violation" : "lead"} | \`${f.rule}\` | ${f.sc.join(", ")} | \`${f.file}:${f.line}\` | ${mdEscape(f.message)} |`);
    }
    if (newOnes.length > 100) lines.push("", `...and ${newOnes.length - 100} more in static.json.`);
  }
  return lines.join("\n") + "\n";
}

async function main() {
  const appKeys = args.app ? [args.app] : Object.keys(config.apps);
  let findings = [];
  for (const key of appKeys) {
    const app = config.apps[key];
    const raw = [...(await runEslint(app)), ...runCustomChecks(app, config)].filter((r) => !isIgnored(r.file));
    findings.push(...raw.map((r) => enrich(r, key)));
  }
  findings.push(...runTranslationChecks(config).map((r) => enrich(r, "i18n")));
  findings = findings.filter((f) => f.rule === "parse-error" || f.sc.length);
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
  fingerprint(findings);

  const baseline = fs.existsSync(baselinePath) ? new Set(readJson(baselinePath).fingerprints) : null;
  for (const f of findings) f.inBaseline = baseline ? baseline.has(f.fingerprint) : false;
  const newOnes = baseline ? findings.filter((f) => !f.inBaseline) : findings;

  writeJson(path.join(outDir, "static.json"), { generatedAt: new Date().toISOString(), apps: appKeys, findings });
  writeJson(path.join(outDir, "static.sarif"), toSarif(findings.filter((f) => f.rule !== "parse-error")));
  const md = toMarkdown(findings, newOnes, appKeys);
  fs.writeFileSync(path.join(outDir, "static.md"), md);
  appendStepSummary(md);
  console.log(md);

  if (args["update-baseline"]) {
    writeJson(baselinePath, { updatedAt: new Date().toISOString(), note: "Accepted static findings. Regenerate with: npm run static -- --update-baseline", fingerprints: findings.map((f) => f.fingerprint) });
    console.log(`Baseline written with ${findings.length} fingerprints.`);
    return;
  }
  const parseErrors = findings.filter((f) => f.rule === "parse-error");
  if (parseErrors.length) {
    console.error(`${parseErrors.length} files failed to parse; fix the scanner config.`);
    process.exit(2);
  }
  if (failOn === "new" && baseline && newOnes.length) process.exit(1);
  if (failOn === "violation" && findings.some((f) => f.confidence === "violation")) process.exit(1);
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
}
