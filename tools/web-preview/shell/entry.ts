// Browser entry: boots the in-memory vault, loads the real plugin (bundled from <appDir>/src/main.ts), then draws the preview shell.
import "../shim/globals";
import { App, Modal, Notice, preview, setIcon, type WorkspaceLeaf } from "../shim/obsidian";
import Plugin from "@app/main";
import { EXAMPLE_PROMPTS, installFakeLlm } from "./fake-llm";
import { makeSeed, today } from "./seed";

declare const __VGP__: { label: string; sha: string; builtAt: string; manifest: { id: string; name: string; version: string } };
/* eslint-disable @typescript-eslint/no-explicit-any */
const meta = __VGP__;
const STORE_KEY = `vgp:data:${meta.label}:${meta.sha}`, PREF_KEY = "vgp:prefs";
const $ = (id: string) => document.getElementById(id)!;
const safe = <T>(f: () => T, d: T): T => { try { return f(); } catch { return d; } };
const prefs: { theme?: "light" | "dark"; narrow?: boolean } = safe(() => JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}"), {});
const savePrefs = () => safe(() => localStorage.setItem(PREF_KEY, JSON.stringify(prefs)), undefined);

function applyPrefs(app?: App): void {
  const theme = prefs.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.body.classList.remove("theme-light", "theme-dark"); document.body.classList.add("theme-" + theme);
  document.querySelector('meta[name="viewport"]')!.setAttribute("content", prefs.narrow ? "width=device-width, initial-scale=1" : "width=1200");
  app?.workspace.trigger("css-change");
}
applyPrefs();

window.addEventListener("error", (e) => { console.error(e.error ?? e.message); try { new Notice("エラー: " + (e.error?.message ?? e.message), 8000).noticeEl.classList.add("is-error"); } catch { /* ignore */ } });
window.addEventListener("unhandledrejection", (e) => { console.error(e.reason); try { new Notice("エラー: " + (e.reason?.message ?? e.reason), 8000).noticeEl.classList.add("is-error"); } catch { /* ignore */ } });

async function boot(): Promise<void> {
  installFakeLlm();
  const stored = safe(() => JSON.parse(localStorage.getItem(STORE_KEY) ?? "null"), null);
  const seed = stored ?? makeSeed();
  seed.data.ganttNationalHolidaysUpdatedAt = today(); // the sample holidays are bundled; never try the (CORS-blocked) download
  const app = new App();
  app.vault.load(seed.files); app.pluginData = seed.data; preview.secrets = seed.secrets ?? {};
  let blocked = false, timer: any;
  preview.persist = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (!blocked) safe(() => localStorage.setItem(STORE_KEY, JSON.stringify({ files: app.vault.dump(), data: app.pluginData, secrets: preview.secrets })), undefined); }, 250);
  };
  if (!stored) preview.persist();

  const plugin: any = new (Plugin as any)(app, meta.manifest);
  (app as any).plugins = { plugins: { [meta.manifest.id]: plugin }, manifests: { [meta.manifest.id]: meta.manifest } };
  plugin._loaded = true;
  await plugin.onload();

  buildShell(app, plugin, () => { blocked = true; safe(() => localStorage.removeItem(STORE_KEY), undefined); location.reload(); });
  const id = (c: string) => meta.manifest.id + ":" + c;
  app.commands.executeCommandById(id("open-task-gantt"));
  (window as any).vgp = { app, plugin };
}

function buildShell(app: App, plugin: any, reset: () => void): void {
  const root = $("vgp-root"), ws = app.workspace;
  const bar = root.createDiv("vgp-top");
  const brand = bar.createDiv("vgp-brand");
  brand.createEl("b", { text: `${meta.label}` });
  brand.createEl("small", { text: `${meta.sha.slice(0, 8)} · v${meta.manifest.version} · ${meta.builtAt.replace("T", " ").slice(0, 16)}` });
  const body = root.createDiv("vgp-body");
  const main = body.createDiv("vgp-region vgp-main"), side = body.createDiv("vgp-region vgp-side");
  const mainTabs = main.createDiv("vgp-tabs"), mainPanes = main.createDiv("vgp-panes");
  const sideHead = side.createDiv("vgp-tabs"), sidePanes = side.createDiv("vgp-panes");
  mainPanes.createDiv({ cls: "vgp-empty", text: "上のボタンからビューを開いてください" });
  let lastMain: WorkspaceLeaf | null = null, lastSide: WorkspaceLeaf | null = null;

  const exists = (c: string) => !!app.commands.commands[meta.manifest.id + ":" + c];
  const run = (c: string) => app.commands.executeCommandById(meta.manifest.id + ":" + c);
  const fillChat = async (prompt: string) => {
    if (!prompt) return;
    let ta = document.querySelector<HTMLTextAreaElement>(".vg-ai-composer textarea");
    if (!ta) { await run("open-ai-chat-right"); await new Promise((r) => setTimeout(r, 150)); ta = document.querySelector<HTMLTextAreaElement>(".vg-ai-composer textarea"); }
    if (!ta) return;
    ta.value = prompt; ta.dispatchEvent(new Event("input", { bubbles: true })); ta.focus();
  };
  const open = async (type: string, region: "main" | "right" = "main") => {
    const l = ws.getLeavesOfType(type)[0] ?? (region === "main" ? ws.getLeaf("tab") : ws.getRightLeaf());
    await l.setViewState({ type, active: true }); await ws.revealLeaf(l);
  };
  const buttons: Array<[string, string, () => any, boolean]> = [
    ["Gantt", "bar-chart-3", () => run("open-task-gantt"), exists("open-task-gantt")],
    ["ワークベンチ", "list-todo", () => run("open-task-workbench"), exists("open-task-workbench")],
    ["AIチャット", "messages-square", () => run("open-ai-chat-right"), exists("open-ai-chat-right")],
    ["承認一覧", "shield-check", () => run("open-ai-approval"), exists("open-ai-approval")],
    ["設定", "settings", () => app.openSettings(meta.manifest.id), true],
    ["ノート一覧", "folder", () => open("vgp-notes"), true],
    ["コマンド", "menu", () => palette(app), true],
  ];
  for (const [label, icon, fn, show] of buttons) if (show) { const b = bar.createEl("button"); const i = b.createSpan(); setIcon(i, icon); b.appendText(" " + label); b.addEventListener("click", () => void fn()); }
  if (exists("open-ai-chat-right")) {
    // Shell-only helper (outside the plugin's DOM): fills the chat input with a prompt the scripted fake LLM understands.
    const sel = bar.createEl("select", { cls: "vgp-examples", title: "台本AI(fake-llm)が反応する例文。選ぶとAIチャットの入力欄に入ります" });
    sel.createEl("option", { text: "AIに試す例…", value: "" });
    for (const [label, prompt] of EXAMPLE_PROMPTS) sel.createEl("option", { text: label, value: prompt });
    sel.addEventListener("change", () => void fillChat(sel.value).then(() => { sel.value = ""; }));
  }
  bar.createDiv("vgp-spacer");
  const mk = (text: string, fn: (b: HTMLButtonElement) => void, title = "") => { const b = bar.createEl("button", { text, title }); b.addEventListener("click", () => fn(b)); return b; };
  mk(document.body.classList.contains("theme-dark") ? "ライト" : "ダーク", (b) => { prefs.theme = document.body.classList.contains("theme-dark") ? "light" : "dark"; savePrefs(); applyPrefs(app); b.setText(prefs.theme === "dark" ? "ライト" : "ダーク"); }, "ライト/ダーク切替");
  const nb = mk("スマホ幅", () => { prefs.narrow = !prefs.narrow; savePrefs(); applyPrefs(app); nb.classList.toggle("is-on", !!prefs.narrow); }, "表示幅をデスクトップ(1200px)と端末幅で切替");
  nb.classList.toggle("is-on", !!prefs.narrow);
  mk("サンプルデータを初期化", () => { if (confirm("サンプルデータを初期化しますか？ 編集内容は失われます。")) reset(); });

  const tab = (host: HTMLElement, l: WorkspaceLeaf, active: boolean) => {
    const t = host.createDiv({ cls: "vgp-tab" + (active ? " is-active" : "") }); const ic = t.createSpan(); setIcon(ic, l.getIcon());
    t.createSpan({ text: l.getDisplayText() || l.view?.getViewType() || "…" });
    t.createSpan({ cls: "vgp-tab-x", text: "×" }).addEventListener("click", (e) => { e.stopPropagation(); void l.detach(); });
    t.addEventListener("click", () => void ws.revealLeaf(l));
  };
  const layout = () => {
    const mains = ws.leaves.filter((l) => l.region === "main"), sides = ws.leaves.filter((l) => l.region !== "main");
    if (!lastMain || !mains.includes(lastMain)) lastMain = mains[mains.length - 1] ?? null;
    if (!lastSide || !sides.includes(lastSide)) lastSide = sides[sides.length - 1] ?? null;
    mainTabs.empty(); sideHead.empty();
    for (const l of mains) { tab(mainTabs, l, l === lastMain); if (l.containerEl.parentElement !== mainPanes) mainPanes.appendChild(l.containerEl); l.containerEl.classList.toggle("is-shown", l === lastMain); }
    for (const l of sides) { tab(sideHead, l, l === lastSide); if (l.containerEl.parentElement !== sidePanes) sidePanes.appendChild(l.containerEl); l.containerEl.classList.toggle("is-shown", l === lastSide); }
    (mainPanes.querySelector(".vgp-empty") as HTMLElement | null)?.style.setProperty("display", mains.length ? "none" : "");
    side.classList.toggle("has-leaves", sides.length > 0);
    if (!sides.length) document.body.classList.remove("vgp-side-open");
    const x = sideHead.createEl("button", { cls: "vgp-side-close", text: "閉じる" }); x.addEventListener("click", () => document.body.classList.remove("vgp-side-open"));
  };
  // A new leaf must be in the DOM (and visible) before its view opens: the Gantt only draws once it has layout.
  ws.on("vgp-leaf-add", (l: WorkspaceLeaf) => {
    (l.region === "main" ? mainPanes : sidePanes).appendChild(l.containerEl);
    if (l.region === "main") lastMain = l; else { lastSide = l; side.classList.add("has-leaves"); document.body.classList.add("vgp-side-open"); }
    layout();
  });
  ws.on("layout-change", layout);
  ws.on("active-leaf-change", (l: WorkspaceLeaf) => { if (l.region === "main") lastMain = l; else lastSide = l; layout(); });
  ws.on("vgp-reveal", (l: WorkspaceLeaf) => { if (l.region !== "main") document.body.classList.add("vgp-side-open"); else document.body.classList.remove("vgp-side-open"); });
  layout();
}

function palette(app: App): void {
  const m = new Modal(app); m.titleEl.setText("コマンド");
  const q = m.contentEl.createEl("input", { type: "search", placeholder: "コマンドを検索…" }); q.style.width = "100%";
  const list = m.contentEl.createDiv();
  const draw = () => { list.empty(); for (const c of Object.values<any>(app.commands.commands).filter((x) => x.name.toLowerCase().includes(q.value.toLowerCase()))) list.createDiv({ cls: "vgp-palette-item", text: c.name }).addEventListener("click", () => { m.close(); app.commands.executeCommandById(c.id); }); };
  q.addEventListener("input", draw); draw(); m.open(); q.focus();
}

boot().catch((e) => { console.error(e); $("vgp-root").createDiv({ cls: "vgp-empty", text: "起動に失敗しました: " + (e?.message ?? e) }); });
