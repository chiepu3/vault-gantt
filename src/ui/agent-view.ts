import { ItemView } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import { ChatSession, Proposal } from "../ai/chat-session";
import type { OperationResult, TaskDiff } from "../app/operation-registry";

export const VIEW_TYPE_AI_CHAT = "vault-gantt-ai-chat";
export interface AgentViewHost {
  session: ChatSession;
  secretIds(): string[];
  selectedTask?(): string | undefined;
  closeDiff?(): void;
  openGantt(): Promise<void> | void;
  undo(result: OperationResult): Promise<void> | void;
  canUndo(result: OperationResult): boolean;
}
const fieldNames: Record<string, string> = { plannedStartDate: "開始日", plannedEndDate: "終了日", dueDate: "期限", notes: "メモ", displayName: "表示名", title: "名前", create: "作成" };
export function diffText(diffs: TaskDiff[]): string {
  return diffs.map((diff) => diff.name + "\n" + diff.fields.map((field) => (fieldNames[field.field] ?? field.field) + ": " + display(field.before) + " → " + display(field.after)).join("\n")).join("\n\n");
}
function display(value: unknown): string { return value === "" || value == null ? "未設定" : typeof value === "string" ? value : JSON.stringify(value); }

// Deliberately small Markdown subset: text nodes only, no HTML or executable links.
export function renderChatText(parent: HTMLElement, text: string): void {
  for (const line of text.split("\n")) {
    const block = document.createElement(line.startsWith("- ") ? "div" : "p");
    parent.appendChild(block);
    const content = line.startsWith("- ") ? "• " + line.slice(2) : line;
    for (const part of content.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
      const tag = part.startsWith("**") && part.endsWith("**") ? "strong" : part.startsWith("`") && part.endsWith("`") ? "code" : "span";
      const node = document.createElement(tag);
      node.textContent = tag === "strong" ? part.slice(2, -2) : tag === "code" ? part.slice(1, -1) : part;
      block.appendChild(node);
    }
  }
}

export class AgentView extends ItemView {
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private messagesEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private historyEl!: HTMLElement;
  private contextEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private modelEl!: HTMLSelectElement;
  private readonly models = new Set<string>();
  private sendEl!: HTMLButtonElement;
  private stopEl!: HTMLButtonElement;
  constructor(leaf: WorkspaceLeaf, private readonly host: AgentViewHost) { super(leaf); }
  getViewType(): string { return VIEW_TYPE_AI_CHAT; }
  getDisplayText(): string { return "AI チャット"; }
  getIcon(): string { return "messages-square"; }
  async onOpen(): Promise<void> {
    const root = (this.containerEl.children[1] ?? this.containerEl) as HTMLElement;
    root.empty(); root.classList.add("vg-ai-chat");
    const header = this.element(root, "header"); header.className = "vg-ai-header";
    this.element(header, "strong").textContent = "AI チャット";
    this.statusEl = this.element(header, "span"); this.statusEl.className = "vg-ai-status"; this.statusEl.setAttribute("role", "status"); this.statusEl.setAttribute("aria-live", "polite");
    this.iconButton(header, "+", "新しい会話", () => this.host.session.newConversation());
    const history = this.element(header, "details"); history.className = "vg-ai-menu";
    const historyToggle = this.element(history, "summary"); historyToggle.textContent = "◷"; historyToggle.setAttribute("aria-label", "会話履歴を開く"); historyToggle.title = "会話履歴";
    this.historyEl = this.element(history, "div"); this.historyEl.className = "vg-ai-popover vg-ai-history";
    const connection = this.element(header, "details"); connection.className = "vg-ai-menu";
    const settingsToggle = this.element(connection, "summary"); settingsToggle.textContent = "⚙"; settingsToggle.setAttribute("aria-label", "接続設定を開く"); settingsToggle.title = "接続設定";
    const settings = this.element(connection, "div"); settings.className = "vg-ai-popover";
    this.element(settings, "strong").textContent = "接続設定（このセッションのみ）";
    const config = this.host.session.config;
    const provider = this.select(settings, "プロバイダー", [["disconnected", "未接続"], ["openai-compatible", "OpenAI 互換"]], config.provider);
    const endpoint = this.input(settings, "接続先URL", config.endpoint); endpoint.placeholder = "https://…/v1 または http://localhost:…/v1";
    const model = this.input(settings, "モデルID", config.model); model.placeholder = "接続先で利用できるモデルID";
    const auth = this.select(settings, "認証方式", [["secret", "既存のObsidian秘密ストレージ"], ["none", "認証なし（明示選択）"]], config.auth);
    const secret = this.select(settings, "既存の秘密ID", [["", "選択してください"], ...this.host.secretIds().map((id): [string, string] => [id, id])], config.secretId);
    const apply = this.button(settings, "接続設定を適用", () => this.host.session.configure({ provider: provider.value as typeof config.provider, endpoint: endpoint.value.trim(), model: model.value.trim(), auth: auth.value as typeof config.auth, secretId: secret.value }));
    apply.title = "設定の変更だけでは接続リクエストを送信しません";
    this.element(settings, "p").textContent = "秘密は作成・コピー・保存しません。送信すると会話と必要なタスク情報がこの接続先へ送られます。";
    this.messagesEl = this.element(root, "div"); this.messagesEl.className = "vg-ai-messages"; this.messagesEl.setAttribute("role", "log"); this.messagesEl.setAttribute("aria-label", "会話履歴");
    const composer = this.element(root, "div"); composer.className = "vg-ai-composer";
    this.contextEl = this.element(composer, "div"); this.contextEl.className = "vg-ai-context";
    this.inputEl = this.element(composer, "textarea"); this.inputEl.rows = 2; this.inputEl.setAttribute("aria-label", "メッセージ"); this.inputEl.placeholder = "タスクについて相談…";
    this.inputEl.addEventListener("input", () => { this.host.session.active.draft = this.inputEl.value; this.resizeInput(); });
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); void this.host.session.send(this.inputEl.value); }
      // Native editor Ctrl-Z is intentionally untouched.
    });
    const actions = this.element(composer, "div"); actions.className = "vg-ai-composer-actions";
    this.modelEl = this.select(actions, "モデル", [], config.model);
    this.modelEl.setAttribute("aria-label", "モデルを選択");
    this.modelEl.title = "モデルIDの追加は接続設定から";
    this.modelEl.addEventListener("change", () => {
      model.value = this.modelEl.value;
      this.host.session.configure({ ...this.host.session.config, model: this.modelEl.value });
    });
    this.sendEl = this.button(actions, "送信 ↑", () => { void this.host.session.send(this.inputEl.value); }); this.sendEl.title = "送信（Ctrl / ⌘ + Enter）";
    this.stopEl = this.button(actions, "停止 ■", () => this.host.session.stop());
    this.unsubscribe = this.host.session.subscribe(() => {
      if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.render(); }, 40);
    });
    this.render();
  }
  async onClose(): Promise<void> { this.host.closeDiff?.(); this.unsubscribe?.(); this.unsubscribe = undefined; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  render(): void {
    if (!this.messagesEl) return;
    const session = this.host.session; const conversation = session.active;
    const names = { idle: "待機中", running: "実行中", preview: "確認待ち", failed: "失敗", cancelled: "停止済み" };
    this.statusEl.textContent = session.connected ? names[conversation.status] : "未接続";
    this.statusEl.title = (session.connected ? "接続設定あり" : "未接続") + " · " + names[conversation.status] + (conversation.error ? " — " + conversation.error : "");
    this.historyEl.empty();
    for (const item of session.conversations) {
      const button = this.button(this.historyEl, item.title, () => { session.select(item.id); this.historyEl.parentElement?.removeAttribute("open"); });
      button.setAttribute("aria-current", String(item.id === conversation.id));
    }
    const selected = this.host.selectedTask?.();
    this.contextEl.textContent = selected ? "選択中: " + selected + "（表示のみ）" : "タスク未選択 · 会話から対象を指定";
    this.contextEl.title = "選択表示は自動送信されません。対象タスクはメッセージで指定してください。";
    if (this.inputEl.value !== conversation.draft) { this.inputEl.value = conversation.draft; this.resizeInput(); }
    const running = conversation.status === "running";
    this.sendEl.disabled = running || !session.connected; this.sendEl.hidden = running; this.stopEl.hidden = !running;
    this.modelEl.disabled = running;
    if (session.config.model) this.models.add(session.config.model);
    this.modelEl.empty();
    for (const id of session.config.model ? this.models : ["", ...this.models]) {
      const option = this.element(this.modelEl, "option"); option.value = id; option.textContent = id || "接続設定でモデルを指定";
    }
    this.modelEl.value = session.config.model;
    const stickToBottom = this.messagesEl.scrollHeight - this.messagesEl.scrollTop - this.messagesEl.clientHeight < 64;
    this.messagesEl.empty();
    if (!conversation.messages.length) {
      const empty = this.element(this.messagesEl, "div"); empty.className = "vg-ai-empty";
      this.element(empty, "strong").textContent = "予定の整理を、会話から";
      this.element(empty, "p").textContent = "タスクを探して、変更案を確認。保存は確認して実行したときだけ。";
      if (!session.connected) this.element(empty, "p").textContent = "歯車から接続先を設定してください。";
    }
    for (const [index, message] of conversation.messages.entries()) {
      const item = this.element(this.messagesEl, "section"); item.className = "vg-ai-message vg-ai-" + message.role;
      this.element(item, "strong").textContent = message.role === "user" ? "あなた" : "AI";
      const body = this.element(item, "div"); body.className = "vg-ai-message-body";
      renderChatText(body, message.text || (running ? "応答中…" : "（テキスト応答なし）"));
      for (const proposal of message.proposals) this.renderProposal(item, proposal, running);
      if (message.role === "assistant" && index === conversation.messages.length - 1) {
        this.renderToolStatus(item);
        if (["failed", "cancelled"].includes(conversation.status)) {
          const error = this.element(item, "p"); error.className = "vg-ai-error"; error.textContent = conversation.error;
          this.button(item, "応答を再試行", () => { void session.retry(); }).disabled = running || !session.connected;
        }
      }
    }
    if (stickToBottom) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }
  private resizeInput(): void { this.inputEl.style.height = "auto"; this.inputEl.style.height = Math.max(56, Math.min(160, this.inputEl.scrollHeight)) + "px"; }
  private renderToolStatus(parent: HTMLElement): void {
    const tools: string[] = [];
    for (const message of this.host.session.active.context) {
      if (message.role !== "tool" || !Array.isArray(message.content)) continue;
      for (const part of message.content) if (part.type === "tool-result") tools.push(part.toolName);
    }
    if (!tools.length) return;
    const details = this.element(parent, "details"); details.className = "vg-ai-tools";
    this.element(details, "summary").textContent = "✓ ツール履歴 · " + tools.length + "件";
    const names: Record<string, string> = { search: "タスク検索", get: "タスク取得", update: "変更案の作成", "schedule-batch": "日程変更案の作成" };
    for (const tool of tools) this.element(details, "div").textContent = names[tool] ?? tool;
  }
  private renderProposal(parent: HTMLElement, proposal: Proposal, running: boolean): void {
    const item = this.element(parent, "div"); item.className = "vg-ai-diff";
    const outcomes = { success: "保存済み", partial: "一部保存", failed: "失敗", cancelled: "停止済み", stale: "失効" };
    this.element(item, "strong").textContent = proposal.result ? outcomes[proposal.result.kind] + " · " + proposal.result.committed + "/" + proposal.result.total + "件" : "変更案 · " + proposal.plan.count + "件（未実行）";
    for (const diff of proposal.result?.diffs ?? proposal.plan.diffs) {
      const card = this.element(item, "div"); card.className = "vg-ai-result-task";
      this.element(card, "strong").textContent = diff.name;
      this.element(card, "div").textContent = diff.fields.map((field) => (fieldNames[field.field] ?? field.field) + ": " + display(field.before) + " → " + display(field.after)).join("\n");
    }
    if (proposal.result) this.element(item, "p").textContent = proposal.result.message;
    const actions = this.element(item, "div"); actions.className = "vg-ai-actions";
    if (!proposal.consumed) this.button(actions, "確認して実行", () => { void this.host.session.confirm(proposal); }).disabled = running;
    if (proposal.consumed && !proposal.retryPrepared && proposal.result?.kind !== "success" && (!proposal.result || proposal.result.committed < proposal.result.total)) this.button(actions, "再プレビュー", () => { void this.host.session.repreview(proposal); }).disabled = running;
    if (proposal.result?.committed) {
      this.button(actions, "Ganttを開く", () => { void this.host.openGantt(); });
      this.button(actions, "元に戻す", () => { void this.host.undo(proposal.result!); }).disabled = !this.host.canUndo(proposal.result);
    }
  }
  // eslint-disable-next-line no-undef
  private element<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K): HTMLElementTagNameMap[K] { const element = document.createElement(tag); parent.appendChild(element); return element; }
  private button(parent: HTMLElement, text: string, action: () => void): HTMLButtonElement { const button = this.element(parent, "button"); button.type = "button"; button.textContent = text; button.addEventListener("click", action); return button; }
  private iconButton(parent: HTMLElement, text: string, label: string, action: () => void): HTMLButtonElement { const button = this.button(parent, text, action); button.className = "vg-ai-icon"; button.title = label; button.setAttribute("aria-label", label); return button; }
  private input(parent: HTMLElement, text: string, value: string): HTMLInputElement { const label = this.element(parent, "label"); label.textContent = text; const input = this.element(label, "input"); input.value = value; return input; }
  private select(parent: HTMLElement, text: string, choices: [string, string][], value: string): HTMLSelectElement { const label = this.element(parent, "label"); label.textContent = text; const select = this.element(label, "select"); for (const [id, name] of choices) { const option = this.element(select, "option"); option.value = id; option.textContent = name; } select.value = value; return select; }
}
