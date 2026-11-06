#!/usr/bin/env node
/**
 * Phase 2, after the agent: re-measure every measurable finding in a fresh browser, independently of
 * the agent, while Suma is still running. A finding whose numbers do not reproduce is refuted and
 * the validator drops it.
 *
 *   node recheck.mjs [--report a11y-report/report.json]   writes <reportDir>/recheck.json
 *
 * For each finding and each measurable criterion it cites (contrast, non-text contrast, target size,
 * focus obscured, reflow, text spacing): open the finding's URL with the right session and locale,
 * replay the finding's `replay` steps (to reach states such as "menu open"), run the same probe the
 * agent used and apply the same pass/fail rule as the validator.
 *
 *   confirmed  the fresh measurement also shows the failure
 *   refuted    the fresh measurement shows a pass
 *   skipped    it could not be re-measured (element not found, needs a visual judgement, ...)
 *
 * It also re-measures carried findings (PREV- leads in previous.json) that the agent dismissed as
 * fixed. If the failure still reproduces, the result is "confirmed" with dismissedLead set, a
 * screenshot is saved, and the validator puts the finding back.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { settle } from "./axe-sweep.mjs";
import { isMain, loadConfig, parseArgs, readJson, REPO_ROOT, reportDir, writeJson } from "./lib/common.mjs";
import { MEASURED, RECHECK_SC as RECHECKABLE } from "./validate-report.mjs";

/** Find the route entry in impact.json that a finding's route names, to know whether it needs a session. */
function routeInfo(impact, app, route) {
  return impact?.apps?.[app]?.routes?.find((r) => r.path === route) || null;
}

async function replay(page, steps = []) {
  for (const s of steps) {
    if (s.action === "click") await page.click(s.target, { timeout: 5000 });
    else if (s.action === "hover") await page.hover(s.target, { timeout: 5000 });
    else if (s.action === "press") await page.keyboard.press(s.key);
    else if (s.action === "fill") await page.fill(s.target, s.value ?? "", { timeout: 5000 });
    else if (s.action === "resize") await page.setViewportSize({ width: s.width, height: s.height || 800 });
    else if (s.action === "scroll") await page.evaluate((y) => window.scrollTo(0, y), s.y || 0);
    else if (s.action === "reducedMotion") await page.emulateMedia({ reducedMotion: "reduce" });
    else throw new Error(`unknown replay action ${s.action}`);
    await page.waitForTimeout(400);
  }
}

/** Tab until the focused element matches the selector, like a keyboard user reaching it. */
async function tabTo(page, selector, max = 80) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    if (await page.evaluate((sel) => !!document.activeElement?.matches?.(sel), selector).catch(() => false)) return true;
  }
  return false;
}

/** Screenshot of the element still failing, outlined, saved under the report's screenshots/. */
async function evidenceShot(page, selector, name, out) {
  try {
    await page.evaluate((s) => window.__a11y.highlight?.(s, "still fails"), selector);
    await page.waitForTimeout(200);
    const rel = `screenshots/recheck-${name.replace(/[^A-Za-z0-9.-]+/g, "_")}.png`;
    fs.mkdirSync(path.join(out, "screenshots"), { recursive: true });
    await page.screenshot({ path: path.join(out, rel) });
    return rel;
  } catch {
    return undefined;
  }
}

async function measure(page, sc, f) {
  const sel = f.element?.selector;
  const exists = sel ? await page.evaluate((s) => { const el = document.querySelector(s); return !!el && !!el.getClientRects().length; }, sel).catch(() => false) : false;
  if (["1.4.3", "1.4.6", "1.4.11", "2.5.8", "2.5.5", "2.4.11", "2.4.12"].includes(sc) && !exists) return { skipped: `element ${sel || "(no selector)"} is not on the page after loading and replaying` };
  if (sc === "1.4.3" || sc === "1.4.6") return { m: await page.evaluate((s) => window.__a11y.contrast(s), sel) };
  if (sc === "1.4.11") return { m: await page.evaluate(([s, prop]) => window.__a11y.nonTextContrast(s, prop), [sel, f.measurement?.property || "borderTopColor"]) };
  if (sc === "2.5.8" || sc === "2.5.5") {
    // Measure the target at rest: no hover from an earlier replay step, no focus (the probe blurs).
    await page.mouse.move(0, 0);
    return { m: await page.evaluate((s) => window.__a11y.targetSize(s), sel) };
  }
  if (sc === "2.4.11" || sc === "2.4.12") {
    if (!(await tabTo(page, sel))) return { skipped: `Tab never reached ${sel}` };
    return { m: await page.evaluate(() => window.__a11y.focusInfo()) };
  }
  if (sc === "1.4.10") {
    if (f.measurement?.contentLost && !f.measurement?.pageScrollsHorizontally) return { skipped: "the finding rests on a visual judgement (contentLost), not on measured overflow" };
    await page.setViewportSize({ width: 320, height: 640 });
    await page.waitForTimeout(600);
    return { m: await page.evaluate(() => window.__a11y.reflow()) };
  }
  if (sc === "1.4.12") {
    if (f.measurement?.contentLost && !f.measurement?.clipped?.length) return { skipped: "the finding rests on a visual judgement (contentLost), not on measured clipping" };
    const m = await page.evaluate(() => window.__a11y.textSpacing(true));
    if (!m.applied) return { skipped: "the text spacing override did not apply" };
    return { m };
  }
  return { skipped: "not re-measurable" };
}

/** Carried findings the agent dismissed, in the shape of a finding, so they can be re-measured. */
export function dismissedCarried(report, previous) {
  const leads = new Map((previous?.leads || []).map((l) => [l.id, l]));
  return (report.dismissedLeads || [])
    .filter((d) => /^PREV-/.test(d.leadId || "") && leads.has(d.leadId))
    .map((d) => {
      const l = leads.get(d.leadId);
      return { id: d.leadId, dismissedLead: true, sc: l.sc, app: l.app, route: l.route, url: l.url, locale: l.locale, state: l.state, replay: l.replay, measurement: l.measurement, element: { selector: l.target?.[0] } };
    });
}

export async function recheck(report, { config, impact, out, browser, previous = null }) {
  const results = [];
  const initScript = path.join(out, ".mcp/init.js");
  for (const f of [...(report.findings || []), ...dismissedCarried(report, previous)]) {
    for (const sc of (f.sc || []).filter((s) => RECHECKABLE.includes(s))) {
      const res = { id: f.id, sc, ...(f.dismissedLead ? { dismissedLead: true } : {}) };
      try {
        const info = routeInfo(impact, f.app, f.route);
        const app = config.apps[f.app];
        const needsAuth = info ? info.needsAuth : true;
        const state = needsAuth ? path.join(out, `.auth/${app?.auth || "member"}.json`) : undefined;
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState: state && fs.existsSync(state) ? state : undefined });
        await context.addInitScript({ path: initScript });
        const page = await context.newPage();
        try {
          const url = f.url || `${config.baseUrl}${app?.mountPath || "/app"}${f.route}`;
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
          await settle(page);
          if (f.locale && f.locale !== "en") {
            await page.evaluate((l) => localStorage.setItem("language", JSON.stringify(l)), f.locale);
            await page.reload({ waitUntil: "domcontentloaded" });
            await settle(page);
          }
          await replay(page, f.replay);
          const { m, skipped } = await measure(page, sc, f);
          if (skipped) Object.assign(res, { status: "skipped", detail: skipped });
          else {
            const why = MEASURED[sc](m);
            // MEASURED explains why a measurement does NOT show a failure; null means it does.
            if (why === null) {
              Object.assign(res, { status: "confirmed", measurement: m });
              if (f.dismissedLead) res.screenshot = await evidenceShot(page, f.element?.selector, `${f.id}-${sc}`, out);
            }
            else if (/^needs /.test(why) || /indeterminate|ambiguous/.test(why)) Object.assign(res, { status: "skipped", detail: why, measurement: m });
            else Object.assign(res, { status: "refuted", detail: why, measurement: m });
          }
        } finally {
          await context.close();
        }
      } catch (e) {
        Object.assign(res, { status: "skipped", detail: `could not re-measure: ${String(e.message || e).split("\n")[0]}` });
      }
      results.push(res);
    }
  }
  return results;
}

if (isMain(import.meta.url)) {
  const args = parseArgs();
  const config = loadConfig();
  const out = reportDir(config);
  const reportPath = path.resolve(REPO_ROOT, args.report || path.join(out, "report.json"));
  if (!fs.existsSync(reportPath)) {
    console.log("No report to re-check.");
    process.exit(0);
  }
  const report = readJson(reportPath);
  const impactPath = path.join(out, "impact.json");
  const impact = fs.existsSync(impactPath) ? readJson(impactPath) : null;
  const previousPath = path.join(out, "previous.json");
  const previous = fs.existsSync(previousPath) ? readJson(previousPath) : null;
  const browser = await chromium.launch();
  try {
    const results = await recheck(report, { config, impact, out, browser, previous });
    writeJson(path.join(out, "recheck.json"), { checkedAt: new Date().toISOString(), results });
    for (const r of results) console.log(`${r.id}${r.dismissedLead ? " (dismissed by the agent)" : ""} ${r.sc}: ${r.status}${r.detail ? ` (${r.detail})` : ""}`);
  } finally {
    await browser.close();
  }
}
