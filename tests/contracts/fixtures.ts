import type { OperationInputMap } from "../../src/contracts/operations";
import type { ContextQueryMap, ContextQueryOutputMap, ReadResultV1 } from "../../src/contracts/context";
import { CONTEXT_CURSOR_RULES } from "../../src/contracts/context";
import { PROJECTION_PAGING_RULES } from "../../src/contracts/preview";
import type { GanttChildStateV1, GanttParentStateV1, GanttStateV1, GanttProjectionV1, OperationPreviewV1, OperationOutcomeV1, PreviewEffect, ProjectionPageV1 } from "../../src/contracts/preview";

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
export const INPUT_FIXTURES = {
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

export const CHILD_STATE: GanttChildStateV1 = {
  id: CHILD_ID, parentId: PARENT_ID, name: "レビュー", status: "in_progress", completed: false, tags: ["対象"],
  period: { start: DATE, end: "2026-10-15" }, due: null,
  markers: [{ key: "review-point", title: "確認", date: DATE, tags: [] }], hours: [{ date: DATE, plan: 1.5, actual: 1 }],
  effectivePriority: 0, appearance: { color: "#4488cc", tags: [{ name: "対象", color: "#4488cc", origin: "own" }] },
};
const parentState: GanttParentStateV1 = {
  id: PARENT_ID, name: "リリース", enabled: true, order: 1000, tags: [], children: [CHILD_STATE],
  period: CHILD_STATE.period, progress: 0, effectivePriority: 0, appearance: { color: null, tags: [] },
};
export const GANTT_STATE: GanttStateV1 = {
  parents: [parentState], events: [], weekly: [], daily: [{ date: DATE, totalCount: 1, completedCount: 0 }],
  tagDefinitions: [{ key: "target", name: "対象", color: "#4488cc", order: 1000 }, { key: "focus", name: "重点", color: "#cc3344", order: 2000 }, { key: "other", name: "別", color: "#22aa66", order: 3000 }],
  settings: { ganttFeatureWorkloadEnabled: true, ganttWorkloadDailyCapacityHours: 7 },
  calendar: { weekends: [0, 6], manual: [], special: [], national: ["2026-10-12"] },
  aggregates: [{ date: DATE, plan: 1.5, actual: 1, capacity: 7, overCapacity: false }],
};
function projection(after: GanttStateV1): GanttProjectionV1 {
  return {
    schemaVersion: 1, baseRevision: revision, settingsRevision: "settings-sha256:fixture", calendarRevision: "calendar-sha256:fixture",
    evaluatedDate: "2026-10-09", timezone: "Asia/Tokyo", before: structuredClone(GANTT_STATE), after: structuredClone(after),
    targets: [{ kind: "task", taskId: CHILD_ID, parentId: PARENT_ID }],
    visibility: [{ entity: { kind: "task", taskId: CHILD_ID, parentId: PARENT_ID }, state: "visible", reason: "表示条件に一致" }],
    affectedParentIds: [PARENT_ID], affectedDates: [DATE, "2026-10-14", "2026-10-15"], coverage: { targetCount: 1, offset: 0, includedCount: 1, truncated: false, nextCursor: null },
  };
}
function preview(id: string, operationId: OperationPreviewV1["operationId"], effects: readonly PreviewEffect[], after?: GanttStateV1): OperationPreviewV1 {
  return {
    schemaVersion: 1, previewId: id, vaultInstanceId: "vault-fixture", operationId, origin: { kind: "chat", conversationId: "conversation-1" },
    status: "pending", createdAt: "2026-10-09T03:00:00Z", expiresAt: "2026-10-09T03:10:00Z",
    summary: { targetCount: 1, actionCount: 1 },
    entries: [{ actionId: `${id}:0`, entity: { kind: "task", taskId: CHILD_ID, parentId: PARENT_ID }, displayName: "レビュー", effects }],
    warnings: [], undo: { support: "full" }, projection: after ? projection(after) : null,
  };
}
const createdChild = { ...CHILD_STATE, id: `${PARENT_ID}::new`, name: "新しい子", period: { start: DATE, end: DATE }, markers: [], hours: [] };
const create = preview("create-fixture", "T06", [{ kind: "presence", action: "create", before: null, after: { id: createdChild.id, name: createdChild.name } },
  { kind: "schedule", before: { start: null, end: null }, after: createdChild.period, unit: "business-day" }],
{ ...GANTT_STATE, parents: [{ ...parentState, children: [CHILD_STATE, createdChild] }] });
export const CREATE_PREVIEW: OperationPreviewV1 = {
  ...create, entries: [{ ...create.entries[0], entity: { kind: "task", taskId: createdChild.id, parentId: PARENT_ID }, displayName: createdChild.name }],
  projection: { ...create.projection!, targets: [{ kind: "task", taskId: createdChild.id, parentId: PARENT_ID }], visibility: [{ entity: { kind: "task", taskId: createdChild.id, parentId: PARENT_ID }, state: "visible", reason: "新しい子の配置予定" }] },
};
export const DELETE_PREVIEW = preview("delete-fixture", "T26", [{ kind: "presence", action: "delete", before: { id: CHILD_ID, name: "レビュー" }, after: null }],
  { ...GANTT_STATE, parents: [{ ...parentState, children: [], period: { start: null, end: null } }], aggregates: [{ date: DATE, plan: 0, actual: 0, capacity: 7, overCapacity: false }] });
export const MARKER_PREVIEW = preview("marker-fixture", "M03", [{ kind: "marker", before: CHILD_STATE.markers[0], after: { ...CHILD_STATE.markers[0], date: "2026-10-14" } }],
  { ...GANTT_STATE, parents: [{ ...parentState, children: [{ ...CHILD_STATE, markers: [{ ...CHILD_STATE.markers[0], date: "2026-10-14" }] }] }] });
export const WORKLOAD_PREVIEW = preview("workload-fixture", "M07", [{ kind: "workload", cells: [{ date: DATE, before: CHILD_STATE.hours[0], after: { ...CHILD_STATE.hours[0], plan: 2 } }] }],
  { ...GANTT_STATE, parents: [{ ...parentState, children: [{ ...CHILD_STATE, hours: [{ ...CHILD_STATE.hours[0], plan: 2 }] }] }], aggregates: [{ date: DATE, plan: 2, actual: 1, capacity: 7, overCapacity: false }] });
const settings = preview("settings-fixture", "S10", [{ kind: "settings", fields: [{ field: "ganttFeatureWorkloadEnabled", before: true, after: false, reason: "requested" }] }],
  { ...GANTT_STATE, settings: { ...GANTT_STATE.settings, ganttFeatureWorkloadEnabled: false } });
export const SETTINGS_PREVIEW: OperationPreviewV1 = {
  ...settings, entries: [{ ...settings.entries[0], entity: { kind: "setting", key: "ganttFeatureWorkloadEnabled" }, displayName: "作業時間表示" }],
  projection: { ...settings.projection!, targets: [{ kind: "setting", key: "ganttFeatureWorkloadEnabled" }], visibility: [{ entity: { kind: "setting", key: "ganttFeatureWorkloadEnabled" }, state: "feature-disabled", reason: "作業時間機能をOFFにするため表示しない。保存済み時間は保持。" }] },
};
const fields: PreviewEffect[] = [{ kind: "fields", fields: [{ field: "completed", before: false, after: true, reason: "requested" }, { field: "statusLabel", before: "active", after: "done", reason: "derived" }] }];
export const SECOND_PARENT_ID = "tasks/2026/10/別リリース.md";
export const SECOND_CHILD_ID = `${SECOND_PARENT_ID}::review`;
const secondChild: GanttChildStateV1 = { ...CHILD_STATE, id: SECOND_CHILD_ID, parentId: SECOND_PARENT_ID, hours: [{ date: DATE, plan: 2, actual: 0 }] };
const secondParent: GanttParentStateV1 = { ...parentState, id: SECOND_PARENT_ID, name: "別リリース", children: [secondChild] };
const partialBefore: GanttStateV1 = { ...GANTT_STATE, parents: [parentState, secondParent], aggregates: [{ date: DATE, plan: 3.5, actual: 1, capacity: 7, overCapacity: false }] };
const savedChild: GanttChildStateV1 = { ...CHILD_STATE, tags: ["重点"], hours: [{ date: DATE, plan: 8, actual: 1 }], appearance: { color: "#cc3344", tags: [{ name: "重点", color: "#cc3344", origin: "own" }] } };
const failedChild: GanttChildStateV1 = { ...secondChild, tags: ["別"], hours: [{ date: DATE, plan: 10, actual: 0 }], appearance: { color: "#22aa66", tags: [{ name: "別", color: "#22aa66", origin: "own" }] } };
const savedEffects: readonly PreviewEffect[] = [
  { kind: "fields", fields: [{ field: "tags", before: ["対象"], after: ["重点"], reason: "requested" }] },
  { kind: "workload", cells: [{ date: DATE, before: CHILD_STATE.hours[0], after: savedChild.hours[0] }] },
];
const failedEffects: readonly PreviewEffect[] = [
  { kind: "fields", fields: [{ field: "tags", before: ["対象"], after: ["別"], reason: "requested" }] },
  { kind: "workload", cells: [{ date: DATE, before: secondChild.hours[0], after: failedChild.hours[0] }] },
];
const partial = preview("partial-fixture", "T27", savedEffects);
const partialTargets = [{ kind: "task", taskId: CHILD_ID, parentId: PARENT_ID }, { kind: "task", taskId: SECOND_CHILD_ID, parentId: SECOND_PARENT_ID }, { kind: "task", taskId: SECOND_PARENT_ID }] as const;
const partialProjection: GanttProjectionV1 = {
  ...projection(partialBefore), before: structuredClone(partialBefore),
  after: { ...partialBefore, parents: [{ ...parentState, children: [savedChild] }, { ...secondParent, name: "変更予定", children: [failedChild] }], aggregates: [{ date: DATE, plan: 18, actual: 1, capacity: 7, overCapacity: true }] },
  targets: partialTargets, visibility: partialTargets.map((entity) => ({ entity, state: "filtered", reason: "選択タグ「対象」に一致しない" })),
  affectedParentIds: [PARENT_ID, SECOND_PARENT_ID], coverage: { targetCount: 3, offset: 0, includedCount: 3, truncated: false, nextCursor: null },
};
export const PARTIAL_PREVIEW: OperationPreviewV1 = {
  ...partial, status: "partial", summary: { targetCount: 3, actionCount: 3 }, undo: { support: "partial", reason: "保存済みactionだけ" },
  entries: [
    { actionId: "partial-fixture:0", entity: partialTargets[0], displayName: "レビュー", effects: savedEffects },
    { actionId: "partial-fixture:1", entity: partialTargets[1], displayName: "別レビュー", effects: failedEffects },
    { actionId: "partial-fixture:2", entity: partialTargets[2], displayName: "別リリース", effects: [{ kind: "fields", fields: [{ field: "displayName", before: "別リリース", after: "変更予定", reason: "requested" }] }] },
  ], projection: partialProjection,
};
export const PARTIAL_OUTCOME: OperationOutcomeV1 = {
  previewId: PARTIAL_PREVIEW.previewId, status: "partial", undoEntryId: "undo-1",
  actions: [
    { actionId: "partial-fixture:0", state: "committed", actual: savedEffects },
    { actionId: "partial-fixture:1", state: "failed", actual: [], errorCode: "WRITE_FAILED" },
    { actionId: "partial-fixture:2", state: "not-attempted", actual: [] },
  ],
  actualProjection: {
    ...partialProjection, after: { ...partialBefore, parents: [{ ...parentState, children: [savedChild] }, secondParent], aggregates: [{ date: DATE, plan: 10, actual: 1, capacity: 7, overCapacity: true }] },
    targets: [partialTargets[0]], visibility: [{ entity: partialTargets[0], state: "filtered", reason: "選択タグ「対象」に一致しない" }],
    affectedParentIds: [PARENT_ID], coverage: { targetCount: 1, offset: 0, includedCount: 1, truncated: false, nextCursor: null },
  },
};
export const MCP_PREVIEW: OperationPreviewV1 = { ...preview("mcp-fixture", "T29", fields), origin: { kind: "mcp", principalId: "principal-fixture", clientLabel: "ローカルMCPクライアント" } };
const oneSided = preview("one-sided-fixture", "T19", [{ kind: "schedule", before: CHILD_STATE.period, after: { start: null, end: "2026-10-15" }, unit: "calendar-day" }],
  { ...GANTT_STATE, parents: [{ ...parentState, period: { start: null, end: "2026-10-15" }, children: [{ ...CHILD_STATE, period: { start: null, end: "2026-10-15" } }] }] });
export const ONE_SIDED_PREVIEW: OperationPreviewV1 = { ...oneSided, projection: { ...oneSided.projection!, visibility: [{ entity: partialTargets[0], state: "unscheduled", reason: "開始日が未設定のためbarを描画できない" }] } };
const filtered = preview("filtered-fixture", "T16", savedEffects.slice(0, 1), { ...GANTT_STATE, parents: [{ ...parentState, children: [{ ...savedChild, hours: CHILD_STATE.hours }] }] });
export const FILTERED_PREVIEW: OperationPreviewV1 = { ...filtered, projection: { ...filtered.projection!, visibility: [{ entity: partialTargets[0], state: "filtered", reason: "選択タグ「対象」に一致しない" }] } };
const outside = preview("outside-fixture", "T19", [{ kind: "schedule", before: CHILD_STATE.period, after: { start: "2026-12-13", end: "2026-12-15" }, unit: "calendar-day" }],
  { ...GANTT_STATE, parents: [{ ...parentState, period: { start: "2026-12-13", end: "2026-12-15" }, children: [{ ...CHILD_STATE, period: { start: "2026-12-13", end: "2026-12-15" } }] }] });
export const OUTSIDE_RANGE_PREVIEW: OperationPreviewV1 = { ...outside, projection: { ...outside.projection!, affectedDates: [DATE, "2026-10-15", "2026-12-13", "2026-12-15"], visibility: [{ entity: partialTargets[0], state: "outside-range", reason: "viewport 2026-10-01〜2026-10-31の範囲外" }] } };
const emptyDailyFile = { path: daily.path, sourceKey: "main" };
const emptyDailyState: GanttStateV1 = { ...GANTT_STATE, daily: [{ date: DATE, totalCount: 0, completedCount: 0, items: [] }], dailyFiles: [{ ...emptyDailyFile, exists: false }] };
const emptyDaily = preview("empty-daily-file-fixture", "D02", [{ kind: "presence", action: "create", before: null, after: emptyDailyFile }]);
export const D02_EMPTY_FILE_PREVIEW: OperationPreviewV1 = {
  ...emptyDaily, undo: { support: "none", reason: "Dailyファイル作成は履歴対象外" },
  entries: [{ ...emptyDaily.entries[0], entity: { kind: "daily-file", ...emptyDailyFile }, displayName: "空のDailyファイル" }],
  projection: { ...projection(emptyDailyState), before: structuredClone(emptyDailyState), after: { ...structuredClone(emptyDailyState), dailyFiles: [{ ...emptyDailyFile, exists: true }] },
    targets: [{ kind: "daily-file", ...emptyDailyFile }], visibility: [{ entity: { kind: "daily-file", ...emptyDailyFile }, state: "visible", reason: "ToDo項目0件でもDailyファイルは存在する" }], affectedParentIds: [], affectedDates: [DATE] },
};
export const PREVIEW_FIXTURES = { create: CREATE_PREVIEW, delete: DELETE_PREVIEW, marker: MARKER_PREVIEW, workload: WORKLOAD_PREVIEW, settings: SETTINGS_PREVIEW, partial: PARTIAL_PREVIEW, mcpOrigin: MCP_PREVIEW, oneSided: ONE_SIDED_PREVIEW, filtered: FILTERED_PREVIEW, outsideRange: OUTSIDE_RANGE_PREVIEW, emptyDailyFile: D02_EMPTY_FILE_PREVIEW } as const;
function successOutcome(preview: OperationPreviewV1): OperationOutcomeV1 {
  return { previewId: preview.previewId, status: "success", actions: preview.entries.map((entry) => ({ actionId: entry.actionId, state: "committed", actual: entry.effects })), actualProjection: structuredClone(preview.projection) };
}
export const D02_EMPTY_FILE_OUTCOME = successOutcome(D02_EMPTY_FILE_PREVIEW);
export const BOUNDARY_OUTCOMES = { oneSided: successOutcome(ONE_SIDED_PREVIEW), filtered: successOutcome(FILTERED_PREVIEW), featureDisabled: successOutcome(SETTINGS_PREVIEW), outsideRange: successOutcome(OUTSIDE_RANGE_PREVIEW), partial: PARTIAL_OUTCOME, emptyDailyFile: D02_EMPTY_FILE_OUTCOME } as const;
export const PROJECTION_PAGE_FIXTURES: readonly ProjectionPageV1[] = [
  { schemaVersion: 1, previewId: PARTIAL_PREVIEW.previewId, vaultInstanceId: PARTIAL_PREVIEW.vaultInstanceId, projectionKind: "planned", requestCursor: null,
    projection: { ...partialProjection, targets: partialTargets.slice(0, 2), visibility: partialProjection.visibility.slice(0, 2), coverage: { targetCount: 3, offset: 0, includedCount: 2, truncated: true, nextCursor: "projection-page-2" } } },
  { schemaVersion: 1, previewId: PARTIAL_PREVIEW.previewId, vaultInstanceId: PARTIAL_PREVIEW.vaultInstanceId, projectionKind: "planned", requestCursor: "projection-page-2",
    projection: { ...partialProjection, targets: partialTargets.slice(2), visibility: partialProjection.visibility.slice(2), coverage: { targetCount: 3, offset: 2, includedCount: 1, truncated: false, nextCursor: null } } },
];

/** All renderer variants, including effects without a natural Gantt shape. */
export const EFFECT_FIXTURES = [
  ...fields, CREATE_PREVIEW.entries[0].effects[0], CREATE_PREVIEW.entries[0].effects[1],
  { kind: "deadline", before: null, after: DATE }, MARKER_PREVIEW.entries[0].effects[0], WORKLOAD_PREVIEW.entries[0].effects[0],
  { kind: "order", before: ["a", "b"], after: ["b", "a"] },
  { kind: "membership", before: true, after: false, retained: ["schedule", "workload", "markers"] },
  { kind: "tag-definition", before: null, after: { key: "tag-1", name: "リリース", color: "#4488cc", order: 1000 }, affectedCount: 1 },
  { kind: "weekly", before: null, after: { key: "weekly-1", title: "定例", dayOfWeek: 2, minutesPerWeek: 60 } },
  { kind: "daily-todo", before: null, after: { path: daily.path, sourceKey: "main", text: "確認", completed: false } },
  { kind: "calendar", added: [DATE], removed: [], source: "manual" }, SETTINGS_PREVIEW.entries[0].effects[0],
  { kind: "view", before: { showCompleted: false }, after: { showCompleted: true }, affectedIds: [CHILD_ID] },
  { kind: "external-send", destination: "https://example.test/api/snapshot", payloadDigest: "payload-sha256:fixture", taskCount: 1, fieldsSent: ["title", "period"], bytes: 100 },
  { kind: "diagnostic", recording: false, outputPath: "_vault-gantt-logs/fixture.log", entryCount: 10 },
  { kind: "conversation", action: "request-approval", before: null, after: { previewId: "mcp-fixture" } },
  { kind: "service-state", fields: [{ field: "lastAutoPriorityUpdate", before: "", after: "2026-10-09", reason: "derived" }] },
] as const satisfies readonly PreviewEffect[];
export const READ_FIXTURES = {
  tasks: {
    schemaVersion: 1, resultKind: "read", today: "2026-10-09", timezone: "Asia/Tokyo", snapshotRevision: "snapshot-sha256:fixture", errors: [],
    data: { kind: "tasks", fieldsIncluded: ["identity", "status", "schedule", "priority"],
      items: [{ id: CHILD_ID, kind: "subtask", parentId: PARENT_ID, name: "レビュー", status: "in_progress", completed: false,
        schedule: { start: DATE, end: "2026-10-15", due: null }, priority: { stored: 0, effective: 0, mode: "auto" }, revision }],
      totalMatched: 21, returned: 1, truncated: true, nextCursor: "opaque-query-snapshot-cursor" },
  },
  daily: {
    schemaVersion: 1, resultKind: "read", today: "2026-10-09", timezone: "Asia/Tokyo", snapshotRevision: "snapshot-sha256:fixture", errors: [],
    data: { kind: "daily", days: [{ date: DATE, totalCount: 1, completedCount: 0, items: [{ path: daily.path, sourceKey: "main", line: daily.line, itemFingerprint: daily.itemFingerprint, revision, text: "確認", completed: false }] }],
      totalMatched: 1, returned: 1, truncated: false, nextCursor: null },
  },
} as const satisfies Record<string, ReadResultV1>;

export const CONTEXT_QUERY_FIXTURES = {
  "events.get": { eventKeys: ["event-1"] },
  "weekly.get": { daysOfWeek: [2] },
  "context.overview": { scope: { parentIds: [PARENT_ID] } },
  "tasks.search": { name: "レビュー", kind: "subtask", limit: 1, fields: ["identity", "status", "schedule", "priority"] },
  "tasks.get-many": { taskIds: [CHILD_ID], include: ["identity", "status", "schedule", "priority"] },
  "projects.get": { parentTaskId: PARENT_ID, includeChildren: true, childFields: ["identity", "status", "schedule", "priority"] },
  "calendar.get": { from: DATE, to: "2026-10-31" },
  "workload.get": { from: DATE, to: DATE, detail: true, mode: "both" },
  "daily.get": { dateRange: { from: DATE, to: DATE }, includeItems: true },
  "settings.get": { sections: ["display", "tags"] },
  "context.changes": { sinceRevision: "snapshot-sha256:previous", scope: { parentIds: [PARENT_ID] } },
} as const satisfies ContextQueryMap;
export const CONTEXT_QUERY_OUTPUT_FIXTURES = {
  "events.get": { ...READ_FIXTURES.tasks, data: { kind: "events", items: [{ key: "event-1", title: "確認会", date: DATE, hours: [], revision }], totalMatched: 1, returned: 1, truncated: false, nextCursor: null } },
  "weekly.get": { ...READ_FIXTURES.tasks, data: { kind: "weekly", items: [{ key: "weekly-1", title: "定例", dayOfWeek: 2, minutesPerWeek: 30, revision }], totalMatched: 1, returned: 1, truncated: false, nextCursor: null } },
  "context.overview": { ...READ_FIXTURES.tasks, data: { kind: "overview", counts: { parents: 1, children: 1, unplaced: 0, completed: 0, parseFailures: 0 }, settings: GANTT_STATE.settings, capabilities: ["read", "propose"], summaryRevision: READ_FIXTURES.tasks.snapshotRevision } },
  "tasks.search": READ_FIXTURES.tasks,
  "tasks.get-many": { ...READ_FIXTURES.tasks, data: { ...READ_FIXTURES.tasks.data, totalMatched: 1, truncated: false, nextCursor: null } },
  "projects.get": { ...READ_FIXTURES.tasks, data: { kind: "project", parent: { id: PARENT_ID, kind: "parent", parentId: null, name: "リリース", revision }, children: { ...READ_FIXTURES.tasks.data, totalMatched: 1, truncated: false, nextCursor: null }, derived: { period: CHILD_STATE.period, progress: 0 } } },
  "calendar.get": { ...READ_FIXTURES.tasks, data: { kind: "calendar", from: DATE, to: "2026-10-31", revision: "calendar-sha256:fixture", calendar: GANTT_STATE.calendar } },
  "workload.get": { ...READ_FIXTURES.tasks, data: { kind: "workload", days: [{ date: DATE, plan: 26.5, actual: 1, capacity: 7, overCapacity: true }], contributions: [
    { kind: "task", id: CHILD_ID, cells: CHILD_STATE.hours },
    { kind: "weekly", id: "weekly-1500", cells: [{ date: DATE, plan: 25, actual: 0 }] },
  ] } },
  "daily.get": READ_FIXTURES.daily,
  "settings.get": { ...READ_FIXTURES.tasks, data: { kind: "settings", sections: ["display", "tags"], values: { ganttZoom: 36, ganttTags: GANTT_STATE.tagDefinitions } } },
  "context.changes": { ...READ_FIXTURES.tasks, data: { kind: "changes", sinceRevision: "snapshot-sha256:previous", added: [], changed: READ_FIXTURES.tasks.data.items, deletedIds: [] } },
} as const satisfies ContextQueryOutputMap;
export const STALE_CURSOR_ERROR = { code: "CURSOR_STALE", field: "cursor", retryable: true, nextAction: CONTEXT_CURSOR_RULES.CURSOR_STALE } as const;
export const PROJECTION_STALE_ERROR = { ...STALE_CURSOR_ERROR, nextAction: PROJECTION_PAGING_RULES.plannedStale } as const;
