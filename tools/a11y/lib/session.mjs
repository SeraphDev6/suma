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
 * What the agent did on each page, from the transcript, keyed by page path (mount path removed,
 * e.g. "/funding"). Each browser (signed-in and signed-out server) has its own current page,
 * viewport and media settings. A tool result's "Page URL" line, or a navigation's URL, sets the
 * current page; key presses and probe calls carry no URL and belong to the current page.
 *
 *   { "/funding": { tabs, snapshots, widths: [1280, 320], reducedMotion, textSpacing } }
 */
export function pageEvidence(text, mountPath = "/app") {
  const pages = {};
  const state = {};
  const toPath = (url) => {
    try {
      let p = new URL(url).pathname;
      if (mountPath && p.startsWith(mountPath)) p = p.slice(mountPath.length) || "/";
      return p.length > 1 ? p.replace(/\/$/, "") : p;
    } catch {
      return null;
    }
  };
  const page = (path) => (pages[path] ||= { tabs: 0, snapshots: 0, widths: [], reducedMotion: false, textSpacing: false });
  const visit = (st) => {
    if (!st.path) return;
    const pg = page(st.path);
    if (!pg.widths.includes(st.width)) pg.widths.push(st.width);
    if (st.reducedMotion) pg.reducedMotion = true;
  };
  for (const block of text.split(/^(?=### `)/m)) {
    const m = /^### `(playwright(?:-[a-z]+)?)-(browser_[a-z_]+)`/.exec(block);
    if (!m) continue;
    const [, server, tool] = m;
    const st = (state[server] ||= { path: null, width: 1280, reducedMotion: false });
    const urls = [...block.matchAll(/Page URL: (\S+)/g)].map((u) => u[1]);
    const navUrl = tool === "browser_navigate" ? /"url":\s*"([^"]+)"/.exec(block)?.[1] : null;
    const next = urls.at(-1) || navUrl;
    if (next) {
      const path = toPath(next);
      if (path && path !== st.path) {
        st.path = path;
        visit(st);
      }
    }
    if (!st.path) continue;
    const pg = page(st.path);
    if (tool === "browser_resize") {
      const w = Number(/"width":\s*(\d+)/.exec(block)?.[1]);
      if (w) {
        st.width = w;
        visit(st);
      }
    } else if (tool === "browser_emulate_media") {
      const rm = /"reducedMotion":\s*"([^"]+)"/.exec(block)?.[1];
      if (rm) st.reducedMotion = rm === "reduce";
      visit(st);
    } else if (tool === "browser_press_key") {
      const key = /"key":\s*"([^"]+)"/.exec(block)?.[1];
      if (key === "Tab" || key === "Shift+Tab") pg.tabs++;
    } else if (tool === "browser_snapshot") {
      pg.snapshots++;
    } else if (tool === "browser_evaluate" && /textSpacing\((true)?\)/.test(block.split("</details>")[0])) {
      pg.textSpacing = true;
    }
  }
  return pages;
}

/** Tab and Shift+Tab presses per page path. */
export function keyPressesByPath(text, mountPath = "/app") {
  return Object.fromEntries(Object.entries(pageEvidence(text, mountPath)).filter(([, e]) => e.tabs).map(([p, e]) => [p, e.tabs]));
}

/** Criteria whose pass needs a full keyboard pass over the page. */
export const KEYBOARD_SC = ["2.1.1", "2.1.2", "2.4.3", "2.4.7", "2.4.11", "2.4.12", "2.4.13"];

/**
 * Criteria a pass needs session-log proof for, on each page it names. A needsHuman entry for one of
 * these must give a blocker: they are tests the agent can run, not judgement calls.
 */
export const PROCEDURAL = {
  ...Object.fromEntries(KEYBOARD_SC.map((sc) => [sc, "a full keyboard pass (Tab presses at least equal to the page's Tab stops, up to 40)"])),
  "1.4.10": "a resize to 320px wide on the page",
  "1.4.4": "a resize to about 640px wide (200% zoom) on the page",
  "1.4.12": "a textSpacing() probe call on the page",
  "2.3.3": "reduced motion emulated while on the page",
  "4.1.2": "an accessibility snapshot of the page",
  "1.3.1": "an accessibility snapshot of the page",
};

export const BLOCKERS = ["unreachable", "irreversible", "ambiguous", "tool-limit"];

/** Does the session log show the work a pass on this criterion and page needs? */
export function hasEvidence(sc, ev, { tabbables, cap = 40, fallback = 10 } = {}) {
  if (!ev) return false;
  if (KEYBOARD_SC.includes(sc)) return ev.tabs >= Math.min(tabbables ?? fallback, cap);
  if (sc === "1.4.10") return ev.widths.some((w) => w <= 320);
  if (sc === "1.4.4") return ev.widths.some((w) => w >= 560 && w <= 720);
  if (sc === "1.4.12") return ev.textSpacing;
  if (sc === "2.3.3") return ev.reducedMotion;
  if (sc === "4.1.2" || sc === "1.3.1") return ev.snapshots > 0;
  return true;
}

/**
 * Move passes on procedural criteria to needsHuman for pages where the session log does not show
 * the work they need. Returns the remaining passes and the moved entries.
 */
export function enforceCoverage(report, { evidence, tabbables = {} }) {
  const routeRe = (r) => new RegExp("^" + (r === "/" ? "/" : r.replace(/:[^/]+/g, "[^/]+").replace(/\/$/, "")) + "$");
  const merged = (route) => {
    const hits = Object.entries(evidence).filter(([p]) => routeRe(route).test(p)).map(([, e]) => e);
    if (!hits.length) return null;
    return {
      tabs: hits.reduce((n, e) => n + e.tabs, 0),
      snapshots: hits.reduce((n, e) => n + e.snapshots, 0),
      widths: hits.flatMap((e) => e.widths),
      reducedMotion: hits.some((e) => e.reducedMotion),
      textSpacing: hits.some((e) => e.textSpacing),
    };
  };
  const passes = [];
  const moved = [];
  for (const p of report.passes || []) {
    if (!PROCEDURAL[p.sc]) {
      passes.push(p);
      continue;
    }
    const routes = Array.isArray(p.route) ? p.route : [p.route];
    const keep = [];
    for (const r of routes) {
      const ev = merged(r);
      if (hasEvidence(p.sc, ev, { tabbables: tabbables[r] })) keep.push(r);
      else {
        const detail = KEYBOARD_SC.includes(p.sc) ? ` (${ev?.tabs ?? 0} Tab presses on a page with ${tabbables[r] ?? "an unknown number of"} Tab stops)` : "";
        moved.push({ sc: p.sc, app: p.app, route: r, blocker: "unverified", downgraded: true, reason: `Recorded as a pass, but the session log does not show ${PROCEDURAL[p.sc]}${detail}. Not verified.` });
      }
    }
    if (keep.length) passes.push({ ...p, route: Array.isArray(p.route) ? keep : keep[0] });
  }
  return { passes, moved };
}

/** Back-compat wrapper for keyboard-only coverage. */
export function enforceKeyboardCoverage(report, { keys, tabbables }) {
  const evidence = Object.fromEntries(Object.entries(keys).map(([p, tabs]) => [p, { tabs, snapshots: 0, widths: [], reducedMotion: false, textSpacing: false }]));
  const kb = { ...report, passes: (report.passes || []).filter((p) => KEYBOARD_SC.includes(p.sc)) };
  const res = enforceCoverage(kb, { evidence, tabbables });
  return { passes: [...res.passes, ...(report.passes || []).filter((p) => !KEYBOARD_SC.includes(p.sc))], moved: res.moved };
}
