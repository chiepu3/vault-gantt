import { describe, it, expect, vi, afterEach } from "vitest";
import { ScheduleGhostStore } from "../../src/app/schedule-ghost";
import type { OperationResult } from "../../src/app/operation-registry";
function result(count = 1): OperationResult {
  return { kind: "success", committed: count, total: count, results: [], message: "synthetic", diffs: Array.from({ length: count }, (_, index) => ({ taskId: "tasks/p.md::" + index, name: "合成", fields: [{ field: "plannedStartDate", before: "2026-10-01", after: "2026-10-03" }], schedule: { before: { start: "2026-10-01", end: "2026-10-02" }, after: { start: "2026-10-03", end: "2026-10-04" } } })) };
}
afterEach(() => vi.useRealTimers());
describe("ephemeral confirmed schedule ghosts", () => {
  it("bounds the latest result and expires after 60 seconds", () => {
    vi.useFakeTimers(); const store = new ScheduleGhostStore(); const listener = vi.fn(); store.subscribe(listener);
    store.show(result(200)); expect(store.entries.size).toBe(100);
    expect(store.fingerprint("tasks/p.md")).not.toBe("");
    vi.advanceTimersByTime(60000); expect(store.entries.size).toBe(0);
    expect(store.fingerprint("tasks/p.md")).toBe(""); expect(listener).toHaveBeenLastCalledWith("clear");
  });
  it("does not display non-date changes, uncommitted attempts, or persist between instances", () => {
    const store = new ScheduleGhostStore(); const nonDate = result(); nonDate.diffs[0].fields[0].field = "notes";
    store.show(nonDate); expect(store.entries.size).toBe(0);
    store.show({ ...result(), committed: 0, diffs: [] }); expect(store.entries.size).toBe(0);
    store.show(result()); expect(new ScheduleGhostStore().entries.size).toBe(0); store.clear();
  });
  it("clear is idempotent for close, undo/redo and external changes", () => {
    const store = new ScheduleGhostStore(); store.show(result()); store.clear(); store.clear(); expect(store.entries.size).toBe(0);
  });
});
