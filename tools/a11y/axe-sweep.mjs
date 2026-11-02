#!/usr/bin/env node
/**
 * Phase 2, step 2: deterministic axe-core sweep of the routes impact.mjs selected.
 *
 * For every plain (no :param) route in impact.json it loads the page with the right session,
 * runs axe-core for WCAG 2.0-2.2 A, AA and AAA rules, records page facts (title, lang, headings,
 * landmarks), and saves a highlighted screenshot of each failing element. Results are LEADS for
 * the agent: axe is reliable, but the agent still confirms user impact and may dismiss a lead
 * with evidence.
 *
 *   node axe-sweep.mjs [--impact a11y-report/impact.json] [--max-nodes 4]
 * Writes <reportDir>/axe.json and screenshots under <reportDir>/screenshots/axe/.
 * Run mcp-setup.mjs first (it creates the signed-in sessions and init script).
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { criterion, isMain, loadConfig, parseArgs, readJson, REPO_ROOT, reportDir, writeJson } from "./lib/common.mjs";

const args = parseArgs();
const config = loadConfig();
const out = reportDir(config);
const maxNodes = Number(args["max-nodes"] || 4);
const TAGS = ["wcag2a", "wcag2aa", "wcag2aaa", "wcag21a", "wcag21aa", "wcag22aa"];

/** axe tag "wcag1411" -> "1.4.11" */
export function tagToSc(tag) {
  const m = tag.match(/^wcag(\d)(\d)(\d+)$/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

const slug = (s) => s.replace(/^\//, "").replace(/[^\w-]+/g, "_") || "root";

export async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  // Suma shows a screen loader while strings and the user load.
  await page.waitForFunction(() => !document.querySelector(".screen-loader-show"), null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(500);
}

/**
 * Buttons that show or hide content must expose that state (aria-expanded) to assistive technology
 * (4.1.2). axe does not check this, so click each candidate on a fresh load of the page and compare
 * what is visible before and after. Content that appears or disappears without navigation or a
 * dialog, on a button with no aria-expanded, becomes a lead the agent must resolve.
 */
export async function disclosureLeads(page, route, appKey, rec, nextId, seen = new Map()) {
  const leads = [];
  const candidates = await page.evaluate(() => window.__a11y.disclosureCandidates()).catch(() => []);
  for (const c of candidates) {
    // Shared page chrome (the main menu) gets one lead, listing the other pages it is on.
    const key = `${c.selector}|${c.name}`;
    if (seen.has(key)) {
      const lead = seen.get(key);
      if (lead && !lead.alsoOn.includes(route.path)) lead.alsoOn.push(route.path);
      continue;
    }
    seen.set(key, null);
    try {
      await page.goto(route.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await settle(page);
      const before = await page.evaluate(() => window.__a11y.visibleCount());
      const startUrl = page.url();
      await page.click(c.selector, { timeout: 3000 });
      await page.waitForTimeout(600);
      if (page.url() !== startUrl) continue;
      const after = await page.evaluate(() => window.__a11y.visibleCount());
      if (after.dialogs > before.dialogs) continue;
      const delta = after.count - before.count;
      const state = await page.evaluate((sel) => { const el = document.querySelector(sel); return el && { expanded: el.getAttribute("aria-expanded"), pressed: el.getAttribute("aria-pressed") }; }, c.selector);
      if (!state || Math.abs(delta) < 3 || c.expanded != null || state.expanded != null || state.pressed != null) continue;
      const id = nextId();
      let screenshot = null;
      try {
        await page.evaluate(([t, label]) => window.__a11y.highlight(t, label), [c.selector, id]);
        screenshot = `screenshots/axe/${id}-${slug(route.path)}-disclosure.png`;
        await page.screenshot({ path: path.join(out, screenshot) });
        await page.evaluate(() => window.__a11y.clearHighlight());
      } catch {
        screenshot = null;
      }
      leads.push({
        id,
        source: "disclosure-check",
        kind: "needs-review",
        rule: "disclosure-state",
        help: `Clicking "${c.name || c.element}" ${delta > 0 ? "showed" : "hid"} ${Math.abs(delta)} elements, but the button has no aria-expanded before or after, so assistive technology cannot tell whether the content is open.`,
        sc: ["4.1.2"],
        app: appKey,
        route: route.path,
        url: rec.finalUrl,
        locale: "en",
        target: [c.selector],
        html: c.element,
        summary: `visible elements ${before.count} -> ${after.count}; aria-expanded ${c.expanded ?? "absent"} -> ${state.expanded ?? "absent"}`,
        screenshot,
        alsoOn: [],
      });
      seen.set(key, leads.at(-1));
    } catch {
      // A candidate that cannot be clicked is not evidence of anything.
    }
  }
  return leads;
}

async function main() {
  const impact = readJson(path.resolve(REPO_ROOT, args.impact || path.join(out, "impact.json")));
  const initScript = path.join(out, ".mcp/init.js");
  if (!fs.existsSync(initScript)) throw new Error("Run mcp-setup.mjs first");
  fs.mkdirSync(path.join(out, "screenshots/axe"), { recursive: true });

  const browser = await chromium.launch();
  const leads = [];
  const pages = [];
  let n = 0;
  let d = 0;
  const seenDisclosures = new Map();
  try {
    for (const [appKey, app] of Object.entries(impact.apps)) {
      for (const route of app.routes) {
        if (route.hasParams || !route.url) {
          pages.push({ app: appKey, path: route.path, skipped: "has parameters; the agent reaches it by navigation", howToReach: route.howToReach });
          continue;
        }
        for (const locale of route.locales) {
          const state = route.needsAuth ? path.join(out, `.auth/${app.auth}.json`) : undefined;
          const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState: state && fs.existsSync(state) ? state : undefined, locale: locale === "es" ? "es-US" : "en-US" });
          await context.addInitScript({ path: initScript });
          const page = await context.newPage();
          const rec = { app: appKey, path: route.path, url: route.url, locale };
          try {
            const resp = await page.goto(route.url, { waitUntil: "domcontentloaded", timeout: 30000 });
            await settle(page);
            if (locale !== "en") {
              // Suma keeps the chosen language in localStorage as JSON (localStorageHelper); set it, then reload.
              await page.evaluate((l) => localStorage.setItem("language", JSON.stringify(l)), locale).catch(() => {});
              await page.reload({ waitUntil: "domcontentloaded" });
              await settle(page);
            }
            rec.status = resp?.status();
            rec.finalUrl = page.url();
            rec.redirected = new URL(rec.finalUrl).pathname !== new URL(route.url).pathname;
            rec.facts = await page.evaluate(() => window.__a11y.structure());
            const res = await page.evaluate((tags) => window.__a11y.axe(document, tags), TAGS);
            rec.axePasses = res.passes;
            for (const kind of ["violations", "incomplete"]) {
              for (const v of res[kind]) {
                const sc = [...new Set(v.tags.map(tagToSc).filter((s) => s && criterion(s)))];
                if (!sc.length) continue;
                for (const node of v.nodes.slice(0, maxNodes)) {
                  const id = `AXE-${String(++n).padStart(3, "0")}`;
                  let screenshot = null;
                  try {
                    const loc = page.locator(node.target).first();
                    await loc.scrollIntoViewIfNeeded({ timeout: 3000 });
                    await page.evaluate(([t, label]) => window.__a11y.highlight(t, label), [node.target, id]);
                    screenshot = `screenshots/axe/${id}-${slug(route.path)}-${v.id}.png`;
                    await page.screenshot({ path: path.join(out, screenshot) });
                    await page.evaluate(() => window.__a11y.clearHighlight());
                  } catch (e) {
                    screenshot = null;
                  }
                  leads.push({
                    id,
                    source: "axe",
                    kind: kind === "violations" ? "violation" : "needs-review",
                    rule: v.id,
                    help: v.help,
                    impact: v.impact,
                    sc,
                    app: appKey,
                    route: route.path,
                    url: rec.finalUrl,
                    locale,
                    target: node.target,
                    html: node.html,
                    summary: node.summary,
                    screenshot,
                  });
                }
              }
            }
            if (locale === "en") leads.push(...(await disclosureLeads(page, route, appKey, rec, () => `DISC-${String(++d).padStart(3, "0")}`, seenDisclosures)));
          } catch (e) {
            rec.error = String(e.message || e).slice(0, 300);
          }
          pages.push(rec);
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  writeJson(path.join(out, "axe.json"), { generatedAt: new Date().toISOString(), tags: TAGS, pages, leads });
  const v = leads.filter((l) => l.kind === "violation").length;
  const disc = leads.filter((l) => l.source === "disclosure-check").length;
  console.log(`axe sweep: ${pages.length} page loads, ${v} violation nodes, ${leads.length - v - disc} needs-review nodes, ${disc} show/hide buttons without aria-expanded.`);
  for (const p of pages.filter((p) => p.error || p.redirected)) console.log(`  ${p.path}: ${p.error || "redirected to " + p.finalUrl}`);
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
