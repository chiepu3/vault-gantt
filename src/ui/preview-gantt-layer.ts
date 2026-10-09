import { diffDays } from "../app/gantt-layout";
import type { ScheduleGhost } from "../app/schedule-ghost";
import type { PreviewPort } from "../contracts/ports";
import {
  mergeProjectionPages, type GanttChildStateV1, type GanttParentStateV1, type GanttProjectionV1, type GanttStateV1,
  type OperationOutcomeV1, type OperationPreviewV1, type ProjectionPageV1,
} from "../contracts/preview";
import type { PointGhost } from "./ghost-layer";
import { originLabel, STATE_LABELS, cardState } from "./operation-preview-card";
import { renderNonGanttPanel } from "./preview-panels";
import { buildNameMap, entityKindLabel, entryTitle, fieldLabel, fmtDate, formatScalar, h, renderAggregates, renderEffect } from "./preview-renderers";
import { periodText } from "./schedule-summary";

export interface PointChange extends PointGhost { readonly taskId: string }
export type RowState = "created" | "deleted" | "changed" | "context";
export interface ChildDiff { readonly id: string; readonly name: string; readonly state: RowState; readonly before?: GanttChildStateV1; readonly after?: GanttChildStateV1; readonly points: readonly PointChange[] }
export interface ParentDiff { readonly id: string; readonly name: string; readonly state: RowState; readonly before?: GanttParentStateV1; readonly after?: GanttParentStateV1; readonly notes: readonly string[]; readonly children: readonly ChildDiff[] }
export interface Overlay {
  readonly ghosts: ReadonlyMap<string, ScheduleGhost>;
  readonly points: ReadonlyMap<string, readonly PointChange[]>;
  readonly deleted: ReadonlySet<string>;
  readonly created: ReadonlySet<string>;
  readonly parents: readonly ParentDiff[];
  /** Created rows that cannot be placed on the chart (no schedule, or hidden parent). */
  readonly unplaced: readonly { readonly id: string; readonly name: string; readonly reason: string }[];
}

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const complete = (period: { start: string | null; end: string | null }): boolean => !!period.start && !!period.end;

function pointsOf(before: GanttChildStateV1 | undefined, after: GanttChildStateV1 | undefined, id: string): PointChange[] {
  const result: PointChange[] = [];
  const dueBefore = before?.due ?? null; const dueAfter = after?.due ?? null;
  if (dueBefore !== dueAfter) result.push({ taskId: id, kind: "deadline", key: "due", label: (after ?? before)?.name ?? "名前なし", before: dueBefore, after: dueAfter });
  const keys = [...new Set([...(before?.markers ?? []), ...(after?.markers ?? [])].map((marker) => marker.key))];
  for (const key of keys) {
    const oldMarker = before?.markers.find((marker) => marker.key === key); const newMarker = after?.markers.find((marker) => marker.key === key);
    if (same(oldMarker, newMarker)) continue;
    result.push({ taskId: id, kind: "marker", key, label: (newMarker ?? oldMarker)?.title ?? "名前なし", before: oldMarker?.date ?? null, after: newMarker?.date ?? null });
  }
  return result;
}

/** Presentation diff of the projector's before/after snapshots. No business rule is applied. */
export function deriveOverlay(projection: GanttProjectionV1): Overlay {
  const ghosts = new Map<string, ScheduleGhost>(); const points = new Map<string, readonly PointChange[]>();
  const deleted = new Set<string>(); const created = new Set<string>(); const parents: ParentDiff[] = [];
  const unplaced: { id: string; name: string; reason: string }[] = [];
  const ids = [...new Set([...projection.affectedParentIds])];
  for (const id of ids) {
    const before = projection.before.parents.find((parent) => parent.id === id); const after = projection.after.parents.find((parent) => parent.id === id);
    const notes: string[] = [];
    if (before && after) {
      if (before.name !== after.name) notes.push(`名前: ${before.name} → ${after.name}`);
      if (before.enabled !== after.enabled) notes.push(`Ganttに表示: ${before.enabled ? "する" : "しない"} → ${after.enabled ? "する" : "しない"}`);
      if (before.order !== after.order) notes.push("並び順が変わります");
      if (!same(before.period, after.period)) notes.push(`集計期間: ${periodText(before.period)} → ${periodText(after.period)}`);
      if (!same(before.tags, after.tags)) notes.push(`タグ: ${before.tags.join("、") || "なし"} → ${after.tags.join("、") || "なし"}`);
    }
    const children: ChildDiff[] = [];
    const childIds = [...new Set([...(before?.children ?? []), ...(after?.children ?? [])].map((child) => child.id))];
    for (const childId of childIds) {
      const oldChild = before?.children.find((child) => child.id === childId); const newChild = after?.children.find((child) => child.id === childId);
      const state: RowState = !oldChild ? "created" : !newChild ? "deleted" : same(oldChild, newChild) ? "context" : "changed";
      const childPoints = state === "context" ? [] : pointsOf(oldChild, newChild, childId);
      if (childPoints.length) points.set(childId, childPoints);
      if (state === "deleted") deleted.add(childId);
      if (state === "created") {
        created.add(childId);
        if (!newChild || !complete(newChild.period)) unplaced.push({ id: childId, name: newChild?.name ?? childId, reason: "日程が未設定のため、Ganttには置かれません" });
        else if (after && !after.enabled) unplaced.push({ id: childId, name: newChild.name, reason: "親がGanttに表示されないため、置かれません" });
      }
      if (oldChild && newChild && !same(oldChild.period, newChild.period)) {
        ghosts.set(childId, { taskId: childId, name: newChild.name, before: { start: oldChild.period.start ?? "", end: oldChild.period.end ?? "" }, after: { start: newChild.period.start ?? "", end: newChild.period.end ?? "" } });
      }
      children.push({ id: childId, name: (newChild ?? oldChild)?.name ?? childId, state, before: oldChild, after: newChild, points: childPoints });
    }
    const state: RowState = !before ? "created" : !after ? "deleted" : notes.length || children.some((child) => child.state !== "context") ? "changed" : "context";
    if (state === "created" && after && !after.enabled) unplaced.push({ id, name: after.name, reason: "Gantt表示がオフのため、置かれません" });
    parents.push({ id, name: (after ?? before)?.name ?? "名前なし", state, before, after, notes, children });
  }
  return { ghosts, points, deleted, created, parents, unplaced };
}

interface LayerSource { readonly key: string; readonly preview: OperationPreviewV1; readonly outcome?: OperationOutcomeV1; readonly kind: "planned" | "actual"; readonly projection: GanttProjectionV1 | null }

/** Projects the one focused preview/outcome onto the Gantt. Holds only display state; never touches live rows. */
export class PreviewGanttLayer {
  private readonly listeners = new Set<() => void>();
  private unsubscribe?: () => void;
  private source?: LayerSource;
  private pages: ProjectionPageV1[] = [];
  private merged: GanttProjectionV1 | null = null;
  private derived?: Overlay;
  private loading = false;
  private loadError = "";
  constructor(private readonly port: PreviewPort) {
    this.unsubscribe = port.subscribe(() => this.refresh());
    this.refresh(false);
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  dispose(): void { this.unsubscribe?.(); this.unsubscribe = undefined; this.listeners.clear(); this.source = undefined; this.derived = undefined; this.merged = null; this.pages = []; }
  get active(): boolean { return !!this.source; }
  get overlay(): Overlay | undefined { return this.derived; }
  get projection(): GanttProjectionV1 | null { return this.merged; }
  get previewId(): string | undefined { return this.source?.preview.previewId; }
  scheduleGhost(taskId: string): ScheduleGhost | undefined { return this.derived?.ghosts.get(taskId); }
  pointsFor(taskId: string): readonly PointChange[] { return this.derived?.points.get(taskId) ?? []; }
  isDeleted(taskId: string): boolean { return !!this.derived?.deleted.has(taskId); }
  /** Rows re-render when this changes: previewId + status + kind + affected revisions. */
  fingerprint(parentPath: string): string {
    const source = this.source; const projection = this.merged;
    if (!source || !projection || !projection.affectedParentIds.includes(parentPath)) return "";
    return `|pv:${source.key}:${projection.coverage.includedCount}`;
  }
  /** Which side the dashed band stands for on the live chart. */
  get ghostMode(): "saved" | "proposed" { return this.source?.kind === "actual" ? "saved" : "proposed"; }
  legend(): { text: string; title: string } | undefined {
    const source = this.source; if (!source) return undefined;
    const label = originLabel(source.preview.origin);
    return source.kind === "actual"
      ? { text: `保存結果 · ${label} · 上: 前（破線） / 下: 後（実線）`, title: "変更前は破線、変更後は実線。◀ ▶は表示範囲外。詳細はカードで確認できます。" }
      : { text: `変更案 · ${label} · 実線: 現在 / 破線: 変更案（後）`, title: "バーは現在の状態です。破線の帯が承認後の位置で、まだ保存されていません。◀ ▶は表示範囲外。詳細はカードで確認できます。" };
  }
  private resolve(): LayerSource | undefined {
    const id = this.port.focusedPreviewId(); if (!id) return undefined;
    const preview = this.port.inspect(id); if (!preview) return undefined;
    const outcome = this.port.inspectOutcome(id);
    const projection = outcome ? outcome.actualProjection : preview.projection;
    // Descriptor version: status + base revision. A re-preview gets a new previewId.
    const key = [preview.previewId, outcome?.status ?? preview.status, outcome ? "actual" : "planned", projection?.baseRevision ?? "none", projection?.coverage.targetCount ?? 0].join(":");
    return { key, preview, outcome, kind: outcome ? "actual" : "planned", projection };
  }
  refresh(notify = true): void {
    const next = this.resolve();
    const changed = next?.key !== this.source?.key;
    this.source = next;
    if (changed) {
      this.pages = []; this.loadError = ""; this.loading = false;
      this.merged = next?.projection ?? null;
      this.derived = this.merged ? deriveOverlay(this.merged) : undefined;
      if (next?.projection) this.pages = [{ schemaVersion: 1, previewId: next.preview.previewId, vaultInstanceId: next.preview.vaultInstanceId, projectionKind: next.kind, requestCursor: null, projection: next.projection }];
    }
    // The preview may be present but have no Gantt impact: the dock still explains that.
    if (notify) for (const listener of this.listeners) listener();
  }
  /** Fetch the next page through the port. Stale cursors discard every page so nothing is mixed. */
  async loadMore(): Promise<void> {
    const source = this.source; const projection = this.merged;
    if (!source || !projection || this.loading || !projection.coverage.nextCursor) return;
    this.loading = true; this.loadError = ""; this.notify();
    try {
      const result = await this.port.getProjectionPage({ previewId: source.preview.previewId, cursor: projection.coverage.nextCursor, projectionKind: source.kind });
      if (this.source?.key !== source.key) return;
      if (result.status === "error") {
        this.loadError = result.error.nextAction;
        if (result.error.code === "CURSOR_STALE" || result.error.code === "PLAN_EXPIRED") { this.pages = this.pages.slice(0, 1); this.merged = this.pages[0]?.projection ?? null; this.derived = this.merged ? deriveOverlay(this.merged) : undefined; }
      } else {
        const pages = [...this.pages, result.page];
        this.merged = mergeProjectionPages(pages); this.pages = pages; this.derived = deriveOverlay(this.merged);
      }
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : "続きを取得できませんでした";
    } finally {
      this.loading = false; this.notify();
    }
  }
  private notify(): void { for (const listener of this.listeners) listener(); }
  close(): void { this.port.focus(null); }

  /** A separate preview region: after-state rows, created/deleted rows, daily totals and panels. */
  renderDock(parent: HTMLElement): HTMLElement | undefined {
    const source = this.source; if (!source) return undefined;
    const { preview, outcome } = source; const projection = this.merged;
    const savedEntries = outcome ? outcome.actions.filter((action) => action.state === "committed").flatMap((action) => {
      const entry = preview.entries.find((entry) => entry.actionId === action.actionId);
      return entry ? [{ ...entry, effects: action.actual }] : [];
    }) : preview.entries;
    const renderedPreview = { ...preview, entries: savedEntries };
    const renderPanels = () => {
      renderNonGanttPanel(dock, renderedPreview, projection);
      if (outcome) {
        const unsaved = preview.entries.filter((entry) => !outcome.actions.some((action) => action.actionId === entry.actionId && action.state === "committed"));
        if (unsaved.length) {
          const section = h(dock, "section", "vg-pv-unsaved"); section.setAttribute("aria-label", "未保存の変更案");
          h(section, "strong", "vg-pv-subtitle", `未保存の変更案（${unsaved.length}件）`);
          h(section, "p", "vg-pv-note", "以下は変更案の内容です。保存されていません。");
          for (const entry of unsaved) { h(section, "div", "vg-pv-muted", entryTitle(entry)); for (const effect of entry.effects) renderEffect(section, effect, { entity: entry.entity, projection: null }); }
        }
      }
    };
    const dock = h(parent, "section", "vg-pv-dock"); dock.setAttribute("role", "region");
    dock.setAttribute("aria-label", source.kind === "actual" ? "保存結果のGantt確認" : "変更案のGantt確認");
    const head = h(dock, "div", "vg-pv-dockhead");
    const state = cardState(preview, outcome, undefined, Date.now());
    dock.dataset.state = state;
    h(head, "span", "vg-pv-status", STATE_LABELS[state]).setAttribute("role", "status");
    h(head, "strong", "vg-pv-title", source.kind === "actual" ? "保存された内容" : "変更案の確認");
    h(head, "span", "vg-pv-origin", "要求元: " + originLabel(preview.origin)).dataset.origin = preview.origin.kind;
    const close = h(head, "button", "vg-pv-button", "閉じる") as HTMLButtonElement; close.type = "button"; close.title = "Gantt確認を終了します（変更案は残ります）";
    close.addEventListener("click", () => this.close());
    if (!projection) { h(dock, "p", "vg-pv-note", source.kind === "actual" ? "保存された内容はGanttの表示に影響しません。" : "この変更案はGanttの表示に影響しません。"); renderPanels(); return dock; }
    const overlay = this.derived ?? deriveOverlay(projection);
    const hidden = projection.visibility.filter((item) => item.state !== "visible");
    const summary = h(dock, "div", "vg-pv-muted", `対象 ${projection.coverage.targetCount}件 · 表示 ${projection.visibility.length - hidden.length}件 · 表示されない ${hidden.length}件`);
    summary.setAttribute("aria-live", "polite");
    for (const item of hidden.slice(0, 6)) {
      const names = buildNameMap(projection);
      const id = item.entity.kind === "task" ? item.entity.taskId : item.entity.kind === "marker" ? item.entity.taskId : "";
      const line = h(dock, "div", "vg-pv-hidden"); line.dataset.state = item.state;
      h(line, "span", "vg-pv-hidden-title", { filtered: "絞り込みで非表示", "feature-disabled": "機能オフで非表示", unscheduled: "日程未設定", "outside-range": "表示範囲外", visible: "" }[item.state]);
      h(line, "span", "vg-pv-muted", ` ${id ? (names.get(id) ?? "名前を取得できない項目") : entityKindLabel(item.entity.kind)}: ${item.reason}`);
    }
    if (hidden.length > 6) h(dock, "div", "vg-pv-muted", `ほか ${hidden.length - 6}件は詳細で確認できます。`);
    if (projection.coverage.truncated) {
      const more = h(dock, "div", "vg-pv-coverage");
      h(more, "span", "", `一部だけ表示しています: 全${projection.coverage.targetCount}件中${projection.coverage.includedCount}件`);
      const next = h(more, "button", "vg-pv-button", this.loading ? "取得中…" : "続きを取得") as HTMLButtonElement; next.type = "button"; next.disabled = this.loading; next.dataset.action = "load-more";
      next.addEventListener("click", () => { void this.loadMore(); });
    }
    if (this.loadError) h(dock, "p", "vg-pv-note is-error", this.loadError).setAttribute("role", "alert");
    renderRows(dock, overlay);
    if (overlay.unplaced.length) {
      const list = h(dock, "div", "vg-pv-unplaced"); list.setAttribute("aria-label", "未配置の作成予定");
      h(list, "div", "vg-pv-subtitle", `未配置（作成予定 ${overlay.unplaced.length}件）`);
      for (const item of overlay.unplaced) h(list, "div", "vg-pv-muted", `${item.name}: ${item.reason}`);
    }
    for (const entry of savedEntries) for (const effect of entry.effects) if (effect.kind === "order") {
      const section = h(dock, "div", "vg-pv-ordered"); h(section, "p", "vg-pv-note", outcome ? "保存された並び順です。" : "仮の並び順です。元の行順とスクロール位置は承認するまで変わりません。");
      renderEffect(section, effect, { entity: entry.entity, projection, names: buildNameMap(projection) });
    }
    renderStateDiffs(dock, projection);
    renderPanels();
    return dock;
  }
}

function span(overlay: Overlay): { min: string; days: number } | undefined {
  const dates: string[] = [];
  for (const parent of overlay.parents) for (const child of parent.children) {
    for (const state of [child.before, child.after]) if (state) { dates.push(...[state.period.start, state.period.end, state.due].filter((d): d is string => !!d)); for (const marker of state.markers) dates.push(marker.date); }
  }
  dates.sort();
  return dates.length ? { min: dates[0], days: diffDays(dates[0], dates[dates.length - 1]) + 1 } : undefined;
}
function place(axis: { min: string; days: number }, start: string, end = start): { left: string; width: string } {
  return { left: (diffDays(axis.min, start) / axis.days) * 100 + "%", width: ((diffDays(start, end) + 1) / axis.days) * 100 + "%" };
}
const ROW_LABELS: Record<RowState, string> = { created: "追加", deleted: "削除", changed: "変更", context: "変更なし" };

function renderRows(dock: HTMLElement, full: Overlay): void {
  // Parents whose snapshot did not change (e.g. a settings-only plan) have nothing to place.
  const overlay: Overlay = { ...full, parents: full.parents.filter((parent) => parent.state !== "context") };
  if (!overlay.parents.length) return;
  const axis = span(overlay);
  const region = h(dock, "div", "vg-pv-gantt"); region.setAttribute("role", "group"); region.setAttribute("aria-label", "変更後の配置（前: 破線 / 後: 実線）");
  if (axis) {
    const ruler = h(region, "div", "vg-pv-gruler");
    h(ruler, "span", "", fmtDate(axis.min).replace(/^\d{4}-/, "")); h(ruler, "span", "vg-pv-muted", `${axis.days}日分`);
    const lastDay = new Date(Date.parse(axis.min + "T00:00:00Z") + (axis.days - 1) * 86400000).toISOString().slice(0, 10);
    h(ruler, "span", "", fmtDate(lastDay).replace(/^\d{4}-/, ""));
  }
  let shown = 0; const limit = 40;
  for (const parent of overlay.parents) {
    const group = h(region, "div", "vg-pv-gparent"); group.dataset.state = parent.state;
    const title = h(group, "div", "vg-pv-gparent-title");
    h(title, "span", "vg-pv-badge", ROW_LABELS[parent.state]).dataset.kind = parent.state;
    h(title, "strong", parent.state === "deleted" ? "is-removed" : "", parent.name);
    for (const note of parent.notes) h(group, "div", "vg-pv-muted", note);
    for (const child of parent.children) {
      if (child.state === "context" && shown >= 5) continue;
      if (shown >= limit) { continue; }
      shown++;
      renderChildRow(group, child, axis);
    }
  }
  const total = overlay.parents.reduce((sum, parent) => sum + parent.children.length, 0);
  if (total > shown) h(region, "div", "vg-pv-muted", `ほか ${total - shown}件の行は省略しています（変更のない行を含みます）。`);
}

function renderChildRow(group: HTMLElement, child: ChildDiff, axis: { min: string; days: number } | undefined): void {
  const row = h(group, "div", "vg-pv-grow"); row.dataset.state = child.state;
  const label = h(row, "div", "vg-pv-glabel");
  h(label, "span", "vg-pv-badge", ROW_LABELS[child.state]).dataset.kind = child.state;
  h(label, "span", child.state === "deleted" ? "vg-pv-gname is-removed" : "vg-pv-gname", child.name);
  const track = h(row, "div", "vg-pv-gtrack");
  const summary = [`前: ${child.before ? periodText(child.before.period) : "なし"}`, `後: ${child.after ? periodText(child.after.period) : "なし"}`].join(" → ");
  row.setAttribute("aria-label", `${child.name}（${ROW_LABELS[child.state]}）${summary}`); row.title = summary;
  if (!axis) return;
  for (const [side, state] of [["before", child.before], ["after", child.after]] as const) {
    if (!state || (child.state === "context" && side === "before")) continue;
    const lane = h(track, "div", `vg-pv-glane is-${side}`);
    const { start, end } = state.period;
    if (start && end) { const bar = h(lane, "span", "vg-pv-gbar"); Object.assign(bar.style, place(axis, start, end)); if (child.state === "deleted") bar.classList.add("is-removed"); }
    else if (start || end) { const tick = h(lane, "span", "vg-pv-gtick"); Object.assign(tick.style, place(axis, (start ?? end) as string)); h(lane, "span", "vg-pv-gnote", start ? "終了日未設定" : "開始日未設定"); }
    else h(lane, "span", "vg-pv-gnote", side === "before" && child.state === "created" ? "" : "日程なし");
  }
  const points = h(track, "div", "vg-pv-glane is-points");
  const draw = (glyph: string, date: string | null, side: "before" | "after", title: string): void => {
    if (!date) return; const node = h(points, "span", `vg-pv-gpoint is-${side}`, glyph); Object.assign(node.style, { left: place(axis, date).left }); node.title = title; node.setAttribute("aria-label", title);
  };
  for (const point of child.points) {
    const glyph = point.kind === "deadline" ? "⚑" : "◆"; const noun = point.kind === "deadline" ? "期限" : "マーカー";
    const title = `${noun}「${point.label}」 前 ${point.before ?? "なし"} → 後 ${point.after ?? "なし"}`;
    draw(glyph, point.before, "before", title + "（前）"); draw(glyph, point.after, "after", title + "（後）");
  }
}

/** Daily chips, tag definitions, weekly work, holidays and fixed-row settings, as before -> after text. */
function renderStateDiffs(dock: HTMLElement, projection: GanttProjectionV1): void {
  const { before, after } = projection;
  const sections: [string, string[]][] = [];
  sections.push(["日別のToDo", dailyLines(before, after)]);
  sections.push(["定例作業", weeklyLines(before, after)]);
  sections.push(["タグ定義", tagLines(before, after)]);
  sections.push(["休日", calendarLines(before, after)]);
  sections.push(["表示の設定", settingLines(before, after)]);
  const visible = sections.filter(([, lines]) => lines.length);
  if (!visible.length && !projection.affectedDates.length) return;
  const box = h(dock, "div", "vg-pv-statediff"); box.setAttribute("role", "group"); box.setAttribute("aria-label", "ほかの表示の変化");
  renderAggregatesIfChanged(box, projection);
  for (const [title, lines] of visible) {
    h(box, "div", "vg-pv-subtitle", title);
    for (const line of lines.slice(0, 12)) h(box, "div", "vg-pv-line", line);
    if (lines.length > 12) h(box, "div", "vg-pv-muted", `ほか ${lines.length - 12}件`);
  }
  if (!box.children.length) box.remove();
}
function renderAggregatesIfChanged(box: HTMLElement, projection: GanttProjectionV1): void {
  const changed = projection.affectedDates.some((date) => !same(projection.before.aggregates.find((a) => a.date === date), projection.after.aggregates.find((a) => a.date === date)));
  if (changed) renderAggregates(box, projection);
}
function dailyLines(before: GanttStateV1, after: GanttStateV1): string[] {
  const dates = [...new Set([...before.daily, ...after.daily].map((day) => day.date))].sort();
  const text = (day?: { totalCount: number; completedCount: number }) => day ? `${day.totalCount}件（完了${day.totalCount ? Math.round(day.completedCount / day.totalCount * 100) : 0}%）` : "なし";
  return dates.flatMap((date) => {
    const oldDay = before.daily.find((day) => day.date === date); const newDay = after.daily.find((day) => day.date === date);
    return same(oldDay, newDay) ? [] : [`${fmtDate(date).replace(/^\d{4}-/, "")}: ${text(oldDay)} → ${text(newDay)}`];
  });
}
function weeklyLines(before: GanttStateV1, after: GanttStateV1): string[] {
  const keys = [...new Set([...before.weekly, ...after.weekly].map((item) => item.key))];
  const text = (item?: { title: string; dayOfWeek: number; minutesPerWeek: number }) => item ? `${item.title}（毎週${"日月火水木金土"[item.dayOfWeek]}曜・${item.minutesPerWeek}分）` : "なし";
  return keys.flatMap((key) => { const oldItem = before.weekly.find((i) => i.key === key); const newItem = after.weekly.find((i) => i.key === key); return same(oldItem, newItem) ? [] : [`${text(oldItem)} → ${text(newItem)}`]; });
}
function tagLines(before: GanttStateV1, after: GanttStateV1): string[] {
  const keys = [...new Set([...before.tagDefinitions, ...after.tagDefinitions].map((item) => item.key))];
  const text = (item?: { name: string; color: string }) => item ? `${item.name}（色 ${item.color}）` : "なし";
  return keys.flatMap((key) => { const oldItem = before.tagDefinitions.find((i) => i.key === key); const newItem = after.tagDefinitions.find((i) => i.key === key); return same(oldItem, newItem) ? [] : [`${text(oldItem)} → ${text(newItem)}`]; });
}
function calendarLines(before: GanttStateV1, after: GanttStateV1): string[] {
  const lines: string[] = []; const names = { manual: "手動の休日", special: "特別休日", national: "祝日" } as const;
  for (const source of ["manual", "special", "national"] as const) {
    const added = after.calendar[source].filter((date) => !before.calendar[source].includes(date)); const removed = before.calendar[source].filter((date) => !after.calendar[source].includes(date));
    if (added.length) lines.push(`${names[source]}を追加: ${added.join("、")}`);
    if (removed.length) lines.push(`${names[source]}を削除: ${removed.join("、")}`);
  }
  return lines;
}
function settingLines(before: GanttStateV1, after: GanttStateV1): string[] {
  const left = before.settings as Record<string, unknown>; const right = after.settings as Record<string, unknown>;
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].filter((key) => !same(left[key], right[key]) && key !== "ganttTags").map((key) => `${fieldLabel(key)}: ${formatScalar(key, left[key])} → ${formatScalar(key, right[key])}`);
}
