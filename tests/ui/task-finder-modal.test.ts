/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TaskFinderModal } from "../../src/ui/task-finder-modal";
import type { TaskRow } from "../../src/core/types";

function makeFakeEl(): any {
  const el: any = {
    children: [] as any[],
    listeners: {} as Record<string, Array<(e: any) => void>>,
    textContent: "",
    className: "",
    value: "",
    type: "",
    placeholder: "",
    appendChild(child: any): any {
      el.children.push(child);
      return child;
    },
    replaceChildren(): void {
      el.children = [];
    },
    addEventListener(type: string, cb: (e: any) => void): void {
      if (!el.listeners[type]) {
        el.listeners[type] = [];
      }
      el.listeners[type].push(cb);
    },
    focus: vi.fn(),
  };
  return el;
}

function makeRow(overrides: Record<string, unknown>): TaskRow {
  return {
    kind: "parent",
    id: "tasks/x.md",
    file: { path: "tasks/x.md" },
    title: "X",
    displayName: "X",
    statusLabel: "active",
    completed: false,
    currentStatus: "",
    tags: [],
    ...overrides,
  } as unknown as TaskRow;
}

function keyEvent(key: string): any {
  return { key, preventDefault: vi.fn() };
}

describe("TaskFinderModal", () => {
  let nav: { openTaskItem: ReturnType<typeof vi.fn> };
  let items: TaskRow[];

  beforeEach(() => {
    vi.stubGlobal("document", {
      createElement: () => makeFakeEl(),
    });
    nav = { openTaskItem: vi.fn() };
    items = [
      makeRow({ id: "p1", title: "Design review", displayName: "Design review" }),
      makeRow({
        kind: "subtask",
        id: "p1::draft-agenda",
        key: "draft-agenda",
        title: "Draft agenda",
        displayName: "Draft agenda",
      }),
      makeRow({ id: "p2", title: "Buy milk", displayName: "Buy milk" }),
    ];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function openModal(): { modal: TaskFinderModal; contentEl: any } {
    const modal = new TaskFinderModal({} as any, nav, items);
    const contentEl = makeFakeEl();
    (modal as any).contentEl = contentEl;
    modal.onOpen();
    return { modal, contentEl };
  }

  it("lists every task and subtask passed at construction", () => {
    const { contentEl } = openModal();

    // search input + list container
    expect(contentEl.children).toHaveLength(2);
    const input = contentEl.children[0];
    expect(input.type).toBe("search");
    expect(input.placeholder).toBe("タスクを検索...");

    const list = contentEl.children[1];
    expect(list.children).toHaveLength(3);
    // each row renders a bold title element plus a meta
    // line ("子/親 • [ステータス] • [期限日 or 期限なし] • [ファイルパス]")
    const row = list.children[1];
    expect(row.children[0].className).toBe("task-workbench-finder-title");
    expect(row.children[0].textContent).toBe("Draft agenda");
    expect(row.children[1].className).toBe("task-workbench-finder-meta");
    expect(row.children[1].textContent).toBe(
      "子 • 未着手 • 期限なし • tasks/x.md"
    );
    // the search input receives initial focus
    expect(input.focus).toHaveBeenCalledTimes(1);
  });

  it("typing into the search input filters the list live", () => {
    const { contentEl } = openModal();
    const input = contentEl.children[0];
    const list = contentEl.children[1];

    input.value = "agenda";
    input.listeners["input"][0]();

    expect(list.children).toHaveLength(1);
    expect(list.children[0].children[0].textContent).toBe("Draft agenda");
  });

  it("subsequence fuzzy matching finds non-contiguous queries", () => {
    const { contentEl } = openModal();
    const input = contentEl.children[0];
    const list = contentEl.children[1];

    // "dvw" = D(e sign) (re)V(ie) (re)W... subsequence of "design review"
    input.value = "dvw";
    input.listeners["input"][0]();

    expect(list.children).toHaveLength(1);
    expect(list.children[0].children[0].textContent).toBe("Design review");
  });

  it("arrow keys move the selection and Enter confirms it", () => {
    const { contentEl } = openModal();
    const input = contentEl.children[0];
    const list = contentEl.children[1];

    expect(list.children[0].className).toBe("is-selected");

    input.listeners["keydown"][0](keyEvent("ArrowDown"));
    input.listeners["keydown"][0](keyEvent("ArrowDown"));
    expect(list.children[2].className).toBe("is-selected");
    expect(list.children[0].className).toBe("");

    input.listeners["keydown"][0](keyEvent("Enter"));

    expect(nav.openTaskItem).toHaveBeenCalledTimes(1);
    expect(nav.openTaskItem).toHaveBeenCalledWith(items[2]);
  });

  it("ArrowUp clamps at the first row", () => {
    const { contentEl } = openModal();
    const input = contentEl.children[0];
    const list = contentEl.children[1];

    input.listeners["keydown"][0](keyEvent("ArrowUp"));

    expect(list.children[0].className).toBe("is-selected");
    expect(nav.openTaskItem).not.toHaveBeenCalled();
  });

  it("clicking a row opens the task through navigation.openTaskItem", () => {
    const { contentEl } = openModal();
    const list = contentEl.children[1];

    list.children[1].listeners["click"][0]();

    expect(nav.openTaskItem).toHaveBeenCalledTimes(1);
    expect(nav.openTaskItem).toHaveBeenCalledWith(items[1]);
  });

  it("choosing an item closes the dialog before opening the task", () => {
    const modal = new TaskFinderModal({} as any, nav, items);
    const closeSpy = vi
      .spyOn(modal, "close")
      .mockImplementation(() => undefined);

    modal.chooseItem(items[0]);

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(nav.openTaskItem).toHaveBeenCalledWith(items[0]);
    // close happens first, then the navigation call
    expect(closeSpy.mock.invocationCallOrder[0]).toBeLessThan(
      nav.openTaskItem.mock.invocationCallOrder[0]
    );
  });

  it("matches on the localized status label", () => {
    items[1] = makeRow({
      kind: "subtask",
      id: "p1::x",
      title: "X",
      displayName: "X",
      statusLabel: "in_progress",
    });
    const { contentEl } = openModal();
    const input = contentEl.children[0];
    const list = contentEl.children[1];

    input.value = "進行中";
    input.listeners["input"][0]();

    expect(list.children).toHaveLength(1);
    expect(list.children[0].children[0].textContent).toBe("X");
  });

  it("matches on currentStatus text", () => {
    items[2] = makeRow({
      id: "p3",
      title: "Unrelated",
      displayName: "Unrelated",
      currentStatus: "blocked on vendor reply",
    });
    const { contentEl } = openModal();
    const input = contentEl.children[0];
    const list = contentEl.children[1];

    input.value = "vendor";
    input.listeners["input"][0]();

    expect(list.children).toHaveLength(1);
    expect(list.children[0].children[0].textContent).toBe("Unrelated");
  });

  it("matches on space-joined tags", () => {
    items[0] = makeRow({
      id: "p9",
      title: "Plain name",
      displayName: "Plain name",
      tags: ["backend", "urgent"],
    });
    const { contentEl } = openModal();
    const input = contentEl.children[0];
    const list = contentEl.children[1];

    // substring of the space-joined "backend urgent"
    input.value = "end urg";
    input.listeners["input"][0]();

    expect(list.children).toHaveLength(1);
    expect(list.children[0].children[0].textContent).toBe("Plain name");
  });

  it("matches on the file path", () => {
    items[2] = makeRow({
      id: "projects/alpha/notes.md",
      file: { path: "projects/alpha/notes.md" },
      title: "Notes",
      displayName: "Notes",
    });
    const { contentEl } = openModal();
    const input = contentEl.children[0];
    const list = contentEl.children[1];

    input.value = "alpha";
    input.listeners["input"][0]();

    expect(list.children).toHaveLength(1);
    expect(list.children[0].children[0].textContent).toBe("Notes");
  });

  it("meta line shows kind, status, due date and path for parents", () => {
    items = [
      makeRow({
        id: "tasks/due.md",
        file: { path: "tasks/due.md" },
        title: "With due",
        displayName: "With due",
        statusLabel: "waiting",
        dueDate: "2026-08-01",
      }),
    ];
    const { contentEl } = openModal();
    const list = contentEl.children[1];

    expect(list.children[0].children[1].textContent).toBe(
      "親 • 待ち • 2026-08-01 • tasks/due.md"
    );
  });

  it("with empty items only the search field renders, nothing selectable", () => {
    items = [];
    const { contentEl } = openModal();

    expect(contentEl.children).toHaveLength(2);
    expect(contentEl.children[0].type).toBe("search");
    expect(contentEl.children[1].children).toHaveLength(0);

    // Enter with no candidates opens nothing
    contentEl.children[0].listeners["keydown"][0](keyEvent("Enter"));
    expect(nav.openTaskItem).not.toHaveBeenCalled();
  });
});
