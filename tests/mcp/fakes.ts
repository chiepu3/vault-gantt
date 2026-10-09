import { vi } from "vitest";
import type { ContextQueryId, ContextQueryMap, ContextQueryResult, RequestContext, Capability } from "../../src/contracts/context";
import { OPERATION_IDS, OPERATION_CONTRACTS, type OperationId, type OperationInputMap, type OperationOutputMap, type ReadOperationId, type WriteOperationId, type ExternalRequestOperationId } from "../../src/contracts/operations";
import type { OperationPreviewV1, OperationOutcomeV1 } from "../../src/contracts/preview";
import type { OperationService, PreviewPort, ContextReadPort, HistoryPort, PublicOperationDescription } from "../../src/contracts/ports";
import type { McpDependencies } from "../../src/mcp/server";
import { CONTEXT_QUERY_OUTPUT_FIXTURES, READ_FIXTURES } from "../contracts/fixtures";

export function createFakeMcp(capabilities?: readonly Capability[]) {
  const previews = new Map<string, OperationPreviewV1>();
  const outcomes = new Map<string, OperationOutcomeV1>();
  const contexts: RequestContext[] = [];
  const calls = { propose: vi.fn(), request: vi.fn(), read: vi.fn(), query: vi.fn(), reject: vi.fn(), projection: vi.fn(), undo: vi.fn() };
  const hooks: {
    propose?: (id: WriteOperationId, input: OperationInputMap[WriteOperationId], context: RequestContext) => Promise<OperationPreviewV1>;
    query?: (id: ContextQueryId, input: ContextQueryMap[ContextQueryId], context: RequestContext) => Promise<unknown>;
  } = {};
  const makePreview = (id: OperationId, context: RequestContext): OperationPreviewV1 => ({
    schemaVersion: 1, previewId: `preview-${previews.size + 1}`, vaultInstanceId: context.vaultInstanceId, operationId: id,
    origin: context.origin, status: "pending", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 599_000).toISOString(),
    summary: { targetCount: 0, actionCount: 0 }, entries: [], warnings: [], undo: { support: "none" }, projection: null,
  });
  const operations: OperationService = {
    describe(ids = OPERATION_IDS) {
      return ids.map((id): PublicOperationDescription => ({
        id, classification: OPERATION_CONTRACTS[id][0], capabilities: OPERATION_CONTRACTS[id][2], requestPolicy: id === "V14" ? "direct-ui-only" : "capabilities",
        previewKinds: OPERATION_CONTRACTS[id][1], available: true,
        description: { purpose: `${id} description`, targetKinds: [], parameters: [], constraints: [], sideEffects: [], clearSemantics: [], examples: [], errors: [], undo: "none" },
      } as PublicOperationDescription));
    },
    async read<K extends ReadOperationId>(id: K, input: OperationInputMap[K], context: RequestContext): Promise<OperationOutputMap[K]> {
      contexts.push(context); calls.read(id, input, context);
      return (id === "D01" ? READ_FIXTURES.daily : READ_FIXTURES.tasks) as unknown as OperationOutputMap[K];
    },
    async propose<K extends WriteOperationId>(id: K, input: OperationInputMap[K], context: RequestContext) {
      contexts.push(context); calls.propose(id, input, context);
      const preview = hooks.propose ? await hooks.propose(id, input, context) : makePreview(id, context);
      previews.set(preview.previewId, preview);
      return preview;
    },
    async request<K extends ExternalRequestOperationId>(id: K, input: OperationInputMap[K], context: RequestContext): Promise<OperationOutputMap[K]> {
      contexts.push(context); calls.request(id, input, context);
      if (id === "Q08") {
        const original = previews.get((input as { previewId: string }).previewId)!;
        const preview = makePreview(original.operationId, context);
        previews.set(preview.previewId, preview);
        return preview as OperationOutputMap[K];
      }
      return { schemaVersion: 1, resultKind: "request", operationId: id, status: "requested", effects: [] } as unknown as OperationOutputMap[K];
    },
    inspect(id) {
      const preview = previews.get(id);
      if (!preview) throw { code: "NOT_FOUND", retryable: false, nextAction: "再取得" };
      return preview;
    },
  };
  const previewPort: PreviewPort = {
    list: () => [...previews.values()], inspect: (id) => previews.get(id), focusedPreviewId: () => null,
    inspectOutcome: (id) => outcomes.get(id), subscribe: () => () => {}, focus: () => {},
    reject: async (id) => { calls.reject(id); const preview = previews.get(id); if (preview?.status === "pending") previews.set(id, { ...preview, status: "rejected" }); },
    requestRepreview: async () => { throw new Error("not used"); },
    getProjectionPage: async (request) => { calls.projection(request); return { status: "error", error: { code: "CURSOR_STALE", retryable: true, nextAction: "再取得" } }; },
  };
  const contextPort: ContextReadPort = {
    async query<K extends ContextQueryId>(id: K, input: ContextQueryMap[K], context: RequestContext): Promise<ContextQueryResult<K>> {
      contexts.push(context); calls.query(id, input, context);
      return (hooks.query ? await hooks.query(id, input, context) : { status: "success", result: CONTEXT_QUERY_OUTPUT_FIXTURES[id] }) as ContextQueryResult<K>;
    },
  };
  const history: HistoryPort = {
    inspectUndo: (entryId) => { calls.undo(entryId); return { entryId, historyRevision: "history-1", state: "available", reason: null }; },
    subscribe: () => () => {},
  };
  const deps: McpDependencies = { operations, previews: previewPort, context: contextPort, history,
    vaultInstanceId: "vault-test", principal: { id: "principal-test", label: "Registered test client", capabilities }, isDesktop: true,
  };
  return { deps, previews, outcomes, calls, contexts, hooks, makePreview };
}
