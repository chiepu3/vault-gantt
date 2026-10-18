// Browser stand-in for the "obsidian" module: just enough of the API for the plugin to load and its views to work
// on an in-memory vault. Not emulated: CodeMirror editor, metadataCache beyond frontmatter, Node-only APIs (MCP server), real network.
/* eslint-disable @typescript-eslint/no-explicit-any */
import "./globals";
import momentLib from "moment";
import "moment/locale/ja";
import jsyaml from "js-yaml";
import { iconSvg } from "./icons";

momentLib.locale("ja");
export const moment: any = momentLib;
export type Moment = any;
// Obsidian parses YAML 1.2 core schema: dates stay strings.
export const parseYaml = (s: string): any => jsyaml.load(s, { schema: jsyaml.CORE_SCHEMA });
export const stringifyYaml = (o: any): string => jsyaml.dump(o, { lineWidth: -1 });
export const normalizePath = (p: string): string => p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
export const debounce = <T extends (...a: any[]) => any>(fn: T, ms = 0, reset = false) => {
  let t: any;
  return ((...a: any[]) => { if (t && !reset) return; clearTimeout(t); t = setTimeout(() => { t = undefined; fn(...a); }, ms); }) as T;
};
export const Platform = {
  isDesktop: true, isDesktopApp: false, isMobile: false, isMobileApp: false, isPhone: false, isTablet: false, isIosApp: false, isAndroidApp: false,
  isMacOS: /Mac/.test(navigator.platform), isWin: /Win/.test(navigator.platform), isLinux: /Linux/.test(navigator.platform), isSafari: false, isMobileApp_: false,
};

/** Hooks the shell installs (persistence, settings screen, toasts). */
export const preview: { persist: () => void; secrets: Record<string, string>; codeBlocks: Map<string, any> } = { persist: () => {}, secrets: {}, codeBlocks: new Map() };

// ---------- icons / network ----------
export function setIcon(el: HTMLElement, id: string): void { el.innerHTML = iconSvg(id); }
export function getIcon(id: string): SVGElement { const d = document.createElement("div"); d.innerHTML = iconSvg(id); return d.firstElementChild as SVGElement; }
export function addIcon(): void {}
export async function requestUrl(req: any): Promise<any> {
  const r = typeof req === "string" ? { url: req } : req;
  const res = await fetch(r.url, { method: r.method ?? "GET", headers: { ...(r.headers ?? {}), ...(r.contentType ? { "content-type": r.contentType } : {}) }, body: r.body });
  const buf = await res.arrayBuffer();
  const text = new TextDecoder().decode(buf);
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  if (r.throw !== false && res.status >= 400) throw Object.assign(new Error("Request failed, status " + res.status), { status: res.status });
  return { status: res.status, headers, arrayBuffer: buf, text, get json() { return JSON.parse(text); } };
}

// ---------- events / component ----------
export class Events {
  private _h: Record<string, Array<{ fn: (...a: any[]) => any; ctx?: any }>> = {};
  on(name: string, fn: (...a: any[]) => any, ctx?: any): any { (this._h[name] ??= []).push({ fn, ctx }); return { e: this, name, fn }; }
  off(name: string, fn: (...a: any[]) => any): void { this._h[name] = (this._h[name] ?? []).filter((x) => x.fn !== fn); }
  offref(ref: any): void { this.off(ref.name, ref.fn); }
  trigger(name: string, ...args: any[]): void { for (const h of [...(this._h[name] ?? [])]) { try { h.fn.apply(h.ctx, args); } catch (e) { console.error(e); } } }
  tryTrigger(ref: any, args: any[]): void { try { ref.fn(...args); } catch (e) { console.error(e); } }
}
export class Component {
  _loaded = false; _children: Component[] = []; _cleanups: Array<() => void> = [];
  load(): void { if (this._loaded) return; this._loaded = true; this.onload(); for (const c of this._children) c.load(); }
  unload(): void { if (!this._loaded) return; this._loaded = false; for (const c of [...this._children]) c.unload(); this.onunload(); for (const f of this._cleanups.splice(0).reverse()) { try { f(); } catch (e) { console.error(e); } } }
  onload(): void {}
  onunload(): void {}
  addChild<T extends Component>(c: T): T { this._children.push(c); if (this._loaded) c.load(); return c; }
  removeChild<T extends Component>(c: T): T { this._children = this._children.filter((x) => x !== c); c.unload(); return c; }
  register(cb: () => any): void { this._cleanups.push(cb); }
  registerEvent(ref: any): void { this.register(() => ref.e.offref(ref)); }
  registerDomEvent(el: any, type: string, cb: any, opts?: any): void { el.addEventListener(type, cb, opts); this.register(() => el.removeEventListener(type, cb, opts)); }
  registerInterval(id: number): number { this.register(() => clearInterval(id)); return id; }
}
export class MarkdownRenderChild extends Component { constructor(public containerEl: HTMLElement) { super(); } }

// ---------- files ----------
export class TAbstractFile {
  constructor(public vault: Vault, public path: string) {}
  get name(): string { return this.path.split("/").pop() ?? ""; }
  get parent(): TFolder | null { const i = this.path.lastIndexOf("/"); return this.path === "" ? null : this.vault.getFolderByPath(i < 0 ? "" : this.path.slice(0, i)); }
}
export class TFile extends TAbstractFile {
  stat = { ctime: Date.now(), mtime: Date.now(), size: 0 };
  get extension(): string { const n = this.name, i = n.lastIndexOf("."); return i < 0 ? "" : n.slice(i + 1); }
  get basename(): string { const n = this.name, i = n.lastIndexOf("."); return i < 0 ? n : n.slice(0, i); }
}
export class TFolder extends TAbstractFile {
  get children(): TAbstractFile[] {
    const out: TAbstractFile[] = [], prefix = this.path ? this.path + "/" : "";
    for (const p of this.vault.allPaths()) if (p !== this.path && p.startsWith(prefix) && !p.slice(prefix.length).includes("/")) out.push(this.vault.getAbstractFileByPath(p)!);
    return out;
  }
  isRoot(): boolean { return this.path === ""; }
}

class Adapter {
  constructor(private v: Vault) {}
  async exists(p: string): Promise<boolean> { return !!this.v.getAbstractFileByPath(normalizePath(p)); }
  async read(p: string): Promise<string> { return this.v.read(this.v.getFileByPath(normalizePath(p))!); }
  async write(p: string, data: string): Promise<void> { const f = this.v.getFileByPath(normalizePath(p)); f ? await this.v.modify(f, data) : await this.v.create(normalizePath(p), data); }
  async stat(p: string): Promise<any> { const f = this.v.getFileByPath(normalizePath(p)); return f ? { type: "file", ...f.stat } : null; }
  async mkdir(p: string): Promise<void> { await this.v.createFolder(normalizePath(p)); }
  async remove(p: string): Promise<void> { const f = this.v.getFileByPath(normalizePath(p)); if (f) await this.v.delete(f); }
  async list(p: string): Promise<{ files: string[]; folders: string[] }> {
    const dir = this.v.getFolderByPath(normalizePath(p)); const c = dir?.children ?? [];
    return { files: c.filter((x) => x instanceof TFile).map((x) => x.path), folders: c.filter((x) => x instanceof TFolder).map((x) => x.path) };
  }
  getName(): string { return "preview"; }
  getResourcePath(p: string): string { return p; }
}

export class Vault extends Events {
  private content = new Map<string, string>();
  private objs = new Map<string, TAbstractFile>();
  private folders = new Set<string>([""]);
  adapter: any = new Adapter(this);
  configDir = ".obsidian";
  load(files: Record<string, string>): void { for (const [p, c] of Object.entries(files)) this.put(p, c); }
  dump(): Record<string, string> { return Object.fromEntries(this.content); }
  allPaths(): string[] { return [...this.folders, ...this.content.keys()]; }
  private put(path: string, data: string): TFile {
    const parts = path.split("/"); for (let i = 1; i < parts.length; i++) this.folders.add(parts.slice(0, i).join("/"));
    let f = this.objs.get(path) as TFile | undefined;
    if (!f) { f = new TFile(this, path); this.objs.set(path, f); }
    this.content.set(path, data); f.stat.mtime = Date.now(); f.stat.size = data.length;
    return f;
  }
  getName(): string { return "サンプルVault"; }
  getRoot(): TFolder { return this.getFolderByPath("")!; }
  getAbstractFileByPath(path: string): TAbstractFile | null {
    path = path.replace(/^\/+/, "");
    if (this.content.has(path)) return this.objs.get(path)!;
    if (this.folders.has(path)) { let f = this.objs.get("dir:" + path); if (!f) { f = new TFolder(this, path); this.objs.set("dir:" + path, f); } return f; }
    return null;
  }
  getFileByPath(p: string): TFile | null { const f = this.getAbstractFileByPath(p); return f instanceof TFile ? f : null; }
  getFolderByPath(p: string): TFolder | null { const f = this.getAbstractFileByPath(p); return f instanceof TFolder ? f : null; }
  getFiles(): TFile[] { return [...this.content.keys()].map((p) => this.objs.get(p) as TFile); }
  getMarkdownFiles(): TFile[] { return this.getFiles().filter((f) => f.extension === "md"); }
  getAllLoadedFiles(): TAbstractFile[] { return this.allPaths().map((p) => this.getAbstractFileByPath(p)!); }
  async read(f: TFile): Promise<string> { const c = this.content.get(f.path); if (c === undefined) throw new Error("ENOENT: " + f.path); return c; }
  cachedRead(f: TFile): Promise<string> { return this.read(f); }
  async create(path: string, data: string): Promise<TFile> {
    path = path.replace(/^\/+/, "");
    if (this.getAbstractFileByPath(path)) throw new Error("File already exists.");
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (!this.folders.has(dir)) throw new Error("ENOENT: no such file or directory, open '" + path + "'");
    const f = this.put(path, data); f.stat.ctime = f.stat.mtime; this.trigger("create", f); preview.persist(); return f;
  }
  async createFolder(path: string): Promise<TFolder> {
    path = path.replace(/^\/+|\/+$/g, "");
    if (this.folders.has(path)) throw new Error("Folder already exists.");
    const parts = path.split("/"); for (let i = 1; i <= parts.length; i++) this.folders.add(parts.slice(0, i).join("/"));
    const f = this.getFolderByPath(path)!; this.trigger("create", f); return f;
  }
  async modify(f: TFile, data: string): Promise<void> { if (!this.content.has(f.path)) throw new Error("ENOENT: " + f.path); this.put(f.path, data); this.trigger("modify", f); preview.persist(); }
  async process(f: TFile, fn: (d: string) => string): Promise<string> { const next = fn(await this.read(f)); await this.modify(f, next); return next; }
  async append(f: TFile, data: string): Promise<void> { await this.modify(f, (await this.read(f)) + data); }
  async delete(f: TAbstractFile): Promise<void> {
    if (f instanceof TFolder) { for (const c of f.children) await this.delete(c); this.folders.delete(f.path); this.objs.delete("dir:" + f.path); }
    else { this.content.delete(f.path); this.objs.delete(f.path); }
    this.trigger("delete", f); preview.persist();
  }
  trash(f: TAbstractFile): Promise<void> { return this.delete(f); }
  /** Renames a file or a folder (with everything in it). Like Obsidian's "automatically update internal links", [[old]] becomes [[new]] in other notes. */
  async rename(f: TAbstractFile, newPath: string): Promise<void> {
    const old = f.path; newPath = newPath.replace(/^\/+/, "");
    if (this.getAbstractFileByPath(newPath)) throw new Error("Destination file already exists!");
    const moves: Array<[string, string]> = f instanceof TFile ? [[old, newPath]] : [...this.content.keys()].filter((p) => p.startsWith(old + "/")).map((p) => [p, newPath + p.slice(old.length)] as [string, string]);
    if (f instanceof TFolder) {
      for (const dir of [...this.folders]) if (dir === old || dir.startsWith(old + "/")) { this.folders.delete(dir); this.objs.delete("dir:" + dir); }
      f.path = newPath; this.objs.set("dir:" + newPath, f);
      const parts = newPath.split("/"); for (let i = 1; i <= parts.length; i++) this.folders.add(parts.slice(0, i).join("/"));
    }
    const base = (p: string) => p.split("/").pop()!.replace(/\.md$/, "");
    for (const [from, to] of moves) {
      const file = this.objs.get(from) as TFile; const c = this.content.get(from)!;
      this.content.delete(from); this.objs.delete(from); file.path = to; this.objs.set(to, file); this.put(to, c);
      const dir = to.includes("/") ? to.slice(0, to.lastIndexOf("/")) : ""; const segs = dir.split("/");
      for (let i = 1; i <= segs.length; i++) this.folders.add(segs.slice(0, i).join("/"));
    }
    for (const [from, to] of moves) {
      if (base(from) !== base(to)) for (const [p, text] of [...this.content]) {
        if (!p.endsWith(".md") || !text.includes(`[[${base(from)}`)) continue;
        const next = text.split(`[[${base(from)}]]`).join(`[[${base(to)}]]`).split(`[[${base(from)}|`).join(`[[${base(to)}|`);
        if (next !== text) { this.put(p, next); this.trigger("modify", this.objs.get(p)); }
      }
      this.trigger("rename", this.objs.get(to), from);
    }
    if (f instanceof TFolder) this.trigger("rename", f, old);
    preview.persist();
  }
  async copy(f: TFile, p: string): Promise<TFile> { return this.create(p, await this.read(f)); }
  getConfig(): any { return undefined; }
}

export class MetadataCache extends Events {
  private cache = new Map<string, { text: string; value: any }>();
  constructor(private vault: Vault) {
    super();
    // Like Obsidian, the cache catches up shortly after a file changes and then announces it.
    const changed = (f: any) => { if (f instanceof TFile && f.extension === "md") setTimeout(() => this.trigger("changed", f, "", this.getFileCache(f)), 0); };
    vault.on("create", changed); vault.on("modify", changed);
    vault.on("delete", (f: any) => { this.cache.delete(f.path); this.trigger("deleted", f, null); });
    vault.on("rename", (f: any, old: string) => { this.cache.delete(old); });
  }
  resolvedLinks: Record<string, Record<string, number>> = {};
  unresolvedLinks: Record<string, Record<string, number>> = {};
  private nameIndex: { size: number; keys: string; map: Map<string, TFile[]> } | null = null;
  /** Markdown files by basename; rebuilt when the set of paths changes (cheap check: count plus first/last path). */
  private byBasename(name: string): TFile[] {
    const content = (this.vault as any).content as Map<string, string>;
    const keys = [...content.keys()];
    const stamp = `${keys[0]}|${keys[keys.length - 1]}`;
    if (!this.nameIndex || this.nameIndex.size !== keys.length || this.nameIndex.keys !== stamp) {
      const map = new Map<string, TFile[]>();
      for (const f of this.vault.getMarkdownFiles()) { const list = map.get(f.basename); if (list) list.push(f); else map.set(f.basename, [f]); }
      this.nameIndex = { size: keys.length, keys: stamp, map };
    }
    return this.nameIndex.map.get(name) ?? [];
  }
  /** The note nearest to the one linking (same folder first, then shorter paths), like Obsidian's link resolution. */
  getFirstLinkpathDest(link: string, sourcePath = ""): TFile | null {
    const l = link.split("#")[0].replace(/\.md$/, "");
    const exact = this.vault.getFileByPath(l + ".md");
    if (exact) return exact;
    const dir = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
    const matches = this.byBasename(l.split("/").pop() ?? l).filter((f) => f.basename === l || f.path.endsWith("/" + l + ".md"));
    const near = (f: TFile) => (f.path.startsWith(dir + "/") || dir === "" ? 0 : 1);
    return matches.sort((a, b) => near(a) - near(b) || a.path.length - b.path.length || a.path.localeCompare(b.path))[0] ?? null;
  }
  /** Frontmatter only (that is all the plugin reads from the cache). Parsed from the file text, memoized per text. */
  getFileCache(f: TFile): any {
    const text = (this.vault as any).content.get(f.path) as string | undefined;
    if (text === undefined) return null;
    const hit = this.cache.get(f.path);
    if (hit && hit.text === text) return hit.value;
    const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
    let frontmatter: any;
    if (m) { try { const v = parseYaml(m[1]); if (v && typeof v === "object") frontmatter = v; } catch { /* invalid YAML: no frontmatter */ } }
    const value = frontmatter ? { frontmatter } : {};
    this.cache.set(f.path, { text, value });
    return value;
  }
  getCache(): any { return null; }
  fileToLinktext(f: TFile): string { return f.basename; }
}

// ---------- notice / modal / menu / setting ----------
function noticeHost(): HTMLElement { return (document.querySelector(".notice-container") as HTMLElement) ?? document.body.createDiv("notice-container"); }
export class Notice {
  noticeEl: HTMLElement; private timer: any;
  constructor(message: string | DocumentFragment, duration = 5000) {
    this.noticeEl = noticeHost().createDiv("notice");
    this.setMessage(message);
    this.noticeEl.addEventListener("click", () => this.hide());
    if (duration > 0) this.timer = setTimeout(() => this.hide(), duration);
  }
  setMessage(m: string | DocumentFragment): this { this.noticeEl.empty(); this.noticeEl.createDiv("notice-message").setText(m); return this; }
  hide(): void { clearTimeout(this.timer); this.noticeEl.remove(); }
}

export class Scope {
  keys: Array<{ modifiers: string[]; key: string | null; func: (e: KeyboardEvent, c: any) => any }> = [];
  constructor(public parent?: Scope) {}
  register(modifiers: string[] | null, key: string | null, func: any): any { const h = { modifiers: modifiers ?? [], key, func }; this.keys.push(h); return h; }
  unregister(h: any): void { this.keys = this.keys.filter((k) => k !== h); }
}
const modalStack: Modal[] = [];
document.addEventListener("keydown", (e) => {
  const m = modalStack[modalStack.length - 1]; if (!m) return;
  for (const k of m.scope.keys) if ((k.key === null || k.key === e.key) && k.modifiers.every((x) => (x === "Mod" ? e.ctrlKey || e.metaKey : x === "Shift" ? e.shiftKey : x === "Alt" ? e.altKey : true))) { if (k.func(e, {}) === false) { e.preventDefault(); return; } }
  if (e.key === "Escape") { e.preventDefault(); m.close(); }
});
export class Modal {
  containerEl: HTMLElement; modalEl: HTMLElement; titleEl: HTMLElement; contentEl: HTMLElement; scope = new Scope(); shouldRestoreSelection = false;
  constructor(public app: App) {
    this.containerEl = createDiv("modal-container mod-dim");
    this.containerEl.createDiv("modal-bg").addEventListener("click", () => this.close());
    this.modalEl = this.containerEl.createDiv("modal");
    this.modalEl.createDiv("modal-close-button").addEventListener("click", () => this.close());
    this.titleEl = this.modalEl.createDiv("modal-title");
    this.contentEl = this.modalEl.createDiv("modal-content");
  }
  open(): void { document.body.appendChild(this.containerEl); modalStack.push(this); void this.onOpen(); }
  close(): void { const i = modalStack.indexOf(this); if (i < 0) return; modalStack.splice(i, 1); this.containerEl.remove(); void this.onClose(); }
  onOpen(): any {}
  onClose(): any {}
  setTitle(t: string): this { this.titleEl.setText(t); return this; }
  setContent(c: string | DocumentFragment): this { this.contentEl.setText(c); return this; }
}

export class MenuItem {
  dom: HTMLElement; submenu?: Menu; private disabled = false; private titleEl: HTMLElement; private iconEl: HTMLElement; private cb?: (e: any) => any;
  constructor(public menu: Menu) {
    this.dom = createDiv("menu-item tappable");
    this.iconEl = this.dom.createDiv("menu-item-icon"); this.titleEl = this.dom.createDiv("menu-item-title");
    this.dom.addEventListener("click", (e) => {
      if (this.disabled) return;
      if (this.submenu) { menu.openSub(this); return; }
      this.cb?.(e); menu.hideAll();
    });
    this.dom.addEventListener("mouseenter", () => this.submenu && menu.openSub(this));
  }
  setTitle(t: string | DocumentFragment): this { this.titleEl.setText(t); return this; }
  setIcon(i: string | null): this { this.iconEl.empty(); if (i) setIcon(this.iconEl, i); return this; }
  setChecked(c: boolean | null): this { this.dom.classList.toggle("is-checked", c === true); if (c !== null) { this.iconEl.empty(); if (c) setIcon(this.iconEl, "check"); } return this; }
  setDisabled(d: boolean): this { this.disabled = d; this.dom.classList.toggle("is-disabled", d); return this; }
  setWarning(w: boolean): this { this.dom.classList.toggle("is-warning", w); return this; }
  setIsLabel(l: boolean): this { this.dom.classList.toggle("is-label", l); return this; }
  setSection(): this { return this; }
  setSubmenu(): Menu { this.submenu ??= new Menu(); this.submenu.parentMenu = this.menu; this.dom.classList.add("has-submenu"); return this.submenu; }
  onClick(cb: (e: any) => any): this { this.cb = cb; return this; }
}
export class Menu extends Component {
  dom = createDiv("menu"); parentMenu?: Menu; private sub?: Menu; private hideCbs: Array<() => any> = []; private away?: (e: Event) => void;
  private items: MenuItem[] = [];
  setNoIcon(): this { return this; }
  setUseNativeMenu(): this { return this; }
  setParentElement(): this { return this; }
  addItem(cb: (i: MenuItem) => any): this { const i = new MenuItem(this); this.items.push(i); this.dom.appendChild(i.dom); cb(i); return this; }
  addSeparator(): this { this.dom.createDiv("menu-separator"); return this; }
  openSub(item: MenuItem): void {
    if (this.sub === item.submenu) return; this.sub?.hide();
    this.sub = item.submenu; const r = item.dom.getBoundingClientRect(); item.submenu!.showAtPosition({ x: r.right - 4, y: r.top - 4 });
  }
  showAtMouseEvent(e: MouseEvent): this { return this.showAtPosition({ x: e.clientX, y: e.clientY }); }
  showAtPosition(p: { x: number; y: number }): this {
    document.body.appendChild(this.dom);
    const r = this.dom.getBoundingClientRect();
    this.dom.style.left = Math.max(4, Math.min(p.x, innerWidth - r.width - 4)) + "px";
    this.dom.style.top = Math.max(4, Math.min(p.y, innerHeight - r.height - 4)) + "px";
    if (!this.away && !this.parentMenu) {
      this.away = (e: Event) => { if (!this.contains(e.target as Node)) this.hide(); };
      setTimeout(() => this.away && document.addEventListener("mousedown", this.away, true), 0);
    }
    return this;
  }
  private contains(n: Node): boolean { return this.dom.contains(n) || (this.sub?.contains(n) ?? false); }
  hideAll(): void { let m: Menu = this; while (m.parentMenu) m = m.parentMenu; m.hide(); }
  hide(): this {
    this.sub?.hide(); this.sub = undefined;
    if (this.away) document.removeEventListener("mousedown", this.away, true); this.away = undefined;
    if (this.parentMenu?.sub === this) this.parentMenu.sub = undefined;
    if (this.dom.isConnected) { this.dom.remove(); for (const f of this.hideCbs.splice(0)) f(); }
    return this;
  }
  close(): void { this.hide(); }
  onHide(cb: () => any): void { this.hideCbs.push(cb); }
  static forEvent(): Menu { return new Menu(); }
}

// Setting + components (DOM mirrors Obsidian's so the app stylesheet and the plugin's own CSS selectors line up).
class Base<T extends HTMLElement> { disabled = false; constructor(public el: T) {} setDisabled(d: boolean): this { this.disabled = d; (this.el as any).disabled = d; this.el.classList.toggle("is-disabled", d); return this; } setTooltip(t: string): this { this.el.title = t; this.el.setAttribute("aria-label", t); return this; } }
export class TextComponent extends Base<HTMLInputElement> {
  inputEl: HTMLInputElement;
  constructor(parent: HTMLElement) { const el = parent.createEl("input", { type: "text" }); super(el); this.inputEl = el; }
  getValue(): string { return this.inputEl.value; }
  setValue(v: string): this { this.inputEl.value = v; return this; }
  setPlaceholder(p: string): this { this.inputEl.placeholder = p; return this; }
  onChange(cb: (v: string) => any): this { this.inputEl.addEventListener("input", () => cb(this.inputEl.value)); return this; }
  onChanged(): void {}
}
export class TextAreaComponent extends Base<HTMLTextAreaElement> {
  inputEl: HTMLTextAreaElement;
  constructor(parent: HTMLElement) { const el = parent.createEl("textarea"); super(el); this.inputEl = el; }
  getValue(): string { return this.inputEl.value; }
  setValue(v: string): this { this.inputEl.value = v; return this; }
  setPlaceholder(p: string): this { this.inputEl.placeholder = p; return this; }
  onChange(cb: (v: string) => any): this { this.inputEl.addEventListener("input", () => cb(this.inputEl.value)); return this; }
}
export class ToggleComponent extends Base<HTMLElement> {
  toggleEl: HTMLElement; private on = false; private cb?: (v: boolean) => any; private input: HTMLInputElement;
  constructor(parent: HTMLElement) {
    const el = parent.createDiv("checkbox-container"); super(el); this.toggleEl = el;
    this.input = el.createEl("input", { type: "checkbox" }); this.input.tabIndex = 0;
    el.addEventListener("click", (e) => { e.preventDefault(); if (this.disabled) return; this.setValue(!this.on); this.cb?.(this.on); });
  }
  getValue(): boolean { return this.on; }
  setValue(v: boolean): this { this.on = v; this.input.checked = v; this.toggleEl.classList.toggle("is-enabled", v); return this; }
  onChange(cb: (v: boolean) => any): this { this.cb = cb; return this; }
}
export class DropdownComponent extends Base<HTMLSelectElement> {
  selectEl: HTMLSelectElement;
  constructor(parent: HTMLElement) { const el = parent.createEl("select", { cls: "dropdown" }); super(el); this.selectEl = el; }
  addOption(v: string, d: string): this { this.selectEl.createEl("option", { value: v, text: d }); return this; }
  addOptions(o: Record<string, string>): this { for (const [k, v] of Object.entries(o)) this.addOption(k, v); return this; }
  getValue(): string { return this.selectEl.value; }
  setValue(v: string): this { this.selectEl.value = v; return this; }
  onChange(cb: (v: string) => any): this { this.selectEl.addEventListener("change", () => cb(this.selectEl.value)); return this; }
}
export class ColorComponent extends Base<HTMLInputElement> {
  colorPickerEl: HTMLInputElement;
  constructor(parent: HTMLElement) { const el = parent.createEl("input", { type: "color" }); super(el); this.colorPickerEl = el; }
  getValue(): string { return this.colorPickerEl.value; }
  setValue(v: string): this { this.colorPickerEl.value = v; return this; }
  onChange(cb: (v: string) => any): this { this.colorPickerEl.addEventListener("input", () => cb(this.colorPickerEl.value)); return this; }
}
export class SliderComponent extends Base<HTMLInputElement> {
  sliderEl: HTMLInputElement;
  constructor(parent: HTMLElement) { const el = parent.createEl("input", { type: "range", cls: "slider" }); super(el); this.sliderEl = el; }
  setLimits(min: number, max: number, step: number | "any"): this { Object.assign(this.sliderEl, { min: String(min), max: String(max), step: String(step) }); return this; }
  getValue(): number { return Number(this.sliderEl.value); }
  setValue(v: number): this { this.sliderEl.value = String(v); return this; }
  setDynamicTooltip(): this { return this; }
  onChange(cb: (v: number) => any): this { this.sliderEl.addEventListener("input", () => cb(this.getValue())); return this; }
}
export class SearchComponent extends TextComponent { constructor(p: HTMLElement) { super(p); this.inputEl.type = "search"; } }
export class ButtonComponent extends Base<HTMLButtonElement> {
  buttonEl: HTMLButtonElement;
  constructor(parent: HTMLElement) { const el = parent.createEl("button"); super(el); this.buttonEl = el; }
  setButtonText(t: string): this { this.buttonEl.setText(t); return this; }
  setCta(): this { this.buttonEl.classList.add("mod-cta"); return this; }
  removeCta(): this { this.buttonEl.classList.remove("mod-cta"); return this; }
  setWarning(): this { this.buttonEl.classList.add("mod-warning"); return this; }
  setIcon(i: string): this { setIcon(this.buttonEl, i); return this; }
  onClick(cb: (e: MouseEvent) => any): this { this.buttonEl.addEventListener("click", cb); return this; }
}
export class ExtraButtonComponent extends Base<HTMLElement> {
  extraSettingsEl: HTMLElement;
  constructor(parent: HTMLElement) { const el = parent.createDiv("clickable-icon extra-setting-button"); super(el); this.extraSettingsEl = el; }
  setIcon(i: string): this { setIcon(this.extraSettingsEl, i); return this; }
  onClick(cb: () => any): this { this.extraSettingsEl.addEventListener("click", () => cb()); return this; }
}
export class Setting {
  settingEl: HTMLElement; infoEl: HTMLElement; nameEl: HTMLElement; descEl: HTMLElement; controlEl: HTMLElement; components: any[] = [];
  constructor(public containerEl: HTMLElement) {
    this.settingEl = containerEl.createDiv("setting-item");
    this.infoEl = this.settingEl.createDiv("setting-item-info");
    this.nameEl = this.infoEl.createDiv("setting-item-name");
    this.descEl = this.infoEl.createDiv("setting-item-description");
    this.controlEl = this.settingEl.createDiv("setting-item-control");
  }
  setName(n: string | DocumentFragment): this { this.nameEl.setText(n); return this; }
  setDesc(d: string | DocumentFragment): this { this.descEl.setText(d); return this; }
  setClass(c: string): this { this.settingEl.classList.add(c); return this; }
  setTooltip(t: string): this { this.settingEl.title = t; return this; }
  setHeading(): this { this.settingEl.classList.add("setting-item-heading"); return this; }
  setDisabled(d: boolean): this { this.settingEl.classList.toggle("is-disabled", d); return this; }
  clear(): this { this.controlEl.empty(); return this; }
  then(cb: (s: this) => any): this { cb(this); return this; }
  private add<C>(c: C, cb?: (c: C) => any): this { this.components.push(c); cb?.(c); return this; }
  addText(cb: (c: TextComponent) => any): this { return this.add(new TextComponent(this.controlEl), cb); }
  addTextArea(cb: (c: TextAreaComponent) => any): this { return this.add(new TextAreaComponent(this.controlEl), cb); }
  addSearch(cb: (c: SearchComponent) => any): this { return this.add(new SearchComponent(this.controlEl), cb); }
  addToggle(cb: (c: ToggleComponent) => any): this { return this.add(new ToggleComponent(this.controlEl), cb); }
  addDropdown(cb: (c: DropdownComponent) => any): this { return this.add(new DropdownComponent(this.controlEl), cb); }
  addColorPicker(cb: (c: ColorComponent) => any): this { return this.add(new ColorComponent(this.controlEl), cb); }
  addSlider(cb: (c: SliderComponent) => any): this { return this.add(new SliderComponent(this.controlEl), cb); }
  addButton(cb: (c: ButtonComponent) => any): this { return this.add(new ButtonComponent(this.controlEl), cb); }
  addExtraButton(cb: (c: ExtraButtonComponent) => any): this { return this.add(new ExtraButtonComponent(this.controlEl), cb); }
}

// ---------- workspace ----------
export class WorkspaceLeaf extends Events {
  view: any = null; containerEl = createDiv("workspace-leaf"); private resizer?: ResizeObserver; id = Math.random().toString(36).slice(2);
  constructor(public app: App, public region: "main" | "right" | "left") { super(); }
  getViewState(): any { return { type: this.view?.getViewType() ?? "empty", state: this.view?.getState?.() ?? {}, active: this.app.workspace.activeLeaf === this }; }
  async setViewState(vs: { type: string; state?: any; active?: boolean }, eState?: any): Promise<void> {
    if (this.view?.getViewType() === vs.type) { if (vs.state) await this.view.setState?.(vs.state, {}); if (vs.active) this.app.workspace.setActiveLeaf(this); this.app.workspace.trigger("layout-change"); return; }
    await this.teardown();
    const make = this.app.workspace.viewRegistry.get(vs.type);
    if (!make) throw new Error("View type not registered: " + vs.type);
    this.view = make(this); this.containerEl.appendChild(this.view.containerEl);
    this.view.load(); await this.view.onOpen();
    this.resizer ??= new ResizeObserver(() => this.view?.onResize?.()); this.resizer.observe(this.containerEl); await this.view.setState?.(vs.state ?? {}, eState ?? {});
    if (vs.active !== false) this.app.workspace.setActiveLeaf(this);
    this.app.workspace.trigger("layout-change");
  }
  private async teardown(): Promise<void> { if (!this.view) return; const v = this.view; this.view = null; try { await v.onClose(); } catch (e) { console.error(e); } v.unload(); v.containerEl.remove(); }
  async openFile(file: TFile, state?: any): Promise<void> { await this.setViewState({ type: "markdown", state: { file: file.path, ...(state?.eState ? { eState: state.eState } : {}) }, active: true }, state?.eState); this.app.workspace.trigger("file-open", file); }
  getDisplayText(): string { return this.view?.getDisplayText?.() ?? ""; }
  getIcon(): string { return this.view?.getIcon?.() ?? "file"; }
  async detach(): Promise<void> { await this.app.workspace.removeLeaf(this); }
  async close(): Promise<void> { this.resizer?.disconnect(); await this.teardown(); this.containerEl.remove(); }
  getRoot(): any { return this.app.workspace; }
  setPinned(): void {}
}
export class Workspace extends Events {
  viewRegistry = new Map<string, (leaf: WorkspaceLeaf) => any>();
  leaves: WorkspaceLeaf[] = []; activeLeaf: WorkspaceLeaf | null = null; activeFile: TFile | null = null; layoutReady = true;
  constructor(public app: App) { super(); }
  registerView(type: string, creator: (leaf: WorkspaceLeaf) => any): void { this.viewRegistry.set(type, creator); }
  unregisterView(type: string): void { this.viewRegistry.delete(type); }
  private add(region: "main" | "right" | "left"): WorkspaceLeaf { const l = new WorkspaceLeaf(this.app, region); this.leaves.push(l); this.trigger("vgp-leaf-add", l); return l; }
  getLeaf(newLeaf?: boolean | string): WorkspaceLeaf {
    const main = this.leaves.filter((l) => l.region === "main");
    if (!newLeaf && this.activeLeaf?.region === "main") return this.activeLeaf;
    if (!newLeaf && main[0]) return main[main.length - 1];
    return this.add("main");
  }
  getRightLeaf(): WorkspaceLeaf { return this.add("right"); }
  getLeftLeaf(): WorkspaceLeaf { return this.add("left"); }
  getMostRecentLeaf(): WorkspaceLeaf | null { return this.activeLeaf?.region === "main" ? this.activeLeaf : this.leaves.filter((l) => l.region === "main").pop() ?? null; }
  getLeavesOfType(type: string): WorkspaceLeaf[] { return this.leaves.filter((l) => l.view?.getViewType() === type); }
  iterateAllLeaves(cb: (l: WorkspaceLeaf) => any): void { this.leaves.forEach(cb); }
  setActiveLeaf(leaf: WorkspaceLeaf): void { this.activeLeaf = leaf; const f = leaf.view?.file; if (f instanceof TFile) this.activeFile = f; this.trigger("active-leaf-change", leaf); }
  async revealLeaf(leaf: WorkspaceLeaf): Promise<void> { this.setActiveLeaf(leaf); this.trigger("layout-change"); this.trigger("vgp-reveal", leaf); }
  getActiveFile(): TFile | null { return this.activeFile; }
  getActiveViewOfType(t: any): any { return this.activeLeaf?.view instanceof t ? this.activeLeaf.view : null; }
  async removeLeaf(leaf: WorkspaceLeaf): Promise<void> { this.leaves = this.leaves.filter((l) => l !== leaf); if (this.activeLeaf === leaf) this.activeLeaf = this.leaves.filter((l) => l.region === "main").pop() ?? null; await leaf.close(); this.trigger("layout-change"); }
  detachLeavesOfType(type: string): void { for (const l of this.getLeavesOfType(type)) void this.removeLeaf(l); }
  onLayoutReady(cb: () => any): void { queueMicrotask(cb); }
  async openLinkText(link: string, _source?: string, newLeaf?: boolean | string, state?: any): Promise<void> {
    const [path, anchor] = link.split("#"); const clean = path.replace(/\.md$/, "");
    const file = this.app.metadataCache.getFirstLinkpathDest(clean);
    if (!file) throw new Error("Note not found: " + link);
    const leaf = this.getLeaf(newLeaf === undefined ? false : newLeaf);
    await leaf.openFile(file, { eState: { ...(state?.eState ?? {}), ...(anchor ? { heading: anchor } : {}) } });
    await this.revealLeaf(leaf);
  }
}

// ---------- views ----------
export class View extends Component {
  app: App; containerEl: HTMLElement; contentEl: HTMLElement; scope = new Scope(); navigation = true; icon = "file";
  constructor(public leaf: WorkspaceLeaf) {
    super(); this.app = leaf.app;
    this.containerEl = createDiv("workspace-leaf-content");
    const head = this.containerEl.createDiv("view-header");
    head.createDiv("view-header-title-container").createDiv("view-header-title");
    head.createDiv("view-actions");
    this.contentEl = this.containerEl.createDiv("view-content");
    queueMicrotask(() => this.containerEl.setAttribute("data-type", this.getViewType()));
  }
  getViewType(): string { return ""; }
  getDisplayText(): string { return ""; }
  getIcon(): string { return this.icon; }
  getState(): any { return {}; }
  setState(_s: any, _r: any): Promise<void> | void {}
  onOpen(): Promise<void> | void {}
  onClose(): Promise<void> | void {}
  onResize(): void {}
  addAction(icon: string, title: string, cb: (e: MouseEvent) => any): HTMLElement { const b = this.containerEl.querySelector(".view-actions")!.createDiv("clickable-icon view-action"); b.title = title; setIcon(b, icon); b.addEventListener("click", cb); return b; }
}
export class ItemView extends View {}
export class FileView extends ItemView { file: TFile | null = null; }

/** Minimal note viewer/editor: the stand-in for Obsidian's markdown view (openLinkText, task notes, daily notes). */
class NoteView extends FileView {
  private mode: "read" | "edit" = "read"; private body!: HTMLElement; private text = ""; private eState: any = {};
  getViewType(): string { return "markdown"; }
  getDisplayText(): string { return this.file?.basename ?? "ノート"; }
  getState(): any { return { file: this.file?.path }; }
  async setState(s: any, eState: any): Promise<void> {
    this.file = s.file ? this.app.vault.getFileByPath(s.file) : null; this.eState = eState ?? s.eState ?? {};
    this.contentEl.addClass("vgp-note");
    if (this.file) this.text = await this.app.vault.read(this.file);
    this.render();
  }
  private render(): void {
    const el = this.contentEl; el.empty();
    const bar = el.createDiv("vgp-note-bar");
    bar.createSpan({ cls: "vgp-note-path", text: this.file?.path ?? "(なし)" });
    const toggle = bar.createEl("button", { text: this.mode === "read" ? "編集" : "閲覧" });
    toggle.addEventListener("click", () => { this.mode = this.mode === "read" ? "edit" : "read"; this.render(); });
    this.body = el.createDiv("vgp-note-body");
    if (this.mode === "edit") {
      const ta = this.body.createEl("textarea", { cls: "vgp-note-edit" }); ta.value = this.text; ta.spellcheck = false;
      const save = debounce(async () => { if (this.file) { this.text = ta.value; await this.app.vault.modify(this.file, ta.value); } }, 400, true);
      ta.addEventListener("input", save);
    } else { renderMarkdown(this.text, this.body, this.file?.path ?? ""); const h = this.eState?.heading; if (h) setTimeout(() => [...this.body.querySelectorAll("h1,h2,h3,h4")].find((x) => x.textContent === h)?.scrollIntoView(), 0); }
  }
}

function inline(s: string): string {
  const esc = s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return esc.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, l, a) => `<a class="internal-link" data-href="${l}">${a ?? l}</a>`);
}
/** Tiny markdown renderer: headings, lists, callouts/quotes, fenced code (with registered code block processors), frontmatter. */
export function renderMarkdown(src: string, host: HTMLElement, sourcePath: string): void {
  host.empty();
  let lines = src.split("\n");
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (fm) { host.createEl("details", { cls: "vgp-fm" }).innerHTML = `<summary>プロパティ</summary><pre>${fm[1].replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`; lines = src.slice(fm[0].length).split("\n"); }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], f = /^```(\S*)/.exec(l);
    if (f) {
      const code: string[] = []; for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      const proc = preview.codeBlocks.get(f[1]);
      if (proc) { const d = host.createDiv(); try { void proc(code.join("\n"), d, { sourcePath }); } catch (e) { d.setText(String(e)); } }
      else if (f[1] !== "meta-bind-button") host.createEl("pre").createEl("code", { text: code.join("\n") });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)/.exec(l);
    if (h) { host.createEl(("h" + h[1].length) as any).innerHTML = inline(h[2]); continue; }
    if (l.startsWith(">")) { host.createEl("blockquote").innerHTML = inline(l.replace(/^>\s?/, "")); continue; }
    const li = /^(\s*)[-*]\s+(?:\[( |x)\]\s+)?(.*)/.exec(l);
    if (li) { const d = host.createDiv("vgp-li"); d.style.marginLeft = li[1].length * 6 + "px"; d.innerHTML = (li[2] ? `<input type="checkbox" disabled ${li[2] === "x" ? "checked" : ""}> ` : "• ") + inline(li[3]); continue; }
    if (l.trim()) host.createEl("p").innerHTML = inline(l);
  }
  host.querySelectorAll("a.internal-link").forEach((a) => a.addEventListener("click", () => void (window as any).app.workspace.openLinkText(a.getAttribute("data-href"), sourcePath)));
}
export const MarkdownRenderer = { render: async (_app: any, md: string, el: HTMLElement, path: string) => renderMarkdown(md, el, path), renderMarkdown: async (md: string, el: HTMLElement, path: string) => renderMarkdown(md, el, path) };

class SettingsView extends ItemView {
  getViewType(): string { return "vgp-settings"; }
  getDisplayText(): string { return "設定"; }
  getIcon(): string { return "settings"; }
  async setState(s: any): Promise<void> {
    const { app } = this, el = this.contentEl; el.empty(); el.addClass("vgp-settings");
    const tabs: PluginSettingTab[] = app.setting.tabs;
    const nav = el.createDiv("vgp-settings-nav"), pane = el.createDiv("vertical-tab-content");
    const show = (t: PluginSettingTab) => { pane.empty(); pane.appendChild(t.containerEl); t.containerEl.empty(); t.display(); nav.findAll(".vertical-tab-nav-item").forEach((n) => n.toggleClass("is-active", n.textContent === t.name)); };
    for (const t of tabs) nav.createDiv({ cls: "vertical-tab-nav-item", text: t.name }).addEventListener("click", () => show(t));
    const t = tabs.find((x) => x.id === s?.tab) ?? tabs[0]; if (t) show(t);
  }
  getState(): any { return {}; }
}
class NoteListView extends ItemView {
  getViewType(): string { return "vgp-notes"; }
  getDisplayText(): string { return "ノート一覧"; }
  getIcon(): string { return "folder"; }
  onOpen(): void {
    const el = this.contentEl; el.addClass("vgp-notelist");
    const q = el.createEl("input", { type: "search", placeholder: "ノートを検索…", cls: "vgp-notelist-q" }), list = el.createDiv("vgp-notelist-items");
    const draw = () => {
      list.empty(); const term = q.value.toLowerCase();
      for (const f of this.app.vault.getFiles().filter((x) => x.path.toLowerCase().includes(term)).sort((a, b) => a.path.localeCompare(b.path))) {
        const row = list.createDiv({ cls: "vgp-notelist-row" }); row.createSpan({ cls: "vgp-notelist-name", text: f.basename }); row.createSpan({ cls: "vgp-notelist-dir", text: f.parent?.path ?? "" });
        row.addEventListener("click", () => void this.app.workspace.openLinkText(f.path, "", true));
      }
    };
    q.addEventListener("input", draw); draw();
    this.registerEvent(this.app.vault.on("create", draw)); this.registerEvent(this.app.vault.on("delete", draw));
  }
}

// ---------- plugin / app ----------
export class PluginSettingTab {
  containerEl = createDiv("vertical-tab-content-inner"); id = ""; name = "";
  constructor(public app: App, public plugin: Plugin) {}
  display(): void {}
  hide(): void {}
}
export class Plugin extends Component {
  constructor(public app: App, public manifest: any) { super(); }
  async loadData(): Promise<any> { return this.app.pluginData === undefined ? null : structuredClone(this.app.pluginData); }
  async saveData(d: any): Promise<void> { this.app.pluginData = structuredClone(d); preview.persist(); }
  addCommand(c: any): any { const full = { ...c, id: this.manifest.id + ":" + c.id }; this.app.commands.commands[full.id] = full; this.register(() => delete this.app.commands.commands[full.id]); return full; }
  addRibbonIcon(icon: string, title: string, cb: (e: MouseEvent) => any): HTMLElement { const el = createDiv("clickable-icon side-dock-ribbon-action"); el.title = title; setIcon(el, icon); el.addEventListener("click", cb); this.app.ribbon.push({ icon, title, cb, el }); return el; }
  addStatusBarItem(): HTMLElement { return createDiv("status-bar-item"); }
  addSettingTab(tab: PluginSettingTab): void { tab.id = this.manifest.id; tab.name = this.manifest.name; this.app.setting.tabs.push(tab); }
  registerView(type: string, creator: (l: WorkspaceLeaf) => any): void { this.app.workspace.registerView(type, creator); this.register(() => this.app.workspace.unregisterView(type)); }
  registerMarkdownCodeBlockProcessor(lang: string, cb: any): void { preview.codeBlocks.set(lang, cb); }
  registerMarkdownPostProcessor(): void {}
  registerEditorExtension(): void {}
  registerExtensions(): void {}
  registerHoverLinkSource(): void {}
  registerObsidianProtocolHandler(): void {}
  registerEditorSuggest(): void {}
}

export class App {
  vault = new Vault(); workspace = new Workspace(this); metadataCache = new MetadataCache(this.vault);
  commands: any = { commands: {}, executeCommandById: (id: string) => { const c = this.commands.commands[id]; if (!c) return false; (c.callback ?? (() => c.checkCallback?.(false)))(); return true; } };
  ribbon: any[] = []; pluginData: any; keymap = { pushScope() {}, popScope() {} }; scope = new Scope(); isMobile = false;
  secretStorage = { getSecret: (id: string) => preview.secrets[id] ?? null, setSecret: (id: string, v: string) => { preview.secrets[id] = v; preview.persist(); }, listSecrets: () => Object.keys(preview.secrets) };
  setting: any = { tabs: [] as PluginSettingTab[], open: () => this.openSettings(), openTabById: (id: string) => this.openSettings(id), close() {} };
  fileManager = {
    processFrontMatter: async (f: TFile, fn: (fm: any) => void) => {
      await this.vault.process(f, (d) => { const m = /^---\n([\s\S]*?)\n---\n?/.exec(d); const fm = (m ? parseYaml(m[1]) : null) ?? {}; fn(fm); return `---\n${stringifyYaml(fm)}---\n` + (m ? d.slice(m[0].length) : d); });
    },
    renameFile: (f: TFile, p: string) => this.vault.rename(f, p), trashFile: (f: TFile) => this.vault.delete(f),
  };
  constructor() { this.workspace.registerView("markdown", (l) => new NoteView(l)); this.workspace.registerView("vgp-settings", (l) => new SettingsView(l)); this.workspace.registerView("vgp-notes", (l) => new NoteListView(l)); (window as any).app = this; }
  async openSettings(tab?: string): Promise<void> { const l = this.workspace.getLeaf("tab"); await l.setViewState({ type: "vgp-settings", state: { tab }, active: true }); await this.workspace.revealLeaf(l); }
  loadLocalStorage(k: string): any { try { return JSON.parse(localStorage.getItem("vgp-app:" + k) ?? "null"); } catch { return null; } }
  saveLocalStorage(k: string, v: any): void { try { localStorage.setItem("vgp-app:" + k, JSON.stringify(v)); } catch { /* ignore */ } }
}

export const Keymap = { isModEvent: (e: any) => !!(e?.ctrlKey || e?.metaKey) };
