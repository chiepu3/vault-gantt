import { z } from "zod";
import {
  dateOnlySchema, idSchema, revisionSchema, statusSchema, tagNamesSchema,
  readResultSchema, type TaskReadResultV1, type DailyReadResultV1, type DeepReadonly, type Capability,
  type RequestOrigin, type OperationErrorV1,
} from "./context";
import {
  operationPreviewSchema, operationRequestResultSchema, type OperationPreviewV1,
  type OperationRequestResultV1, type PreviewEffectKind,
} from "./preview";

export type Schema<T> = z.ZodType<T>;
export const OPERATION_IDS = [
  "T01", "T02", "T03", "T04", "T05", "T06", "T07", "T08", "T09", "T10", "T11", "T12", "T13", "T14", "T15", "T16", "T17", "T18", "T19", "T20", "T21", "T22", "T23", "T24", "T25", "T26", "T27", "T28", "T29", "T30",
  "M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08",
  "E01", "E02", "E03", "E04", "E05", "E06", "E07", "W01", "W02", "W03",
  "D01", "D02", "D03", "D04", "D05", "D06", "D07", "D08", "D09",
  "S01", "S02", "S03", "S04", "S05", "S06", "S07", "S08", "S09", "S10", "S11", "S12", "S13", "S14", "S15", "S16", "S17", "S18", "S19", "S20", "S21", "S22", "S23", "S24", "S25", "S26", "S27", "S28", "S29", "S30", "S31", "S32", "S33", "S34", "S35",
  "V01", "V02", "V03", "V04", "V05", "V06", "V07", "V08", "V09", "V10", "V11", "V12", "V13", "V14", "V15", "V16", "V17", "V18", "V19", "V20", "V21", "V22", "V23",
  "Q01", "Q02", "Q03", "Q04", "Q05", "Q06", "Q07", "Q08",
] as const;
export const operationIdSchema = z.enum(OPERATION_IDS);
export type OperationId = z.infer<typeof operationIdSchema>;
export type OperationClassification = "read" | "view" | "write" | "control";

const singleLine = z.string().max(20000).regex(/^[^\r\n\0]*$/);
const name = singleLine.trim().min(1).max(200);
const text = z.string().max(20000);
const clearableDate = z.union([dateOnlySchema, z.literal("")]);
const expectedRevision = revisionSchema.optional();
const dateRange = z.object({ from: dateOnlySchema, to: dateOnlySchema }).strict().refine(({ from, to }) => from <= to, "日付範囲が逆転しています");
const workload = z.record(dateOnlySchema, z.number().finite().min(0).max(24));
const marker = z.object({ key: z.string().min(1).max(200).regex(/^[^\r\n\0:,[\]]+$/), title: singleLine.trim().min(1), date: dateOnlySchema, tags: tagNamesSchema.optional() }).strict();
const markers = z.array(marker).max(100).refine((items) => new Set(items.map((item) => item.key)).size === items.length, "マーカーkeyは一意");
export const taskScheduleInputSchema = z.object({ plannedStartDate: clearableDate.optional(), plannedEndDate: clearableDate.optional(), dueDate: clearableDate.optional() }).strict();
/** Legacy 19 fields. updatedAt is accepted for compatibility, but remains server managed. */
export const taskPatchInputSchema = taskScheduleInputSchema.extend({
  displayName: singleLine.optional(), title: singleLine.optional(), statusLabel: statusSchema.optional(),
  createdAt: clearableDate.optional(), updatedAt: clearableDate.optional(), priority: z.number().finite().min(0).max(5).optional(),
  priorityMode: z.enum(["auto", "manual"]).optional(), tags: tagNamesSchema.optional(), completed: z.boolean().optional(),
  ganttEnabled: z.boolean().optional(), ganttOrder: z.number().finite().optional(), currentStatus: text.optional(), notes: text.optional(),
  workloadPlan: workload.optional(), workloadActual: workload.optional(), ganttMarkers: markers.optional(),
}).strict();
export type TaskPatchInput = DeepReadonly<z.infer<typeof taskPatchInputSchema>>;
const task = { taskId: idSchema, expectedRevision };
const child = { subtaskId: idSchema, expectedRevision };
const parent = { parentId: idSchema, expectedRevision };
const event = { eventKey: idSchema, expectedRevision };
const markerTarget = { ...child, markerKey: idSchema };
const source = { sourceKey: idSchema, expectedRevision };
const tag = { tagKey: idSchema, expectedRevision };
const view = { viewId: idSchema };
const conversation = { conversationId: idSchema };
const dailyTarget = { path: idSchema, line: z.number().int().nonnegative(), itemFingerprint: revisionSchema, expectedRevision: revisionSchema };
const update = z.object({ ...task, patch: taskPatchInputSchema }).strict();
const batch = z.array(update).min(1).max(100).refine((items) => new Set(items.map((item) => item.taskId)).size === items.length, "タスクIDの重複は禁止");
const orderedIds = z.array(idSchema).min(1).max(1000).refine((ids) => new Set(ids).size === ids.length, "順序IDの重複は禁止");
const openView = z.object({ position: z.enum(["tab", "left", "right"]).optional(), viewId: idSchema.optional() }).strict();
const force = z.object({ force: z.boolean().optional() }).strict();
const empty = z.object({}).strict();
const feature = z.object({ enabled: z.boolean(), expectedRevision }).strict();
const weeklyPatch = z.object({ title: name.optional(), dayOfWeek: z.number().int().min(0).max(6).optional(), minutesPerWeek: z.number().finite().nonnegative().optional() }).strict().refine((patch) => Object.keys(patch).length > 0, "変更項目が必要");

/** One schema per ledger ID. Domain normalization/lookup belongs to future handlers. */
export const operationInputSchemas = {
  T01: z.object({ query: z.string().max(1000).optional(), cursor: idSchema.optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  T02: z.object({ taskId: idSchema, include: z.array(z.enum(["status", "schedule", "derived", "priority", "tags", "content", "markers", "workload", "children"])).optional() }).strict(),
  T03: z.object({ name }).strict(), T04: z.object({ parentTaskId: idSchema, name, expectedRevision }).strict(),
  T05: z.object({ name }).strict(), T06: z.object({ ...parent, name, date: dateOnlySchema }).strict(),
  T07: z.object({ ...task, name }).strict(), T08: z.object({ ...task, statusLabel: statusSchema }).strict(),
  T09: z.object({ ...task, completed: z.boolean() }).strict(), T10: z.object({ ...task, text }).strict(), T11: z.object({ ...task, text }).strict(),
  T12: z.object({ ...task, createdAt: clearableDate }).strict(), T13: z.object({ ...task, dueDate: clearableDate }).strict(),
  T14: z.object({ ...task, priority: z.number().finite().min(0).max(5) }).strict(), T15: z.object(task).strict(),
  T16: z.object({ ...task, tags: tagNamesSchema }).strict(), T17: z.object({ ...parent, enabled: z.boolean(), order: z.number().finite().optional() }).strict(),
  T18: z.object({ orderedParentIds: orderedIds, expectedRevision }).strict(),
  T19: z.object({ ...child, start: clearableDate.optional(), end: clearableDate.optional() }).strict().refine((v) => v.start !== undefined || v.end !== undefined, "開始/終了の指定が必要"),
  T20: z.object({ ...child, calendarDelta: z.number().int() }).strict(),
  T21: z.object({ ...child, date: dateOnlySchema }).strict(), T22: z.object({ ...child, date: dateOnlySchema }).strict(),
  T23: z.object({ ...child, date: dateOnlySchema }).strict(), T24: z.object(child).strict(),
  T25: z.object({ ...parent, anchorId: idSchema, shiftDays: z.number().int() }).strict(), T26: z.object(child).strict(),
  T27: z.object({ changes: batch }).strict(),
  T28: z.object({ changes: z.array(z.object({ ...task, patch: taskScheduleInputSchema }).strict()).min(1).max(100).refine((items) => new Set(items.map((item) => item.taskId)).size === items.length, "タスクIDの重複は禁止") }).strict(),
  T29: update, T30: force,
  M01: z.object({ ...child, title: name, date: dateOnlySchema, tags: tagNamesSchema.optional() }).strict(),
  M02: z.object({ ...markerTarget, patch: z.object({ title: name.optional(), date: dateOnlySchema.optional() }).strict().refine((v) => Object.keys(v).length > 0, "変更項目が必要") }).strict(),
  M03: z.object({ ...markerTarget, date: dateOnlySchema }).strict(), M04: z.object(markerTarget).strict(),
  M05: z.object({ ...markerTarget, tags: tagNamesSchema }).strict(), M06: z.object({ ...child, markers }).strict(),
  M07: z.object({ ...child, workloadPlan: workload }).strict(), M08: z.object({ ...child, workloadActual: workload }).strict(),
  E01: z.object({ title: singleLine.max(200), date: dateOnlySchema }).strict(), E02: z.object({ ...event, title: name }).strict(),
  E03: z.object({ ...event, date: dateOnlySchema }).strict(), E04: z.object(event).strict(), E05: z.object(event).strict(),
  E06: z.object({ ...event, plan: workload }).strict(), E07: z.object({ ...event, actual: workload }).strict(),
  W01: z.object({ title: name, dayOfWeek: z.number().int().min(0).max(6), minutesPerWeek: z.number().finite().nonnegative() }).strict(),
  W02: z.object({ scheduleKey: idSchema, patch: weeklyPatch, expectedRevision }).strict(), W03: z.object({ scheduleKey: idSchema, expectedRevision }).strict(),
  D01: z.object({ dateRange, sourceKeys: z.array(idSchema).optional(), cursor: idSchema.optional() }).strict(),
  D02: z.object({ date: dateOnlySchema, sourceKey: z.literal("main").optional() }).strict(),
  D03: z.object({ date: dateOnlySchema, text: singleLine.trim().min(1), completed: z.boolean().optional(), sourceKey: z.literal("main").optional() }).strict(),
  D04: z.object({ ...dailyTarget, text: singleLine.trim().min(1) }).strict(), D05: z.object({ ...dailyTarget, completed: z.boolean() }).strict(), D06: z.object(dailyTarget).strict(),
  D07: z.object({ date: dateOnlySchema, nextItems: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("existing"), ...dailyTarget, text: singleLine, completed: z.boolean() }).strict(),
    z.object({ kind: z.literal("new"), text: singleLine, completed: z.boolean() }).strict(),
  ])).max(100) }).strict(),
  D08: z.object({ path: idSchema }).strict(), D09: z.object({ date: dateOnlySchema }).strict(),
  S01: z.object({ taskFolder: idSchema, expectedRevision }).strict(), S02: z.object({ filenameUsesDatePrefix: z.boolean(), expectedRevision }).strict(),
  S03: z.object({ hideCompletedByDefault: z.boolean(), expectedRevision }).strict(), S04: z.object({ currentStatusRows: z.number().finite(), expectedRevision }).strict(),
  S05: z.object({ autoPriorityEnabled: z.boolean(), expectedRevision }).strict(), S06: z.object({ date: dateOnlySchema, enabled: z.boolean(), expectedRevision }).strict(),
  S07: z.object({ dates: z.array(dateOnlySchema).max(1000), expectedRevision }).strict(), S08: force,
  S09: feature, S10: feature, S11: feature, S12: feature, S13: feature, S14: feature, S15: feature, S16: feature, S17: feature, S18: feature,
  S19: z.object({ ganttSyncUrl: z.string().max(2000), expectedRevision }).strict(), S20: z.object({ ganttSyncIntervalMinutes: z.number().finite(), expectedRevision }).strict(),
  S21: empty,
  S22: z.object({ name, color: z.string().max(200).optional(), order: z.number().finite(), expectedRevision }).strict(),
  S23: z.object({ ...tag, name: singleLine.max(200) }).strict(), S24: z.object({ ...tag, color: z.string().max(200) }).strict(),
  S25: z.object({ orderedKeys: orderedIds, expectedRevision }).strict(), S26: z.object(tag).strict(),
  S27: z.object({ name, target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("task"), taskId: idSchema }).strict(),
    z.object({ kind: z.literal("marker"), taskId: idSchema, markerKey: idSchema }).strict(),
  ]), expectedRevision }).strict(),
  S28: z.object({ label: singleLine.max(200), format: z.string().max(1000), creatableFromGantt: z.boolean().optional(), templatePath: idSchema.optional(), expectedRevision }).strict(),
  S29: z.object({ ...source, label: singleLine.max(200) }).strict(), S30: z.object({ ...source, momentFormat: z.string().max(1000) }).strict(),
  S31: z.object({ ...source, templatePath: z.string().max(1000) }).strict(), S32: z.object({ ...source, creatableFromGantt: z.boolean() }).strict(),
  S33: z.object({ orderedKeys: orderedIds, expectedRevision }).strict(), S34: z.object(source).strict(), S35: empty,
  V01: openView, V02: openView, V03: z.object({ query: z.string().max(1000).optional() }).strict(),
  V04: z.object({ taskId: idSchema }).strict(), V05: z.object({ date: dateOnlySchema }).strict(), V06: openView,
  V07: z.object({ ...view, text: z.string().max(1000) }).strict(), V08: z.object({ ...view, status: z.union([statusSchema, z.literal("all")]) }).strict(),
  V09: z.object({ ...view, sort: z.enum(["dueDate", "updatedAt", "createdAt", "title", "statusLabel"]), direction: z.enum(["asc", "desc"]) }).strict(),
  V10: z.object({ ...view, flatDueSort: z.boolean() }).strict(), V11: z.object({ ...view, showCompleted: z.boolean() }).strict(),
  V12: z.object({ ...view, parentId: idSchema, expanded: z.boolean() }).strict(), V13: z.object({ ...view, tagNames: tagNamesSchema }).strict(),
  V14: z.object({ ...view, dayWidth: z.number().finite().min(14).max(72) }).strict(), V15: z.object({ ...view, date: dateOnlySchema, offset: z.number().int().optional() }).strict(),
  V16: z.object(view).strict(), V17: z.object({ ...view, kind: z.enum(["task", "parent", "event", "workload", "daily", "weekly"]), target: idSchema }).strict(),
  V18: z.object({ ...view, targetKind: z.enum(["task", "event"]), targetId: idSchema, mode: z.enum(["plan", "actual"]) }).strict(),
  V19: z.object({ ...view, enabled: z.boolean(), parentId: idSchema.optional(), anchorId: idSchema.optional() }).strict(),
  V20: empty, V21: empty, V22: z.object({ name: name.optional() }).strict(), V23: empty,
  Q01: z.object({ provider: z.enum(["disconnected", "openai-compatible"]), endpoint: z.string().max(2000), model: z.string().max(200), auth: z.enum(["secret", "none"]), secretId: z.string().max(1000) }).strict(),
  Q02: empty, Q03: z.object(conversation).strict(), Q04: z.object({ ...conversation, text: text.trim().min(1) }).strict(),
  Q05: z.object(conversation).strict(), Q06: z.object(conversation).strict(),
  // This is an approval REQUEST. The actual Q07 commit is only HumanApprovalPort.approve.
  Q07: z.object({ previewId: idSchema }).strict(), Q08: z.object({ previewId: idSchema }).strict(),
} as const satisfies Record<OperationId, z.ZodType>;
export type OperationInputMap = { [K in OperationId]: DeepReadonly<z.infer<(typeof operationInputSchemas)[K]>> };

type ContractRow = readonly [OperationClassification, readonly PreviewEffectKind[], readonly Capability[]];
const taskEffects = ["fields", "schedule", "deadline", "marker", "workload", "membership", "order"] as const;
/** Allowed effects, not a promise that every invocation produces every listed effect. Read effects are empty. */
export const OPERATION_CONTRACTS = {
  T01: ["read", [], ["read"]], T02: ["read", [], ["read"]],
  T03: ["write", ["presence"], ["propose"]], T04: ["write", ["presence", "fields", "schedule"], ["propose"]],
  T05: ["write", ["presence", "membership", "order"], ["propose"]], T06: ["write", ["presence", "schedule", "fields"], ["propose"]],
  T07: ["write", ["fields"], ["propose"]], T08: ["write", ["fields"], ["propose"]], T09: ["write", ["fields"], ["propose"]],
  T10: ["write", ["fields"], ["propose"]], T11: ["write", ["fields"], ["propose"]], T12: ["write", ["fields"], ["propose"]],
  T13: ["write", ["deadline", "fields"], ["propose"]], T14: ["write", ["fields"], ["propose"]], T15: ["write", ["fields"], ["propose"]], T16: ["write", ["fields"], ["propose"]],
  T17: ["write", ["membership", "order", "fields"], ["propose"]], T18: ["write", ["order", "fields"], ["propose"]],
  T19: ["write", ["schedule", "fields"], ["propose"]], T20: ["write", ["schedule", "marker", "fields"], ["propose"]],
  T21: ["write", ["schedule", "fields"], ["propose"]], T22: ["write", ["schedule", "fields"], ["propose"]], T23: ["write", ["schedule", "fields"], ["propose"]], T24: ["write", ["schedule", "fields"], ["propose"]],
  T25: ["write", ["schedule", "marker", "workload", "fields"], ["propose"]], T26: ["write", ["presence", "fields", "schedule", "workload", "marker"], ["propose"]],
  T27: ["write", taskEffects, ["propose"]], T28: ["write", ["schedule", "deadline", "fields"], ["propose"]], T29: ["write", taskEffects, ["propose"]], T30: ["write", ["fields", "service-state"], ["propose"]],
  M01: ["write", ["marker", "fields"], ["propose"]], M02: ["write", ["marker", "fields"], ["propose"]], M03: ["write", ["marker", "fields"], ["propose"]],
  M04: ["write", ["marker", "fields"], ["propose"]], M05: ["write", ["marker", "fields"], ["propose"]], M06: ["write", ["marker", "fields"], ["propose"]],
  M07: ["write", ["workload", "fields"], ["propose"]], M08: ["write", ["workload", "fields"], ["propose"]],
  E01: ["write", ["presence"], ["propose"]], E02: ["write", ["fields"], ["propose"]], E03: ["write", ["schedule"], ["propose"]],
  E04: ["write", ["presence", "workload"], ["propose"]], E05: ["write", ["presence", "workload"], ["propose"]], E06: ["write", ["workload"], ["propose"]], E07: ["write", ["workload"], ["propose"]],
  W01: ["write", ["weekly", "workload"], ["propose"]], W02: ["write", ["weekly", "workload"], ["propose"]], W03: ["write", ["weekly", "workload"], ["propose"]],
  D01: ["read", [], ["read"]], D02: ["write", ["presence"], ["propose"]], D03: ["write", ["presence", "daily-todo"], ["propose"]],
  D04: ["write", ["daily-todo"], ["propose"]], D05: ["write", ["daily-todo"], ["propose"]], D06: ["write", ["daily-todo"], ["propose"]],
  D07: ["write", ["presence", "daily-todo"], ["propose"]], D08: ["view", ["view"], ["ui"]], D09: ["write", ["presence", "daily-todo"], ["propose"]],
  S01: ["write", ["settings", "view"], ["propose"]], S02: ["write", ["settings"], ["propose"]], S03: ["write", ["settings", "view"], ["propose"]],
  S04: ["write", ["settings", "view"], ["propose"]], S05: ["write", ["settings", "fields", "service-state"], ["propose"]],
  S06: ["write", ["calendar", "workload", "settings"], ["propose"]], S07: ["write", ["calendar", "workload", "settings"], ["propose"]], S08: ["write", ["calendar", "workload", "service-state"], ["propose"]],
  S09: ["write", ["settings", "view"], ["propose"]], S10: ["write", ["settings", "view"], ["propose"]], S11: ["write", ["settings", "view"], ["propose"]],
  S12: ["write", ["settings", "view"], ["propose"]], S13: ["write", ["settings", "view"], ["propose"]], S14: ["write", ["settings", "view"], ["propose"]],
  S15: ["write", ["settings", "view"], ["propose"]], S16: ["write", ["settings", "view"], ["propose"]], S17: ["write", ["settings", "view"], ["propose"]],
  S18: ["write", ["settings", "external-send"], ["propose", "external"]], S19: ["write", ["settings", "external-send"], ["propose", "external"]], S20: ["write", ["settings", "external-send"], ["propose", "external"]],
  S21: ["write", ["external-send"], ["propose", "external"]],
  S22: ["write", ["tag-definition"], ["propose"]], S23: ["write", ["tag-definition"], ["propose"]], S24: ["write", ["tag-definition"], ["propose"]],
  S25: ["write", ["tag-definition", "order"], ["propose"]], S26: ["write", ["tag-definition"], ["propose"]], S27: ["write", ["tag-definition", "fields", "marker"], ["propose"]],
  S28: ["write", ["settings", "view"], ["propose"]], S29: ["write", ["settings", "view"], ["propose"]], S30: ["write", ["settings", "view"], ["propose"]],
  S31: ["write", ["settings"], ["propose"]], S32: ["write", ["settings"], ["propose"]], S33: ["write", ["settings", "order", "view"], ["propose"]], S34: ["write", ["settings", "view"], ["propose"]], S35: ["write", ["settings", "view"], ["propose"]],
  V01: ["view", ["view"], ["ui"]], V02: ["view", ["view"], ["ui"]], V03: ["view", ["view"], ["ui"]], V04: ["view", ["view"], ["ui"]], V05: ["view", ["view"], ["ui"]], V06: ["view", ["view"], ["ui"]],
  V07: ["view", ["view"], ["ui"]], V08: ["view", ["view"], ["ui"]], V09: ["view", ["view"], ["ui"]], V10: ["view", ["view"], ["ui"]], V11: ["view", ["view"], ["ui"]], V12: ["view", ["view"], ["ui"]],
  V13: ["view", ["view"], ["ui"]], V14: ["view", ["view", "settings"], ["ui"]], V15: ["view", ["view"], ["ui"]], V16: ["view", ["view"], ["ui"]], V17: ["view", ["view"], ["ui"]], V18: ["view", ["view"], ["ui"]], V19: ["view", ["view"], ["ui"]],
  V20: ["write", ["fields", "presence", "schedule", "deadline", "marker", "workload", "order", "membership", "tag-definition", "weekly", "daily-todo", "calendar", "settings", "view"], ["propose"]],
  V21: ["write", ["fields", "presence", "schedule", "deadline", "marker", "workload", "order", "membership", "tag-definition", "weekly", "daily-todo", "calendar", "settings", "view"], ["propose"]],
  V22: ["control", ["diagnostic"], ["diagnostic"]], V23: ["write", ["diagnostic", "presence"], ["propose", "diagnostic"]],
  Q01: ["control", ["conversation"], ["chat-control"]], Q02: ["control", ["conversation"], ["chat-control"]], Q03: ["control", ["conversation"], ["chat-control"]],
  Q04: ["control", ["conversation", "external-send"], ["chat-control", "external"]], Q05: ["control", ["conversation"], ["chat-control"]], Q06: ["control", ["conversation", "external-send"], ["chat-control", "external"]],
  Q07: ["control", ["conversation"], ["propose"]], Q08: ["control", ["conversation"], ["propose"]],
} as const satisfies Record<OperationId, ContractRow>;
export type ReadOperationId = { [K in OperationId]: (typeof OPERATION_CONTRACTS)[K][0] extends "read" ? K : never }[OperationId];
export type ViewOperationId = { [K in OperationId]: (typeof OPERATION_CONTRACTS)[K][0] extends "view" ? K : never }[OperationId];
export type WriteOperationId = { [K in OperationId]: (typeof OPERATION_CONTRACTS)[K][0] extends "write" ? K : never }[OperationId];
export type ControlOperationId = { [K in OperationId]: (typeof OPERATION_CONTRACTS)[K][0] extends "control" ? K : never }[OperationId];
/** Exhaustive audit of immediate view/control requests. Q07 only requests human approval. */
export const IMMEDIATE_PERSISTENCE = {
  D08: "none", V01: "none", V02: "none", V03: "none", V04: "none", V05: "none", V06: "none",
  V07: "none", V08: "none", V09: "none", V10: "none", V11: "none", V12: "none", V13: "none", V14: "settings",
  V15: "none", V16: "none", V17: "none", V18: "none", V19: "none", V22: "none",
  Q01: "none", Q02: "none", Q03: "none", Q04: "none", Q05: "none", Q06: "none", Q07: "none", Q08: "none",
} as const satisfies Record<ViewOperationId | ControlOperationId, "none" | "settings" | "vault">;
export const DIRECT_UI_ONLY_OPERATION_IDS = ["V14"] as const;
export type DirectUiOnlyOperationId = (typeof DIRECT_UI_ONLY_OPERATION_IDS)[number];
export type ExternalRequestOperationId = Exclude<ViewOperationId | ControlOperationId, DirectUiOnlyOperationId>;
/** Server-trusted origin only. A capability, client assertion or chat confirmation cannot override this. */
export function operationRequestDenial(id: OperationId, origin: RequestOrigin): OperationErrorV1 | undefined {
  if (id === "V14" && origin.kind !== "ui") return {
    code: "POLICY_DENIED", retryable: false, nextAction: "V14はganttZoomを永続化するため、人間がObsidianのGantt UIを直接操作してください。",
  };
  return undefined;
}
export type OperationOutputMap = {
  [K in OperationId]: K extends "T01" | "T02" ? TaskReadResultV1
    : K extends "D01" ? DailyReadResultV1
    : K extends WriteOperationId | "Q08" ? OperationPreviewV1 : OperationRequestResultV1;
};
/** Lazy DTO references avoid an initialization cycle with preview's operationId enum. */
export const operationOutputSchemas = Object.fromEntries(OPERATION_IDS.map((id) => [id, z.lazy(() => {
  if (OPERATION_CONTRACTS[id][0] === "read") return readResultSchema.refine((result) => result.data.kind === (id === "D01" ? "daily" : "tasks"), "操作とread DTOが不一致");
  if (OPERATION_CONTRACTS[id][0] === "write") return operationPreviewSchema.refine((result) => result.operationId === id, "操作IDが不一致");
  if (id === "Q08") return operationPreviewSchema;
  return operationRequestResultSchema.refine((result) => result.operationId === id, "操作IDが不一致");
})])) as unknown as { readonly [K in OperationId]: Schema<OperationOutputMap[K]> };
export interface ParameterDoc { readonly name: string; readonly description: string; readonly required: boolean }
export interface OperationDefinition<K extends OperationId> {
  readonly id: K;
  readonly inputSchema: Schema<OperationInputMap[K]>;
  readonly outputSchema: Schema<OperationOutputMap[K]>;
  readonly classification: OperationClassification;
  readonly capabilities: readonly Capability[];
  readonly requestPolicy: "capabilities" | "direct-ui-only";
  readonly previewKinds: readonly PreviewEffectKind[];
  readonly description: {
    readonly purpose: string; readonly targetKinds: readonly string[]; readonly parameters: readonly ParameterDoc[];
    readonly constraints: readonly string[]; readonly sideEffects: readonly string[]; readonly clearSemantics: readonly string[];
    readonly examples: readonly { readonly input: OperationInputMap[K]; readonly explanation: string }[];
    readonly errors: readonly string[]; readonly undo: string;
  };
}
// Re-export stable shared names for catalog consumers.
export type { DateOnly, Revision, Json, RequestOrigin, EditableSettingKey } from "./context";
