import { describe, it, expect } from "vitest";
import { applyStoredOrder, computeParentOrder, reconcileParentOrder } from "../../src/core/parent-order";
import type { TaskRow } from "../../src/core/types";

const parent = (path: string, ganttOrder: number | undefined, name = path): TaskRow =>
  ({ kind: "parent", id: path, file: { path }, title: name, displayName: name, ganttOrder } as TaskRow);

describe("parent-order", () => {
  it("migrates from note ganttOrder (name tiebreak) when the store is undefined", () => {
    const settings: { ganttParentOrder?: string[] } = {};
    const rows = [parent("c.md", 30), parent("a.md", 20, "b"), parent("b.md", 20, "a"), parent("d.md", undefined)];
    expect(reconcileParentOrder(settings, rows)).toBe(true);
    expect(settings.ganttParentOrder).toEqual(["b.md", "a.md", "c.md", "d.md"]);
    expect(rows.map((r) => r.ganttOrder)).toEqual([3000, 2000, 1000, 4000]);
  });

  it("appends parents missing from the store after listed ones, by note order", () => {
    const settings = { ganttParentOrder: ["x.md", "y.md"] };
    const rows = [parent("y.md", 1), parent("new2.md", 20), parent("x.md", 2), parent("new1.md", 10)];
    expect(reconcileParentOrder(settings, rows)).toBe(true);
    expect(settings.ganttParentOrder).toEqual(["x.md", "y.md", "new1.md", "new2.md"]);
    expect(rows.find((r) => r.id === "new1.md")!.ganttOrder).toBe(3000);
    expect(reconcileParentOrder(settings, rows)).toBe(false);
  });

  it("applyStoredOrder leaves unknown parents alone", () => {
    const rows = [parent("a.md", 7), parent("b.md", 8)];
    applyStoredOrder({ ganttParentOrder: ["b.md"] }, rows);
    expect(rows.map((r) => r.ganttOrder)).toEqual([7, 1000]);
  });

  it("computeParentOrder applies numeric targets and keeps ties stable", () => {
    expect(computeParentOrder(["a", "b", "c"], new Map([["c", 500]]))).toEqual(["c", "a", "b"]);
    expect(computeParentOrder(["a", "b"], new Map([["z", 1500]]))).toEqual(["a", "z", "b"]);
    expect(computeParentOrder(["a", "b"], new Map([["b", 1000]]))).toEqual(["a", "b"]);
  });
});
