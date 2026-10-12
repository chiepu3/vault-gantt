import { z } from "zod";
import type { OperationName, OperationPlan, TaskDiff } from "../app/operation-registry";
import { jsonSchema, markerStateSchema, type Json, type RequestOrigin } from "./context";
import { operationInputSchemas, type OperationId, type OperationInputMap } from "./operations";
import { fieldChangeSchema, operationPreviewSchema, type FieldChange, type PreviewEffect, type OperationPreviewV1 } from "./preview";

export const LEGACY_OPERATION_IDS = {
  search: ["T01"], get: ["T02"], create: ["T03", "T04"], update: ["T29"],
  "schedule-batch": ["T28"], "update-batch": ["T27"],
} as const satisfies Record<OperationName, readonly OperationId[]>;
export type OperationRequest = { [K in OperationId]: { readonly operationId: K; readonly input: OperationInputMap[K] } }[OperationId];

/** Pure compatibility bridge. Existing registry/SDK/ToolAdapter signatures remain untouched. */
export function adaptLegacyOperationInput(operation: OperationName, input: unknown): OperationRequest {
  if (operation === "create") {
    const parsed = z.object({ name: z.string(), parentTaskId: z.string().optional() }).strict().parse(input);
    return parsed.parentTaskId === undefined
      ? { operationId: "T03", input: operationInputSchemas.T03.parse(parsed) }
      : { operationId: "T04", input: operationInputSchemas.T04.parse(parsed) };
  }
  const id = LEGACY_OPERATION_IDS[operation][0];
  // The old registry treats an empty expectedRevision as no guard. Normalize only
  // this legacy boundary; new contracts still require a nonempty revision.
  const omitEmptyRevision = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    if (record.expectedRevision !== "") return value;
    const { expectedRevision: _empty, ...rest } = record;
    void _empty;
    return rest;
  };
  let normalized = operation === "update" ? omitEmptyRevision(input) : input;
  if ((operation === "schedule-batch" || operation === "update-batch") && typeof input === "object" && input !== null && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    if (Array.isArray(record.changes)) normalized = { ...record, changes: record.changes.map(omitEmptyRevision) };
  }
  return { operationId: id, input: operationInputSchemas[id].parse(normalized) } as OperationRequest;
}
export interface LegacyPlanMetadata {
  readonly vaultInstanceId: string;
  readonly origin: RequestOrigin;
  /** Use the actual registry plan lifetime; this adapter does not invent a new TTL. */
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly input: unknown;
  readonly undo?: OperationPreviewV1["undo"];
}

function requestedPatch(request: OperationRequest, taskId: string): Readonly<Record<string, unknown>> {
  if (request.operationId === "T29") return request.input.patch;
  if (request.operationId === "T27" || request.operationId === "T28") return request.input.changes.find((change) => change.taskId === taskId)?.patch ?? {};
  return {};
}
function period(value: { start: string; end: string }) { return { start: value.start || null, end: value.end || null }; }
function markerStates(value: Json) {
  if (value === "" || value === null) return [];
  return z.array(markerStateSchema.extend({ tags: markerStateSchema.shape.tags.default([]) })).parse(value);
}
function effectsForDiff(diff: TaskDiff, patch: Readonly<Record<string, unknown>>, warnings: { code: string; detail: string }[]): PreviewEffect[] {
  const fields: FieldChange[] = diff.fields.map((change) => fieldChangeSchema.parse({
    ...change, before: jsonSchema.parse(change.before), after: jsonSchema.parse(change.after),
    reason: change.field === "updatedAt" || !Object.prototype.hasOwnProperty.call(patch, change.field) ? "derived"
      : JSON.stringify(patch[change.field]) === JSON.stringify(change.after) ? "requested" : "normalized",
  }));
  const effects: PreviewEffect[] = fields.length ? [{ kind: "fields", fields }] : [];
  if (diff.schedule && fields.some((field) => field.field === "plannedStartDate" || field.field === "plannedEndDate")) {
    const before = period(diff.schedule.before), after = period(diff.schedule.after);
    if (before.start !== after.start || before.end !== after.end) effects.push({ kind: "schedule", before, after, unit: "calendar-day" });
  }
  for (const field of fields) {
    if (field.field === "dueDate") effects.push({ kind: "deadline", before: field.before === "" ? null : field.before as string | null, after: field.after === "" ? null : field.after as string | null });
    if (field.field === "ganttEnabled") effects.push({ kind: "membership", before: z.boolean().parse(field.before), after: z.boolean().parse(field.after), retained: ["schedule", "workload", "markers"] });
    if (field.field === "ganttMarkers") {
      const before = markerStates(field.before), after = markerStates(field.after);
      for (const key of new Set([...before, ...after].map((marker) => marker.key))) {
        const oldState = before.find((marker) => marker.key === key) ?? null, newState = after.find((marker) => marker.key === key) ?? null;
        if (JSON.stringify(oldState) !== JSON.stringify(newState)) effects.push({ kind: "marker", before: oldState, after: newState });
      }
    }
    // A legacy diff has no unchanged opposite-mode cells. Keep the complete field diff
    // instead of inventing zero actual/plan values in a workload descriptor.
    if (field.field === "workloadPlan" || field.field === "workloadActual") warnings.push({ code: "LEGACY_WORKLOAD_FIELDS_ONLY", detail: `${diff.taskId}: 反対modeの時間は旧planから取得できません。field差分を表示してください。` });
  }
  return effects;
}
export function adaptLegacyOperationPlan(plan: OperationPlan, metadata: LegacyPlanMetadata): OperationPreviewV1 {
  const request = adaptLegacyOperationInput(plan.operation, metadata.input);
  if (request.operationId === "T01" || request.operationId === "T02") throw new Error("Read results are not mutation previews");
  const warnings = [{ code: "LEGACY_PROJECTION_UNAVAILABLE", detail: "旧planには完全な投影・関連revisionがありません。再取得した状態を推測して補完しません。" }];
  const isCreate = request.operationId === "T03" || request.operationId === "T04";
  if (request.operationId === "T04") warnings.push({ code: "LEGACY_CREATED_CHILD_ID_UNAVAILABLE", detail: "旧planは新しい子IDを持ちません。entityは作成先の親ファイルを示します。" });
  return operationPreviewSchema.parse({
    schemaVersion: 1, previewId: plan.previewId, vaultInstanceId: metadata.vaultInstanceId,
    operationId: request.operationId, origin: metadata.origin, status: "pending", createdAt: metadata.createdAt, expiresAt: metadata.expiresAt,
    summary: { targetCount: plan.count, actionCount: plan.diffs.length },
    entries: plan.diffs.map((diff, index) => ({
      actionId: `${plan.previewId}:${index}`, entity: { kind: "task", taskId: diff.taskId }, displayName: diff.name,
      effects: isCreate ? [{ kind: "presence", action: "create", before: null, after: jsonSchema.parse({ name: diff.name }) }]
        : effectsForDiff(diff, requestedPatch(request, diff.taskId), warnings),
    })),
    warnings, undo: metadata.undo ?? { support: "none", reason: "旧planにはUndo可否がありません。実行系から取得してください。" }, projection: null,
  });
}
