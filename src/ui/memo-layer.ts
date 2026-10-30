import { setIcon } from "obsidian";
import type { MemoAnchor } from "../app/memo-anchor";
import { MEMO_DEFAULT_OFFSET, MEMO_DEFAULT_WIDTH, MEMO_MAX_WIDTH, MEMO_MIN_WIDTH, type MemoMeta } from "../core/memo";
import type { MemoLayout, TaskWorkbenchSettings } from "../core/types";

/**
 * Floating speech-bubble memos over the Gantt.
 *
 * Every memo lives in ONE layer element, the last child of the scroll container and sized to its content, so the
 * memos scroll natively with the chart and are never repositioned from a scroll handler. Memos stay out of row
 * rendering: a row never knows about them, and changing a memo never rebuilds a row. The view re-places the layer
 * (O(number of memos)) after it renders, zooms or relayouts; `onScroll` only moves the layer's clip edge.
 */

/** One memo to draw: a stored note, a draft being typed, or an AI proposal. */
export interface MemoEntry {
  id: string;
  /** The stored memo; absent for a draft and for a proposal that adds one. */
  meta?: MemoMeta;
  anchor: MemoAnchor;
  /** Header label: the task name, or the row and day. */
  where: string;
  /** Text known without reading the note (a draft, a proposal). */
  text?: string;
  /** An AI proposal drawn over the chart: read-only, dashed accent frame with a mark. */
  proposal?: "追加" | "変更" | "削除";
}

export interface MemoPoint { x: number; y: number }

/** Where a dropped anchor dot would land: the anchor to save, and what the drag tooltip says about it. */
export interface MemoDropTarget { anchor: MemoAnchor; label: string }

export interface MemoLayerContext {
  /** The scroll container. */
  wrap: HTMLElement;
  settings(): TaskWorkbenchSettings;
  entries(): MemoEntry[];
  /** Anchor point in scroll-content px; null = the anchor is not on the chart (filtered, out of range, no bar). */
  pointOf(entry: MemoEntry): MemoPoint | null;
  /** Width of the sticky name column, which the layer must not paint over. */
  leftWidth: number;
  /** The scroll content's size without the layer, from what the view already knows (no layout read). Omitted: measured from the wrap's children. */
  contentSize?(): { width: number; height: number };
  /** What is under the pointer to re-anchor to (a bar, a parent row's timeline or the その他 row, with the day snapped); null = nothing there. */
  dropTargetAt(entry: MemoEntry, clientX: number, clientY: number): MemoDropTarget | null;
  /** A dot drag starts or ends; the chart keeps its hover popovers closed meanwhile. */
  dotDragging(active: boolean): void;
  /** Shows the drop label in the drag tooltip (null hides it). */
  dragHint(label: string | null, clientX: number, clientY: number): void;
  readText(meta: MemoMeta): Promise<string>;
  saveText(meta: MemoMeta, text: string): Promise<void>;
  moveAnchor(entry: MemoEntry, target: MemoDropTarget): Promise<void>;
  /** Persists the view state (settings only; no chart render). */
  saveLayout(): void;
  /** Records a bubble move or resize for undo/redo (the settings are already updated). */
  recordLayout(label: string, id: string, before: MemoLayout | null, after: MemoLayout): void;
  openMenu(evt: MouseEvent, entry: MemoEntry): void;
}

const ICON_MEMO = "message-square-text";
const DEFAULT_DX = 28;
const BUBBLE_GAP = 14;
const DOT_CLEARANCE = 8;
const MIN_BUBBLE_HEIGHT = 56;
const MAX_BUBBLE_HEIGHT = 260;
const PIN_RISE = 12;
const LINE_HEIGHT = 17;
const EDGE = 3;
/** A measured height this close to the one placement used does not move the bubble. */
const HEIGHT_TOLERANCE = 2;
/** Memos whose anchor is within this many viewport widths of the visible dates get DOM nodes. */
const NEAR_VIEWPORTS = 1;
const FALLBACK_VIEWPORT = 1200;
const STOPPED_EVENTS = ["pointerdown", "mousedown", "click", "dblclick", "contextmenu", "mouseover"] as const;

interface Rect { x: number; y: number; w: number; h: number }
interface MemoNode {
  id: string;
  entry: MemoEntry;
  group: HTMLElement;
  open: boolean;
  /** What the built DOM depends on; a change rebuilds the node. */
  signature: string;
  pt: MemoPoint;
  dx: number;
  dy: number;
  w: number;
  /** Measured bubble height; unknown until the first measurement, then kept current by the resize observer. */
  h?: number;
  /** Offsets came from auto-placement (no stored layout). */
  auto: boolean;
  box?: HTMLElement;
  pin?: HTMLElement;
  dot?: HTMLElement;
  tail?: HTMLElement;
  textEl?: HTMLElement;
  editing?: boolean;
  draftCommit?: (text: string) => Promise<MemoMeta | null>;
}

// eslint-disable-next-line no-undef
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Height of a bubble holding `text` at width `w`, before it is measured. */
export function estimateBubbleHeight(text: string, w: number): number {
  const usable = Math.max(40, w - 20);
  let lines = 0;
  for (const line of text.split("\n")) {
    let width = 0;
    for (const char of line) width += /[\u0020-ÿ｡-ﾟ]/.test(char) ? 6.6 : 12.5;
    lines += Math.max(1, Math.ceil(width / usable));
  }
  return Math.min(MAX_BUBBLE_HEIGHT, Math.max(MIN_BUBBLE_HEIGHT, 22 + 12 + lines * LINE_HEIGHT));
}

export class MemoLayer {
  private layer: HTMLElement | undefined;
  private readonly nodes = new Map<string, MemoNode>();
  /** Text per memo object: a changed note is a new object, so stale text is never shown. */
  private readonly texts = new WeakMap<MemoMeta, string>();
  private placedScrollLeft = 0;
  private frame = 0;
  private disposed = false;
  /** One observer for every open bubble: real heights arrive without a forced layout. */
  private observer: ResizeObserver | undefined;
  private readonly observed = new Map<Element, MemoNode>();

  constructor(private readonly ctx: MemoLayerContext) {}

  /** The layer element (created on first use). */
  get element(): HTMLElement | undefined { return this.layer; }

  /** Number of memos that currently have DOM nodes. */
  get nodeCount(): number { return this.nodes.size; }

  private ensureLayer(): HTMLElement {
    let layer = this.layer;
    if (!layer) {
      layer = el("div", "vg-memo-layer");
      // Memo gestures must not reach the chart's own handlers (bar hover, drags, context menus).
      for (const type of STOPPED_EVENTS) layer.addEventListener(type, (evt: Event) => evt.stopPropagation());
      this.layer = layer;
    }
    return layer;
  }

  dispose(): void {
    this.disposed = true;
    this.layer?.remove();
    this.layer = undefined;
    this.nodes.clear();
    this.observed.clear();
    this.observer?.disconnect();
    this.observer = undefined;
  }

  private observe(node: MemoNode): void {
    if (!node.box || typeof ResizeObserver === "undefined") return;
    this.observer ??= new ResizeObserver((records) => this.onResized(records));
    this.observed.set(node.box, node);
    this.observer.observe(node.box);
  }

  private unobserve(node: MemoNode): void {
    if (!node.box || !this.observed.delete(node.box)) return;
    this.observer?.unobserve(node.box);
  }

  private dropNode(node: MemoNode): void {
    this.unobserve(node);
    node.group.remove();
    this.nodes.delete(node.id);
  }

  /** A bubble got its real height (text loaded, edited, resized): redraw its tail, and place again when auto-placement used another guess. */
  private onResized(records: readonly ResizeObserverEntry[]): void {
    if (this.disposed) return;
    let replace = false;
    for (const record of records) {
      const node = this.observed.get(record.target);
      if (!node || node.box !== record.target) continue;
      const h = record.borderBoxSize?.[0]?.blockSize ?? record.contentRect.height;
      if (!(h > 0)) continue;
      const before = this.heightOf(node);
      node.h = h;
      this.layoutTail(node);
      if (node.auto && Math.abs(h - before) > HEIGHT_TOLERANCE) replace = true;
    }
    if (replace) this.schedulePlace();
  }

  private heightOf(node: MemoNode): number {
    return node.h ?? estimateBubbleHeight(this.knownText(node.entry) ?? "", node.w);
  }

  /** Coalesces re-placement requests into one animation frame. */
  schedulePlace(): void {
    if (this.frame || this.disposed) return;
    if (typeof requestAnimationFrame !== "function") { this.place(); return; }
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.place(); });
  }

  /** The only work a scroll event does: move the clip edge, and note when the drawn window has to follow. */
  onScroll(): void {
    const layer = this.layer;
    if (!layer || this.disposed) return;
    const { wrap } = this.ctx;
    layer.style.clipPath = `inset(0 0 0 ${wrap.scrollLeft + this.ctx.leftWidth}px)`;
    const width = wrap.clientWidth || FALLBACK_VIEWPORT;
    if (Math.abs(wrap.scrollLeft - this.placedScrollLeft) > width / 2) this.schedulePlace();
  }

  /**
   * Draws the memos. Keeps the layer the last child of the scroll container, sizes it to the content, and gives DOM
   * nodes only to memos whose anchor is within the visible dates plus one viewport width on each side.
   * Reads layout once up front and only writes afterwards, so a call costs at most one reflow.
   */
  place(): void {
    if (this.disposed) return;
    const { wrap } = this.ctx;
    const layer = this.ensureLayer();
    if (!this.ctx.settings().ganttMemosVisible) {
      if (layer.parentNode !== wrap || layer.nextSibling !== null) wrap.appendChild(layer);
      layer.style.display = "none";
      return;
    }

    // Read phase: everything the placement needs from layout.
    const { width: contentWidth, height: contentHeight } = this.ctx.contentSize?.() ?? this.measureContent();
    const scrollLeft = wrap.scrollLeft;
    const viewport = wrap.clientWidth || FALLBACK_VIEWPORT;
    const from = scrollLeft - NEAR_VIEWPORTS * viewport, to = scrollLeft + (1 + NEAR_VIEWPORTS) * viewport;
    const layoutOf = this.ctx.settings().ganttMemoLayout ?? {};
    const live = new Map<string, { entry: MemoEntry; pt: MemoPoint }>();
    for (const entry of this.ctx.entries()) {
      const pt = this.ctx.pointOf(entry);
      if (pt && pt.x >= from && pt.x <= to) live.set(entry.id, { entry, pt });
    }
    // A draft stays while it is being typed, wherever the chart scrolled to.
    for (const node of this.nodes.values()) if (node.draftCommit && !live.has(node.id)) live.set(node.id, { entry: node.entry, pt: this.ctx.pointOf(node.entry) ?? node.pt });
    const minTop = this.stickyTop();
    for (const node of this.nodes.values()) {
      const measured = node.open && node.box ? node.box.offsetHeight : 0;
      if (measured > 0) node.h = measured;
    }

    // Write phase: from here on nothing reads layout.
    if (layer.parentNode !== wrap || layer.nextSibling !== null) wrap.appendChild(layer);
    layer.style.display = "";
    layer.style.width = `${contentWidth}px`; layer.style.height = `${contentHeight}px`;
    layer.style.clipPath = `inset(0 0 0 ${scrollLeft + this.ctx.leftWidth}px)`;
    this.placedScrollLeft = scrollLeft;
    for (const [id, node] of [...this.nodes]) if (!live.has(id)) this.dropNode(node);

    // Stored layouts claim their space first; auto-placed memos then look for free space around them.
    // Anchor dots count as taken too, so no bubble hides another memo's anchor.
    const taken: Rect[] = [...live.values()].map(({ pt }) => ({ x: pt.x - DOT_CLEARANCE, y: pt.y - DOT_CLEARANCE, w: DOT_CLEARANCE * 2, h: DOT_CLEARANCE * 2 }));
    const pending: MemoNode[] = [];
    const order = [...live.values()].sort((a, b) => a.pt.x - b.pt.x || a.pt.y - b.pt.y);
    for (const { entry, pt } of order) {
      let node = this.nodes.get(entry.id);
      // A proposal that adds a memo has no stored layout; one that changes or deletes uses its memo's. Proposals are always drawn open.
      const stored = entry.proposal === "追加" ? undefined : layoutOf[entry.id];
      const open = entry.proposal ? true : stored ? stored.open : true;
      if (!node) {
        node = { id: entry.id, entry, group: el("div", "vg-memo-group"), open, signature: "", pt, dx: 0, dy: 0, w: MEMO_DEFAULT_WIDTH, auto: true };
        this.nodes.set(entry.id, node);
        layer.appendChild(node.group);
      }
      node.pt = pt;
      if (!node.editing) { node.entry = entry; node.open = open; }
      if (stored) { node.dx = stored.dx; node.dy = stored.dy; node.w = stored.w; node.auto = false; }
      else if (!node.editing) node.auto = true;
      if (node.auto && node.open && !node.editing) { pending.push(node); continue; }
      this.rebuildIfNeeded(node);
      if (node.open) taken.push(this.rectOf(node));
    }
    for (const node of pending) {
      const spot = this.freeSpot(node.pt, node.w, this.heightOf(node), taken, contentWidth, contentHeight, minTop);
      node.dx = spot.dx; node.dy = spot.dy;
      this.rebuildIfNeeded(node);
      taken.push(this.rectOf(node));
    }
    this.layoutTails();
  }

  /** The scroll content's size without the layer, for contexts that cannot say it: the farthest edge of the wrap's other children. */
  private measureContent(): { width: number; height: number } {
    const { wrap } = this.ctx;
    let width = wrap.clientWidth, height = wrap.clientHeight;
    for (const child of Array.from(wrap.children) as HTMLElement[]) {
      if (child === this.layer) continue;
      width = Math.max(width, child.offsetLeft + child.offsetWidth);
      height = Math.max(height, child.offsetTop + child.offsetHeight);
    }
    return { width, height };
  }

  private rectOf(node: MemoNode): Rect {
    return { x: node.pt.x + node.dx, y: node.pt.y + node.dy, w: node.w, h: this.heightOf(node) };
  }

  /**
   * Up-right of the anchor first, then down-right, then further down; the same rows to the far right and to the left
   * of the anchor next. A spot must stay below the sticky header rows (minTop) and clear of other bubbles and anchors.
   */
  private freeSpot(pt: MemoPoint, w: number, h: number, taken: readonly Rect[], maxX: number, maxY: number, minTop = 0): { dx: number; dy: number } {
    const rows = [-(h + BUBBLE_GAP), BUBBLE_GAP];
    for (let step = 1; step <= 8; step += 1) rows.push(BUBBLE_GAP + step * (MIN_BUBBLE_HEIGHT + 8));
    const columns = [DEFAULT_DX, DEFAULT_DX + w + BUBBLE_GAP, -(w + DEFAULT_DX)];
    for (const dx of columns) {
      for (const dy of rows) {
        const rect = { x: pt.x + dx, y: pt.y + dy, w, h };
        if (rect.y < minTop || (maxY > 0 && rect.y + h > maxY)) continue;
        if (rect.x < this.ctx.leftWidth || (maxX > 0 && rect.x + w > maxX)) continue;
        if (!taken.some((other) => overlaps(rect, other))) return { dx, dy };
      }
    }
    return { dx: DEFAULT_DX, dy: Math.max(BUBBLE_GAP, minTop - pt.y) };
  }

  /** Content y where the scrolling rows start: everything above it is the sticky header (and sticky fixed rows). */
  private stickyTop(): number {
    let bottom = 0;
    for (const child of Array.from(this.ctx.wrap.children) as HTMLElement[]) {
      if (child === this.layer) continue;
      if (typeof getComputedStyle !== "function" || getComputedStyle(child).position !== "sticky") break;
      bottom = Math.max(bottom, child.offsetTop + child.offsetHeight);
    }
    return bottom;
  }

  private knownText(entry: MemoEntry): string | undefined {
    return entry.text ?? (entry.meta ? this.texts.get(entry.meta) : undefined);
  }

  private signatureOf(node: MemoNode): string {
    const { entry } = node;
    return [node.open ? "o" : "c", entry.where, entry.proposal ?? "", entry.text ?? "", entry.meta ? entry.meta.path : "", node.draftCommit ? "d" : ""].join("|");
  }

  /** Builds the node's DOM when what it shows changed, then positions it. */
  private rebuildIfNeeded(node: MemoNode): void {
    const signature = this.signatureOf(node);
    if (node.signature !== signature && !node.editing) {
      node.signature = signature;
      this.unobserve(node);
      node.group.replaceChildren();
      node.box = node.pin = node.dot = node.tail = node.textEl = undefined;
      node.h = undefined;
      if (node.open) { this.buildBubble(node); this.observe(node); } else this.buildPin(node);
    } else if (node.entry.meta && node.textEl && !node.editing) this.fillText(node);
    this.position(node);
  }

  private position(node: MemoNode): void {
    const { pt } = node;
    node.group.classList.toggle("is-ai", !!node.entry.proposal);
    if (!node.open) {
      if (node.pin) { node.pin.style.left = `${pt.x}px`; node.pin.style.top = `${pt.y - PIN_RISE}px`; }
      return;
    }
    if (node.dot) { node.dot.style.left = `${pt.x}px`; node.dot.style.top = `${pt.y}px`; }
    if (node.box) {
      node.box.style.left = `${Math.max(0, pt.x + node.dx)}px`;
      node.box.style.top = `${Math.max(0, pt.y + node.dy)}px`;
      node.box.style.width = `${node.w}px`;
    }
  }

  // ------------------------------------------------------------------ pins

  private buildPin(node: MemoNode): void {
    const { entry } = node;
    const pin = el("div", "vg-memo-pin");
    if (entry.proposal) pin.classList.add("is-ai");
    const icon = el("span", "vg-memo-pin-icon");
    setIcon(icon, ICON_MEMO);
    pin.appendChild(icon);
    pin.setAttribute("aria-label", entry.where);
    pin.addEventListener("mouseenter", () => {
      const known = this.knownText(entry);
      if (known !== undefined) { pin.title = known; return; }
      void this.loadText(entry).then((text) => { if (text !== undefined && node.group.isConnected) pin.title = text; });
    });
    pin.addEventListener("click", () => { if (!entry.proposal) this.setOpen(node, true); });
    pin.addEventListener("contextmenu", (evt: MouseEvent) => this.menuOf(evt, node));
    node.pin = pin;
    node.group.appendChild(pin);
  }

  // --------------------------------------------------------------- bubbles

  private buildBubble(node: MemoNode): void {
    const { entry } = node;
    const dot = el("div", "vg-memo-dot");
    const tail = el("div", "vg-memo-tail");
    const box = el("div", "vg-memo");
    if (entry.proposal) {
      box.classList.add("is-ai");
      dot.classList.add("is-ai"); tail.classList.add("is-ai");
      if (entry.proposal === "削除") box.classList.add("is-deleted");
    }
    box.dataset.memoId = entry.id;
    const head = el("div", "vg-memo-head");
    if (entry.proposal) head.appendChild(el("span", "vg-memo-mark", `AI提案・${entry.proposal}`));
    else {
      const icon = el("span", "vg-memo-head-icon");
      setIcon(icon, ICON_MEMO);
      head.appendChild(icon);
    }
    const where = el("span", "vg-memo-where", entry.where);
    where.title = entry.where;
    head.appendChild(where);
    if (!entry.proposal) {
      const close = el("button", "vg-memo-btn");
      close.type = "button";
      close.title = "閉じる（アンカーにピンだけ残す）";
      close.setAttribute("aria-label", "メモを閉じる");
      setIcon(close, "minus");
      close.addEventListener("click", () => this.setOpen(node, false));
      head.appendChild(close);
      head.addEventListener("pointerdown", (evt: PointerEvent) => this.startBubbleDrag(evt, node));
      dot.addEventListener("pointerdown", (evt: PointerEvent) => this.startDotDrag(evt, node));
      box.addEventListener("contextmenu", (evt: MouseEvent) => this.menuOf(evt, node));
    }
    const text = el("div", "vg-memo-text");
    node.textEl = text;
    if (!entry.proposal) text.addEventListener("dblclick", () => this.startEdit(node));
    box.append(head, text);
    if (!entry.proposal) {
      const grip = el("div", "vg-memo-resize");
      grip.title = "幅を変える";
      grip.addEventListener("pointerdown", (evt: PointerEvent) => this.startResize(evt, node));
      box.appendChild(grip);
    }
    node.box = box; node.dot = dot; node.tail = tail;
    node.group.append(dot, tail, box);
    this.fillText(node);
  }

  private fillText(node: MemoNode): void {
    const textEl = node.textEl;
    if (!textEl) return;
    const known = this.knownText(node.entry);
    if (known !== undefined) { textEl.textContent = known; return; }
    if (!textEl.textContent) textEl.textContent = "…";
    void this.loadText(node.entry).then((text) => {
      if (text === undefined || node.textEl !== textEl || node.editing) return;
      textEl.textContent = text;
      // With an observer the bubble's new height arrives by itself; without one, redraw from the new estimate.
      if (this.observer) return;
      this.layoutTail(node);
      // Auto-placed bubbles were spaced by an estimate; place them again now that the real height is known.
      if (node.auto) this.schedulePlace();
    });
  }

  private async loadText(entry: MemoEntry): Promise<string | undefined> {
    const meta = entry.meta;
    if (!meta) return entry.text;
    const known = this.texts.get(meta);
    if (known !== undefined) return known;
    try {
      const text = await this.ctx.readText(meta);
      this.texts.set(meta, text);
      return text;
    } catch {
      return undefined;
    }
  }

  /** Remembers the text of a memo object that was just saved. */
  rememberText(meta: MemoMeta, text: string): void { this.texts.set(meta, text); }

  // ----------------------------------------------------------------- tails

  /** Draws every open bubble's tail from its known (or estimated) size; reads no layout. */
  private layoutTails(): void {
    for (const node of this.nodes.values()) this.layoutTail(node);
  }

  private layoutTail(node: MemoNode): void {
    if (!node.open || !node.box) return;
    this.drawTail(node, this.rectOf(node));
  }

  /** A straight line from the anchor to the nearest point of the bubble's frame. */
  private drawTail(node: MemoNode, rect: Rect): void {
    const tail = node.tail;
    if (!tail) return;
    const { x: ax, y: ay } = node.pt;
    const left = Math.max(0, rect.x), top = Math.max(0, rect.y);
    const tx = Math.max(left, Math.min(ax, left + rect.w)), ty = Math.max(top, Math.min(ay, top + rect.h));
    const length = Math.hypot(tx - ax, ty - ay);
    tail.style.display = length < EDGE ? "none" : "";
    tail.style.left = `${ax}px`;
    tail.style.top = `${ay}px`;
    tail.style.width = `${length}px`;
    tail.style.transform = `rotate(${Math.atan2(ty - ay, tx - ax)}rad)`;
  }

  // ------------------------------------------------------- open / close / menu

  private layoutFor(node: MemoNode, open: boolean): MemoLayout {
    return { open, dx: Math.round(node.dx), dy: Math.round(node.dy), w: Math.round(node.w) };
  }

  /** Opens or closes one memo. Writes only the settings; the chart is not rendered. */
  private setOpen(node: MemoNode, open: boolean): void {
    const settings = this.ctx.settings();
    settings.ganttMemoLayout = { ...settings.ganttMemoLayout, [node.id]: this.layoutFor(node, open) };
    this.ctx.saveLayout();
    node.open = open;
    this.rebuildIfNeeded(node);
    this.layoutTails();
  }

  /** Opens or closes every memo (the toolbar menu). Memos never drawn yet keep their auto-placed spot. */
  setAllOpen(open: boolean): void {
    const settings = this.ctx.settings();
    const next = { ...settings.ganttMemoLayout };
    for (const entry of this.ctx.entries()) {
      if (!entry.meta) continue;
      const node = this.nodes.get(entry.id), stored = next[entry.id];
      next[entry.id] = stored ? { ...stored, open } : { open, dx: node?.dx ?? MEMO_DEFAULT_OFFSET.dx, dy: node?.dy ?? MEMO_DEFAULT_OFFSET.dy, w: node?.w ?? MEMO_DEFAULT_WIDTH };
    }
    settings.ganttMemoLayout = next;
    this.ctx.saveLayout();
    this.place();
  }

  private menuOf(evt: MouseEvent, node: MemoNode): void {
    evt.preventDefault();
    evt.stopPropagation();
    if (node.entry.meta && !node.entry.proposal) this.ctx.openMenu(evt, node.entry);
  }

  // --------------------------------------------------------------- dragging

  private startBubbleDrag(evt: PointerEvent, node: MemoNode): void {
    const target = evt.target as HTMLElement | null;
    if (evt.button !== 0 || target?.closest?.("button") || !node.box) return;
    evt.preventDefault();
    const box = node.box, startX = evt.clientX, startY = evt.clientY, ox = node.dx, oy = node.dy;
    const size = { w: box.offsetWidth || node.w, h: box.offsetHeight || MIN_BUBBLE_HEIGHT };
    box.classList.add("is-dragging");
    const move = (e: PointerEvent): void => {
      node.dx = Math.round(ox + e.clientX - startX); node.dy = Math.round(oy + e.clientY - startY);
      this.position(node);
      this.drawTail(node, { x: node.pt.x + node.dx, y: node.pt.y + node.dy, ...size });
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      box.classList.remove("is-dragging");
      if (node.dx === ox && node.dy === oy) return;
      node.auto = false;
      const settings = this.ctx.settings();
      const before = settings.ganttMemoLayout[node.id] ?? null, after = this.layoutFor(node, true);
      settings.ganttMemoLayout = { ...settings.ganttMemoLayout, [node.id]: after };
      this.ctx.saveLayout();
      this.ctx.recordLayout("メモ移動", node.id, before, after);
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  }

  private startResize(evt: PointerEvent, node: MemoNode): void {
    if (evt.button !== 0 || !node.box) return;
    evt.preventDefault(); evt.stopPropagation();
    const startX = evt.clientX, ow = node.w;
    const move = (e: PointerEvent): void => {
      node.w = Math.min(MEMO_MAX_WIDTH, Math.max(MEMO_MIN_WIDTH, Math.round(ow + e.clientX - startX)));
      this.position(node);
      this.layoutTail(node);
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      if (node.w === ow && !node.auto) return;
      node.auto = false;
      const settings = this.ctx.settings();
      const before = settings.ganttMemoLayout[node.id] ?? null, after = this.layoutFor(node, true);
      settings.ganttMemoLayout = { ...settings.ganttMemoLayout, [node.id]: after };
      this.ctx.saveLayout();
      this.ctx.recordLayout("メモのサイズ変更", node.id, before, after);
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  }

  /** Drags the anchor dot anywhere on the chart; dropped on a bar, a parent row or the その他 row it re-anchors there. The bubble keeps its offset and follows. */
  private startDotDrag(evt: PointerEvent, node: MemoNode): void {
    if (evt.button !== 0 || !node.dot || !node.box) return;
    evt.preventDefault(); evt.stopPropagation();
    const origin = node.pt, entry = node.entry, wrap = this.ctx.wrap;
    const size = { w: node.box.offsetWidth || node.w, h: node.box.offsetHeight || MIN_BUBBLE_HEIGHT };
    let target: MemoDropTarget | null = null;
    node.dot.classList.add("is-dragging");
    // The dragged memo must not catch the pointer, or the hit test would find its own dot and bubble.
    node.group.classList.add("is-dot-dragging");
    this.ctx.dotDragging(true);
    const move = (e: PointerEvent): void => {
      target = this.ctx.dropTargetAt(entry, e.clientX, e.clientY);
      const snapped = target ? this.ctx.pointOf({ ...entry, anchor: target.anchor }) : null;
      const rect = wrap.getBoundingClientRect?.();
      node.pt = snapped ?? { x: e.clientX - (rect?.left ?? 0) + wrap.scrollLeft, y: e.clientY - (rect?.top ?? 0) + wrap.scrollTop };
      this.ctx.dragHint(snapped && target ? target.label : null, e.clientX, e.clientY);
      this.position(node);
      this.drawTail(node, { x: node.pt.x + node.dx, y: node.pt.y + node.dy, ...size });
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      node.dot?.classList.remove("is-dragging");
      node.group.classList.remove("is-dot-dragging");
      this.ctx.dragHint(null, 0, 0);
      this.ctx.dotDragging(false);
      const from = entry.anchor, to = target?.anchor;
      if (target && to && (to.kind !== from.kind || to.taskId !== from.taskId || to.date !== from.date)) void this.ctx.moveAnchor(entry, target);
      else { node.pt = origin; this.position(node); this.layoutTail(node); }
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  }

  // ---------------------------------------------------------------- editing

  /**
   * Starts a new memo: a bubble with an empty text area at the anchor. Nothing exists until the text is confirmed;
   * empty text or Esc leaves no note behind.
   */
  beginDraft(entry: MemoEntry, commit: (text: string) => Promise<MemoMeta | null>): void {
    this.place();
    const pt = this.ctx.pointOf(entry);
    if (!pt) return;
    this.discardDraft();
    const node: MemoNode = { id: entry.id, entry, group: el("div", "vg-memo-group"), open: true, signature: "", pt, dx: DEFAULT_DX, dy: BUBBLE_GAP, w: MEMO_DEFAULT_WIDTH, auto: true, draftCommit: commit };
    this.nodes.set(entry.id, node);
    this.ensureLayer().appendChild(node.group);
    const taken: Rect[] = [];
    for (const other of this.nodes.values()) if (other !== node && other.open) taken.push(this.rectOf(other));
    const { width, height } = this.ctx.contentSize?.() ?? this.measureContent();
    const spot = this.freeSpot(pt, node.w, MIN_BUBBLE_HEIGHT + 24, taken, width, height, this.stickyTop());
    node.dx = spot.dx; node.dy = spot.dy;
    this.rebuildIfNeeded(node);
    this.layoutTail(node);
    this.startEdit(node);
  }

  private discardDraft(): void {
    for (const node of [...this.nodes.values()]) {
      if (!node.draftCommit) continue;
      this.dropNode(node);
    }
  }

  /** Swaps the text for a text area. Enter confirms, Shift+Enter breaks the line, Esc cancels. */
  private startEdit(node: MemoNode): void {
    const textEl = node.textEl;
    if (!textEl || node.editing || node.entry.proposal) return;
    const draft = !!node.draftCommit;
    const meta = node.entry.meta;
    const original = draft ? "" : this.knownText(node.entry) ?? textEl.textContent ?? "";
    node.editing = true;
    node.group.classList.add("is-editing");
    const area = el("textarea", "vg-memo-edit");
    area.value = original;
    area.rows = 2;
    const grow = (): void => { area.style.height = "auto"; if (area.scrollHeight) area.style.height = `${area.scrollHeight + 2}px`; };
    area.addEventListener("input", grow);
    textEl.replaceWith(area);
    node.textEl = area;
    grow();
    area.focus();
    if (typeof area.setSelectionRange === "function") area.setSelectionRange(area.value.length, area.value.length);
    let done = false;
    const leave = (): void => {
      node.editing = false;
      node.group.classList.remove("is-editing");
    };
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;
      const value = area.value.trim();
      leave();
      if (draft) {
        this.discardDraft();
        if (!commit || !value) return;
        void this.commitDraft(node, value);
        return;
      }
      // Rebuild the text element in place; a changed value is saved first.
      const restore = el("div", "vg-memo-text");
      restore.addEventListener("dblclick", () => this.startEdit(node));
      area.replaceWith(restore);
      node.textEl = restore;
      if (!commit || !value || value === original || !meta) { this.fillText(node); this.layoutTail(node); return; }
      restore.textContent = value;
      this.layoutTail(node);
      void this.ctx.saveText(meta, value).catch(() => { this.fillText(node); });
    };
    area.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); finish(false); return; }
      // Enter confirms; Enter while the IME is composing only commits the conversion.
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); finish(true); }
    });
    area.addEventListener("blur", () => finish(true));
  }

  private async commitDraft(node: MemoNode, text: string): Promise<void> {
    const draftOffsets = { dx: node.dx, dy: node.dy, w: node.w };
    const meta = await node.draftCommit!(text);
    if (!meta) return;
    this.texts.set(meta, text);
    const settings = this.ctx.settings();
    settings.ganttMemoLayout = { ...settings.ganttMemoLayout, [meta.id]: { open: true, ...draftOffsets } };
    this.ctx.saveLayout();
    this.place();
  }

  /** Opens the memo if it is closed, then redraws (used when a memo is revealed from elsewhere). */
  open(id: string): void {
    const settings = this.ctx.settings();
    const stored = settings.ganttMemoLayout?.[id];
    if (stored?.open === false) {
      settings.ganttMemoLayout = { ...settings.ganttMemoLayout, [id]: { ...stored, open: true } };
      this.ctx.saveLayout();
    }
    this.place();
  }
}
