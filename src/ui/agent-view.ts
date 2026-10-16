import { ItemView, Menu, setIcon } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import { ChatSession, partsOf, type ChatMessage, type ChatPart, type Proposal } from "../ai/chat-session";
import { toolLabel } from "../ai/tool-labels";
import type { OperationPreviewV1 } from "../contracts/preview";
import { completionText, type ChatCompletion } from "../ai/chat-completion";
import type { OperationResult, TaskDiff } from "../app/operation-registry";
import type { PreviewUiHostPorts } from "../contracts/ports";
import { captureFocusKey, cardState, PreviewCardController, renderOperationPreviewCard, restoreFocusKey } from "./operation-preview-card";
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

/** One-line status under a reply, for real failures only (timeout, connection, refused tool, step limit). */
export function completionLine(completion: ChatCompletion | undefined): string {
  if (!completion) return "";
  const text = completionText[completion.kind];
  if (!text) return "";
  return completion.kind === "connection-error" && completion.httpStatus ? text + "（HTTP " + completion.httpStatus + "）" : text;
}

/** One keyed child of a container. `sig` changes exactly when the element has to be rebuilt. */
interface SyncItem { key: string; sig: string; build: () => HTMLElement; update?: (el: HTMLElement) => void }
interface SyncEntry { el: HTMLElement; sig: string }
const PREVIEW_CHARS = 1500;
export function prettyJson(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") { try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; } }
  try { return JSON.stringify(value, null, 2) ?? String(value); } catch { return String(value); }
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
  /** Rendered children per container, so a re-render only touches what changed. */
  private readonly stores = new WeakMap<HTMLElement, Map<string, SyncEntry>>();
  private readonly partsOfShell = new WeakMap<HTMLElement, HTMLElement>();
  /** Items that already played their entrance; they never animate again. */
  private readonly seen = new Set<string>();
  /** Open/closed state the reader chose for a details row, by part key. */
  private readonly openState = new Map<string, boolean>();
  private readonly expanded = new Set<string>();
  private animate = false;
  private readonly freshShells = new WeakSet<HTMLElement>();
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
    const box = this.element(composer, "div"); box.className = "vg-ai-composer-box";
    this.inputEl = this.element(box, "textarea"); this.inputEl.rows = 1; this.inputEl.setAttribute("aria-label", "メッセージ"); this.inputEl.placeholder = "メッセージを入力…"; this.inputEl.title = "Enterで送信、Shift+Enterで改行";
    this.inputEl.addEventListener("input", () => { this.host.session.active.draft = this.inputEl.value; this.resizeInput(); });
    this.inputEl.addEventListener("keydown", (event) => {
      // Enter sends, Shift+Enter breaks the line. Enter that confirms an IME conversion must not send.
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      event.preventDefault(); void this.host.session.send(this.inputEl.value);
      // Native editor Ctrl-Z is intentionally untouched.
    });
    const actions = this.element(box, "div"); actions.className = "vg-ai-composer-actions";
    this.modelEl = this.button(actions, "", () => this.openModelMenu()); this.modelEl.className = "clickable-icon vg-ai-model";
    this.modelEl.setAttribute("aria-label", "モデルを選択"); this.modelEl.setAttribute("aria-haspopup", "menu"); this.modelEl.setAttribute("aria-expanded", "false");
    this.modelLabelEl = this.element(this.modelEl, "span"); this.modelLabelEl.className = "vg-ai-model-label";
    const chevron = this.element(this.modelEl, "span"); chevron.className = "vg-ai-model-chevron"; chevron.setAttribute("aria-hidden", "true"); setIcon(chevron, "chevron-down");
    this.modelEl.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); this.openModelMenu(); }
    });
    this.sendEl = this.button(actions, "", () => { void this.host.session.send(this.inputEl.value); });
    this.sendEl.className = "vg-ai-send"; this.sendEl.title = "送信（Enter）"; this.sendEl.setAttribute("aria-label", "送信（Enter）"); setIcon(this.sendEl, "send-horizontal");
    this.stopEl = this.button(actions, "", () => this.host.session.stop());
    this.stopEl.className = "vg-ai-stop"; this.stopEl.title = "停止"; this.stopEl.setAttribute("aria-label", "停止"); setIcon(this.stopEl, "square");
    this.unsubscribe = this.host.session.subscribe(() => this.schedule());
    const ports = this.host.previewPorts;
    if (ports) {
      this.cards = new PreviewCardController(ports, { openGantt: () => this.host.openGantt(), undoEntry: this.host.undoEntry, repreviewed: (from, to) => this.host.session.attachPreview(from, to) }, () => this.schedule());
      this.unsubscribePreviews = [ports.previewPort.subscribe(() => this.schedule()), ports.historyPort.subscribe(() => this.schedule())];
    }
    this.render();
  }
  /** Streaming bursts coalesce into one light render. */
  private schedule(): void { if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.render(); }, 40); }
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
    // A restored or freshly opened conversation appears at once; only new items slide in.
    const switched = this.lastConversationId !== conversation.id;
    if (switched) {
      if (this.lastConversationId !== undefined) this.releasePreviewFocus(conversation.id);
      this.lastConversationId = conversation.id; this.messagesEl.empty(); this.stores.delete(this.messagesEl);
    }
    this.animate = !switched;
    this.statusEl.textContent = session.connected ? "" : "未接続";
    this.statusEl.dataset.state = session.connected ? conversation.status : "disconnected";
    this.statusEl.hidden = session.connected;
    this.historyEl.empty();
    for (const item of session.conversations) {
      const button = this.button(this.historyEl, item.title, () => { session.select(item.id); this.historyEl.parentElement?.removeAttribute("open"); });
      button.setAttribute("aria-current", String(item.id === conversation.id));
    }
    const selected = this.host.selectedTask?.();
    this.contextEl.hidden = !selected;
    this.contextEl.textContent = selected ? "選択中: " + selected : "";
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
    const cid = conversation.id;
    const items: SyncItem[] = [];
    if (session.config.connectionError) {
      const text = session.config.connectionError;
      items.push({ key: cid + "/connection-error", sig: text, build: () => { const error = this.make("p", "vg-ai-error"); error.textContent = text; return error; } });
    }
    if (!conversation.messages.length) {
      items.push({ key: cid + "/empty", sig: String(session.connected), build: () => {
        const empty = this.make("div", "vg-ai-empty");
        const emptyIcon = this.element(empty, "div"); emptyIcon.className = "vg-ai-empty-icon"; emptyIcon.setAttribute("aria-hidden", "true"); setIcon(emptyIcon, "messages-square");
        this.element(empty, "strong").textContent = "AIチャット";
        this.element(empty, "p").textContent = session.connected ? "タスクの質問や、変更の相談ができます。" : "歯車ボタンから設定画面を開き、接続先とモデルを設定してください。";
        return empty;
      } });
    }
    const known = new Set<string>();
    for (const message of conversation.messages) for (const part of partsOf(message)) if (part.type === "proposal") known.add(part.previewId);
    const orphans = this.orphanPreviews(cid, known);
    const lastAssistant = conversation.messages.length - 1;
    for (const [index, message] of conversation.messages.entries()) {
      const last = index === lastAssistant && message.role === "assistant";
      items.push({
        key: cid + "/m" + index, sig: message.role,
        build: () => this.messageShell(message.role),
        update: (shell) => {
          if (last && running) shell.dataset.streaming = "true"; else delete shell.dataset.streaming;
          // Parts of a message that is sliding in as a whole do not animate on their own.
          const outer = this.animate; if (shell.classList.contains("vg-ai-enter") && this.freshShells.delete(shell)) this.animate = false;
          this.sync(this.partsOfShell.get(shell)!, this.partItems(cid, index, message, last, running, last ? orphans : []));
          this.animate = outer;
        },
      });
    }
    // Cards of this conversation with no reply to sit in (not expected in practice) still show up.
    if (!conversation.messages.some((message) => message.role === "assistant")) for (const preview of orphans) items.push(this.proposalItem(cid + "/orphan:" + preview.previewId, undefined, preview.previewId, running));
    this.sync(this.messagesEl, items);
    if (this.cards) this.cards.pager.prune(new Set(this.host.previewPorts!.previewPort.list().map((preview) => preview.previewId)));
    restoreFocusKey(this.messagesEl, focusKey);
    if (stickToBottom) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }
  /** Previews of this conversation that no message part points to yet (e.g. a re-preview started from a card). */
  private orphanPreviews(conversationId: string, known: Set<string>): OperationPreviewV1[] {
    const ports = this.host.previewPorts; if (!ports || !this.cards) return [];
    return ports.previewPort.list().filter((preview) => preview.origin.kind === "chat" && preview.origin.conversationId === conversationId && !known.has(preview.previewId))
      .slice().sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }
  // eslint-disable-next-line no-undef
  private make<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] { const element = document.createElement(tag); element.className = className; return element; }
  private messageShell(role: ChatMessage["role"]): HTMLElement {
    const shell = this.make("section", "vg-ai-message vg-ai-" + role);
    if (role === "user") {
      const bubble = this.element(shell, "div"); bubble.className = "vg-ai-bubble"; this.partsOfShell.set(shell, bubble);
      return shell;
    }
    const avatar = this.element(shell, "div"); avatar.className = "vg-ai-avatar"; avatar.setAttribute("aria-hidden", "true"); setIcon(avatar, "sparkles");
    const column = this.element(shell, "div"); column.className = "vg-ai-column";
    this.element(column, "strong").className = "vg-ai-name"; column.children[0].textContent = "AI";
    const parts = this.element(column, "div"); parts.className = "vg-ai-parts"; this.partsOfShell.set(shell, parts);
    return shell;
  }
  /** Reconciles `container` with `items`: unchanged items keep their element (open details, scroll, selection), changed ones are rebuilt in place. */
  private sync(container: HTMLElement, items: SyncItem[]): void {
    let store = this.stores.get(container);
    if (!store) { store = new Map(); this.stores.set(container, store); }
    const wanted = new Set(items.map((item) => item.key));
    for (const [key, entry] of store) if (!wanted.has(key)) { entry.el.remove(); store.delete(key); }
    let previous: HTMLElement | null = null;
    for (const item of items) {
      let entry = store.get(item.key);
      if (!entry || entry.sig !== item.sig) {
        const el = item.build();
        if (this.animate && !this.seen.has(item.key)) { el.classList.add("vg-ai-enter"); this.freshShells.add(el); }
        this.seen.add(item.key);
        if (entry) { const old = entry.el; container.insertBefore(el, old); old.remove(); }
        entry = { el, sig: item.sig }; store.set(item.key, entry);
      }
      const expected: HTMLElement | null = previous ? previous.nextSibling as HTMLElement | null : (container.children[0] as HTMLElement | undefined) ?? null;
      if (entry.el !== expected || entry.el.parentNode !== container) container.insertBefore(entry.el, expected);
      item.update?.(entry.el);
      previous = entry.el;
    }
    if (this.seen.size > 5000) this.seen.clear();
  }
  private partItems(cid: string, index: number, message: ChatMessage, last: boolean, running: boolean, orphans: OperationPreviewV1[]): SyncItem[] {
    const prefix = cid + "/m" + index + "/";
    const items: SyncItem[] = [];
    const parts = partsOf(message);
    for (const part of parts) {
      const key = prefix + part.id;
      if (part.type === "text") items.push({ key, sig: part.text, build: () => { const body = this.make("div", "vg-ai-text"); renderChatText(body, part.text); return body; } });
      else if (part.type === "reasoning") items.push({ key, sig: part.state + part.text, build: () => this.reasoningRow(key, part) });
      else if (part.type === "tool") items.push({ key, sig: [part.state, part.input !== undefined, part.output !== undefined, part.error ?? ""].join("|"), build: () => this.toolRow(key, part) });
      else items.push(this.proposalItem(key, message, part.previewId, running));
    }
    for (const preview of orphans) items.push(this.proposalItem(prefix + "orphan:" + preview.previewId, message, preview.previewId, running));
    if (message.role === "assistant" && last && running) {
      const tail = parts.at(-1);
      const waiting = !tail || !(tail.type === "text" || (tail.type === "reasoning" && tail.state === "streaming") || (tail.type === "tool" && tail.state === "running"));
      if (waiting) items.push({ key: prefix + "typing", sig: "", build: () => {
        const typing = this.make("div", "vg-ai-typing"); typing.setAttribute("role", "status"); typing.setAttribute("aria-label", "応答を待っています");
        for (let dot = 0; dot < 3; dot++) this.element(typing, "span");
        return typing;
      } });
    }
    const line = completionLine(message.completion);
    if (line && !running && message.completion) items.push({ key: prefix + "completion", sig: line, build: () => {
      const note = this.make("p", "vg-ai-completion"); note.dataset.kind = message.completion!.kind; note.setAttribute("role", "status"); note.textContent = line; return note;
    } });
    const status = this.host.session.active.status;
    if (message.role === "assistant" && last && ["failed", "cancelled"].includes(status)) {
      const completed = !!message.completion;
      const error = this.host.session.active.error;
      items.push({ key: prefix + "failure", sig: [completed, error, running, this.host.session.connected].join("|"), build: () => {
        const box = this.make("div", "vg-ai-failure");
        if (!completed) { const text = this.element(box, "p"); text.className = "vg-ai-error"; text.textContent = error; }
        this.button(box, "応答を再試行", () => { void this.host.session.retry(); }).disabled = running || !this.host.session.connected;
        return box;
      } });
    }
    return items;
  }
  private statusMark(parent: HTMLElement, state: "running" | "done" | "error"): void {
    const mark = this.element(parent, "span"); mark.className = "vg-ai-mark is-" + state; mark.setAttribute("aria-hidden", "true");
    if (state === "done") setIcon(mark, "check"); else if (state === "error") setIcon(mark, "x");
  }
  private detailsRow(key: string, className: string, defaultOpen: boolean): HTMLDetailsElement {
    const details = this.make("details", className);
    details.open = this.openState.get(key) ?? defaultOpen;
    // Only a change the reader makes is remembered; the toggle event of the initial state is not one.
    let last = details.open;
    details.addEventListener("toggle", () => { if (details.open !== last) { last = details.open; this.openState.set(key, details.open); } });
    return details;
  }
  private reasoningRow(key: string, part: Extract<ChatPart, { type: "reasoning" }>): HTMLElement {
    const streaming = part.state === "streaming";
    const details = this.detailsRow(key, "vg-ai-reasoning", streaming);
    details.dataset.state = part.state;
    const summary = this.element(details, "summary");
    this.statusMark(summary, streaming ? "running" : "done");
    this.element(summary, "span").textContent = streaming ? "考え中…" : "考えた内容";
    const body = this.element(details, "div"); body.className = "vg-ai-reasoning-body"; body.textContent = part.text;
    if (streaming) body.scrollTop = body.scrollHeight;
    return details;
  }
  private toolRow(key: string, part: Extract<ChatPart, { type: "tool" }>): HTMLElement {
    const details = this.detailsRow(key, "vg-ai-tool", false);
    details.dataset.state = part.state;
    const label = toolLabel(part.name);
    const summary = this.element(details, "summary"); summary.setAttribute("aria-label", label + (part.state === "running" ? "（実行中）" : part.state === "error" ? "（失敗）" : "（完了）"));
    this.statusMark(summary, part.state);
    this.element(summary, "span").textContent = label;
    const sections: [string, unknown][] = [["入力", part.input], ["出力", part.error !== undefined ? part.error : part.output]];
    for (const [title, value] of sections) {
      if (value === undefined) continue;
      const text = prettyJson(value);
      const block = this.element(details, "div"); block.className = "vg-ai-io";
      this.element(block, "div").textContent = title;
      const pre = this.element(block, "pre"); pre.className = "vg-ai-json";
      const id = key + ":" + title;
      const clipped = text.length > PREVIEW_CHARS && !this.expanded.has(id);
      pre.textContent = clipped ? text.slice(0, PREVIEW_CHARS) + "…" : text;
      if (clipped) {
        const more = this.button(block, "もっと見る", () => { this.expanded.add(id); pre.textContent = text; more.remove(); });
        more.className = "vg-ai-more";
      }
    }
    return details;
  }
  private proposalItem(key: string, message: ChatMessage | undefined, previewId: string, running: boolean): SyncItem {
    const ports = this.host.previewPorts;
    const preview = this.cards && ports ? ports.previewPort.inspect(previewId) : undefined;
    if (preview && this.cards) {
      const options = this.cards.optionsFor(preview);
      const sig = JSON.stringify([preview, { ...options, handlers: undefined, now: undefined }, cardState(preview, options.outcome, options.undoState, options.now ?? Date.now())]);
      return { key, sig, build: () => { const slot = this.make("div", "vg-ai-card-slot"); renderOperationPreviewCard(slot, preview, options); return slot; } };
    }
    const proposal = message?.proposals.find((item) => item.plan.previewId === previewId);
    const undoStatus = proposal?.result ? this.host.undoStatus?.(proposal.result) : undefined;
    const canUndo = proposal?.result ? this.host.canUndo(proposal.result) : false;
    return { key, sig: JSON.stringify([!!proposal, proposal?.result, proposal?.consumed, proposal?.retryPrepared, running, undoStatus, canUndo, proposal?.plan.diffs]), build: () => {
      const slot = this.make("div", "vg-ai-card-slot"); if (proposal) this.renderProposal(slot, proposal, running); return slot;
    } };
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
  private resizeInput(): void { this.inputEl.style.height = "auto"; this.inputEl.style.height = Math.max(40, Math.min(160, this.inputEl.scrollHeight)) + "px"; }
  private renderProposal(parent: HTMLElement, proposal: Proposal, running: boolean): void {
    if (this.cards && this.host.previewPorts?.previewPort.inspect(proposal.plan.previewId)) return;
    const item = this.element(parent, "div"); item.className = "vg-ai-diff";
    const undone = !!proposal.result && this.host.undoStatus?.(proposal.result) === "undone";
    item.dataset.state = proposal.result ? (undone ? "undone" : proposal.result.kind) : "proposal";
    const outcomes = { success: "保存済み", partial: "一部保存", failed: "失敗", cancelled: "停止済み", stale: "失効" };
    const status = this.element(item, "span"); status.className = "vg-ai-result-status"; status.setAttribute("role", "status");
    status.textContent = proposal.result ? (this.host.undoStatus?.(proposal.result) === "undone" ? "元に戻しました" : outcomes[proposal.result.kind]) : "未承認";
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
    if (!proposal.consumed) { const confirm = this.button(actions, "承認して保存", () => { void this.host.session.confirm(proposal); }); confirm.classList.add("mod-cta"); confirm.disabled = running; }
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
