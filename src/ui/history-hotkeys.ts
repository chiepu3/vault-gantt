import { Platform } from "obsidian";
import type { Component } from "obsidian";

interface HistoryActions {
  undoLastAction(): Promise<void>;
  redoLastAction(): Promise<void>;
}

function isEditable(target: Node | null): boolean {
  for (let node = target; node; node = node.parentNode) {
    const element = node as HTMLElement;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)
      || element.isContentEditable
      || element.getAttribute?.("contenteditable") === ""
      || element.getAttribute?.("contenteditable") === "true"
      || element.getAttribute?.("contenteditable") === "plaintext-only"
      || ["cm-editor", "markdown-source-view", "monaco-editor"].some((name) => element.classList?.contains(name))) return true;
  }
  return false;
}

function isInside(container: HTMLElement, target: Node | null): boolean {
  for (let node = target; node; node = node.parentNode) {
    if (node === container) return true;
  }
  return false;
}

/** View-local history, intercepted before Obsidian's document keymap. */
export function registerHistoryHotkeys(component: Component, container: HTMLElement, actions: HistoryActions): () => void {
  const win = container.ownerDocument?.defaultView ?? window;
  container.tabIndex = -1;
  const onPointerDown = (event: PointerEvent): void => {
    // Bars/cells are not normally focusable. Move focus off a previous input
    // when interacting with them so subsequent keys belong to this view.
    if (event.button === 0 && !event.defaultPrevented && !isEditable(event.target as Node | null)) {
      container.focus({ preventScroll: true });
    }
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as Node | null;
    if (event.defaultPrevented || event.isComposing || event.altKey
      || !(Platform.isMacOS ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
      || !isInside(container, target) || isEditable(target)) return;
    const key = event.key.toLowerCase();
    const undo = key === "z" && !event.shiftKey;
    const redo = (key === "z" && event.shiftKey) || (key === "y" && !event.shiftKey);
    if (!undo && !redo) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void (undo ? actions.undoLastAction() : actions.redoLastAction());
  };
  component.registerDomEvent(container, "pointerdown", onPointerDown, true);
  component.registerDomEvent(win, "keydown", onKeyDown, true);
  return () => {
    container.removeEventListener("pointerdown", onPointerDown, true);
    win.removeEventListener("keydown", onKeyDown, true);
  };
}
