// Runs in .github/workflows/release.yml after a push to main: decides the next version
// from the PR titles merged since the last release commit, bumps it with `npm version`
// (package.json / package-lock.json / manifest.json / versions.json), updates CHANGELOG.md,
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

execFileSync("npm", ["version", next, "--no-git-tag-version"], { stdio: "inherit" });
const date = new Date().toISOString().slice(0, 10);
const existing = existsSync("CHANGELOG.md") ? readFileSync("CHANGELOG.md", "utf8") : "";
writeFileSync("CHANGELOG.md", prependChangelog(existing, next, date, notes));

git("add", "package.json", "package-lock.json", "manifest.json", "versions.json", "CHANGELOG.md");
git("-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
  "commit", "-m", `chore(release): v${next}`);
git("tag", `v${next}`);
git("push", "origin", "HEAD:main", `v${next}`);
writeFileSync(process.env.RUNNER_TEMP ? `${process.env.RUNNER_TEMP}/release-notes.md` : "release-notes.md", notes);
execFileSync("gh", ["release", "create", `v${next}`, "--title", `v${next}`, "--notes-file",
  process.env.RUNNER_TEMP ? `${process.env.RUNNER_TEMP}/release-notes.md` : "release-notes.md"], { stdio: "inherit" });
