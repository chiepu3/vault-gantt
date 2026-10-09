import { z } from "zod";

/** Wire contracts only: no Obsidian objects, Maps, secrets or service imports. */
export type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export const jsonSchema: z.ZodType<Json> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(),
  z.array(jsonSchema), z.record(z.string(), jsonSchema),
]));
export const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "実在するYYYY-MM-DD（暦日、TZ変換なし）");
export type DateOnly = z.infer<typeof dateOnlySchema>;
/** Content/subset hashes, never an mtime or a file size. */
export const revisionSchema = z.string().min(1).max(1000);
export type Revision = z.infer<typeof revisionSchema>;
export const idSchema = z.string().min(1).max(1000);
export const timestampSchema = z.iso.datetime({ offset: true });
export const countSchema = z.number().int().nonnegative();
export const statusSchema = z.enum(["active", "in_progress", "waiting", "hold", "done"]);
export const tagNamesSchema = z.array(z.string().max(200).regex(/^[^\r\n\0]*$/)).max(100);
export const capabilitySchema = z.enum(["read", "propose", "ui", "external", "diagnostic", "chat-control"]);
export type Capability = z.infer<typeof capabilitySchema>;
export const DEFAULT_CAPABILITIES = ["read", "propose"] as const satisfies readonly Capability[];
export const INITIAL_POLICY = {
  mcpWrite: "preview-then-obsidian-human-approval",
  stdio: "running-plugin-bridge", autoExecute: false,
} as const;
export const requestOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chat"), conversationId: idSchema }).strict(),
  z.object({ kind: z.literal("mcp"), principalId: idSchema, clientLabel: z.string().max(200) }).strict(),
  z.object({ kind: z.literal("ui"), viewId: idSchema }).strict(),
  z.object({ kind: z.literal("system"), cause: z.enum(["priority", "holidays", "sync"]) }).strict(),
]);
export type RequestOrigin = DeepReadonly<z.infer<typeof requestOriginSchema>>;
/** Constructed by the transport/server, never accepted as tool arguments. */
export interface RequestContext {
  readonly vaultInstanceId: string;
  readonly principalId: string;
  readonly origin: RequestOrigin;
  readonly capabilities: readonly Capability[];
  readonly requestId: string;
  readonly callerIntentId?: string;
  readonly signal?: AbortSignal;
}

export const periodSchema = z.object({ start: dateOnlySchema.nullable(), end: dateOnlySchema.nullable() }).strict()
  .refine(({ start, end }) => !start || !end || start <= end, "開始日は終了日以前");
export type Period = DeepReadonly<z.infer<typeof periodSchema>>;
/** Persisted task/event cells retain the 24h limit. Weekly contributions can exceed it. */
export const taskHoursCellSchema = z.object({ date: dateOnlySchema, plan: z.number().finite().min(0).max(24).multipleOf(0.5), actual: z.number().finite().min(0).max(24).multipleOf(0.5) }).strict();
export type TaskHoursCell = DeepReadonly<z.infer<typeof taskHoursCellSchema>>;
export const hoursCellSchema = taskHoursCellSchema;
export type HoursCell = TaskHoursCell;
export const contributionHoursCellSchema = z.object({ date: dateOnlySchema, plan: z.number().finite().nonnegative().multipleOf(0.5), actual: z.number().finite().nonnegative().multipleOf(0.5) }).strict();
export type ContributionHoursCell = DeepReadonly<z.infer<typeof contributionHoursCellSchema>>;
export const workloadContributionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task"), id: idSchema, cells: z.array(taskHoursCellSchema) }).strict(),
  z.object({ kind: z.literal("event"), id: idSchema, cells: z.array(taskHoursCellSchema) }).strict(),
  z.object({ kind: z.literal("weekly"), id: idSchema, cells: z.array(contributionHoursCellSchema) }).strict(),
]);
export type WorkloadContributionV1 = DeepReadonly<z.infer<typeof workloadContributionSchema>>;
export const markerStateSchema = z.object({ key: idSchema, title: z.string().trim().min(1).max(20000).regex(/^[^\r\n\0]*$/), date: dateOnlySchema, tags: tagNamesSchema }).strict();
export type MarkerState = DeepReadonly<z.infer<typeof markerStateSchema>>;
export const namedDefinitionSchema = z.object({ key: idSchema, name: z.string().max(200), color: z.string().max(200), order: z.number().finite() }).strict();
export type NamedDefinition = DeepReadonly<z.infer<typeof namedDefinitionSchema>>;
export const weeklyStateSchema = z.object({ key: idSchema, title: z.string().max(200), dayOfWeek: z.number().int().min(0).max(6), minutesPerWeek: z.number().int().nonnegative().multipleOf(30) }).strict();
export type WeeklyState = DeepReadonly<z.infer<typeof weeklyStateSchema>>;
export const dailyStateSchema = z.object({ path: idSchema, sourceKey: idSchema, text: z.string().max(20000), completed: z.boolean() }).strict();
export type DailyState = DeepReadonly<z.infer<typeof dailyStateSchema>>;
export const sourceDefinitionSchema = z.object({ key: idSchema, label: z.string().max(200), format: z.string().max(1000), creatableFromGantt: z.boolean(), templatePath: idSchema.optional() }).strict();
export const EDITABLE_SETTING_KEYS = [
  "taskFolder", "filenameUsesDatePrefix", "hideCompletedByDefault", "currentStatusRows", "autoPriorityEnabled",
  "ganttManualHolidays", "ganttSpecialHolidays", "ganttFeatureDailyTodoEnabled", "ganttFeatureWorkloadEnabled",
  "ganttFeatureEventsEnabled", "ganttFeatureSyncEnabled", "ganttFeatureTagsEnabled", "incrementalGanttRender",
  "ganttShowTagsOnBars", "ganttShowParentTagsOnChildBars", "ganttShowTagsOnParents", "ganttSyncEnabled",
  "ganttSyncUrl", "ganttSyncIntervalMinutes", "ganttTags", "dailyTodoSources", "ganttZoom",
] as const;
export const editableSettingKeySchema = z.enum(EDITABLE_SETTING_KEYS);
export type EditableSettingKey = z.infer<typeof editableSettingKeySchema>;
/** Public read allowlist. Management fields and secret values cannot be returned. */
export const publicSettingsSchema = z.object({
  taskFolder: idSchema, filenameUsesDatePrefix: z.boolean(), hideCompletedByDefault: z.boolean(),
  currentStatusRows: z.number().int().min(3), autoPriorityEnabled: z.boolean(),
  ganttManualHolidays: z.array(dateOnlySchema), ganttSpecialHolidays: z.array(dateOnlySchema), ganttNationalHolidays: z.array(dateOnlySchema),
  ganttFeatureDailyTodoEnabled: z.boolean(), ganttFeatureWorkloadEnabled: z.boolean(), ganttFeatureEventsEnabled: z.boolean(),
  ganttFeatureSyncEnabled: z.boolean(), ganttFeatureTagsEnabled: z.boolean(), incrementalGanttRender: z.boolean(),
  ganttShowTagsOnBars: z.boolean(), ganttShowParentTagsOnChildBars: z.boolean(), ganttShowTagsOnParents: z.boolean(),
  ganttSyncEnabled: z.boolean(), ganttSyncUrl: z.string().max(2000), ganttSyncIntervalMinutes: z.number().finite().min(1),
  ganttTags: z.array(namedDefinitionSchema), dailyTodoSources: z.array(sourceDefinitionSchema), ganttZoom: z.number().min(14).max(72),
  ganttWorkloadMaxHours: z.number().finite().positive(), ganttWorkloadDailyCapacityHours: z.number().finite().nonnegative(),
}).partial().strict();
export type PublicSettingsV1 = DeepReadonly<z.infer<typeof publicSettingsSchema>>;

export const taskFieldGroupSchema = z.enum(["identity", "status", "schedule", "derived", "priority", "tags", "content", "markers", "workload", "children"]);
export type TaskFieldGroup = z.infer<typeof taskFieldGroupSchema>;
const taskCommon = {
  id: idSchema, name: z.string().max(20000), revision: revisionSchema,
  status: statusSchema.optional(), completed: z.boolean().optional(),
  priority: z.object({ stored: z.number().min(0).max(5), effective: z.number().min(0).max(5), mode: z.enum(["auto", "manual"]) }).strict().optional(),
  tags: tagNamesSchema.optional(), content: z.object({ currentStatus: z.string(), notes: z.string(), createdAt: dateOnlySchema.nullable(), updatedAt: dateOnlySchema.nullable() }).strict().optional(),
};
/** Missing group = not fetched; null = fetched but unset; [] = fetched, zero items. */
export const compactTaskSchema = z.discriminatedUnion("kind", [
  z.object({ ...taskCommon, kind: z.literal("parent"), parentId: z.null(),
    due: dateOnlySchema.nullable().optional(),
    gantt: z.object({ enabled: z.boolean(), order: z.number().finite() }).strict().optional(),
    derived: z.object({ period: periodSchema, progress: z.number().min(0).max(1), effectivePriority: z.number().min(0).max(5) }).strict().optional(),
    children: z.array(idSchema).optional(),
  }).strict(),
  z.object({ ...taskCommon, kind: z.literal("subtask"), parentId: idSchema,
    schedule: z.object({ start: dateOnlySchema.nullable(), end: dateOnlySchema.nullable(), due: dateOnlySchema.nullable() }).strict().optional(),
    markers: z.array(markerStateSchema).optional(), hours: z.array(hoursCellSchema).optional(),
  }).strict(),
]);
export type CompactTaskV1 = DeepReadonly<z.infer<typeof compactTaskSchema>>;
export const pageInfoSchema = z.object({ totalMatched: countSchema, returned: countSchema, truncated: z.boolean(), nextCursor: idSchema.nullable() }).strict();
export type PageInfoV1 = DeepReadonly<z.infer<typeof pageInfoSchema>>;
export const taskReadSchema = z.object({
  kind: z.literal("tasks"), fieldsIncluded: z.array(taskFieldGroupSchema), items: z.array(compactTaskSchema), ...pageInfoSchema.shape,
}).strict().superRefine((page, ctx) => {
  if (page.returned !== page.items.length || page.returned > page.totalMatched) ctx.addIssue({ code: "custom", message: "件数がitemsと一致しません" });
  if (page.truncated !== (page.nextCursor !== null)) ctx.addIssue({ code: "custom", message: "省略には詳細取得cursorが必要です" });
  for (const item of page.items) {
    const fields: Partial<Record<TaskFieldGroup, readonly string[]>> = {
      identity: ["id", "kind", "parentId", "name", "revision"], status: ["status", "completed"],
      schedule: item.kind === "parent" ? ["due", "gantt"] : ["schedule"], priority: ["priority"],
      tags: ["tags"], content: ["content"], derived: item.kind === "parent" ? ["derived"] : [],
      children: item.kind === "parent" ? ["children"] : [], markers: item.kind === "subtask" ? ["markers"] : [],
      workload: item.kind === "subtask" ? ["hours"] : [],
    };
    for (const group of taskFieldGroupSchema.options) {
      for (const key of fields[group] ?? []) {
        const present = Object.prototype.hasOwnProperty.call(item, key);
        if (present !== page.fieldsIncluded.includes(group)) ctx.addIssue({ code: "custom", message: `取得groupとfieldが不一致: ${group}/${key}` });
      }
    }
  }
});
export type TaskReadV1 = DeepReadonly<z.infer<typeof taskReadSchema>>;
export const dailyItemSchema = dailyStateSchema.extend({ line: countSchema, itemFingerprint: revisionSchema, revision: revisionSchema }).strict();
export const dailySummarySchema = z.object({ date: dateOnlySchema, totalCount: countSchema, completedCount: countSchema, items: z.array(dailyItemSchema).optional() }).strict()
  .refine(({ completedCount, totalCount }) => completedCount <= totalCount, "完了件数は全件数以下");
export const dailyReadSchema = z.object({ kind: z.literal("daily"), days: z.array(dailySummarySchema), ...pageInfoSchema.shape }).strict();
export const calendarStateSchema = z.object({ weekends: z.array(z.number().int().min(0).max(6)), manual: z.array(dateOnlySchema), special: z.array(dateOnlySchema), national: z.array(dateOnlySchema) }).strict();
export const dailyAggregateSchema = z.object({ date: dateOnlySchema, plan: z.number().finite().nonnegative(), actual: z.number().finite().nonnegative(), capacity: z.number().finite().nonnegative(), overCapacity: z.boolean() }).strict();
export type DailyAggregateV1 = DeepReadonly<z.infer<typeof dailyAggregateSchema>>;
export const readPayloadSchema = z.discriminatedUnion("kind", [
  taskReadSchema, dailyReadSchema,
  z.object({ kind: z.literal("overview"), counts: z.object({ parents: countSchema, children: countSchema, unplaced: countSchema, completed: countSchema, parseFailures: countSchema }).strict(), settings: publicSettingsSchema, capabilities: z.array(capabilitySchema), summaryRevision: revisionSchema }).strict(),
  z.object({ kind: z.literal("project"), parent: compactTaskSchema.refine((task) => task.kind === "parent", "projectは親タスク"), children: taskReadSchema.optional(), derived: z.object({ period: periodSchema, progress: z.number().min(0).max(1) }).strict() }).strict(),
  z.object({ kind: z.literal("calendar"), from: dateOnlySchema, to: dateOnlySchema, revision: revisionSchema, calendar: calendarStateSchema }).strict(),
  z.object({ kind: z.literal("workload"), days: z.array(dailyAggregateSchema), contributions: z.array(workloadContributionSchema).optional() }).strict(),
  z.object({ kind: z.literal("settings"), sections: z.array(z.enum(["storage", "display", "calendar", "sources", "tags", "sync", "workload"])), values: publicSettingsSchema }).strict(),
  z.object({ kind: z.literal("changes"), sinceRevision: revisionSchema, added: z.array(compactTaskSchema), changed: z.array(compactTaskSchema), deletedIds: z.array(idSchema) }).strict(),
]);
export const readResultSchema = z.object({
  schemaVersion: z.literal(1), resultKind: z.literal("read"), today: dateOnlySchema, timezone: idSchema,
  snapshotRevision: revisionSchema, data: readPayloadSchema,
  errors: z.array(z.object({ code: z.enum(["NOT_FOUND", "PARSE_FAILED", "RESET_REQUIRED", "CURSOR_STALE"]), targetId: idSchema.optional(), detail: z.string(), nextAction: z.string().min(1).optional() }).strict()
    .refine((error) => !["CURSOR_STALE", "RESET_REQUIRED"].includes(error.code) || error.nextAction !== undefined, "失効時は再取得手順が必要")),
}).strict();
export type ReadResultV1 = DeepReadonly<z.infer<typeof readResultSchema>>;
export type TaskReadResultV1 = ReadResultV1 & { readonly data: TaskReadV1 };
export type DailyReadResultV1 = ReadResultV1 & { readonly data: DeepReadonly<z.infer<typeof dailyReadSchema>> };

export const operationErrorSchema = z.object({
  code: z.enum(["INVALID_INPUT", "KIND_MISMATCH", "NOT_FOUND", "REVISION_CONFLICT", "PLAN_EXPIRED", "PLAN_CONSUMED", "POLICY_DENIED", "BUSY_CONVERSATION", "UI_UNAVAILABLE", "PARTIAL", "RESET_REQUIRED", "CURSOR_STALE", "APP_NOT_RUNNING", "UNKNOWN_AFTER_RESTART"]),
  field: z.string().optional(), allowedKinds: z.array(z.string()).optional(), retryable: z.boolean(), nextAction: z.string().min(1),
}).strict();
export type OperationErrorV1 = DeepReadonly<z.infer<typeof operationErrorSchema>>;

/** These read queries are separate from, and do not increase, the 123-operation ledger. */
export const CONTEXT_QUERY_LIMITS = { defaultPageSize: 20, maxPageSize: 100, maxGetMany: 20, workloadDefaultDays: 31, workloadMaxDays: 366 } as const;
const queryRange = z.object({ from: dateOnlySchema, to: dateOnlySchema }).strict()
  .refine(({ from, to }) => from <= to, "日付範囲が逆転しています");
const queryScope = z.object({ parentIds: z.array(idSchema).max(100).optional() }).strict();
const queryFields = z.array(taskFieldGroupSchema).min(1).max(10);
const settingsSections = z.array(z.enum(["storage", "display", "calendar", "sources", "tags", "sync", "workload"])).min(1).max(7);
export const contextQueryInputSchemas = {
  "context.overview": z.object({ scope: queryScope.optional(), dateRange: queryRange.optional() }).strict(),
  "tasks.search": z.object({
    name: z.string().max(1000).optional(), text: z.string().max(1000).optional(), kind: z.enum(["parent", "subtask"]).optional(),
    parentId: idSchema.optional(), statuses: z.array(statusSchema).max(5).optional(), tags: tagNamesSchema.optional(),
    dueRange: queryRange.optional(), plannedRange: queryRange.optional(), placed: z.boolean().optional(), gantt: z.boolean().optional(),
    cursor: idSchema.optional(), limit: z.number().int().min(1).max(CONTEXT_QUERY_LIMITS.maxPageSize).default(CONTEXT_QUERY_LIMITS.defaultPageSize), fields: queryFields.optional(),
  }).strict(),
  "tasks.get-many": z.object({ taskIds: z.array(idSchema).min(1).max(CONTEXT_QUERY_LIMITS.maxGetMany), include: queryFields.optional() }).strict(),
  "projects.get": z.object({ parentTaskId: idSchema, includeChildren: z.boolean().default(false), cursor: idSchema.optional(), childFields: queryFields.optional(), limit: z.number().int().min(1).max(100).default(20) }).strict(),
  "calendar.get": queryRange,
  // Omitted range = evaluated today through +30 calendar days, inclusive, in the server timezone.
  "workload.get": z.object({ from: dateOnlySchema.optional(), to: dateOnlySchema.optional(), parentIds: z.array(idSchema).max(100).optional(), mode: z.enum(["plan", "actual", "both"]).default("both"), detail: z.boolean().default(false) }).strict()
    .refine(({ from, to }) => (!from && !to) || (!!from && !!to && from <= to && (Date.parse(to) - Date.parse(from)) / 86400000 < CONTEXT_QUERY_LIMITS.workloadMaxDays), "両端指定、最大366暦日"),
  "daily.get": z.object({ dateRange: queryRange, sourceKeys: z.array(idSchema).max(100).optional(), cursor: idSchema.optional(), includeItems: z.boolean().default(false), limit: z.number().int().min(1).max(100).default(20) }).strict(),
  "settings.get": z.object({ sections: settingsSections }).strict(),
  "context.changes": z.object({ sinceRevision: revisionSchema, scope: queryScope }).strict(),
} as const;
export type ContextQueryId = keyof typeof contextQueryInputSchemas;
export type ContextQueryMap = { [K in ContextQueryId]: DeepReadonly<z.input<(typeof contextQueryInputSchemas)[K]>> };
export const CONTEXT_QUERY_KINDS = {
  "context.overview": "overview", "tasks.search": "tasks", "tasks.get-many": "tasks", "projects.get": "project",
  "calendar.get": "calendar", "workload.get": "workload", "daily.get": "daily", "settings.get": "settings", "context.changes": "changes",
} as const satisfies Record<ContextQueryId, ReadResultV1["data"]["kind"]>;
export type ContextQueryOutputMap = { [K in ContextQueryId]: ReadResultV1 & { readonly data: Extract<ReadResultV1["data"], { readonly kind: (typeof CONTEXT_QUERY_KINDS)[K] }> } };
export type ContextQueryResult<K extends ContextQueryId> = { readonly status: "success"; readonly result: ContextQueryOutputMap[K] } | { readonly status: "error"; readonly error: OperationErrorV1 };
export const contextQueryOutputSchemas = Object.fromEntries(Object.keys(contextQueryInputSchemas).map((query) => {
  const kind = CONTEXT_QUERY_KINDS[query as ContextQueryId];
  return [query, z.discriminatedUnion("status", [
    z.object({ status: z.literal("success"), result: readResultSchema.refine((result) => result.data.kind === kind, "取得queryとDTOが不一致") }).strict(),
    z.object({ status: z.literal("error"), error: operationErrorSchema }).strict(),
  ])];
})) as unknown as { readonly [K in ContextQueryId]: z.ZodType<ContextQueryResult<K>> };
export const CONTEXT_CURSOR_RULES = {
  boundTo: ["query", "scope", "snapshotRevision", "order", "principalId", "vaultInstanceId"],
  CURSOR_STALE: "取得済みページを破棄し、同じqueryをcursorなしで先頭から再取得する。",
  RESET_REQUIRED: "古い差分を破棄し、context.overviewと対象の詳細を再取得して新しいsnapshotRevisionから再開する。",
} as const;
