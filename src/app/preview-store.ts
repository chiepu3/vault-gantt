import type { PreviewPort } from "../contracts/ports";
import { operationPreviewSchema, validatePreviewOutcome, type OperationPreviewV1, type OperationOutcomeV1, type ProjectionPageRequestV1, type ProjectionPageResultV1, type PreviewEventV1 } from "../contracts/preview";
import { fail } from "./operations/runtime";
export class PreviewStore implements PreviewPort {
  private readonly previews = new Map<string, OperationPreviewV1>();
  private readonly outcomes = new Map<string, OperationOutcomeV1>();
  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<(event: PreviewEventV1) => void>();
  private eventCounter = 0;
  private focused: string | null = null;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  constructor(private readonly callbacks: { reject: (id: string) => void; repreview: (id: string) => Promise<OperationPreviewV1> }) {}
  put(preview: OperationPreviewV1): void {
    this.previews.set(preview.previewId, structuredClone(operationPreviewSchema.parse(preview)));
    while (this.previews.size > 100) { const old = this.previews.keys().next().value!; this.callbacks.reject(old); this.previews.delete(old); this.outcomes.delete(old); if (this.focused === old) this.focused = null; }
    this.scheduleExpiry(); this.emit();
  }
  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    const pending = [...this.previews.values()].filter((preview) => preview.status === "pending");
    if (!pending.length) { this.expiryTimer = undefined; return; }
    const delay = Math.max(0, Math.min(...pending.map((preview) => Date.parse(preview.expiresAt))) - Date.now());
    this.expiryTimer = setTimeout(() => { this.expiryTimer = undefined; for (const id of this.previews.keys()) this.inspect(id); this.scheduleExpiry(); }, delay);
    if (typeof this.expiryTimer === "object") this.expiryTimer.unref?.();
  }
  setStatus(id: string, status: OperationPreviewV1["status"]): void { const preview = this.previews.get(id); if (preview) { this.previews.set(id, { ...preview, status }); if (["rejected", "stale", "expired", "revoked"].includes(status) && this.focused === id) this.focused = null; this.scheduleExpiry(); this.emit(); } }
  markApproved(id: string): void {
    const preview = this.inspect(id);
    if (!preview || preview.status !== "pending") fail("PLAN_CONSUMED", "承認できる保留提案ではありません。");
    const approvedEvent = { schemaVersion: 1 as const, kind: "approved" as const, eventId: `${id}:event-${++this.eventCounter}`, previewId: id, occurredAt: new Date().toISOString() };
    this.previews.set(id, { ...preview, status: "applying", approvedEvent });
    this.scheduleExpiry(); this.emit(); this.emitEvent(approvedEvent);
  }
  async invalidate(id: string, reason: "expired" | "revoked"): Promise<void> {
    const preview = this.previews.get(id);
    if (!preview) fail("NOT_FOUND", "提案を取得し直してください。");
    if (preview.status !== "pending") return;
    this.callbacks.reject(id); this.setStatus(id, reason);
    this.emitEvent({ schemaVersion: 1, kind: reason, eventId: `${id}:event-${++this.eventCounter}`, previewId: id, occurredAt: new Date().toISOString() });
  }
  subscribeEvents(listener: (event: PreviewEventV1) => void): () => void { this.eventListeners.add(listener); return () => { this.eventListeners.delete(listener); }; }
  private emitEvent(event: PreviewEventV1): void { for (const listener of this.eventListeners) { try { listener(structuredClone(event)); } catch { /* Detached UI listeners cannot interrupt saving. */ } } }
  publish(outcome: OperationOutcomeV1): void {
    const preview = this.previews.get(outcome.previewId); if (!preview) fail("NOT_FOUND", "プレビューを取得し直してください。");
    const validated = validatePreviewOutcome(preview, outcome);
    this.outcomes.set(outcome.previewId, structuredClone(validated)); this.setStatus(outcome.previewId, outcome.status);
  }
  list(): readonly OperationPreviewV1[] { return [...this.previews.keys()].map((id) => this.inspect(id)!); }
  inspect(id: string): OperationPreviewV1 | undefined {
    const preview = this.previews.get(id);
    if (preview?.status === "pending" && Date.parse(preview.expiresAt) <= Date.now()) { void this.invalidate(id, "expired"); }
    return this.previews.has(id) ? structuredClone(this.previews.get(id)!) : undefined;
  }
  focusedPreviewId(): string | null { if (this.focused) this.inspect(this.focused); return this.focused; }
  inspectOutcome(id: string): OperationOutcomeV1 | undefined { const result = this.outcomes.get(id); return result ? structuredClone(result) : undefined; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(): void { for (const listener of this.listeners) { try { listener(); } catch { /* A detached view cannot interrupt saving. */ } } }
  focus(id: string | null): void { if (id) { const preview = this.inspect(id); if (!preview || !["pending", "success", "partial"].includes(preview.status)) fail("PLAN_CONSUMED", "有効な提案または保存結果を選択してください。"); } this.focused = id; this.emit(); }
  async reject(id: string): Promise<void> { const preview = this.inspect(id); if (!preview) fail("NOT_FOUND", "プレビューを取得し直してください。"); if (preview.status !== "pending") fail("PLAN_CONSUMED", "処理中または完了した提案は却下できません。"); this.callbacks.reject(id); this.setStatus(id, "rejected"); }
  requestRepreview(id: string): Promise<OperationPreviewV1> { return this.callbacks.repreview(id); }
  async getProjectionPage(_request: ProjectionPageRequestV1): Promise<ProjectionPageResultV1> {
    // This implementation returns complete snapshots, so it never issues a page cursor.
    return { status: "error", error: { code: "CURSOR_STALE", retryable: true, field: "cursor", nextAction: "このruntimeの投影は全件を含みます。inspect/inspectOutcomeで先頭snapshotを取得してください。" } };
  }
  dispose(): void { for (const id of this.previews.keys()) this.callbacks.reject(id); if (this.expiryTimer) clearTimeout(this.expiryTimer); this.previews.clear(); this.outcomes.clear(); this.focused = null; this.emit(); this.listeners.clear(); this.eventListeners.clear(); }
}
