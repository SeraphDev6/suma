#!/usr/bin/env node
/**
 * Read or write the sticky phase 2 comment through the gh CLI (GH_TOKEN, GITHUB_REPOSITORY).
 *
 *   node pr-comment.mjs fetch --pr N --out existing.md     writes the current body ("" if none)
 *   node pr-comment.mjs put   --pr N --file comment.md     creates or updates the comment
 */
import fs from "node:fs";
import { parseArgs } from "./lib/common.mjs";
import { findComment, upsertComment } from "./lib/comment.mjs";

const args = parseArgs();
const repo = process.env.GITHUB_REPOSITORY;
const [cmd] = args._;
if (!repo || !args.pr) throw new Error("GITHUB_REPOSITORY and --pr are required");

if (cmd === "fetch") {
  fs.writeFileSync(args.out, findComment(repo, args.pr)?.body || "");
} else if (cmd === "put") {
  upsertComment(repo, args.pr, fs.readFileSync(args.file, "utf8"));
} else {
  throw new Error(`unknown command ${cmd}; use fetch or put`);
}
