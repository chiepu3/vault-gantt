import { ItemView, Menu, setIcon } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import { ChatSession, Proposal } from "../ai/chat-session";
import type { OperationResult, TaskDiff } from "../app/operation-registry";
import { renderScheduleTimeline } from "./schedule-timeline";

export const VIEW_TYPE_AI_CHAT = "vault-gantt-ai-chat";
export interface AgentViewHost {
  session: ChatSession;
  secretIds(): string[];
  selectedTask?(): string | undefined;
  closeDiff?(): void;
  openGantt(): Promise<void> | void;
  undo(result: OperationResult): Promise<void> | void;
  canUndo(result: OperationResult): boolean;
  undoStatus?(result: OperationResult): "available" | "undone" | "unavailable";
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
  private modelEl!: HTMLButtonElement;
  private modelLabelEl!: HTMLElement;
  private modelSettingEl!: HTMLInputElement;
  private modelMenu?: Menu;
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
    const headerShell = this.element(root, "header"); headerShell.className = "vg-ai-header";
    const header = this.element(headerShell, "div"); header.className = "vg-ai-content vg-ai-header-content";
    this.element(header, "strong").textContent = "AI チャット";
    this.statusEl = this.element(header, "span"); this.statusEl.className = "vg-ai-status"; this.statusEl.setAttribute("role", "status"); this.statusEl.setAttribute("aria-live", "polite");
    this.iconButton(header, "plus", "新しい会話", () => this.host.session.newConversation());
    const history = this.element(header, "details"); history.className = "vg-ai-menu";
    const historyToggle = this.element(history, "summary"); this.decorateIcon(historyToggle, "history", "会話履歴を開く");
    this.historyEl = this.element(history, "div"); this.historyEl.className = "vg-ai-popover vg-ai-history";
    const connection = this.element(header, "details"); connection.className = "vg-ai-menu";
    const settingsToggle = this.element(connection, "summary"); this.decorateIcon(settingsToggle, "settings", "接続設定を開く");
    const settings = this.element(connection, "div"); settings.className = "vg-ai-popover";
    this.element(settings, "strong").textContent = "接続設定（このセッションのみ）";
    const config = this.host.session.config;
    const provider = this.select(settings, "プロバイダー", [["disconnected", "未接続"], ["openai-compatible", "OpenAI 互換"]], config.provider);
    const endpoint = this.input(settings, "接続先URL", config.endpoint); endpoint.placeholder = "https://…/v1 または http://localhost:…/v1";
    const model = this.input(settings, "モデルID", config.model); model.placeholder = "接続先で利用できるモデルID"; this.modelSettingEl = model;
    const auth = this.select(settings, "認証方式", [["secret", "既存のObsidian秘密ストレージ"], ["none", "認証なし（明示選択）"]], config.auth);
    const secret = this.select(settings, "既存の秘密ID", [["", "選択してください"], ...this.host.secretIds().map((id): [string, string] => [id, id])], config.secretId);
    const apply = this.button(settings, "接続設定を適用", () => this.host.session.configure({ provider: provider.value as typeof config.provider, endpoint: endpoint.value.trim(), model: model.value.trim(), auth: auth.value as typeof config.auth, secretId: secret.value }));
    apply.title = "設定の変更だけでは接続リクエストを送信しません";
    this.element(settings, "p").textContent = "秘密は作成・コピー・保存しません。送信すると会話と必要なタスク情報がこの接続先へ送られます。";
    this.messagesEl = this.element(root, "div"); this.messagesEl.className = "vg-ai-messages"; this.messagesEl.setAttribute("role", "log"); this.messagesEl.setAttribute("aria-label", "会話履歴");
    const composer = this.element(root, "div"); composer.className = "vg-ai-content vg-ai-composer";
    this.contextEl = this.element(composer, "div"); this.contextEl.className = "vg-ai-context";
    this.inputEl = this.element(composer, "textarea"); this.inputEl.rows = 2; this.inputEl.setAttribute("aria-label", "メッセージ"); this.inputEl.placeholder = "タスクについて相談…";
    this.inputEl.addEventListener("input", () => { this.host.session.active.draft = this.inputEl.value; this.resizeInput(); });
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); void this.host.session.send(this.inputEl.value); }
      // Native editor Ctrl-Z is intentionally untouched.
    });
    const actions = this.element(composer, "div"); actions.className = "vg-ai-composer-actions";
    this.modelEl = this.button(actions, "", () => this.openModelMenu()); this.modelEl.className = "clickable-icon vg-ai-model";
    this.modelEl.setAttribute("aria-label", "モデルを選択"); this.modelEl.setAttribute("aria-haspopup", "menu"); this.modelEl.setAttribute("aria-expanded", "false");
    this.modelLabelEl = this.element(this.modelEl, "span"); this.modelLabelEl.className = "vg-ai-model-label";
    const chevron = this.element(this.modelEl, "span"); chevron.className = "vg-ai-model-chevron"; chevron.setAttribute("aria-hidden", "true"); setIcon(chevron, "chevron-down");
    this.modelEl.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); this.openModelMenu(); }
    });
    this.sendEl = this.button(actions, "送信 ↑", () => { void this.host.session.send(this.inputEl.value); }); this.sendEl.className = "vg-ai-send"; this.sendEl.title = "送信（Ctrl / ⌘ + Enter）";
    this.stopEl = this.button(actions, "停止 ■", () => this.host.session.stop()); this.stopEl.className = "vg-ai-stop";
    this.unsubscribe = this.host.session.subscribe(() => {
      if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.render(); }, 40);
    });
    this.render();
  }
  async onClose(): Promise<void> { this.modelMenu?.hide(); this.host.closeDiff?.(); this.unsubscribe?.(); this.unsubscribe = undefined; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  render(): void {
    if (!this.messagesEl) return;
    const session = this.host.session; const conversation = session.active;
    const names = { idle: "待機中", running: "実行中", preview: "確認待ち", failed: "失敗", cancelled: "停止済み" };
    this.statusEl.textContent = session.connected ? names[conversation.status] : "未接続";
    this.statusEl.dataset.state = session.connected ? conversation.status : "disconnected";
    this.statusEl.title = (session.connected ? "接続設定あり" : "未接続") + " · " + names[conversation.status] + (conversation.error ? " — " + conversation.error : "");
    this.historyEl.empty();
    for (const item of session.conversations) {
      const button = this.button(this.historyEl, item.title, () => { session.select(item.id); this.historyEl.parentElement?.removeAttribute("open"); });
      button.setAttribute("aria-current", String(item.id === conversation.id));
    }
    const selected = this.host.selectedTask?.();
    this.contextEl.hidden = !selected;
    this.contextEl.textContent = selected ? "選択中: " + selected : "";
    this.contextEl.title = "選択表示は自動送信されません。対象タスクはメッセージで指定してください。";
    if (this.inputEl.value !== conversation.draft) { this.inputEl.value = conversation.draft; this.resizeInput(); }
    const running = conversation.status === "running";
    this.sendEl.disabled = running || !session.connected; this.sendEl.hidden = running; this.stopEl.hidden = !running;
    if (session.config.model) this.models.add(session.config.model);
    this.modelEl.disabled = running || !this.models.size;
    this.modelLabelEl.textContent = session.config.model || "モデル";
    this.modelEl.title = session.config.model || "接続設定でモデルIDを指定";
    this.modelEl.dataset.model = session.config.model;
    if (running) this.modelMenu?.hide();
    const stickToBottom = this.messagesEl.scrollHeight - this.messagesEl.scrollTop - this.messagesEl.clientHeight < 64;
    this.messagesEl.empty();
    if (!conversation.messages.length) {
      const empty = this.element(this.messagesEl, "div"); empty.className = "vg-ai-empty";
      const emptyIcon = this.element(empty, "div"); emptyIcon.className = "vg-ai-empty-icon"; emptyIcon.setAttribute("aria-hidden", "true"); setIcon(emptyIcon, "messages-square");
      this.element(empty, "strong").textContent = "AIチャット";
      this.element(empty, "p").textContent = "タスクの検索や変更ができます。変更は「確認して実行」を押すと保存されます。";
      if (!session.connected) this.element(empty, "p").textContent = "歯車から接続先を設定してください。";
    }
    for (const [index, message] of conversation.messages.entries()) {
      const item = this.element(this.messagesEl, "section"); item.className = "vg-ai-message vg-ai-" + message.role;
      this.element(item, "strong").textContent = message.role === "user" ? "あなた" : "AI";
      if (running && message.role === "assistant" && index === conversation.messages.length - 1) item.dataset.streaming = "true";
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
  private openModelMenu(): void {
    if (this.modelEl.disabled || this.host.session.active.status === "running") return;
    this.modelMenu?.hide();
    const menu = new Menu(); this.modelMenu = menu;
    for (const id of this.models) menu.addItem((item) => item.setTitle(id).setChecked(id === this.host.session.config.model).onClick(() => {
      if (this.host.session.active.status === "running") return;
      this.modelSettingEl.value = id;
      this.host.session.configure({ ...this.host.session.config, model: id });
      menu.hide();
    }));
    this.modelEl.setAttribute("aria-expanded", "true");
    menu.onHide(() => { this.modelEl.setAttribute("aria-expanded", "false"); if (this.modelMenu === menu) this.modelMenu = undefined; });
    const rect = this.modelEl.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom });
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
    const undone = !!proposal.result && this.host.undoStatus?.(proposal.result) === "undone";
    item.dataset.state = proposal.result ? (undone ? "undone" : proposal.result.kind) : "proposal";
    const outcomes = { success: "適用済み", partial: "一部適用", failed: "失敗", cancelled: "停止済み", stale: "失効" };
    const status = this.element(item, "span"); status.className = "vg-ai-result-status"; status.setAttribute("role", "status");
    status.textContent = proposal.result ? (this.host.undoStatus?.(proposal.result) === "undone" ? "元に戻しました" : outcomes[proposal.result.kind]) : "変更案";
    for (const diff of proposal.result?.diffs ?? proposal.plan.diffs) {
      const card = this.element(item, "div"); card.className = "vg-ai-result-task";
      this.element(card, "strong").textContent = diff.name;
      if (diff.schedule) renderScheduleTimeline(card, diff.schedule);
      const fields = diff.fields.filter((field) => field.field !== "updatedAt" && (!diff.schedule || !["plannedStartDate", "plannedEndDate"].includes(field.field)));
      if (fields.length) this.element(card, "div").textContent = fields.map((field) => (fieldNames[field.field] ?? field.field) + ": " + display(field.before) + " → " + display(field.after)).join("\n");
    }
    if (proposal.result && proposal.result.kind !== "success") {
      const details = this.element(item, "details"); this.element(details, "summary").textContent = "結果の詳細";
      this.element(details, "p").textContent = proposal.result.message;
    }
    const actions = this.element(item, "div"); actions.className = "vg-ai-actions";
    if (!proposal.consumed) { const confirm = this.button(actions, "確認して実行", () => { void this.host.session.confirm(proposal); }); confirm.classList.add("mod-cta"); confirm.disabled = running; }
    if (proposal.consumed && !proposal.retryPrepared && proposal.result?.kind !== "success" && (!proposal.result || proposal.result.committed < proposal.result.total)) this.button(actions, "再プレビュー", () => { void this.host.session.repreview(proposal); }).disabled = running;
    if (proposal.result?.committed) {
      const result = proposal.result;
      const available = !!result.undoLabel && this.host.canUndo(result);
      const undone = this.host.undoStatus?.(result) === "undone";
      const undoHint = undone ? "元に戻しました" : available ? "履歴の先頭の変更を元に戻す" : "現在の履歴の先頭ではないため元に戻せません";
      this.button(actions, "Ganttを開く", () => { void this.host.openGantt(); });
      const undo = this.button(actions, "元に戻す", () => {
        // Recheck at click time as other views may have changed the history.
        if (!result.undoLabel || !this.host.canUndo(result)) { this.render(); return; }
        void (async () => {
          try { await this.host.undo(result); this.render(); }
          catch { status.textContent = "元に戻せませんでした。履歴とタスクを確認してください。"; }
        })();
      });
      undo.disabled = !available;
      undo.title = undoHint;
    }
  }
  // eslint-disable-next-line no-undef
  private element<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K): HTMLElementTagNameMap[K] { const element = document.createElement(tag); parent.appendChild(element); return element; }
  private button(parent: HTMLElement, text: string, action: () => void): HTMLButtonElement { const button = this.element(parent, "button"); button.type = "button"; button.textContent = text; button.addEventListener("click", action); return button; }
  private decorateIcon(element: HTMLElement, icon: string, label: string): void { element.className = "clickable-icon vg-ai-icon-button"; element.title = label; element.setAttribute("aria-label", label); setIcon(element, icon); }
  private iconButton(parent: HTMLElement, icon: string, label: string, action: () => void): HTMLButtonElement { const button = this.button(parent, "", action); this.decorateIcon(button, icon, label); return button; }
  private input(parent: HTMLElement, text: string, value: string): HTMLInputElement { const label = this.element(parent, "label"); label.textContent = text; const input = this.element(label, "input"); input.value = value; return input; }
  private select(parent: HTMLElement, text: string, choices: [string, string][], value: string): HTMLSelectElement { const label = this.element(parent, "label"); label.textContent = text; const select = this.element(label, "select"); for (const [id, name] of choices) { const option = this.element(select, "option"); option.value = id; option.textContent = name; } select.value = value; return select; }
}
