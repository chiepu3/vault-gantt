/** One memo in the Workbench list: where it is and whether its bubble is open on the Gantt. */
export interface MemoListItem {
  id: string;
  /** What the note is called (the first line of the text, from the file name). */
  headline: string;
  /** The task it is attached to, and the day. */
  where: string;
  open: boolean;
}

export interface MemoPopoverOptions {
  anchor: HTMLElement;
  items: MemoListItem[];
  /** Opens or closes bubbles; ids are memo ids. */
  onToggle(ids: string[], open: boolean): void | Promise<void>;
  /** 「Ganttで表示」: opens the Gantt scrolled to the memo. */
  onReveal(id: string): void | Promise<void>;
  /** Called once, whichever way the popover closed. */
  onClose?(): void;
}

function el(parent: HTMLElement, tag: string, cls: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  parent.appendChild(node);
  return node;
}

/**
 * A small list under `anchor` of every memo, to open or close its bubble and to jump to it on the Gantt. It never edits
 * a memo. Closes on Escape or a click outside, and returns its closer.
 */
export function openMemoPopover(options: MemoPopoverOptions): () => void {
  const { anchor, items } = options;
  const root = document.createElement("div");
  root.classList.add("twb-memo-popover");

  const head = el(root, "div", "twb-memo-popover-head");
  el(head, "span", "twb-memo-popover-title", `メモ ${items.length}件`);
  const bulk = el(head, "div", "twb-memo-popover-bulk");
  const list = el(root, "div", "twb-memo-popover-list");

  const paint = (): void => {
    list.replaceChildren();
    if (!items.length) { el(list, "div", "twb-memo-popover-empty", "メモはまだありません。Ganttのバーや行を右クリックして追加できます。"); return; }
    for (const item of items) {
      const row = el(list, "div", item.open ? "twb-memo-popover-row" : "twb-memo-popover-row is-closed");
      const text = el(row, "div", "twb-memo-popover-text");
      el(text, "div", "twb-memo-popover-headline", item.headline);
      el(text, "div", "twb-memo-popover-where", item.where);
      const toggle = el(row, "button", "twb-memo-popover-toggle", item.open ? "閉じる" : "開く");
      toggle.title = item.open ? "吹き出しをピンに畳みます" : "吹き出しを開きます";
      toggle.addEventListener("click", () => { item.open = !item.open; void options.onToggle([item.id], item.open); paint(); });
      const reveal = el(row, "button", "twb-memo-popover-reveal", "Ganttで表示");
      reveal.addEventListener("click", () => { close(); void options.onReveal(item.id); });
    }
  };
  for (const [label, open] of [["すべて開く", true], ["すべて閉じる", false]] as const) {
    const button = el(bulk, "button", "twb-memo-popover-bulk-button", label) as HTMLButtonElement;
    button.disabled = !items.length;
    button.addEventListener("click", () => { for (const item of items) item.open = open; void options.onToggle(["*"], open); paint(); });
  }

  const onOutside = (evt: PointerEvent): void => {
    if (!root.contains(evt.target as Node) && !anchor.contains(evt.target as Node)) close();
  };
  const onKey = (evt: KeyboardEvent): void => { if (evt.key === "Escape") close(); };
  function close(): void {
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    root.remove();
    options.onClose?.();
  }

  paint();
  document.body.appendChild(root);
  const rect = anchor.getBoundingClientRect();
  const width = root.offsetWidth;
  const height = root.offsetHeight;
  const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
  const top = rect.bottom + 4 + height > window.innerHeight ? Math.max(8, rect.top - height - 4) : rect.bottom + 4;
  root.style.left = `${left}px`;
  root.style.top = `${top}px`;
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("keydown", onKey, true);
  return close;
}
