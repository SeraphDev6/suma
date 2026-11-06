import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, rel, walk } from "./common.mjs";

const SOURCE_EXTS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".scss", ".css", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".json"];
const RESOLVE_EXTS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".scss", ".css", ".json"];

const JS_IMPORT_RES = [
  /\b(?:import|export)\s+[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
];
const SCSS_IMPORT_RE = /@(?:import|use|forward)\s+([^;]+);/g;

/** Parse the specifiers a source file imports. Exported for tests. */
export function parseImports(file, text) {
  const specs = [];
  if (/\.s?css$/.test(file)) {
    for (const m of text.matchAll(SCSS_IMPORT_RE)) {
      for (const q of m[1].matchAll(/['"]([^'"]+)['"]/g)) specs.push(q[1]);
    }
  } else if (/\.(m?jsx?|tsx?)$/.test(file)) {
    for (const re of JS_IMPORT_RES) for (const m of text.matchAll(re)) specs.push(m[1]);
  }
  return [...new Set(specs)];
}

/** Resolve a relative import specifier to a repo-relative file, or null for packages/unresolvable. */
export function resolveImport(fromFile, spec) {
  const clean = spec.split("?")[0];
  if (!clean.startsWith(".")) return null;
  const base = path.resolve(REPO_ROOT, path.dirname(fromFile), clean);
  const candidates = [base];
  for (const e of RESOLVE_EXTS) candidates.push(base + e);
  for (const e of RESOLVE_EXTS) candidates.push(path.join(base, "index" + e));
  if (/\.s?css$/.test(fromFile)) {
    const dir = path.dirname(base);
    const name = path.basename(base);
    for (const e of [".scss", ".css"]) candidates.push(path.join(dir, "_" + name + e));
  }
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return rel(c);
  }
  return null;
}

/**
 * Build forward and reverse import graphs for every file under srcDir.
 * Edges: importer -> imported (forward), imported -> importers (reverse).
 */
export function buildGraph(srcDir) {
  const files = walk(srcDir, SOURCE_EXTS);
  const forward = new Map();
  const reverse = new Map();
  for (const f of files) {
    forward.set(f, new Set());
    if (!reverse.has(f)) reverse.set(f, new Set());
  }
  for (const f of files) {
    if (!/\.(m?jsx?|tsx?|s?css)$/.test(f)) continue;
    const text = fs.readFileSync(path.join(REPO_ROOT, f), "utf8");
    for (const spec of parseImports(f, text)) {
      const target = resolveImport(f, spec);
      if (!target) continue;
      forward.get(f).add(target);
      if (!reverse.has(target)) reverse.set(target, new Set());
      reverse.get(target).add(f);
    }
  }
  return { files, forward, reverse };
}

/**
 * Walk importers upward from `start`. Returns Map(file -> parent file on the shortest path)
 * so a chain back to `start` can be rebuilt. Walking does not continue past files in `stopAt`.
 */
export function walkUp(graph, start, stopAt = new Set()) {
  const parent = new Map([[start, null]]);
  const queue = [start];
  while (queue.length) {
    const f = queue.shift();
    if (f !== start && stopAt.has(f)) continue;
    for (const imp of graph.reverse.get(f) || []) {
      if (parent.has(imp)) continue;
      parent.set(imp, f);
      queue.push(imp);
    }
  }
  return parent;
}

export function chainTo(parent, file) {
  const chain = [];
  for (let f = file; f; f = parent.get(f)) chain.push(f);
  return chain.reverse();
}
