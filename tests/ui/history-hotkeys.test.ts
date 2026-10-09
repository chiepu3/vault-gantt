import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import type { Component } from "obsidian";
import { registerHistoryHotkeys } from "../../src/ui/history-hotkeys";
import { dispatch, makeFakeEl, type FakeEl } from "../stubs/fake-dom";

describe("view history hotkeys", () => {
  let container: FakeEl, win: FakeEl;
  const actions = { undoLastAction: vi.fn(async () => {}), redoLastAction: vi.fn(async () => {}) };
  const component = { registerDomEvent: (el: EventTarget, type: string, cb: (event: Event) => void, options: boolean) => el.addEventListener(type, cb, options) } as unknown as Component;
  const key = (target: FakeEl, overrides = {}) => dispatch(win, "keydown", {
    target, key: "z", ctrlKey: true, stopImmediatePropagation: vi.fn(), ...overrides,
  });
  beforeEach(() => {
    container = makeFakeEl(); win = makeFakeEl("window");
    vi.stubGlobal("window", win);
    Platform.isMacOS = false;
  });
  afterEach(() => { Platform.isMacOS = false; vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });

  it.each([false, true])("uses the platform modifier (mac=%s) and capture before the document keymap", (mac) => {
    Platform.isMacOS = mac;
    const register = vi.spyOn(component, "registerDomEvent");
    registerHistoryHotkeys(component, container as unknown as HTMLElement, actions);
    expect(register.mock.calls[1][3]).toBe(true);
    const modifiers = { ctrlKey: !mac, metaKey: mac };
    expect(key(container, modifiers).__defaultPrevented).toBe(true);
    key(container, { ...modifiers, shiftKey: true, key: "Z" });
    key(container, { ...modifiers, key: "y" });
    expect(actions.undoLastAction).toHaveBeenCalledOnce();
    expect(actions.redoLastAction).toHaveBeenCalledTimes(2);
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
    expect(win.listeners.keydown).toHaveLength(0); expect(container.listeners.pointerdown).toHaveLength(0);
  });
});
