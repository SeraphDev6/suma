import { execFileSync } from "node:child_process";

/**
 * The phase 2 pull request comment is a single sticky comment found by MARKER. Its status block
 * (between STATUS_START and STATUS_END) says which commit was tested and whether newer commits
 * exist; the push-time preview rewrites only that block, so test results stay in place.
 */
export const MARKER = "<!-- suma-a11y-impact-report -->";
export const HEADING = "## Accessibility phase 2: live test of the changed pages";
export const STATUS_START = "<!-- a11y-status:start -->";
export const STATUS_END = "<!-- a11y-status:end -->";
export const TEST_LABEL = "a11y-test";

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
