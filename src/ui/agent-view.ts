import { ItemView } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import { ChatSession, Proposal } from "../ai/chat-session";
import type { OperationResult, TaskDiff } from "../app/operation-registry";

export const VIEW_TYPE_AI_CHAT = "vault-gantt-ai-chat";
export interface AgentViewHost {
  session: ChatSession;
  secretIds(): string[];
  openGantt(): Promise<void> | void;
  undo(result: OperationResult): Promise<void> | void;
  canUndo(result: OperationResult): boolean;
}
const fieldNames: Record<string, string> = { plannedStartDate: "開始日", plannedEndDate: "終了日", dueDate: "期限", notes: "メモ", displayName: "表示名", title: "名前", create: "作成" };
export function diffText(diffs: TaskDiff[]): string {
  return diffs.map((diff) => diff.name + "\n" + diff.fields.map((field) => (fieldNames[field.field] ?? field.field) + ": " + display(field.before) + " → " + display(field.after)).join("\n")).join("\n\n");
}
function display(value: unknown): string { return value === "" || value == null ? "未設定" : typeof value === "string" ? value : JSON.stringify(value); }

export class AgentView extends ItemView {
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private messagesEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private conversationsEl!: HTMLSelectElement;
  private inputEl!: HTMLTextAreaElement;
  private sendEl!: HTMLButtonElement;
  private stopEl!: HTMLButtonElement;
  private retryEl!: HTMLButtonElement;
  constructor(leaf: WorkspaceLeaf, private readonly host: AgentViewHost) { super(leaf); }
  getViewType(): string { return VIEW_TYPE_AI_CHAT; }
  getDisplayText(): string { return "AI チャット"; }
  getIcon(): string { return "messages-square"; }
  async onOpen(): Promise<void> {
    const root = (this.containerEl.children[1] ?? this.containerEl) as HTMLElement;
    root.empty(); root.classList.add("vg-ai-chat");
    const title = this.element(root, "h3"); title.textContent = "AI チャット";
    const connection = this.element(root, "details");
    this.element(connection, "summary").textContent = "接続設定（このセッションのみ）";
    const config = this.host.session.config;
    const provider = this.select(connection, "プロバイダー", [["disconnected", "未接続"], ["openai-compatible", "OpenAI 互換"]], config.provider);
    const endpoint = this.input(connection, "接続先URL", config.endpoint); endpoint.placeholder = "https://…/v1 または http://localhost:…/v1";
    const model = this.input(connection, "モデルID", config.model); model.placeholder = "接続先で利用できるモデルID";
    const auth = this.select(connection, "認証方式", [["secret", "既存のObsidian秘密ストレージ"], ["none", "認証なし（明示選択）"]], config.auth);
    const secret = this.select(connection, "既存の秘密ID", [["", "選択してください"], ...this.host.secretIds().map((id): [string, string] => [id, id])], config.secretId);
    const apply = this.button(connection, "接続設定を適用", () => this.host.session.configure({ provider: provider.value as typeof config.provider, endpoint: endpoint.value.trim(), model: model.value.trim(), auth: auth.value as typeof config.auth, secretId: secret.value }));
    apply.title = "設定の変更だけでは接続リクエストを送信しません";
    this.element(connection, "p").textContent = "秘密は作成・コピー・保存しません。送信すると会話と必要なタスク情報がこの接続先へ送られます。";
    const toolbar = this.element(root, "div"); toolbar.className = "vg-ai-actions";
    this.conversationsEl = this.select(toolbar, "会話", [], "");
    this.conversationsEl.addEventListener("change", () => this.host.session.select(this.conversationsEl.value));
    this.button(toolbar, "新しい会話", () => this.host.session.newConversation());
    this.statusEl = this.element(root, "div"); this.statusEl.className = "vg-ai-status"; this.statusEl.setAttribute("role", "status"); this.statusEl.setAttribute("aria-live", "polite");
    this.messagesEl = this.element(root, "div"); this.messagesEl.className = "vg-ai-messages"; this.messagesEl.setAttribute("role", "log"); this.messagesEl.setAttribute("aria-label", "会話履歴");
    const label = this.element(root, "label"); label.textContent = "メッセージ";
    this.inputEl = this.element(label, "textarea"); this.inputEl.rows = 3; this.inputEl.setAttribute("aria-label", "メッセージ");
    this.inputEl.addEventListener("input", () => { this.host.session.active.draft = this.inputEl.value; });
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); void this.host.session.send(this.inputEl.value); }
      // Native editor Ctrl-Z is intentionally untouched.
    });
    const actions = this.element(root, "div"); actions.className = "vg-ai-actions";
    this.sendEl = this.button(actions, "送信", () => { void this.host.session.send(this.inputEl.value); });
    this.stopEl = this.button(actions, "停止", () => this.host.session.stop());
    this.retryEl = this.button(actions, "応答を再試行", () => { void this.host.session.retry(); });
    this.unsubscribe = this.host.session.subscribe(() => {
      if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.render(); }, 40);
    });
    this.render();
  }
  async onClose(): Promise<void> { this.unsubscribe?.(); this.unsubscribe = undefined; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  render(): void {
    if (!this.messagesEl) return;
    const session = this.host.session; const conversation = session.active;
    const names = { idle: "待機中", running: "実行中", preview: "確認待ち", failed: "失敗", cancelled: "停止済み" };
    this.statusEl.textContent = (session.connected ? "接続設定あり" : "未接続") + " · " + names[conversation.status] + (conversation.error ? " — " + conversation.error : "");
    this.conversationsEl.empty();
    for (const item of session.conversations) { const option = this.element(this.conversationsEl, "option"); option.value = item.id; option.textContent = item.title; }
    this.conversationsEl.value = conversation.id;
    if (this.inputEl.value !== conversation.draft) this.inputEl.value = conversation.draft;
    const running = conversation.status === "running";
    this.sendEl.disabled = running || !session.connected; this.stopEl.disabled = !running;
    this.retryEl.disabled = running || !session.connected || !["failed", "cancelled"].includes(conversation.status);
    this.messagesEl.empty();
    for (const message of conversation.messages) {
      const item = this.element(this.messagesEl, "section"); item.className = "vg-ai-message vg-ai-" + message.role;
      this.element(item, "strong").textContent = message.role === "user" ? "あなた" : "AI";
      this.element(item, "p").textContent = message.text || (running ? "応答中…" : "（テキスト応答なし）");
      for (const proposal of message.proposals) this.renderProposal(item, proposal, running);
    }
  }
  private renderProposal(parent: HTMLElement, proposal: Proposal, running: boolean): void {
    const item = this.element(parent, "div"); item.className = "vg-ai-diff";
    this.element(item, "strong").textContent = proposal.result ? "保存済み " + proposal.result.committed + "/" + proposal.result.total + "件 · " + proposal.result.kind : "変更案 " + proposal.plan.count + "件（未実行）";
    this.element(item, "pre").textContent = diffText(proposal.result?.diffs ?? proposal.plan.diffs);
    if (proposal.result) this.element(item, "p").textContent = proposal.result.message;
    if (!proposal.consumed) this.button(item, "確認して実行", () => { void this.host.session.confirm(proposal); }).disabled = running;
    if (proposal.consumed && proposal.result?.kind !== "success") this.button(item, "再プレビュー", () => { void this.host.session.repreview(proposal); }).disabled = running;
    if (proposal.result?.committed) {
      this.button(item, "Ganttを開く", () => { void this.host.openGantt(); });
      this.button(item, "元に戻す", () => { void this.host.undo(proposal.result!); }).disabled = !this.host.canUndo(proposal.result);
    }
  }
  // eslint-disable-next-line no-undef
  private element<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K): HTMLElementTagNameMap[K] { const element = document.createElement(tag); parent.appendChild(element); return element; }
  private button(parent: HTMLElement, text: string, action: () => void): HTMLButtonElement { const button = this.element(parent, "button"); button.textContent = text; button.addEventListener("click", action); return button; }
  private input(parent: HTMLElement, text: string, value: string): HTMLInputElement { const label = this.element(parent, "label"); label.textContent = text; const input = this.element(label, "input"); input.value = value; return input; }
  private select(parent: HTMLElement, text: string, choices: [string, string][], value: string): HTMLSelectElement { const label = this.element(parent, "label"); label.textContent = text; const select = this.element(label, "select"); for (const [id, name] of choices) { const option = this.element(select, "option"); option.value = id; option.textContent = name; } select.value = value; return select; }
}
