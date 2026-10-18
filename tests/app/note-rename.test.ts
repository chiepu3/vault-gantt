import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/core/constants";
import { HistoryManager } from "../../src/app/history-manager";
import { setNoteNotifier } from "../../src/app/note-changes";
import { addSubtask, createTask, loadTasks, updateTaskItemsBatch, type TaskCache } from "../../src/app/task-operations";
import type { TaskRow, TaskWorkbenchSettings } from "../../src/core/types";
import { FakeVault } from "./fake-vault";

class ProcessingVault extends FakeVault {
  async process(file: { path: string }, transform: (content: string) => string): Promise<string> {
    const current = this.getFileContent(file.path);
    if (current === null) throw new Error("File not found");
    const content = transform(current);
    await this.modify(file, content);
    return content;
  }
}

describe("file names follow titles", () => {
  let vault: ProcessingVault;
  let settings: TaskWorkbenchSettings;
  let cache: TaskCache;
  let history: HistoryManager;
  const notices: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T10:00:00Z"));
    vault = new ProcessingVault();
    settings = { ...DEFAULT_SETTINGS };
    cache = new Map();
    history = new HistoryManager();
    notices.length = 0;
    setNoteNotifier((message) => notices.push(message));
  });
  afterEach(() => { vi.useRealTimers(); setNoteNotifier(() => {}); });

  const rename = (row: TaskRow, title: string) =>
    updateTaskItemsBatch(vault, settings, cache, [{ row, patch: { displayName: title } }], {}, history);
  const pathOf = (id: string) => vault.getFileById(id)!.path;

  it("renames a subtask note when its title changes and leaves the parent note alone", async () => {
    const parent = await createTask(vault, settings, "親");
    const child = await addSubtask(vault, settings, parent, "旧題");
    const parentBefore = vault.getFileContent(parent.file.path);
    await rename(child, "新題");
    expect(pathOf(child.id)).toBe(`${parent.file.path.replace(/\.md$/, "")}/新題.md`);
    expect(vault.getFileContent(parent.file.path)).toBe(parentBefore);
    const rows = await loadTasks(vault, settings, cache);
    expect(rows[0].subtasks!.get(child.id)!.title).toBe("新題");
  });

  it("replaces forbidden characters and keeps the title as written in the frontmatter", async () => {
    const parent = await createTask(vault, settings, "親");
    const child = await addSubtask(vault, settings, parent, "x");
    await rename(child, 'a/b:c*d?e"f<g>h|i\\j.  ');
    expect(pathOf(child.id).endsWith("/a／b：c＊d？e＂f＜g＞h｜i＼j.md")).toBe(true);
    expect(vault.getFileContentById(child.id)).toContain('a/b:c*d?e"f<g>h|i\\j.');
  });

  it("adds a numeric suffix when the name is taken in the same folder", async () => {
    const parent = await createTask(vault, settings, "親");
    const a = await addSubtask(vault, settings, parent, "同名");
    const b = await addSubtask(vault, settings, parent, "別名");
    await rename(b, "同名");
    expect(pathOf(a.id).endsWith("/同名.md")).toBe(true);
    expect(pathOf(b.id).endsWith("/同名 2.md")).toBe(true);
  });

  it("truncates long titles to about 100 characters", async () => {
    const parent = await createTask(vault, settings, "親");
    const child = await addSubtask(vault, settings, parent, "x");
    await rename(child, "あ".repeat(300));
    const stem = pathOf(child.id).split("/").pop()!.replace(/\.md$/, "");
    expect(Array.from(stem)).toHaveLength(100);
  });

  it("renames a parent with its date prefix kept and moves the subtask folder", async () => {
    const parent = await createTask(vault, settings, "親");
    const child = await addSubtask(vault, settings, parent, "子");
    expect(parent.file.path).toBe("tasks/2026-07-29 親.md");
    await rename(parent, "新しい親");
    expect(pathOf(parent.id)).toBe("tasks/2026-07-29 新しい親.md");
    expect(pathOf(child.id)).toBe("tasks/2026-07-29 新しい親/子.md");
    expect(vault.getFileContentById(child.id)).toContain("[[2026-07-29 新しい親]]");
    const rows = await loadTasks(vault, settings, cache);
    expect(rows).toHaveLength(1);
    expect(rows[0].subtasks!.has(child.id)).toBe(true);
  });

  it("fixes parent links itself when Obsidian did not update them", async () => {
    vault.updateLinksOnRename = false;
    const parent = await createTask(vault, settings, "親");
    const child = await addSubtask(vault, settings, parent, "子");
    await rename(parent, "改名");
    expect(vault.getFileContentById(child.id)).toContain("[[2026-07-29 改名]]");
    expect(vault.getFileContentById(child.id)).not.toContain("[[2026-07-29 親]]");
  });

  it("fixes dependsOn links in siblings when Obsidian did not update them", async () => {
    vault.updateLinksOnRename = false;
    const parent = await createTask(vault, settings, "親");
    const a = await addSubtask(vault, settings, parent, "前");
    const b = await addSubtask(vault, settings, parent, "後");
    const file = vault.getFileById(b.id)!;
    await vault.processFrontMatter(file, (fm) => { fm.dependsOn = ["[[前]]"]; });
    await rename(a, "先行");
    expect(vault.getFileContentById(b.id)).toContain("[[先行]]");
    expect(vault.getFileContentById(b.id)).not.toContain("[[前]]");
  });

  it("does not rename when the title is unchanged or other fields are edited", async () => {
    const parent = await createTask(vault, settings, "親");
    const child = await addSubtask(vault, settings, parent, "子");
    vault.renames.length = 0;
    await updateTaskItemsBatch(vault, settings, cache, [{ row: child, patch: { notes: "メモ" } }], {}, history);
    await rename(child, "子");
    expect(vault.renames).toEqual([]);
  });

  it("keeps the old name and the data, and shows a Notice, when the rename fails", async () => {
    const parent = await createTask(vault, settings, "親");
    const child = await addSubtask(vault, settings, parent, "旧");
    const oldPath = child.file.path;
    vault.failRename = () => true;
    await rename(child, "新");
    expect(pathOf(child.id)).toBe(oldPath);
    expect(vault.getFileContentById(child.id)).toContain("title: 新");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("ファイル名を変更できませんでした");
  });

  it("rolls the parent file back when the subtask folder cannot be moved", async () => {
    const parent = await createTask(vault, settings, "親");
    const child = await addSubtask(vault, settings, parent, "子");
    vault.failRename = (path) => !path.endsWith(".md");
    await rename(parent, "新");
    expect(pathOf(parent.id)).toBe(parent.file.path);
    expect(pathOf(child.id)).toBe(child.file.path);
    expect(notices).toHaveLength(1);
  });

  it("undo and redo of a title change move the file name with the title", async () => {
    const parent = await createTask(vault, settings, "親");
    const child = await addSubtask(vault, settings, parent, "旧");
    const oldPath = child.file.path;
    await rename(child, "新");
    const newPath = pathOf(child.id);
    expect(newPath).not.toBe(oldPath);
    expect((await history.undo(vault as never)).kind).toBe("success");
    expect(pathOf(child.id)).toBe(oldPath);
    expect(vault.getFileContentById(child.id)).toContain("title: 旧");
    expect((await history.redo(vault as never)).kind).toBe("success");
    expect(pathOf(child.id)).toBe(newPath);
    expect(vault.getFileContentById(child.id)).toContain("title: 新");
  });

  it("undo and redo of a parent title change restore the parent and its subtasks' paths", async () => {
    const parent = await createTask(vault, settings, "親");
    const child = await addSubtask(vault, settings, parent, "子");
    const [parentOld, childOld] = [parent.file.path, child.file.path];
    await rename(parent, "新");
    const [parentNew, childNew] = [pathOf(parent.id), pathOf(child.id)];
    expect((await history.undo(vault as never)).kind).toBe("success");
    expect([pathOf(parent.id), pathOf(child.id)]).toEqual([parentOld, childOld]);
    expect(vault.getFileContentById(child.id)).toContain("[[2026-07-29 親]]");
    expect((await history.redo(vault as never)).kind).toBe("success");
    expect([pathOf(parent.id), pathOf(child.id)]).toEqual([parentNew, childNew]);
  });

  it("renaming a parent and its subtask in one batch keeps a single consistent history entry", async () => {
    const parent = await createTask(vault, settings, "親");
    const child = await addSubtask(vault, settings, parent, "子");
    const [parentOld, childOld] = [parent.file.path, child.file.path];
    await updateTaskItemsBatch(vault, settings, cache, [
      { row: parent, patch: { displayName: "新親" } },
      { row: child, patch: { displayName: "新子" } },
    ], {}, history);
    expect(pathOf(child.id)).toBe("tasks/2026-07-29 新親/新子.md");
    expect((await history.undo(vault as never)).kind).toBe("success");
    expect([pathOf(parent.id), pathOf(child.id)]).toEqual([parentOld, childOld]);
    expect((await history.redo(vault as never)).kind).toBe("success");
    expect(pathOf(child.id)).toBe("tasks/2026-07-29 新親/新子.md");
  });
});
