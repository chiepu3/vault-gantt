import { describe, expect, it } from "vitest";
import { parseYaml, stringifyYaml } from "obsidian";
import { buildNewNote, diffFrontmatter, managedFrontmatter, parseNote, splitFrontmatter } from "../../src/core/note-v2";
import { getMilestones, isLegacyOnlyMilestones, withDueDate } from "../../src/core/milestones";
import { applyPatchToRow } from "../../src/core/task-patch";
import type { TaskRow } from "../../src/core/types";

const settings = { autoPriorityEnabled: false };
const bodies = { currentStatus: "", notes: "" };

function parentRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    kind: "parent", id: "t-aaaaaa", file: { path: "タスク/親.md" } as TaskRow["file"], title: "親", displayName: "親",
    statusLabel: "active", completed: false, createdAt: "2026-10-01", updatedAt: "2026-10-01", priority: 0, priorityMode: "auto",
    currentStatus: "", notes: "", tags: [], ganttEnabled: true, subtasks: new Map(), ...overrides,
  };
}

function frontmatterOf(note: string): Record<string, unknown> {
  const { front } = splitFrontmatter(note);
  return parseYaml(front.replace(/^---\r?\n/, "").replace(/\r?\n---[ \t]*\r?\n?$/, "")) as Record<string, unknown>;
}

describe("parent milestones", () => {
  it("treats a legacy single due as one 期限 milestone, without writing milestones", () => {
    const row = parentRow({ dueDate: "2026-11-01" });
    expect(getMilestones(row)).toEqual([{ key: "due", title: "期限", date: "2026-11-01" }]);
    expect(managedFrontmatter(row).milestones).toBeUndefined();
    const parsed = parseNote({ path: "a.md" }, { type: "task", id: "t-aaaaaa", due: "2026-11-01" }, bodies, settings)!.row;
    expect(parsed.milestones).toBeUndefined();
    expect(parsed.dueDate).toBe("2026-11-01");
  });

  it("round-trips named, tagged milestones and keeps due as the earliest date", () => {
    const row = parentRow({
      dueDate: "2026-11-01",
      milestones: [
        { key: "a", title: "最終納品", date: "2026-12-01", tags: ["会議"] },
        { key: "b", title: "中間レビュー", date: "2026-11-01" },
      ],
    });
    const fm = frontmatterOf(buildNewNote(row, stringifyYaml));
    expect(fm.due).toBe("2026-11-01");
    expect(fm.milestones).toEqual([
      { title: "最終納品", date: "2026-12-01", tags: ["会議"] },
      { title: "中間レビュー", date: "2026-11-01" },
    ]);
    const back = parseNote({ path: "a.md" }, fm, bodies, settings)!.row;
    expect(back.dueDate).toBe("2026-11-01");
    expect(back.milestones?.map((m) => [m.title, m.date, m.tags])).toEqual([
      ["最終納品", "2026-12-01", ["会議"]],
      ["中間レビュー", "2026-11-01", undefined],
    ]);
  });

  it("does not store milestones that are only the plain 期限", () => {
    expect(isLegacyOnlyMilestones([{ key: "x", title: "期限", date: "2026-11-01" }])).toBe(true);
    const before = managedFrontmatter(parentRow({ dueDate: "2026-11-01" }));
    const after = managedFrontmatter(parentRow({ dueDate: "2026-11-01", milestones: [{ key: "due", title: "期限", date: "2026-11-01" }] }));
    expect(diffFrontmatter(before, after)).toEqual({});
  });

  it("a milestones patch sets dueDate to the earliest and clears it when empty", () => {
    const row = parentRow({ dueDate: "2026-11-01" });
    applyPatchToRow(row, { milestones: [{ key: "a", title: "後", date: "2026-12-01" }, { key: "b", title: "先", date: "2026-11-15" }] }, settings);
    expect(row.dueDate).toBe("2026-11-15");
    applyPatchToRow(row, { milestones: [] }, settings);
    expect(row.dueDate).toBe("");
    expect(row.milestones).toBeUndefined();
  });

  it("a plain dueDate patch moves or creates the earliest milestone", () => {
    const row = parentRow();
    applyPatchToRow(row, { dueDate: "2026-11-01" }, settings);
    expect(row.milestones).toEqual([{ key: "due", title: "期限", date: "2026-11-01" }]);
    applyPatchToRow(row, { milestones: [{ key: "a", title: "後", date: "2026-12-01" }, { key: "b", title: "先", date: "2026-11-15" }] }, settings);
    applyPatchToRow(row, { dueDate: "2026-11-20" }, settings);
    expect(row.milestones).toEqual([{ key: "b", title: "先", date: "2026-11-20", tags: [] }, { key: "a", title: "後", date: "2026-12-01", tags: [] }]);
    expect(row.dueDate).toBe("2026-11-20");
    expect(withDueDate(row.milestones!, "").map((m) => m.key)).toEqual(["a"]);
  });

  it("rejects a milestone without a title", () => {
    expect(() => applyPatchToRow(parentRow(), { milestones: [{ key: "a", title: "", date: "2026-11-01" }] }, settings)).toThrow(/title is required/);
  });
});
