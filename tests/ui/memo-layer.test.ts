/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MemoLayer, estimateBubbleHeight, type MemoDropTarget, type MemoEntry, type MemoLayerContext, type MemoPoint } from "../../src/ui/memo-layer";
import { DEFAULT_SETTINGS } from "../../src/core/constants";
import type { MemoMeta } from "../../src/core/memo";
import type { TaskWorkbenchSettings } from "../../src/core/types";
import { byClass, createFakeDocument, dispatch, makeFakeEl } from "../stubs/fake-dom";
import type { FakeEl } from "../stubs/fake-dom";

function meta(id: string, extra: Partial<MemoMeta> = {}): MemoMeta {
  return { id, path: `tasks/_memos/2026-10-01 ${id}.md`, created: "2026-10-01", updated: "2026-10-01", ...extra };
}

function entry(id: string, extra: Partial<MemoEntry> = {}): MemoEntry {
  return { id, meta: meta(id), anchor: { kind: "free", date: "2026-10-05" }, where: "その他", ...extra };
}

interface Rig {
  layer: MemoLayer;
  ctx: MemoLayerContext;
  wrap: FakeEl;
  settings: TaskWorkbenchSettings;
  entries: MemoEntry[];
  points: Map<string, MemoPoint>;
  fns: { readText: any; saveText: any; moveAnchor: any; saveLayout: any; recordLayout: any; openMenu: any; dropTargetAt: any; dragHint: any; dotDragging: any };
}

function rig(entries: MemoEntry[], points: Record<string, MemoPoint> = {}, settingsOverrides: Partial<TaskWorkbenchSettings> = {}): Rig {
  const wrap = makeFakeEl();
  wrap.clientWidth = 1000;
  // The layer measures the content from the wrap's other children.
  const content = makeFakeEl() as any;
  content.offsetLeft = 0; content.offsetWidth = 5000; content.offsetTop = 0; content.offsetHeight = 1200;
  wrap.appendChild(content);
  const settings = { ...DEFAULT_SETTINGS, ganttMemosVisible: true, ganttMemoLayout: {}, ...settingsOverrides } as TaskWorkbenchSettings;
  const map = new Map(Object.entries(points));
  for (const e of entries) if (!map.has(e.id)) map.set(e.id, { x: 600, y: 200 });
  const fns = {
    readText: vi.fn(async (m: MemoMeta) => `本文 ${m.id}`),
    saveText: vi.fn(async () => undefined),
    moveAnchor: vi.fn(async () => undefined),
    saveLayout: vi.fn(),
    openMenu: vi.fn(),
    // x > 700: the day 10/08 of the same task; x > 300: a parent row's timeline; otherwise nothing is there.
    dropTargetAt: vi.fn((e: MemoEntry, clientX: number, clientY: number): MemoDropTarget | null =>
      clientX > 700 ? { anchor: { ...e.anchor, date: "2026-10-08" }, label: "タスク · 10/8" }
        : clientY > 500 ? { anchor: { kind: "free" as const, date: "2026-10-05" }, label: "その他 · 10/5" }
        : clientX > 300 ? { anchor: { kind: "parent" as const, taskId: "p2", parentId: "p2", date: "2026-10-05" }, label: "親2 · 10/5" }
        : null),
    dragHint: vi.fn(),
    dotDragging: vi.fn(),
    recordLayout: vi.fn(),
  };
  const ctx: MemoLayerContext = {
    wrap: wrap as unknown as HTMLElement,
    settings: () => settings,
    entries: () => entries,
    pointOf: (e) => map.get(e.id) ?? null,
    leftWidth: 320,
    ...fns,
  };
  return { layer: new MemoLayer(ctx), ctx, wrap, settings, entries, points: map, fns };
}

const flush = async (): Promise<void> => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
const boxes = (r: Rig): FakeEl[] => byClass(r.layer.element as unknown as FakeEl, "vg-memo");
const pins = (r: Rig): FakeEl[] => byClass(r.layer.element as unknown as FakeEl, "vg-memo-pin");
const first = (els: FakeEl[]): FakeEl => els[0] as FakeEl;
const key = (k: string, extra: Record<string, unknown> = {}) => ({ key: k, shiftKey: false, isComposing: false, keyCode: 0, ...extra });

describe("MemoLayer", () => {
  let fakeWindow: FakeEl;
  beforeEach(() => {
    vi.stubGlobal("document", createFakeDocument());
    fakeWindow = makeFakeEl("window");
    vi.stubGlobal("window", fakeWindow);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("the layer", () => {
    it("is the last child of the scroll container and stays last when something is appended after it", () => {
      const r = rig([entry("m-aaaaaa")]);
      r.wrap.appendChild(makeFakeEl());
      r.layer.place();
      const layer = r.layer.element as unknown as FakeEl;
      expect(r.wrap.children[r.wrap.children.length - 1]).toBe(layer);
      expect(layer.className).toBe("vg-memo-layer");
      r.wrap.appendChild(makeFakeEl());
      r.layer.place();
      expect(r.wrap.children[r.wrap.children.length - 1]).toBe(layer);
      expect(r.wrap.children.filter((child) => child === layer)).toHaveLength(1);
    });

    it("is sized to the scroll content and clipped behind the sticky name column", () => {
      const r = rig([entry("m-aaaaaa")]);
      r.wrap.scrollLeft = 150;
      r.layer.place();
      const layer = r.layer.element as unknown as FakeEl;
      expect(layer.style.width).toBe("5000px");
      expect(layer.style.height).toBe("1200px");
      expect(layer.style.clipPath).toBe("inset(0 0 0 470px)");
    });

    it("is hidden while memos are switched off, and nothing is built", () => {
      const r = rig([entry("m-aaaaaa")], {}, { ganttMemosVisible: false });
      r.layer.place();
      expect((r.layer.element as unknown as FakeEl).style.display).toBe("none");
      expect(r.layer.nodeCount).toBe(0);
    });

    it("stops memo gestures from reaching the chart's handlers", () => {
      const r = rig([entry("m-aaaaaa")]);
      r.layer.place();
      for (const type of ["pointerdown", "mousedown", "click", "dblclick", "contextmenu", "mouseover"]) {
        const evt = dispatch(r.layer.element as unknown as FakeEl, type);
        expect(evt["__propagationStopped"], type).toBe(true);
      }
    });

    it("scrolling only moves the clip edge: no node is built, moved or removed", () => {
      const r = rig([entry("m-aaaaaa"), entry("m-bbbbbb")], { "m-bbbbbb": { x: 900, y: 400 } });
      r.layer.place();
      const layer = r.layer.element as unknown as FakeEl;
      const groups = [...layer.children];
      const styles = groups.map((group) => JSON.stringify(group.children.map((c) => c.style)));
      r.wrap.scrollLeft = 120;
      r.layer.onScroll();
      expect(layer.style.clipPath).toBe("inset(0 0 0 440px)");
      expect(layer.children).toEqual(groups);
      expect(groups.map((group) => JSON.stringify(group.children.map((c) => c.style)))).toEqual(styles);
    });

    it("gives DOM nodes only to memos within the visible dates plus one viewport width on each side", () => {
      const r = rig([entry("m-near01"), entry("m-edge01"), entry("m-far001"), entry("m-farleft")], {
        "m-near01": { x: 500, y: 100 }, "m-edge01": { x: 1900, y: 100 }, "m-far001": { x: 4000, y: 100 }, "m-farleft": { x: -1500, y: 100 },
      });
      r.layer.place();
      expect(r.layer.nodeCount).toBe(2);
      // Scrolling far enough moves the window along with the next placement.
      r.wrap.scrollLeft = 3500;
      r.layer.onScroll();
      expect(r.layer.nodeCount).toBe(1);
      expect(byClass(r.layer.element as unknown as FakeEl, "vg-memo-where")).toHaveLength(1);
    });

    it("does not rebuild a node whose content did not change", () => {
      const r = rig([entry("m-aaaaaa")]);
      r.layer.place();
      const before = first(boxes(r));
      r.layer.place();
      expect(first(boxes(r))).toBe(before);
    });

    it("drops the nodes of memos that left the list", () => {
      const r = rig([entry("m-aaaaaa"), entry("m-bbbbbb")]);
      r.layer.place();
      expect(r.layer.nodeCount).toBe(2);
      r.entries.pop();
      r.layer.place();
      expect(r.layer.nodeCount).toBe(1);
    });

    it("leaves the memos that are not on the chart out", () => {
      const r = rig([entry("m-aaaaaa")]);
      r.points.delete("m-aaaaaa");
      r.layer.place();
      expect(r.layer.nodeCount).toBe(0);
    });

    it("dispose removes the layer (only the content stays)", () => {
      const r = rig([entry("m-aaaaaa")]);
      r.layer.place();
      r.layer.dispose();
      expect(r.wrap.children).toHaveLength(1);
      r.layer.place();
      expect(r.wrap.children).toHaveLength(1);
    });
  });

  describe("placement", () => {
    it("places memos without a stored layout so they do not cover each other", () => {
      const entries = [entry("m-aaaaaa"), entry("m-bbbbbb"), entry("m-cccccc")];
      const r = rig(entries, { "m-aaaaaa": { x: 600, y: 300 }, "m-bbbbbb": { x: 610, y: 300 }, "m-cccccc": { x: 620, y: 300 } });
      r.layer.place();
      const tops = boxes(r).map((box) => Number.parseFloat(box.style.top));
      expect(new Set(tops).size).toBe(3);
      const lefts = boxes(r).map((box) => Number.parseFloat(box.style.left));
      expect(lefts.every((left) => left > 600)).toBe(true);
    });

    it("keeps a stored layout exactly", () => {
      const r = rig([entry("m-aaaaaa")], { "m-aaaaaa": { x: 600, y: 300 } }, { ganttMemoLayout: { "m-aaaaaa": { open: true, dx: -40, dy: 25, w: 300 } } });
      r.layer.place();
      const box = first(boxes(r));
      expect(box.style.left).toBe("560px");
      expect(box.style.top).toBe("325px");
      expect(box.style.width).toBe("300px");
    });

    it("estimates a taller bubble for longer text", () => {
      expect(estimateBubbleHeight("あ", 220)).toBeLessThan(estimateBubbleHeight("あ".repeat(60), 220));
      expect(estimateBubbleHeight("a\nb\nc\nd", 220)).toBeGreaterThan(estimateBubbleHeight("a", 220));
    });
  });

  describe("open and closed", () => {
    it("a memo with no stored layout is open", () => {
      const r = rig([entry("m-aaaaaa")]);
      r.layer.place();
      expect(boxes(r)).toHaveLength(1);
      expect(pins(r)).toHaveLength(0);
    });

    it("a closed memo is a pin at its anchor, with no text read", async () => {
      const r = rig([entry("m-aaaaaa")], { "m-aaaaaa": { x: 600, y: 300 } }, { ganttMemoLayout: { "m-aaaaaa": { open: false, dx: 28, dy: -70, w: 220 } } });
      r.layer.place();
      await flush();
      expect(boxes(r)).toHaveLength(0);
      expect(pins(r)).toHaveLength(1);
      expect(first(pins(r)).style.left).toBe("600px");
      expect(r.fns.readText).not.toHaveBeenCalled();
    });

    it("reads the text of an open memo lazily, once", async () => {
      const r = rig([entry("m-aaaaaa")]);
      r.layer.place();
      await flush();
      expect(r.fns.readText).toHaveBeenCalledTimes(1);
      expect(byClass(r.layer.element as unknown as FakeEl, "vg-memo-text")[0]?.textContent).toBe("本文 m-aaaaaa");
      r.layer.place();
      await flush();
      expect(r.fns.readText).toHaveBeenCalledTimes(1);
    });

    it("hovering a pin reads the text for its tooltip", async () => {
      const r = rig([entry("m-aaaaaa")], {}, { ganttMemoLayout: { "m-aaaaaa": { open: false, dx: 0, dy: 0, w: 220 } } });
      r.layer.place();
      const pin = first(pins(r));
      dispatch(pin, "mouseenter");
      await flush();
      expect(pin.title).toBe("本文 m-aaaaaa");
    });

    it("the minus button closes to a pin and saves only the layout", () => {
      const r = rig([entry("m-aaaaaa")]);
      r.layer.place();
      dispatch(first(byClass(r.layer.element as unknown as FakeEl, "vg-memo-btn")), "click");
      expect(r.settings.ganttMemoLayout["m-aaaaaa"]?.open).toBe(false);
      expect(r.fns.saveLayout).toHaveBeenCalledTimes(1);
      expect(boxes(r)).toHaveLength(0);
      expect(pins(r)).toHaveLength(1);
    });

    it("clicking the pin opens it again", () => {
      const r = rig([entry("m-aaaaaa")], {}, { ganttMemoLayout: { "m-aaaaaa": { open: false, dx: 28, dy: -70, w: 220 } } });
      r.layer.place();
      dispatch(first(pins(r)), "click");
      expect(r.settings.ganttMemoLayout["m-aaaaaa"]).toEqual({ open: true, dx: 28, dy: -70, w: 220 });
      expect(boxes(r)).toHaveLength(1);
      expect(pins(r)).toHaveLength(0);
    });

    it("setAllOpen closes every memo with one layout save, including memos with no stored layout", () => {
      const r = rig([entry("m-aaaaaa"), entry("m-bbbbbb")], {}, { ganttMemoLayout: { "m-aaaaaa": { open: true, dx: 1, dy: 2, w: 200 } } });
      r.layer.place();
      r.layer.setAllOpen(false);
      expect(r.settings.ganttMemoLayout["m-aaaaaa"]).toEqual({ open: false, dx: 1, dy: 2, w: 200 });
      expect(r.settings.ganttMemoLayout["m-bbbbbb"]?.open).toBe(false);
      expect(r.fns.saveLayout).toHaveBeenCalledTimes(1);
      expect(pins(r)).toHaveLength(2);
      r.layer.setAllOpen(true);
      expect(boxes(r)).toHaveLength(2);
    });

    it("open() reopens a closed memo", () => {
      const r = rig([entry("m-aaaaaa")], {}, { ganttMemoLayout: { "m-aaaaaa": { open: false, dx: 28, dy: -70, w: 220 } } });
      r.layer.place();
      r.layer.open("m-aaaaaa");
      expect(r.settings.ganttMemoLayout["m-aaaaaa"]?.open).toBe(true);
      expect(boxes(r)).toHaveLength(1);
    });
  });

  describe("gestures", () => {
    it("dragging the header saves the offsets", () => {
      const r = rig([entry("m-aaaaaa")], { "m-aaaaaa": { x: 600, y: 300 } }, { ganttMemoLayout: { "m-aaaaaa": { open: true, dx: 10, dy: -80, w: 220 } } });
      r.layer.place();
      const head = first(byClass(r.layer.element as unknown as FakeEl, "vg-memo-head"));
      dispatch(head, "pointerdown", { button: 0, clientX: 700, clientY: 200, target: head });
      dispatch(fakeWindow, "pointermove", { clientX: 740, clientY: 230 });
      expect(first(boxes(r)).style.left).toBe("650px");
      expect(r.fns.saveLayout).not.toHaveBeenCalled();
      dispatch(fakeWindow, "pointerup");
      expect(r.settings.ganttMemoLayout["m-aaaaaa"]).toEqual({ open: true, dx: 50, dy: -50, w: 220 });
      expect(r.fns.saveLayout).toHaveBeenCalledTimes(1);
      expect(r.fns.recordLayout).toHaveBeenCalledWith("メモ移動", "m-aaaaaa", { open: true, dx: 10, dy: -80, w: 220 }, { open: true, dx: 50, dy: -50, w: 220 });
      expect(fakeWindow.listeners["pointermove"]).toHaveLength(0);
    });

    it("a header click that does not move saves nothing", () => {
      const r = rig([entry("m-aaaaaa")], {}, { ganttMemoLayout: { "m-aaaaaa": { open: true, dx: 10, dy: -80, w: 220 } } });
      r.layer.place();
      const head = first(byClass(r.layer.element as unknown as FakeEl, "vg-memo-head"));
      dispatch(head, "pointerdown", { button: 0, clientX: 700, clientY: 200, target: head });
      dispatch(fakeWindow, "pointerup");
      expect(r.fns.saveLayout).not.toHaveBeenCalled();
      expect(r.fns.recordLayout).not.toHaveBeenCalled();
    });

    it("the bottom-right handle resizes within the width limits", () => {
      const r = rig([entry("m-aaaaaa")], {}, { ganttMemoLayout: { "m-aaaaaa": { open: true, dx: 10, dy: -80, w: 220 } } });
      r.layer.place();
      const grip = first(byClass(r.layer.element as unknown as FakeEl, "vg-memo-resize"));
      dispatch(grip, "pointerdown", { button: 0, clientX: 800, clientY: 300 });
      dispatch(fakeWindow, "pointermove", { clientX: 860, clientY: 300 });
      expect(first(boxes(r)).style.width).toBe("280px");
      dispatch(fakeWindow, "pointermove", { clientX: 5000, clientY: 300 });
      expect(first(boxes(r)).style.width).toBe("480px");
      dispatch(fakeWindow, "pointermove", { clientX: -500, clientY: 300 });
      expect(first(boxes(r)).style.width).toBe("140px");
      dispatch(fakeWindow, "pointerup");
      expect(r.settings.ganttMemoLayout["m-aaaaaa"]?.w).toBe(140);
      expect(r.fns.saveLayout).toHaveBeenCalledTimes(1);
      expect(r.fns.recordLayout).toHaveBeenCalledWith("メモのサイズ変更", "m-aaaaaa", { open: true, dx: 10, dy: -80, w: 220 }, { open: true, dx: 10, dy: -80, w: 140 });
    });

    it("dragging the dot moves the anchor to the target under the pointer", () => {
      const e = entry("m-aaaaaa");
      const r = rig([e], { "m-aaaaaa": { x: 600, y: 300 } });
      r.layer.place();
      const dot = first(byClass(r.layer.element as unknown as FakeEl, "vg-memo-dot"));
      dispatch(dot, "pointerdown", { button: 0, clientX: 600, clientY: 300 });
      dispatch(fakeWindow, "pointermove", { clientX: 760, clientY: 300 });
      expect(r.fns.dropTargetAt).toHaveBeenCalledWith(e, 760, 300);
      expect(r.fns.dragHint).toHaveBeenLastCalledWith("タスク · 10/8", 760, 300);
      dispatch(fakeWindow, "pointerup");
      expect(r.fns.moveAnchor).toHaveBeenCalledWith(e, { anchor: { ...e.anchor, date: "2026-10-08" }, label: "タスク · 10/8" });
      expect(r.fns.dragHint).toHaveBeenLastCalledWith(null, 0, 0);
    });

    it("the dot follows the snapped anchor of the target, or the raw pointer without one", () => {
      const e = entry("m-aaaaaa");
      const r = rig([e], { "m-aaaaaa": { x: 600, y: 300 } });
      r.layer.place();
      const dot = first(byClass(r.layer.element as unknown as FakeEl, "vg-memo-dot"));
      dispatch(dot, "pointerdown", { button: 0, clientX: 600, clientY: 300 });
      // The context answers pointOf for the would-be anchor; a target the chart cannot place falls back to the pointer.
      r.points.set("m-aaaaaa", { x: 650, y: 120 });
      dispatch(fakeWindow, "pointermove", { clientX: 500, clientY: 100 });
      expect(dot.style.left).toBe("650px");
      expect(dot.style.top).toBe("120px");
      expect(first(boxes(r)).style.left).toBe(`${650 + 28}px`);
      dispatch(fakeWindow, "pointermove", { clientX: 100, clientY: 100 });
      expect(r.fns.dragHint).toHaveBeenLastCalledWith(null, 100, 100);
      expect(dot.style.left).toBe("100px");
      expect(dot.style.top).toBe("100px");
      dispatch(fakeWindow, "pointerup");
      expect(r.fns.moveAnchor).not.toHaveBeenCalled();
    });

    it("dropping the dot on no target snaps it back and saves nothing", () => {
      const r = rig([entry("m-aaaaaa")], { "m-aaaaaa": { x: 600, y: 300 } });
      r.layer.place();
      const dot = first(byClass(r.layer.element as unknown as FakeEl, "vg-memo-dot"));
      dispatch(dot, "pointerdown", { button: 0, clientX: 600, clientY: 300 });
      dispatch(fakeWindow, "pointermove", { clientX: 100, clientY: 100 });
      dispatch(fakeWindow, "pointerup");
      expect(r.fns.moveAnchor).not.toHaveBeenCalled();
      expect(dot.style.left).toBe("600px");
      expect(dot.style.top).toBe("300px");
    });

    it("the dragged memo ignores the pointer while dragging, so the hit test sees the chart", () => {
      const r = rig([entry("m-aaaaaa")]);
      r.layer.place();
      const dot = first(byClass(r.layer.element as unknown as FakeEl, "vg-memo-dot"));
      const group = (dot as any).parentNode as FakeEl;
      dispatch(dot, "pointerdown", { button: 0, clientX: 600, clientY: 300 });
      expect(group.classList.contains("is-dot-dragging")).toBe(true);
      expect(r.fns.dotDragging).toHaveBeenLastCalledWith(true);
      dispatch(fakeWindow, "pointerup");
      expect(r.fns.dotDragging).toHaveBeenLastCalledWith(false);
      expect(group.classList.contains("is-dot-dragging")).toBe(false);
    });

    it("dropping the dot on its own anchor, or a click without moving, moves nothing", () => {
      const e = entry("m-aaaaaa");
      const r = rig([e]);
      r.layer.place();
      const dot = first(byClass(r.layer.element as unknown as FakeEl, "vg-memo-dot"));
      dispatch(dot, "pointerdown", { button: 0, clientX: 600, clientY: 300 });
      dispatch(fakeWindow, "pointerup");
      r.fns.dropTargetAt.mockImplementationOnce((x: MemoEntry) => ({ anchor: { ...x.anchor }, label: "同じ" }));
      dispatch(dot, "pointerdown", { button: 0, clientX: 600, clientY: 300 });
      dispatch(fakeWindow, "pointermove", { clientX: 650, clientY: 300 });
      dispatch(fakeWindow, "pointerup");
      expect(r.fns.moveAnchor).not.toHaveBeenCalled();
    });

    it("right-click on a bubble or pin opens the memo menu", () => {
      const e = entry("m-aaaaaa");
      const r = rig([e, entry("m-bbbbbb")], {}, { ganttMemoLayout: { "m-bbbbbb": { open: false, dx: 0, dy: 0, w: 220 } } });
      r.layer.place();
      const evt = dispatch(first(boxes(r)), "contextmenu");
      expect(evt["__defaultPrevented"]).toBe(true);
      expect(r.fns.openMenu).toHaveBeenCalledWith(expect.anything(), e);
      dispatch(first(pins(r)), "contextmenu");
      expect(r.fns.openMenu).toHaveBeenCalledTimes(2);
    });
  });

  describe("editing", () => {
    async function openEditor(r: Rig): Promise<FakeEl> {
      r.layer.place();
      await flush();
      dispatch(first(byClass(r.layer.element as unknown as FakeEl, "vg-memo-text")), "dblclick");
      const area = first(byClass(r.layer.element as unknown as FakeEl, "vg-memo-edit"));
      expect(area).toBeDefined();
      return area;
    }

    it("double-click turns the text into a text area holding the text", async () => {
      const area = await openEditor(rig([entry("m-aaaaaa")]));
      expect(area.tagName).toBe("TEXTAREA");
      expect(area.value).toBe("本文 m-aaaaaa");
    });

    it("Enter confirms and saves the new text", async () => {
      const r = rig([entry("m-aaaaaa")]);
      const area = await openEditor(r);
      area.value = "書き換え\n";
      const evt = dispatch(area, "keydown", key("Enter"));
      await flush();
      expect(evt["__defaultPrevented"]).toBe(true);
      expect(r.fns.saveText).toHaveBeenCalledWith(r.entries[0]?.meta, "書き換え");
      expect(byClass(r.layer.element as unknown as FakeEl, "vg-memo-edit")).toHaveLength(0);
      expect(byClass(r.layer.element as unknown as FakeEl, "vg-memo-text")[0]?.textContent).toBe("書き換え");
    });

    it("Shift+Enter inserts a newline instead of confirming", async () => {
      const r = rig([entry("m-aaaaaa")]);
      const area = await openEditor(r);
      const evt = dispatch(area, "keydown", key("Enter", { shiftKey: true }));
      expect(evt["__defaultPrevented"]).toBeUndefined();
      expect(r.fns.saveText).not.toHaveBeenCalled();
      expect(byClass(r.layer.element as unknown as FakeEl, "vg-memo-edit")).toHaveLength(1);
    });

    it("Enter while the IME is composing does not confirm", async () => {
      const r = rig([entry("m-aaaaaa")]);
      const area = await openEditor(r);
      area.value = "かな";
      dispatch(area, "keydown", key("Enter", { isComposing: true }));
      dispatch(area, "keydown", key("Enter", { keyCode: 229 }));
      expect(r.fns.saveText).not.toHaveBeenCalled();
      expect(byClass(r.layer.element as unknown as FakeEl, "vg-memo-edit")).toHaveLength(1);
    });

    it("Esc cancels and keeps the old text", async () => {
      const r = rig([entry("m-aaaaaa")]);
      const area = await openEditor(r);
      area.value = "捨てる";
      dispatch(area, "keydown", key("Escape"));
      await flush();
      expect(r.fns.saveText).not.toHaveBeenCalled();
      expect(byClass(r.layer.element as unknown as FakeEl, "vg-memo-text")[0]?.textContent).toBe("本文 m-aaaaaa");
    });

    it("confirming unchanged or emptied text saves nothing", async () => {
      const r = rig([entry("m-aaaaaa")]);
      const area = await openEditor(r);
      dispatch(area, "keydown", key("Enter"));
      await flush();
      expect(r.fns.saveText).not.toHaveBeenCalled();
      const again = await openEditor(r);
      again.value = "   ";
      dispatch(again, "keydown", key("Enter"));
      await flush();
      expect(r.fns.saveText).not.toHaveBeenCalled();
    });

    it("shows the old text again when the save fails", async () => {
      const r = rig([entry("m-aaaaaa")]);
      r.fns.saveText.mockRejectedValueOnce(new Error("disk"));
      const area = await openEditor(r);
      area.value = "失敗する";
      dispatch(area, "keydown", key("Enter"));
      await flush();
      expect(byClass(r.layer.element as unknown as FakeEl, "vg-memo-text")[0]?.textContent).toBe("本文 m-aaaaaa");
    });

    it("an AI proposal cannot be edited, moved or closed", () => {
      const r = rig([entry("m-aaaaaa", { proposal: "変更", text: "提案" })]);
      r.layer.place();
      const layer = r.layer.element as unknown as FakeEl;
      dispatch(first(byClass(layer, "vg-memo-text")), "dblclick");
      expect(byClass(layer, "vg-memo-edit")).toHaveLength(0);
      expect(byClass(layer, "vg-memo-btn")).toHaveLength(0);
      expect(byClass(layer, "vg-memo-resize")).toHaveLength(0);
      expect(first(boxes(r)).classList.contains("is-ai")).toBe(true);
      expect(first(byClass(layer, "vg-memo-mark")).textContent).toBe("AI提案・変更");
      dispatch(first(boxes(r)), "contextmenu");
      expect(r.fns.openMenu).not.toHaveBeenCalled();
    });

    it("a proposed deletion is drawn faded", () => {
      const r = rig([entry("m-aaaaaa", { proposal: "削除", text: "消える" })]);
      r.layer.place();
      expect(first(boxes(r)).classList.contains("is-deleted")).toBe(true);
    });
  });

  describe("a new memo", () => {
    function begin(r: Rig, commit = vi.fn(async (text: string) => meta("m-nnnnnn", { date: text }))): { area: FakeEl; commit: typeof commit } {
      r.layer.beginDraft({ id: "draft", anchor: { kind: "free", date: "2026-10-05" }, where: "その他", text: "" }, commit);
      return { area: first(byClass(r.layer.element as unknown as FakeEl, "vg-memo-edit")), commit };
    }

    it("opens a bubble in edit mode and writes nothing yet", () => {
      const r = rig([]);
      r.points.set("draft", { x: 600, y: 300 });
      const { area, commit } = begin(r);
      expect(area).toBeDefined();
      expect(area.focused).toBe(true);
      expect(commit).not.toHaveBeenCalled();
    });

    it("Enter creates the memo with the typed text and stores its first layout", async () => {
      const r = rig([]);
      r.points.set("draft", { x: 600, y: 300 });
      const { area, commit } = begin(r);
      area.value = "最初のメモ\n";
      dispatch(area, "keydown", key("Enter"));
      await flush();
      expect(commit).toHaveBeenCalledWith("最初のメモ");
      expect(r.settings.ganttMemoLayout["m-nnnnnn"]?.open).toBe(true);
      expect(r.fns.saveLayout).toHaveBeenCalled();
    });

    it("Shift+Enter and IME Enter do not create it", () => {
      const r = rig([]);
      r.points.set("draft", { x: 600, y: 300 });
      const { area, commit } = begin(r);
      area.value = "a";
      dispatch(area, "keydown", key("Enter", { shiftKey: true }));
      dispatch(area, "keydown", key("Enter", { isComposing: true }));
      expect(commit).not.toHaveBeenCalled();
    });

    it("Esc and empty text create nothing and remove the bubble", async () => {
      const r = rig([]);
      r.points.set("draft", { x: 600, y: 300 });
      let { area, commit } = begin(r);
      area.value = "書きかけ";
      dispatch(area, "keydown", key("Escape"));
      await flush();
      expect(commit).not.toHaveBeenCalled();
      expect(boxes(r)).toHaveLength(0);
      ({ area, commit } = begin(r));
      area.value = "  \n ";
      dispatch(area, "keydown", key("Enter"));
      await flush();
      expect(commit).not.toHaveBeenCalled();
      expect(boxes(r)).toHaveLength(0);
      expect(r.layer.nodeCount).toBe(0);
    });

    it("keeps the draft while the chart is re-placed", () => {
      const r = rig([]);
      r.points.set("draft", { x: 600, y: 300 });
      begin(r);
      r.layer.place();
      expect(r.layer.nodeCount).toBe(1);
      expect(byClass(r.layer.element as unknown as FakeEl, "vg-memo-edit")).toHaveLength(1);
    });
  });
});
