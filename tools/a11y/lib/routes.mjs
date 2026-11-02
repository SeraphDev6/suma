import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./common.mjs";
import { resolveImport } from "./graph.mjs";

/** Map of local identifier -> import specifier for every import in a module. */
export function parseImportBindings(text) {
  const bindings = new Map();
  const re = /\bimport\s+([^'";]+?)\s+from\s*['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(re)) {
    const clause = m[1].trim();
    const spec = m[2];
    const named = clause.match(/\{([^}]*)\}/);
    const def = clause.replace(/\{[^}]*\}/, "").replace(/,/g, " ").trim();
    if (def && !def.startsWith("*")) bindings.set(def.split(/\s+/)[0], spec);
    const ns = clause.match(/\*\s+as\s+([\w$]+)/);
    if (ns) bindings.set(ns[1], spec);
    if (named) {
      for (const part of named[1].split(",")) {
        const p = part.trim();
        if (!p) continue;
        const local = p.split(/\s+as\s+/).pop().trim();
        bindings.set(local, spec);
      }
    }
  }
  return bindings;
}

/** Find the end of a JSX opening tag starting at `start` ("<Route"), respecting braces and strings. */
function scanTag(text, start) {
  let depth = 0;
  let quote = null;
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (depth === 0 && ch === ">") return i + 1;
  }
  return text.length;
}

function attrExpression(tag, name) {
  const idx = tag.search(new RegExp(`\\b${name}=\\{`));
  if (idx < 0) return null;
  let i = tag.indexOf("{", idx);
  const begin = i + 1;
  let depth = 0;
  for (; i < tag.length; i++) {
    if (tag[i] === "{") depth++;
    else if (tag[i] === "}" && --depth === 0) return tag.slice(begin, i);
  }
  return null;
}

/**
 * Parse <Route path=... element={...}> declarations from a routes file.
 * Each route gets: path, needsAuth, identifiers used in its element, and the files they resolve to.
 */
export function parseRoutes(routesFile) {
  const text = fs.readFileSync(path.join(REPO_ROOT, routesFile), "utf8");
  const bindings = parseImportBindings(text);
  const routes = [];
  const routeIdentifierFiles = new Set();
  let idx = 0;
  while ((idx = text.indexOf("<Route", idx)) >= 0) {
    if (!/\s/.test(text[idx + 6])) {
      idx += 6;
      continue;
    }
    const end = scanTag(text, idx);
    const tag = text.slice(idx, end);
    const line = text.slice(0, idx).split("\n").length;
    const endLine = text.slice(0, end).split("\n").length;
    idx = end;
    const pathMatch = tag.match(/\bpath=(?:"([^"]+)"|\{["'`]([^"'`]+)["'`]\})/);
    if (!pathMatch) continue;
    const routePath = pathMatch[1] || pathMatch[2];
    const element = attrExpression(tag, "element") || "";
    if (!element || element.trim() === "null") continue;
    const ids = [...new Set(element.match(/\b[A-Za-z_$][\w$]*\b/g) || [])].filter((id) => bindings.has(id));
    const files = [];
    for (const id of ids) {
      const f = resolveImport(routesFile, bindings.get(id));
      if (f) {
        files.push({ id, file: f });
        routeIdentifierFiles.add(f);
      }
    }
    const titleKey = (element.match(/title:\s*t\(\s*["']([^"']+)["']/) || [])[1] || null;
    routes.push({
      path: routePath,
      line,
      endLine,
      needsAuth: /\bredirectIfUnauthed\b/.test(element),
      hasParams: routePath.includes(":"),
      titleKey,
      elementSource: element,
      identifiers: files,
    });
  }
  // Lines of the routes file that are only imports; changes there show up through the imported files.
  const importLines = new Set();
  text.split("\n").forEach((l, i) => {
    if (/^\s*import\b/.test(l) || /^\s*[\w$,{}\s]*\}?\s*from\s*["']/.test(l)) importLines.add(i + 1);
  });
  return { routes, routeIdentifierFiles, bindings, importLines, lineCount: text.split("\n").length };
}
