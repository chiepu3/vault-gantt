import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/core/constants";
import { buildFullNote } from "../../src/core/note-format";
import type { TaskRow, TaskWorkbenchSettings } from "../../src/core/types";
import { backupStamp, findLegacyNotes, planMigration, runMigration } from "../../src/app/migration-v1";
import { setNoteNotifier } from "../../src/app/note-changes";
import { updateTaskItemsBatch } from "../../src/app/task-operations";
import { loadNoteTasks } from "../../src/app/note-store";
import { FakeVault } from "./fake-vault";

const base = {
  completed: false, ganttEnabled: false, tags: [] as string[], currentStatus: "", notes: "", priority: 0,
  priorityMode: "auto" as const, createdAt: "2026-06-01", updatedAt: "2026-06-10", dueDate: undefined, statusLabel: "active" as const,
};

function v1Row(partial: Partial<TaskRow> & Pick<TaskRow, "kind" | "id" | "displayName">): TaskRow {
  return { ...base, title: partial.displayName, file: { path: "" } as TaskRow["file"], ...partial } as TaskRow;
}

/** A v1 parent note with two subtasks, a user frontmatter key, an unknown section and extra text in a subtask. */
function v1Note(path: string, name: string, order?: number): string {
  const sub1 = v1Row({
    kind: "subtask", id: `${path}::design`, key: "design", displayName: "設計", statusLabel: "in_progress",
    plannedStartDate: "2026-07-01", plannedEndDate: "2026-07-03", dueDate: "2026-07-05", tags: ["x", "y"],
    workloadPlan: { "2026-07-01": 2, "2026-07-02": 3 }, workloadActual: { "2026-07-01": 1.5 },
    ganttMarkers: [{ key: "review", title: "レビュー", date: "2026-07-02", tags: ["m"] }],
    currentStatus: "設計中", notes: "設計のメモ", priority: 5, priorityMode: "manual",
  });
  const sub2 = v1Row({ kind: "subtask", id: `${path}::build`, key: "build", displayName: "実装", statusLabel: "done", completed: true, notes: "実装メモ" });
  const parent = v1Row({
    kind: "parent", id: path, displayName: name, statusLabel: "in_progress", dueDate: "2026-07-31", priority: 3, priorityMode: "manual",
    currentStatus: "親の現状", notes: "親のメモ", tags: ["a", "b"], ganttEnabled: true, file: { path } as TaskRow["file"],
  });
  const subtasks = new Map([["design", sub1], ["build", sub2]]);
  parent.subtasks = subtasks;
  let text = buildFullNote(parent, subtasks);
  if (order !== undefined) text = text.replace("ganttEnabled: true", `ganttEnabled: true\nganttOrder: ${order}`);
  text = text.replace("type: task\n", "type: task\nproject: 顧客A\nrefs:\n  - 資料A\n  - 資料B\n");
  text = text.replace("#### Notes\n設計のメモ\n", "#### Notes\n設計のメモ\n\n#### 参考\n補足の文章\n");
  return `${text}\n## 参考資料\n[資料](https://example.com)\n`;
}

describe("v1 to v2 conversion", () => {
  let vault: FakeVault;
  let settings: TaskWorkbenchSettings;
  const persist = vi.fn(async (candidate: TaskWorkbenchSettings) => { void candidate; });
  const deps = () => ({ persist, now: () => new Date(2026, 6, 1, 9, 5, 7) });
  const A = "tasks/2026/06/2026-06-01 アルファ.md";
  const B = "tasks/2026/06/2026-06-02 ベータ.md";

  beforeEach(async () => {
    vault = new FakeVault();
    settings = { ...DEFAULT_SETTINGS, autoPriorityEnabled: false, ganttParentOrder: [B, A] };
    persist.mockClear();
    await vault.create(A, v1Note(A, "アルファ", 1000));
    await vault.create(B, v1Note(B, "ベータ", 2000));
  });

  it("lists what it would create and change without writing", async () => {
    const before = vault.snapshot();
    const plan = await planMigration(vault, settings, new Date(2026, 6, 1, 9, 5, 7));
    expect(plan.backupRoot).toBe(".vault-gantt-backup/20260701-090507");
    expect(plan.items.map((item) => item.path)).toEqual([A, B]);
    expect(plan.items[0].subtasks.map((sub) => sub.path)).toEqual([
      "tasks/2026/06/2026-06-01 アルファ/設計.md", "tasks/2026/06/2026-06-01 アルファ/実装.md",
    ]);
    expect(vault.snapshot()).toEqual(before);
    expect(backupStamp(new Date(2026, 0, 2, 3, 4, 5))).toBe("20260102-030405");
  });

  it("converts every parent, keeps the data and the user's own content, and leaves no v1 traces", async () => {
    const original = vault.getFileContent(A)!;
    const plan = await planMigration(vault, settings, new Date(2026, 6, 1, 9, 5, 7));
    const report = await runMigration(vault, settings, plan, deps());
    expect(report.failed).toEqual([]);
    expect(report.converted).toHaveLength(2);

    // backup of the whole task folder, taken before any change
    expect(vault.adapterFiles.get(`.vault-gantt-backup/20260701-090507/${A}`)).toBe(original);

    const rows = await loadNoteTasks(vault, settings, new Map());
    expect(rows).toHaveLength(2);
    const alpha = rows.find((row) => row.displayName === "アルファ")!;
    expect(alpha).toMatchObject({ statusLabel: "in_progress", dueDate: "2026-07-31", priority: 3, priorityMode: "manual", currentStatus: "親の現状", notes: "親のメモ", tags: ["a", "b"], ganttEnabled: true, createdAt: "2026-06-01", updatedAt: "2026-06-10" });
    expect(alpha.id).toMatch(/^t-[0-9a-z]{6}$/);
    const subs = [...alpha.subtasks!.values()];
    expect(subs.map((sub) => sub.displayName)).toEqual(["設計", "実装"]);
    expect(subs[0]).toMatchObject({
      statusLabel: "in_progress", plannedStartDate: "2026-07-01", plannedEndDate: "2026-07-03", dueDate: "2026-07-05", tags: ["x", "y"],
      workloadPlan: { "2026-07-01": 2, "2026-07-02": 3 }, workloadActual: { "2026-07-01": 1.5 }, currentStatus: "設計中", priority: 5, priorityMode: "manual",
    });
    expect(subs[0].id).toMatch(/^s-[0-9a-z]{6}$/);
    expect(subs[0].ganttMarkers).toMatchObject([{ title: "レビュー", date: "2026-07-02", tags: ["m"] }]);
    // text the format has no field for stays in the note
    expect(subs[0].notes).toBe("設計のメモ\n\n#### 参考\n補足の文章");
    expect(subs[1]).toMatchObject({ statusLabel: "done", completed: true, notes: "実装メモ" });

    const parentText = vault.getFileContent(A)!;
    expect(parentText).toContain("project: 顧客A");
    expect(parentText).toContain("  - 資料B");
    expect(parentText).toContain("## 参考資料\n[資料](https://example.com)");
    expect(parentText).toContain("formatVersion: 2");
    expect(parentText).not.toMatch(/subtask__|subtaskOrder|meta-bind|INPUT\[|ganttOrder|^# /m);
    expect(parentText).not.toContain("### ");

    // order stores
    expect(settings.subtaskOrder![alpha.id]).toEqual(subs.map((sub) => sub.id));
    const beta = rows.find((row) => row.displayName === "ベータ")!;
    expect(settings.ganttParentOrder).toEqual([beta.id, alpha.id]);
    expect(persist).toHaveBeenCalled();
    expect(await findLegacyNotes(vault, settings)).toEqual([]);
  });

  it("builds the gantt order from the notes' own order values when settings have none", async () => {
    settings.ganttParentOrder = undefined;
    await runMigration(vault, settings, await planMigration(vault, settings), deps());
    const rows = await loadNoteTasks(vault, settings, new Map());
    const byName = (name: string) => rows.find((row) => row.displayName === name)!.id;
    expect(settings.ganttParentOrder).toEqual([byName("アルファ"), byName("ベータ")]);
  });

  it("uses the notes' own order values when the stored order was completed empty while the v1 notes were hidden", async () => {
    settings.ganttParentOrder = [];
    await runMigration(vault, settings, await planMigration(vault, settings), deps());
    const rows = await loadNoteTasks(vault, settings, new Map());
    const byName = (name: string) => rows.find((row) => row.displayName === name)!.id;
    expect(settings.ganttParentOrder).toEqual([byName("アルファ"), byName("ベータ")]);
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({ ganttParentOrder: [byName("アルファ"), byName("ベータ")] }), ["subtaskOrder", "ganttParentOrder"]);
  });

  it("stops and restores one parent when its result differs, and still converts the others", async () => {
    const plan = await planMigration(vault, settings, new Date(2026, 6, 1, 9, 5, 7));
    const original = vault.getFileContent(A)!;
    const frontmatter = vault.getFrontmatter.bind(vault);
    vi.spyOn(vault, "getFrontmatter").mockImplementation((file) => {
      const fm = frontmatter(file);
      return file.path.startsWith("tasks/2026/06/2026-06-01 アルファ/設計") && fm ? { ...fm, title: "別の題名" } : fm;
    });
    const report = await runMigration(vault, settings, plan, deps());
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].path).toBe(A);
    expect(report.failed[0].reason).toContain("一致しません");
    expect(vault.getFileContent(A)).toBe(original);
    expect(vault.getFileByPath("tasks/2026/06/2026-06-01 アルファ/設計.md")).toBeNull();
    expect(vault.getFileByPath("tasks/2026/06/2026-06-01 アルファ/実装.md")).toBeNull();
    expect(report.converted.map((entry) => entry.path)).toEqual([B]);
    expect(settings.subtaskOrder && Object.keys(settings.subtaskOrder)).toHaveLength(1);
    expect(settings.ganttParentOrder).toContain(A);
  });

  it("restores the parent when a subtask note cannot be created", async () => {
    const plan = await planMigration(vault, settings);
    const original = vault.getFileContent(B)!;
    const create = vault.create.bind(vault);
    vi.spyOn(vault, "create").mockImplementation(async (path, content) => {
      if (path.endsWith("ベータ/実装.md")) throw new Error("disk full");
      return create(path, content);
    });
    const report = await runMigration(vault, settings, plan, deps());
    expect(report.failed).toEqual([{ path: B, reason: "disk full" }]);
    expect(vault.getFileContent(B)).toBe(original);
    expect(vault.getFileByPath("tasks/2026/06/2026-06-02 ベータ/設計.md")).toBeNull();
    expect(report.converted.map((entry) => entry.path)).toEqual([A]);
  });

  it("changes nothing when the backup cannot be made", async () => {
    const before = vault.snapshot();
    vault.failCopy = true;
    await expect(runMigration(vault, settings, await planMigration(vault, settings), deps())).rejects.toThrow("backup failed");
    expect(vault.snapshot()).toEqual(before);
    expect(persist).not.toHaveBeenCalled();
  });

  it("does not touch notes that are already v2", async () => {
    await runMigration(vault, settings, await planMigration(vault, settings), deps());
    const before = vault.snapshot();
    const plan = await planMigration(vault, settings);
    expect(plan.items).toEqual([]);
    await runMigration(vault, settings, plan, deps());
    expect(vault.snapshot()).toEqual(before);
  });

  it("stops saving a converted parent when v1 keys show up in it again", async () => {
    await runMigration(vault, settings, await planMigration(vault, settings), deps());
    const rows = await loadNoteTasks(vault, settings, new Map());
    const alpha = rows.find((row) => row.displayName === "アルファ")!;
    const file = vault.getFileByPath(A)!;
    await vault.processFrontMatter(file, (fm) => { fm.subtask__x__title = "古い書き込み"; });
    const notices: string[] = [];
    setNoteNotifier((message) => notices.push(message));
    const before = vault.getFileContent(A);
    await expect(updateTaskItemsBatch(vault, settings, new Map(), [{ row: alpha, patch: { notes: "新しいメモ" } }], {})).rejects.toThrow("v1 形式");
    expect(vault.getFileContent(A)).toBe(before);
    expect(notices).toHaveLength(1);
    setNoteNotifier(() => {});
  });

  it("orders parents with equal ganttOrder by name, like the v1 gantt", async () => {
    const C = "tasks/2026/06/2026-06-03 カ.md", D = "tasks/2026/06/2026-06-04 イ.md", E = "tasks/2026/06/2026-06-05 ウ.md";
    await vault.create(C, v1Note(C, "カ", 0));
    await vault.create(D, v1Note(D, "イ", 0));
    await vault.create(E, v1Note(E, "ウ", 0));
    settings.ganttParentOrder = undefined;
    await runMigration(vault, settings, await planMigration(vault, settings), deps());
    const rows = await loadNoteTasks(vault, settings, new Map());
    const name = (id: string) => rows.find((row) => row.id === id)!.displayName;
    expect(settings.ganttParentOrder!.map(name)).toEqual(["イ", "ウ", "カ", "アルファ", "ベータ"]);
  });
});
