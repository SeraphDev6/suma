import { execFileSync } from "node:child_process";

/**
 * The phase 2 pull request comment is a single sticky comment found by MARKER. Its status block
 * (between STATUS_START and STATUS_END) says which commit was tested and whether newer commits
 * exist; the push-time preview rewrites only that block, so test results stay in place.
 */
export const MARKER = "<!-- suma-a11y-impact-report -->";
export const HEADING = "## Accessibility phase 2: the changed pages";
export const STATUS_START = "<!-- a11y-status:start -->";
export const STATUS_END = "<!-- a11y-status:end -->";
export const TEST_LABEL = "a11y-test";
export const SCAN_LABEL = "a11y-scan";

export const short = (sha) => String(sha || "").slice(0, 8);
export const testedShaMarker = (sha) => `<!-- a11y-tested-sha: ${sha} -->`;

export function testedSha(body) {
  return /<!-- a11y-tested-sha: ([0-9a-f]{7,40}) -->/.exec(body || "")?.[1] || null;
}

export function statusBlock(lines) {
  return [STATUS_START, ...lines, STATUS_END].join("\n");
}

/** Replace the status block in body; insert it after the heading when the body has none. */
export function replaceStatus(body, block) {
  const s = body.indexOf(STATUS_START);
  const e = body.indexOf(STATUS_END);
  if (s !== -1 && e > s) return body.slice(0, s) + block + body.slice(e + STATUS_END.length);
  const h = body.indexOf(HEADING);
  if (h === -1) return `${block}\n\n${body}`;
  const at = h + HEADING.length;
  return `${body.slice(0, at)}\n\n${block}${body.slice(at)}`;
}

function gh(args, input) {
  return execFileSync("gh", args, { encoding: "utf8", input, maxBuffer: 16 * 1024 * 1024 });
}

/** The sticky comment on a pull request, or null. Needs GH_TOKEN and GITHUB_REPOSITORY. */
export function findComment(repo, pr) {
  const out = gh(["api", `repos/${repo}/issues/${pr}/comments`, "--paginate", "--jq", `.[] | select(.body | startswith("${MARKER}")) | {id, body}`]);
  const first = out.split("\n").find((l) => l.trim());
  return first ? JSON.parse(first) : null;
}

export function upsertComment(repo, pr, body) {
  const existing = findComment(repo, pr);
  const payload = JSON.stringify({ body });
  if (existing) gh(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${existing.id}`, "--input", "-"], payload);
  else gh(["api", "-X", "POST", `repos/${repo}/issues/${pr}/comments`, "--input", "-"], payload);
}

/** The parts of a measurement the re-check needs to re-measure a carried finding the same way. */
function carriedMeasurement(m) {
  if (!m) return undefined;
  const keep = { property: m.property, contentLost: m.contentLost, pageScrollsHorizontally: m.pageScrollsHorizontally, clipped: Array.isArray(m.clipped) ? m.clipped.slice(0, 3) : undefined };
  return Object.values(keep).some((v) => v !== undefined) ? keep : undefined;
}

/** Confirmed findings, embedded invisibly in the comment so the next run can re-test them. */
export function findingsMarker(findings, sha) {
  const keep = (findings || []).map((f) => ({ id: f.id, sc: f.sc, level: f.level, app: f.app, route: f.route, url: f.url, locale: f.locale, state: f.state, replay: f.replay, title: f.title, why: f.why, expected: f.expected, actual: f.actual, severity: f.severity, steps: f.steps, suggestedFix: f.suggestedFix, measurement: carriedMeasurement(f.measurement), element: { selector: f.element?.selector, name: f.element?.name } }));
  return `<!-- a11y-findings: ${Buffer.from(JSON.stringify({ sha, findings: keep })).toString("base64")} -->`;
}

export function readFindingsMarker(body) {
  const m = /<!-- a11y-findings: ([A-Za-z0-9+/=]+) -->/.exec(body || "");
  if (!m) return null;
  try {
    return JSON.parse(Buffer.from(m[1], "base64").toString("utf8"));
  } catch {
    return null;
  }
}
