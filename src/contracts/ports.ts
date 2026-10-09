import { z } from "zod";
import { idSchema, revisionSchema, type DeepReadonly, type RequestContext, type OperationErrorV1, type ContextQueryId, type ContextQueryMap, type ContextQueryResult } from "./context";
import type {
  OperationId, ReadOperationId, ViewOperationId, WriteOperationId,
  OperationInputMap, OperationOutputMap, OperationDefinition, ExternalRequestOperationId,
} from "./operations";
import type { OperationPreviewV1, OperationOutcomeV1, OperationRequestResultV1, PreviewEffect, ProjectionPageRequestV1, ProjectionPageResultV1 } from "./preview";

/** Cursor is bound to the authenticated Vault/principal, preview and frozen projection.
 * A stale revision/date/TZ, expired preview or wrong cursor produces an explicit error;
 * the server must not silently recompute a later page from live state.
 */
export interface ProjectionDetailPort {
  getProjectionPage(request: ProjectionPageRequestV1): Promise<ProjectionPageResultV1>;
}
export interface PreviewPort extends ProjectionDetailPort {
  list(): readonly OperationPreviewV1[];
  inspect(previewId: string): OperationPreviewV1 | undefined;
  /** Subscribers need to read the focus shared by cards and Gantt views. */
  focusedPreviewId(): string | null;
  /** Outcomes have passed validatePreviewOutcome and carry actualProjection for other views. */
  inspectOutcome(previewId: string): OperationOutcomeV1 | undefined;
  subscribe(listener: () => void): () => void;
  focus(previewId: string | null): void;
  reject(previewId: string): Promise<void>;
  requestRepreview(previewId: string): Promise<OperationPreviewV1>;
}
/** Only passed to Obsidian human UI. SDK/MCP consumers receive no approval port. */
export interface HumanApprovalPort {
  /** Validate against the entire stored preview before publishing; never drop unattempted actions. */
  approve(previewId: string): Promise<OperationOutcomeV1>;
}
export const historyEntryUndoStateSchema = z.object({
  entryId: idSchema, historyRevision: revisionSchema,
  state: z.enum(["available", "not-latest", "conflict", "invalidated", "missing", "busy", "already-undone"]), reason: z.string().nullable(),
}).strict();
export type HistoryEntryUndoStateV1 = DeepReadonly<z.infer<typeof historyEntryUndoStateSchema>>;
export const historyChangeSchema = z.object({ historyRevision: revisionSchema, changedEntryIds: z.array(idSchema).nullable() }).strict();
export type HistoryChangeV1 = DeepReadonly<z.infer<typeof historyChangeSchema>>;
/** Live entry-specific eligibility, separate from the static preview.undo support.
 * Notifications cover push/undo/redo, barriers, eviction and external content conflicts;
 * null changedEntryIds means all entries. Apply still rechecks content immediately.
 */
export interface HistoryPort {
  inspectUndo(entryId: string): HistoryEntryUndoStateV1;
  subscribe(listener: (change: HistoryChangeV1) => void): () => void;
}
export interface ContextReadPort {
  query<K extends ContextQueryId>(id: K, input: ContextQueryMap[K], context: RequestContext): Promise<ContextQueryResult<K>>;
}
export interface ViewStateV1 {
  readonly viewId: string;
  readonly kind: "workbench" | "gantt" | "chat" | "approval";
  readonly filterText: string;
  readonly statusFilter: "all" | "active" | "in_progress" | "waiting" | "hold" | "done";
  readonly showCompleted: boolean;
  readonly tagNames: readonly string[];
  readonly dayWidth?: number;
}
/** Obsidian's direct human UI only. Never pass this port to MCP, Chat SDK or transport code.
 * V14 may persist ganttZoom here; external requests use OperationService and are denied.
 */
export interface UiPort {
  listViews(): readonly ViewStateV1[];
  inspectView(viewId: string): ViewStateV1 | undefined;
  request<K extends ViewOperationId>(id: K, input: OperationInputMap[K]): Promise<OperationOutputMap[K]>;
  requestApproval(previewId: string): Promise<OperationRequestResultV1>;
}
/** Track 2 extends its existing UI hosts with these additional ports. */
export interface PreviewUiHostPorts {
  readonly previewPort: PreviewPort;
  readonly humanApprovalPort: HumanApprovalPort;
  readonly uiPort: UiPort;
  readonly historyPort: HistoryPort;
}
export type PublicOperationDescription = {
  [K in OperationId]: Pick<OperationDefinition<K>, "id" | "classification" | "capabilities" | "requestPolicy" | "previewKinds" | "description">
    & { readonly available: boolean; readonly denial?: OperationErrorV1 };
}[OperationId];
/** No commit/approve method is exposed to model or transport adapters. */
export interface OperationService {
  describe(ids?: readonly OperationId[]): readonly PublicOperationDescription[];
  read<K extends ReadOperationId>(id: K, input: OperationInputMap[K], context: RequestContext): Promise<OperationOutputMap[K]>;
  propose<K extends WriteOperationId>(id: K, input: OperationInputMap[K], context: RequestContext): Promise<OperationPreviewV1>;
  request<K extends ExternalRequestOperationId>(id: K, input: OperationInputMap[K], context: RequestContext): Promise<OperationOutputMap[K]>;
  inspect(previewId: string, context: RequestContext): OperationPreviewV1;
}
// Signatures for future handlers; P0 provides no implementations or registration.
export type ReadHandler<K extends ReadOperationId> = (input: OperationInputMap[K], context: RequestContext) => Promise<OperationOutputMap[K]>;
export type PlanHandler<K extends WriteOperationId> = (input: OperationInputMap[K], context: RequestContext) => Promise<OperationPreviewV1>;
export type ActualEffects = readonly PreviewEffect[];
