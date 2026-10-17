// Runs before the plugin: Node-ish globals the bundled libraries probe, and the HTMLElement/Node helpers Obsidian adds
// (createEl, createDiv, empty, setText, addClass, ...). Imported first by the shell entry so it is evaluated first.
/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any;
g.global = g;
g.process = g.process ?? { env: {}, versions: {}, platform: "browser", argv: [], cwd: () => "/", nextTick: (f: any, ...a: any[]) => queueMicrotask(() => f(...a)), emitWarning() {}, on() {}, off() {}, release: {} };

type Info = string | { cls?: string | string[]; text?: string | Node; attr?: Record<string, any>; title?: string; value?: string; type?: string; placeholder?: string; href?: string; parent?: Node; prepend?: boolean };
function apply(el: any, info?: Info, parent?: Node): void {
  const o: any = typeof info === "string" ? { cls: info } : info ?? {};
  if (o.cls) el.classList.add(...[].concat(o.cls).join(" ").split(/\s+/).filter(Boolean));
  if (o.text !== undefined) typeof o.text === "string" ? (el.textContent = o.text) : el.replaceChildren(o.text);
  if (o.attr) for (const [k, v] of Object.entries(o.attr)) if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v === true ? "" : String(v));
  for (const k of ["title", "value", "type", "placeholder", "href"]) if (o[k] !== undefined) el[k] = o[k];
  const p = o.parent ?? parent;
  if (p) o.prepend ? p.insertBefore(el, p.firstChild) : p.appendChild(el);
}
function make(parent: Node | null, tag: string, info?: Info, cb?: (el: any) => void, ns?: string): any {
  const doc: Document = (parent as any)?.ownerDocument ?? (parent as any)?.documentElement?.ownerDocument ?? document;
  const el = ns ? doc.createElementNS(ns, tag) : doc.createElement(tag);
  apply(el, info, parent ?? undefined);
  cb?.(el);
  return el;
}
const SVG = "http://www.w3.org/2000/svg";
const NP = Node.prototype as any, EP = Element.prototype as any, HP = HTMLElement.prototype as any;
NP.createEl = function (tag: string, info?: Info, cb?: any) { return make(this, tag, info, cb); };
NP.createDiv = function (info?: Info, cb?: any) { return make(this, "div", info, cb); };
NP.createSpan = function (info?: Info, cb?: any) { return make(this, "span", info, cb); };
NP.createSvg = function (tag: string, info?: Info, cb?: any) { return make(this, tag, info, cb, SVG); };
NP.empty = function () { while (this.firstChild) this.removeChild(this.firstChild); };
NP.detach = function () { this.parentNode?.removeChild(this); };
NP.appendText = function (t: string) { this.appendChild(document.createTextNode(t)); };
NP.setText = function (t: string | Node) { typeof t === "string" ? (this.textContent = t) : this.replaceChildren(t); };
NP.getText = function () { return this.textContent ?? ""; };
EP.addClass = function (...c: string[]) { this.classList.add(...c.flatMap((s) => s.split(/\s+/)).filter(Boolean)); };
EP.addClasses = EP.addClass;
EP.removeClass = function (...c: string[]) { this.classList.remove(...c.flatMap((s) => s.split(/\s+/)).filter(Boolean)); };
EP.removeClasses = EP.removeClass;
EP.toggleClass = function (c: string | string[], on: boolean) { for (const n of [].concat(c as any)) this.classList.toggle(n, on); };
EP.hasClass = function (c: string) { return this.classList.contains(c); };
EP.setAttr = function (k: string, v: any) { v === null || v === undefined || v === false ? this.removeAttribute(k) : this.setAttribute(k, v === true ? "" : String(v)); };
EP.setAttrs = function (o: Record<string, any>) { for (const [k, v] of Object.entries(o)) this.setAttr(k, v); };
EP.getAttr = function (k: string) { return this.getAttribute(k); };
EP.find = function (sel: string) { return this.querySelector(sel); };
EP.findAll = function (sel: string) { return Array.from(this.querySelectorAll(sel)); };
EP.findAllSelf = function (sel: string) { return [...(this.matches(sel) ? [this] : []), ...this.querySelectorAll(sel)]; };
HP.hide = function () { if (this.style.display !== "none") this._vgDisplay = this.style.display; this.style.display = "none"; };
HP.show = function () { this.style.display = this._vgDisplay ?? ""; };
HP.toggle = function (on?: boolean) { (on ?? this.style.display === "none") ? this.show() : this.hide(); };
HP.isShown = function () { return this.style.display !== "none" && this.isConnected; };
HP.setCssStyles = function (s: Record<string, string>) { Object.assign(this.style, s); };
HP.setCssProps = function (p: Record<string, string>) { for (const [k, v] of Object.entries(p)) this.style.setProperty(k, v); };
HP.onClickEvent = function (cb: any) { this.addEventListener("click", cb); };
EP.instanceOf = function (t: any) { return this instanceof t; };
g.createEl = (tag: string, info?: Info, cb?: any) => make(null, tag, info, cb);
g.createDiv = (info?: Info, cb?: any) => make(null, "div", info, cb);
g.createSpan = (info?: Info, cb?: any) => make(null, "span", info, cb);
g.createSvg = (tag: string, info?: Info, cb?: any) => make(null, tag, info, cb, SVG);
g.createFragment = (cb?: any) => { const f = document.createDocumentFragment(); cb?.(f); return f; };
g.activeDocument = document;
g.activeWindow = window;
g.sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
g.nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));
(window as any).Node.prototype.win = window;
Object.defineProperty(NP, "doc", { get() { return document; }, configurable: true });
export {};
