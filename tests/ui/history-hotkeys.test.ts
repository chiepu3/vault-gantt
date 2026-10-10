import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import type { Component } from "obsidian";
import { registerHistoryHotkeys } from "../../src/ui/history-hotkeys";
import { dispatch, makeFakeEl, type FakeEl } from "../stubs/fake-dom";

describe("view history hotkeys", () => {
  let container: FakeEl, win: FakeEl;
  let cleanups: Array<() => void>;
  const actions = { undoLastAction: vi.fn(async () => {}), redoLastAction: vi.fn(async () => {}) };
  const component = { registerDomEvent: (el: EventTarget, type: string, cb: (event: Event) => void, options: boolean) => {
    el.addEventListener(type, cb, options);
    cleanups.push(() => el.removeEventListener(type, cb, options));
  } } as unknown as Component;
  const key = (target: FakeEl, overrides = {}) => dispatch(container, "keydown", {
    target, key: "z", ctrlKey: true, stopImmediatePropagation: vi.fn(), ...overrides,
  });
  beforeEach(() => {
    container = makeFakeEl(); win = makeFakeEl("window");
    cleanups = [];
    vi.stubGlobal("window", win);
    Platform.isMacOS = false;
  });
  afterEach(() => { Platform.isMacOS = false; vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });

  it.each([false, true])("uses the platform modifier (mac=%s) and capture on the container", (mac) => {
    Platform.isMacOS = mac;
    const register = vi.spyOn(component, "registerDomEvent");
    registerHistoryHotkeys(component, container as unknown as HTMLElement, actions);
    expect(register.mock.calls[1][0]).toBe(container);
    expect(register.mock.calls[1][3]).toBe(true);
    const modifiers = { ctrlKey: !mac, metaKey: mac };
    expect(key(container, modifiers).__defaultPrevented).toBe(true);
    key(container, { ...modifiers, shiftKey: true, key: "Z" });
    key(container, { ...modifiers, key: "y" });
    expect(actions.undoLastAction).toHaveBeenCalledOnce();
    expect(actions.redoLastAction).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("ignores held undo and redo shortcuts (mac=%s)", (mac) => {
    Platform.isMacOS = mac;
    registerHistoryHotkeys(component, container as unknown as HTMLElement, actions);
    const modifiers = { ctrlKey: !mac, metaKey: mac };
    for (const shortcut of [{ key: "z" }, { key: "z", shiftKey: true }, { key: "y" }]) {
      key(container, { ...modifiers, ...shortcut });
      for (let i = 0; i < 3; i++) {
        const event = key(container, { ...modifiers, ...shortcut, repeat: true });
        expect(event.__defaultPrevented).toBeUndefined();
        expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
      }
    }
    expect(actions.undoLastAction).toHaveBeenCalledOnce();
    expect(actions.redoLastAction).toHaveBeenCalledTimes(2);
  });

  it.each(["dispose", "unload"])("keeps hotkeys after window moves and removes listeners on %s", (cleanup) => {
    Object.assign(container, { ownerDocument: { defaultView: win } });
    const dispose = registerHistoryHotkeys(component, container as unknown as HTMLElement, actions);
    const bar = makeFakeEl(); container.appendChild(bar);
    const popout = makeFakeEl("window");
    for (const currentWindow of [popout, win, popout]) {
      Object.assign(container, { ownerDocument: { defaultView: currentWindow } });
      expect(key(bar).__defaultPrevented).toBe(true);
      expect(key(bar, { shiftKey: true }).__defaultPrevented).toBe(true);
      expect(win.listeners.keydown ?? []).toHaveLength(0);
      expect(popout.listeners.keydown ?? []).toHaveLength(0);
    }
    expect(actions.undoLastAction).toHaveBeenCalledTimes(3);
    expect(actions.redoLastAction).toHaveBeenCalledTimes(3);
    if (cleanup === "dispose") dispose();
    else cleanups.forEach((fn) => fn());
    expect(container.listeners.keydown).toHaveLength(0);
    expect(container.listeners.pointerdown).toHaveLength(0);
    key(bar);
    dispatch(container, "pointerdown", { button: 0, target: bar });
    expect(actions.undoLastAction).toHaveBeenCalledTimes(3);
    expect(container.focused).toBeFalsy();
  });

  it.each(["input", "textarea", "select", "contenteditable", "plaintext-only", "cm-editor", "markdown-source-view", "monaco-editor"])("preserves native/editor undo in %s, including nested targets", (kind) => {
    registerHistoryHotkeys(component, container as unknown as HTMLElement, actions);
    const editor = makeFakeEl(["input", "textarea", "select"].includes(kind) ? kind : "div");
    if (kind === "contenteditable" || kind === "plaintext-only") editor.setAttribute("contenteditable", kind === "contenteditable" ? "true" : kind);
    else editor.classList.add(kind);
    const nested = makeFakeEl("span"); container.appendChild(editor); editor.appendChild(nested);
    for (const target of [editor, nested]) {
      expect(key(target).__defaultPrevented).toBeUndefined();
      expect(key(target, { shiftKey: true }).__defaultPrevented).toBeUndefined();
      expect(key(target, { key: "y" }).__defaultPrevented).toBeUndefined();
      dispatch(container, "pointerdown", { button: 0, target });
    }
    expect(container.focused).toBeFalsy();
    expect(actions.undoLastAction).not.toHaveBeenCalled(); expect(actions.redoLastAction).not.toHaveBeenCalled();
  });

  it("leaves other views, IME, handled events and unrelated modifiers alone", () => {
    registerHistoryHotkeys(component, container as unknown as HTMLElement, actions);
    key(makeFakeEl("div"));
    for (const overrides of [{ isComposing: true }, { defaultPrevented: true }, { altKey: true }, { ctrlKey: false }, { metaKey: true }, { key: "a" }, { key: "y", shiftKey: true }]) {
      expect(key(container, overrides).__defaultPrevented).toBeUndefined();
    }
    expect(actions.undoLastAction).not.toHaveBeenCalled(); expect(actions.redoLastAction).not.toHaveBeenCalled();
  });

  it("focuses a clicked bar and cleans up both listeners", () => {
    const dispose = registerHistoryHotkeys(component, container as unknown as HTMLElement, actions);
    const bar = makeFakeEl(); container.appendChild(bar);
    dispatch(container, "pointerdown", { button: 0, target: bar });
    expect(container.focused).toBe(true);
    dispose();
    expect(container.listeners.keydown).toHaveLength(0); expect(container.listeners.pointerdown).toHaveLength(0);
  });
});
