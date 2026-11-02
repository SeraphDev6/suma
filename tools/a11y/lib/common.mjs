import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TOOL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(TOOL_DIR, "../..");

export function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
}

export function loadConfig() {
  return readJson(path.join(TOOL_DIR, "config.json"));
}

export function reportDir(config = loadConfig()) {
  return path.resolve(REPO_ROOT, process.env.A11Y_REPORT_DIR || config.reportDir);
}

let catalogCache;
export function loadCatalog() {
  catalogCache ||= readJson(path.join(TOOL_DIR, "wcag22.json"));
  return catalogCache;
}

/** Full info for one success criterion, or null if it is not a WCAG 2.2 criterion. */
export function criterion(sc) {
  const cat = loadCatalog();
  const c = cat.criteria[sc];
  if (!c) return null;
  return { sc, ...c, url: cat.understandingBase + c.slug + ".html" };
}

export function git(args, opts = {}) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
}

export function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex");
}

export function rel(p) {
  return path.relative(REPO_ROOT, path.resolve(REPO_ROOT, p)).split(path.sep).join("/");
}

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

/** Walk a directory, returning repo-relative paths of files whose extension is in exts. */
export function walk(dir, exts) {
  const abs = path.resolve(REPO_ROOT, dir);
  const out = [];
  if (!fs.existsSync(abs)) return out;
  const stack = [abs];
  while (stack.length) {
    const d = stack.pop();
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (exts.includes(path.extname(ent.name))) out.push(rel(p));
    }
  }
  return out.sort();
}

export function appendStepSummary(md) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
}

export function mdEscape(s) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** True when the module at metaUrl is the script node was started with. */
export function isMain(metaUrl) {
  try {
    return fs.realpathSync(fileURLToPath(metaUrl)) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
