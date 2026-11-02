# Accessibility scanner

Two phases, both measured against WCAG 2.2 Levels A, AA and AAA.

| Phase | When | What it does | Output |
|---|---|---|---|
| 1. Static | Every PR and push to main (`a11y-static.yml`) | Lints the member app with every `eslint-plugin-jsx-a11y` rule that maps to a WCAG criterion, plus Suma checks (stylesheets, HTML shell, manifest, untranslated strings) | Code scanning annotations, job summary, `static.json` |
| 2. Traced impact | Preview on every push to a PR that touches `webapp/` or `data/i18n/`; the live test only when you add the `a11y-test` label (`a11y-impact.yml`) | Preview: traces the diff to the pages it can affect. Live test: runs axe-core on them, then a Copilot agent tests those pages in a real browser through Playwright MCP | One sticky PR comment: the pages in scope, then failures, screenshots, passes and open questions |

Phase 1 finds code patterns everywhere. Phase 2 tells you what a person using this PR's pages would hit.

## How phase 2 works

**Starting it.** The live test builds and starts Suma and spends Copilot requests, so it runs only on request:

- **Label:** add `a11y-test` to the pull request. The run tests the PR's head commit, then removes the label, so add it again to re-test.
- **Run workflow:** from the Actions tab, with an optional base ref and PR number. This button appears only once the workflow is on the default branch.

Every push runs only the preview. It traces the diff in seconds, without starting the app, and updates the comment with the pages in scope. When there are earlier results, it keeps them and marks them as being for an older commit. A push never cancels a test that is running. Fork PRs get the preview in the job summary and cannot run the test.


```
git diff ──► impact.mjs ──► routes in scope ──► axe-sweep.mjs ──► leads + screenshots
                 │                                                     │
   import graph walked up to the <Route>                               ▼
   elements in App.jsx; string keys traced     Copilot agent (a11y-tester) + Playwright MCP
   to the files that use them                  confirms or dismisses every lead, tests keyboard,
                                               focus, reflow, spacing, forms, motion, language
                                                               │
                                                               ▼
                                validate-report.mjs ──► render-report.mjs ──► PR comment
```

**Tracing.** `impact.mjs` builds the member app's import graph and walks up from every changed file until it reaches a route element (page component or HOC) in `App.jsx`. Edits inside a `<Route>` declaration affect only that route. A change reached only through a provider, `index.jsx`, `index.html` or the global stylesheets affects every page; the run then tests the directly changed pages first, then a representative sample (`globalSample` in `config.json`), up to 15 routes, and lists the rest as not tested. Changed keys in `data/i18n/seeds/*/strings.json` are traced through the files that use them, and Spanish keys put Spanish in the locales to test. Backend changes are listed as not traced.

**Leads.** Static results in changed files and axe-core results on the traced pages are leads, not findings. The agent must resolve each one: confirm it with a finding, or dismiss it with evidence.

**Agent.** `.github/agents/a11y-tester.agent.md` defines the procedure: per route, resolve leads, keyboard pass with focus checks after every Tab, names/roles/states from the accessibility tree, contrast, 320px reflow, 200% resize, text spacing, forms and errors, reduced motion, new windows, language. It drives two Playwright MCP servers (member, signed out), each with axe-core and the measurement probes in `tools/a11y/agent/probes.js` preloaded in every page. It never places orders, moves money or edits code.

**Only real issues.** `validate-report.mjs` drops any claimed failure that:

- cites something other than a WCAG 2.2 success criterion (or cites 4.1.1, which 2.2 removed),
- has no screenshot on disk, no steps, no expected/actual, or no plain-English reason,
- is a measurable criterion (1.4.3, 1.4.6, 1.4.10, 1.4.11, 1.4.12, 2.4.11, 2.4.12, 2.5.5, 2.5.8) without probe output that shows the failure. A contrast "failure" whose measured ratio meets the threshold is rejected, and so is a 1.4.11 border that passes on one side.

It also checks the agent's session transcript: the run is marked invalid if the agent ran Playwright scripts (`browser_run_code_unsafe` is blocked, and so is driving a browser from the shell), or tested pages without pressing keys or reading the accessibility tree. The comment lists how many page loads, key presses, clicks and snapshots the agent made. Passes on procedural criteria must be backed by the session log on each page they name: keyboard passes by at least as many Tab presses as the page has Tab stops (counted by the axe sweep, capped at 40), 1.4.10 and 1.4.4 by a resize to 320 and about 640px wide, 1.4.12 by a text spacing probe call, 2.3.3 by reduced motion emulation, and 4.1.2 and 1.3.1 by an accessibility snapshot. Unbacked passes move to "Needs a human" marked not verified. The agent cannot defer these criteria to a human without a blocker (unreachable, irreversible, ambiguous or tool-limit); the validator treats that as an error, so the agent keeps testing. It also marks the run incomplete when a lead is unresolved, an in-scope route is missing, or a tested route has no outcome for a criterion in `agentChecklist` (34 criteria across A, AA and AAA). Passes need a method and an observation. Rejected claims are listed separately in the comment so reviewers can see what was thrown out and why.

**Consistency between runs.** Two inputs keep runs from silently disagreeing:

- **Earlier findings carry forward.** The PR comment holds the confirmed findings in a hidden marker. The next test run turns each one into a `PREV-` lead the agent must resolve: confirmed again as a finding, or dismissed as fixed with evidence and a screenshot.
- **Show/hide check.** The axe sweep clicks buttons that look like menus, accordions or "more" toggles (never ones named like remove, pay, sign out and similar), and adds a `DISC-` lead when content appears or disappears but the button exposes no `aria-expanded`. axe-core does not check this.

**Independent re-measurement.** After the agent finishes, `recheck.mjs` opens each finding on a measured criterion (contrast, non-text contrast, target size, focus obscured, reflow, text spacing) in a fresh browser, replays the finding's `replay` steps, runs the same probe and applies the same rule. A finding whose failure does not reproduce is rejected; the comment says for each finding whether it was confirmed or could not be re-measured. Measured findings that depend on a state (menu open, narrow viewport) must include `replay` steps.

**Gate.** The live test is advisory by default: confirmed failures the PR introduces show as warnings on the run. Set the repository variable `A11Y_FAIL_LEVEL` to `A`, `AA` or `AAA` to make the run fail on failures at that level or stricter. A manual check cannot sensibly be required for merging, so phase 1 remains the merge gate. Pre-existing failures on the tested pages are reported with `introducedByDiff: no` and never fail the run.

## Setup

1. Copilot CLI authentication, one of:
   - Organization policy "Allow use of Copilot CLI billed to the organization"; the workflow's `copilot-requests: write` permission then lets `github.token` call Copilot.
   - A fine-grained personal access token with the **Copilot Requests** permission, saved as the repository secret `COPILOT_GITHUB_TOKEN`. Use this on a personal fork.
2. Create the label once: `gh label create a11y-test --description "Run the live accessibility test"`.
3. Optional repository variables: `A11Y_AGENT_MODEL`, `A11Y_FAIL_LEVEL`, `A11Y_EVIDENCE_BRANCH` (default `a11y-evidence`; screenshots are pushed there so they show inline in the comment; set `off` to only attach them to the run).
4. Code scanning must be enabled for the SARIF upload (it is free on public repositories).

Pull requests from forks never run the live test: they get no secrets, and an agent with a shell should not run untrusted code with a token.

### Running the agent on demand (Copilot cloud agent)

`copilot-setup-steps.yml` starts Suma and prepares the same inputs, so the cloud agent can run `a11y-tester` from a pull request. Copilot reads that workflow from the default branch only.

## Running locally

Start Suma as usual (`make run`, backend on port 22001 with the member app built at `/app`, bootstrapped database). Then:

```sh
cd tools/a11y && npm ci && npx playwright install chromium && cd ../..
node tools/a11y/static-scan.mjs                       # phase 1
node tools/a11y/impact.mjs --base origin/main          # trace the working tree against main
node tools/a11y/mcp-setup.mjs                          # sessions, init script, MCP config
node tools/a11y/axe-sweep.mjs                          # leads + screenshots
copilot --agent a11y-tester --additional-mcp-config @a11y-report/.mcp/mcp-config.json \
  -p "Test the accessibility impact of my changes; inputs are in a11y-report/."
node tools/a11y/validate-report.mjs && node tools/a11y/render-report.mjs
open a11y-report/report.html
```

`npm test` in `tools/a11y` runs the scanner's own tests.

## Maintaining it

- **Baseline.** `tools/a11y/static-baseline.json` holds the accepted phase 1 results, so only new ones fail. After fixing or accepting results, run `npm run static -- --update-baseline` in `tools/a11y`.
- **Rule mapping.** `tools/a11y/rules.json` maps each rule to criteria and says whether it is a certain `violation` or a `lead`. Rules with no WCAG criterion are left out on purpose.
- **Components.** If a new wrapper component renders a plain DOM element, add it to `components` in `rules.json` so jsx-a11y checks it. Do not add components that add roles or keyboard handling themselves (react-bootstrap `Dropdown.Item`, `Nav.Link`), or you will get false results.
- **Routes.** New routes are picked up from `App.jsx` automatically. Give parameter routes a `paramRouteHints` entry so the agent can reach them.
- **Versions.** Playwright MCP is pinned in `mcp-setup.mjs` and in the agent's front matter; keep the two in step.

## Limits

- Automated and agent testing do not replace testing with screen reader users. Criteria that need judgement (reading level, unusual words, pronunciation, captions quality) go to "Needs a human".
- `rake bootstrap` looks up the runner's location from two public IP services to place demo scooters; if those are down, the environment step fails.
- Actions that move money or place orders are tested only up to the last reversible step.
- The admin app (`adminapp/`) is out of scope: it is not linted, traced or tested. CI writes a placeholder `build-adminapp/index.html` only because the backend reads it at boot.
