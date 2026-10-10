/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Shared hand-rolled fake DOM for UI tests (vitest runs with
 * environment: "node" — no jsdom). Extends the minimal inline fake used by
 * tests/ui/task-finder-modal.test.ts with the surface the workbench view
 * needs: classList, dataset, attributes, multi-class add, parent links,
 * remove/empty, text nodes and an event dispatch helper.
 *
 * Keep extensions generic so this stub stays reusable.
 */

export interface FakeEl {
  tagName: string;
  nodeType: number;
  children: FakeEl[];
  parentNode: FakeEl | null;
  listeners: Record<string, Array<(event: any) => void>>;
  attributes: Record<string, string>;
  dataset: Record<string, string>;
  style: Record<string, string>;
  textContent: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  type: string;
  placeholder: string;
  title: string;
  focused: boolean;
  /** Set by select — tracks the select-all call for autofocus tests. */
  selected: boolean;
  /** HTMLTextAreaElement.rows — the visible line count of a textarea. */
  rows: number;

  // clamping, so tests can set scrollLeft/scrollWidth/clientWidth directly
  // and read back exactly what the view assigned. ---
  scrolledIntoView?: { block?: string; inline?: string };
  scrollIntoView(options?: { block?: string; inline?: string }): void;
  scrollLeft: number;
  scrollTop: number;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;

  // writable numbers (default 0) with no layout engine behind them: tests
  // that exercise the popover's measured-height / viewport logic assign the
  // values directly (e.g. `popoverEl.offsetHeight = 250`, or
  // `(window as any).innerWidth = 1200` on the fake window). innerWidth /
  // innerHeight only make sense on the fake `window` element, but live here
  // as generic fields to match this stub's one-shape-fits-all convention. ---
  offsetWidth: number;
  offsetHeight: number;
  /** Border-left width in real DOM terms — plain writable number, default 0, same convention as offsetWidth/offsetHeight above. */
  clientLeft: number;
  innerWidth: number;
  innerHeight: number;
  getBoundingClientRect(): {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  };
  classList: {
    add(...names: string[]): void;
    remove(...names: string[]): void;
    contains(name: string): boolean;
    toggle(name: string, force?: boolean): boolean;
    [Symbol.iterator](): IterableIterator<string>;
  };
  className: string;







  readonly isConnected: boolean;
  /** The next element in the parent's children array (null when last / parentless). */
  readonly nextSibling: FakeEl | null;
  appendChild(child: FakeEl): FakeEl;
  /**
 * Inserts `child` immediately before `ref` (appends when ref is null),
 * detaching it from any previous parent first — same move semantics as
 * the real DOM. Throws when `ref` is not a child of this element, like
 * the real DOM's NotFoundError.
 */
  insertBefore(child: FakeEl, ref: FakeEl | null): FakeEl;
  replaceChildren(...children: FakeEl[]): void;
  remove(): void;
  empty(): void;
  addEventListener(type: string, cb: (event: any) => void): void;
  removeEventListener(type: string, cb: (event: any) => void): void;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  focus(): void;
  select(): void;








  hide(): void;
  show(): void;








  pointerCaptures: number[];
  setPointerCapture(pointerId: number): void;
  releasePointerCapture(pointerId: number): void;
  hasPointerCapture(pointerId: number): boolean;
}

export function makeFakeEl(tag = "div"): FakeEl {
  const classes = new Set<string>();
  const el: any = {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    children: [] as FakeEl[],
    parentNode: null as FakeEl | null,
    listeners: {} as Record<string, Array<(event: any) => void>>,
    attributes: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
    textContent: "",
    value: "",
    checked: false,
    disabled: false,
    type: "",
    placeholder: "",
    title: "",
    focused: false,
    selected: false,
    rows: 0,
    scrollIntoView(options?: { block?: string; inline?: string }): void {
      el.scrolledIntoView = options;
    },
    scrollLeft: 0,
    scrollTop: 0,
    scrollWidth: 0,
    scrollHeight: 0,
    clientWidth: 0,
    clientHeight: 0,
    offsetWidth: 0,
    offsetHeight: 0,
    clientLeft: 0,
    innerWidth: 0,
    innerHeight: 0,
    getBoundingClientRect(): {
      left: number;
      top: number;
      right: number;
      bottom: number;
      width: number;
      height: number;
    } {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    },
    classList: {
      add(...names: string[]): void {
        for (const name of names) {
          if (name !== "") {
            classes.add(name);
          }
        }
      },
      remove(...names: string[]): void {
        for (const name of names) {
          classes.delete(name);
        }
      },
      contains(name: string): boolean {
        return classes.has(name);
      },
      toggle(name: string, force?: boolean): boolean {
        const want = force === undefined ? !classes.has(name) : force;
        if (want) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
        return want;
      },
      [Symbol.iterator](): IterableIterator<string> {
        return classes.values();
      },
    },
    appendChild(child: FakeEl): FakeEl {
      // Real DOM never inserts a DocumentFragment itself (nodeType 11) —
      // only its children move to the target, in order, and the fragment
      // is left empty afterward. Without this, appending a fragment built
      // for batched insertion (e.g. task-gantt-view.ts's renderChartFull)
      // would wrongly nest all its children under one opaque "#fragment"
      // node instead of making them direct children of `el`.
      if (child.nodeType === 11) {
        const fragmentChildren = child.children.slice();
        child.children.length = 0;
        for (const fragmentChild of fragmentChildren) {
          fragmentChild.parentNode = el;
          el.children.push(fragmentChild);
        }
        return child;
      }
      (child as any).parentNode = el;
      el.children.push(child);
      return child;
    },
    insertBefore(child: FakeEl, ref: FakeEl | null): FakeEl {
      // Move semantics: detach from the previous parent first (which may
      // be this very element — the index is computed AFTER the removal,
      // matching the real DOM).
      const oldParent = (child as any).parentNode as FakeEl | null;
      if (oldParent) {
        const oldIndex = oldParent.children.indexOf(child);
        if (oldIndex >= 0) {
          oldParent.children.splice(oldIndex, 1);
        }
      }
      (child as any).parentNode = el;
      if (ref === null) {
        el.children.push(child);
        return child;
      }
      const index = el.children.indexOf(ref);
      if (index < 0) {
        throw new Error(
          "insertBefore: reference node is not a child of this parent"
        );
      }
      el.children.splice(index, 0, child);
      return child;
    },
    replaceChildren(...newChildren: FakeEl[]): void {
      el.children = [];
      for (const child of newChildren) {
        (child as any).parentNode = el;
        el.children.push(child);
      }
    },
    remove(): void {
      const parent = el.parentNode;
      if (parent) {
        const index = parent.children.indexOf(el);
        if (index >= 0) {
          parent.children.splice(index, 1);
        }
        el.parentNode = null;
      }
    },
    // Obsidian's HTMLElement.empty extension (used by the workbench view).
    // Does NOT touch scrollLeft/scrollTop: real browsers only clamp scroll
    // position against scrollWidth/Height at layout time, and this codebase
    // always calls empty and repopulates synchronously within the same
    // function (no yield to the browser in between). The real view relies on
    // scrollLeft surviving an empty-and-rebuild cycle. Resetting it here made
    // the holiday-toggle scroll-preservation test stricter but broke the
    // right-extension test, so the stub leaves it unchanged.
    empty(): void {
      el.children = [];
    },
    addEventListener(type: string, cb: (event: any) => void): void {
      if (!el.listeners[type]) {
        el.listeners[type] = [];
      }
      el.listeners[type].push(cb);
    },
    removeEventListener(type: string, cb: (event: any) => void): void {
      const arr = el.listeners[type];
      if (arr) {
        el.listeners[type] = arr.filter((fn: (event: any) => void) => fn !== cb);
      }
    },
    setAttribute(name: string, value: string): void {
      el.attributes[name] = String(value);
    },
    getAttribute(name: string): string | null {
      return name in el.attributes ? el.attributes[name] : null;
    },
    focus(): void {
      el.focused = true;
    },
    select(): void {
      // selection range not modeled; the call itself is tracked so tests

      el.selected = true;
    },
    hide(): void {
      el.style.display = "none";
    },
    show(): void {
      delete el.style.display;
    },
    pointerCaptures: [] as number[],
    setPointerCapture(pointerId: number): void {
      if (!el.pointerCaptures.includes(pointerId)) {
        el.pointerCaptures.push(pointerId);
      }
    },
    releasePointerCapture(pointerId: number): void {
      const idx = el.pointerCaptures.indexOf(pointerId);
      if (idx >= 0) {
        el.pointerCaptures.splice(idx, 1);
      }
    },
    hasPointerCapture(pointerId: number): boolean {
      return el.pointerCaptures.includes(pointerId);
    },
  };

  Object.defineProperty(el, "className", {
    get(): string {
      return [...classes].join(" ");
    },
    set(value: string): void {
      classes.clear();
      for (const name of String(value).split(/\s+/)) {
        if (name !== "") {
          classes.add(name);
        }
      }
    },
  });

  Object.defineProperty(el, "isConnected", {
    get(): boolean {
      // Documented approximation (see the FakeEl.isConnected note): fake
      // elements have no Document root to reach, so "connected" reduces to
      // "has a parent".
      return el.parentNode !== null;
    },
  });

  Object.defineProperty(el, "nextSibling", {
    get(): FakeEl | null {
      const parent = el.parentNode;
      if (!parent) {
        return null;
      }
      const index = parent.children.indexOf(el);
      if (index < 0) {
        return null;
      }
      return parent.children[index + 1] ?? null;
    },
  });

  return el as FakeEl;
}

export function makeFakeTextNode(text: string): FakeEl {
  const node = makeFakeEl("#text");
  node.nodeType = 3;
  node.textContent = text;
  return node;
}












export function createFakeDocument(): {
  createElement(tag: string): FakeEl;

  createElementNS(namespace: string, tag: string): FakeEl;

  createDocumentFragment(): FakeEl;
  createTextNode(text: string): FakeEl;
  body: FakeEl;
} {
  return {
    createElement: (tag: string) => makeFakeEl(tag),

    createElementNS: (_namespace: string, tag: string) => makeFakeEl(tag),

    createDocumentFragment: () => {
      const fragment = makeFakeEl("#fragment");
      (fragment as any).nodeType = 11;
      return fragment;
    },
    createTextNode: (text: string) => makeFakeTextNode(text),
    body: makeFakeEl("body"),
  };
}

// --- Query / dispatch helpers ---------------------------------------------

/** Depth-first collect every descendant (inclusive) matching predicate. */
export function findAll(
  root: FakeEl,
  predicate: (el: FakeEl) => boolean
): FakeEl[] {
  const out: FakeEl[] = [];
  const walk = (node: FakeEl): void => {
    if (predicate(node)) {
      out.push(node);
    }
    for (const child of node.children) {
      walk(child);
    }
  };
  walk(root);
  return out;
}

export function byTag(root: FakeEl, tag: string): FakeEl[] {
  const upper = tag.toUpperCase();
  return findAll(root, (el) => el.tagName === upper);
}

export function byClass(root: FakeEl, className: string): FakeEl[] {
  return findAll(root, (el) => el.classList.contains(className));
}

/**
 * Fires every listener registered for `type` on `el` (no bubbling — the
 * view attaches handlers directly on the target elements). Returns the
 * event object, defaulting to a recording stopPropagation/preventDefault.
 */
export function dispatch(
  el: FakeEl,
  type: string,
  event: Record<string, unknown> = {}
): Record<string, unknown> {
  const evt: any = {
    type,
    stopPropagation: () => {
      evt.__propagationStopped = true;
    },
    preventDefault: () => {
      evt.__defaultPrevented = true;
    },
    ...event,
  };
  for (const cb of el.listeners[type] ?? []) {
    cb(evt);
  }
  return evt;
}

/**
 * Concatenated text of an element tree. Convention in this fake DOM: an
 * element either has its textContent set directly (no children) or carries
 * child nodes; text nodes hold their string in textContent. So the node's
 * own textContent plus the recursive children text never double-counts.
 */
export function deepText(root: FakeEl): string {
  let text = root.textContent;
  for (const child of root.children) {
    text += deepText(child);
  }
  return text;
}
