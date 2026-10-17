// Computes the preview target list: default branch + open same-repo PRs + "*-all" branches.
// Usage: node plan.mjs --repo owner/name --out targets.json   (needs GH_TOKEN and `gh`)
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { parseArgs, assignSlugs } from "./common.mjs";

const args = parseArgs(process.argv.slice(2));
const repo = args.repo || process.env.GITHUB_REPOSITORY;
if (!repo || !args.out) { console.error("usage: plan.mjs --repo owner/name --out file"); process.exit(2); }

const gh = (path) => JSON.parse(execFileSync("gh", ["api", "--paginate", "--slurp", path], { encoding: "utf8", maxBuffer: 64 << 20 })).flat();
const ghOne = (path) => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8" }));

const info = ghOne(`repos/${repo}`);
const defaultBranch = info.default_branch;
const byBranch = new Map();
const prs = [];

async function commitInfo(sha) {
  const c = ghOne(`repos/${repo}/commits/${sha}`);
  return { sha, commitTime: c.commit?.committer?.date || c.commit?.author?.date || null };
}
function add(branch, sha, kind, extra = {}) {
  const cur = byBranch.get(branch);
  if (cur) { Object.assign(cur, extra); return; }
  byBranch.set(branch, { branch, sha, kind, pr: null, ...extra });
}

const main = ghOne(`repos/${repo}/branches/${encodeURIComponent(defaultBranch)}`);
add(defaultBranch, main.commit.sha, "main");

for (const b of gh(`repos/${repo}/branches?per_page=100`)) {
  if (b.name.endsWith("-all") && b.name !== "gh-pages") add(b.name, b.commit.sha, "all");
}
for (const p of gh(`repos/${repo}/pulls?state=open&per_page=100`)) {
  if (p.head.repo?.full_name !== repo) continue; // skip forks: never build untrusted code
  const pr = { number: p.number, title: p.title, url: p.html_url, createdAt: p.created_at, body: String(p.body ?? "").slice(0, 8000) };
  prs.push({ ...pr, branch: p.head.ref });
  const cur = byBranch.get(p.head.ref);
  if (cur) cur.pr = pr; // e.g. an -all branch that also has a PR
  else add(p.head.ref, p.head.sha, "pr", { pr });
}
// A PR on the default branch name itself is impossible; keep it simple.

const targets = [...byBranch.values()];
// "X-all" integration branches combine the open PRs whose head branch starts with X (e.g. X, X-gantt-highlight, X-event-hours).
for (const t of targets) {
  if (t.kind !== "all" || !t.branch.endsWith("-all")) continue;
  const prefix = t.branch.slice(0, -4);
  t.combines = prs.filter((p) => p.branch !== t.branch && (p.branch === prefix || p.branch.startsWith(prefix + "-")))
    .map(({ number, title, url, branch }) => ({ number, title, url, branch })).sort((a, b) => a.number - b.number);
}
for (const t of targets) Object.assign(t, await commitInfo(t.sha));
assignSlugs(targets);
writeFileSync(args.out, JSON.stringify({ repository: repo, defaultBranch, targets }, null, 2) + "\n");
console.log(`planned ${targets.length} target(s): ${targets.map((t) => t.branch).join(", ")}`);
