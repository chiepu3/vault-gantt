#!/usr/bin/env node
// Static web preview builder.
//   node tools/web-preview/build.mjs --app <appDir> --out <outDir> [--label <branch>] [--sha <commit>]
// Bundles <appDir>/src/main.ts (the real plugin of whatever branch is checked out there) with a browser shim for the
// "obsidian" module and writes a self-contained site (index.html, app.js, preview.css, styles.css) to <outDir>.
// This script may live in a different checkout than <appDir>: esbuild and every package are resolved from <appDir>.
import fs from "node:fs";
import path from "node:path";
import { builtinModules, createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { renderMarkdown, safeUrl } from "./md.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
if (!args.app || !args.out) { console.error("usage: build.mjs --app <appDir> --out <outDir> [--label <name>] [--sha <sha>]"); process.exit(2); }
const appDir = path.resolve(args.app), outDir = path.resolve(args.out);
const git = (...a) => { try { return execFileSync("git", ["-C", appDir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };
const label = args.label ?? (git("rev-parse", "--abbrev-ref", "HEAD") || "local");
const sha = args.sha ?? (git("rev-parse", "--short", "HEAD") || "unknown");
const manifest = JSON.parse(fs.readFileSync(path.join(appDir, "manifest.json"), "utf8"));
// Commit time, not wall-clock time, so rebuilding the same commit yields byte-identical output (gh-pages skips no-op pushes).
const builtAt = git("log", "-1", "--format=%cI") || new Date().toISOString();
// Optional "about this PR" info (JSON file from build-all). Rendered to safe HTML here; the shell only shows it.
let about = null;
if (args.info) {
  const raw = JSON.parse(fs.readFileSync(path.resolve(args.info), "utf8"));
  about = {
    pr: raw.pr ? { number: raw.pr.number, title: String(raw.pr.title ?? ""), url: safeUrl(raw.pr.url), bodyHtml: renderMarkdown(raw.pr.body) } : null,
    combines: (raw.combines ?? []).map((c) => ({ number: c.number, title: String(c.title ?? ""), url: safeUrl(c.url), slug: c.slug ? String(c.slug) : null })),
  };
  if (!about.pr && !about.combines.length) about = null;
}
const esbuild = createRequire(path.join(appDir, "package.json"))("esbuild");

const nodeStub = path.join(here, "shim/stub-node.cjs");
const builtins = new Set([...builtinModules, "electron"]);
const previewPlugin = {
  name: "web-preview",
  setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(here, "shim/obsidian.ts") }));
    build.onResolve({ filter: /^@app\// }, (a) => build.resolve("./" + a.path.slice(5), { resolveDir: path.join(appDir, "src"), kind: a.kind }));
    build.onResolve({ filter: /^[^./]/ }, (a) => (a.path.startsWith("node:") || builtins.has(a.path.split("/")[0]) ? { path: nodeStub } : undefined));
    // Packages imported from the shim (moment, js-yaml, ...) come from the app checkout, like the plugin's own imports.
    build.onResolve({ filter: /^[^./]/ }, (a) => {
      if (a.pluginData?.skip || !a.importer.startsWith(here) || a.path === "obsidian" || a.path.startsWith("@app/")) return undefined;
      return build.resolve(a.path, { resolveDir: appDir, kind: a.kind, pluginData: { skip: true } });
    });
  },
};

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
await esbuild.build({
  entryPoints: [path.join(here, "shell/entry.ts")],
  outfile: path.join(outDir, "app.js"),
  absWorkingDir: appDir,
  nodePaths: [path.join(appDir, "node_modules")],
  tsconfig: path.join(appDir, "tsconfig.json"),
  bundle: true, format: "iife", platform: "browser", target: "es2020", minify: true, logLevel: "warning", legalComments: "none",
  define: {
    __VG_VERSION__: JSON.stringify(String(manifest.version)),
    __VG_COMMIT__: JSON.stringify(sha),
    __VG_BUILT_AT__: JSON.stringify(builtAt),
    __VGP__: JSON.stringify({ label, sha, builtAt, about, manifest: { id: manifest.id, name: manifest.name, version: manifest.version } }),
    "process.env.NODE_ENV": '"production"',
  },
  plugins: [previewPlugin],
});

const read = (p) => fs.readFileSync(p, "utf8");
const pluginCss = read(path.join(appDir, "styles.css"));
const previewCss = read(path.join(here, "shell/base.css")) + "\n" + read(path.join(here, "shell/shell.css"));
fs.writeFileSync(path.join(outDir, "styles.css"), pluginCss);
fs.writeFileSync(path.join(outDir, "preview.css"), previewCss);
fs.writeFileSync(path.join(outDir, "version.json"), JSON.stringify({ label, sha, builtAt, version: manifest.version }, null, 2));
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
fs.writeFileSync(path.join(outDir, "index.html"), `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=1200">
<title>${esc(manifest.name)} プレビュー (${esc(label)})</title>
<link rel="stylesheet" href="preview.css?v=${sha}"><link rel="stylesheet" href="styles.css?v=${sha}">
</head><body class="theme-light"><div id="vgp-root"></div><script src="app.js?v=${sha}"></script></body></html>
`);

// Heads-up for CSS variables the plugin stylesheet uses but neither it nor the preview theme defines.
const defined = new Set([...(pluginCss + previewCss).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
const missing = [...new Set([...pluginCss.matchAll(/var\((--[\w-]+)\s*\)/g)].map((m) => m[1]))].filter((v) => !defined.has(v));
if (missing.length) console.warn("[web-preview] CSS variables used by styles.css but not defined (check fallbacks): " + missing.join(" "));
console.log(`[web-preview] ${label} @ ${sha} (v${manifest.version}) -> ${outDir} (${(fs.statSync(path.join(outDir, "app.js")).size / 1024).toFixed(0)} KB)`);
