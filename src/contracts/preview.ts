import { z } from "zod";
import {
  idSchema, dateOnlySchema, timestampSchema, countSchema, statusSchema, jsonSchema, requestOriginSchema,
  revisionSchema, periodSchema, markerStateSchema, hoursCellSchema, namedDefinitionSchema, weeklyStateSchema,
  dailyStateSchema, dailySummarySchema, calendarStateSchema, publicSettingsSchema, dailyAggregateSchema,
  editableSettingKeySchema, EDITABLE_SETTING_KEYS, tagNamesSchema, operationErrorSchema, type DeepReadonly,
  contributionHoursCellSchema, SERVICE_STATE_KEYS, serviceStateSchema,
} from "./context";
import { operationIdSchema } from "./operations";

export const entityRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task"), taskId: idSchema, parentId: idSchema.optional() }).strict(),
  z.object({ kind: z.literal("marker"), taskId: idSchema, markerKey: idSchema }).strict(),
  z.object({ kind: z.literal("event"), eventKey: idSchema }).strict(),
  z.object({ kind: z.literal("weekly"), scheduleKey: idSchema }).strict(),
  z.object({ kind: z.literal("daily-todo"), path: idSchema, line: countSchema, itemFingerprint: revisionSchema }).strict(),
  z.object({ kind: z.literal("daily-file"), path: idSchema, sourceKey: idSchema }).strict(),
  z.object({ kind: z.literal("tag-definition"), tagKey: idSchema }).strict(),
  z.object({ kind: z.literal("source"), sourceKey: idSchema }).strict(),
  z.object({ kind: z.literal("setting"), key: editableSettingKeySchema }).strict(),
  z.object({ kind: z.literal("view"), viewId: idSchema }).strict(),
  z.object({ kind: z.literal("conversation"), conversationId: idSchema }).strict(),
  z.object({ kind: z.literal("integration"), targetId: idSchema }).strict(),
]);
export type EntityRef = DeepReadonly<z.infer<typeof entityRefSchema>>;
/** Stable identity used for coverage and page unions; optional task parent hints are not identity. */
export function entityRefKey(entity: EntityRef): string {
  switch (entity.kind) {
    case "task": return JSON.stringify([entity.kind, entity.taskId]);
    case "marker": return JSON.stringify([entity.kind, entity.taskId, entity.markerKey]);
    case "event": return JSON.stringify([entity.kind, entity.eventKey]);
    case "weekly": return JSON.stringify([entity.kind, entity.scheduleKey]);
    case "daily-todo": return JSON.stringify([entity.kind, entity.path, entity.line, entity.itemFingerprint]);
    case "daily-file": return JSON.stringify([entity.kind, entity.path, entity.sourceKey]);
    case "tag-definition": return JSON.stringify([entity.kind, entity.tagKey]);
    case "source": return JSON.stringify([entity.kind, entity.sourceKey]);
    case "setting": return JSON.stringify([entity.kind, entity.key]);
    case "view": return JSON.stringify([entity.kind, entity.viewId]);
    case "conversation": return JSON.stringify([entity.kind, entity.conversationId]);
    case "integration": return JSON.stringify([entity.kind, entity.targetId]);
  }
}
export const ENTITY_FIELDS = {
  task: ["displayName", "title", "statusLabel", "createdAt", "updatedAt", "dueDate", "priority", "priorityMode", "tags", "completed", "ganttEnabled", "ganttOrder", "currentStatus", "notes", "plannedStartDate", "plannedEndDate", "workloadPlan", "workloadActual", "ganttMarkers", "derivedPeriod", "progress", "effectivePriority", "children"],
  marker: ["key", "title", "date", "tags"], event: ["key", "title", "date", "workloadPlan", "workloadActual"],
  weekly: ["key", "title", "dayOfWeek", "minutesPerWeek"], "daily-todo": ["text", "completed"],
  "daily-file": ["path", "sourceKey", "templatePath"], "tag-definition": ["key", "name", "color", "order"],
  source: ["key", "label", "format", "creatableFromGantt", "templatePath"], setting: EDITABLE_SETTING_KEYS,
  view: ["position", "filterText", "statusFilter", "sortKey", "sortDir", "flatDueSort", "showCompleted", "expanded", "tagNames", "dayWidth", "date", "offset", "mode", "targetId", "selection"],
  conversation: ["provider", "endpoint", "model", "auth", "secretId", "title", "status", "activeConversationId", "messageCount"],
  integration: [...SERVICE_STATE_KEYS, "destination", "enabled", "intervalMinutes", "recording", "outputPath", "entryCount"],
} as const satisfies Record<EntityRef["kind"], readonly string[]>;
export type PublicEntityField = (typeof ENTITY_FIELDS)[keyof typeof ENTITY_FIELDS][number];
export const fieldChangeSchema = z.object({
  field: z.enum([...ENTITY_FIELDS.task, ...ENTITY_FIELDS.marker, ...ENTITY_FIELDS.event, ...ENTITY_FIELDS.weekly,
    ...ENTITY_FIELDS["daily-todo"], ...ENTITY_FIELDS["daily-file"], ...ENTITY_FIELDS["tag-definition"], ...ENTITY_FIELDS.source,
    ...ENTITY_FIELDS.setting, ...ENTITY_FIELDS.view, ...ENTITY_FIELDS.conversation, ...ENTITY_FIELDS.integration]),
  before: jsonSchema, after: jsonSchema, reason: z.enum(["requested", "normalized", "derived"]),
}).strict();
export type FieldChange = DeepReadonly<z.infer<typeof fieldChangeSchema>>;
export const serviceStateChangeSchema = fieldChangeSchema.superRefine((change, ctx) => {
  if (!(SERVICE_STATE_KEYS as readonly string[]).includes(change.field)) { ctx.addIssue({ code: "custom", message: "管理fieldのみ保存可能" }); return; }
  const schema = serviceStateSchema.shape[change.field as typeof SERVICE_STATE_KEYS[number]];
  if (!schema.safeParse(change.before).success || !schema.safeParse(change.after).success) ctx.addIssue({ code: "custom", message: "管理値の型が不正です" });
});
export const PREVIEW_EFFECT_KINDS = ["fields", "presence", "schedule", "deadline", "marker", "workload", "order", "membership", "tag-definition", "weekly", "daily-todo", "calendar", "settings", "view", "external-send", "diagnostic", "conversation", "service-state"] as const;
export const previewEffectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fields"), fields: z.array(fieldChangeSchema) }).strict(),
  z.object({ kind: z.literal("presence"), before: jsonSchema, after: jsonSchema, action: z.enum(["create", "delete", "duplicate"]) }).strict(),
  z.object({ kind: z.literal("schedule"), before: periodSchema, after: periodSchema, unit: z.enum(["calendar-day", "business-day"]) }).strict(),
  z.object({ kind: z.literal("deadline"), before: dateOnlySchema.nullable(), after: dateOnlySchema.nullable() }).strict(),
  z.object({ kind: z.literal("marker"), before: markerStateSchema.nullable(), after: markerStateSchema.nullable() }).strict(),
  z.object({ kind: z.literal("workload"), cells: z.array(z.object({ date: dateOnlySchema, before: contributionHoursCellSchema, after: contributionHoursCellSchema }).strict().refine((cell) => cell.date === cell.before.date && cell.date === cell.after.date, "時間cellの日付が不一致")) }).strict(),
  z.object({ kind: z.literal("order"), before: z.array(idSchema), after: z.array(idSchema) }).strict(),
  z.object({ kind: z.literal("membership"), before: z.boolean(), after: z.boolean(), retained: z.array(z.enum(["schedule", "workload", "markers"])) }).strict(),
  z.object({ kind: z.literal("tag-definition"), before: namedDefinitionSchema.nullable(), after: namedDefinitionSchema.nullable(), affectedCount: countSchema }).strict(),
  z.object({ kind: z.literal("weekly"), before: weeklyStateSchema.nullable(), after: weeklyStateSchema.nullable() }).strict(),
  z.object({ kind: z.literal("daily-todo"), before: dailyStateSchema.nullable(), after: dailyStateSchema.nullable() }).strict(),
  z.object({ kind: z.literal("calendar"), added: z.array(dateOnlySchema), removed: z.array(dateOnlySchema), source: z.enum(["manual", "special", "national"]) }).strict(),
  z.object({ kind: z.literal("service-state"), fields: z.array(serviceStateChangeSchema) }).strict(),
  z.object({ kind: z.literal("settings"), fields: z.array(fieldChangeSchema) }).strict(),
  z.object({ kind: z.literal("view"), before: jsonSchema, after: jsonSchema, affectedIds: z.array(idSchema) }).strict(),
  z.object({ kind: z.literal("external-send"), destination: z.string().min(1).max(2000), payloadDigest: revisionSchema, taskCount: countSchema, fieldsSent: z.array(z.string()), bytes: countSchema }).strict(),
  z.object({ kind: z.literal("diagnostic"), recording: z.boolean(), outputPath: idSchema.optional(), entryCount: countSchema.optional() }).strict(),
  z.object({ kind: z.literal("conversation"), action: z.enum(["configure", "create", "select", "send", "stop", "retry", "request-approval", "repreview"]), before: jsonSchema, after: jsonSchema }).strict(),
]);
export type PreviewEffect = DeepReadonly<z.infer<typeof previewEffectSchema>>;
export type PreviewEffectKind = PreviewEffect["kind"];
export const previewEntrySchema = z.object({
  actionId: idSchema, entity: entityRefSchema, displayName: z.string().max(20000), effects: z.array(previewEffectSchema),
}).strict().superRefine((entry, ctx) => {
  for (const effect of entry.effects) {
    if (effect.kind === "workload" && ["task", "marker", "event"].includes(entry.entity.kind)) {
      for (const cell of effect.cells) if (!hoursCellSchema.safeParse(cell.before).success || !hoursCellSchema.safeParse(cell.after).success) ctx.addIssue({ code: "custom", message: "task/eventの時間は24h以下" });
    }
    if (effect.kind === "service-state" && entry.entity.kind !== "integration") ctx.addIssue({ code: "custom", message: "管理値の保存先はintegrationです" });
    if (effect.kind !== "fields" && effect.kind !== "settings") continue;
    const allowed: readonly string[] = ENTITY_FIELDS[entry.entity.kind];
    for (const change of effect.fields) {
      if (!allowed.includes(change.field)) ctx.addIssue({ code: "custom", message: `entityの公開fieldではありません: ${change.field}` });
    }
  }
});
export type PreviewEntry = DeepReadonly<z.infer<typeof previewEntrySchema>>;

/** Appearance is already resolved by the projector; UI does not infer tag inheritance. */
const appearance = z.object({ color: z.string().nullable(), tags: z.array(z.object({ name: z.string(), color: z.string().nullable(), origin: z.enum(["own", "parent"]) }).strict()) }).strict();
export const ganttChildStateSchema = z.object({
  id: idSchema, parentId: idSchema, name: z.string(), status: statusSchema, completed: z.boolean(), tags: tagNamesSchema,
  period: periodSchema, due: dateOnlySchema.nullable(), markers: z.array(markerStateSchema), hours: z.array(hoursCellSchema),
  effectivePriority: z.number().min(0).max(5), appearance,
}).strict();
export const ganttParentStateSchema = z.object({
  id: idSchema, name: z.string(), enabled: z.boolean(), order: z.number().finite(), tags: tagNamesSchema,
  children: z.array(ganttChildStateSchema), period: periodSchema, progress: z.number().min(0).max(1), effectivePriority: z.number().min(0).max(5), appearance,
}).strict().refine((parent) => parent.children.every((child) => child.parentId === parent.id), "親子IDが不一致");
/** File existence is independent of parsed ToDo items, including an empty Daily file. */
export const dailyFileSnapshotSchema = z.object({ path: idSchema, sourceKey: idSchema, exists: z.boolean() }).strict();
export type DailyFileSnapshotV1 = DeepReadonly<z.infer<typeof dailyFileSnapshotSchema>>;
export const ganttStateSchema = z.object({
  parents: z.array(ganttParentStateSchema),
  events: z.array(z.object({ key: idSchema, title: z.string(), date: dateOnlySchema, hours: z.array(hoursCellSchema) }).strict()),
  weekly: z.array(weeklyStateSchema), daily: z.array(dailySummarySchema), tagDefinitions: z.array(namedDefinitionSchema),
  /** Optional for existing producers; required snapshots for any daily-file projection target. */
  dailyFiles: z.array(dailyFileSnapshotSchema).optional(), serviceState: serviceStateSchema.optional(),
  // Domain totals retain hidden task hours; viewport/tag filters do not erase stored contributions.
  settings: publicSettingsSchema, calendar: calendarStateSchema, aggregates: z.array(dailyAggregateSchema),
}).strict().superRefine((state, ctx) => {
  const taskIds = state.parents.flatMap((parent) => [parent.id, ...parent.children.map((child) => child.id)]);
  if (new Set(taskIds).size !== taskIds.length) ctx.addIssue({ code: "custom", message: "snapshotのtask IDは一意" });
  for (const ids of [state.events.map((event) => event.key), state.weekly.map((weekly) => weekly.key), state.tagDefinitions.map((tag) => tag.key), state.daily.map((day) => day.date), state.aggregates.map((day) => day.date), (state.dailyFiles ?? []).map((file) => JSON.stringify([file.path, file.sourceKey]))]) {
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "snapshotのentity/dateは一意" });
  }
});
export type GanttChildStateV1 = DeepReadonly<z.infer<typeof ganttChildStateSchema>>;
export type GanttParentStateV1 = DeepReadonly<z.infer<typeof ganttParentStateSchema>>;
export type GanttStateV1 = DeepReadonly<z.infer<typeof ganttStateSchema>>;
export const projectionCoverageSchema = z.object({
  targetCount: countSchema, offset: countSchema, includedCount: countSchema, truncated: z.boolean(), nextCursor: idSchema.nullable(),
}).strict().refine((coverage) => coverage.offset + coverage.includedCount <= coverage.targetCount
  && coverage.truncated === (coverage.offset + coverage.includedCount < coverage.targetCount)
  && coverage.truncated === (coverage.nextCursor !== null), "省略件数と詳細取得cursorが不一致");
export type ProjectionCoverageV1 = DeepReadonly<z.infer<typeof projectionCoverageSchema>>;
function represented(entity: EntityRef, state: GanttStateV1): boolean {
  const children = state.parents.flatMap((parent) => parent.children);
  switch (entity.kind) {
    case "task": return state.parents.some((parent) => parent.id === entity.taskId) || children.some((child) => child.id === entity.taskId);
    case "marker": return children.some((child) => child.id === entity.taskId && child.markers.some((marker) => marker.key === entity.markerKey));
    case "event": return state.events.some((event) => event.key === entity.eventKey);
    case "weekly": return state.weekly.some((weekly) => weekly.key === entity.scheduleKey);
    case "tag-definition": return state.tagDefinitions.some((tag) => tag.key === entity.tagKey);
    case "source": return state.settings.dailyTodoSources?.some((source) => source.key === entity.sourceKey) ?? false;
    case "setting": return Object.prototype.hasOwnProperty.call(state.settings, entity.key);
    case "daily-todo": return state.daily.some((day) => day.items?.some((item) => item.path === entity.path && item.line === entity.line && item.itemFingerprint === entity.itemFingerprint));
    case "daily-file": return state.dailyFiles?.some((file) => file.path === entity.path && file.sourceKey === entity.sourceKey && file.exists) ?? false;
    // These have no natural Gantt entity; their view/panel details are in effects.
    case "view": case "conversation": case "integration": return true;
  }
}
export const ganttProjectionSchema = z.object({
  schemaVersion: z.literal(1), baseRevision: revisionSchema, settingsRevision: revisionSchema, calendarRevision: revisionSchema,
  evaluatedDate: dateOnlySchema, timezone: idSchema, before: ganttStateSchema, after: ganttStateSchema,
  /** Counts refer to explicit changed targets, not contextual siblings or aggregate cells. */
  targets: z.array(entityRefSchema),
  visibility: z.array(z.object({ entity: entityRefSchema, state: z.enum(["visible", "filtered", "feature-disabled", "unscheduled", "outside-range"]), reason: z.string().min(1) }).strict()),
  affectedParentIds: z.array(idSchema), affectedDates: z.array(dateOnlySchema), coverage: projectionCoverageSchema,
}).strict().superRefine((projection, ctx) => {
  const keys = projection.targets.map(entityRefKey), visibleKeys = projection.visibility.map((item) => entityRefKey(item.entity));
  if (projection.coverage.includedCount !== keys.length || new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", message: "coverageは実際の一意なtarget数と一致する必要があります" });
  if (visibleKeys.length !== keys.length || new Set(visibleKeys).size !== keys.length || visibleKeys.some((key) => !keys.includes(key))) ctx.addIssue({ code: "custom", message: "visibilityは全targetと1対1" });
  for (const entity of projection.targets) if (!represented(entity, projection.before) && !represented(entity, projection.after)) ctx.addIssue({ code: "custom", message: "targetのbefore/after状態が投影にありません" });
  for (const id of projection.affectedParentIds) if (![...projection.before.parents, ...projection.after.parents].some((parent) => parent.id === id)) ctx.addIssue({ code: "custom", message: "影響親の全子snapshotが必要です" });
});
export type GanttProjectionV1 = DeepReadonly<z.infer<typeof ganttProjectionSchema>>;
export const projectionPageRequestSchema = z.object({ previewId: idSchema, cursor: idSchema, projectionKind: z.enum(["planned", "actual"]) }).strict();
export type ProjectionPageRequestV1 = DeepReadonly<z.infer<typeof projectionPageRequestSchema>>;
export const projectionPageSchema = z.object({
  schemaVersion: z.literal(1), previewId: idSchema, vaultInstanceId: idSchema, projectionKind: z.enum(["planned", "actual"]),
  requestCursor: idSchema.nullable(), projection: ganttProjectionSchema,
}).strict();
export type ProjectionPageV1 = DeepReadonly<z.infer<typeof projectionPageSchema>>;
export const projectionPageResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("success"), page: projectionPageSchema }).strict(),
  z.object({ status: z.literal("error"), error: operationErrorSchema }).strict(),
]);
export type ProjectionPageResultV1 = DeepReadonly<z.infer<typeof projectionPageResultSchema>>;
export const PROJECTION_PAGING_RULES = {
  boundTo: ["previewId", "vaultInstanceId", "principalId", "projectionKind", "baseRevision", "settingsRevision", "calendarRevision", "evaluatedDate", "timezone"],
  unit: "affected-parent-and-all-children", merge: "union-by-identity; identical-context-only; never-sum-aggregates",
  plannedStale: "全ページを破棄しrequestRepreviewで新previewIdを取得する。",
  actualStale: "全ページを破棄しinspectOutcomeと最新contextを再取得する。保存済みactionを再承認しない。",
} as const;
function canonical(value: unknown): string {
  function ordered(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(ordered);
    if (item !== null && typeof item === "object") return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, ordered(child)]));
    return item;
  }
  return JSON.stringify(ordered(value));
}
function unionByKey<T>(left: readonly T[], right: readonly T[], key: (value: T) => string): T[] {
  const items = new Map(left.map((value) => [key(value), value]));
  for (const value of right) {
    const old = items.get(key(value));
    if (old && canonical(old) !== canonical(value)) throw new Error("CURSOR_STALE: 同じsnapshotの内容が異なります");
    items.set(key(value), value);
  }
  return [...items.values()];
}
function mergeStates(left: GanttStateV1, right: GanttStateV1): GanttStateV1 {
  if (canonical(left.settings) !== canonical(right.settings) || canonical(left.calendar) !== canonical(right.calendar) || canonical(left.serviceState) !== canonical(right.serviceState)) throw new Error("CURSOR_STALE: 設定/休日snapshotが異なります");
  return {
    ...left, parents: unionByKey(left.parents, right.parents, (parent) => parent.id), events: unionByKey(left.events, right.events, (event) => event.key),
    weekly: unionByKey(left.weekly, right.weekly, (weekly) => weekly.key), daily: unionByKey(left.daily, right.daily, (day) => day.date),
    tagDefinitions: unionByKey(left.tagDefinitions, right.tagDefinitions, (tag) => tag.key), aggregates: unionByKey(left.aggregates, right.aggregates, (day) => day.date),
    ...(left.dailyFiles || right.dailyFiles ? { dailyFiles: unionByKey(left.dailyFiles ?? [], right.dailyFiles ?? [], (file) => JSON.stringify([file.path, file.sourceKey])) } : {}),
  };
}
/** Pure DTO validation/union only. No layout, business projection or persistence is computed here.
 * Pages must start at offset 0 and follow each preceding nextCursor. Prefixes may remain truncated.
 * Revision, date/TZ, Vault/principal binding changes invalidate the cursor at the serving port.
 */
export function mergeProjectionPages(pages: readonly ProjectionPageV1[]): GanttProjectionV1 {
  if (!pages.length) throw new Error("INVALID_INPUT: 最初の投影ページが必要です");
  const parsed = pages.map((page) => projectionPageSchema.parse(page));
  const first = parsed[0];
  if (first.requestCursor !== null || first.projection.coverage.offset !== 0) throw new Error("INVALID_INPUT: 先頭ページから取得してください");
  let combined: GanttProjectionV1 = first.projection;
  for (let index = 1; index < parsed.length; index++) {
    const page = parsed[index], previous = parsed[index - 1], projection = page.projection;
    const bound = ["baseRevision", "settingsRevision", "calendarRevision", "evaluatedDate", "timezone"] as const;
    if (page.previewId !== first.previewId || page.vaultInstanceId !== first.vaultInstanceId || page.projectionKind !== first.projectionKind
      || bound.some((key) => projection[key] !== first.projection[key]) || projection.coverage.targetCount !== first.projection.coverage.targetCount) throw new Error("CURSOR_STALE: ページの前提が異なります");
    if (previous.projection.coverage.nextCursor === null || page.requestCursor !== previous.projection.coverage.nextCursor
      || projection.coverage.offset !== combined.targets.length) throw new Error("INVALID_INPUT: cursor/ページ順序が不一致");
    if (projection.targets.some((target) => combined.targets.some((old) => entityRefKey(target) === entityRefKey(old)))) throw new Error("INVALID_INPUT: targetがページ間で重複しています");
    const targets = [...combined.targets, ...projection.targets];
    combined = ganttProjectionSchema.parse({
      ...combined, before: mergeStates(combined.before, projection.before), after: mergeStates(combined.after, projection.after), targets,
      visibility: [...combined.visibility, ...projection.visibility],
      affectedParentIds: [...new Set([...combined.affectedParentIds, ...projection.affectedParentIds])], affectedDates: [...new Set([...combined.affectedDates, ...projection.affectedDates])],
      coverage: { ...projection.coverage, offset: 0, includedCount: targets.length },
    });
  }
  return combined;
}
export const previewStatusSchema = z.enum(["pending", "applying", "success", "partial", "failed", "cancelled", "rejected", "stale", "expired", "revoked"]);
export const approvedPreviewEventSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal("approved"), eventId: idSchema, previewId: idSchema, occurredAt: timestampSchema }).strict();
export const previewEventSchema = z.union([approvedPreviewEventSchema, z.object({ schemaVersion: z.literal(1), kind: z.enum(["expired", "revoked"]), eventId: idSchema, previewId: idSchema, occurredAt: timestampSchema }).strict()]);
export type PreviewEventV1 = DeepReadonly<z.infer<typeof previewEventSchema>>;
export const operationPreviewSchema = z.object({
  schemaVersion: z.literal(1), previewId: idSchema, vaultInstanceId: idSchema,
  // Lazy enum access keeps the operation/preview module cycle safe in either import order.
  operationId: z.lazy(() => operationIdSchema), operationLabel: z.string().min(1).max(20000).optional(), origin: requestOriginSchema, status: previewStatusSchema,
  createdAt: timestampSchema, expiresAt: timestampSchema, approvedEvent: approvedPreviewEventSchema.optional(),
  summary: z.object({ targetCount: countSchema, actionCount: countSchema }).strict(),
  entries: z.array(previewEntrySchema), warnings: z.array(z.object({ code: z.string().min(1), detail: z.string() }).strict()),
  undo: z.object({ support: z.enum(["full", "partial", "none"]), reason: z.string().optional() }).strict(),
  projection: ganttProjectionSchema.nullable(),
}).strict().superRefine((preview, ctx) => {
  if (preview.approvedEvent && preview.approvedEvent.previewId !== preview.previewId) ctx.addIssue({ code: "custom", message: "別previewの承認イベントです" });
  if (new Set(preview.entries.map((entry) => entry.actionId)).size !== preview.entries.length) ctx.addIssue({ code: "custom", message: "actionIdは一意" });
  if (preview.summary.actionCount !== preview.entries.length) ctx.addIssue({ code: "custom", message: "承認対象actionを省略できません" });
  if (Date.parse(preview.createdAt) >= Date.parse(preview.expiresAt)) ctx.addIssue({ code: "custom", message: "期限は作成時刻より後" });
  if (preview.projection && preview.projection.coverage.offset !== 0) ctx.addIssue({ code: "custom", message: "previewには先頭投影ページが必要です" });
});
export type OperationPreviewV1 = DeepReadonly<z.infer<typeof operationPreviewSchema>>;
export const operationOutcomeSchema = z.object({
  previewId: idSchema, status: z.enum(["success", "partial", "failed", "cancelled", "stale"]),
  actions: z.array(z.object({ actionId: idSchema, state: z.enum(["committed", "failed", "not-attempted"]), actual: z.array(previewEffectSchema), errorCode: z.string().optional() }).strict()),
  undoEntryId: idSchema.optional(),
  /** Track 1 projects the actual committed actions against the original before snapshot.
   * Never use preview.projection.after as the saved state after partial/cancelled saving.
   * null = no Gantt impact (or zero committed actions), not permission for UI to infer it.
   */
  actualProjection: ganttProjectionSchema.nullable(),
}).strict().superRefine((outcome, ctx) => {
  if (new Set(outcome.actions.map((action) => action.actionId)).size !== outcome.actions.length) ctx.addIssue({ code: "custom", message: "結果actionIdは一意" });
  if (outcome.actions.some((action) => action.state !== "committed" && action.actual.length > 0)) ctx.addIssue({ code: "custom", message: "未保存actionにactual effectsはありません" });
  const committed = outcome.actions.filter((action) => action.state === "committed").length;
  if (outcome.status === "success" && committed !== outcome.actions.length) ctx.addIssue({ code: "custom", message: "successは全action保存済み" });
  if (outcome.status === "partial" && (committed === 0 || committed === outcome.actions.length)) ctx.addIssue({ code: "custom", message: "partialは一部だけ保存済み" });
  if (["failed", "stale"].includes(outcome.status) && committed > 0) ctx.addIssue({ code: "custom", message: "保存済みactionがある結果はfailed/staleではありません" });
  if (committed === 0 && outcome.actualProjection !== null) ctx.addIssue({ code: "custom", message: "未保存結果にactual投影はありません" });
  if (outcome.actualProjection && outcome.actualProjection.coverage.offset !== 0) ctx.addIssue({ code: "custom", message: "outcomeには先頭投影ページが必要です" });
});
export type OperationOutcomeV1 = DeepReadonly<z.infer<typeof operationOutcomeSchema>>;
/** Validate snapshot provenance, not layout. Contextual siblings remain in both snapshots:
 * their stored fields cannot change without committed effects, even if targets omit them.
 * Parent summaries and inherited appearance may change as a consequence of saved children.
 */
function validateActualSnapshots(planned: GanttProjectionV1 | null, projection: GanttProjectionV1, saved: readonly PreviewEntry[], issue: (message: string) => void): void {
  if (planned) {
    try { mergeStates(planned.before, projection.before); }
    catch { issue("actualProjection.beforeの共通snapshotがpreviewと一致しません"); }
  }
  const { before, after } = projection;
  const allEffects = saved.flatMap((entry) => entry.effects);
  const fields = (effects: readonly PreviewEffect[]) => effects.flatMap((effect) => effect.kind === "fields" || effect.kind === "settings" || effect.kind === "service-state" ? effect.fields : []);
  const hasKind = (effects: readonly PreviewEffect[], ...kinds: PreviewEffectKind[]) => effects.some((effect) => kinds.includes(effect.kind));
  const changed = (left: unknown, right: unknown) => canonical(left) !== canonical(right);
  const check = (allowed: boolean, left: unknown, right: unknown, label: string) => {
    if (!allowed && changed(left, right)) issue(`actualProjection.afterに未保存変更が含まれています: ${label}`);
  };
  const checkRecords = <T>(left: readonly T[], right: readonly T[], key: (item: T) => string, validate: (id: string, old: T | undefined, next: T | undefined) => void) => {
    const old = new Map(left.map((item) => [key(item), item])), next = new Map(right.map((item) => [key(item), item]));
    for (const id of new Set([...old.keys(), ...next.keys()])) validate(id, old.get(id), next.get(id));
  };
  const taskEffects = (id: string) => saved.filter((entry) => entry.entity.kind === "task" && entry.entity.taskId === id).flatMap((entry) => entry.effects);
  const globalAppearance = hasKind(allEffects, "tag-definition") || fields(allEffects).some((field) => ["ganttTags", "ganttFeatureTagsEnabled", "ganttShowTagsOnBars", "ganttShowParentTagsOnChildBars", "ganttShowTagsOnParents"].includes(field.field));
  const aliases: Record<string, readonly string[]> = {
    name: ["displayName", "title"], status: ["statusLabel"], enabled: ["ganttEnabled"], order: ["ganttOrder"],
    period: ["plannedStartDate", "plannedEndDate"], due: ["dueDate"], hours: ["workloadPlan", "workloadActual"], markers: ["ganttMarkers"],
  };
  const kinds: Record<string, readonly PreviewEffectKind[]> = { enabled: ["membership"], order: ["order"], period: ["schedule"], due: ["deadline"], hours: ["workload"], markers: ["marker"] };
  const checkHours = (id: string, old: readonly z.infer<typeof hoursCellSchema>[], next: readonly z.infer<typeof hoursCellSchema>[], effects: readonly PreviewEffect[]) => {
    const original = new Map(old.map((cell) => [cell.date, { ...cell }]));
    const expected = new Map(old.map((cell) => [cell.date, { ...cell }]));
    const workloadAfter = new Map<string, z.infer<typeof hoursCellSchema>>();
    const cellAt = (date: string) => expected.get(date) ?? { date, plan: 0, actual: 0 };
    // Both effect forms describe the same frozen change, not successive mutations.
    const ordered = [...effects.filter((effect) => effect.kind === "workload"), ...effects.filter((effect) => effect.kind !== "workload")];
    for (const effect of ordered) {
      if (effect.kind === "workload") for (const cell of effect.cells) {
        if (changed(original.get(cell.date) ?? { date: cell.date, plan: 0, actual: 0 }, cell.before)) issue(`actual workloadのbeforeがsnapshotと一致しません: ${id}/${cell.date}`);
        if (workloadAfter.has(cell.date) && changed(workloadAfter.get(cell.date), cell.after)) issue(`同じ日の日別工数effectsが矛盾しています: ${id}/${cell.date}`);
        workloadAfter.set(cell.date, { ...cell.after });
        expected.set(cell.date, { ...cell.after });
      }
      if (effect.kind === "fields") for (const change of effect.fields) {
        if (change.field !== "workloadPlan" && change.field !== "workloadActual") continue;
        const channel = change.field === "workloadPlan" ? "plan" : "actual";
        if (hasKind(effects, "workload")) {
          const fromCells = Object.fromEntries([...expected.values()].filter((cell) => cell[channel] !== 0).map((cell) => [cell.date, cell[channel]]));
          const fromMap = change.after && typeof change.after === "object" && !Array.isArray(change.after)
            ? Object.fromEntries(Object.entries(change.after).filter(([, value]) => value !== 0)) : change.after;
          if (changed(fromCells, fromMap)) issue(`actual workloadのmapとcellが一致しません: ${id}/${channel}`);
        }
        for (const cell of expected.values()) cell[channel] = 0;
        if (change.after === null || typeof change.after !== "object" || Array.isArray(change.after)) { issue(`actual workload mapが不正です: ${id}`); continue; }
        for (const [date, hours] of Object.entries(change.after)) {
          if (typeof hours !== "number") { issue(`actual workload mapが不正です: ${id}/${date}`); continue; }
          expected.set(date, { ...cellAt(date), [channel]: hours });
        }
      }
    }
    const normalized = (cells: readonly z.infer<typeof hoursCellSchema>[]) => cells.filter((cell) => cell.plan !== 0 || cell.actual !== 0).slice().sort((a, b) => a.date.localeCompare(b.date));
    if (changed(normalized([...expected.values()]), normalized(next))) issue(`actualProjectionの時間cellが実保存effectsと一致しません: ${id}`);
  };
  const checkTask = (id: string, old: GanttChildStateV1 | GanttParentStateV1 | undefined, next: GanttChildStateV1 | GanttParentStateV1 | undefined, parentId?: string) => {
    const effects = taskEffects(id);
    const parentPresence = parentId !== undefined && hasKind(taskEffects(parentId), "presence");
    if (!old || !next) { check(hasKind(effects, "presence") || parentPresence, old, next, id); return; }
    const markerEffects = saved.filter((entry) => entry.entity.kind === "marker" && entry.entity.taskId === id).flatMap((entry) => entry.effects);
    const childEffects = "children" in old && "children" in next ? [...new Set([...old.children, ...next.children].map((child) => child.id))].flatMap(taskEffects) : [];
    const parentTagChange = parentId !== undefined && fields(taskEffects(parentId)).some((field) => field.field === "tags");
    const ownFields = fields(effects).map((field) => field.field);
    for (const [field, value] of Object.entries(old)) {
      if (field === "children") continue; // Each child is checked independently below.
      const updated = (next as unknown as Record<string, unknown>)[field];
      const derived = ["appearance", "effectivePriority", "progress"].includes(field) || (field === "period" && "children" in old);
      const relevant = [...effects, ...childEffects];
      const derivedAllowed = field === "appearance" ? ownFields.includes("tags") || globalAppearance || parentTagChange
        : field === "period" ? hasKind(relevant, "schedule", "presence") || fields(relevant).some((change) => ["plannedStartDate", "plannedEndDate", "derivedPeriod"].includes(change.field))
        : field === "progress" ? hasKind(relevant, "presence") || fields(relevant).some((change) => ["completed", "statusLabel", "progress"].includes(change.field))
        : relevant.length > 0 || hasKind(allEffects, "calendar") || fields(allEffects).some((change) => change.field === "autoPriorityEnabled");
      const allowed = derived
        ? derivedAllowed
        : (aliases[field] ?? [field]).some((alias) => ownFields.includes(alias as PublicEntityField))
          || hasKind(effects, ...(kinds[field] ?? [])) || (field === "markers" && markerEffects.length > 0)
          || (field === "order" && allEffects.some((effect) => effect.kind === "order" && effect.after.includes(id)));
      check(allowed, value, updated, `${id}/${field}`);
    }
    if ("hours" in old && "hours" in next) checkHours(id, old.hours, next.hours, effects);
  };
  checkRecords(before.parents, after.parents, (parent) => parent.id, (id, old, next) => checkTask(id, old, next));
  checkRecords(before.parents.flatMap((parent) => parent.children), after.parents.flatMap((parent) => parent.children), (child) => child.id,
    (id, old, next) => checkTask(id, old, next, old?.parentId ?? next?.parentId));
  const entityEffects = (entity: EntityRef) => saved.filter((entry) => entityRefKey(entry.entity) === entityRefKey(entity)).flatMap((entry) => entry.effects);
  checkRecords(before.events, after.events, (event) => event.key, (key, old, next) => {
    const effects = entityEffects({ kind: "event", eventKey: key });
    if (!old || !next) { check(hasKind(effects, "presence"), old, next, `event/${key}`); return; }
    for (const field of ["title", "date", "hours"] as const) check(fields(effects).some((change) => (aliases[field] ?? [field]).includes(change.field))
      || hasKind(effects, ...(field === "date" ? ["schedule" as const] : kinds[field] ?? [])), old[field], next[field], `event/${key}/${field}`);
    checkHours(key, old.hours, next.hours, effects);
  });
  checkRecords(before.weekly, after.weekly, (schedule) => schedule.key, (key, old, next) => check(hasKind(entityEffects({ kind: "weekly", scheduleKey: key }), "weekly", "fields", "presence"), old, next, `weekly/${key}`));
  checkRecords(before.tagDefinitions, after.tagDefinitions, (tag) => tag.key, (key, old, next) => check(hasKind(entityEffects({ kind: "tag-definition", tagKey: key }), "tag-definition", "fields", "presence", "order")
    || allEffects.some((effect) => effect.kind === "order" && effect.after.includes(key)), old, next, `tag/${key}`));
  checkRecords(before.dailyFiles ?? [], after.dailyFiles ?? [], (file) => JSON.stringify([file.path, file.sourceKey]), (key, old, next) => {
    const file = next ?? old!;
    check(hasKind(entityEffects({ kind: "daily-file", path: file.path, sourceKey: file.sourceKey }), "presence"), old, next, `daily-file/${key}`);
  });
  const settingsFields = fields(saved.filter((entry) => ["setting", "source", "tag-definition"].includes(entry.entity.kind)).flatMap((entry) => entry.effects));
  const managementFields = saved.filter((entry) => entry.entity.kind === "integration").flatMap((entry) => entry.effects.flatMap((effect) => effect.kind === "service-state" ? effect.fields : []));
  for (const key of SERVICE_STATE_KEYS) {
    const change = managementFields.find((field) => field.field === key);
    const derivedHolidayUnion = key === "ganttHolidays" && hasKind(allEffects, "calendar");
    check(!!change || derivedHolidayUnion, before.serviceState?.[key], after.serviceState?.[key], `service-state/${key}`);
    if (derivedHolidayUnion && after.serviceState?.ganttHolidays !== undefined && changed(after.serviceState.ganttHolidays, [...new Set([...after.calendar.manual, ...after.calendar.special, ...after.calendar.national])].sort())) issue("統合休日が実保存calendarと一致しません");
    if (change && (changed(before.serviceState?.[key], change.before) || changed(after.serviceState?.[key], change.after))) issue(`管理値の実保存がsnapshotと一致しません: ${key}`);
  }
  for (const key of new Set([...Object.keys(before.settings), ...Object.keys(after.settings)])) {
    const derived = (key === "ganttTags" && hasKind(allEffects, "tag-definition")) || (key === "dailyTodoSources" && saved.some((entry) => entry.entity.kind === "source"));
    check(derived || (key === "ganttNationalHolidays" && managementFields.some((field) => field.field === key)) || settingsFields.some((field) => field.field === key), (before.settings as Record<string, unknown>)[key], (after.settings as Record<string, unknown>)[key], `settings/${key}`);
  }
  for (const key of ["weekends", "manual", "special", "national"] as const) check(allEffects.some((effect) => effect.kind === "calendar" && effect.source === key)
    || settingsFields.some((field) => field.field === ({ manual: "ganttManualHolidays", special: "ganttSpecialHolidays", national: "ganttNationalHolidays", weekends: "weekends" })[key]), before.calendar[key], after.calendar[key], `calendar/${key}`);
  checkRecords(before.daily, after.daily, (day) => day.date, (date, old, next) => {
    const dailySaved = saved.some((entry) => ["daily-todo", "daily-file", "source"].includes(entry.entity.kind));
    check(dailySaved, old, next, `daily/${date}`);
  });
  // Check arithmetic deltas against stored cells, including hidden siblings, without
  // recomputing the projector's baseline totals or adding repeated page aggregates.
  const totals = (state: GanttStateV1, date: string) => {
    const cells = [...state.parents.flatMap((parent) => parent.children.flatMap((child) => child.hours)), ...state.events.flatMap((event) => event.hours)].filter((cell) => cell.date === date);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    return { plan: cells.reduce((sum, cell) => sum + cell.plan, 0) + state.weekly.filter((schedule) => schedule.dayOfWeek === weekday).reduce((sum, schedule) => sum + schedule.minutesPerWeek / 60, 0), actual: cells.reduce((sum, cell) => sum + cell.actual, 0) };
  };
  checkRecords(before.aggregates, after.aggregates, (day) => day.date, (date, old, next) => {
    if (!old || !next) { issue(`actualProjectionの集計にはbefore/afterの同日snapshotが必要です: ${date}`); return; }
    const previous = totals(before, date), updated = totals(after, date);
    if (Math.abs(next.plan - old.plan - updated.plan + previous.plan) > 1e-9 || Math.abs(next.actual - old.actual - updated.actual + previous.actual) > 1e-9) issue(`actualProjectionの集計が実保存分と一致しません: ${date}`);
    check(changed(before.calendar, after.calendar) || settingsFields.some((field) => ["ganttWorkloadDailyCapacityHours", "ganttWorkloadMaxHours"].includes(field.field)), old.capacity, next.capacity, `aggregate/${date}/capacity`);
    if (next.overCapacity !== (next.plan > next.capacity || next.actual > next.capacity)) issue(`actualProjectionの計画時間超過判定が実保存分と一致しません: ${date}`);
  });
}
export const previewOutcomePairSchema = z.object({ preview: operationPreviewSchema, outcome: operationOutcomeSchema }).strict().superRefine(({ preview, outcome }, ctx) => {
  if (preview.previewId !== outcome.previewId) ctx.addIssue({ code: "custom", message: "別previewの結果です" });
  const expected = new Set(preview.entries.map((entry) => entry.actionId)), actual = new Set(outcome.actions.map((action) => action.actionId));
  if (expected.size !== actual.size || [...expected].some((id) => !actual.has(id)) || [...actual].some((id) => !expected.has(id))) ctx.addIssue({ code: "custom", message: "action ID集合が完全一致しません（未知/欠落ID）" });
  const committedIds = new Set(outcome.actions.filter((action) => action.state === "committed").map((action) => action.actionId));
  const committedEntities = new Set(preview.entries.filter((entry) => committedIds.has(entry.actionId)).map((entry) => entityRefKey(entry.entity)));
  if (preview.projection !== null && committedIds.size > 0 && outcome.actualProjection === null) ctx.addIssue({ code: "custom", message: "Gantt影響のある保存結果にactualProjectionが必要です" });
  if (outcome.actualProjection) {
    const projection = outcome.actualProjection;
    if (preview.projection && (["baseRevision", "settingsRevision", "calendarRevision", "evaluatedDate", "timezone"] as const).some((key) => projection[key] !== preview.projection![key])) ctx.addIssue({ code: "custom", message: "actualProjectionはpreviewと同じbefore前提から生成してください" });
    if (projection.coverage.targetCount !== committedEntities.size) ctx.addIssue({ code: "custom", message: "actualProjectionの全target数は保存済みentity数と一致する必要があります" });
    if (projection.targets.some((target) => !committedEntities.has(entityRefKey(target)))) ctx.addIssue({ code: "custom", message: "actualProjectionに未保存targetが含まれています" });
    if (!projection.coverage.truncated && preview.projection && committedEntities.size !== projection.targets.length) ctx.addIssue({ code: "custom", message: "actualProjectionに保存済みtargetが欠落しています" });
    const saved = preview.entries.filter((entry) => committedIds.has(entry.actionId)).map((entry) => ({ ...entry, effects: outcome.actions.find((action) => action.actionId === entry.actionId)!.actual }));
    validateActualSnapshots(preview.projection, projection, saved, (message) => ctx.addIssue({ code: "custom", message }));
  }
  for (const action of outcome.actions) {
    const entry = preview.entries.find((entry) => entry.actionId === action.actionId);
    if (entry && !previewEntrySchema.safeParse({ ...entry, effects: action.actual }).success) ctx.addIssue({ code: "custom", message: "actual effectsが保存先entityの契約に違反しています" });
  }
});
/** Call before publishing an outcome through HumanApprovalPort/PreviewPort. */
export function validatePreviewOutcome(preview: unknown, outcome: unknown): OperationOutcomeV1 {
  return previewOutcomePairSchema.parse({ preview, outcome }).outcome;
}
/** Immediate view/control results are distinct from reads and pending mutation previews. */
export const operationRequestResultSchema = z.object({
  schemaVersion: z.literal(1), resultKind: z.literal("request"), operationId: z.lazy(() => operationIdSchema),
  status: z.enum(["applied", "requested", "cancelled", "unavailable"]), effects: z.array(previewEffectSchema), error: operationErrorSchema.optional(),
}).strict();
export type OperationRequestResultV1 = DeepReadonly<z.infer<typeof operationRequestResultSchema>>;
export type { Period, HoursCell, MarkerState, NamedDefinition, WeeklyState, DailyState } from "./context";
