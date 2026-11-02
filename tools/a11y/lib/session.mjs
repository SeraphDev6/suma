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
