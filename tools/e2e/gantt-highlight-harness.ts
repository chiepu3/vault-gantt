/* Browser-side harness for tools/e2e/gantt-highlight.mjs. Bundled into the page of a throw-away Obsidian.
 * It builds one preview that changes a subtask period, plan/actual hours, a Daily ToDo day and events,
 * and serves it through a fake preview port so the real Gantt view can highlight it. */
import { FakePreviewPort } from "../../tests/ui/preview-fakes";
import type { OperationOutcomeV1, OperationPreviewV1 } from "../../src/contracts/preview";

const hours = (cells: Array<[string, number, number]>) => cells.map(([date, plan, actual]) => ({ date, plan, actual }));
const appearance = { color: null, tags: [] };
const child = (parentId: string, key: string, name: string, start: string, end: string, cells: Array<[string, number, number]>) => ({
  id: `${parentId}::${key}`, parentId, name, status: "in_progress", completed: false, tags: [], period: { start, end }, due: null, markers: [],
  hours: hours(cells), effectivePriority: 0, appearance,
});
function states(notePath: string) {
  const parentOf = (children: ReturnType<typeof child>[], name: string) => ({
    id: notePath, name, enabled: true, order: 0, tags: [], children, period: { start: "2026-10-13", end: "2026-10-21" }, progress: 0, effectivePriority: 0, appearance,
  });
  const base = {
    weekly: [], tagDefinitions: [], settings: {}, calendar: { weekends: [0, 6], manual: [], special: [], national: [] },
  };
  const before: any = {
    ...base,
    parents: [parentOf([
      child(notePath, "design", "デザイン確認", "2026-10-13", "2026-10-15", [["2026-10-13", 2, 1], ["2026-10-14", 3, 0]]),
      child(notePath, "review", "レビュー", "2026-10-16", "2026-10-19", [["2026-10-16", 4, 0]]),
      child(notePath, "old", "旧い作業", "2026-10-20", "2026-10-21", [["2026-10-20", 1, 0]]),
    ], "合成リリース")],
    events: [{ key: "e1", title: "定例会議", date: "2026-10-15", hours: hours([["2026-10-15", 1, 0]]) }, { key: "e2", title: "振り返り", date: "2026-10-22", hours: [] }],
    daily: [{ date: "2026-10-14", totalCount: 1, completedCount: 0 }],
    aggregates: [
      { date: "2026-10-13", plan: 2, actual: 1, capacity: 7, overCapacity: false }, { date: "2026-10-14", plan: 3, actual: 0, capacity: 7, overCapacity: false },
      { date: "2026-10-15", plan: 1, actual: 0, capacity: 7, overCapacity: false }, { date: "2026-10-16", plan: 4, actual: 0, capacity: 7, overCapacity: false },
    ],
  };
  const after: any = {
    ...base,
    parents: [parentOf([
      child(notePath, "design", "デザイン確認", "2026-10-13", "2026-10-17", [["2026-10-13", 2, 2], ["2026-10-14", 5, 0], ["2026-10-15", 2, 0]]),
      child(notePath, "review", "レビュー", "2026-10-16", "2026-10-19", [["2026-10-16", 4, 0]]),
      child(notePath, "new", "追加タスク", "2026-10-19", "2026-10-21", [["2026-10-19", 2, 0]]),
    ], "合成リリース")],
    events: [{ key: "e1", title: "定例会議", date: "2026-10-16", hours: hours([["2026-10-16", 2, 0]]) }, { key: "e3", title: "新しい予定", date: "2026-10-21", hours: [] }],
    daily: [{ date: "2026-10-14", totalCount: 2, completedCount: 0 }, { date: "2026-10-15", totalCount: 1, completedCount: 0 }],
    aggregates: [
      { date: "2026-10-13", plan: 2, actual: 2, capacity: 7, overCapacity: false }, { date: "2026-10-14", plan: 5, actual: 0, capacity: 7, overCapacity: false },
      { date: "2026-10-15", plan: 2, actual: 0, capacity: 7, overCapacity: false }, { date: "2026-10-16", plan: 6, actual: 0, capacity: 7, overCapacity: false },
      { date: "2026-10-19", plan: 2, actual: 0, capacity: 7, overCapacity: false },
    ],
  };
  return { before, after };
}
function build(notePath: string): { preview: OperationPreviewV1; saved: OperationPreviewV1; outcome: OperationOutcomeV1 } {
  const { before, after } = states(notePath);
  const projection: any = {
    schemaVersion: 1, baseRevision: "rev", settingsRevision: "settings-sha256:fixture", calendarRevision: "calendar-sha256:fixture", evaluatedDate: "2026-10-13", timezone: "Asia/Tokyo",
    before, after, targets: [{ kind: "task", taskId: `${notePath}::design`, parentId: notePath }], visibility: [], affectedParentIds: [notePath],
    affectedDates: ["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"], coverage: { targetCount: 1, offset: 0, includedCount: 1, truncated: false, nextCursor: null },
  };
  const preview: any = {
    schemaVersion: 1, previewId: "combo", vaultInstanceId: "vault-fixture", operationId: "T19", origin: { kind: "chat", conversationId: "c1" }, status: "pending",
    createdAt: "2026-10-13T03:00:00Z", expiresAt: "2099-10-13T03:10:00Z", summary: { targetCount: 1, actionCount: 1 },
    entries: [{ actionId: "combo:0", entity: { kind: "task", taskId: `${notePath}::design`, parentId: notePath }, displayName: "デザイン確認", effects: [] }],
    warnings: [], undo: { support: "full" }, projection,
  };
  const saved = { ...preview, previewId: "combo-saved", status: "success" };
  const outcome: any = { previewId: "combo-saved", status: "success", undoEntryId: "undo-1", actions: [{ actionId: "combo:0", state: "committed", actual: [] }], actualProjection: projection };
  return { preview, saved, outcome };
}
(window as any).__vgh = {
  makePort(notePath: string) {
    const { preview, saved, outcome } = build(notePath);
    const port = new FakePreviewPort([]);
    port.set(preview); port.set(saved, outcome);
    return port;
  },
};
