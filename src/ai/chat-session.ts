import type { OperationPreviewV1 } from "../contracts/preview";
import type { WriteOperationId } from "../contracts/operations";
import type { OperationService } from "../app/operation-service";
import type { ModelMessage } from "ai";
import { completionText, type ChatCompletion } from "./chat-completion";
import type { OperationName, OperationPlan, OperationRegistry, OperationResult } from "../app/operation-registry";

export interface ConnectionConfig {
  provider: "disconnected" | "openai-compatible";
  endpoint: string;
  model: string;
  auth: "secret" | "none";
  secretId: string;
}
export type ChatEvent = { type: "text"; text: string } | { type: "plan"; plan: OperationPlan; operation: OperationName; input: unknown; preview?: OperationPreviewV1; operationId?: WriteOperationId } | { type: "context"; messages: ModelMessage[] } | { type: "completion"; completion: ChatCompletion };
export interface ChatRequest { config: ConnectionConfig; messages: ModelMessage[]; signal: AbortSignal; conversationId?: string }
export interface ChatProvider {
  connected(config: ConnectionConfig): boolean;
  stream(request: ChatRequest): AsyncIterable<ChatEvent>;
}
export type ChatStatus = "idle" | "running" | "preview" | "failed" | "cancelled";
export interface Proposal { preview?: OperationPreviewV1; operationId?: WriteOperationId; plan: OperationPlan; operation: OperationName; input: unknown; result?: OperationResult; consumed: boolean; retryPrepared?: boolean }
export interface ChatMessage { completion?: ChatCompletion; role: "user" | "assistant"; text: string; proposals: Proposal[] }
export interface Conversation { completion?: ChatCompletion; id: string; title: string; messages: ChatMessage[]; context: ModelMessage[]; status: ChatStatus; error: string; draft: string }
const emptyConfig = (): ConnectionConfig => ({ provider: "disconnected", endpoint: "", model: "", auth: "secret", secretId: "" });

// Owned by one plugin/vault instance, never saved to plugin data or browser storage.
export class ChatSession {
  config = emptyConfig();
  readonly conversations: Conversation[] = [];
  active!: Conversation;
  private counter = 0;
  private controller?: AbortController;
  private readonly owners = new WeakMap<Conversation, AbortController>();
  private disposed = false;
  private unsubscribePreviews?: () => void;
  private readonly recordedOutcomes = new Set<string>();
  private readonly listeners = new Set<() => void>();
  constructor(readonly scope: object, private readonly registry: Pick<OperationRegistry, "plan" | "commit" | "discard">, private readonly provider: ChatProvider, private readonly changed: (result: OperationResult) => void = () => undefined, private readonly operationService?: OperationService) { this.newConversation(); this.unsubscribePreviews = operationService?.previewPort.subscribe(() => this.observeOutcomes()); }
  private observeOutcomes(): void {
    if (this.disposed || !this.operationService) return;
    for (const conversation of this.conversations) {
      const proposals = conversation.messages.flatMap((message) => message.proposals);
      for (const preview of this.operationService.previewPort.list().filter((preview) => preview.origin.kind === "chat" && preview.origin.conversationId === conversation.id)) {
        const outcome = this.operationService.previewPort.inspectOutcome(preview.previewId);
        if (outcome && !this.recordedOutcomes.has(preview.previewId)) {
          this.recordedOutcomes.add(preview.previewId);
          // Direct confirm already records its result. Cards/repreviews must record actual saved effects too.
          if (!proposals.some((proposal) => proposal.plan.previewId === preview.previewId && proposal.consumed)) {
            const { actualProjection: _projection, ...receipt } = outcome; void _projection;
            conversation.context.push({ role: "user", content: "人間の承認後の実保存結果: " + JSON.stringify(receipt) });
          }
        }
      }
      while (this.recordedOutcomes.size > 100) this.recordedOutcomes.delete(this.recordedOutcomes.values().next().value!);
      for (const proposal of proposals) {
        if (proposal.consumed) continue;
        const id = proposal.plan.previewId, outcome = this.operationService.previewPort.inspectOutcome(id);
        if (outcome) {
          proposal.consumed = true;
        } else {
          const preview = this.operationService.previewPort.inspect(id);
          if (preview && ["rejected", "stale", "expired", "revoked"].includes(preview.status)) proposal.consumed = true;
        }
      }
      if (conversation.status === "preview" && proposals.length && proposals.every((proposal) => proposal.consumed)) conversation.status = "idle";
    }
    this.emit();
  }
  get connected(): boolean { return this.provider.connected(this.config); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(): void { for (const listener of this.listeners) listener(); }
  configure(config: ConnectionConfig): void {
    if (this.active.status === "running") this.stop();
    this.config = { ...config };
    this.emit();
  }
  select(id: string): void {
    const target = this.conversations.find((item) => item.id === id);
    if (!target || target === this.active) return;
    this.stop(); this.active = target; this.emit();
  }
  newConversation(): void {
    this.stop();
    const conversation: Conversation = { id: String(++this.counter), title: "新しい会話", messages: [], context: [], status: "idle", error: "", draft: "" };
    this.conversations.push(conversation);
    while (this.conversations.length > 10) this.discard(this.conversations.shift()!);
    this.active = conversation;
    this.emit();
  }
  private discard(conversation: Conversation): void {
    for (const message of conversation.messages) for (const proposal of message.proposals) if (!proposal.consumed) this.registry.discard(proposal.plan.previewId);
  }
  stop(): void {
    this.controller?.abort();
    this.controller = undefined;
    if (this.active?.status === "running") { this.active.status = "cancelled"; this.active.error = "停止しました。保存済みの変更は戻しません。"; }
    this.emit();
  }
  async send(text: string): Promise<void> {
    const conversation = this.active;
    if (conversation.status === "running" || !text.trim()) return;
    if (!this.connected) { conversation.status = "failed"; conversation.error = "未接続です。接続先・モデル・既存の認証設定を確認してください。"; this.emit(); return; }
    if (conversation.messages.length >= 100) { conversation.error = "会話の上限です。新しい会話を開始してください。"; this.emit(); return; }
    const controller = new AbortController(); this.controller = controller; this.owners.set(conversation, controller);
    conversation.status = "running"; conversation.error = ""; conversation.draft = ""; conversation.completion = undefined;
    conversation.title = text.trim().slice(0, 32);
    conversation.messages.push({ role: "user", text, proposals: [] });
    const assistant: ChatMessage = { role: "assistant", text: "", proposals: [] };
    conversation.messages.push(assistant);
    const contextLength = conversation.context.length;
    const messages: ModelMessage[] = [...conversation.context, { role: "user", content: text }];
    this.emit();
    try {
      let context: ModelMessage[] | undefined;
      for await (const event of this.provider.stream({ config: { ...this.config }, messages, signal: controller.signal, conversationId: conversation.id })) {
        if (controller.signal.aborted) {
          if (event.type === "plan") this.registry.discard(event.plan.previewId);
          break;
        }
        if (event.type === "text") {
          assistant.text += event.text;
          if (assistant.text.length > 100000) throw new Error("RESPONSE_LIMIT");
        }
        if (event.type === "plan" && !assistant.proposals.some((proposal) => proposal.plan.previewId === event.plan.previewId)) assistant.proposals.push({ preview: event.preview, operationId: event.operationId, plan: event.plan, operation: event.operation, input: event.input, consumed: false });
        if (event.type === "context") context = event.messages;
        if (event.type === "completion") assistant.completion = conversation.completion = event.completion;
        this.emit();
      }
      if (controller.signal.aborted) this.discardMessage(assistant);
      if (this.owners.get(conversation) === controller) {
        if (controller.signal.aborted) { conversation.status = "cancelled"; conversation.completion = assistant.completion = { kind: "cancelled", proposalIds: [], toolErrors: 0 }; }
        else {
          const outcomes = conversation.context.slice(contextLength);
          conversation.context = [...messages, ...(context ?? [{ role: "assistant" as const, content: assistant.text }]), ...outcomes];
          assistant.completion ??= { kind: assistant.proposals.length ? "proposal-created" : "no-proposal", proposalIds: assistant.proposals.map((proposal) => proposal.plan.previewId), toolErrors: 0 };
          conversation.completion = assistant.completion;
          conversation.status = assistant.proposals.length ? "preview" : ["timeout", "connection-error"].includes(assistant.completion.kind) ? "failed" : "idle";
          if (conversation.status === "failed") conversation.error = completionText[assistant.completion.kind];
        }
      }
    } catch {
      const cancelled = controller.signal.aborted;
      controller.abort();
      if (this.owners.get(conversation) === controller) {
        conversation.completion = assistant.completion = { kind: cancelled ? "cancelled" : "connection-error", proposalIds: [], toolErrors: 0 };
        conversation.status = cancelled ? "cancelled" : "failed";
        conversation.error = cancelled ? "停止しました。保存済みの変更は戻しません。" : "応答に失敗しました。認証・モデル・接続先を確認して再試行してください。";
      }
      this.discardMessage(assistant);
    } finally {
      if (this.controller === controller) this.controller = undefined;
      this.emit();
    }
  }
  private discardMessage(message: ChatMessage): void {
    for (const proposal of message.proposals) { this.registry.discard(proposal.plan.previewId); proposal.consumed = true; }
  }
  async retry(): Promise<void> {
    const last = [...this.active.messages].reverse().find((message) => message.role === "user");
    if (last) await this.send(last.text);
  }
  async repreview(proposal: Proposal): Promise<void> {
    const conversation = this.active;
    const message = conversation.messages.find((item) => item.proposals.includes(proposal));
    if (conversation.status === "running" || !message || proposal.retryPrepared) return;
    if (proposal.result && proposal.result.committed >= proposal.result.total) return;
    proposal.retryPrepared = true;
    const controller = new AbortController(); this.controller = controller; this.owners.set(conversation, controller);
    conversation.status = "running"; this.emit();
    try {
      let input = proposal.input;
      if (proposal.result?.committed && ["schedule-batch", "update-batch"].includes(proposal.operation)) {
        const committed = new Set(proposal.result.diffs.map((diff) => diff.taskId));
        const original = input as { changes: { taskId: string; patch: unknown }[] };
        input = { changes: original.changes.filter((change) => !committed.has(change.taskId)) };
      }
      // A new preview refreshes preconditions; the original commit guards remain intact.
      if (proposal.operation === "update") { const { expectedRevision: _revision, ...fresh } = input as Record<string, unknown>; void _revision; input = fresh; }
      if (["schedule-batch", "update-batch"].includes(proposal.operation)) {
        input = { changes: (input as { changes: Record<string, unknown>[] }).changes.map(({ expectedRevision: _revision, ...fresh }) => { void _revision; return fresh; }) };
      }
      const preview = proposal.operationId && this.operationService ? await this.operationService.previewPort.requestRepreview(proposal.plan.previewId) : undefined;
      const plan = preview ? this.operationService!.legacyPlan(preview, proposal.operation) : await this.registry.plan(proposal.operation, input);
      if (controller.signal.aborted || this.owners.get(conversation) !== controller) { this.registry.discard(plan.previewId); throw new Error("CANCELLED"); }
      this.registry.discard(proposal.plan.previewId);
      message.proposals.push({ plan, preview, operationId: proposal.operationId, operation: proposal.operation, input, consumed: false });
      conversation.status = "preview"; conversation.error = "";
    } catch {
      proposal.retryPrepared = false;
      if (this.owners.get(conversation) === controller) { conversation.status = controller.signal.aborted ? "cancelled" : "failed"; conversation.error = "再プレビューできません。対象タスクや入力を確認してください。"; }
    } finally { if (this.controller === controller) this.controller = undefined; this.emit(); }
  }
  async confirm(proposal: Proposal): Promise<void> {
    if (proposal.consumed || this.active.status === "running") return;
    const conversation = this.active;
    const controller = new AbortController(); this.controller = controller; this.owners.set(conversation, controller);
    proposal.consumed = true; conversation.status = "running"; this.emit();
    try {
      const result = await this.registry.commit(proposal.plan.previewId, controller.signal);
      proposal.result = result;
      // Record actual outcomes, never tell a later model that an unconfirmed preview was committed.
      conversation.context.push({ role: "user", content: "操作の実際の結果: " + JSON.stringify({ kind: result.kind, committed: result.committed, total: result.total, diffs: result.diffs }) });
      if (this.owners.get(conversation) === controller) {
        conversation.status = result.kind === "success" ? "idle" : result.kind === "cancelled" ? "cancelled" : "failed";
        conversation.error = result.kind === "success" ? "" : result.message;
      }
      if (result.committed && !this.disposed) this.changed(result);
    } catch {
      if (this.owners.get(conversation) === controller) { conversation.status = "failed"; conversation.error = "プレビューが失効しました。再プレビューしてください。"; }
    }
    finally { if (this.controller === controller) this.controller = undefined; this.emit(); }
  }
  dispose(): void { this.unsubscribePreviews?.(); this.unsubscribePreviews = undefined; this.disposed = true; this.stop(); for (const conversation of this.conversations) this.discard(conversation); this.listeners.clear(); this.config = emptyConfig(); }
}
