/**
 * Check the agent's shared session transcript (`copilot --share`) for how it drove the browser.
 * The report only counts as a live test when the agent operated pages step by step through the
 * Playwright MCP tools: keys pressed one at a time, accessibility snapshots read, no scripted runs.
 */
const CALL = /^### `(playwright(?:-anon)?)-(browser_[a-z_]+)`/gm;
const SCRIPTED = /chromium\.launch|require\(['"]playwright|from ['"]playwright|puppeteer|selenium-webdriver|axe-sweep\.mjs/;

export function checkSession(text, { routesTested = 0 } = {}) {
  const counts = {};
  for (const m of text.matchAll(CALL)) counts[m[2]] = (counts[m[2]] || 0) + 1;
  const n = (t) => counts[t] || 0;
  const errors = [];
  if (n("browser_run_code_unsafe")) errors.push(`the agent ran Playwright scripts through browser_run_code_unsafe ${n("browser_run_code_unsafe")} times instead of operating the pages`);
  // Bash calls show as "### `bash`" followed by the command; look only at those commands.
  const shell = [...text.matchAll(/^### `bash`[^\n]*\n[\s\S]*?^\$ (.*)$/gm)].map((m) => m[1]);
  if (shell.some((c) => SCRIPTED.test(c))) errors.push("the agent drove a browser from the shell instead of through Playwright MCP");
  if (routesTested > 0) {
    if (!n("browser_press_key")) errors.push("no keyboard testing: browser_press_key was never called");
    if (!n("browser_snapshot")) errors.push("no accessibility tree checks: browser_snapshot was never called");
    if (!n("browser_navigate")) errors.push("browser_navigate was never called");
  }
  return { counts, errors };
}

/**
 * Tab and Shift+Tab presses per page path (mount path removed, e.g. "/funding"). Key presses do not
 * record their page, so each is attributed to the most recent page URL seen in the same browser
 * (the signed-in and signed-out servers each have their own page), from a navigation's arguments or
 * any tool result's "Page URL" line.
 */
export function keyPressesByPath(text, mountPath = "/app") {
  const counts = {};
  const current = {};
  const toPath = (url) => {
    try {
      let p = new URL(url).pathname;
      if (mountPath && p.startsWith(mountPath)) p = p.slice(mountPath.length) || "/";
      return p.length > 1 ? p.replace(/\/$/, "") : p;
    } catch {
      return null;
    }
  };
  for (const block of text.split(/^(?=### `)/m)) {
    const m = /^### `(playwright(?:-[a-z]+)?)-(browser_[a-z_]+)`/.exec(block);
    if (!m) continue;
    const [, server, tool] = m;
    if (tool === "browser_navigate") {
      const url = /"url":\s*"([^"]+)"/.exec(block)?.[1];
      if (url) current[server] = toPath(url) ?? current[server];
    }
    if (tool === "browser_press_key" && current[server]) {
      const key = /"key":\s*"([^"]+)"/.exec(block)?.[1];
      if (key === "Tab" || key === "Shift+Tab") counts[current[server]] = (counts[current[server]] || 0) + 1;
    }
    const pages = [...block.matchAll(/Page URL: (\S+)/g)];
    if (pages.length) current[server] = toPath(pages.at(-1)[1]) ?? current[server];
  }
  return counts;
}

/** Criteria whose pass needs a full keyboard pass over the page. */
export const KEYBOARD_SC = ["2.1.1", "2.1.2", "2.4.3", "2.4.7", "2.4.11", "2.4.12", "2.4.13"];

/**
 * Move keyboard passes to needsHuman for pages where the agent pressed Tab fewer times than the
 * page has focusable elements (from the axe sweep; capped, default when unknown).
 */
export function enforceKeyboardCoverage(report, { keys, tabbables, cap = 40, fallback = 10 }) {
  const routeRe = (r) => new RegExp("^" + r.replace(/:[^/]+/g, "[^/]+").replace(/\/$/, "") + "$");
  const pressesOn = (route) => Object.entries(keys).filter(([p]) => routeRe(route === "/" ? "/" : route).test(p)).reduce((n, [, c]) => n + c, 0);
  const passes = [];
  const moved = [];
  for (const p of report.passes || []) {
    if (!KEYBOARD_SC.includes(p.sc)) {
      passes.push(p);
      continue;
    }
    const routes = Array.isArray(p.route) ? p.route : [p.route];
    const keep = [];
    for (const r of routes) {
      const needed = Math.min(tabbables[r] ?? fallback, cap);
      const got = pressesOn(r);
      if (got >= needed) keep.push(r);
      else moved.push({ sc: p.sc, app: p.app, route: r, reason: `Recorded as a pass, but the keyboard pass was incomplete: ${got} Tab presses on a page with ${tabbables[r] ?? "an unknown number of"} focusable elements (needs ${needed}). Not verified.` });
    }
    if (keep.length) passes.push({ ...p, route: Array.isArray(p.route) ? keep : keep[0] });
  }
  return { passes, moved };
}
