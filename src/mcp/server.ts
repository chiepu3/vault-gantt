import { z } from "zod";
import type { Server, ServerContext, Tool, CallToolResult } from "@modelcontextprotocol/server";
import {
  DEFAULT_CAPABILITIES, contextQueryInputSchemas, contextQueryOutputSchemas, idSchema, operationErrorSchema, capabilitySchema, jsonSchema,
  type Capability, type ContextQueryId, type ContextQueryMap, type OperationErrorV1, type RequestContext,
} from "../contracts/context";
import {
  OPERATION_IDS, OPERATION_CONTRACTS, operationIdSchema, operationInputSchemas, operationOutputSchemas, operationRequestDenial,
  type OperationId, type OperationInputMap, type ReadOperationId, type WriteOperationId, type ExternalRequestOperationId,
} from "../contracts/operations";
import {
  operationPreviewSchema, operationOutcomeSchema, projectionPageRequestSchema, projectionPageResultSchema, previewStatusSchema, validatePreviewOutcome, PREVIEW_EFFECT_KINDS,
  type OperationPreviewV1,
} from "../contracts/preview";
import { historyEntryUndoStateSchema, type OperationService, type PreviewPort, type ContextReadPort, type HistoryPort } from "../contracts/ports";
import { mcpRequestContext, MCP_PROTOCOL_VERSIONS, type McpPrincipal } from "./transport-compat";
import { OVERVIEW_URI, ownsPreview, resourceTarget, validateScopedInputs } from "./resource-adapter";

export interface McpSettings {
  readonly enabled: boolean;
  readonly port: number;
  readonly secretId: string | null;
  readonly allowedOrigins: readonly string[];
}
export const DEFAULT_MCP_SETTINGS: McpSettings = Object.freeze({ enabled: false, port: 8788, secretId: null, allowedOrigins: Object.freeze([]) });
export const mcpSettingsSchema = z.object({
  enabled: z.boolean(), port: z.number().int().min(0).max(65535), secretId: z.string().min(1).nullable(),
  allowedOrigins: z.array(z.string().url().refine((value) => { try { return new URL(value).origin === value && !value.includes("*"); } catch { return false; } })),
}).strict();

export interface McpDependencies {
  readonly operations: OperationService;
  readonly previews: PreviewPort;
  readonly context: ContextReadPort;
  readonly history: HistoryPort;
  readonly vaultInstanceId: string;
  readonly principal: McpPrincipal;
  readonly isDesktop: boolean;
  /** Resolved from secret storage, or omitted to create a session-only token. */
  readonly token?: string;
}
export interface McpServerHandle {
  readonly running: boolean;
  readonly endpoint: string | null;
  /** Human settings UI only. Never include in MCP results or persisted settings. */
  readonly sessionToken: string | null;
  stop(): Promise<void>;
  /** Invalidates old token and pending MCP proposals before accepting new requests. */
  regenerateToken(): Promise<string>;
}

/** Mobile-safe entry: no Node builtin or SDK runtime is evaluated until explicitly enabled on desktop. */
export async function startMcpServer(deps: McpDependencies, settings: McpSettings = DEFAULT_MCP_SETTINGS): Promise<McpServerHandle> {
  if (!settings.enabled || !deps.isDesktop) return {
    running: false, endpoint: null, sessionToken: null, stop: async () => {},
    regenerateToken: async () => { throw new Error("MCP is disabled"); },
  };
  return (await import("./http-server")).startMcpHttpServer(deps, mcpSettingsSchema.parse(settings));
}

/** DOM-independent rows; host wires actions to human controls and secret storage. */
export function buildMcpSettingsDescription(settings: McpSettings) {
  return [
    { key: "enabled", kind: "toggle", label: "MCPを有効化", value: settings.enabled },
    { key: "port", kind: "number", label: "MCPポート", value: settings.port, min: 1, max: 65535 },
    { key: "generateToken", kind: "action", label: "トークン生成", humanOnly: true },
    { key: "regenerateToken", kind: "action", label: "トークン再生成（接続・保留提案を失効）", humanOnly: true },
    { key: "copyToken", kind: "action", label: "トークンをコピー", humanOnly: true },
    { key: "notice", kind: "text", label: "同じPCでObsidian起動中のみ利用できます。秘密ストレージ未対応時はセッション限定です。" },
  ] as const;
}

const errorResponseSchema = z.object({ error: operationErrorSchema }).strict();
const publicDescriptionSchema = z.object({
  id: operationIdSchema, classification: z.enum(["read", "view", "write", "control"]), capabilities: z.array(capabilitySchema),
  requestPolicy: z.enum(["capabilities", "direct-ui-only"]), previewKinds: z.array(z.enum(PREVIEW_EFFECT_KINDS)), available: z.boolean(), denial: operationErrorSchema.optional(),
  description: z.object({
    purpose: z.string(), targetKinds: z.array(z.string()), parameters: z.array(z.object({ name: z.string(), description: z.string(), required: z.boolean() }).strict()),
    constraints: z.array(z.string()), sideEffects: z.array(z.string()), clearSemantics: z.array(z.string()),
    examples: z.array(z.object({ input: jsonSchema, explanation: z.string() }).strict()), errors: z.array(z.string()), undo: z.string(),
  }).strict(),
}).strict();
const proposalResponseSchema = z.object({
  status: z.enum(["pending_approval", "applying", "committed", "partial", "failed", "cancelled", "rejected", "stale", "expired", "revoked"]), previewId: idSchema, expiresAt: z.string(),
  summary: operationPreviewSchema.shape.summary, descriptor: operationPreviewSchema,
  outcome: operationOutcomeSchema.nullable().optional(), undo: historyEntryUndoStateSchema.nullable().optional(),
}).strict();
const statusResponseSchema = z.object({
  status: z.enum(["pending_approval", "applying", "committed", "partial", "failed", "cancelled", "rejected", "stale", "expired", "revoked"]),
  descriptor: operationPreviewSchema, outcome: operationOutcomeSchema.nullable(), undo: historyEntryUndoStateSchema.nullable(),
}).strict();
export function protocolPreviewStatus(status: z.infer<typeof previewStatusSchema>) {
  return status === "pending" ? "pending_approval" : status === "success" ? "committed" : status;
}

class AdapterError extends Error {
  constructor(readonly dto: OperationErrorV1) { super(dto.code); }
}
function failure(code: OperationErrorV1["code"], nextAction: string, retryable = false): never {
  throw new AdapterError({ code, retryable, nextAction });
}
function errorDto(error: unknown): OperationErrorV1 {
  if (error instanceof AdapterError) return error.dto;
  const direct = operationErrorSchema.safeParse(error);
  if (direct.success) return direct.data;
  if (error instanceof z.ZodError) return { code: "RESET_REQUIRED", retryable: false, nextAction: "portが契約外の結果を返しました。Obsidian側の状態を確認してください。" };
  // Do not leak port error text, file contents, tokens or stack traces.
  return { code: "RESET_REQUIRED", retryable: false, nextAction: "状態を再取得し、Obsidian側で結果を確認してください。盲目的に提案を再送しないでください。" };
}
function jsonObject(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}
function toJsonSchema(schema: z.ZodType): Tool["inputSchema"] {
  return z.toJSONSchema(schema, { unrepresentable: "any", reused: "ref" }) as Tool["inputSchema"];
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

interface AdapterTool {
  readonly tool: Tool;
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  readonly read: boolean;
  readonly operationId?: OperationId;
  run(input: unknown, context: RequestContext): Promise<unknown>;
}

/** Shared by all per-request SDK servers of one plugin instance. Contains no approval/commit port. */
export class McpAdapter {
  private readonly capabilities: readonly Capability[];
  private readonly abort = new AbortController();
  private readonly tools = new Map<string, AdapterTool>();
  private reads = 0;
  private queuedProposals = 0;
  private proposalTail: Promise<unknown> = Promise.resolve();
  private readonly intents = new Map<string, { fingerprint: string; result: Promise<unknown> }>();
  private revoked = false;
  private readonly servers = new Set<Server>();
  private readonly expiredIds = new Set<string>();
  private readonly legacyRequests = new Map<string, { rpcId: string | number; abort: AbortController }>();

  constructor(private readonly deps: McpDependencies) {
    this.capabilities = [...(deps.principal.capabilities ?? DEFAULT_CAPABILITIES)];
    this.registerTools();
  }
  private permits(capabilities: readonly Capability[]): boolean { return capabilities.every((cap) => this.capabilities.includes(cap)); }

  private add(name: string, description: string, input: z.ZodType, output: z.ZodType, read: boolean, run: AdapterTool["run"], operationId?: OperationId) {
    const envelope = z.object({ data: output.optional(), error: operationErrorSchema.optional() }).strict();
    this.tools.set(name, {
      tool: { name, description, inputSchema: toJsonSchema(input), outputSchema: toJsonSchema(envelope),
        annotations: { readOnlyHint: read, destructiveHint: false, openWorldHint: false, idempotentHint: read },
      }, input, output, read, run, operationId,
    });
  }

  private registerTools() {
    this.add("server.identity", "認証先Vaultのinstanceと登録principalを確認します。", z.object({}).strict(),
      z.object({ vaultInstanceId: idSchema, principalId: idSchema, principalLabel: z.string(), capabilities: z.array(z.string()) }).strict(), true,
      async () => ({ vaultInstanceId: this.deps.vaultInstanceId, principalId: this.deps.principal.id, principalLabel: this.deps.principal.label, capabilities: this.capabilities }));
    this.add("operations.describe", "全操作の説明、必要権限と不許可理由。承認権限は付与しません。", z.object({}).strict(), z.object({ operations: z.array(publicDescriptionSchema) }).strict(), true, async (_input, context) => ({
      operations: [...this.deps.operations.describe()].sort((a, b) => OPERATION_IDS.indexOf(a.id) - OPERATION_IDS.indexOf(b.id)).map((description) => {
        const denial = operationRequestDenial(description.id, context.origin)
          ?? (!this.permits(OPERATION_CONTRACTS[description.id][2]) ? { code: "POLICY_DENIED", retryable: false, nextAction: "Obsidianの人間操作で必要権限を設定してください。" } as const : description.denial);
        return { ...description, available: description.available && !denial, ...(denial ? { denial } : {}) };
      }),
    }));
    if (this.permits(["read"])) {
      for (const id of Object.keys(contextQueryInputSchemas) as ContextQueryId[]) {
        this.add(id, `管理対象の ${id} を取得します。`, contextQueryInputSchemas[id], contextQueryOutputSchemas[id], true,
          async (input, context) => this.deps.context.query(id, input as ContextQueryMap[typeof id], context));
      }
    }
    for (const id of OPERATION_IDS) {
      const [classification, , caps] = OPERATION_CONTRACTS[id];
      const origin = { kind: "mcp", principalId: this.deps.principal.id, clientLabel: "MCP" } as const;
      if (!this.permits(caps) || operationRequestDenial(id, origin)) continue;
      const description = this.deps.operations.describe([id]).find((item) => item.id === id)?.description.purpose ?? id;
      if (classification === "write" || id === "Q08") {
        const input = z.object({ input: operationInputSchemas[id], callerIntentId: idSchema }).strict();
        this.add(`operations.${id}.propose`, `${id}: ${description}。提案を作成します。保存にはObsidianでの人間承認が必要です。`, input, proposalResponseSchema, false,
          async (value, context) => {
            const { input: args, callerIntentId } = value as { input: OperationInputMap[WriteOperationId | "Q08"]; callerIntentId: string };
            return this.propose(id as WriteOperationId | "Q08", args, { ...context, callerIntentId });
          }, id);
      } else if (classification === "read") {
        this.add(`operations.${id}.read`, `${id}: ${description}`, operationInputSchemas[id], operationOutputSchemas[id], true,
          async (input, context) => this.deps.operations.read(id as ReadOperationId, input as OperationInputMap[ReadOperationId], context), id);
      } else {
        this.add(`operations.${id}.request`, `${id}: ${description}。許可されたUI/制御要求。承認・commitはできません。`, operationInputSchemas[id], operationOutputSchemas[id], false,
          async (input, context) => {
            if (id === "Q07") {
              const preview = this.inspect((input as { previewId: string }).previewId, context);
              if (preview.status !== "pending" || Date.parse(preview.expiresAt) <= Date.now()) failure("PLAN_CONSUMED", "承認要求できるのは期限内の保留提案だけです。");
            }
            const result = await this.deps.operations.request(id as ExternalRequestOperationId, input as OperationInputMap[ExternalRequestOperationId], context);
            if ("previewId" in result) this.assertOwner(result, context);
            return result;
          }, id);
      }
    }
    if (this.permits(["read"]) || this.permits(["propose"])) {
      const target = z.object({ previewId: idSchema }).strict();
      this.add("previews.status", "提案状態をpollします。committedのみ保存完了を示します。", target, statusResponseSchema, true,
        async (input, context) => this.status((input as { previewId: string }).previewId, context));
      this.add("previews.projection-page", "所有する提案の固定済み投影ページを取得します。", projectionPageRequestSchema, projectionPageResultSchema, true,
        async (input, context) => {
          const request = projectionPageRequestSchema.parse(input);
          const preview = this.inspect(request.previewId, context);
          if (this.expiredIds.has(preview.previewId) || preview.status === "expired" || (preview.status === "pending" && Date.parse(preview.expiresAt) <= Date.now())) {
            failure("PLAN_EXPIRED", "期限切れの提案を再プレビューし、新しいcursorで取得してください。");
          }
          return this.deps.previews.getProjectionPage(request);
        });
    }
    if (this.permits(["propose"])) {
      this.add("previews.reject", "所有する未承認の提案を却下します。", z.object({ previewId: idSchema }).strict(), statusResponseSchema, false,
        async (input, context) => {
          const previewId = (input as { previewId: string }).previewId;
          const preview = this.inspect(previewId, context);
          if (preview.status !== "pending") failure("PLAN_CONSUMED", "開始済み・終了済みの提案は取り消せません。状態を取得してください。");
          await this.deps.previews.reject(previewId);
          return this.status(previewId, context);
        });
    }
  }

  private assertOwner(preview: OperationPreviewV1, context: RequestContext) {
    if (!ownsPreview(preview, context)) failure("POLICY_DENIED", "このVault・principalの提案だけを参照できます。");
  }
  private inspect(previewId: string, context: RequestContext): OperationPreviewV1 {
    let preview: OperationPreviewV1;
    try { preview = operationPreviewSchema.parse(this.deps.operations.inspect(previewId, context)); }
    catch (error) {
      if (error instanceof z.ZodError) throw error;
      const dto = operationErrorSchema.safeParse(error);
      if (dto.success && dto.data.code !== "NOT_FOUND") throw error;
      failure("UNKNOWN_AFTER_RESTART", "古い提案は保持されていません。対象を再取得して変更の成否を確認してください。");
    }
    this.assertOwner(preview, context);
    return preview;
  }
  private status(previewId: string, context: RequestContext) {
    const descriptor = this.inspect(previewId, context);
    const stored = this.deps.operations.inspectOutcome(previewId, context);
    const outcome = stored ? validatePreviewOutcome(descriptor, stored) : null;
    const expired = this.expiredIds.has(previewId) || (descriptor.status === "pending" && Date.parse(descriptor.expiresAt) <= Date.now());
    return {
      status: expired ? "expired" as const : protocolPreviewStatus(outcome?.status ?? descriptor.status), descriptor, outcome,
      undo: outcome?.undoEntryId ? historyEntryUndoStateSchema.parse(this.deps.history.inspectUndo(outcome.undoEntryId)) : null,
    };
  }

  private propose(id: WriteOperationId | "Q08", input: OperationInputMap[WriteOperationId | "Q08"], context: RequestContext): Promise<unknown> {
    const key = context.callerIntentId!;
    const fingerprint = canonicalJson({ id, input });
    const existing = this.intents.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) failure("INVALID_INPUT", "callerIntentIdは同じ操作・引数の再送にだけ使用してください。");
      // Reinspect before returning: never expose an old pending descriptor after approval/expiry.
      return existing.result.then((result) => {
        const previewId = (result as { previewId: string }).previewId;
        return { ...(result as Record<string, unknown>), ...this.status(previewId, context) };
      });
    }
    if (this.intents.size >= 256) failure("RESET_REQUIRED", "このMCP起動中の提案保持上限に達しました。対象状態を確認し、MCPを再起動してください。");
    if (this.queuedProposals >= 10) failure("POLICY_DENIED", "提案が混雑しています。同じcallerIntentIdで後から再試行してください。", true);
    this.queuedProposals++;
    let invoked = false;
    const result = this.proposalTail.then(async () => {
      if (this.revoked || context.signal?.aborted) failure("APP_NOT_RUNNING", "ObsidianとMCP接続を確認してください。");
      const pending = this.deps.previews.list().filter((preview) => preview.vaultInstanceId === this.deps.vaultInstanceId && preview.status === "pending");
      if (pending.length >= 50 || pending.filter((preview) => ownsPreview(preview, context)).length >= 10) failure("POLICY_DENIED", "Obsidianで保留提案を承認または却下してから再試行してください。", true);
      let expectedOperationId: OperationId = id;
      if (id === "Q08") {
        const original = this.inspect((input as { previewId: string }).previewId, context);
        const denial = operationRequestDenial(original.operationId, context.origin);
        if (denial) throw new AdapterError(denial);
        if (!this.permits(OPERATION_CONTRACTS[original.operationId][2])) failure("POLICY_DENIED", "再提案にも元操作の権限が必要です。Obsidian側の設定を確認してください。");
        expectedOperationId = original.operationId;
      }
      invoked = true;
      const preview = operationPreviewSchema.parse(id === "Q08"
        ? await this.deps.operations.request(id, input as OperationInputMap["Q08"], context)
        : await this.deps.operations.propose(id, input as OperationInputMap[WriteOperationId], context));
      this.assertOwner(preview, context);
      if (preview.operationId !== expectedOperationId || preview.status !== "pending" || Date.parse(preview.expiresAt) > Date.now() + 600_000 || Date.parse(preview.expiresAt) <= Date.now()) {
        if (preview.status === "pending") await (this.deps.previews.invalidate ? this.deps.previews.invalidate(preview.previewId, "expired") : this.deps.previews.reject(preview.previewId));
        failure("RESET_REQUIRED", "提案portは操作ID一致・pending・10分以内の期限を返す必要があります。");
      }
      if (this.revoked) {
        await this.deps.previews.reject(preview.previewId);
        failure("APP_NOT_RUNNING", "取消済みの提案は保存されません。接続を確認してください。");
      }
      // The port owns cancellation before registration. Once registered, retain
      // the proposal even if its request disconnected; only explicit reject or
      // plugin/token invalidation cancels it. Intent replay recovers the lost reply.
      return { status: "pending_approval" as const, previewId: preview.previewId, expiresAt: preview.expiresAt, summary: preview.summary, descriptor: preview };
    }).catch((error: unknown) => {
      // A refusal before the port call is safe to retry. Once invoked, retain the
      // rejected intent too: an uncertain port result must never trigger a second plan.
      if (!invoked && this.intents.get(key)?.result === result) this.intents.delete(key);
      throw error;
    }).finally(() => { this.queuedProposals--; });
    this.proposalTail = result.catch(() => {});
    this.intents.set(key, { fingerprint, result });
    return result;
  }

  private context(ctx: ServerContext, track = false): RequestContext {
    const legacyAbort = new AbortController();
    const context = mcpRequestContext(this.deps.vaultInstanceId, this.deps.principal, this.capabilities, ctx,
      AbortSignal.any([ctx.mcpReq.envelope ? ctx.mcpReq.signal : legacyAbort.signal, this.abort.signal]));
    if (track && !ctx.mcpReq.envelope) this.legacyRequests.set(context.requestId, { rpcId: ctx.mcpReq.id, abort: legacyAbort });
    return context;
  }
  private async withRead<T>(read: boolean, run: () => Promise<T>): Promise<T> {
    if (this.revoked) failure("APP_NOT_RUNNING", "ObsidianでMCPを起動してください。");
    if (read && this.reads >= 4) failure("POLICY_DENIED", "同時読み取りは4件までです。後から再試行してください。", true);
    if (read) this.reads++;
    try { return await run(); } finally { if (read) this.reads--; }
  }

  async createProtocolServer(): Promise<Server> {
    const { Server } = await import("@modelcontextprotocol/server");
    const server = new Server({ name: "vault-gantt", version: "1.0.0", title: this.deps.principal.label }, {
      supportedProtocolVersions: [...MCP_PROTOCOL_VERSIONS], capabilities: { tools: {}, resources: {} },
      instructions: `Vault instance: ${this.deps.vaultInstanceId}. Writes require Obsidian human approval. Poll previews.status. Never blindly replay after restart.`,
    });
    this.servers.add(server);
    server.onclose = () => this.servers.delete(server);
    // Stateless legacy requests use fresh SDK instances. Route explicit cancellation
    // across those instances, under this authenticated Vault/principal only. A bare
    // HTTP disconnect does not cancel a 2025 request. Ambiguous colliding ids are ignored.
    server.setNotificationHandler("notifications/cancelled", (notification) => {
      const matching = [...this.legacyRequests.values()].filter((request) => request.rpcId === notification.params.requestId);
      if (matching.length === 1) matching[0].abort.abort();
    });
    server.setRequestHandler("tools/list", async () => ({ tools: [...this.tools.values()].filter((item) => !item.operationId
      || this.deps.operations.describe([item.operationId]).some((description) => description.id === item.operationId && description.available && !description.denial)).map((item) => item.tool) }));
    server.setRequestHandler("tools/call", async (request, ctx): Promise<CallToolResult> => {
      let context: RequestContext | undefined;
      try {
        context = this.context(ctx, true);
        const clientVersion = server.getClientVersion();
        if (context.origin.kind === "mcp" && context.origin.clientLabel === "legacy MCP client" && clientVersion) {
          Object.assign(context, { origin: { ...context.origin, clientLabel: clientVersion.name.slice(0, 200) } });
        }
        const match = /^operations\.([A-Z]\d{2})\./.exec(request.params.name);
        if (match) {
          const id = operationIdSchema.parse(match[1]);
          const denial = operationRequestDenial(id, context.origin);
          if (denial) throw new AdapterError(denial);
          if (!this.permits(OPERATION_CONTRACTS[id][2])) failure("POLICY_DENIED", "必要な権限がありません。Obsidian側の設定を確認してください。");
        }
        const item = this.tools.get(request.params.name);
        if (!item) failure("POLICY_DENIED", "公開されたtools/listから操作を選んでください。承認・commitはMCPから実行できません。");
        if (item.operationId) {
          const description = this.deps.operations.describe([item.operationId]).find((description) => description.id === item.operationId);
          if (description?.denial) throw new AdapterError(description.denial);
          if (!description?.available) failure("POLICY_DENIED", "この操作は現在利用できません。Obsidian側の機能設定を確認してください。");
        }
        const parsedInput = item.input.safeParse(request.params.arguments ?? {});
        if (!parsedInput.success) failure("INVALID_INPUT", "公開された入力schemaを確認してください。");
        const input = parsedInput.data;
        try { validateScopedInputs(input); } catch { failure("INVALID_INPUT", "対象は管理対象Vault内の相対IDで指定してください。"); }
        const value = await this.withRead(item.read, () => item.run(input, context!));
        const parsed = item.output.safeParse(value);
        if (!parsed.success) failure("RESET_REQUIRED", "portが契約外の結果を返しました。Obsidian側の状態を確認してください。");
        const isError = !!(parsed.data && typeof parsed.data === "object" && "status" in parsed.data && parsed.data.status === "error");
        return { content: [{ type: "text", text: isError ? "取得できませんでした。structuredContentを確認してください。" : "結果をstructuredContentに返しました。保存状態はpreviews.statusで確認できます。" }], structuredContent: { data: jsonObject(parsed.data) }, ...(isError ? { isError: true } : {}) };
      } catch (error) {
        const dto = errorDto(error);
        return { isError: true, content: [{ type: "text", text: `${dto.code}: ${dto.nextAction}` }], structuredContent: errorResponseSchema.parse({ error: dto }) };
      } finally { if (context) this.legacyRequests.delete(context.requestId); }
    });
    server.setRequestHandler("resources/list", async (_request, ctx) => {
      const context = this.context(ctx);
      return { resources: [
        ...(this.permits(["read"]) ? [{ uri: OVERVIEW_URI, name: "context.overview", mimeType: "application/json" }] : []),
        ...[...this.deps.previews.list()].filter((preview) => ownsPreview(preview, context) && (this.permits(["read"]) || this.permits(["propose"]))).sort((a, b) => a.previewId.localeCompare(b.previewId))
          .map((preview) => ({ uri: `vault-gantt://previews/${encodeURIComponent(preview.previewId)}`, name: preview.previewId, mimeType: "application/json" })),
      ] };
    });
    server.setRequestHandler("resources/templates/list", async () => ({ resourceTemplates: this.permits(["read"])
      ? [{ uriTemplate: "vault-gantt://tasks/{encoded-id}", name: "tasks.get-many", mimeType: "application/json" }] : [] }));
    server.setRequestHandler("resources/read", async (request, ctx) => {
      const context = this.context(ctx, true);
      let value: unknown;
      try {
        let target: ReturnType<typeof resourceTarget>;
        try { target = resourceTarget(request.params.uri); } catch { failure("INVALID_INPUT", "管理対象のvault-gantt resource URIを指定してください。"); }
        value = await this.withRead(true, async () => {
          if (target.kind === "preview") {
            if (!this.permits(["read"]) && !this.permits(["propose"])) failure("POLICY_DENIED", "提案参照権限がありません。");
            return statusResponseSchema.parse(this.status(target.previewId, context));
          }
          if (!this.permits(["read"])) failure("POLICY_DENIED", "読み取り権限がありません。");
          return contextQueryOutputSchemas[target.id].parse(await this.deps.context.query(target.id, target.input, context));
        });
      } catch (error) { value = { error: errorDto(error) }; }
      finally { this.legacyRequests.delete(context.requestId); }
      return { contents: [{ uri: request.params.uri, mimeType: "application/json", text: JSON.stringify(value) }] };
    });
    return server;
  }

  async rejectExpired(): Promise<void> {
    for (const preview of this.deps.previews.list()) {
      if (preview.status === "pending" && preview.vaultInstanceId === this.deps.vaultInstanceId && preview.origin.kind === "mcp"
        && preview.origin.principalId === this.deps.principal.id && Date.parse(preview.expiresAt) <= Date.now()) {
        // Bound adapter status bookkeeping, independently of the application store.
        if (this.expiredIds.size < 256) this.expiredIds.add(preview.previewId);
        await this.deps.previews.reject(preview.previewId);
      }
    }
  }
  async revoke(): Promise<void> {
    this.revoked = true;
    this.abort.abort();
    const errors: unknown[] = [];
    await Promise.all([...this.servers].map(async (server) => { try { await server.close(); } catch (error) { errors.push(error); } }));
    for (const preview of this.deps.previews.list()) {
      if (preview.status === "pending" && preview.vaultInstanceId === this.deps.vaultInstanceId && preview.origin.kind === "mcp"
        && preview.origin.principalId === this.deps.principal.id) {
        try { await (this.deps.previews.invalidate ? this.deps.previews.invalidate(preview.previewId, "revoked") : this.deps.previews.reject(preview.previewId)); } catch (error) { errors.push(error); }
      }
    }
    this.intents.clear();
    this.expiredIds.clear();
    if (errors.length) throw errors[0];
  }
}
