/* eslint-disable @typescript-eslint/no-explicit-any */
import type { HistoryEntryUndoStateV1, HumanApprovalPort, HistoryPort, PreviewPort, PreviewUiHostPorts, UiPort } from "../../src/contracts/ports";
import type { OperationOutcomeV1, OperationPreviewV1, ProjectionPageRequestV1, ProjectionPageResultV1 } from "../../src/contracts/preview";

/** In-memory PreviewPort. Business logic is out of scope; it only stores what the tests give it. */
export class FakePreviewPort implements PreviewPort {
  readonly previews = new Map<string, OperationPreviewV1>();
  readonly outcomes = new Map<string, OperationOutcomeV1>();
  focused: string | null = null;
  readonly focusCalls: (string | null)[] = [];
  readonly rejected: string[] = [];
  readonly reprevied: string[] = [];
  readonly pageRequests: ProjectionPageRequestV1[] = [];
  pageResults: ProjectionPageResultV1[] = [];
  repreviewResult?: OperationPreviewV1;
  private readonly listeners = new Set<() => void>();
  constructor(previews: readonly OperationPreviewV1[] = []) { for (const preview of previews) this.previews.set(preview.previewId, preview); }
  list(): readonly OperationPreviewV1[] { return [...this.previews.values()]; }
  inspect(previewId: string): OperationPreviewV1 | undefined { return this.previews.get(previewId); }
  focusedPreviewId(): string | null { return this.focused; }
  inspectOutcome(previewId: string): OperationOutcomeV1 | undefined { return this.outcomes.get(previewId); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  focus(previewId: string | null): void { this.focusCalls.push(previewId); this.focused = previewId; this.emit(); }
  async reject(previewId: string): Promise<void> { this.rejected.push(previewId); const p = this.previews.get(previewId); if (p) this.previews.set(previewId, { ...p, status: "rejected" }); this.emit(); }
  async requestRepreview(previewId: string): Promise<OperationPreviewV1> {
    this.reprevied.push(previewId);
    const next = this.repreviewResult ?? { ...this.previews.get(previewId)!, previewId: previewId + ":again", status: "pending" as const };
    this.previews.set(next.previewId, next); this.emit(); return next;
  }
  async getProjectionPage(request: ProjectionPageRequestV1): Promise<ProjectionPageResultV1> {
    this.pageRequests.push(request);
    const next = this.pageResults.shift();
    if (!next) throw new Error("no page prepared");
    return next;
  }
  emit(): void { for (const listener of [...this.listeners]) listener(); }
  set(preview: OperationPreviewV1, outcome?: OperationOutcomeV1): void { this.previews.set(preview.previewId, preview); if (outcome) this.outcomes.set(preview.previewId, outcome); this.emit(); }
}
export class FakeHistory implements HistoryPort {
  states = new Map<string, HistoryEntryUndoStateV1>();
  private readonly listeners = new Set<(change: any) => void>();
  inspectUndo(entryId: string): HistoryEntryUndoStateV1 { return this.states.get(entryId) ?? { entryId, historyRevision: "history-1", state: "available", reason: null }; }
  subscribe(listener: (change: any) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  emit(): void { for (const listener of this.listeners) listener({ historyRevision: "history-2", changedEntryIds: null }); }
}
export function fakePorts(previews: readonly OperationPreviewV1[] = []): PreviewUiHostPorts & { previewPort: FakePreviewPort; historyPort: FakeHistory; approved: string[]; approve: { resolve?: (outcome: OperationOutcomeV1) => void; fail?: Error } } {
  const previewPort = new FakePreviewPort(previews); const approved: string[] = []; const approve: { resolve?: (outcome: OperationOutcomeV1) => void; fail?: Error } = {};
  const humanApprovalPort: HumanApprovalPort = {
    async approve(previewId) {
      approved.push(previewId);
      if (approve.fail) throw approve.fail;
      const preview = previewPort.previews.get(previewId)!;
      const outcome: OperationOutcomeV1 = { previewId, status: "success", actions: preview.entries.map((entry) => ({ actionId: entry.actionId, state: "committed", actual: entry.effects })), actualProjection: structuredClone(preview.projection), undoEntryId: "undo-1" };
      previewPort.set({ ...preview, status: "success" }, outcome);
      return outcome;
    },
  };
  const uiPort: UiPort = { listViews: () => [], inspectView: () => undefined, request: async () => { throw new Error("not used"); }, requestApproval: async () => { throw new Error("not used"); } };
  return { previewPort, humanApprovalPort, uiPort, historyPort: new FakeHistory(), approved, approve };
}
