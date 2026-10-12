import { Modal } from "obsidian";
import type { App } from "obsidian";
import type { TaskRow } from "../core/types";
import { getStatusLabel } from "../core/utils";

/**
 * Minimal navigation dependency the finder needs: open the chosen task.
 * The concrete NavigationService (src/app/navigation-service.ts) satisfies
 * this structurally.
 */
export interface TaskItemOpener {
  openTaskItem(item: TaskRow): Promise<void> | void;
}

/**
 *
 *
 * Task search dialog: a fuzzy-filtered flat list of all parent tasks and
 * subtasks. The user types to filter, moves the selection with arrow keys,
 * and confirms with Enter or a click; the chosen row opens through
 * NavigationService.openTaskItem. Search matches any of five fields
 * (name, status label, current status, space-joined tags, file path) and
 * each suggestion renders a bold title plus a meta line.
 */
export class TaskFinderModal extends Modal {
  private filtered: TaskRow[];
  private selectedIndex = 0;
  private listEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly navigation: TaskItemOpener,
    private readonly items: TaskRow[]
  ) {
    super(app);
    // the dialog receives the full flattened task list
    this.filtered = items.slice();
  }

  onOpen(): void {
    const content = this.contentEl;
    content.replaceChildren();

    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = "タスクを検索...";
    input.addEventListener("input", () => {
      this.setQuery(input.value);
    });
    input.addEventListener("keydown", (event) => {
      this.handleKeydown(event);
    });
    content.appendChild(input);

    this.listEl = document.createElement("div");
    this.listEl.className = "vg-modal-list vg-finder-list";
    content.appendChild(this.listEl);

    this.renderList();
    input.focus();
  }

  onClose(): void {
    this.contentEl.replaceChildren();
    this.listEl = null;
  }

  /**
 * live filtering while the user types.
 */
  setQuery(query: string): void {
    this.filtered = this.items.filter((item) => matchesQuery(query, item));
    this.selectedIndex = 0;
    this.renderList();
  }

  /**
 * arrow-key selection movement, clamped to the list bounds.
 */
  moveSelection(delta: number): void {
    if (this.filtered.length === 0) {
      this.selectedIndex = 0;
      return;
    }
    const next = this.selectedIndex + delta;
    this.selectedIndex = Math.max(
      0,
      Math.min(this.filtered.length - 1, next)
    );
    this.renderList();
  }

  /**
 * Enter confirms the highlighted row.
 */
  confirmSelection(): void {
    const item = this.filtered[this.selectedIndex];
    if (item) {
      this.chooseItem(item);
    }
  }

  /**
 * keyboard handling on the search input.
 */
  handleKeydown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.moveSelection(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      this.moveSelection(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      this.confirmSelection();
    }
  }

  /**
 * selecting a row (click or Enter) closes the dialog
 * and opens the task through NavigationService.openTaskItem.
 */
  chooseItem(item: TaskRow): void {
    this.close();
    void this.navigation.openTaskItem(item);
  }

  private renderList(): void {
    const listEl = this.listEl;
    if (!listEl) {
      // Logic-only usage without a rendered DOM (unit tests)
      return;
    }
    listEl.replaceChildren();
    if (this.filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "vg-empty";
      empty.textContent = "該当するタスクがありません";
      listEl.appendChild(empty);
      return;
    }
    let selectedRow: HTMLElement | null = null;
    this.filtered.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "vg-list-row";
      // bold, larger task name
      const titleEl = document.createElement("div");
      titleEl.className = "task-workbench-finder-title";
      titleEl.textContent = item.displayName || item.title;
      // smaller meta line
      // "子/親 • [ステータス] • [期限日 or 期限なし] • [ファイルパス]"
      const metaEl = document.createElement("div");
      metaEl.className = "task-workbench-finder-meta";
      metaEl.textContent = suggestionMeta(item);
      row.appendChild(titleEl);
      row.appendChild(metaEl);
      if (index === this.selectedIndex) {
        row.className = "vg-list-row is-selected";
        selectedRow = row;
      }
      row.addEventListener("click", () => {
        this.chooseItem(item);
      });
      listEl.appendChild(row);
    });
    const target = selectedRow as HTMLElement | null;
    if (target && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ block: "nearest" });
    }
  }
}

/**
 * meta-line template — kind prefix, status label, due date
 * ("期限なし" when absent) and file path, joined by " • ".
 */
function suggestionMeta(item: TaskRow): string {
  const kindLabel = item.kind === "subtask" ? "子" : "親";
  const due = item.dueDate || "期限なし";
  return `${kindLabel} • ${getStatusLabel(item.statusLabel)} • ${due} • ${item.file.path}`;
}

/**
 * an item matches when the query
 * fuzzy-matches ANY of five fields — displayName/title, the localized
 * status label, currentStatus, the space-joined tags, or the file path.
 */
function matchesQuery(query: string, item: TaskRow): boolean {
  const q = query.trim().toLowerCase();
  if (!q) {
    return true;
  }
  return (
    fuzzyIncludes(item.displayName, q) ||
    fuzzyIncludes(item.title, q) ||
    fuzzyIncludes(getStatusLabel(item.statusLabel), q) ||
    fuzzyIncludes(item.currentStatus ?? "", q) ||
    fuzzyIncludes((item.tags ?? []).join(" "), q) ||
    fuzzyIncludes(item.file.path, q)
  );
}

/**
 * Substring match first, then a subsequence fallback (minimal fuzzy
 * matching, deliberately simple — the finder is an experimental
 * convenience, not a search engine).
 */
function fuzzyIncludes(text: string, query: string): boolean {
  const target = text.toLowerCase();
  if (target.includes(query)) {
    return true;
  }
  let qi = 0;
  for (let ti = 0; ti < target.length && qi < query.length; ti += 1) {
    if (target[ti] === query[qi]) {
      qi += 1;
    }
  }
  return qi === query.length;
}
