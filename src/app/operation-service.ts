import type { OperationService as OperationServicePort } from "../contracts/ports";
import type { OperationId, OperationInputMap, OperationOutputMap, ReadOperationId, WriteOperationId, ExternalRequestOperationId } from "../contracts/operations";
import { operationInputSchemas, operationOutputSchemas, operationRequestDenial } from "../contracts/operations";
import type { RequestContext } from "../contracts/context";
import { operationPreviewSchema, type OperationPreviewV1, type OperationOutcomeV1, type PreviewEntry } from "../contracts/preview";
import { adaptLegacyOperationInput } from "../contracts/legacy-operation-plan";
import { applyPatchToParent } from "../core/task-patch";
import { buildFullNote, parseTaskFile } from "../core/note-format";
import { todayStr, buildFileRevision } from "../core/utils";
import type { TaskRow, TaskWorkbenchSettings } from "../core/types";
import { createTask, addSubtask, type VaultAdapter } from "./task-operations";
import { HistoryManager, type HistoryFileChange } from "./history-manager";
import { OperationCatalog, IMPLEMENTED_OPERATION_IDS } from "./operation-catalog";
import { ContextIndex } from "./context-index";
import { ApprovalService } from "./approval-service";
import { PreviewStore } from "./preview-store";
import { project, taskEffects, taskPublicState } from "./preview-projector";
import { canonical, checkRevision, contentRevision, fail, findTask, flatten, type TaskChange, type TaskSnapshot } from "./operations/runtime";
import { taskChanges } from "./operations/task-handlers";
import { scheduleChanges } from "./operations/schedule-handlers";
import { markerWorkloadChanges } from "./operations/marker-workload-handlers";
import { eventWeeklyPlan } from "./operations/event-weekly-handlers";
import { settingsPlan } from "./operations/settings-handlers";
import { holidaySet } from "./gantt-actions";
import { snapForward, hasWorkloadActual } from "./gantt-drag";
import { taskData, OPERATION_MANIFEST } from "./operation-registry";
import type { OperationRegistry, OperationName, OperationPlan, OperationResult, TaskDiff, FieldDiff } from "./operation-registry";

interface WriteUnit { path: string; before: string | null; after: string; actionIds: string[] }
interface StoredPlan { preview: OperationPreviewV1; input: unknown; context: RequestContext; snapshot: TaskSnapshot; afterParents: TaskRow[]; afterSettings: TaskWorkbenchSettings; writes: WriteUnit[]; settingKeys: (keyof TaskWorkbenchSettings)[]; changes: TaskChange[] }
export interface OperationServiceHost {
  readonly settings: TaskWorkbenchSettings;
  readonly historyManager: HistoryManager;
  readonly coordinator: Pick<OperationRegistry, "coordinate">;
  /** Persist the candidate copy. Live settings are published only after success. No timers/network here. */
  persistSettings?(candidate: TaskWorkbenchSettings): Promise<void>;
  invalidate(): void | Promise<void>;
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
  private counter = 0;
  private disposed = false;
  constructor(private readonly host: OperationServiceHost, private readonly vaultFactory: () => VaultAdapter, readonly vaultInstanceId: string) {
    this.contextPort = new ContextIndex(vaultFactory, () => host.settings, vaultInstanceId);
    this.previewPort = new PreviewStore({ reject: (id) => this.pending.delete(id), repreview: (id) => this.repreview(id) });
    this.humanApprovalPort = new ApprovalService((id) => this.executeApproved(id), (id) => this.previewPort.inspectOutcome(id));
  }
  async invalidatePreviews(): Promise<void> {
    if (this.disposed || !this.pending.size) return;
    const snapshot = await this.contextPort.snapshot();
    for (const [id, plan] of this.pending) if (plan.snapshot.revision !== snapshot.revision) { this.pending.delete(id); this.previewPort.setStatus(id, "stale"); }
  }
  describe(ids?: readonly OperationId[]) { return this.catalog.describe(ids).map((description) => !IMPLEMENTED_OPERATION_IDS.has(description.id) || this.available(description.id) ? description : { ...description, available: false, denial: { code: "POLICY_DENIED" as const, retryable: false, nextAction: "設定保存portが未接続です。人間用UIから操作してください。" } }); }
  private available(id: OperationId): boolean { return IMPLEMENTED_OPERATION_IDS.has(id) && (!(id.startsWith("E") || id.startsWith("W") || id.startsWith("S")) || !!this.host.persistSettings); }
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
    const result = id === "T01" ? await this.contextPort.query("tasks.search", { name: (parsed as OperationInputMap["T01"]).query, cursor: (parsed as OperationInputMap["T01"]).cursor, limit: (parsed as OperationInputMap["T01"]).limit }, context)
      : await this.contextPort.query("tasks.get-many", { taskIds: [(parsed as OperationInputMap["T02"]).taskId], include: ["identity", ...(parsed as OperationInputMap["T02"]).include ?? ["status", "schedule", "priority", "tags"]] }, context);
    if (result.status === "error") fail(result.error.code, result.error.nextAction);
    if (id === "T02" && result.result.data.kind === "tasks" && !result.result.data.items.length) fail("NOT_FOUND", "taskIdを検索し直してください。");
    return operationOutputSchemas[id].parse(result.result);
  }
  async propose<K extends WriteOperationId>(id: K, input: OperationInputMap[K], context: RequestContext): Promise<OperationPreviewV1> {
    this.guard(id, input, context);
    if (!context.callerIntentId) return this.createProposal(id, input, context);
    const key = canonical([context.vaultInstanceId, context.principalId, context.callerIntentId]);
    const binding = canonical({ id, input: operationInputSchemas[id].parse(input) });
    const active = this.planningIntents.get(key);
    if (active) { if (active.binding !== binding) fail("POLICY_DENIED", "同じcallerIntentIdで別の操作を送信しないでください。"); return active.promise; }
    const promise = this.createProposal(id, input, context);
    this.planningIntents.set(key, { binding, promise });
    void promise.finally(() => this.planningIntents.delete(key)).catch(() => undefined);
    return promise;
  }
  private async createProposal<K extends WriteOperationId>(id: K, input: OperationInputMap[K], context: RequestContext): Promise<OperationPreviewV1> {
    this.guard(id, input, context);
    if (this.catalog.get(id).classification !== "write") fail("INVALID_INPUT", "write操作IDを指定してください。");
    const parsed = operationInputSchemas[id].parse(input) as OperationInputMap[K];
    const intentKey = context.callerIntentId ? canonical([context.vaultInstanceId, context.principalId, context.callerIntentId]) : undefined;
    const binding = canonical({ id, input: parsed });
    if (intentKey) {
      const previous = this.intents.get(intentKey);
      if (previous) {
        if (previous.binding !== binding) fail("POLICY_DENIED", "同じcallerIntentIdで別の操作を送信しないでください。");
        const preview = this.previewPort.inspect(previous.previewId);
        if (!preview) fail("PLAN_CONSUMED", "receipt保持期間を超えました。対象を再取得し、盲目的に再送しないでください。");
        return preview;
      }
    }
    const snapshot = await this.contextPort.snapshot();
    const parseSettings = { ...snapshot.settings, autoPriorityEnabled: false };
    const afterParents = structuredClone(snapshot.parents);
    let afterSettings = structuredClone(snapshot.settings);
    const previewId = `preview-${this.vaultInstanceId}-${++this.counter}`;
    let entries: PreviewEntry[] = [], changes: TaskChange[] = [], settingKeys: (keyof TaskWorkbenchSettings)[] = [];
    const warnings: OperationPreviewV1["warnings"][number][] = [];
    const vault = this.vaultFactory();
    const checkSafe = (parent: TaskRow) => { const original = snapshot.contents.get(parent.file.path); if (original !== undefined && original !== buildFullNote(parent, parent.subtasks)) fail("INVALID_INPUT", "未モデル化領域または非標準Markdownがあります。内容を保全するwriterが未実装のため、このノートへの保存を拒否します。"); };
    const createdContents = new Map<string, string>();
    if (id.startsWith("E") || id.startsWith("W") || id.startsWith("S")) {
      const plan = id.startsWith("S") ? settingsPlan(id, parsed, snapshot) : eventWeeklyPlan(id, parsed, snapshot);
      afterSettings = plan.settings; settingKeys = [...plan.keys]; entries = plan.entries.map((entry, index) => ({ ...entry, actionId: `${previewId}:${index}` }));
      if (id === "S23" || id === "S26") warnings.push({ code: "TAG_REFERENCES_RETAINED", detail: "既存タスク・マーカーのタグ名参照は変更しません。" });
      if (id === "S34" && !afterSettings.dailyTodoSources.some((source) => source.key === "main")) warnings.push({ code: "MAIN_SOURCE_MISSING", detail: "mainが存在しなくなるため、新規Daily追加はできません。" });
    } else if (["T03", "T04", "T05", "T06"].includes(id)) {
      const args = parsed as OperationInputMap["T03"] & OperationInputMap["T04"] & OperationInputMap["T06"];
      const parentId = id === "T04" ? args.parentTaskId : id === "T06" ? args.parentId : undefined;
      const parent = parentId ? findTask(snapshot, parentId, "parent") : undefined;
      if (parent) { checkRevision(snapshot, parent, args.expectedRevision); checkSafe(parent); }
      // Existing creation helpers execute only against this isolated in-memory vault.
      const virtual: VaultAdapter = { getFiles: () => vault.getFiles(), getFileByPath: (path) => createdContents.has(path) ? { path } : vault.getFileByPath(path),
        read: async (file) => createdContents.get(file.path) ?? snapshot.contents.get(file.path) ?? "",
        create: async (path, content) => { createdContents.set(path, content); return { path }; }, modify: async (file, content) => { createdContents.set(file.path, content); } };
      let created: TaskRow;
      if (parent) {
        const copy = afterParents.find((row) => row.id === parent.id)!;
        const date = id === "T06" ? snapForward(args.date, holidaySet(snapshot.settings)) : undefined;
        created = await addSubtask(virtual, parseSettings, copy, args.name, date ? { plannedStartDate: date, plannedEndDate: date } : undefined);
        const reparsed = parseTaskFile({ path: parent.file.path }, createdContents.get(parent.file.path)!, parseSettings)!;
        afterParents[afterParents.findIndex((row) => row.id === parent.id)] = reparsed;
      } else {
        created = await createTask(virtual, parseSettings, args.name);
        if (id === "T05") { created.ganttEnabled = true; created.ganttOrder = Math.max(0, ...snapshot.parents.filter((parent) => parent.ganttEnabled).map((parent) => parent.ganttOrder ?? 999999)) + 1000; createdContents.set(created.file.path, buildFullNote(created, created.subtasks)); }
        afterParents.push(created);
      }
      if (created.displayName !== args.name.trim()) fail("INVALID_INPUT", "作成名を安全に保存できません。見出し・記号を確認してください。");
      entries = [{ actionId: `${previewId}:0`, entity: { kind: "task", taskId: created.id, ...(parent ? { parentId: parent.id } : {}) }, displayName: created.displayName, effects: taskEffects(undefined, created) }];
    } else if (id === "T26") {
      const args = parsed as OperationInputMap["T26"], child = findTask(snapshot, args.subtaskId, "subtask");
      checkRevision(snapshot, child, args.expectedRevision);
      const parent = findTask(snapshot, child.file.path, "parent"); checkSafe(parent);
      const copy = afterParents.find((row) => row.id === parent.id)!; copy.subtasks!.delete(child.key!); copy.updatedAt = snapshot.today;
      entries = [{ actionId: `${previewId}:0`, entity: { kind: "task", taskId: child.id, parentId: parent.id }, displayName: child.displayName, effects: taskEffects(child, undefined) }];
    } else {
      changes = id.startsWith("M") ? markerWorkloadChanges(id, parsed, snapshot) : id >= "T19" && id <= "T25" ? scheduleChanges(id, parsed, snapshot) : taskChanges(id, parsed, snapshot);
      const changedPaths = new Set<string>();
      for (const change of changes) {
        const before = findTask(snapshot, change.taskId); checkRevision(snapshot, before, change.expectedRevision);
        const parent = afterParents.find((row) => row.file.path === before.file.path)!;
        if (!changedPaths.has(parent.id)) { checkSafe(findTask(snapshot, parent.id, "parent")); changedPaths.add(parent.id); }
        applyPatchToParent(parent, change.patch, change.taskId, snapshot.settings);
        if (["T20", "T21", "T22", "T25"].includes(id) && hasWorkloadActual(before)) warnings.push({ code: "HAS_ACTUAL_WORKLOAD", detail: `${before.id}: 実績があります。${id === "T25" ? "実績mapも移動します。" : "実績mapは移動しません。"}` });
      }
      // Validate the final combined parent, including changes to multiple children in one file.
      for (const path of changedPaths) {
        const index = afterParents.findIndex((parent) => parent.id === path), parent = afterParents[index];
        const reparsed = parseTaskFile({ path }, buildFullNote(parent, parent.subtasks), parseSettings);
        if (!reparsed || canonical(flatten([parent]).map(taskPublicState)) !== canonical(flatten([reparsed]).map(taskPublicState))) fail("INVALID_INPUT", "正規化後の内容を安全に保存できません。入力の記号・見出しを確認してください。");
        afterParents[index] = reparsed;
      }
      entries = changes.map((change, index) => { const before = findTask(snapshot, change.taskId), after = flatten(afterParents).find((row) => row.id === change.taskId)!;
        return { actionId: `${previewId}:${index}`, entity: { kind: "task" as const, taskId: before.id, ...(before.kind === "subtask" ? { parentId: before.file.path } : {}) }, displayName: after.displayName,
          effects: taskEffects(before, after, change.patch as Record<string, unknown>, ["T20", "T21", "T22", "T23"].includes(id)) };
      });
    }
    const writes: WriteUnit[] = [];
    for (const parent of afterParents) {
      const before = snapshot.contents.get(parent.file.path) ?? null, after = createdContents.get(parent.file.path) ?? buildFullNote(parent, parent.subtasks);
      const actions = entries.filter((entry) => entry.entity.kind === "task" && entry.entity.taskId.split("::")[0] === parent.id).map((entry) => entry.actionId);
      if (actions.length) writes.push({ path: parent.file.path, before, after, actionIds: actions });
    }
    const now = Date.now();
    const preview = operationPreviewSchema.parse({ schemaVersion: 1, previewId, vaultInstanceId: this.vaultInstanceId, operationId: id, origin: context.origin, status: "pending", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 600000).toISOString(),
      summary: { targetCount: entries.length, actionCount: entries.length }, entries, warnings,
      undo: settingKeys.length || writes.some((write) => write.before === null) ? { support: "none", reason: "設定保存・親の新規ファイル作成はUndo対象外です。" } : { support: "full", reason: "履歴先頭かつ内容一致時にMarkdown差分を戻せます。" },
      projection: project(snapshot, afterParents, afterSettings, entries) });
    if (this.disposed || context.signal?.aborted) fail("POLICY_DENIED", "停止した要求の計画は破棄しました。");
    if (new TextEncoder().encode(JSON.stringify(preview)).length > 12 * 1024 * 1024) fail("INVALID_INPUT", "提案が12MiBを超えます。対象を分けて再提案してください。");
    while (this.pending.size >= 50) { const oldest = this.pending.keys().next().value!; this.pending.delete(oldest); this.previewPort.setStatus(oldest, "expired"); }
    const stored: StoredPlan = { preview, input: structuredClone(parsed), context: { ...context, origin: structuredClone(context.origin), capabilities: [...context.capabilities], signal: undefined }, snapshot, afterParents, afterSettings, writes, settingKeys, changes };
    this.pending.set(previewId, stored); this.stored.set(previewId, stored);
    while (this.stored.size > 100) this.stored.delete(this.stored.keys().next().value!);
    if (intentKey) { this.intents.set(intentKey, { binding, previewId }); while (this.intents.size > 100) this.intents.delete(this.intents.keys().next().value!); }
    this.previewPort.put(preview);
    return structuredClone(preview);
  }
  inspect(previewId: string, context: RequestContext): OperationPreviewV1 {
    const stored = this.stored.get(previewId);
    if (!stored || stored.context.principalId !== context.principalId || context.vaultInstanceId !== this.vaultInstanceId) fail("NOT_FOUND", "この要求者に属する提案IDを使用してください。");
    return this.previewPort.inspect(previewId)!;
  }
  async request<K extends ExternalRequestOperationId>(id: K, input: OperationInputMap[K], context: RequestContext): Promise<OperationOutputMap[K]> {
    this.guard(id, input, context);
    if (!["Q07", "Q08"].includes(id)) fail("POLICY_DENIED", "このrequest操作は未実装です。");
    const args = operationInputSchemas[id].parse(input) as { previewId: string };
    this.inspect(args.previewId, context);
    if (id === "Q08") return await this.repreview(args.previewId) as OperationOutputMap[K];
    this.previewPort.focus(args.previewId);
    return operationOutputSchemas[id].parse({ schemaVersion: 1, resultKind: "request", operationId: id, status: "requested", effects: [{ kind: "conversation", action: "request-approval", before: null, after: { previewId: args.previewId } }] });
  }
  private async repreview(id: string): Promise<OperationPreviewV1> {
    const stored = this.stored.get(id); if (!stored) fail("NOT_FOUND", "対象を再取得して新しく提案してください。");
    const outcome = this.previewPort.inspectOutcome(id);
    if (outcome?.actions.some((action) => action.state === "committed") && !["T27", "T28"].includes(stored.preview.operationId)) fail("POLICY_DENIED", "保存済みがあるため、未保存対象を指定した新規提案を作成してください。");
    let input = structuredClone(stored.input) as Record<string, unknown>;
    const { expectedRevision: _revision, ...fresh } = input; void _revision; input = fresh;
    if (Array.isArray(input.changes)) {
      const committed = new Set(outcome?.actions.filter((action) => action.state === "committed").map((action) => stored.preview.entries.find((entry) => entry.actionId === action.actionId)!.entity).flatMap((entity) => entity.kind === "task" ? [entity.taskId] : []) ?? []);
      input.changes = (input.changes as Record<string, unknown>[]).filter((change) => !committed.has(String(change.taskId))).map(({ expectedRevision: _expected, ...change }) => { void _expected; return change; });
    }
    const preview = await this.propose(stored.preview.operationId as WriteOperationId, input as OperationInputMap[WriteOperationId], { ...stored.context, requestId: `repreview-${++this.counter}` });
    this.discard(id); return preview;
  }
  private executeApproved(id: string, signal?: AbortSignal): Promise<OperationOutcomeV1> {
    const stored = this.pending.get(id);
    if (!stored) return Promise.reject(new Error("PLAN_CONSUMED"));
    this.pending.delete(id); this.previewPort.setStatus(id, "applying");
    return this.host.coordinator.coordinate(async () => {
      const vault = this.vaultFactory(), history: HistoryFileChange[] = [];
      const committed = new Set<string>(), failed = new Set<string>();
      let status: OperationOutcomeV1["status"] = "success", errorCode: string | undefined;
      try {
        if (this.disposed || signal?.aborted) throw new Error("CANCELLED");
        if (Date.parse(stored.preview.expiresAt) <= Date.now()) throw new Error("PLAN_EXPIRED");
        if ((await this.contextPort.snapshot()).revision !== stored.snapshot.revision) throw new Error("REVISION_CONFLICT");
        if (todayStr() !== stored.snapshot.today || (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC") !== stored.snapshot.timezone || await contentRevision(this.host.settings) !== stored.snapshot.settingsRevision) throw new Error("REVISION_CONFLICT");
        for (const write of stored.writes) { const file = vault.getFileByPath(write.path); if (write.before === null ? !!file : !file || await vault.read(file) !== write.before) throw new Error("REVISION_CONFLICT"); }
        for (const write of stored.writes) {
          if (this.disposed || signal?.aborted) throw new Error("CANCELLED");
          try {
            if (write.before === null) { if (vault.getFileByPath(write.path)) throw new Error("REVISION_CONFLICT"); await vault.create(write.path, write.after); this.host.historyManager.clear(); }
            else if (write.before !== write.after) {
              const file = vault.getFileByPath(write.path); if (!file) throw new Error("REVISION_CONFLICT");
              const transform = (current: string) => { if (current !== write.before) throw new Error("REVISION_CONFLICT"); if (this.disposed || signal?.aborted) throw new Error("CANCELLED"); return write.after; };
              if (vault.process) await vault.process(file, transform); else { transform(await vault.read(file)); await vault.modify(file, write.after); }
              history.push({ path: write.path, before: write.before, after: write.after });
            }
            write.actionIds.forEach((action) => committed.add(action));
          } catch (error) { write.actionIds.forEach((action) => failed.add(action)); throw error; }
        }
        if (stored.settingKeys.length) {
          if (this.disposed || signal?.aborted) throw new Error("CANCELLED");
          if (await contentRevision(this.host.settings) !== stored.snapshot.settingsRevision) throw new Error("REVISION_CONFLICT");
          const candidate = structuredClone(this.host.settings);
          for (const key of stored.settingKeys) Object.assign(candidate, { [key]: structuredClone(stored.afterSettings[key]) });
          try { await this.host.persistSettings!(candidate); } catch (error) { stored.preview.entries.forEach((entry) => failed.add(entry.actionId)); throw error; }
          for (const key of stored.settingKeys) Object.assign(this.host.settings, { [key]: structuredClone(candidate[key]) });
          this.host.historyManager.clear(); stored.preview.entries.forEach((entry) => committed.add(entry.actionId));
        }
      } catch (error) {
        errorCode = error instanceof Error ? error.message : "SAVE_FAILED";
        status = committed.size ? errorCode === "CANCELLED" ? "cancelled" : "partial" : errorCode === "CANCELLED" ? "cancelled" : ["REVISION_CONFLICT", "PLAN_EXPIRED"].includes(errorCode) ? "stale" : "failed";
      }
      if (history.length) this.host.historyManager.push({ label: `タスク変更 ${id}`, files: history });
      // Only apply committed file/settings states to the original before snapshot.
      const parents = structuredClone(stored.snapshot.parents);
      for (const write of stored.writes.filter((write) => write.actionIds.some((action) => committed.has(action)))) {
        const parent = stored.afterParents.find((parent) => parent.id === write.path)!;
        const index = parents.findIndex((parent) => parent.id === write.path); if (index < 0) parents.push(parent); else parents[index] = parent;
      }
      const actualEntries = stored.preview.entries.filter((entry) => committed.has(entry.actionId));
      const outcome: OperationOutcomeV1 = { previewId: id, status, actions: stored.preview.entries.map((entry) => ({ actionId: entry.actionId, state: committed.has(entry.actionId) ? "committed" : failed.has(entry.actionId) ? "failed" : "not-attempted", actual: committed.has(entry.actionId) ? entry.effects : [], ...(committed.has(entry.actionId) ? {} : { errorCode: errorCode ?? "NOT_ATTEMPTED" }) })),
        ...(history.length ? { undoEntryId: `タスク変更 ${id}` } : {}), actualProjection: actualEntries.length ? project(stored.snapshot, parents, stored.settingKeys.length && committed.size ? stored.afterSettings : stored.snapshot.settings, actualEntries) : null };
      if (committed.size) { try { await this.host.invalidate(); } catch { /* Saved bytes remain authoritative. */ } }
      this.previewPort.publish(outcome); return structuredClone(outcome);
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
    return { previewId: preview.previewId, operation, summary: `${preview.summary.targetCount}件の変更`, count: preview.summary.actionCount, diffs: preview.entries.map((entry) => ({ taskId: entry.entity.kind === "task" ? entry.entity.taskId : JSON.stringify(entry.entity), name: entry.displayName,
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
    return { kind: outcome.status, committed: actionIds.size, total: stored.preview.entries.length, diffs: plan.diffs, results: committedEntries.flatMap((entry) => entry.entity.kind === "task" ? [{ taskId: entry.entity.taskId, parentPath: entry.entity.taskId.split("::")[0], revisionBefore: stored.snapshot.statRevisions.get(entry.entity.taskId.split("::")[0]) ?? "new", revisionAfter: buildFileRevision(this.vaultFactory().getFileByPath(entry.entity.taskId.split("::")[0]) as TaskRow["file"]), changedFields: entry.effects.flatMap((effect) => effect.kind === "fields" ? effect.fields.map((field) => field.field) : []) }] : []), message: outcome.status === "success" ? "変更を保存しました" : "保存を完了できませんでした。未保存対象を再取得して再プレビューしてください。", ...(created ? { created } : {}), ...(outcome.undoEntryId ? { undoLabel: outcome.undoEntryId } : {}) };
  }
  dispose(): void { this.disposed = true; this.pending.clear(); this.stored.clear(); this.intents.clear(); this.planningIntents.clear(); this.previewPort.dispose(); }
}
