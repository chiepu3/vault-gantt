import { beforeEach, describe, expect, it } from "vitest";
import { cachedMemos, loadMemos, loadNoteTasks, type TaskCache } from "../../src/app/note-store";
import { HistoryManager } from "../../src/app/history-manager";
import { resolveMemoAnchor } from "../../src/app/memo-anchor";
import { createMemo, deleteMemo, readMemoText, reanchorMemo, updateMemoText } from "../../src/app/memo-service";
import { rowIndex } from "../../src/app/operations/runtime";
import { DEFAULT_SETTINGS } from "../../src/core/constants";
import { memoBody } from "../../src/core/memo";
import type { TaskWorkbenchSettings } from "../../src/core/types";
import { todayStr } from "../../src/core/utils";
import { FakeVault } from "./fake-vault";
import { parentNoteText, subtaskNoteText } from "../helpers-v2";

const settings = (): TaskWorkbenchSettings => ({ ...structuredClone(DEFAULT_SETTINGS), taskFolder: "タスク" });

/** The history vault the plugin passes in: the FakeVault plus an atomic process(). */
function historyVault(vault: FakeVault) {
  return {
    getFileByPath: (path: string) => vault.getFileByPath(path),
    read: (file: { path: string }) => vault.read(file),
    create: (path: string, content: string) => vault.create(path, content),
    trash: (file: { path: string }) => vault.trash(file),
    process: async (file: { path: string }, fn: (content: string) => string) => { const next = fn(await vault.read(file)); await vault.modify(file, next); return next; },
  } as never;
}

async function seed(vault: FakeVault): Promise<void> {
  await vault.create("タスク/2026-10-01 親.md", parentNoteText({ id: "t-7k3q9x", title: "親" }));
  await vault.create("タスク/2026-10-01 親/実装.md", subtaskNoteText({ id: "s-p2m8vd", title: "実装", parent: "[[2026-10-01 親]]", start: "2026-10-20", end: "2026-10-24" }));
}

describe("memo service", () => {
  let vault: FakeVault, cache: TaskCache, history: HistoryManager;
  beforeEach(async () => { vault = new FakeVault(); cache = new Map(); history = new HistoryManager(); await seed(vault); });
  const sub = async () => (await loadNoteTasks(vault, settings(), cache))[0].subtasks!.get("s-p2m8vd")!;

  it("creates a subtask memo as an offset from the bar's start", async () => {
    const meta = await createMemo(vault, settings(), { text: "API仕様を確認\n木曜に", task: await sub(), date: "2026-10-23" }, history, cache);
    expect(meta).toMatchObject({ taskId: "s-p2m8vd", at: 3, date: "2026-10-23" });
    expect(meta.id).toMatch(/^m-[0-9a-z]{6}$/);
    expect(meta.path).toBe(`タスク/_memos/${todayStr()} API仕様を確認.md`);
    const content = vault.getFileContent(meta.path)!;
    expect(content).toContain("type: gantt-memo");
    expect(content).toContain("at: 3");
    expect(memoBody(content)).toBe("API仕様を確認\n木曜に");
    expect(history.peekUndoLabel()).toBe("メモ追加");
  });

  it("creates parent and free memos with a date only", async () => {
    const parent = (await loadNoteTasks(vault, settings(), cache))[0];
    const a = await createMemo(vault, settings(), { text: "親にメモ", task: parent, date: "2026-11-13" });
    const b = await createMemo(vault, settings(), { text: "その他メモ", date: "2026-11-10" });
    expect(a).toMatchObject({ taskId: "t-7k3q9x", date: "2026-11-13" });
    expect(a.at).toBeUndefined();
    expect(b.taskId).toBeUndefined();
    expect(vault.getFileContent(b.path)).not.toContain("task:");
  });

  it("creates nothing for empty text and avoids file name collisions", async () => {
    await expect(createMemo(vault, settings(), { text: "  \n ", date: "2026-11-10" })).rejects.toThrow("empty");
    expect(vault.getFiles().filter((file) => file.path.includes("_memos"))).toHaveLength(0);
    const first = await createMemo(vault, settings(), { text: "同じ", date: "2026-11-10" });
    const second = await createMemo(vault, settings(), { text: "同じ", date: "2026-11-11" });
    expect(second.path).toBe(first.path.replace(".md", " 2.md"));
    expect(second.id).not.toBe(first.id);
  });

  it("is picked up by the same scan as the tasks and is never a task", async () => {
    const meta = await createMemo(vault, settings(), { text: "メモ", date: "2026-11-10" });
    const tasks = await loadNoteTasks(vault, settings(), cache);
    expect(tasks).toHaveLength(1);
    expect(cachedMemos(cache)).toEqual([meta]);
    expect(tasks[0].subtasks!.size).toBe(1);
  });

  it("loadMemos refreshes memo notes only and forgets deleted ones", async () => {
    const meta = await createMemo(vault, settings(), { text: "メモ", date: "2026-11-10" });
    expect(await loadMemos(vault, settings(), cache)).toEqual([meta]);
    expect(cache.has("タスク/2026-10-01 親.md")).toBe(false);
    await vault.trash(vault.getFileByPath(meta.path)!);
    expect(await loadMemos(vault, settings(), cache)).toEqual([]);
  });

  it("ignores a second note that reuses a memo id", async () => {
    const meta = await createMemo(vault, settings(), { text: "メモ", date: "2026-11-10" });
    await vault.create("タスク/_memos/コピー.md", vault.getFileContent(meta.path)!);
    expect(await loadMemos(vault, settings(), cache)).toHaveLength(1);
  });

  it("reads the text lazily and rewrites only the body", async () => {
    const meta = await createMemo(vault, settings(), { text: "古い", date: "2026-11-10" }, history);
    const before = vault.getFileContent(meta.path)!;
    expect(await readMemoText(vault, meta)).toBe("古い");
    await updateMemoText(vault, meta, "新しい\n2行目", history, cache);
    const after = vault.getFileContent(meta.path)!;
    expect(after.split("---")[1]).toBe(before.split("---")[1].replace(/updated: .*/, `updated: ${todayStr()}`));
    expect(await readMemoText(vault, meta)).toBe("新しい\n2行目");
    expect(history.peekUndoLabel()).toBe("メモ編集");
    // Same text: nothing is written.
    vault.resetCounters();
    await updateMemoText(vault, meta, "新しい\n2行目", history, cache);
    expect(vault.getModifyCallCount()).toBe(0);
    await expect(updateMemoText(vault, meta, "", history)).rejects.toThrow("empty");
  });

  it("re-anchors to another task, day or the 「その他」 row", async () => {
    const meta = await createMemo(vault, settings(), { text: "メモ", date: "2026-11-10" }, history);
    await reanchorMemo(vault, meta, { task: await sub(), date: "2026-10-22" }, history, cache);
    let [read] = await loadMemos(vault, settings(), cache);
    expect(read).toMatchObject({ id: meta.id, taskId: "s-p2m8vd", at: 2, date: "2026-10-22" });
    await reanchorMemo(vault, meta, { date: "2026-11-01" }, history, cache);
    [read] = await loadMemos(vault, settings(), cache);
    expect(read.taskId).toBeUndefined();
    expect(read.at).toBeUndefined();
    expect(read.date).toBe("2026-11-01");
    expect(history.peekUndoLabel()).toBe("メモ移動");
  });

  it("refuses to attach to a subtask that has no bar", async () => {
    await vault.create("タスク/2026-10-01 親/未定.md", subtaskNoteText({ id: "s-nodate", title: "未定", parent: "[[2026-10-01 親]]" }));
    const unplaced = (await loadNoteTasks(vault, settings(), cache))[0].subtasks!.get("s-nodate")!;
    await expect(createMemo(vault, settings(), { text: "x", task: unplaced, date: "2026-10-20" })).rejects.toThrow("planned start");
  });

  it("undoes and redoes create, edit, re-anchor and delete", async () => {
    const meta = await createMemo(vault, settings(), { text: "最初", date: "2026-11-10" }, history);
    const created = vault.getFileContent(meta.path)!;
    await updateMemoText(vault, meta, "二番目", history);
    const edited = vault.getFileContent(meta.path)!;
    await reanchorMemo(vault, meta, { task: await sub(), date: "2026-10-21" }, history);
    const moved = vault.getFileContent(meta.path)!;
    await deleteMemo(vault, meta, history);
    expect(vault.getFileContent(meta.path)).toBeNull();
    const hv = historyVault(vault);
    expect((await history.undo(hv)).kind).toBe("success");
    expect(vault.getFileContent(meta.path)).toBe(moved);
    expect((await history.undo(hv)).kind).toBe("success");
    expect(vault.getFileContent(meta.path)).toBe(edited);
    expect((await history.undo(hv)).kind).toBe("success");
    expect(vault.getFileContent(meta.path)).toBe(created);
    expect((await history.undo(hv)).kind).toBe("success");
    expect(vault.getFileContent(meta.path)).toBeNull();
    expect((await history.redo(hv)).kind).toBe("success");
    expect(vault.getFileContent(meta.path)).toBe(created);
  });
});

describe("resolveMemoAnchor", () => {
  let vault: FakeVault, cache: TaskCache;
  beforeEach(async () => { vault = new FakeVault(); cache = new Map(); await seed(vault); });
  const base = { path: "タスク/_memos/a.md", created: "2026-10-01", updated: "2026-10-01" };

  it("follows the bar: start + at, clamped to the end", async () => {
    const rows = rowIndex(await loadNoteTasks(vault, settings(), cache)).rows;
    expect(resolveMemoAnchor({ ...base, id: "m-aaaaaa", taskId: "s-p2m8vd", at: 2, date: "2026-10-01" }, rows)).toMatchObject({ kind: "subtask", date: "2026-10-22", taskName: "実装", parentId: "t-7k3q9x" });
    expect(resolveMemoAnchor({ ...base, id: "m-aaaaaa", taskId: "s-p2m8vd", at: 30 }, rows).date).toBe("2026-10-24");
    expect(resolveMemoAnchor({ ...base, id: "m-aaaaaa", taskId: "s-p2m8vd" }, rows).date).toBe("2026-10-20");
  });

  it("uses the stored date for parent and free memos, and falls back to 「その他」 for a lost task", async () => {
    const rows = rowIndex(await loadNoteTasks(vault, settings(), cache)).rows;
    expect(resolveMemoAnchor({ ...base, id: "m-aaaaaa", taskId: "t-7k3q9x", date: "2026-11-13" }, rows)).toMatchObject({ kind: "parent", date: "2026-11-13" });
    expect(resolveMemoAnchor({ ...base, id: "m-aaaaaa", date: "2026-11-10" }, rows)).toEqual({ kind: "free", date: "2026-11-10" });
    expect(resolveMemoAnchor({ ...base, id: "m-aaaaaa", taskId: "s-gone00", at: 4, date: "2026-10-30" }, rows)).toEqual({ kind: "free", date: "2026-10-30", orphan: true });
    expect(resolveMemoAnchor({ ...base, id: "m-aaaaaa", taskId: "s-gone00" }, rows).date).toBe("2026-10-01");
  });
});
