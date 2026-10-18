import { describe, expect, it } from "vitest";
import { parseYaml, stringifyYaml } from "obsidian";
import {
  applyFrontmatterChanges,
  buildNewNote,
  diffFrontmatter,
  extractSection,
  managedFrontmatter,
  parseNote,
  readSections,
  replaceSections,
  splitFrontmatter,
} from "../../src/core/note-v2";
import type { TaskRow } from "../../src/core/types";

const settings = { autoPriorityEnabled: true };

function frontmatterOf(note: string): Record<string, unknown> {
  const { front } = splitFrontmatter(note);
  return parseYaml(front.replace(/^---\r?\n/, "").replace(/\r?\n---[ \t]*\r?\n?$/, "")) as Record<string, unknown>;
}

function subtaskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    kind: "subtask", id: "s-p2m8vd", key: "s-p2m8vd", file: { path: "タスク/親/実装.md" } as TaskRow["file"],
    title: "実装", displayName: "実装", statusLabel: "active", completed: false, createdAt: "2026-10-02", updatedAt: "2026-10-18",
    dueDate: "2026-10-24", priority: 0, priorityMode: "auto", currentStatus: "進捗あり", notes: "メモ本文\n\n- a",
    tags: ["開発"], ganttEnabled: false, plannedStartDate: "2026-10-20", plannedEndDate: "2026-10-24",
    workloadPlan: { "2026-10-20": 2, "2026-10-21": 3 }, workloadActual: { "2026-10-20": 2.5 },
    ganttMarkers: [{ key: "x", title: "中間レビュー", date: "2026-10-22", tags: ["会議"] }],
    dependsOn: ["[[要件整理]]"], ...overrides,
  };
}

describe("note format v2 round trip", () => {
  it("writes the documented subtask layout and reads it back", () => {
    const note = buildNewNote(subtaskRow(), stringifyYaml, { parentLink: "[[2026-10-01 社内ツール更新]]" });
    const fm = frontmatterOf(note);
    expect(Object.keys(fm).slice(0, 5)).toEqual(["type", "formatVersion", "id", "title", "parent"]);
    expect(fm).toMatchObject({ type: "subtask", formatVersion: 2, id: "s-p2m8vd", parent: "[[2026-10-01 社内ツール更新]]", status: "active", completed: false, start: "2026-10-20", end: "2026-10-24", due: "2026-10-24", tags: ["開発"], dependsOn: ["[[要件整理]]"], plan: { "2026-10-20": 2, "2026-10-21": 3 }, actual: { "2026-10-20": 2.5 }, cssclasses: ["task"] });
    expect(fm.markers).toEqual([{ title: "中間レビュー", date: "2026-10-22", tags: ["会議"] }]);
    expect(fm).not.toHaveProperty("priority");
    expect(note).not.toMatch(/^# /m);

    const parsed = parseNote({ path: "タスク/親/実装.md" }, fm, readSections(note), settings)!;
    expect(parsed.kind).toBe("subtask");
    expect(parsed.parentLink).toBe("[[2026-10-01 社内ツール更新]]");
    expect(parsed.row).toMatchObject({ id: "s-p2m8vd", title: "実装", currentStatus: "進捗あり", notes: "メモ本文\n\n- a", plannedStartDate: "2026-10-20", workloadActual: { "2026-10-20": 2.5 }, dependsOn: ["[[要件整理]]"] });
    expect(parsed.row.ganttMarkers).toEqual([{ key: expect.any(String), title: "中間レビュー", date: "2026-10-22", tags: ["会議"] }]);
  });

  it("parent notes carry gantt and manual priority only", () => {
    const row: TaskRow = { ...subtaskRow(), kind: "parent", id: "t-7k3q9x", title: "社内ツール更新", displayName: "社内ツール更新", priority: 3, priorityMode: "manual", ganttEnabled: true, dependsOn: undefined, subtasks: new Map() };
    const fm = frontmatterOf(buildNewNote(row, stringifyYaml));
    expect(fm).toMatchObject({ type: "task", id: "t-7k3q9x", priority: 3, priorityMode: "manual", gantt: true });
    for (const key of ["parent", "start", "end", "plan", "actual", "markers", "dependsOn"]) expect(fm).not.toHaveProperty(key);
    const back = parseNote({ path: "タスク/x.md" }, fm, { currentStatus: "", notes: "" }, settings)!.row;
    expect(back).toMatchObject({ kind: "parent", priority: 3, priorityMode: "manual", ganttEnabled: true });
  });

  it("computes auto priority at read time instead of storing it", () => {
    const row = subtaskRow({ dueDate: "2000-01-01" });
    expect(managedFrontmatter(row).priority).toBeUndefined();
    const parsed = parseNote({ path: "a/b.md" }, frontmatterOf(buildNewNote(row, stringifyYaml)), { currentStatus: "", notes: "" }, settings)!.row;
    expect(parsed.priority).toBe(5);
    expect(parseNote({ path: "a/b.md" }, frontmatterOf(buildNewNote(row, stringifyYaml)), { currentStatus: "", notes: "" }, { autoPriorityEnabled: false })!.row.priority).toBe(0);
  });

  it("tolerates YAML dates, a missing title and nested dependsOn links", () => {
    const parsed = parseNote({ path: "x/ファイル名.md" }, { type: "subtask", id: "s-aaaaaa", due: new Date("2026-10-24T00:00:00Z"), dependsOn: [["要件整理"]], plan: { "2026-10-20": 2.2, bad: 1, "2026-10-21": 0 } }, { currentStatus: "", notes: "" }, settings)!.row;
    expect(parsed.title).toBe("ファイル名");
    expect(parsed.dueDate).toBe("2026-10-24");
    expect(parsed.dependsOn).toEqual(["[[要件整理]]"]);
    expect(parsed.workloadPlan).toEqual({ "2026-10-20": 2 });
  });

  it("ignores notes without an id or of another type", () => {
    expect(parseNote({ path: "a.md" }, { type: "task" }, { currentStatus: "", notes: "" }, settings)).toBeNull();
    expect(parseNote({ path: "a.md" }, { type: "memo", id: "t-aaaaaa" }, { currentStatus: "", notes: "" }, settings)).toBeNull();
    expect(parseNote({ path: "a.md" }, undefined, { currentStatus: "", notes: "" }, settings)).toBeNull();
  });
});

describe("frontmatter diff", () => {
  it("lists only changed managed keys and maps removals to undefined", () => {
    const before = managedFrontmatter(subtaskRow());
    const after = managedFrontmatter(subtaskRow({ dueDate: undefined, statusLabel: "done", workloadActual: undefined, tags: ["開発", "社内"] }));
    expect(diffFrontmatter(before, after)).toEqual({ status: "done", completed: true, due: undefined, tags: ["開発", "社内"], actual: undefined });
    const fm: Record<string, unknown> = { due: "x", actual: { a: 1 }, other: "keep", status: "active" };
    applyFrontmatterChanges(fm, diffFrontmatter(before, after));
    expect(fm).toEqual({ other: "keep", status: "done", completed: true, tags: ["開発", "社内"] });
  });

  it("no change gives an empty diff", () => {
    expect(diffFrontmatter(managedFrontmatter(subtaskRow()), managedFrontmatter(subtaskRow()))).toEqual({});
  });
});

describe("body sections", () => {
  const note = "---\nid: t-1\n---\n前置き\n\n## 現状\n今の状況\n\n## 独自\nそのまま\n\n## メモ\nm1\nm2\n";
  it("reads 現状 and メモ", () => {
    expect(readSections(note)).toEqual({ currentStatus: "今の状況", notes: "m1\nm2" });
    expect(extractSection("## メモ\n\n", "メモ")).toBe("");
  });
  it("replaces only the named section and keeps the rest byte for byte", () => {
    const next = replaceSections(note, { currentStatus: "新しい\n状況" });
    expect(next).toBe("---\nid: t-1\n---\n前置き\n\n## 現状\n新しい\n状況\n\n## 独自\nそのまま\n\n## メモ\nm1\nm2\n");
    expect(replaceSections(note, { notes: "" })).toBe("---\nid: t-1\n---\n前置き\n\n## 現状\n今の状況\n\n## 独自\nそのまま\n\n## メモ\n");
  });
  it("adds a missing section at the end", () => {
    expect(replaceSections("---\nid: t-1\n---\n本文\n", { notes: "x" })).toBe("---\nid: t-1\n---\n本文\n\n## メモ\nx\n");
  });
  it("is not confused by deeper headings or CRLF", () => {
    const text = "## 現状\r\nA\r\n### 小見出し\r\nB\r\n## メモ\r\nC";
    expect(extractSection(text, "現状")).toBe("A\r\n### 小見出し\r\nB");
  });
});
