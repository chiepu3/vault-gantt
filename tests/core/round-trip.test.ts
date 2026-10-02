import { describe, it, expect } from "vitest";
import { buildFullNote, parseTaskFile } from "../../src/core/note-format";
import { DEFAULT_SETTINGS } from "../../src/core/constants";
import { TaskRow } from "../../src/core/types";

function sub(key: string, title: string, extra: Partial<TaskRow> = {}): TaskRow {
  return {
    kind: "subtask", id: `tasks/2026/07/P.md::${key}`, key,
    file: { parentPath: "tasks/2026/07/P.md", heading: title },
    title, displayName: title, statusLabel: "active", completed: false,
    createdAt: "2026-07-01", updatedAt: "2026-07-02", dueDate: "2026-08-01",
    priority: 3, priorityMode: "manual", tags: ["赤", "b"], currentStatus: "s1\nline2", notes: "n1",
    plannedStartDate: "2026-07-05", plannedEndDate: "2026-07-09",
    workloadPlan: { "2026-07-05": 3.5 }, workloadActual: {},
    ganttMarkers: [{ key: "m1", title: 'マ"ーカ', date: "2026-07-06", tags: ["t"] }],
    ...extra,
  } as TaskRow;
}

describe("round-trip", () => {
  it("preserves a parent with two subtasks", () => {
    const subs = new Map<string, TaskRow>([
      ["alpha", sub("alpha", "Alpha")],
      ["beta", sub("beta", "Beta", { ganttMarkers: [] })],
    ]);
    const parent: TaskRow = {
      kind: "parent", id: "tasks/2026/07/P.md", file: { path: "tasks/2026/07/P.md" },
      title: "親タスク", displayName: "親タスク", statusLabel: "in_progress", completed: false,
      createdAt: "2026-07-01", updatedAt: "2026-07-02", dueDate: "2026-08-15",
      priority: 2, priorityMode: "manual", tags: ["x"], currentStatus: "現状", notes: "メモ",
      ganttEnabled: true, ganttOrder: 12345, subtasks: subs,
    } as TaskRow;

    const note = buildFullNote(parent, subs, DEFAULT_SETTINGS);
    const back = parseTaskFile({ path: "tasks/2026/07/P.md" }, note, DEFAULT_SETTINGS);
    expect(back).not.toBeNull();
    const b = back as TaskRow;
    expect(b.displayName).toBe(parent.displayName);
    expect(b.statusLabel).toBe(parent.statusLabel);
    expect(b.dueDate).toBe(parent.dueDate);
    expect(b.priority).toBe(parent.priority);
    expect(b.priorityMode).toBe(parent.priorityMode);
    expect(b.tags).toEqual(parent.tags);
    expect(b.ganttEnabled).toBe(true);
    expect(b.ganttOrder).toBe(12345);
    expect(b.currentStatus).toBe("現状");
    expect(b.notes).toBe("メモ");
    const bs = b.subtasks as Map<string, TaskRow>;
    expect(bs).toBeInstanceOf(Map);
    expect([...bs.keys()]).toEqual(["alpha", "beta"]);
    const a = bs.get("alpha") as TaskRow;
    expect(a.title).toBe("Alpha");
    expect(a.plannedStartDate).toBe("2026-07-05");
    expect(a.plannedEndDate).toBe("2026-07-09");
    expect(a.workloadPlan).toEqual({ "2026-07-05": 3.5 });
    expect(a.tags).toEqual(["赤", "b"]);
    expect(a.currentStatus).toBe("s1\nline2");
    expect(a.notes).toBe("n1");
    expect(a.ganttMarkers).toEqual([{ key: "m1", title: 'マ"ーカ', date: "2026-07-06", tags: ["t"] }]);
    //末尾のサブタスクの Notes に meta-bind ボタン定義が混入しないこと
    const beta = bs.get("beta") as TaskRow;
    expect(beta.notes).toBe("n1");
    expect(beta.currentStatus).toBe("s1\nline2");
  });
});
