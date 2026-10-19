// Runs in .github/workflows/release.yml after a push to main: decides the next version
// from the PR titles merged since the last release commit, bumps it
// (package.json / manifest.json / versions.json), updates CHANGELOG.md,
// commits, tags and pushes, then publishes a GitHub Release. Pass --dry-run to only print.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { bumpVersion, collectChanges, decideBump, prependChangelog, renderNotes } from "./release-lib.mjs";

const dryRun = process.argv.includes("--dry-run");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const lastRelease = git("log", "--first-parent", "-1", "--format=%H", "--grep=^chore(release): v");
const head = git("rev-parse", "HEAD");
if (lastRelease === head) {
  console.log("HEAD is a release commit; nothing to do.");
  process.exit(0);
}
// A newer push to main means a later run of this workflow will release these commits too; releasing
// from a stale HEAD would make the push below fail after the tag was created.
if (!dryRun) {
  git("fetch", "origin", "main");
  if (git("rev-parse", "origin/main") !== head) {
    console.log("main has moved on since this run started; leaving the release to the newer run.");
    process.exit(0);
  }
}
const range = lastRelease ? `${lastRelease}..${head}` : `${head}~1..${head}`;
const raw = git("log", "--first-parent", "--format=%s%x1f%b%x1e", range);
const commits = raw
  .split("\x1e")
  .map((e) => e.replace(/^\n/, ""))
  .filter((e) => e.trim())
  .map((e) => {
    const [subject, body = ""] = e.split("\x1f");
    return { subject: subject.trim(), body };
  });

const changes = collectChanges(commits);
const bump = decideBump(changes);
if (!bump) {
  console.log("No releasable change (docs/ci/chore/test only); skipping release.");
  process.exit(0);
}

const current = JSON.parse(readFileSync("package.json", "utf8")).version;
const next = bumpVersion(current, bump);
const repo = process.env.GITHUB_REPOSITORY ?? "chiepu3/vault-gantt";
const notes = renderNotes(changes, `https://github.com/${repo}`);
console.log(`${current} -> ${next} (${bump})\n\n${notes}`);
if (dryRun) process.exit(0);

// Not `npm version`: it also rewrites package-lock.json, and install.cmd treats any lockfile
// change as "dependencies changed" and reruns npm ci. npm ci ignores the root version, so the
// lockfile is left alone and package.json + version-bump.mjs sync the other files.
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
pkg.version = next;
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
execFileSync("node", ["version-bump.mjs"], { stdio: "inherit", env: { ...process.env, npm_package_version: next } });
const date = new Date().toISOString().slice(0, 10);
const existing = existsSync("CHANGELOG.md") ? readFileSync("CHANGELOG.md", "utf8") : "";
writeFileSync("CHANGELOG.md", prependChangelog(existing, next, date, notes));

git("add", "package.json", "manifest.json", "versions.json", "CHANGELOG.md");
git("-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
  "commit", "-m", `chore(release): v${next}`);
git("tag", `v${next}`);
// --atomic: either main and the tag both land or neither does, so a rejected push leaves no orphan tag.
git("push", "--atomic", "origin", "HEAD:main", `v${next}`);
writeFileSync(process.env.RUNNER_TEMP ? `${process.env.RUNNER_TEMP}/release-notes.md` : "release-notes.md", notes);
execFileSync("gh", ["release", "create", `v${next}`, "--title", `v${next}`, "--notes-file",
  process.env.RUNNER_TEMP ? `${process.env.RUNNER_TEMP}/release-notes.md` : "release-notes.md"], { stdio: "inherit" });
