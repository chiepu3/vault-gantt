// Builds every target in a targets file into <out>/b/<slug>/. One failure never aborts the rest.
// Usage: node build-all.mjs --targets targets.json --tools <toolsCheckout> --work apps --out site
//        [--repo-url <git url or path>]   (default https://github.com/$GITHUB_REPOSITORY.git)
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, cpSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs, escapeHtml } from "./common.mjs";

const args = parseArgs(process.argv.slice(2), { work: "apps", out: "site" });
if (!args.targets || !args.tools) { console.error("usage: build-all.mjs --targets f --tools dir [--work dir] [--out dir]"); process.exit(2); }
const plan = JSON.parse(readFileSync(args.targets, "utf8"));
const repoUrl = args["repo-url"] || `https://github.com/${plan.repository}.git`;
const tools = resolve(args.tools), work = resolve(args.work), out = resolve(args.out);
mkdirSync(work, { recursive: true });
mkdirSync(join(out, "b"), { recursive: true });

function run(cmd, cmdArgs, cwd) {
  const r = spawnSync(cmd, cmdArgs, { cwd, encoding: "utf8", maxBuffer: 64 << 20 });
  const log = `$ ${cmd} ${cmdArgs.join(" ")}\n${r.stdout || ""}${r.stderr || ""}${r.error ? String(r.error) : ""}`;
  return { ok: r.status === 0 && !r.error, log };
}
const tail = (s, n = 60) => s.split("\n").slice(-n).join("\n");

function errorPage(t, log) {
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ビルド失敗: ${escapeHtml(t.branch)}</title>
<style>:root{color-scheme:light dark}body{font:16px/1.6 system-ui,sans-serif;margin:0 auto;max-width:48rem;padding:16px}pre{overflow:auto;padding:12px;border-radius:8px;background:rgba(127,127,127,.15);font-size:12px}</style>
<h1>ビルドに失敗しました</h1><p>ブランチ: <b>${escapeHtml(t.branch)}</b> (${escapeHtml(t.sha.slice(0, 7))})</p><pre>${escapeHtml(log)}</pre></html>`;
}

// package-lock hash -> directory holding an installed node_modules
const installed = new Map();
const { createHash } = await import("node:crypto");

for (const t of plan.targets) {
  const dest = join(out, "b", t.slug);
  const app = join(work, t.slug);
  let log = "";
  const step = (name, r) => { log += r.log + "\n"; if (!r.ok) throw new Error(`${name} failed`); };
  try {
    rmSync(app, { recursive: true, force: true });
    mkdirSync(app, { recursive: true });
    step("git init", run("git", ["init", "-q"], app));
    step("git fetch", run("git", ["fetch", "-q", "--depth", "1", repoUrl, t.sha], app));
    step("git checkout", run("git", ["checkout", "-q", "FETCH_HEAD"], app));
    const lockPath = join(app, "package-lock.json");
    const key = existsSync(lockPath) ? createHash("sha256").update(readFileSync(lockPath)).digest("hex") : null;
    if (key && installed.has(key)) {
      cpSync(join(installed.get(key), "node_modules"), join(app, "node_modules"), { recursive: true, verbatimSymlinks: true });
      log += `reused node_modules (lockfile ${key.slice(0, 8)})\n`;
    } else {
      step("npm ci", run("npm", ["ci", "--no-audit", "--no-fund"], app));
      if (key) installed.set(key, app);
    }
    mkdirSync(dest, { recursive: true });
    step("preview build", run("node", [join(tools, "tools/web-preview/build.mjs"), "--app", app, "--out", dest, "--label", t.branch, "--sha", t.sha], app));
    if (!existsSync(join(dest, "index.html"))) throw new Error("build produced no index.html");
    t.status = "success";
  } catch (e) {
    t.status = "failure";
    t.error = String(e.message || e);
    t.logTail = tail(log);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "index.html"), errorPage(t, `${t.error}\n\n${t.logTail}`));
    console.error(`[${t.branch}] FAILED: ${t.error}`);
  }
  if (t.status === "success") console.log(`[${t.branch}] ok`);
  // Free disk: the installed node_modules is only kept for lockfile reuse.
  if (!installed.size || ![...installed.values()].includes(app)) rmSync(app, { recursive: true, force: true });
}
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "targets.json"), JSON.stringify(plan, null, 2) + "\n");
