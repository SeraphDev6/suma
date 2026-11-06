import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, walk } from "./common.mjs";

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function lineText(text, line) {
  return text.split("\n")[line - 1] || "";
}

function hit(rule, file, text, index, extra = {}) {
  const line = lineOf(text, index);
  return { rule, file, line, column: index - text.lastIndexOf("\n", index - 1), snippet: lineText(text, line).trim(), ...extra };
}

/** Is there a stylesheet rule that turns animation off for prefers-reduced-motion everywhere? */
function hasGlobalReducedMotion(styleFiles) {
  for (const f of styleFiles) {
    const t = fs.readFileSync(path.join(REPO_ROOT, f), "utf8");
    const m = t.match(/@media[^{]*prefers-reduced-motion\s*:\s*reduce[^{]*\{([\s\S]*?)\n\}/);
    if (m && /(^|[\s,{])\*(\s|,|::?before|::?after|\{)/.test(m[1]) && /(animation|transition)[\w-]*\s*:/.test(m[1])) return f;
  }
  return null;
}

/**
 * Pattern checks that ESLint cannot do: stylesheets, HTML shells, the PWA manifest, JSX
 * patterns that need a live confirmation, and translation coverage.
 */
export function runCustomChecks(app, config) {
  const out = [];
  const jsFiles = walk(app.srcDir, [".js", ".jsx"]);
  const styleFiles = walk(app.srcDir, [".scss", ".css"]);

  for (const f of jsFiles) {
    const text = fs.readFileSync(path.join(REPO_ROOT, f), "utf8");
    for (const m of text.matchAll(/target=\{?["']_blank["']\}?/g)) out.push(hit("suma/new-window-unannounced", f, text, m.index));
    for (const m of text.matchAll(/\bon(MouseDown|PointerDown|TouchStart)=\{/g)) out.push(hit("suma/pointer-down-activation", f, text, m.index));
    for (const m of text.matchAll(/\b(autohide(?!=\{\s*false\s*\})(?=[\s>=/])|autoHideDuration=\{\s*\d+|autoClose=\{\s*\d+)/g)) out.push(hit("suma/auto-dismiss-timer", f, text, m.index));
  }

  const globalRM = hasGlobalReducedMotion(styleFiles);
  for (const f of styleFiles) {
    const text = fs.readFileSync(path.join(REPO_ROOT, f), "utf8");
    for (const m of text.matchAll(/\boutline(?:-style)?\s*:\s*(none|0)\b/g)) {
      // Removing the outline only on :focus:not(:focus-visible) is the recommended pattern.
      const before = text.slice(Math.max(0, m.index - 300), m.index);
      const selector = before.slice(before.lastIndexOf("}") + 1);
      if (/:not\(\s*:focus-visible\s*\)/.test(selector)) continue;
      out.push(hit("suma/outline-removed", f, text, m.index));
    }
    if (!globalRM && !/prefers-reduced-motion/.test(text)) {
      for (const m of text.matchAll(/(^|[\s;{])(animation(?:-name)?|transition)\s*:\s*(?!none\b)[^;]+;/gm)) {
        out.push(hit("suma/motion-without-reduced-motion", f, text, m.index + m[1].length));
      }
    }
  }

  for (const f of app.htmlFiles || []) {
    const abs = path.join(REPO_ROOT, f);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, "utf8");
    const html = text.match(/<html\b[^>]*>/i);
    if (html && !/\blang\s*=\s*["'][^"']+["']/i.test(html[0])) out.push(hit("suma/html-lang-missing", f, text, html.index));
    const vp = text.match(/<meta[^>]+name=["']viewport["'][^>]*>/i);
    if (vp) {
      const c = vp[0];
      const max = c.match(/maximum-scale\s*=\s*([\d.]+)/i);
      if (/user-scalable\s*=\s*(no|0)/i.test(c) || (max && parseFloat(max[1]) < 2)) out.push(hit("suma/viewport-zoom-blocked", f, text, vp.index));
    }
  }

  if (app.manifest && fs.existsSync(path.join(REPO_ROOT, app.manifest))) {
    const text = fs.readFileSync(path.join(REPO_ROOT, app.manifest), "utf8");
    const m = text.match(/"orientation"\s*:\s*"(portrait[\w-]*|landscape[\w-]*)"/);
    if (m) out.push(hit("suma/orientation-locked", app.manifest, text, m.index));
  }

  return out;
}

/** UI strings present in the primary locale but missing from another locale. */
export function runTranslationChecks(config) {
  const out = [];
  const { seedDir, primaryLocale, locales, files } = config.i18n;
  for (const file of files) {
    const primaryPath = path.join(seedDir, primaryLocale, file);
    const abs = path.join(REPO_ROOT, primaryPath);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, "utf8");
    const primary = JSON.parse(text);
    for (const loc of locales.filter((l) => l !== primaryLocale)) {
      const otherAbs = path.join(REPO_ROOT, seedDir, loc, file);
      // A locale may keep all strings in one file; only check when the locale has this file.
      if (!fs.existsSync(otherAbs)) continue;
      const other = JSON.parse(fs.readFileSync(otherAbs, "utf8"));
      for (const key of Object.keys(primary)) {
        if (other[key] === undefined || other[key] === "") {
          const idx = text.indexOf(JSON.stringify(key));
          out.push({ ...hit("suma/untranslated-string", primaryPath, text, Math.max(0, idx)), detail: `missing in ${loc}`, key });
        }
      }
    }
  }
  return out;
}
