import { ItemView, Menu, setIcon } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import { ChatSession, Proposal } from "../ai/chat-session";
import { completionText, type ChatCompletion } from "../ai/chat-completion";
import type { OperationResult, TaskDiff } from "../app/operation-registry";
import type { PreviewUiHostPorts } from "../contracts/ports";
import { captureFocusKey, PreviewCardController, renderOperationPreviewCard, restoreFocusKey } from "./operation-preview-card";
import { renderScheduleTimeline } from "./schedule-timeline";

export const VIEW_TYPE_AI_CHAT = "vault-gantt-ai-chat";
export interface AgentViewHost {
  session: ChatSession;
  /** Opens the plugin settings tab, where the connection is configured. */
  openSettings(): void;
  /** Model IDs fetched from the connection in the settings tab. */
  modelOptions?(): string[];
  selectedTask?(): string | undefined;
  closeDiff?(): void;
  openGantt(): Promise<void> | void;
  undo(result: OperationResult): Promise<void> | void;
  canUndo(result: OperationResult): boolean;
  undoStatus?(result: OperationResult): "available" | "undone" | "unavailable";
  /** Ports for operation previews (cards for every effect). Absent = legacy cards only. */
  previewPorts?: PreviewUiHostPorts;
  /** Reverse the history entry an outcome refers to; the ports only inspect history. */
  undoEntry?(entryId: string): Promise<void> | void;
}
const fieldNames: Record<string, string> = { plannedStartDate: "開始日", plannedEndDate: "終了日", dueDate: "期限", notes: "メモ", displayName: "表示名", title: "名前", create: "作成" };
export function diffText(diffs: TaskDiff[]): string {
  return diffs.map((diff) => diff.name + "\n" + diff.fields.map((field) => (fieldNames[field.field] ?? field.field) + ": " + display(field.before) + " → " + display(field.after)).join("\n")).join("\n\n");
}
function display(value: unknown): string { return value === "" || value == null ? "未設定" : typeof value === "string" ? value : JSON.stringify(value); }

// Deliberately small Markdown subset: text nodes only, no HTML, images or executable links.
// Rendering is line based and stateless, so a half-received reply (open code fence, table
// without its separator row yet, unclosed bold) stays readable and re-renders cleanly.
const STATUS_WORDS: Record<string, string> = { active: "進行中", in_progress: "作業中", done: "完了", completed: "完了", todo: "未着手", pending: "未着手", blocked: "保留", cancelled: "中止" };
function inline(parent: HTMLElement, content: string): void {
  for (const part of content.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
    if (!part) continue;
    const tag = part.startsWith("**") && part.endsWith("**") && part.length > 4 ? "strong" : part.startsWith("`") && part.endsWith("`") && part.length > 2 ? "code" : "span";
    const node = document.createElement(tag);
    const raw = tag === "strong" ? part.slice(2, -2) : tag === "code" ? part.slice(1, -1) : part;
    node.textContent = tag === "code" && STATUS_WORDS[raw] ? STATUS_WORDS[raw] : raw;
    if (tag === "code" && STATUS_WORDS[raw]) node.title = raw;
    parent.appendChild(node);
  }
}
const tableCells = (line: string): string[] => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
const isSeparator = (line: string | undefined): boolean => !!line && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes("|");
export function renderChatText(parent: HTMLElement, text: string): void {
  const lines = text.split("\n");
  const add = (tag: string, className?: string): HTMLElement => { const node = document.createElement(tag); if (className) node.className = className; parent.appendChild(node); return node; };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      index++;
      while (index < lines.length && !/^\s*```/.test(lines[index])) body.push(lines[index++]);
      const code = document.createElement("code"); code.textContent = body.join("\n");
      add("pre", "vg-ai-codeblock").appendChild(code);
      continue;
    }
    if (line.includes("|") && line.trim().startsWith("|") && isSeparator(lines[index + 1])) {
      const wrap = add("div", "vg-ai-table-wrap"); const table = document.createElement("table"); wrap.appendChild(table);
      const head = document.createElement("thead"); const headRow = document.createElement("tr"); head.appendChild(headRow); table.appendChild(head);
      for (const cell of tableCells(line)) { const th = document.createElement("th"); inline(th, cell); headRow.appendChild(th); }
      const body = document.createElement("tbody"); table.appendChild(body);
      index += 2;
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        const row = document.createElement("tr"); body.appendChild(row);
        for (const cell of tableCells(lines[index])) { const td = document.createElement("td"); inline(td, STATUS_WORDS[cell] ?? cell); row.appendChild(td); }
        index++;
      }
      index--;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { inline(add("p", "vg-ai-heading"), heading[2]); continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { add("hr"); continue; }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) { inline(add("p", "vg-ai-quote"), quote[1]); continue; }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) { inline(add("div", "vg-ai-li"), "• " + bullet[1]); continue; }
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (numbered) { inline(add("div", "vg-ai-li"), numbered[1] + ". " + numbered[2]); continue; }
    inline(add("p"), line);
  }
}

/** One-line turn status under the reply. A created proposal shows as a card, so it gets no line. */
export function completionLine(completion: ChatCompletion | undefined): string {
  if (!completion || completion.kind === "proposal-created") return "";
  const text = completionText[completion.kind];
  return completion.kind === "connection-error" && completion.httpStatus ? text + "（HTTP " + completion.httpStatus + "）" : text;
}
/** The provider also appends the completion sentence to the reply text; drop it so the status line is the only copy. */
function replyText(text: string, completion: ChatCompletion | undefined): string {
  const tail = completion ? completionText[completion.kind] : "";
  return tail && text.endsWith(tail) ? text.slice(0, -tail.length).trimEnd() : text;
}

export class AgentView extends ItemView {
  private unregisterState?: () => void;
  private unsubscribe?: () => void;
  private unsubscribePreviews: (() => void)[] = [];
  private cards?: PreviewCardController;
  private lastConversationId?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private messagesEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private historyEl!: HTMLElement;
  private contextEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private modelEl!: HTMLButtonElement;
  private modelLabelEl!: HTMLElement;
  private modelMenu?: Menu;
  private readonly models = new Set<string>();
  private sendEl!: HTMLButtonElement;
  private stopEl!: HTMLButtonElement;
  constructor(leaf: WorkspaceLeaf, private readonly host: AgentViewHost) { super(leaf); }
  getViewType(): string { return VIEW_TYPE_AI_CHAT; }
  getDisplayText(): string { return "AI チャット"; }
  getIcon(): string { return "messages-square"; }
  async onOpen(): Promise<void> {
    const portsForState = this.host.previewPorts;
    if (portsForState?.viewId) this.unregisterState = portsForState.viewStatePort?.register(portsForState.viewId, () => ({ viewId: portsForState.viewId!, kind: "chat", filterText: "", statusFilter: "all", showCompleted: true, tagNames: [] }));
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
    this.iconButton(header, "settings", "接続設定を開く", () => this.host.openSettings());
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
    const ports = this.host.previewPorts;
    if (ports) {
      const rerender = () => { if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.render(); }, 40); };
      this.cards = new PreviewCardController(ports, { openGantt: () => this.host.openGantt(), undoEntry: this.host.undoEntry }, rerender);
      this.unsubscribePreviews = [ports.previewPort.subscribe(rerender), ports.historyPort.subscribe(rerender)];
    }
    this.render();
  }
  async onClose(): Promise<void> {
    this.unregisterState?.(); this.unregisterState = undefined;
    this.releasePreviewFocus();
    for (const stop of this.unsubscribePreviews) stop();
    this.unsubscribePreviews = []; this.cards = undefined;
    this.modelMenu?.hide(); this.host.closeDiff?.(); this.unsubscribe?.(); this.unsubscribe = undefined; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  /** The Gantt overlay of a chat proposal is dropped on conversation switch and view close. The pending plan itself stays. */
  private releasePreviewFocus(keepConversationId?: string): void {
    const port = this.host.previewPorts?.previewPort; if (!port) return;
    const focused = port.focusedPreviewId(); const preview = focused ? port.inspect(focused) : undefined;
    if (preview?.origin.kind === "chat" && preview.origin.conversationId !== keepConversationId) port.focus(null);
  }
  render(): void {
    if (!this.messagesEl) return;
    const session = this.host.session; const conversation = session.active;
    if (this.lastConversationId !== conversation.id) { if (this.lastConversationId !== undefined) this.releasePreviewFocus(conversation.id); this.lastConversationId = conversation.id; }
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
    for (const id of this.host.modelOptions?.() ?? []) this.models.add(id);
    if (session.config.model) this.models.add(session.config.model);
    this.modelEl.disabled = running || !this.models.size;
    this.modelLabelEl.textContent = session.config.model || "モデル";
    this.modelEl.title = session.config.model || "設定画面でモデルを選択";
    this.modelEl.dataset.model = session.config.model;
    if (running) this.modelMenu?.hide();
    const stickToBottom = this.messagesEl.scrollHeight - this.messagesEl.scrollTop - this.messagesEl.clientHeight < 64;
    const focusKey = captureFocusKey();
    this.messagesEl.empty();
    if (session.config.connectionError) {
      const error = this.element(this.messagesEl, "p"); error.className = "vg-ai-error"; error.textContent = session.config.connectionError;
    }
    if (!conversation.messages.length) {
      const empty = this.element(this.messagesEl, "div"); empty.className = "vg-ai-empty";
      const emptyIcon = this.element(empty, "div"); emptyIcon.className = "vg-ai-empty-icon"; emptyIcon.setAttribute("aria-hidden", "true"); setIcon(emptyIcon, "messages-square");
      this.element(empty, "strong").textContent = "AIチャット";
      this.element(empty, "p").textContent = "タスクの検索や変更ができます。変更は「確認して実行」を押すと保存されます。";
      if (!session.connected) this.element(empty, "p").textContent = "歯車ボタンから設定画面を開き、接続先とモデルを設定してください。";
    }
    for (const [index, message] of conversation.messages.entries()) {
      const item = this.element(this.messagesEl, "section"); item.className = "vg-ai-message vg-ai-" + message.role;
      this.element(item, "strong").textContent = message.role === "user" ? "あなた" : "AI";
      if (running && message.role === "assistant" && index === conversation.messages.length - 1) item.dataset.streaming = "true";
      const body = this.element(item, "div"); body.className = "vg-ai-message-body";
      const line = completionLine(message.completion);
      const shown = replyText(message.text, message.completion);
      if (shown || !line) renderChatText(body, shown || (running ? "応答中…" : message.proposals.length ? "変更案を作成しました。" : "変更案はありません。"));
      for (const proposal of message.proposals) this.renderProposal(item, proposal, running);
      if (line && !running && message.completion) {
        const note = this.element(item, "p"); note.className = "vg-ai-completion"; note.dataset.kind = message.completion.kind; note.setAttribute("role", "status"); note.textContent = line;
      }
      if (message.role === "assistant" && index === conversation.messages.length - 1) {
        this.renderToolStatus(item);
        if (["failed", "cancelled"].includes(conversation.status)) {
          if (!message.completion) { const error = this.element(item, "p"); error.className = "vg-ai-error"; error.textContent = conversation.error; }
          this.button(item, "応答を再試行", () => { void session.retry(); }).disabled = running || !session.connected;
        }
      }
    }
    this.renderPreviewCards(conversation.id);
    restoreFocusKey(this.messagesEl, focusKey);
    if (stickToBottom) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }
  /** Operation previews raised by this conversation, in creation order. */
  private renderPreviewCards(conversationId: string): void {
    const controller = this.cards; const ports = this.host.previewPorts;
    if (!controller || !ports) return;
    const previews = ports.previewPort.list().filter((preview) => preview.origin.kind === "chat" && preview.origin.conversationId === conversationId)
      .slice().sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    controller.pager.prune(new Set(ports.previewPort.list().map((preview) => preview.previewId)));
    if (!previews.length) return;
    const section = this.element(this.messagesEl, "section"); section.className = "vg-pv-chat-previews"; section.setAttribute("aria-label", "変更案");
    for (const preview of previews) renderOperationPreviewCard(section, preview, controller.optionsFor(preview));
  }
  private openModelMenu(): void {
    if (this.modelEl.disabled || this.host.session.active.status === "running") return;
    this.modelMenu?.hide();
    const menu = new Menu(); this.modelMenu = menu;
    for (const id of this.models) menu.addItem((item) => item.setTitle(id).setChecked(id === this.host.session.config.model).onClick(() => {
      if (this.host.session.active.status === "running") return;
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
    if (this.cards && this.host.previewPorts?.previewPort.inspect(proposal.plan.previewId)) return;
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
}
