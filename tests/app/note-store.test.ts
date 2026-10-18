import { beforeEach, describe, expect, it } from "vitest";
import { stringifyYaml } from "obsidian";
import { assembleTasks, loadNoteTasks, type TaskCache } from "../../src/app/note-store";
import { applyNoteChange, diffTasks, NoteConflictError } from "../../src/app/note-changes";
import { buildNewNote } from "../../src/core/note-v2";
import { DEFAULT_SETTINGS } from "../../src/core/constants";
import type { TaskRow, TaskWorkbenchSettings } from "../../src/core/types";
import { FakeVault } from "./fake-vault";
import { parentNoteText, subtaskNoteText } from "../helpers-v2";

const settings = (): TaskWorkbenchSettings => ({ ...structuredClone(DEFAULT_SETTINGS), taskFolder: "タスク" });

async function seed(vault: FakeVault): Promise<void> {
  await vault.create("タスク/2026-10-01 社内ツール更新.md", parentNoteText({ id: "t-7k3q9x", title: "社内ツール更新" }, "## 現状\n調査中\n\n## メモ\n独自メモ\n\n## 独自\nkeep\n"));
  await vault.create("タスク/2026-10-01 社内ツール更新/要件整理.md", subtaskNoteText({ id: "s-p2m8vd", title: "要件整理", parent: "[[2026-10-01 社内ツール更新]]", start: "2026-10-20", end: "2026-10-24", plan: { "2026-10-20": 2 } }));
  await vault.create("タスク/2026-10-01 社内ツール更新/実装.md", subtaskNoteText({ id: "s-q1w2e3", title: "実装", parent: "[[2026-10-01 社内ツール更新]]", created: "2026-10-03" }));
  await vault.create("タスク/メモ.md", "# ただのメモ\n");
}

describe("loadNoteTasks", () => {
  let vault: FakeVault;
  let cache: TaskCache;
  beforeEach(async () => { vault = new FakeVault(); cache = new Map(); await seed(vault); });

  it("builds parents with their subtasks from frontmatter links", async () => {
    const tasks = await loadNoteTasks(vault, settings(), cache);
    expect(tasks).toHaveLength(1);
    const parent = tasks[0];
    expect(parent).toMatchObject({ id: "t-7k3q9x", kind: "parent", currentStatus: "調査中", notes: "独自メモ" });
    expect([...parent.subtasks!.keys()]).toEqual(["s-p2m8vd", "s-q1w2e3"]);
    const child = parent.subtasks!.get("s-p2m8vd")!;
    expect(child).toMatchObject({ kind: "subtask", key: "s-p2m8vd", parentId: "t-7k3q9x", plannedStartDate: "2026-10-20" });
    expect(child.file).toMatchObject({ path: "タスク/2026-10-01 社内ツール更新/要件整理.md", parentPath: "タスク/2026-10-01 社内ツール更新.md" });
  });

  it("falls back to the folder named like the parent when the link does not resolve", async () => {
    await vault.create("タスク/2026-10-01 社内ツール更新/迷子.md", subtaskNoteText({ id: "s-lost00", title: "迷子", parent: "[[存在しない]]" }));
    const parent = (await loadNoteTasks(vault, settings(), cache))[0];
    expect(parent.subtasks!.has("s-lost00")).toBe(true);
  });

  it("follows the parent link rather than the folder", async () => {
    await vault.create("タスク/別の親.md", parentNoteText({ id: "t-other0", title: "別の親" }));
    await vault.create("タスク/2026-10-01 社内ツール更新/移動.md", subtaskNoteText({ id: "s-moved0", title: "移動", parent: "[[別の親]]" }));
    const tasks = await loadNoteTasks(vault, settings(), cache);
    expect(tasks.find((row) => row.id === "t-other0")!.subtasks!.has("s-moved0")).toBe(true);
    expect(tasks.find((row) => row.id === "t-7k3q9x")!.subtasks!.has("s-moved0")).toBe(false);
  });

  it("orders subtasks by the stored order, then created", async () => {
    const withOrder = { ...settings(), subtaskOrder: { "t-7k3q9x": ["s-q1w2e3"] } };
    const parent = (await loadNoteTasks(vault, withOrder, cache))[0];
    expect([...parent.subtasks!.keys()]).toEqual(["s-q1w2e3", "s-p2m8vd"]);
  });

  it("skips a second note with a duplicate id", async () => {
    await vault.create("タスク/コピー.md", parentNoteText({ id: "t-7k3q9x", title: "コピー" }));
    const tasks = await loadNoteTasks(vault, settings(), cache);
    expect(tasks).toHaveLength(1);
  });

  it("reuses unchanged rows and re-reads only the edited note", async () => {
    const first = await loadNoteTasks(vault, settings(), cache);
    const childBefore = first[0].subtasks!.get("s-q1w2e3")!;
    const file = vault.getFileByPath("タスク/2026-10-01 社内ツール更新/要件整理.md")!;
    await vault.processFrontMatter(file, (fm) => { fm.due = "2026-11-01"; });
    const second = await loadNoteTasks(vault, settings(), cache);
    expect(second[0]).not.toBe(first[0]);
    expect(second[0].subtasks!.get("s-q1w2e3")).toBe(childBefore);
    expect(second[0].subtasks!.get("s-p2m8vd")!.dueDate).toBe("2026-11-01");
    expect((await loadNoteTasks(vault, settings(), cache))[0]).toBe(second[0]);
  });

  it("drops cache entries of removed notes", async () => {
    await loadNoteTasks(vault, settings(), cache);
    await vault.trash(vault.getFileByPath("タスク/2026-10-01 社内ツール更新/実装.md")!);
    const parent = (await loadNoteTasks(vault, settings(), cache))[0];
    expect([...parent.subtasks!.keys()]).toEqual(["s-p2m8vd"]);
    expect(cache.has("タスク/2026-10-01 社内ツール更新/実装.md")).toBe(false);
  });

  it("waits for notes the metadataCache has not indexed yet", async () => {
    let indexed = false;
    const original = vault.getFrontmatter.bind(vault);
    vault.getFrontmatter = (file) => indexed ? original(file) : undefined;
    vault.whenIndexed = async () => { indexed = true; };
    expect(await loadNoteTasks(vault, settings(), cache)).toHaveLength(1);
  });

  it("does not cache notes that are still unindexed after waiting", async () => {
    vault.getFrontmatter = () => undefined;
    expect(await loadNoteTasks(vault, settings(), cache)).toHaveLength(0);
    expect(cache.size).toBe(0);
  });

  it("migrates a path based parent order to ids", async () => {
    const s = { ...settings(), ganttParentOrder: ["タスク/2026-10-01 社内ツール更新.md"] };
    await loadNoteTasks(vault, s, cache);
    expect(s.ganttParentOrder).toEqual(["t-7k3q9x"]);
  });
});

describe("editing touches only the affected note", () => {
  it("a subtask edit rewrites that subtask's frontmatter keys and nothing else", async () => {
    const vault = new FakeVault();
    await seed(vault);
    const cache: TaskCache = new Map();
    const before = await loadNoteTasks(vault, settings(), cache);
    const after = structuredClone(before);
    const child = after[0].subtasks!.get("s-p2m8vd")!;
    child.statusLabel = "done"; child.completed = true; child.dueDate = "2026-12-01"; child.currentStatus = "終わった"; child.updatedAt = "2026-10-18";
    const changes = diffTasks(before, after, () => "");
    expect(changes).toEqual([{ kind: "update", path: child.file.path, taskId: "s-p2m8vd", fm: { status: "done", completed: true, due: "2026-12-01", updated: "2026-10-18" }, sections: { currentStatus: "終わった" } }]);
    const files = vault.snapshot();
    const applied = await applyNoteChange(vault, changes[0], files[child.file.path]);
    const now = vault.snapshot();
    for (const path of Object.keys(files)) if (path !== child.file.path) expect(now[path]).toBe(files[path]);
    expect(applied.before).toBe(files[child.file.path]);
    expect(now[child.file.path]).toContain("status: done");
    expect(now[child.file.path]).toContain("## 現状\n終わった");
    expect(now[child.file.path]).toContain("id: s-p2m8vd");
  });

  it("keeps unknown frontmatter keys and unknown sections", async () => {
    const vault = new FakeVault();
    await vault.create("タスク/親.md", parentNoteText({ id: "t-aaaaaa", title: "親", custom: { a: [1, 2] }, aliases: ["x"] }, "前置き\n\n## 現状\nA\n\n## 独自\nkeep\n\n## メモ\nB\n"));
    const cache: TaskCache = new Map();
    const before = await loadNoteTasks(vault, settings(), cache);
    const after = structuredClone(before);
    after[0].notes = "新メモ"; after[0].tags = ["a"];
    await applyNoteChange(vault, diffTasks(before, after, () => "")[0]);
    const text = vault.getFileContent("タスク/親.md")!;
    expect(text).toContain("custom:");
    expect(text).toContain("aliases:");
    expect(text).toContain("前置き\n\n## 現状\nA\n\n## 独自\nkeep\n\n## メモ\n新メモ\n");
  });

  it("refuses to write when the note changed since the plan", async () => {
    const vault = new FakeVault();
    await seed(vault);
    const before = await loadNoteTasks(vault, settings(), new Map());
    const after = structuredClone(before);
    after[0].tags = ["x"];
    const [change] = diffTasks(before, after, () => "");
    await expect(applyNoteChange(vault, change, "古い内容")).rejects.toBeInstanceOf(NoteConflictError);
  });

  it("creates and deletes subtask notes", async () => {
    const vault = new FakeVault();
    await seed(vault);
    const cache: TaskCache = new Map();
    const before = await loadNoteTasks(vault, settings(), cache);
    const after = structuredClone(before);
    const template = after[0].subtasks!.get("s-q1w2e3")!;
    const created: TaskRow = { ...structuredClone(template), id: "s-new000", key: "s-new000", title: "新規", displayName: "新規", file: { path: "タスク/2026-10-01 社内ツール更新/新規.md" } as TaskRow["file"] };
    after[0].subtasks!.set("s-new000", created);
    after[0].subtasks!.delete("s-p2m8vd");
    const changes = diffTasks(before, after, (row) => buildNewNote(row, stringifyYaml, { parentLink: "[[2026-10-01 社内ツール更新]]" }));
    expect(changes.map((change) => [change.kind, change.path])).toEqual([["create", created.file.path], ["delete", "タスク/2026-10-01 社内ツール更新/要件整理.md"]]);
    const parentText = vault.getFileContent("タスク/2026-10-01 社内ツール更新.md");
    for (const change of changes) await applyNoteChange(vault, change);
    expect(vault.getFileContent("タスク/2026-10-01 社内ツール更新.md")).toBe(parentText);
    const reloaded = await loadNoteTasks(vault, settings(), cache);
    expect([...reloaded[0].subtasks!.keys()].sort()).toEqual(["s-new000", "s-q1w2e3"]);
    expect(vault.trashed).toEqual(["タスク/2026-10-01 社内ツール更新/要件整理.md"]);
  });
});

describe("assembleTasks", () => {
  it("leaves subtasks without a parent out", () => {
    const vault = new FakeVault();
    const orphan = { kind: "subtask", id: "s-orphan", file: { path: "x/y.md" }, createdAt: "", displayName: "o", title: "o" } as TaskRow;
    expect(assembleTasks(vault, [{ path: "x/y.md", row: orphan, parentLink: "[[nowhere]]" }], settings(), new Map())).toEqual([]);
  });
});
