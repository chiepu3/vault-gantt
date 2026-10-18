import { describe, expect, it } from "vitest";
import { generateTaskId, isTaskId } from "../../src/core/ids";
import { datePrefixOf, parentFileStem, sanitizeFileStem, uniqueFileStem } from "../../src/core/file-names";
import { appendSubtaskOrder, moveSubtaskOrder, pruneSubtaskOrder, sortSubtasks } from "../../src/core/subtask-order";
import type { TaskRow } from "../../src/core/types";

describe("task ids", () => {
  it("has the t-/s- prefix and 6 base36 characters", () => {
    const used = new Set<string>();
    expect(generateTaskId("parent", used)).toMatch(/^t-[0-9a-z]{6}$/);
    expect(generateTaskId("subtask", used)).toMatch(/^s-[0-9a-z]{6}$/);
    expect(isTaskId("t-7k3q9x")).toBe(true);
    expect(isTaskId("t-7K3q9x")).toBe(false);
  });
  it("never returns an id that is already used", () => {
    const used = new Set<string>();
    const ids = Array.from({ length: 5000 }, () => generateTaskId("subtask", used));
    expect(new Set(ids).size).toBe(5000);
    // A deterministic generator that collides first must be retried.
    const taken = new Set(["s-000000"]);
    const values = [0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
    expect(generateTaskId("subtask", taken, () => values.shift()!)).toBe("s-iiiiii");
    expect(taken.has("s-iiiiii")).toBe(true);
  });
});

describe("file names", () => {
  it("replaces Windows-forbidden characters with full-width forms", () => {
    expect(sanitizeFileStem('a\\b/c:d*e?f"g<h>i|j')).toBe("a＼b／c：d＊e？f＂g＜h＞i｜j");
  });
  it("keeps names link-safe", () => {
    expect(sanitizeFileStem("案 #1 [仮] ^x")).toBe("案 ＃1 ［仮］ ＾x");
  });
  it("trims trailing dots and spaces and fills an empty name", () => {
    expect(sanitizeFileStem("  名前. . ")).toBe("名前");
    expect(sanitizeFileStem("...")).toBe("無題");
    expect(sanitizeFileStem("con")).toBe("con_");
  });
  it("truncates to 100 characters without leaving trailing spaces or half a surrogate pair", () => {
    expect(Array.from(sanitizeFileStem("あ".repeat(150))).length).toBe(100);
    expect(sanitizeFileStem("x".repeat(99) + " " + "y".repeat(10))).toBe("x".repeat(99));
    expect(Array.from(sanitizeFileStem("😀".repeat(120))).length).toBe(100);
  });
  it("adds a numeric suffix on collisions", () => {
    const taken = new Set(["案", "案 2"]);
    expect(uniqueFileStem("案", (name) => taken.has(name))).toBe("案 3");
    expect(uniqueFileStem("別", (name) => taken.has(name))).toBe("別");
  });
  it("builds parent stems with the date prefix setting", () => {
    expect(parentFileStem("社内/ツール", "2026-10-01", true)).toBe("2026-10-01 社内／ツール");
    expect(parentFileStem("社内ツール", "2026-10-01", false)).toBe("社内ツール");
    expect(datePrefixOf("2026-10-01 社内ツール")).toBe("2026-10-01");
    expect(datePrefixOf("社内ツール")).toBeUndefined();
  });
});

const row = (id: string, createdAt: string, displayName: string): TaskRow => ({ kind: "subtask", id, createdAt, displayName, title: displayName } as TaskRow);

describe("subtask order store", () => {
  const children = [row("s-b", "2026-10-02", "い"), row("s-a", "2026-10-01", "あ"), row("s-c", "2026-10-02", "あ"), row("s-d", "2026-10-03", "う")];
  it("uses the stored order and appends missing ones by created then title", () => {
    expect(sortSubtasks({ subtaskOrder: { p: ["s-d", "s-b"] } }, "p", children).map((r) => r.id)).toEqual(["s-d", "s-b", "s-a", "s-c"]);
    expect(sortSubtasks({}, "p", children).map((r) => r.id)).toEqual(["s-a", "s-c", "s-b", "s-d"]);
  });
  it("ignores unknown ids and other parents", () => {
    expect(sortSubtasks({ subtaskOrder: { p: ["gone", "s-b"], q: ["s-d"] } }, "p", children).map((r) => r.id)).toEqual(["s-b", "s-a", "s-c", "s-d"]);
  });
  it("append keeps the existing order and materializes the current one for a new parent entry", () => {
    expect(appendSubtaskOrder({ subtaskOrder: { p: ["s-a"] } }, "p", ["s-z", "s-a"]).p).toEqual(["s-a", "s-z"]);
    expect(appendSubtaskOrder({}, "p", ["s-z"], children).p).toEqual(["s-a", "s-c", "s-b", "s-d", "s-z"]);
  });
  it("moves one subtask", () => {
    expect(moveSubtaskOrder({}, "p", children, "s-d", 0).p).toEqual(["s-d", "s-a", "s-c", "s-b"]);
  });
  it("prunes ids that no longer exist", () => {
    const order = { p: ["s-a", "gone"], q: ["x"] };
    expect(pruneSubtaskOrder(order, "p", new Set(["s-a"]))).toEqual({ p: ["s-a"], q: ["x"] });
    expect(pruneSubtaskOrder(order, "q", new Set(["x"]))).toBe(order);
  });
});
