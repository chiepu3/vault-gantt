import type { OperationInputMap } from "../contracts/operations";
export const PARENT_ID = "tasks/2026/10/リリース.md";
export const CHILD_ID = `${PARENT_ID}::review`;
export const DATE = "2026-10-13";
const revision = "file-content-sha256:fixture";
const task = { taskId: CHILD_ID }, child = { subtaskId: CHILD_ID }, parent = { parentId: PARENT_ID };
const markerTarget = { ...child, markerKey: "review-point" }, event = { eventKey: "event-1" };
const source = { sourceKey: "main" }, tag = { tagKey: "tag-1" }, view = { viewId: "gantt-1" };
const daily = { path: "daily/2026-10-13.md", line: 3, itemFingerprint: "line-sha256:fixture", expectedRevision: revision };
const feature = { enabled: true }, conversation = { conversationId: "conversation-2" };

/** Valid example for every ledger schema. Existing rows always carry revision/fingerprint. */
export const OPERATION_EXAMPLES = {
  T01: { query: "レビュー", limit: 20 }, T02: { ...task, include: ["schedule", "status"] },
  T03: { name: "新しい親" }, T04: { parentTaskId: PARENT_ID, name: "新しい子" }, T05: { name: "Gantt親" }, T06: { ...parent, name: "新しい子", date: DATE },
  T07: { ...task, name: "変更名" }, T08: { ...task, statusLabel: "in_progress" }, T09: { ...task, completed: true }, T10: { ...task, text: "進行中\n確認待ち" }, T11: { ...task, text: "メモ" },
  T12: { ...task, createdAt: DATE }, T13: { ...task, dueDate: "" }, T14: { ...task, priority: 4 }, T15: task, T16: { ...task, tags: ["リリース"] },
  T17: { ...parent, enabled: true, order: 1000 }, T18: { orderedParentIds: [PARENT_ID] }, T19: { ...child, start: DATE, end: "2026-10-15" },
  T20: { ...child, calendarDelta: 2 }, T21: { ...child, date: DATE }, T22: { ...child, date: "2026-10-16" }, T23: { ...child, date: DATE }, T24: child,
  T25: { ...parent, anchorId: CHILD_ID, shiftDays: 2 }, T26: child, T27: { changes: [{ ...task, patch: { completed: true } }] },
  T28: { changes: [{ ...task, patch: { plannedStartDate: DATE, plannedEndDate: "2026-10-15" } }] }, T29: { ...task, patch: { notes: "メモ", tags: [] } }, T30: { force: true },
  M01: { ...child, title: "確認", date: DATE, tags: [] }, M02: { ...markerTarget, patch: { title: "最終確認" } }, M03: { ...markerTarget, date: "2026-10-14" },
  M04: markerTarget, M05: { ...markerTarget, tags: ["リリース"] }, M06: { ...child, markers: [] }, M07: { ...child, workloadPlan: { [DATE]: 1.3 } }, M08: { ...child, workloadActual: { [DATE]: 0 } },
  E01: { title: "イベント", date: DATE }, E02: { ...event, title: "変更名" }, E03: { ...event, date: DATE }, E04: event, E05: event,
  E06: { ...event, plan: { [DATE]: 2 } }, E07: { ...event, actual: { [DATE]: 1 } },
  W01: { title: "定例", dayOfWeek: 2, minutesPerWeek: 45 }, W02: { scheduleKey: "weekly-1", patch: { minutesPerWeek: 60 } }, W03: { scheduleKey: "weekly-1" },
  D01: { dateRange: { from: DATE, to: DATE }, sourceKeys: ["main"] }, D02: { date: DATE }, D03: { date: DATE, text: "確認", completed: false },
  D04: { ...daily, text: "確認する" }, D05: { ...daily, completed: true }, D06: daily,
  D07: { date: DATE, nextItems: [{ kind: "existing", ...daily, text: "確認する", completed: true }, { kind: "new", text: "新規", completed: false }] },
  D08: { path: daily.path }, D09: { date: DATE },
  S01: { taskFolder: "tasks" }, S02: { filenameUsesDatePrefix: true }, S03: { hideCompletedByDefault: true }, S04: { currentStatusRows: 5 },
  S05: { autoPriorityEnabled: true }, S06: { date: DATE, enabled: true }, S07: { dates: [DATE] }, S08: { force: true },
  S09: feature, S10: feature, S11: feature, S12: feature, S13: feature, S14: feature, S15: feature, S16: feature, S17: feature, S18: feature,
  S19: { ganttSyncUrl: "https://example.test/api/snapshot" }, S20: { ganttSyncIntervalMinutes: 5 }, S21: {},
  S22: { name: "リリース", color: "#4488cc", order: 1000 }, S23: { ...tag, name: "出荷" }, S24: { ...tag, color: "#4488cc" }, S25: { orderedKeys: ["tag-1"] }, S26: tag,
  S27: { name: "リリース", target: { kind: "marker", taskId: CHILD_ID, markerKey: "review-point" } },
  S28: { label: "日次", format: "[daily/]YYYY-MM-DD", creatableFromGantt: true }, S29: { ...source, label: "日次" }, S30: { ...source, momentFormat: "[daily/]YYYY-MM-DD" },
  S31: { ...source, templatePath: "" }, S32: { ...source, creatableFromGantt: true }, S33: { orderedKeys: ["main"] }, S34: source, S35: {},
  V01: { position: "tab" }, V02: view, V03: { query: "レビュー" }, V04: task, V05: { date: DATE }, V06: { position: "right" },
  V07: { ...view, text: "レビュー" }, V08: { ...view, status: "active" }, V09: { ...view, sort: "dueDate", direction: "asc" },
  V10: { ...view, flatDueSort: true }, V11: { ...view, showCompleted: true }, V12: { ...view, ...parent, expanded: true },
  V13: { ...view, tagNames: ["リリース"] }, V14: { ...view, dayWidth: 36 }, V15: { ...view, date: DATE }, V16: view,
  V17: { ...view, kind: "task", target: CHILD_ID }, V18: { ...view, targetKind: "task", targetId: CHILD_ID, mode: "plan" },
  V19: { ...view, enabled: true, ...parent, anchorId: CHILD_ID }, V20: {}, V21: {}, V22: { name: "診断" }, V23: {},
  Q01: { provider: "openai-compatible", endpoint: "https://example.test/v1", model: "example-model", auth: "secret", secretId: "existing-secret-id" },
  Q02: {}, Q03: conversation, Q04: { ...conversation, text: "レビューを予定してください" }, Q05: conversation, Q06: conversation,
  Q07: { previewId: "preview-fixture" }, Q08: { previewId: "preview-fixture" },
} as const satisfies OperationInputMap;

// Schemas and documentation are selected from the same catalog as the runtime.
// SDK tool names are ASCII and avoid dots for OpenAI-compatible providers.
