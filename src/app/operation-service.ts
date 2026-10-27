import type { UiPort, OperationService as OperationServicePort } from "../contracts/ports";
import type { OperationId, OperationInputMap, OperationOutputMap, ReadOperationId, WriteOperationId, ExternalRequestOperationId } from "../contracts/operations";
import { operationInputSchemas, operationOutputSchemas, operationRequestDenial } from "../contracts/operations";
import type { RequestContext } from "../contracts/context";
import { operationPreviewSchema, validatePreviewOutcome, type OperationPreviewV1, type OperationOutcomeV1, type PreviewEntry } from "../contracts/preview";
import { adaptLegacyOperationInput } from "../contracts/legacy-operation-plan";
import { applyPatchToRow } from "../core/task-patch";
import { generateTaskId } from "../core/ids";
import { replaceSections, splitFrontmatter } from "../core/note-v2";
import { applyStoredOrder, computeParentOrder, orderValue } from "../core/parent-order";
import { todayStr, buildFileRevision } from "../core/utils";
import type { TaskRow, TaskWorkbenchSettings } from "../core/types";
import { collectTaskIds, getAvailableSubtaskPath, getAvailableTaskPath, newNoteText, newParentRow, newSubtaskRow, type VaultAdapter } from "./task-operations";
import { applyNoteChange, byApplyOrder, diffTasks, flattenApplied, mergeApplied, NoteConflictError, roundTripRow, type AppliedNote, type NoteChange } from "./note-changes";
import { HistoryManager } from "./history-manager";
import { OperationCatalog, IMPLEMENTED_OPERATION_IDS } from "./operation-catalog";
import { ContextIndex } from "./context-index";
import { ApprovalService } from "./approval-service";
import { PreviewStore } from "./preview-store";
import { project, taskEffects, taskPublicState } from "./preview-projector";
import { OperationFailure, canonical, checkRevision, contentRevision, fail, findTask, flatten, type TaskChange, type TaskSnapshot } from "./operations/runtime";
import { taskChanges } from "./operations/task-handlers";
import { scheduleChanges } from "./operations/schedule-handlers";
import { markerWorkloadChanges } from "./operations/marker-workload-handlers";
import { eventWeeklyPlan } from "./operations/event-weekly-handlers";
import { settingsPlan } from "./operations/settings-handlers";
import { holidaySet } from "./gantt-actions";
import { snapForward, hasWorkloadActual } from "./gantt-drag";
import { taskData, OPERATION_MANIFEST } from "./operation-registry";
import type { OperationRegistry, OperationName, OperationPlan, OperationResult, TaskDiff, FieldDiff } from "./operation-registry";

import { DailyReadHandler, dailyPlan, dailyProjection, executeDailyPlan, type DailyPlan, type DailyWriteId } from "./operations/daily-handlers";
import { viewRequest, diagnosticRequest, historyPlan, executeHistoryPlan, diagnosticPlan, executeDiagnosticPlan, type HistoryPlan, type DiagnosticPlan, type ViewRequestId } from "./operations/view-handlers";
import { controlRequest, type ControlId } from "./operations/control-handlers";
import { integrationPlan, executeExternalSend, INTEGRATION_OPERATION_IDS, type IntegrationPlan, type IntegrationPlanHost, type IntegrationId } from "./operations/integration-handlers";
import { worklogPlan } from "./operations/worklog-handlers";
import { priorityPlan } from "./operations/priority-handlers";
import type { ChatSession } from "../ai/chat-session";
import type { Logger } from "../core/logger";

/** `change` is set for task notes (applied key by key); daily and diagnostic writes carry their full text in `after`. */
interface WriteUnit { path: string; before: string | null; after: string | null; afterPath?: string; change?: NoteChange; taskId?: string; actionIds: string[] }
const rowOf = (parents: readonly TaskRow[], taskId: string): TaskRow => flatten(parents).find((row) => row.id === taskId)!;
/** What a note keeps of a row; marker keys are derived when reading, so they do not take part. */
const stateOf = (row: TaskRow): string => canonical({ ...taskPublicState(row), ganttOrder: null, priority: row.priorityMode === "manual" ? row.priority : null, ganttMarkers: (row.ganttMarkers ?? []).map((marker) => ({ title: marker.title, date: marker.date, tags: marker.tags ?? [] })),
  // Milestone keys are derived from titles when a note is read, so only title/date/tags must survive the round trip.
  milestones: (taskPublicState(row).milestones as { title: string; date: string; tags: string[] }[]).map(({ title, date, tags }) => ({ title, date, tags })) });
interface StoredPlan { copyFrom?: string; preview: OperationPreviewV1; input: unknown; context: RequestContext; snapshot: TaskSnapshot; afterParents: TaskRow[]; afterSettings: TaskWorkbenchSettings; writes: WriteUnit[]; settingKeys: (keyof TaskWorkbenchSettings)[]; changes: TaskChange[]; noopActions: string[]; daily?: DailyPlan; history?: HistoryPlan; diagnostic?: DiagnosticPlan; integration?: IntegrationPlan }
/** Entries compared by meaning: generated identifiers (new event keys, task ids, paths, revisions) and action ids are ignored. */
const GENERATED_KEYS = new Set(["key", "id", "taskId", "eventKey", "scheduleKey", "path", "revision", "actionId", "createdAt", "updatedAt"]);
const equivalentEntries = (a: OperationPreviewV1, b: OperationPreviewV1): boolean => {
  const norm = (preview: OperationPreviewV1) => canonical(preview.entries.map((entry) => {
    const creates = entry.effects.some((effect) => effect.kind === "presence" && (effect.action === "create" || effect.action === "duplicate"));
    return JSON.parse(JSON.stringify(entry, (key, value) => key === "actionId" || (creates && GENERATED_KEYS.has(key)) ? undefined : value));
  }));
  return norm(a) === norm(b);
};
export interface OperationServiceHost {
  readonly settings: TaskWorkbenchSettings;
  readonly historyManager: HistoryManager;
  readonly coordinator: Pick<OperationRegistry, "coordinate">;
  /** Persist the candidate copy. Live settings are published only after success. No timers/network here. */
  persistSettings?(candidate: TaskWorkbenchSettings, keys: readonly (keyof TaskWorkbenchSettings)[]): Promise<void>;
  /** The host publishes live settings with its own UI generation guards. */
  readonly publishesSettings?: boolean;
  readonly ui?: UiPort;
  readonly chatSession?: ChatSession;
  readonly logger?: Logger;
  readonly integration?: IntegrationPlanHost;
  sendExternal?(destination: string, body: string): Promise<void>;
  restartSync?(): void;
  requestApproval?(previewId: string): Promise<void>;
  /** `paths`: only these task files changed (no settings); omit to drop every cached task. */
  invalidate(paths?: readonly string[]): void | Promise<void>;
}
export class OperationService implements OperationServicePort {
  readonly catalog = new OperationCatalog();
  readonly contextPort: ContextIndex;
  readonly previewPort: PreviewStore;
  readonly humanApprovalPort: ApprovalService;
  private readonly pending = new Map<string, StoredPlan>();
  private readonly stored = new Map<string, StoredPlan>();
  private readonly intents = new Map<string, { binding: string; previewId: string }>();
  private readonly planningIntents = new Map<string, { binding: string; promise: Promise<OperationPreviewV1> }>();
  private readonly dailyReader = new DailyReadHandler();
  private counter = 0;
  private disposed = false;
  private readonly lifecycle = new AbortController();
  private readonly ownWrites = new Map<string, { content?: string | null; until: number }>();
  private projectionChangeGeneration = 0;
  constructor(private readonly host: OperationServiceHost, private readonly vaultFactory: () => VaultAdapter, readonly vaultInstanceId: string) {
    this.contextPort = new ContextIndex(vaultFactory, () => host.settings, vaultInstanceId);
    this.previewPort = new PreviewStore({ reject: (id) => this.pending.delete(id), repreview: (id) => this.repreview(id) });
    this.humanApprovalPort = new ApprovalService((id) => this.executeApproved(id), (id) => this.previewPort.inspectOutcome(id));
  }
  async invalidatePreviews(): Promise<void> {
    if (this.disposed || !this.pending.size) return;
    const snapshot = await this.contextPort.snapshot();
    for (const [id, plan] of [...this.pending]) {
      if (plan.snapshot.revision === snapshot.revision) continue;
      const next = await this.rebase(id, plan, snapshot);
      if (this.pending.get(id) !== plan) continue;
      if (next) { this.pending.set(id, next); this.stored.set(id, next); this.previewPort.replace(id, next.preview); }
      else { this.pending.delete(id); this.previewPort.setStatus(id, "stale"); }
    }
  }
  /** Re-plans a preview against newer data (e.g. after a sibling proposal was applied); undefined when its effects would differ, i.e. it genuinely conflicts. Keeps the previewId. */
  private async rebase(id: string, plan: StoredPlan, fresh: TaskSnapshot): Promise<StoredPlan | undefined> {
    if (this.disposed || todayStr() !== plan.snapshot.today || (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC") !== plan.snapshot.timezone) return undefined;
    // Settings the plan does not write (calendar, tags, ...) changing underneath is not something to merge silently; the parent order follows other plans.
    const own = new Set<string>([...plan.settingKeys, "ganttParentOrder"]);
    if ((Object.keys(fresh.settings) as (keyof TaskWorkbenchSettings)[]).some((key) => !own.has(key) && canonical(fresh.settings[key]) !== canonical(plan.snapshot.settings[key]))) return undefined;
    // A note this plan writes must still be exactly what it was planned against (an edit to it is never merged blindly).
    if (plan.writes.some((write) => write.before === null ? fresh.contents.has(write.path) : fresh.contents.get(write.path) !== write.before)) return undefined;
    const { expectedRevision: _revision, ...input } = structuredClone(plan.input) as Record<string, unknown>; void _revision;
    if (Array.isArray(input.changes)) input.changes = (input.changes as Record<string, unknown>[]).map(({ expectedRevision: _expected, ...change }) => { void _expected; return change; });
    try {
      const next = await this.planProposal(plan.preview.operationId as WriteOperationId, input as OperationInputMap[WriteOperationId], plan.context, plan.copyFrom, id);
      return equivalentEntries(plan.preview, next.preview) ? { ...next, input: plan.input } : undefined;
    } catch { return undefined; }
  }
  clearSavedProjection(): void {
    this.projectionChangeGeneration++;
    this.clearSavedProjectionFocus();
  }
  private clearSavedProjectionFocus(): void {
    this.ownWrites.clear();
    const id = this.previewPort.focusedPreviewId();
    if (id && this.previewPort.inspectOutcome(id)) this.previewPort.focus(null);
  }
  async handleVaultChange(path: string, kind: "modify" | "create" | "delete" | "rename"): Promise<void> {
    const own = this.ownWrites.get(path);
    const vault = this.vaultFactory(), file = vault.getFileByPath(path);
    if (own && own.until > Date.now() && file && (kind === "modify" || kind === "create")) {
      try { if (own.content === undefined || await vault.read(file) === own.content) return; } catch { /* Treat unreadable bytes as an external change. */ }
    }
    this.clearSavedProjection();
    // A plain content edit of a note the context index never reads cannot change any pending preview's snapshot.
    if (kind === "modify" && !this.contextPort.covers(path)) return;
    await this.invalidatePreviews();
  }
  describe(ids?: readonly OperationId[]) { return this.catalog.describe(ids).map((description) => !IMPLEMENTED_OPERATION_IDS.has(description.id) || this.available(description.id) ? description : { ...description, available: false, denial: { code: "POLICY_DENIED" as const, retryable: false, nextAction: "この操作に必要な実行portが未接続です。人間用UIから操作してください。" } }); }
  private available(id: OperationId): boolean {
    if (!IMPLEMENTED_OPERATION_IDS.has(id)) return false;
    if ((id.startsWith("E") || id.startsWith("W") || id.startsWith("S") || id === "T30") && !this.host.persistSettings) return false;
    if (id === "S08") return !!this.host.integration?.fetchNationalHolidays;
    if (id === "S35") return !!this.host.integration?.detectDailyNoteSettings;
    if (["S18", "S19", "S20", "S21"].includes(id)) return !!this.host.sendExternal && !!this.host.restartSync && !!this.host.integration;
    if (id === "V22" || id === "V23") return !!this.host.logger;
    if (["Q01", "Q02", "Q03", "Q04", "Q05", "Q06"].includes(id)) return !!this.host.chatSession;
    if (this.catalog.get(id).classification === "view") return !!this.host.ui;
    return true;
  }
  private guard(id: OperationId, input: unknown, context: RequestContext): void {
    if (this.disposed || context.vaultInstanceId !== this.vaultInstanceId) fail("POLICY_DENIED", "稼働中の同じVaultに接続してください。");
    if (!this.available(id)) fail("POLICY_DENIED", `${id}は未実装またはport未接続です。既存UIを使用してください。`);
    const definition = this.catalog.get(id), denial = operationRequestDenial(id, context.origin);
    if (denial) fail(denial.code, denial.nextAction);
    if (!definition.capabilities.every((capability) => context.capabilities.includes(capability))) fail("POLICY_DENIED", "この操作に必要なcapabilityがありません。");
    if (context.signal?.aborted) fail("POLICY_DENIED", "要求は停止済みです。");
    const parsed = operationInputSchemas[id].safeParse(input);
    if (!parsed.success) fail("INVALID_INPUT", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  }
  async read<K extends ReadOperationId>(id: K, input: OperationInputMap[K], context: RequestContext): Promise<OperationOutputMap[K]> {
    this.guard(id, input, context);
    if (this.catalog.get(id).classification !== "read") fail("INVALID_INPUT", "read操作IDを指定してください。");
    const parsed = operationInputSchemas[id].parse(input);
    if (id === "D01") return await this.dailyReader.read(parsed as OperationInputMap["D01"], context, await this.contextPort.snapshot(), this.vaultFactory()) as OperationOutputMap[K];
    const result = id === "T01" ? await this.contextPort.query("tasks.search", { name: (parsed as OperationInputMap["T01"]).query, cursor: (parsed as OperationInputMap["T01"]).cursor, limit: (parsed as OperationInputMap["T01"]).limit }, context)
      : await this.contextPort.query("tasks.get-many", { taskIds: [(parsed as OperationInputMap["T02"]).taskId], include: ["identity", ...(parsed as OperationInputMap["T02"]).include ?? ["status", "schedule", "priority", "tags"]] }, context);
    if (result.status === "error") fail(result.error.code, result.error.nextAction);
    if (id === "T02" && result.result.data.kind === "tasks" && !result.result.data.items.length) fail("NOT_FOUND", "taskIdを検索し直してください。");
    return operationOutputSchemas[id].parse(result.result);
  }
  async propose<K extends WriteOperationId>(id: K, input: OperationInputMap[K], context: RequestContext): Promise<OperationPreviewV1> {
    return this.proposeBound(id, input, context);
  }
  /** Compose a same-parent copy into one T04 creation preview, with ordinary approval/preconditions. */
  async proposeTaskCopy(subtaskId: string, name: string, context: RequestContext): Promise<OperationPreviewV1> {
    operationInputSchemas.T02.parse({ taskId: subtaskId });
    const parentTaskId = findTask(await this.contextPort.snapshot(), subtaskId, "subtask").parentId ?? "";
    return this.proposeBound("T04", { parentTaskId, name }, context, subtaskId);
  }
  private async proposeBound<K extends WriteOperationId>(id: K, input: OperationInputMap[K], context: RequestContext, copyFrom?: string): Promise<OperationPreviewV1> {
    this.guard(id, input, context);
    if (!context.callerIntentId) return this.createProposal(id, input, context, copyFrom);
    const key = canonical([context.vaultInstanceId, context.principalId, context.callerIntentId]);
    const binding = canonical({ id, input: operationInputSchemas[id].parse(input), ...(copyFrom ? { copyFrom } : {}) });
    const active = this.planningIntents.get(key);
    if (active) { if (active.binding !== binding) fail("POLICY_DENIED", "同じcallerIntentIdで別の操作を送信しないでください。"); return active.promise; }
    const promise = this.createProposal(id, input, context, copyFrom);
    this.planningIntents.set(key, { binding, promise });
    void promise.finally(() => this.planningIntents.delete(key)).catch(() => undefined);
    return promise;
  }
  private async createProposal<K extends WriteOperationId>(id: K, input: OperationInputMap[K], context: RequestContext, copyFrom?: string): Promise<OperationPreviewV1> {
    this.guard(id, input, context);
    if (this.catalog.get(id).classification !== "write") fail("INVALID_INPUT", "write操作IDを指定してください。");
    const parsed = operationInputSchemas[id].parse(input) as OperationInputMap[K];
    const intentKey = context.callerIntentId ? canonical([context.vaultInstanceId, context.principalId, context.callerIntentId]) : undefined;
    const binding = canonical({ id, input: parsed, ...(copyFrom ? { copyFrom } : {}) });
    if (intentKey) {
      const previous = this.intents.get(intentKey);
      if (previous) {
        if (previous.binding !== binding) fail("POLICY_DENIED", "同じcallerIntentIdで別の操作を送信しないでください。");
        const preview = this.previewPort.inspect(previous.previewId);
        if (!preview) fail("PLAN_CONSUMED", "receipt保持期間を超えました。対象を再取得し、盲目的に再送しないでください。");
        return preview;
      }
    }
    const previewId = `preview-${this.vaultInstanceId}-${++this.counter}`;
    const stored = await this.planProposal(id, parsed, context, copyFrom, previewId);
    const preview = stored.preview;
    while (this.pending.size >= 50) { const oldest = this.pending.keys().next().value!; this.pending.delete(oldest); this.previewPort.setStatus(oldest, "expired"); }
    this.pending.set(previewId, stored); this.stored.set(previewId, stored);
    while (this.stored.size > 100) this.stored.delete(this.stored.keys().next().value!);
    if (intentKey) { this.intents.set(intentKey, { binding, previewId }); while (this.intents.size > 100) this.intents.delete(this.intents.keys().next().value!); }
    this.previewPort.put(preview);
    return structuredClone(preview);
  }
  /** Plans `id` against the current snapshot without registering anything; the caller decides what to do with the result. */
  private async planProposal<K extends WriteOperationId>(id: K, parsed: OperationInputMap[K], context: RequestContext, copyFrom: string | undefined, previewId: string): Promise<StoredPlan> {
    const snapshot = await this.contextPort.snapshot();
    const parseSettings = { ...snapshot.settings, autoPriorityEnabled: false };
    let afterParents = structuredClone(snapshot.parents);
    let afterSettings = structuredClone(snapshot.settings);
    let entries: PreviewEntry[] = [], changes: TaskChange[] = [], settingKeys: (keyof TaskWorkbenchSettings)[] = [];
    const warnings: OperationPreviewV1["warnings"][number][] = [];
    const vault = this.vaultFactory();
    let daily: DailyPlan | undefined, historyPlanData: HistoryPlan | undefined, diagnostic: DiagnosticPlan | undefined, integration: IntegrationPlan | undefined;
    const assignEntries = (rows: Omit<PreviewEntry, "actionId">[]) => rows.map((entry, index) => ({ ...entry, actionId: `${previewId}:${index}` }));
    if (id.startsWith("D")) {
      daily = await dailyPlan(id as DailyWriteId, parsed as OperationInputMap[DailyWriteId], snapshot, vault);
      entries = assignEntries(daily.entries); warnings.push(...daily.warnings);
    } else if (id === "V20" || id === "V21") {
      historyPlanData = await historyPlan(id, parsed as OperationInputMap["V20"], snapshot, this.host.historyManager);
      daily = historyPlanData.daily;
      afterParents = historyPlanData.afterParents; entries = assignEntries(historyPlanData.entries);
    } else if (id === "V23") {
      diagnostic = diagnosticPlan(parsed as OperationInputMap["V23"], this.host.logger!); entries = assignEntries(diagnostic.entries);
    } else if (id === "T31") {
      const plan = await worklogPlan(parsed as OperationInputMap["T31"], snapshot, vault);
      afterParents = plan.afterParents; afterSettings = plan.afterSettings; settingKeys = plan.settingKeys; entries = assignEntries(plan.entries);
    } else if (id === "T30" || id === "S05") {
      const plan = priorityPlan(id, parsed as OperationInputMap["T30"] | OperationInputMap["S05"], snapshot);
      afterParents = plan.parents; afterSettings = plan.settings; settingKeys = plan.keys; entries = assignEntries(plan.entries);
    } else if ((INTEGRATION_OPERATION_IDS as readonly string[]).includes(id)) {
      integration = await integrationPlan(id as IntegrationId, parsed as OperationInputMap[IntegrationId], snapshot, this.host.integration ?? { pluginVersion: "unknown" });
      afterSettings = integration.settings; settingKeys = integration.keys; changes = integration.changes; warnings.push(...integration.warnings);
      for (const change of changes) {
        applyPatchToRow(rowOf(afterParents, change.taskId), change.patch, afterSettings);
      }
      if (id === "S08" && integration.entries.length) integration.entries[0] = { ...integration.entries[0], effects: [...integration.entries[0].effects, { kind: "service-state", fields: (["ganttNationalHolidays", "ganttNationalHolidaysUpdatedAt", "ganttHolidays"] as const).map((key) => ({ field: key, before: snapshot.settings[key] as import("../contracts/context").Json, after: afterSettings[key] as import("../contracts/context").Json, reason: "normalized" })) }] };
      entries = assignEntries(integration.entries);
    } else if (id.startsWith("E") || id.startsWith("W") || id.startsWith("S")) {
      const plan = id.startsWith("S") ? settingsPlan(id, parsed, snapshot) : eventWeeklyPlan(id, parsed, snapshot);
      afterSettings = plan.settings; settingKeys = [...plan.keys]; entries = plan.entries.map((entry, index) => ({ ...entry, actionId: `${previewId}:${index}` }));
      if (id === "S23" || id === "S26") warnings.push({ code: "TAG_REFERENCES_RETAINED", detail: "既存タスク・マーカーのタグ名参照は変更しません。" });
      if (id === "S34" && !afterSettings.dailyTodoSources.some((source) => source.key === "main")) warnings.push({ code: "MAIN_SOURCE_MISSING", detail: "mainが存在しなくなるため、新規Daily追加はできません。" });
    } else if (["T03", "T04", "T05", "T06"].includes(id)) {
      const args = parsed as OperationInputMap["T03"] & OperationInputMap["T04"] & OperationInputMap["T06"];
      const parentId = id === "T04" ? args.parentTaskId : id === "T06" ? args.parentId : undefined;
      const parent = parentId ? findTask(snapshot, parentId, "parent") : undefined;
      if (parent) { checkRevision(snapshot, parent, args.expectedRevision); }
      const used = collectTaskIds(vault, snapshot.settings), today = snapshot.today || todayStr(), name = args.name.trim();
      let created: TaskRow;
      if (parent) {
        const copy = afterParents.find((row) => row.id === parent.id)!;
        const date = id === "T06" ? snapForward(args.date, holidaySet(snapshot.settings)) : undefined;
        created = newSubtaskRow(generateTaskId("subtask", used), getAvailableSubtaskPath(vault, copy.file.path, name), copy, name, date ? { plannedStartDate: date, plannedEndDate: date } : undefined, today);
        if (copyFrom) {
          const source = findTask(snapshot, copyFrom, "subtask");
          if (source.parentId !== parent.id) fail("KIND_MISMATCH", "同じ親の子タスクだけを複製できます。");
          created = { ...structuredClone(source), id: created.id, key: created.id, parentId: parent.id, file: created.file, title: created.title, displayName: created.displayName, createdAt: today, updatedAt: today };
        }
        copy.subtasks!.set(created.id, created);
        const reparsed = roundTripRow(created, parseSettings);
        if (copyFrom && (!reparsed || stateOf(reparsed) !== stateOf(created))) fail("INVALID_INPUT", "複製内容を安全に保存できません。元タスクの内容を確認してください。");
      } else {
        created = newParentRow(generateTaskId("parent", used), getAvailableTaskPath(vault, snapshot.settings, name, today), name, today);
        if (id === "T05") { created.ganttEnabled = true;
          // The new parent goes to the end of the stored order (not written to the note).
          afterSettings.ganttParentOrder = [...(afterSettings.ganttParentOrder ?? []), created.id]; settingKeys = ["ganttParentOrder"]; created.ganttOrder = orderValue(afterSettings.ganttParentOrder.length - 1); }
        afterParents.push(created);
      }
      if (created.displayName !== name) fail("INVALID_INPUT", "作成名を安全に保存できません。見出し・記号を確認してください。");
      entries = [{ actionId: `${previewId}:0`, entity: { kind: "task", taskId: created.id, ...(parent ? { parentId: parent.id } : {}) }, displayName: created.displayName, effects: taskEffects(undefined, created) }];
    } else if (id === "T26") {
      const args = parsed as OperationInputMap["T26"], child = findTask(snapshot, args.subtaskId, "subtask");
      checkRevision(snapshot, child, args.expectedRevision);
      const parent = findTask(snapshot, child.parentId ?? "", "parent");
      afterParents.find((row) => row.id === parent.id)!.subtasks!.delete(child.id);
      entries = [{ actionId: `${previewId}:0`, entity: { kind: "task", taskId: child.id, parentId: parent.id }, displayName: child.displayName, effects: taskEffects(child, undefined) }];
    } else {
      changes = id.startsWith("M") ? markerWorkloadChanges(id, parsed, snapshot) : id >= "T19" && id <= "T25" ? scheduleChanges(id, parsed, snapshot) : taskChanges(id, parsed, snapshot);
      const changedIds = new Set<string>();
      const orderTargets = new Map<string, number>();
      for (const change of changes) {
        const before = findTask(snapshot, change.taskId); checkRevision(snapshot, before, change.expectedRevision);
        const target = rowOf(afterParents, before.id);
        changedIds.add(before.id);
        // ganttOrder is kept in settings.ganttParentOrder, not in the note: order-only changes never touch the note.
        const { ganttOrder, ...notePatch } = change.patch as Record<string, unknown>;
        if (before.kind === "parent" && ganttOrder !== undefined) {
          orderTargets.set(before.id, Number(ganttOrder));
          if (Object.keys(notePatch).length) applyPatchToRow(target, notePatch as typeof change.patch, snapshot.settings);
        } else applyPatchToRow(target, change.patch, snapshot.settings);
        if (["T20", "T21", "T22", "T25"].includes(id) && hasWorkloadActual(before)) warnings.push({ code: "HAS_ACTUAL_WORKLOAD", detail: `${before.id}: 実績があります。${id === "T25" ? "実績mapも移動します。" : "実績mapは移動しません。"}` });
      }
      if (orderTargets.size) {
        const order = computeParentOrder(afterSettings.ganttParentOrder ?? [], orderTargets);
        if (JSON.stringify(order) !== JSON.stringify(afterSettings.ganttParentOrder ?? [])) { afterSettings.ganttParentOrder = order; settingKeys = ["ganttParentOrder"]; }
        applyStoredOrder(afterSettings, afterParents);
      }
      // Validate every changed note against what the format can hold.
      for (const taskId of changedIds) {
        const row = rowOf(afterParents, taskId), reparsed = roundTripRow(row, parseSettings);
        if (!reparsed || stateOf(row) !== stateOf(reparsed)) fail("INVALID_INPUT", "正規化後の内容を安全に保存できません。入力の記号・見出しを確認してください。");
      }
      entries = changes.map((change, index) => { const before = findTask(snapshot, change.taskId), after = flatten(afterParents).find((row) => row.id === change.taskId)!;
        return { actionId: `${previewId}:${index}`, entity: { kind: "task" as const, taskId: before.id, ...(before.kind === "subtask" ? { parentId: before.parentId } : {}) }, displayName: after.displayName,
          effects: taskEffects(before, after, change.patch as Record<string, unknown>) };
      });
    }
    const writes: WriteUnit[] = [], noopActions: string[] = [];
    applyStoredOrder(afterSettings, afterParents);
    if (historyPlanData) for (const write of historyPlanData.writes.filter((write) => !historyPlanData!.daily?.writes.some((other) => other.path === write.path))) writes.push({ ...write, actionIds: entries.filter((entry) => entry.entity.kind === "task" && entry.entity.taskId === write.taskId).map((entry) => entry.actionId) });
    else if (!daily && !diagnostic) {
      const changes = diffTasks(snapshot.parents, afterParents, (row, parent) => newNoteText(vault, row, parent));
      for (const change of changes) {
        const actionIds = entries.filter((entry) => entry.entity.kind === "task" && entry.entity.taskId === change.taskId).map((entry) => entry.actionId);
        if (!actionIds.length) continue;
        writes.push({ path: change.path, before: change.kind === "create" ? null : snapshot.contents.get(change.path) ?? null, after: change.kind === "delete" ? null : change.content ?? null, change, actionIds });
      }
      const written = new Set(writes.flatMap((write) => write.actionIds));
      noopActions.push(...entries.filter((entry) => entry.entity.kind === "task" && !written.has(entry.actionId)).map((entry) => entry.actionId));
    }
    for (const write of daily?.writes ?? diagnostic?.writes ?? []) writes.push({ ...write, actionIds: entries.filter((entry) => (entry.entity.kind === "daily-file" || entry.entity.kind === "daily-todo") ? entry.entity.path === write.path : entry.effects.some((effect) => effect.kind === "diagnostic" && effect.outputPath === write.path)).map((entry) => entry.actionId) });
    const now = Date.now();
    const preview = operationPreviewSchema.parse({ schemaVersion: 1, previewId, vaultInstanceId: this.vaultInstanceId, operationId: id, operationLabel: this.catalog.get(id).description.purpose, origin: context.origin, status: "pending", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 600000).toISOString(),
      summary: { targetCount: entries.length, actionCount: entries.length }, entries, warnings,
      undo: settingKeys.some((key) => key !== "ganttParentOrder") || historyPlanData || diagnostic || daily?.unresolvedTemplates.length || writes.some((write) => write.before === null && !write.change) ? { support: "none", reason: "設定保存・Dailyの新規ファイル作成はUndo対象外です。" } : { support: "full", reason: "履歴先頭かつ内容一致時にMarkdown差分を戻せます。" },
      projection: daily ? await dailyProjection(daily, snapshot, entries, afterParents) : project(snapshot, afterParents, afterSettings, entries) });
    if (this.disposed || context.signal?.aborted) fail("POLICY_DENIED", "停止した要求の計画は破棄しました。");
    if (new TextEncoder().encode(JSON.stringify(preview)).length > 12 * 1024 * 1024) fail("INVALID_INPUT", "提案が12MiBを超えます。対象を分けて再提案してください。");
    const stored: StoredPlan = { copyFrom, preview, input: structuredClone(parsed), context: { ...context, origin: structuredClone(context.origin), capabilities: [...context.capabilities], signal: undefined }, snapshot, afterParents, afterSettings, writes, settingKeys, changes, noopActions, daily, history: historyPlanData, diagnostic, integration };
    return stored;
  }
  inspect(previewId: string, context: RequestContext): OperationPreviewV1 {
    const stored = this.stored.get(previewId);
    if (!stored || stored.context.principalId !== context.principalId || context.vaultInstanceId !== this.vaultInstanceId) fail("NOT_FOUND", "この要求者に属する提案IDを使用してください。");
    return this.previewPort.inspect(previewId)!;
  }
  inspectOutcome(previewId: string, context: RequestContext): OperationOutcomeV1 | undefined {
    const stored = this.stored.get(previewId);
    if (this.disposed || context.signal?.aborted || !context.capabilities.includes("read") || context.vaultInstanceId !== this.vaultInstanceId
      || (stored && (stored.context.vaultInstanceId !== context.vaultInstanceId || stored.context.principalId !== context.principalId)))
      fail("POLICY_DENIED", "このVault・要求者に対するread権限が必要です。");
    if (!stored) fail("NOT_FOUND", "保持期間を超えました。対象の状態を取得し直してください。");
    const outcome = this.previewPort.inspectOutcome(previewId);
    return outcome ? structuredClone(validatePreviewOutcome(stored.preview, outcome)) : undefined;
  }
  async request<K extends ExternalRequestOperationId>(id: K, input: OperationInputMap[K], context: RequestContext): Promise<OperationOutputMap[K]> {
    this.guard(id, input, context);
    if (this.catalog.get(id).classification === "view") return await viewRequest(id as ViewRequestId, input as OperationInputMap[ViewRequestId], context, this.host.ui) as OperationOutputMap[K];
    if (id === "V22") return await diagnosticRequest(input as OperationInputMap["V22"], context, this.host.logger) as OperationOutputMap[K];
    if (["Q01", "Q02", "Q03", "Q04", "Q05", "Q06"].includes(id)) return await controlRequest(id as ControlId, input as OperationInputMap[ControlId], context, this.host.chatSession) as OperationOutputMap[K];
    if (!["Q07", "Q08"].includes(id)) fail("INVALID_INPUT", "request操作IDを指定してください。");
    const args = operationInputSchemas[id].parse(input) as { previewId: string };
    this.inspect(args.previewId, context);
    if (id === "Q08") return await this.repreview(args.previewId) as OperationOutputMap[K];
    this.previewPort.focus(args.previewId);
    await this.host.requestApproval?.(args.previewId);
    return operationOutputSchemas[id].parse({ schemaVersion: 1, resultKind: "request", operationId: id, status: "requested", effects: [{ kind: "conversation", action: "request-approval", before: null, after: { previewId: args.previewId } }] });
  }
  private async repreview(id: string): Promise<OperationPreviewV1> {
    const stored = this.stored.get(id); if (!stored) fail("NOT_FOUND", "対象を再取得して新しく提案してください。");
    const newer = this.previewPort.supersededBy(id); if (newer) fail("PLAN_CONSUMED", `再プレビュー済みです。新しい提案 ${newer} を使ってください。`);
    const outcome = this.previewPort.inspectOutcome(id);
    if (outcome?.actions.some((action) => action.state === "committed") && !["T27", "T28"].includes(stored.preview.operationId)) fail("POLICY_DENIED", "保存済みがあるため、未保存対象を指定した新規提案を作成してください。");
    let input = structuredClone(stored.input) as Record<string, unknown>;
    const { expectedRevision: _revision, ...fresh } = input; void _revision; input = fresh;
    if (Array.isArray(input.changes)) {
      const committed = new Set(outcome?.actions.filter((action) => action.state === "committed").map((action) => stored.preview.entries.find((entry) => entry.actionId === action.actionId)!.entity).flatMap((entity) => entity.kind === "task" ? [entity.taskId] : []) ?? []);
      input.changes = (input.changes as Record<string, unknown>[]).filter((change) => !committed.has(String(change.taskId))).map(({ expectedRevision: _expected, ...change }) => { void _expected; return change; });
    }
    const preview = await this.proposeBound(stored.preview.operationId as WriteOperationId, input as OperationInputMap[WriteOperationId], { ...stored.context, callerIntentId: undefined, requestId: `repreview-${++this.counter}` }, stored.copyFrom);
    this.discard(id); this.previewPort.markSuperseded(id, preview.previewId); return preview;
  }
  private executeApproved(id: string, signal?: AbortSignal): Promise<OperationOutcomeV1> {
    signal = signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
    const approved = this.pending.get(id);
    if (!approved) return Promise.reject(new Error("PLAN_CONSUMED"));
    let stored: StoredPlan = approved;
    const projectionGeneration = this.projectionChangeGeneration;
    if (Date.parse(stored.preview.expiresAt) > Date.now()) this.previewPort.markApproved(id);
    else this.previewPort.setStatus(id, "expired");
    this.pending.delete(id);
    return this.host.coordinator.coordinate(async () => {
      const vault = this.vaultFactory(), history: AppliedNote[] = [];
      let renamed = false;
      const committed = new Set<string>(), failed = new Set<string>(), actualEffects = new Map<string, PreviewEntry["effects"]>();
      let status: OperationOutcomeV1["status"] = "success", errorCode: string | undefined, orderPersisted = false;
      try {
        if (this.disposed || signal?.aborted) throw new Error("CANCELLED");
        if (Date.parse(stored.preview.expiresAt) <= Date.now()) throw new Error("PLAN_EXPIRED");
        const fresh = await this.contextPort.snapshot();
        if (fresh.revision !== stored.snapshot.revision) {
          // A sibling proposal may have been applied meanwhile: keep this one if it still means the same thing.
          const next = await this.rebase(id, stored, fresh);
          if (!next) throw new Error("REVISION_CONFLICT");
          stored = next; this.stored.set(id, next); this.previewPort.replace(id, next.preview);
        }
        // The snapshot's settings revision already covers the stored settings plus the completed parent order, so a
        // plain re-hash of the live settings is not comparable (the order may not be persisted yet). It is kept only
        // to detect a settings change while this approval is being applied.
        if (todayStr() !== stored.snapshot.today || (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC") !== stored.snapshot.timezone || fresh.settingsRevision !== stored.snapshot.settingsRevision) throw new Error("REVISION_CONFLICT");
        const liveSettingsRevision = await contentRevision(this.host.settings);
        for (const write of stored.writes) { const file = vault.getFileByPath(write.path); if (write.before === null ? !!file : !file || await vault.read(file) !== write.before) throw new Error("REVISION_CONFLICT"); }
        if (stored.history) this.clearSavedProjectionFocus();
        for (const [path, write] of this.ownWrites) if (write.until <= Date.now()) this.ownWrites.delete(path);
        for (const write of stored.writes) for (const path of [write.path, ...(write.afterPath ? [write.afterPath] : [])]) this.ownWrites.set(path, { ...(stored.daily || stored.history || stored.diagnostic ? { content: write.after } : {}), until: Date.now() + 60_000 });
        if (stored.daily && !stored.history) {
          await executeDailyPlan(stored.daily, vault, (path) => {
            const write = stored.writes.find((write) => write.path === path)!;
            write.actionIds.forEach((action) => committed.add(action));
            if (write.before === null) this.host.historyManager.discardRedo();
            else history.push({ path, before: write.before, after: write.after });
          }, signal);
        } else if (stored.history) {
          await executeHistoryPlan(stored.history, this.host.historyManager, vault, signal);
          stored.preview.entries.forEach((entry) => committed.add(entry.actionId));
        } else if (stored.diagnostic) {
          const result = await executeDiagnosticPlan(stored.diagnostic, this.host.logger!, vault, signal);
          for (const entry of stored.preview.entries) actualEffects.set(entry.actionId, entry.effects.map((effect) => effect.kind === "diagnostic" ? { ...effect, recording: result.recording } : effect));
          stored.preview.entries.forEach((entry) => committed.add(entry.actionId)); this.host.historyManager.discardRedo();
        }
        for (const write of stored.daily || stored.history || stored.diagnostic ? [] : byApplyOrder(stored.writes, (item) => item.change!)) {
          if (this.disposed || signal?.aborted) throw new Error("CANCELLED");
          try {
            let applied: AppliedNote;
            try { applied = await applyNoteChange(vault, write.change!, write.before); }
            catch (error) { throw error instanceof NoteConflictError ? new Error("REVISION_CONFLICT") : error; }
            history.push(...flattenApplied(applied));
            if (applied.afterPath) renamed = true;
            // The body after our write must be the body we meant to write; anything else is a concurrent edit.
            if (write.change!.kind === "update" && applied.before !== null && applied.after !== null && splitFrontmatter(applied.after).body !== splitFrontmatter(replaceSections(applied.before, write.change!.sections ?? {})).body) this.clearSavedProjection();
            if (write.change!.kind === "create") this.host.historyManager.discardRedo();
            write.actionIds.forEach((action) => committed.add(action));
            for (const note of flattenApplied(applied)) for (const path of [note.path, ...(note.afterPath ? [note.afterPath] : [])]) this.ownWrites.set(path, { content: note.after, until: Date.now() + 60_000 });
          } catch (error) { write.actionIds.forEach((action) => failed.add(action)); throw error; }
        }
        if (!stored.daily && !stored.history && !stored.diagnostic) stored.noopActions.forEach((action) => committed.add(action));
        if (stored.settingKeys.length) {
          if (this.disposed || signal?.aborted) throw new Error("CANCELLED");
          if (await contentRevision(this.host.settings) !== liveSettingsRevision) throw new Error("REVISION_CONFLICT");
          const candidate = structuredClone(this.host.settings);
          for (const key of stored.settingKeys) Object.assign(candidate, { [key]: structuredClone(stored.afterSettings[key]) });
          const settingsActions = stored.preview.entries.filter((entry) => entry.entity.kind !== "task" && !entry.effects.some((effect) => effect.kind === "external-send"));
          const beforeSettings = structuredClone(this.host.settings);
          try { await this.host.persistSettings!(candidate, stored.settingKeys); } catch (error) { settingsActions.forEach((entry) => failed.add(entry.actionId)); throw error; }
          if (!this.host.publishesSettings) for (const key of stored.settingKeys) if (canonical(this.host.settings[key]) === canonical(beforeSettings[key])) Object.assign(this.host.settings, { [key]: structuredClone(candidate[key]) });
          this.host.historyManager.discardRedo(); settingsActions.forEach((entry) => committed.add(entry.actionId));
          orderPersisted = stored.settingKeys.includes("ganttParentOrder");
          if (stored.integration?.restartSync) this.host.restartSync!();
        }
        if (stored.integration?.externalSend) {
          const sends = stored.preview.entries.filter((entry) => entry.effects.some((effect) => effect.kind === "external-send"));
          try { await executeExternalSend(stored.integration.externalSend, this.host.sendExternal!.bind(this.host), signal); sends.forEach((entry) => committed.add(entry.actionId)); }
          catch (error) { sends.forEach((entry) => failed.add(entry.actionId)); throw error; }
        }
      } catch (error) {
        // HistoryManager may fail to compensate an earlier file. Report only bytes
        // that still match the approved transition, never the planned full result.
        if (stored.history) for (const write of stored.writes) {
          const file = vault.getFileByPath(write.afterPath ?? write.path);
          try { if (write.after === null ? !file : !!file && await vault.read(file) === write.after) write.actionIds.forEach((action) => committed.add(action)); } catch { /* Unknown bytes are not claimed as saved. */ }
        }
        errorCode = signal?.aborted || this.disposed ? "CANCELLED" : error instanceof OperationFailure ? error.error.code : error instanceof Error ? error.message : "SAVE_FAILED";
        if (!failed.size && (stored.daily || stored.diagnostic || stored.history) && !["REVISION_CONFLICT", "PLAN_EXPIRED", "CANCELLED"].includes(errorCode)) {
          const first = stored.preview.entries.find((entry) => !committed.has(entry.actionId)); if (first) failed.add(first.actionId);
        }
        status = committed.size ? errorCode === "CANCELLED" ? "cancelled" : "partial" : errorCode === "CANCELLED" ? "cancelled" : ["REVISION_CONFLICT", "PLAN_EXPIRED"].includes(errorCode) ? "stale" : "failed";
      }
      // The parent order (settings) is undoable together with the file changes; other settings are not.
      const undoable = (history.length > 0 || orderPersisted) && stored.settingKeys.every((key) => key === "ganttParentOrder") && !stored.writes.some((write) => write.before === null && !write.change && write.actionIds.some((action) => committed.has(action)));
      if (undoable) this.host.historyManager.push({ label: `タスク変更 ${id}`, files: mergeApplied(history), ...(orderPersisted ? { order: { before: stored.snapshot.settings.ganttParentOrder ?? [], after: stored.afterSettings.ganttParentOrder ?? [] } } : {}) });
      for (const write of stored.writes) {
        if (!write.actionIds.some((action) => committed.has(action))) { this.ownWrites.delete(write.path); if (write.afterPath) this.ownWrites.delete(write.afterPath); }
        else if (stored.daily && !stored.history) this.ownWrites.set(write.path, { content: write.after, until: Date.now() + 60_000 });
      }
      // Only apply committed file/settings states to the original before snapshot.
      const parents = structuredClone(stored.snapshot.parents);
      if (orderPersisted) applyStoredOrder(stored.afterSettings, parents);
      const isCommitted = (write: WriteUnit) => write.actionIds.some((action) => committed.has(action));
      for (const write of stored.writes.filter(isCommitted)) {
        const taskId = write.change?.taskId ?? write.taskId; if (!taskId) continue;
        const next = flatten(stored.afterParents).find((row) => row.id === taskId), prior = flatten(stored.snapshot.parents).find((row) => row.id === taskId), known = (next ?? prior)!;
        if (known.kind === "parent") {
          if (!next) { const gone = parents.findIndex((parent) => parent.id === taskId); if (gone >= 0) parents.splice(gone, 1); continue; }
          const index = parents.findIndex((parent) => parent.id === next.id), row = structuredClone(next);
          row.subtasks = index >= 0 ? parents[index].subtasks : new Map();
          if (index < 0) parents.push(row); else parents[index] = row;
        } else {
          const owner = parents.find((parent) => parent.id === known.parentId); if (!owner) continue;
          if (next) owner.subtasks!.set(next.id, structuredClone(next)); else owner.subtasks!.delete(taskId);
        }
      }
      const actualEntries = stored.preview.entries.filter((entry) => committed.has(entry.actionId)).map((entry) => ({ ...entry, effects: actualEffects.get(entry.actionId) ?? entry.effects }));
      const outcome: OperationOutcomeV1 = { previewId: id, status, actions: stored.preview.entries.map((entry) => ({ actionId: entry.actionId, state: committed.has(entry.actionId) ? "committed" : failed.has(entry.actionId) ? "failed" : "not-attempted", actual: committed.has(entry.actionId) ? actualEffects.get(entry.actionId) ?? entry.effects : [], ...(committed.has(entry.actionId) ? {} : { errorCode: errorCode ?? "NOT_ATTEMPTED" }) })),
        ...(undoable ? { undoEntryId: `タスク変更 ${id}` } : {}), actualProjection: actualEntries.length ? stored.daily ? await dailyProjection({ ...stored.daily, files: stored.daily.files.map((file) => ({ ...file, after: stored.writes.some((write) => write.path === file.path && write.actionIds.some((action) => committed.has(action))) ? file.after : file.before })) }, stored.snapshot, actualEntries, parents) : project(stored.snapshot, parents, orderPersisted || stored.settingKeys.length && stored.preview.entries.some((entry) => entry.entity.kind !== "task" && committed.has(entry.actionId) && !entry.effects.some((effect) => effect.kind === "external-send")) ? stored.afterSettings : stored.snapshot.settings, actualEntries) : null };
      if (committed.size && !this.disposed) { try { await this.host.invalidate(renamed || stored.settingKeys.length || stored.daily || stored.history || stored.diagnostic ? undefined : stored.writes.filter((write) => write.actionIds.some((action) => committed.has(action))).flatMap((write) => [write.path, ...(write.afterPath ? [write.afterPath] : [])])); } catch { /* Saved bytes remain authoritative. */ } }
      const validated = validatePreviewOutcome(stored.preview, outcome);
      if (!this.disposed) {
        // An external change while applying cannot clear an outcome that
        // does not exist yet. Clear its focus before listeners see the result.
        if (projectionGeneration !== this.projectionChangeGeneration && this.previewPort.focusedPreviewId() === id) this.previewPort.focus(null);
        this.previewPort.publish(validated);
      }
      return structuredClone(validated);
    });
  }
  // Compatibility backend for the original six tools and existing human chat cards.
  legacyContext(): RequestContext { return { vaultInstanceId: this.vaultInstanceId, principalId: "obsidian-chat", origin: { kind: "chat", conversationId: "compatibility" }, capabilities: ["read", "propose"], requestId: `legacy-${++this.counter}` }; }
  async rows(query = ""): Promise<TaskRow[]> { return flatten((await this.contextPort.snapshot()).parents).filter((row) => `${row.displayName} ${row.title}`.toLowerCase().includes(query.toLowerCase())); }
  async get(taskId: string): Promise<TaskRow> { return findTask(await this.contextPort.snapshot(), taskId); }
  async invoke(name: OperationName, input: unknown) {
    const parsed = OPERATION_MANIFEST[name].schema.parse(input);
    if (name === "search") return (await this.rows((parsed as { query?: string }).query)).slice(0, 100).map(taskData);
    if (name === "get") return taskData(await this.get((parsed as { taskId: string }).taskId));
    return this.plan(name, parsed);
  }
  async plan(name: OperationName, input: unknown, context: RequestContext = this.legacyContext()): Promise<OperationPlan> {
    const request = adaptLegacyOperationInput(name, input);
    const legacy = structuredClone(request.input) as Record<string, unknown>;
    // Old UI revisions are stat-based. Validate once at this explicit boundary, then plan with a content hash.
    const convert = async (arg: Record<string, unknown>) => {
      if (!arg.expectedRevision) return arg;
      const taskId = String(arg.taskId ?? arg.parentTaskId), row = await this.get(taskId), file = this.vaultFactory().getFileByPath(row.file.path);
      if (arg.expectedRevision !== buildFileRevision(file as TaskRow["file"]) && arg.expectedRevision !== await contentRevision(await this.vaultFactory().read(file!))) fail("REVISION_CONFLICT", "対象を再取得してください。");
      return { ...arg, expectedRevision: await contentRevision(await this.vaultFactory().read(file!)) };
    };
    const converted = Array.isArray(legacy.changes) ? { ...legacy, changes: await Promise.all(legacy.changes.map((change) => convert(change as Record<string, unknown>))) } : await convert(legacy);
    const preview = await this.propose(request.operationId as WriteOperationId, converted as OperationInputMap[WriteOperationId], context);
    return this.legacyPlan(preview, name);
  }
  legacyPlan(preview: OperationPreviewV1, operation: OperationName = "update-batch"): OperationPlan {
    return { previewId: preview.previewId, operation, summary: `${preview.summary.targetCount}件の変更`, count: preview.summary.actionCount, diffs: preview.entries.map((entry) => ({ taskId: entry.entity.kind === "task" ? entry.entity.taskId : JSON.stringify(entry.entity), name: entry.displayName, ...(entry.entity.kind === "task" && entry.entity.parentId ? { parentId: entry.entity.parentId } : {}),
      fields: entry.effects.flatMap<FieldDiff>((effect) => effect.kind === "fields" || effect.kind === "settings" ? effect.fields.map(({ field, before, after }) => ({ field, before, after })) : effect.kind === "presence" ? [{ field: effect.action, before: effect.before, after: effect.after }]
        : effect.kind === "marker" || effect.kind === "weekly" || effect.kind === "deadline" || effect.kind === "membership" ? [{ field: effect.kind, before: effect.before, after: effect.after }]
        : effect.kind === "workload" ? [{ field: "workload", before: effect.cells.map((cell) => cell.before), after: effect.cells.map((cell) => cell.after) }] : []),
      ...entry.effects.reduce<Pick<TaskDiff, "schedule">>((result, effect) => effect.kind === "schedule" ? { schedule: { before: { start: effect.before.start ?? "", end: effect.before.end ?? "" }, after: { start: effect.after.start ?? "", end: effect.after.end ?? "" } } } : result, {}) })) };
  }
  discard(id: string): void { this.pending.delete(id); if (this.previewPort.inspect(id)?.status === "pending") this.previewPort.setStatus(id, "rejected"); }
  async commit(id: string, signal?: AbortSignal): Promise<OperationResult> {
    const stored = this.stored.get(id); if (!stored) throw new Error("PLAN_CONSUMED");
    const outcome = this.previewPort.inspectOutcome(id) ?? await this.executeApproved(id, signal);
    const actionIds = new Set(outcome.actions.filter((action) => action.state === "committed").map((action) => action.actionId));
    const committedEntries = stored.preview.entries.filter((entry) => actionIds.has(entry.actionId));
    const plan = this.legacyPlan({ ...stored.preview, entries: committedEntries });
    const createdEntry = committedEntries.find((entry) => entry.effects.some((effect) => effect.kind === "presence" && effect.action === "create"));
    const created = createdEntry?.entity.kind === "task" ? flatten(stored.afterParents).find((row) => row.id === (createdEntry.entity as { taskId: string }).taskId) : undefined;
    return { kind: outcome.status, committed: actionIds.size, total: stored.preview.entries.length, diffs: plan.diffs, results: committedEntries.flatMap((entry) => { if (entry.entity.kind !== "task") return []; const taskId = entry.entity.taskId, row = flatten(stored.afterParents).find((item) => item.id === taskId) ?? flatten(stored.snapshot.parents).find((item) => item.id === taskId), file = row ? this.vaultFactory().getFileByPath(row.file.path) : null;
      return [{ taskId, parentPath: row?.file.parentPath ?? row?.file.path ?? "", revisionBefore: (row && stored.snapshot.statRevisions.get(row.file.path)) ?? "new", revisionAfter: file ? buildFileRevision(file as TaskRow["file"]) : "", changedFields: entry.effects.flatMap((effect) => effect.kind === "fields" ? effect.fields.map((field) => field.field) : []) }]; }), message: outcome.status === "success" ? "変更を保存しました" : "保存を完了できませんでした。未保存対象を再取得して再プレビューしてください。", ...(created ? { created } : {}), ...(outcome.undoEntryId ? { undoLabel: outcome.undoEntryId } : {}) };
  }
  dispose(): void { this.disposed = true; this.lifecycle.abort(); this.pending.clear(); this.stored.clear(); this.intents.clear(); this.planningIntents.clear(); this.ownWrites.clear(); this.previewPort.dispose(); }
}
