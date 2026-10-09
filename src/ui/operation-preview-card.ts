import type { HistoryEntryUndoStateV1, PreviewUiHostPorts, ProjectionDetailPort } from "../contracts/ports";
import type { ReadResultV1, RequestOrigin } from "../contracts/context";
import { mergeProjectionPages, type GanttProjectionV1, type OperationOutcomeV1, type OperationPreviewV1, type PreviewEntry, type ProjectionPageV1 } from "../contracts/preview";
import { buildNameMap, h, renderEntryEffects, type RenderContext } from "./preview-renderers";

export type CardState = "pending" | "applying" | "success" | "partial" | "failed" | "cancelled" | "rejected" | "stale" | "expired" | "revoked" | "undone";
export const STATE_LABELS: Record<CardState, string> = {
  pending: "未承認", applying: "適用中", success: "適用済み", partial: "一部適用", failed: "失敗", cancelled: "停止済み",
  rejected: "却下", stale: "失効", expired: "期限切れ", revoked: "接続の失効", undone: "元に戻しました",
};
const GROUP_LABELS: Record<string, string> = { T: "タスク", M: "マーカー・時間", E: "イベント", W: "定例作業", D: "Daily ToDo", S: "設定", V: "表示", Q: "チャット" };
const UNDO_STATE_TEXT: Record<HistoryEntryUndoStateV1["state"], string> = {
  available: "元に戻せます", "not-latest": "履歴の先頭ではないため元に戻せません", conflict: "保存後に別の変更があり、元に戻せません",
  invalidated: "履歴が無効になり、元に戻せません", missing: "履歴が見つからず、元に戻せません", busy: "他の処理が実行中のため、今は元に戻せません", "already-undone": "元に戻しました",
};
const VISIBILITY_TEXT = {
  visible: "表示されます", filtered: "絞り込みで非表示", "feature-disabled": "機能がオフで非表示", unscheduled: "日程が未設定のため描画なし", "outside-range": "表示範囲の外",
} as const;
const SYSTEM_CAUSES = { priority: "優先度の自動計算", holidays: "祝日の更新", sync: "同期" } as const;

export function originLabel(origin: RequestOrigin): string {
  switch (origin.kind) {
    case "chat": return "チャット";
    case "mcp": return `MCP · ${origin.clientLabel.trim() || "名称なし"}`;
    case "ui": return "画面操作";
    case "system": return `自動処理 · ${SYSTEM_CAUSES[origin.cause]}`;
  }
}
export function operationTitle(operationId: string): string { return `${GROUP_LABELS[operationId[0]] ?? "操作"} · ${operationId}`; }
export function cardState(preview: OperationPreviewV1, outcome: OperationOutcomeV1 | undefined, undo: HistoryEntryUndoStateV1 | undefined, now: number): CardState {
  if (outcome) return outcome.status === "success" && undo?.state === "already-undone" ? "undone" : outcome.status;
  if (preview.status === "pending" && now >= Date.parse(preview.expiresAt)) return "expired";
  return preview.status;
}
function clock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export interface PreviewCardHandlers {
  onFocus?(): void;
  onApprove?(): void;
  onReject?(): void;
  onRepreview?(): void;
  onUndo?(entryId: string): void;
  /** Fetch the next projection page; the host merges pages and re-renders with `projection`. */
  onLoadMore?(cursor: string): void;
}
export interface PreviewCardOptions {
  readonly outcome?: OperationOutcomeV1;
  readonly focused?: boolean;
  /** An approval call is in flight in this UI. */
  readonly busy?: boolean;
  readonly now?: number;
  readonly undoState?: HistoryEntryUndoStateV1;
  /** Projection merged from several pages. Defaults to the preview/outcome projection. */
  readonly projection?: GanttProjectionV1 | null;
  readonly loadingMore?: boolean;
  readonly loadError?: string;
  /** Last approve/reject/undo failure shown on the card. */
  readonly actionError?: string;
  readonly handlers?: PreviewCardHandlers;
  readonly entryLimit?: number;
}

function button(parent: HTMLElement, text: string, action: string, onClick: (() => void) | undefined, previewId: string, disabled = false): HTMLButtonElement {
  const element = h(parent, "button", "vg-pv-button", text) as HTMLButtonElement;
  element.type = "button"; element.disabled = disabled || !onClick; element.dataset.action = action; element.dataset.focusKey = previewId + ":" + action;
  if (onClick) element.addEventListener("click", onClick);
  return element;
}

function renderHeader(card: HTMLElement, preview: OperationPreviewV1, state: CardState): void {
  const header = h(card, "header", "vg-pv-header");
  const top = h(header, "div", "vg-pv-headtop");
  const status = h(top, "span", "vg-pv-status", STATE_LABELS[state]); status.setAttribute("role", "status");
  h(top, "strong", "vg-pv-title", (preview.operationLabel ?? operationTitle(preview.operationId)));
  const meta = h(header, "div", "vg-pv-meta");
  h(meta, "span", "", `対象 ${preview.summary.targetCount}件 · 操作 ${preview.summary.actionCount}件`);
  const origin = h(meta, "span", "vg-pv-origin", "要求元: " + originLabel(preview.origin)); origin.dataset.origin = preview.origin.kind;
  if (state === "pending" || state === "expired") h(meta, "span", "", (state === "expired" ? "期限 " : "期限 ") + clock(preview.expiresAt));
  if (preview.origin.kind === "mcp") {
    const detail = h(header, "div", "vg-pv-mcp");
    h(detail, "div", "", `クライアントが名乗っている名前です（認証済みの名前ではありません）。登録ID: ${preview.origin.principalId}`);
    h(detail, "div", "", `対象のVault: ${preview.vaultInstanceId}`);
    if (state === "pending") h(detail, "div", "", "外部のAIは提案だけを行います。保存はこの画面で承認したあとに行われます。");
  }
}

function renderUndo(card: HTMLElement, preview: OperationPreviewV1, outcome: OperationOutcomeV1 | undefined, undoState: HistoryEntryUndoStateV1 | undefined): void {
  const line = h(card, "div", "vg-pv-undo");
  if (outcome && outcome.undoEntryId) {
    const live = undoState ? UNDO_STATE_TEXT[undoState.state] : "元に戻せるか確認中です";
    line.textContent = "元に戻す: " + live + (undoState?.reason ? `（${undoState.reason}）` : "");
    return;
  }
  const texts = { full: "保存後、全体を元に戻せます", partial: "保存後、一部だけ元に戻せます", none: "保存後は元に戻せません" } as const;
  line.textContent = "元に戻す: " + texts[preview.undo.support] + (preview.undo.reason ? `（${preview.undo.reason}）` : "");
}

function renderProjectionNotes(card: HTMLElement, projection: GanttProjectionV1 | null, kind: "planned" | "actual", options: PreviewCardOptions, previewId: string): void {
  if (!projection) {
    if (kind === "actual") h(card, "p", "vg-pv-note", "保存された内容はGanttの表示に影響しません。");
    return;
  }
  const box = h(card, "div", "vg-pv-projection"); box.setAttribute("role", "group"); box.setAttribute("aria-label", "Ganttでの見え方");
  const { coverage } = projection;
  h(box, "div", "vg-pv-subtitle", kind === "actual" ? "保存された分のGantt表示" : "Gantt表示への影響");
  const names = buildNameMap(projection);
  const hidden = projection.visibility.filter((item) => item.state !== "visible");
  h(box, "div", "vg-pv-muted", `表示対象 ${projection.visibility.length - hidden.length}件 / 表示されない ${hidden.length}件`);
  for (const state of ["unscheduled", "filtered", "feature-disabled", "outside-range"] as const) {
    const items = hidden.filter((item) => item.state === state);
    if (!items.length) continue;
    const group = h(box, "div", "vg-pv-hidden"); group.dataset.state = state;
    h(group, "div", "vg-pv-hidden-title", `${VISIBILITY_TEXT[state]}: ${items.length}件`);
    for (const item of items.slice(0, 5)) {
      const entity = item.entity;
      const id = entity.kind === "task" ? entity.taskId : entity.kind === "marker" ? entity.taskId : "";
      const name = id ? (names.get(id) ?? id) : entity.kind;
      h(group, "div", "vg-pv-muted", `${name}: ${item.reason}`);
    }
    if (items.length > 5) h(group, "div", "vg-pv-muted", `ほか ${items.length - 5}件`);
  }
  if (coverage.truncated) {
    const more = h(box, "div", "vg-pv-coverage");
    h(more, "span", "", `一部だけ表示しています: 全${coverage.targetCount}件中${coverage.includedCount}件`);
    if (options.handlers?.onLoadMore && coverage.nextCursor) {
      const cursor = coverage.nextCursor;
      button(more, options.loadingMore ? "取得中…" : "続きを取得", "load-more", () => options.handlers?.onLoadMore?.(cursor), previewId, !!options.loadingMore);
    }
  }
  if (options.loadError) { const error = h(box, "p", "vg-pv-note is-error", options.loadError); error.setAttribute("role", "alert"); }
}

function entryStateOf(entry: PreviewEntry, outcome: OperationOutcomeV1 | undefined) {
  return outcome?.actions.find((action) => action.actionId === entry.actionId);
}

function renderEntry(list: HTMLElement, entry: PreviewEntry, ctx: RenderContext, outcome: OperationOutcomeV1 | undefined): void {
  const section = h(list, "section", "vg-pv-entry");
  const action = entryStateOf(entry, outcome);
  section.dataset.state = action?.state ?? "planned";
  const head = h(section, "div", "vg-pv-entryhead");
  h(head, "strong", "vg-pv-entryname", entry.displayName || entry.entity.kind);
  if (action) {
    const labels = { committed: "保存済み", failed: "保存できませんでした", "not-attempted": "未実行" } as const;
    h(head, "span", "vg-pv-badge", labels[action.state]).dataset.kind = action.state;
  }
  const body = h(section, "div", "vg-pv-entrybody");
  if (action?.state === "committed") {
    h(body, "div", "vg-pv-subtitle", "保存された内容");
    // Only the effects the port reports as actually saved.
    if (action.actual.length) renderEntryEffects(body, entry, ctx, action.actual);
    else h(body, "p", "vg-pv-note", "保存された変更はありません。");
  } else {
    if (action) {
      const unsaved = h(body, "p", "vg-pv-note is-warn", action.state === "failed" ? `保存されていません${action.errorCode ? `（${action.errorCode}）` : ""}。以下は保存できなかった変更案です。` : "保存されていません。以下は実行されなかった変更案です。");
      unsaved.setAttribute("role", "note");
    }
    const wrap = h(body, "div", action ? "vg-pv-unsaved" : "vg-pv-planned");
    renderEntryEffects(wrap, entry, ctx);
  }
}

/** The shared card for chat, Gantt side panel and the MCP approval list. */
export function renderOperationPreviewCard(parent: HTMLElement, preview: OperationPreviewV1, options: PreviewCardOptions = {}): HTMLElement {
  const now = options.now ?? Date.now();
  const outcome = options.outcome;
  const state = cardState(preview, outcome, options.undoState, now);
  const handlers = options.handlers ?? {};
  const card = h(parent, "article", "vg-pv-card");
  card.dataset.state = state; card.dataset.previewId = preview.previewId; card.dataset.origin = preview.origin.kind;
  if (options.focused) card.dataset.focused = "true";
  card.setAttribute("role", "group"); card.setAttribute("aria-label", `${(preview.operationLabel ?? operationTitle(preview.operationId))}（${STATE_LABELS[state]}）`);
  renderHeader(card, preview, state);

  for (const warning of preview.warnings) { const line = h(card, "p", "vg-pv-note is-warn", warning.detail || warning.code); line.dataset.code = warning.code; }
  if (outcome) {
    const count = (kind: string) => outcome.actions.filter((action) => action.state === kind).length;
    h(card, "div", "vg-pv-result", `保存済み ${count("committed")}件 · 失敗 ${count("failed")}件 · 未実行 ${count("not-attempted")}件`);
    if (state === "partial" || state === "cancelled") h(card, "p", "vg-pv-note is-warn", "保存できたのは一部だけです。保存済みの分と、保存されていない分を分けて表示しています。");
  }
  if (state === "stale") h(card, "p", "vg-pv-note is-warn", "元のデータが変わったため、この変更案は使えません。再プレビューしてください。");
  if (state === "expired") h(card, "p", "vg-pv-note is-warn", "承認の期限が過ぎました。再プレビューしてください。");

  const projection = outcome ? outcome.actualProjection : (options.projection !== undefined ? options.projection : preview.projection);
  const ctx: RenderContext = { projection, names: buildNameMap(projection ?? preview.projection) };
  const entries = h(card, "div", "vg-pv-entries");
  const limit = options.entryLimit ?? 20;
  for (const entry of preview.entries.slice(0, limit)) renderEntry(entries, entry, ctx, outcome);
  if (preview.entries.length > limit) {
    const rest = h(entries, "details", "vg-pv-rest");
    h(rest, "summary", "", `残りの操作 ${preview.entries.length - limit}件を表示`);
    for (const entry of preview.entries.slice(limit)) renderEntry(rest, entry, ctx, outcome);
  }
  if (!preview.entries.length) h(entries, "p", "vg-pv-note is-noop", "変更する操作はありません。");

  renderProjectionNotes(card, projection, outcome ? "actual" : "planned", options, preview.previewId);
  renderUndo(card, preview, outcome, options.undoState);

  if (options.actionError) h(card, "p", "vg-pv-note is-error", options.actionError).setAttribute("role", "alert");
  const actions = h(card, "div", "vg-pv-actions");
  const hasGantt = outcome ? !!outcome.actualProjection : !!preview.projection;
  const id = preview.previewId;
  const open = state === "pending";
  if (hasGantt && handlers.onFocus) {
    const focus = button(actions, "Ganttで確認", "focus", handlers.onFocus, id);
    focus.setAttribute("aria-pressed", String(!!options.focused));
  }
  if (open || state === "applying" || state === "stale" || state === "expired") {
    const approve = button(actions, state === "applying" || options.busy ? "適用中…" : "承認して保存", "approve", () => {
      // Re-check at click time: the card may have outlived its expiry.
      if (Date.now() >= Date.parse(preview.expiresAt)) { handlers.onRepreview?.(); return; }
      handlers.onApprove?.();
    }, id, !open || !!options.busy || !handlers.onApprove);
    approve.classList.add("mod-cta");
    if (!open) approve.title = state === "applying" ? "保存中です" : "期限切れまたは失効のため保存できません";
    if (state === "stale" || state === "expired") button(actions, "再プレビュー", "repreview", handlers.onRepreview, id);
    if (state !== "applying") button(actions, "却下", "reject", handlers.onReject, id, !!options.busy);
  }
  if ((state === "success" || state === "partial" || state === "cancelled") && outcome?.undoEntryId) {
    const entryId = outcome.undoEntryId;
    const undo = button(actions, "元に戻す", "undo", () => handlers.onUndo?.(entryId), id, options.undoState?.state !== "available");
    undo.title = options.undoState ? UNDO_STATE_TEXT[options.undoState.state] : "元に戻せるか確認中です";
  }
  if ((state === "partial" || state === "cancelled" || state === "failed") && handlers.onRepreview) button(actions, state === "failed" ? "再プレビュー" : "未保存分を再プレビュー", "repreview", handlers.onRepreview, id);
  if (!actions.children.length) actions.remove();
  return card;
}

/** Read results are shown with their scope and omission; the cursor is passed back to the host. */
export function renderReadResultCard(parent: HTMLElement, result: ReadResultV1, handlers: { onLoadMore?(cursor: string): void } = {}): HTMLElement {
  const card = h(parent, "article", "vg-pv-card is-read");
  const data = result.data;
  card.dataset.state = "read"; card.setAttribute("role", "group");
  const titles = { events: "イベントの取得結果", weekly: "定例作業の取得結果", tasks: "タスクの取得結果", daily: "Daily ToDoの取得結果", overview: "全体の概要", project: "親タスクの取得結果", calendar: "休日の取得結果", workload: "作業時間の取得結果", settings: "設定の取得結果", changes: "前回からの変更" } as const;
  card.setAttribute("aria-label", titles[data.kind]);
  const header = h(card, "header", "vg-pv-header");
  const top = h(header, "div", "vg-pv-headtop"); h(top, "span", "vg-pv-status", "読み取り"); h(top, "strong", "vg-pv-title", titles[data.kind]);
  h(header, "div", "vg-pv-meta", `基準日 ${result.today} · ${result.timezone}`);
  if (data.kind === "tasks" || data.kind === "daily" || data.kind === "events" || data.kind === "weekly") {
    const total = data.totalMatched;
    h(card, "div", "vg-pv-result", `該当 ${total}件のうち ${data.returned}件を取得`);
    const list = h(card, "ul", "vg-pv-readlist");
    if (data.kind === "tasks") for (const item of data.items) {
      const schedule = "schedule" in item && item.schedule ? `${item.schedule.start ?? "未設定"} ～ ${item.schedule.end ?? "未設定"}` : "";
      h(list, "li", "", `${item.kind === "parent" ? "親" : "子"} · ${item.name}${schedule ? ` · ${schedule}` : ""}`);
    } else if (data.kind === "events") for (const item of data.items) h(list, "li", "", `${item.title} · ${item.date}`);
    else if (data.kind === "weekly") for (const item of data.items) h(list, "li", "", `${item.title} · 曜日${item.dayOfWeek} · ${item.minutesPerWeek}分/週`);
    else for (const day of data.days) h(list, "li", "", `${day.date} · ${day.completedCount}/${day.totalCount}件完了`);
    if (data.truncated) {
      const more = h(card, "div", "vg-pv-coverage");
      h(more, "span", "", `省略あり: 残り ${total - data.returned}件`);
      const cursor = data.nextCursor;
      if (cursor && handlers.onLoadMore) button(more, "続きを取得", "load-more", () => handlers.onLoadMore?.(cursor), "read");
    }
  }
  for (const error of result.errors) h(card, "p", "vg-pv-note is-warn", `${error.code}: ${error.detail}`);
  return card;
}

/** Re-rendering replaces buttons; keep keyboard focus on the same logical control. */
export function captureFocusKey(): string | undefined {
  const active = (typeof document !== "undefined" ? (document as Document & { activeElement?: Element | null }).activeElement : undefined) as HTMLElement | null | undefined;
  return active?.dataset?.focusKey;
}
export function restoreFocusKey(root: HTMLElement, key: string | undefined): void {
  if (!key) return;
  const find = (element: HTMLElement): HTMLElement | undefined => {
    if (element.dataset?.focusKey === key) return element;
    for (const child of Array.from(element.children) as HTMLElement[]) { const found = find(child); if (found) return found; }
    return undefined;
  };
  const target = find(root) as HTMLButtonElement | undefined;
  if (target && !target.disabled) target.focus();
}

interface PagerEntry { pages: ProjectionPageV1[]; merged: GanttProjectionV1 | null; loading: boolean; error: string; key: string }
/** Loads further projection pages for cards. Pages are merged by the contract's own union rules. */
export class CardProjectionPager {
  private readonly entries = new Map<string, PagerEntry>();
  constructor(private readonly port: ProjectionDetailPort, private readonly onChange: () => void) {}
  private keyOf(preview: OperationPreviewV1, outcome?: OperationOutcomeV1): string { return `${preview.previewId}:${outcome?.status ?? preview.status}`; }
  /** undefined = nothing extra loaded; use the preview/outcome projection. */
  projectionFor(preview: OperationPreviewV1, outcome?: OperationOutcomeV1): GanttProjectionV1 | null | undefined {
    const entry = this.entries.get(preview.previewId);
    return entry && entry.key === this.keyOf(preview, outcome) ? entry.merged : undefined;
  }
  loading(previewId: string): boolean { return this.entries.get(previewId)?.loading ?? false; }
  error(previewId: string): string | undefined { return this.entries.get(previewId)?.error || undefined; }
  prune(keep: ReadonlySet<string>): void { for (const id of [...this.entries.keys()]) if (!keep.has(id)) this.entries.delete(id); }
  async loadMore(preview: OperationPreviewV1, outcome?: OperationOutcomeV1): Promise<void> {
    const kind = outcome ? "actual" : "planned";
    const base = outcome ? outcome.actualProjection : preview.projection;
    const key = this.keyOf(preview, outcome);
    let entry = this.entries.get(preview.previewId);
    if (!entry || entry.key !== key) {
      if (!base) return;
      entry = { pages: [{ schemaVersion: 1, previewId: preview.previewId, vaultInstanceId: preview.vaultInstanceId, projectionKind: kind, requestCursor: null, projection: base }], merged: base, loading: false, error: "", key };
      this.entries.set(preview.previewId, entry);
    }
    const cursor = entry.merged?.coverage.nextCursor;
    if (entry.loading || !cursor) return;
    entry.loading = true; entry.error = ""; this.onChange();
    try {
      const result = await this.port.getProjectionPage({ previewId: preview.previewId, cursor, projectionKind: kind });
      if (result.status === "error") {
        entry.error = result.error.nextAction;
        // A stale cursor invalidates every page: fall back to the first page only.
        if (result.error.code === "CURSOR_STALE" || result.error.code === "PLAN_EXPIRED") { entry.pages = entry.pages.slice(0, 1); entry.merged = entry.pages[0].projection; }
      } else {
        const pages = [...entry.pages, result.page];
        entry.merged = mergeProjectionPages(pages); entry.pages = pages;
      }
    } catch (error) {
      entry.error = error instanceof Error ? error.message : "続きを取得できませんでした";
    } finally {
      entry.loading = false; this.onChange();
    }
  }
}

export interface PreviewCardExtras {
  openGantt?(): Promise<void> | void;
  /** Reverse the history entry the outcome refers to (the ports only inspect history). */
  undoEntry?(entryId: string): Promise<void> | void;
}
/** Wires one card to the ports: approve/reject/re-preview/focus/undo, busy flags and errors. */
export class PreviewCardController {
  private readonly busy = new Set<string>();
  private readonly errors = new Map<string, string>();
  readonly pager: CardProjectionPager;
  constructor(private readonly ports: PreviewUiHostPorts, private readonly extras: PreviewCardExtras, private readonly onChange: () => void) {
    this.pager = new CardProjectionPager(ports.projectionDetailPort ?? ports.previewPort, onChange);
  }
  private async run(previewId: string, action: () => Promise<unknown>, failure: string): Promise<void> {
    this.busy.add(previewId); this.errors.delete(previewId); this.onChange();
    try { await action(); }
    catch (error) { this.errors.set(previewId, `${failure}${error instanceof Error && error.message ? `: ${error.message}` : ""}`); }
    finally { this.busy.delete(previewId); this.onChange(); }
  }
  optionsFor(preview: OperationPreviewV1): PreviewCardOptions {
    const { previewPort, humanApprovalPort, historyPort } = this.ports;
    const outcome = previewPort.inspectOutcome(preview.previewId);
    const id = preview.previewId;
    const focused = previewPort.focusedPreviewId() === id;
    return {
      outcome, focused, busy: this.busy.has(id), now: Date.now(),
      undoState: outcome?.undoEntryId ? historyPort.inspectUndo(outcome.undoEntryId) : undefined,
      projection: this.pager.projectionFor(preview, outcome), loadingMore: this.pager.loading(id),
      loadError: this.pager.error(id), actionError: this.errors.get(id),
      handlers: {
        onFocus: () => { previewPort.focus(focused ? null : id); if (!focused) void this.extras.openGantt?.(); },
        onApprove: () => { void this.run(id, () => humanApprovalPort.approve(id), "保存できませんでした"); },
        onReject: () => { void this.run(id, () => previewPort.reject(id), "却下できませんでした"); },
        onRepreview: () => { void this.run(id, async () => { const next = await previewPort.requestRepreview(id); if (previewPort.focusedPreviewId() === id) previewPort.focus(next.previewId); }, "再プレビューできませんでした"); },
        onUndo: (this.ports.undoPort || this.extras.undoEntry) ? (entryId) => { void this.run(id, async () => { if (this.ports.undoPort) await this.ports.undoPort.undoEntry(entryId); else await this.extras.undoEntry?.(entryId); }, "元に戻せませんでした"); } : undefined,
        onLoadMore: () => { void this.pager.loadMore(preview, outcome); },
      },
    };
  }
}
