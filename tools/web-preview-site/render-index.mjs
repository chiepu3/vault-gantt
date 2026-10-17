// Renders site/index.html (+ .nojekyll) from a targets file.
// Usage: node render-index.mjs --targets targets.json --out site
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, escapeHtml as h } from "./common.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.targets || !args.out) { console.error("usage: render-index.mjs --targets f --out dir"); process.exit(2); }
const plan = JSON.parse(readFileSync(args.targets, "utf8"));

const rank = (t) => (t.kind === "main" ? 0 : t.kind === "all" ? 1 : 2);
const sorted = [...plan.targets].sort((a, b) =>
  rank(a) - rank(b) || (b.pr?.number ?? 0) - (a.pr?.number ?? 0) || a.branch.localeCompare(b.branch));

const fmtTime = (iso) => {
  if (!iso) return "-";
  const d = new Date(iso);
  return isNaN(d) ? "-" : d.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false }) + " JST";
};
const kindLabel = { main: "メイン", all: "統合ブランチ", pr: "PR" };
const statusLabel = (s) => (s === "success" ? "成功" : s === "failure" ? "失敗" : "未ビルド");

const cards = sorted.map((t) => {
  const st = t.status || "unknown";
  const pr = t.pr ? `<p class="pr"><a href="${h(t.pr.url)}">#${h(t.pr.number)}</a> ${h(t.pr.title)}</p>` : "";
  return `<li class="card ${h(st)}">
  <div class="top"><span class="kind">${kindLabel[t.kind] || h(t.kind)}</span><span class="status ${h(st)}">${statusLabel(st)}</span></div>
  <h2>${h(t.branch)}</h2>${pr}
  <p class="meta"><code>${h(String(t.sha).slice(0, 7))}</code> · ${h(fmtTime(t.commitTime))}</p>
  <div class="links"><a class="open" href="b/${encodeURIComponent(t.slug)}/">プレビューを開く</a>${t.shots ? `<a class="open shots" href="b/${encodeURIComponent(t.slug)}/shots/">実機スクショ</a>` : ""}</div>
</li>`;
}).join("\n");

const html = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vault Gantt プレビュー</title>
<style>
:root{--bg:#f6f7f9;--fg:#1c1f24;--card:#fff;--line:#d9dde3;--mut:#5b6572;--acc:#2a6df4;--ok:#1a7f37;--ng:#c62828}
@media (prefers-color-scheme:dark){:root{--bg:#14161a;--fg:#e6e8eb;--card:#1e2126;--line:#33383f;--mut:#98a2af;--acc:#6b9bff;--ok:#4cc26a;--ng:#ff7b72}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}
main{max-width:46rem;margin:0 auto;padding:16px}
h1{font-size:1.4rem;margin:8px 0 4px}.sub{color:var(--mut);margin:0 0 16px;font-size:.9rem}
ul{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.card.failure{border-color:var(--ng)}
.top{display:flex;justify-content:space-between;font-size:.8rem;color:var(--mut)}
.status.success{color:var(--ok)}.status.failure{color:var(--ng)}
h2{font-size:1.05rem;margin:4px 0;word-break:break-all}
.pr{margin:2px 0}a{color:var(--acc)}.meta{color:var(--mut);font-size:.85rem;margin:4px 0 10px}
.open{display:block;text-align:center;background:var(--acc);color:#fff;text-decoration:none;font-weight:700;font-size:1.1rem;padding:12px;border-radius:10px}
.links{display:flex;gap:8px}.links .open{flex:1}.open.shots{background:transparent;color:var(--acc);border:2px solid var(--acc);padding:10px}
@media (prefers-color-scheme:dark){.open{color:#0b1020}.open.shots{color:var(--acc)}}
</style></head><body><main>
<h1>Vault Gantt ブラウザプレビュー</h1>
<p class="sub">${h(plan.repository)} · ${sorted.length} 件(30分ごとに自動更新)</p>
<ul>
${cards}
</ul></main></body></html>
`;
mkdirSync(args.out, { recursive: true });
writeFileSync(join(args.out, "index.html"), html);
writeFileSync(join(args.out, ".nojekyll"), "");
console.log(`wrote ${join(args.out, "index.html")}`);
