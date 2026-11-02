#!/usr/bin/env node
/**
 * Prepare the browser the Copilot agent drives through Playwright MCP:
 *   <reportDir>/.mcp/init.js          axe-core + probes, injected into every page
 *   <reportDir>/.auth/member.json     signed-in member session
 *   <reportDir>/.mcp/mcp-config.json  config for `copilot --additional-mcp-config @...`
 *
 * Two Playwright servers, so the agent never types credentials and never signs itself out:
 *   playwright        signed in as the member (member app pages that need auth)
 *   playwright-anon   signed out (public member pages: /, /start, /sitemap, ...)
 * All are isolated (in-memory profile). Paths are absolute so the servers' working directory
 * does not matter.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { chromium } from "playwright";
import { loadConfig, parseArgs, REPO_ROOT, reportDir, TOOL_DIR, writeJson } from "./lib/common.mjs";
import { signIn } from "./lib/login.mjs";

const args = parseArgs();
const config = loadConfig();
const out = reportDir(config);
const require = createRequire(import.meta.url);
const MCP_VERSION = "0.0.83";

async function main() {
  fs.mkdirSync(path.join(out, ".mcp"), { recursive: true });
  fs.mkdirSync(path.join(out, ".auth"), { recursive: true });
  fs.mkdirSync(path.join(out, "screenshots"), { recursive: true });

  const axeSrc = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
  const probes = fs.readFileSync(path.join(TOOL_DIR, "agent/probes.js"), "utf8");
  const initPath = path.join(out, ".mcp/init.js");
  fs.writeFileSync(initPath, `${axeSrc}\n;\n${probes}\n`);

  const states = {};
  if (!args["skip-login"]) {
    const browser = await chromium.launch();
    try {
      for (const role of new Set(Object.values(config.apps).map((a) => a.auth))) {
        states[role] = await signIn(browser, config, role, path.join(out, `.auth/${role}.json`));
      }
    } finally {
      await browser.close();
    }
  }

  const server = (statePath) => ({
    type: "local",
    command: "npx",
    args: [
      "-y",
      `@playwright/mcp@${MCP_VERSION}`,
      "--headless",
      "--isolated",
      "--viewport-size", "1280x800",
      "--init-script", initPath,
      "--output-dir", path.join(out, "screenshots"),
      ...(statePath ? ["--storage-state", statePath] : []),
    ],
    tools: ["*"],
  });
  const mcpConfig = {
    mcpServers: {
      playwright: server(states.member),
      "playwright-anon": server(null),
    },
  };
  writeJson(path.join(out, ".mcp/mcp-config.json"), mcpConfig);
  console.log(`init script: ${path.relative(REPO_ROOT, initPath)} (${Math.round((axeSrc.length + probes.length) / 1024)} KB)`);
  console.log(`MCP config:  ${path.relative(REPO_ROOT, path.join(out, ".mcp/mcp-config.json"))}`);
  for (const [r, p] of Object.entries(states)) console.log(`${r} session: ${path.relative(REPO_ROOT, p)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
