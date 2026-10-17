import type { ScheduleGhost } from "../app/schedule-ghost";
import type { GanttEvent } from "../core/types";
import type { PreviewPort } from "../contracts/ports";
import {
  mergeProjectionPages, type GanttChildStateV1, type GanttParentStateV1, type GanttProjectionV1,
  type OperationOutcomeV1, type OperationPreviewV1, type ProjectionPageV1,
} from "../contracts/preview";
import type { PointGhost } from "./ghost-layer";
import { deriveHighlights, type CellChange, type DailyChange, type EventChange, type Highlights, type HlState, type PhantomBar, type TotalsChange } from "./preview-highlights";
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
  private marks?: Highlights;
  private readonly seen = new Set<string>();
  private loading = false;
  private loadError = "";
  constructor(private readonly port: PreviewPort) {
    for (const preview of port.list?.() ?? []) this.seen.add(preview.previewId);
    this.unsubscribe = port.subscribe(() => this.refresh());
    this.refresh(false);
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  dispose(): void { this.unsubscribe?.(); this.unsubscribe = undefined; this.listeners.clear(); this.source = undefined; this.derived = undefined; this.marks = undefined; this.merged = null; this.pages = []; }
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
    return source.kind === "actual"
      ? { text: "保存した変更を表示中", title: "保存された変更を強調しています。破線の帯は変更前の位置です。" }
      : { text: "変更案を表示中", title: "変更される場所を強調しています。破線の帯は変更案の位置で、まだ保存されていません。" };
  }
  /** Changed things on the real chart. Undefined when nothing is focused or the preview has no Gantt impact. */
  get highlights(): Highlights | undefined { return this.marks; }
  rowState(id: string): HlState | undefined { return this.marks?.rows.get(id); }
  workloadChanges(entityKey: string): ReadonlyMap<string, CellChange> | undefined { return this.marks?.workload.get(entityKey); }
  totalsChange(date: string): TotalsChange | undefined { return this.marks?.totals.get(date); }
  dailyChange(date: string): DailyChange | undefined { return this.marks?.daily.get(date); }
  get dailyChanges(): ReadonlyMap<string, DailyChange> { return this.marks?.daily ?? new Map(); }
  get eventChanges(): ReadonlyMap<string, EventChange> { return this.marks?.events ?? new Map(); }
  /**
   * Created rows that the live chart cannot show yet (proposal) and deleted rows it no longer shows (saved).
   * Rows that exist on the chart are marked in place instead.
   */
  phantomBars(parentId: string): readonly PhantomBar[] {
    const wanted = this.ghostMode === "proposed" ? "created" : "deleted";
    return (this.marks?.phantoms.get(parentId) ?? []).filter((bar) => bar.state === wanted);
  }
  /**
   * Event chips the live row cannot show: a proposed new/moved event at its new date, or (after saving) a deleted/moved
   * event at its old date. Live chips are marked in place instead.
   */
  phantomEvents(): readonly { event: GanttEvent; state: HlState }[] {
    const proposed = this.ghostMode === "proposed"; const result: { event: GanttEvent; state: HlState }[] = [];
    for (const change of this.marks?.events.values() ?? []) {
      const side = proposed ? change.after : change.before; if (!side) continue;
      const moved = change.state === "changed" && change.before?.date !== change.after?.date;
      if (change.state === "changed" && !moved) continue;
      if (proposed ? change.state === "deleted" : change.state === "created") continue;
      const plan: Record<string, number> = {}; const actual: Record<string, number> = {};
      for (const cell of proposed ? change.afterHours : change.beforeHours) { if (cell.plan) plan[cell.date] = cell.plan; if (cell.actual) actual[cell.date] = cell.actual; }
      result.push({ event: { key: `pv:${change.key}`, title: side.title, date: side.date, workloadPlan: plan, workloadActual: actual }, state: proposed ? (change.state === "created" ? "created" : "changed") : "deleted" });
    }
    return result;
  }
  /** Where the first change is, so the Gantt can scroll to it. */
  focusTarget(): { taskId?: string; date?: string } { return { taskId: this.marks?.firstTaskId, date: this.marks?.firstDate }; }
  /** Changes whenever the highlighted content changes; used to invalidate cached fixed rows. */
  get markKey(): string { return this.marks ? `pv:${this.source?.key}:${this.merged?.coverage.includedCount ?? 0}` : ""; }
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
    this.focusNewChatPreview();
    const next = this.resolve();
    const changed = next?.key !== this.source?.key;
    this.source = next;
    if (changed) {
      this.pages = []; this.loadError = ""; this.loading = false;
      this.merged = next?.projection ?? null;
      this.recompute();
      if (next?.projection) this.pages = [{ schemaVersion: 1, previewId: next.preview.previewId, vaultInstanceId: next.preview.vaultInstanceId, projectionKind: next.kind, requestCursor: null, projection: next.projection }];
    }
    if (notify) for (const listener of this.listeners) listener();
    if (changed && this.merged?.coverage.nextCursor) void this.loadAll();
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
        if (result.error.code === "CURSOR_STALE" || result.error.code === "PLAN_EXPIRED") { this.pages = this.pages.slice(0, 1); this.merged = this.pages[0]?.projection ?? null; this.recompute(); }
      } else {
        const pages = [...this.pages, result.page];
        this.merged = mergeProjectionPages(pages); this.pages = pages; this.recompute();
      }
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : "続きを取得できませんでした";
    } finally {
      this.loading = false; this.notify();
    }
  }
  /** The dedicated preview region is gone, so further projection pages are fetched without a button. */
  private async loadAll(): Promise<void> {
    const key = this.source?.key;
    for (let page = 0; page < 20 && this.source?.key === key && this.merged?.coverage.nextCursor && !this.loadError; page += 1) await this.loadMore();
  }
  private recompute(): void {
    this.derived = this.merged ? deriveOverlay(this.merged) : undefined;
    this.marks = this.merged && this.derived ? deriveHighlights(this.merged, this.derived) : undefined;
  }
  /** A chat proposal created while the Gantt is open is shown right away, unless the person is looking at something else. */
  private focusNewChatPreview(): void {
    if (!this.port.list) return;
    let newest: OperationPreviewV1 | undefined;
    for (const preview of this.port.list()) {
      if (this.seen.has(preview.previewId)) continue;
      this.seen.add(preview.previewId);
      if (preview.status === "pending" && preview.origin.kind === "chat" && preview.projection) newest = preview;
    }
    if (!newest) return;
    const focused = this.port.focusedPreviewId(); const current = focused ? this.port.inspect(focused) : undefined;
    if (!current || current.origin.kind === "chat") this.port.focus(newest.previewId);
  }
  private notify(): void { for (const listener of this.listeners) listener(); }
  close(): void { this.port.focus(null); }
}
