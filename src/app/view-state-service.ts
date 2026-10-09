import type { UiPort, ViewStateV1 } from "../contracts/ports";
import { operationInputSchemas, operationOutputSchemas, type ViewOperationId, type OperationInputMap, type OperationOutputMap } from "../contracts/operations";
import type { OperationRequestResultV1 } from "../contracts/preview";
import type { PreviewPort } from "../contracts/ports";
/** View callbacks are supplied by their owning UI track at integration. No synthetic view IDs. */
export class ViewStateService implements UiPort {
  private readonly views = new Map<string, { read: () => ViewStateV1; request?: (id: ViewOperationId, input: unknown) => Promise<OperationRequestResultV1> }>();
  constructor(private readonly previews: PreviewPort, private readonly openApproval?: (previewId: string) => Promise<void>, private readonly globalRequest?: (id: ViewOperationId, input: unknown) => Promise<OperationRequestResultV1>) {}
  register(viewId: string, read: () => ViewStateV1, request?: (id: ViewOperationId, input: unknown) => Promise<OperationRequestResultV1>): () => void {
    const entry = { read, request }; this.views.set(viewId, entry);
    return () => { if (this.views.get(viewId) === entry) this.views.delete(viewId); };
  }
  listViews(): readonly ViewStateV1[] { return [...this.views.values()].map((entry) => structuredClone(entry.read())); }
  inspectView(viewId: string): ViewStateV1 | undefined { const entry = this.views.get(viewId); return entry ? structuredClone(entry.read()) : undefined; }
  async request<K extends ViewOperationId>(id: K, input: OperationInputMap[K]): Promise<OperationOutputMap[K]> {
    const args = operationInputSchemas[id].parse(input) as { viewId?: string };
    const handler = args.viewId ? this.views.get(args.viewId)?.request : this.globalRequest;
    const result = handler ? await handler(id, input) : { schemaVersion: 1, resultKind: "request", operationId: id, status: "unavailable", effects: [], error: { code: "UI_UNAVAILABLE", retryable: false, nextAction: "対象ビューが開いていないか、この表示操作に対応していません。対象ビューを開いてください。" } };
    return operationOutputSchemas[id].parse(result);
  }
  async requestApproval(previewId: string): Promise<OperationRequestResultV1> {
    this.previews.focus(previewId);
    await this.openApproval?.(previewId);
    return { schemaVersion: 1, resultKind: "request", operationId: "Q07", status: "requested", effects: [{ kind: "conversation", action: "request-approval", before: null, after: { previewId } }] };
  }
}
