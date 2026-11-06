#!/usr/bin/env node
/**
 * Phase 2, step 1: trace which pages a diff can affect.
 *
 * changed file -> import graph (walked upward) -> the route elements in App.jsx that use it.
 * Changed UI string keys are traced to the files that use them, then the same way.
 * A change reached only through a provider or global stylesheet affects every route; the
 * routes to test are then capped and prioritised, and the rest are listed as not tested.
 *
 *   node impact.mjs --base origin/main [--head HEAD] [--static a11y-report/static.json]
 *
 * Without --head, the working tree (including untracked files) is compared with the merge base.
 * Writes <reportDir>/impact.json and impact.md.
 */
import fs from "node:fs";
import path from "node:path";
import { appendStepSummary, criterion, git, loadConfig, parseArgs, readJson, REPO_ROOT, reportDir, writeJson } from "./lib/common.mjs";
import { buildGraph, chainTo, walkUp } from "./lib/graph.mjs";
import { parseRoutes } from "./lib/routes.mjs";

const args = parseArgs();
const config = loadConfig();
const outDir = reportDir(config);
const base = args.base || process.env.A11Y_BASE || "origin/main";
const head = args.head || null;

function changedFiles() {
  const mergeBase = git(["merge-base", base, head || "HEAD"]).trim();
  const files = head
    ? git(["diff", "--name-only", "--diff-filter=ACMRD", `${mergeBase}...${head}`]).split("\n")
    : [...git(["diff", "--name-only", "--diff-filter=ACMRD", mergeBase]).split("\n"), ...git(["ls-files", "--others", "--exclude-standard"]).split("\n")];
  return { mergeBase, files: [...new Set(files.filter(Boolean))].sort() };
}

/** Changed line numbers (new side) per file, from a zero-context diff. */
function changedLines(mergeBase) {
  const diff = head ? git(["diff", "-U0", `${mergeBase}...${head}`]) : git(["diff", "-U0", mergeBase]);
  const out = new Map();
  let file = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line.startsWith("+++ b/") ? line.slice(6) : null;
      if (file) out.set(file, new Set());
    } else if (file && line.startsWith("@@")) {
      const m = line.match(/\+(\d+)(?:,(\d+))?/);
      const start = +m[1];
      const count = m[2] === undefined ? 1 : +m[2];
      for (let i = 0; i < count; i++) out.get(file).add(start + i);
    }
  }
  return out;
}

function readAt(ref, file) {
  try {
    return git(["show", `${ref}:${file}`], { stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** Keys whose value was added, changed or removed between the merge base and the head. */
function changedStringKeys(mergeBase, files) {
  const out = [];
  const { seedDir, files: seedFiles } = config.i18n;
  for (const f of files) {
    const m = f.match(new RegExp(`^${seedDir}/([^/]+)/(.+)$`));
    if (!m || !seedFiles.includes(m[2])) continue;
    const before = JSON.parse(readAt(mergeBase, f) || "{}");
    const afterText = head ? readAt(head, f) : fs.existsSync(path.join(REPO_ROOT, f)) ? fs.readFileSync(path.join(REPO_ROOT, f), "utf8") : null;
    const after = JSON.parse(afterText || "{}");
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (before[k] !== after[k]) out.push({ key: k, locale: m[1], change: before[k] === undefined ? "added" : after[k] === undefined ? "removed" : "changed", file: f });
    }
  }
  return out;
}

function filesUsingKey(graph, key) {
  const needles = [`"${key}"`, `'${key}'`, `\`${key}\``];
  return graph.files.filter((f) => /\.(m?jsx?|tsx?)$/.test(f) && needles.some((n) => fs.readFileSync(path.join(REPO_ROOT, f), "utf8").includes(n)));
}

function main() {
  const { mergeBase, files } = changedFiles();
  const lines = changedLines(mergeBase);
  const ignore = config.impact.ignorePatterns.map((p) => new RegExp(p));
  const globalRes = config.impact.globalPatterns.map((p) => new RegExp(p));
  const relevant = files.filter((f) => !ignore.some((re) => re.test(f)));
  const stringKeys = changedStringKeys(mergeBase, relevant);
  const untraced = [];
  const result = { base, head: head || "WORKTREE", mergeBase, generatedAt: new Date().toISOString(), changedFiles: relevant, stringKeys, apps: {}, untraced, leads: [] };

  const claimed = new Set();
  for (const [appKey, app] of Object.entries(config.apps)) {
    const graph = buildGraph(app.srcDir);
    const { routes, importLines } = parseRoutes(app.routesFile);
    const routeFiles = new Set(routes.flatMap((r) => r.identifiers.map((i) => i.file)));
    const entry = new Set(app.entryFiles);

    // Seeds: changed files in this app, plus files that use a changed string key.
    const seeds = [];
    for (const f of relevant) {
      if (f.startsWith(app.srcDir + "/") || (app.htmlFiles || []).includes(f) || app.manifest === f) {
        seeds.push({ file: f, reason: `changed ${f}` });
        claimed.add(f);
      }
    }
    for (const k of stringKeys) {
      const users = filesUsingKey(graph, k.key);
      for (const u of users) seeds.push({ file: u, reason: `string ${k.key} ${k.change} (${k.locale})`, locale: k.locale, key: k.key });
      if (users.length) claimed.add(k.file);
    }

    const hits = new Map(); // route path -> {route, reasons[], locales Set}
    const globalReasons = [];
    const touch = (route, reason, locale) => {
      if (!hits.has(route.path)) hits.set(route.path, { route, reasons: [], locales: new Set() });
      const h = hits.get(route.path);
      const key = reason.why.replace(/:\d+\)$/, ")");
      if (h.reasons.length < 5 && !h.reasons.some((r) => r.why.replace(/:\d+\)$/, ")") === key)) h.reasons.push(reason);
      h.locales.add(locale || config.i18n.primaryLocale);
    };

    for (const seed of seeds) {
      if (globalRes.some((re) => re.test(seed.file)) && !seed.key) {
        globalReasons.push(`${seed.reason} (global file)`);
        continue;
      }
      if (seed.file === app.routesFile && !seed.key) {
        // Map changed lines of the routes file to the <Route> blocks that contain them.
        // Changed lines outside any route (providers, wrappers) make the change global.
        const changed = [...(lines.get(seed.file) || [])];
        const outside = [];
        for (const ln of changed) {
          const r = routes.find((x) => ln >= x.line && ln <= x.endLine);
          if (r) touch(r, { why: `route declaration changed (${app.routesFile}:${ln})`, chain: [app.routesFile] });
          else if (!importLines.has(ln) && (lines.get(seed.file)?.size ?? 0) > 0) outside.push(ln);
        }
        const meaningful = outside.filter((ln) => /\S/.test(fs.readFileSync(path.join(REPO_ROOT, seed.file), "utf8").split("\n")[ln - 1] || ""));
        if (meaningful.length) globalReasons.push(`${app.routesFile} changed outside route declarations (lines ${meaningful.slice(0, 5).join(", ")})`);
        continue;
      }
      if (seed.file === app.routesFile && seed.key) {
        // The key is used inside a route declaration (page title): only that route.
        for (const r of routes) if (r.elementSource.includes(seed.key)) touch(r, { why: seed.reason, chain: [app.routesFile] }, seed.locale);
        continue;
      }
      const parent = walkUp(graph, seed.file, routeFiles);
      let reachedRoute = false;
      for (const r of routes) {
        const via = r.identifiers.find((i) => parent.has(i.file));
        if (via) {
          reachedRoute = true;
          touch(r, { why: seed.reason, chain: chainTo(parent, via.file).reverse() }, seed.locale);
        }
      }
      // Reaching an entry file through something that is not a route element (a provider,
      // a global stylesheet) means every page is affected.
      for (const e of entry) {
        if (!parent.has(e) || e === seed.file) continue;
        const chain = chainTo(parent, e); // seed ... entry
        if (!chain.slice(0, -1).some((f) => routeFiles.has(f))) globalReasons.push(`${seed.reason} -> ${chain.join(" -> ")}`);
      }
      if (!reachedRoute && !globalReasons.length && !graph.reverse.get(seed.file)?.size && !entry.has(seed.file)) {
        untraced.push({ file: seed.file, reason: "No route imports this file (unused, or imported dynamically)." });
      }
    }

    const skip = new Set(app.skipRoutes);
    const isGlobal = globalReasons.length > 0;
    let candidates = [...hits.values()].filter((h) => !skip.has(h.route.path));
    if (isGlobal) {
      for (const p of app.globalSample) {
        const r = routes.find((x) => x.path === p);
        if (r) touch(r, { why: "global change: representative page", chain: [] });
      }
      candidates = [...hits.values()].filter((h) => !skip.has(h.route.path));
    }
    // Rank: the route's own page or declaration changed, then the representative sample, then
    // shorter import chains; plain routes before parameter routes.
    const sample = new Set(app.globalSample);
    // chain is [route element file, ..., changed file]. "Direct" means this route's own page
    // component (the last renderWithHocs argument) or its declaration changed, not a shared HOC.
    const direct = (h) => h.reasons.some((x) => x.chain.length === 1 && (x.chain[0] === app.routesFile || x.chain[0] === h.route.identifiers.at(-1)?.file));
    const rank = (h) => (direct(h) ? 0 : sample.has(h.route.path) ? 1 : 2);
    const hops = (h) => Math.min(...h.reasons.map((x) => x.chain.length || 99));
    candidates.sort((a, b) => rank(a) - rank(b) || hops(a) - hops(b) || a.route.hasParams - b.route.hasParams || a.route.line - b.route.line);
    const cap = config.impact.maxRoutesPerApp;
    const toTest = candidates.slice(0, cap);
    const notTested = isGlobal
      ? routes.filter((r) => !skip.has(r.path) && !toTest.some((h) => h.route.path === r.path)).map((r) => r.path)
      : candidates.slice(cap).map((h) => h.route.path);

    const hint = (p) => app.paramRouteHints[p] || (p.includes(":") ? app.paramRouteHints["*"] : undefined);
    result.apps[appKey] = {
      label: app.label,
      auth: app.auth,
      mountPath: app.mountPath,
      global: isGlobal,
      wide: candidates.length > config.impact.maxRoutesPerApp,
      globalReasons: [...new Set(globalReasons)].slice(0, 10),
      routes: toTest.map((h) => ({
        app: appKey,
        path: h.route.path,
        url: h.route.hasParams ? null : `${config.baseUrl}${app.mountPath}${h.route.path === "/" ? "/" : h.route.path}`,
        needsAuth: h.route.needsAuth,
        hasParams: h.route.hasParams,
        howToReach: hint(h.route.path),
        locales: [...h.locales],
        reasons: h.reasons,
      })),
      notTested,
    };
  }

  for (const f of relevant) {
    if (claimed.has(f)) continue;
    if (/^(lib|app|config|db)\//.test(f)) untraced.push({ file: f, reason: "Backend change. Not traced to pages; data or API responses shown on any page may differ." });
  }

  // Static leads in changed files, flagged when they sit on a changed line.
  const staticPath = path.resolve(REPO_ROOT, args.static || path.join(outDir, "static.json"));
  if (fs.existsSync(staticPath)) {
    const st = readJson(staticPath);
    const changedSet = new Set(relevant);
    for (const f of st.findings) {
      if (!changedSet.has(f.file)) continue;
      result.leads.push({ id: f.id, source: "static", rule: f.rule, sc: f.sc, confidence: f.confidence, file: f.file, line: f.line, message: f.message, snippet: f.snippet, onChangedLine: !!lines.get(f.file)?.has(f.line) });
    }
  }

  writeJson(path.join(outDir, "impact.json"), result);
  const md = toMarkdown(result);
  fs.writeFileSync(path.join(outDir, "impact.md"), md);
  appendStepSummary(md);
  console.log(md);
}

function toMarkdown(r) {
  const out = ["## Accessibility phase 2: traced impact", "", `Diff: \`${r.mergeBase.slice(0, 10)}...${r.head}\`, ${r.changedFiles.length} relevant changed files, ${r.stringKeys.length} changed string keys.`, ""];
  for (const [k, a] of Object.entries(r.apps)) {
    if (!a.routes.length && !a.global) continue;
    out.push(`### ${a.label}${a.global ? " (global change)" : a.wide ? " (wide change, top routes by priority)" : ""}`, "");
    if (a.global) out.push("Global because: " + a.globalReasons.slice(0, 3).map((x) => `\`${x}\``).join("; "), "");
    out.push("| Route | Why it is in scope | Locales |", "|---|---|---|");
    for (const rt of a.routes) out.push(`| \`${rt.path}\` | ${rt.reasons.map((x) => x.why + (x.chain.length > 1 ? ` via \`${x.chain[0]}\`` : "")).slice(0, 2).join("; ")} | ${rt.locales.join(", ")} |`);
    if (a.notTested.length) out.push("", `Not tested in this run (${a.notTested.length}): ${a.notTested.map((p) => `\`${p}\``).join(", ")}`);
    out.push("");
  }
  if (r.untraced.length) out.push("### Not traced", "", ...r.untraced.map((u) => `- \`${u.file}\`: ${u.reason}`), "");
  if (r.leads.length) {
    out.push(`### Static leads in changed files (${r.leads.length}, ${r.leads.filter((l) => l.onChangedLine).length} on changed lines)`, "");
    for (const l of r.leads.slice(0, 40)) out.push(`- ${l.id} \`${l.file}:${l.line}\` ${l.rule} (WCAG ${l.sc.map((s) => `${s} ${criterion(s)?.title}`).join(", ")})${l.onChangedLine ? " **changed line**" : ""}`);
  }
  if (!Object.values(r.apps).some((a) => a.routes.length)) out.push("No frontend pages are affected by this diff.");
  return out.join("\n") + "\n";
}

main();
