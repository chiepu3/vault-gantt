import { diffDays } from "../app/gantt-layout";
import { DEFAULT_STATUSES } from "../core/constants";
import type { EntityRef, GanttProjectionV1, GanttStateV1, PreviewEffect, PreviewEffectKind, PreviewEntry, FieldChange } from "../contracts/preview";
import { renderScheduleTimeline } from "./schedule-timeline";

/** Everything the effect renderers may use besides the effect itself (all supplied by ports). */
export interface RenderContext {
  readonly entity?: EntityRef;
  readonly projection?: GanttProjectionV1 | null;
  /** id -> display name taken from the projected before/after snapshots. */
  readonly names?: ReadonlyMap<string, string>;
}

export function h(parent: HTMLElement, tag: string, className = "", text?: string): HTMLElement {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  parent.appendChild(element);
  return element;
}

export const EFFECT_TITLES: Record<PreviewEffectKind, string> = {
  fields: "項目の変更", presence: "作成・削除", schedule: "日程", deadline: "期限", marker: "マーカー", workload: "作業時間",
  order: "並び順", membership: "Ganttへの表示", "tag-definition": "タグ定義", weekly: "定例作業", "daily-todo": "Daily ToDo",
  "service-state": "管理値の保存", calendar: "休日", settings: "設定", view: "表示", "external-send": "外部への送信", diagnostic: "診断ログ", conversation: "チャット",
};

export const FIELD_LABELS: Record<string, string> = {
  displayName: "表示名", title: "タイトル", statusLabel: "状態", createdAt: "作成日", updatedAt: "更新日", dueDate: "期限",
  priority: "優先度", priorityMode: "優先度の決め方", tags: "タグ", completed: "完了", ganttEnabled: "Ganttに表示", ganttOrder: "Ganttでの並び順",
  currentStatus: "現在の状況", notes: "メモ", plannedStartDate: "開始日", plannedEndDate: "終了日", workloadPlan: "予定時間",
  workloadActual: "実績時間", ganttMarkers: "マーカー", derivedPeriod: "親の集計期間", progress: "進捗", effectivePriority: "実効優先度", children: "子タスク",
  key: "キー", date: "日付", dayOfWeek: "曜日", minutesPerWeek: "週あたりの分数", text: "内容", path: "ファイル", sourceKey: "ソース",
  templatePath: "テンプレート", name: "名前", color: "色", order: "順序", label: "ラベル", format: "ファイル名形式",
  creatableFromGantt: "Ganttから作成", position: "開く場所", filterText: "検索文字", statusFilter: "状態の絞り込み", sortKey: "並び替え項目",
  sortDir: "並び替え方向", flatDueSort: "期限順の平坦表示", showCompleted: "完了を表示", expanded: "展開", tagNames: "タグの絞り込み",
  dayWidth: "1日の幅", offset: "ずらし幅", mode: "モード", targetId: "対象", selection: "選択", provider: "プロバイダー",
  endpoint: "接続先URL", model: "モデル", auth: "認証方式", secretId: "秘密ID", status: "状態", activeConversationId: "表示中の会話",
  messageCount: "メッセージ数", destination: "送信先", enabled: "有効", intervalMinutes: "間隔（分）", recording: "記録", outputPath: "保存先", entryCount: "ログ件数",
  taskFolder: "管理タスクのフォルダー", filenameUsesDatePrefix: "ファイル名に日付を付ける", hideCompletedByDefault: "完了済みを初期表示で隠す", currentStatusRows: "現在の状況の行数",
  autoPriorityEnabled: "期限にもとづく優先度の自動設定", ganttManualHolidays: "手動の休日", ganttSpecialHolidays: "特別休暇",
  ganttFeatureDailyTodoEnabled: "Daily ToDoを表示", ganttFeatureWorkloadEnabled: "作業時間を表示", ganttFeatureEventsEnabled: "その他行を表示",
  ganttFeatureSyncEnabled: "同期機能", ganttFeatureTagsEnabled: "タグ機能", incrementalGanttRender: "Gantt差分描画", ganttShowTagsOnBars: "子バーにタグ名を表示",
  ganttShowParentTagsOnChildBars: "子バーに親のタグ名を表示", ganttShowTagsOnParents: "親タスク列にタグ名を表示", ganttSyncEnabled: "定期的な外部同期", ganttSyncUrl: "同期先のURL",
  ganttSyncIntervalMinutes: "同期の間隔（分）", ganttTags: "タグ定義", dailyTodoSources: "Daily ToDoのソース", ganttZoom: "Ganttの拡大率",
  lastAutoPriorityUpdate: "優先度を自動計算した日", ganttNationalHolidaysUpdatedAt: "祝日を更新した日", ganttNationalHolidays: "祝日", ganttHolidays: "休日",
  previewId: "対象の変更案", conversationId: "対象の会話",
  period: "日程", due: "期限", hours: "作業時間", id: "場所", kind: "種類", parentId: "親タスク",
};
const DATE_FIELDS = new Set(["dueDate", "plannedStartDate", "plannedEndDate", "createdAt", "updatedAt", "date"]);
const SECRET_KEY = /secret|token|password|authorization|api[-_]?key/i;
const WEEKDAYS = "日月火水木金土";

export function fmtDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const day = new Date(date + "T00:00:00Z").getUTCDay();
  return Number.isNaN(day) ? date : `${date}（${WEEKDAYS[day]}）`;
}
export const fmtHours = (value: number): string => `${Math.round(value * 100) / 100}h`;
function fmtSigned(value: number, unit: string): string { const rounded = Math.round(value * 100) / 100; return (rounded > 0 ? "+" : "") + rounded + unit; }
export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 102.4) / 10} KB` : `${Math.round(bytes / 104857.6) / 10} MB`;
}
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
/** Internal names never reach the screen: unknown keys read "その他の項目" (the raw key goes in a title attribute). */
export function fieldLabel(field: string): string { return FIELD_LABELS[field] ?? "その他の項目"; }
export const isKnownField = (field: string): boolean => field in FIELD_LABELS;
const VALUE_LABELS: Record<string, Record<string, string>> = {
  provider: { disconnected: "未接続", "openai-compatible": "OpenAI互換" },
  auth: { secret: "秘密ストレージ", none: "認証なし" },
  position: { tab: "タブ", left: "左サイドバー", right: "右サイドバー" },
  sortKey: { dueDate: "期限", name: "名前", status: "状態", priority: "優先度", createdAt: "作成日", updatedAt: "更新日", plannedStartDate: "開始日", plannedEndDate: "終了日" },
  sortDir: { asc: "昇順", desc: "降順" },
  mode: { plan: "予定", actual: "実績" },
  status: { idle: "待機中", running: "実行中", preview: "確認待ち", failed: "失敗", cancelled: "停止済み" },
};
const ENTITY_KIND_LABELS: Record<string, string> = {
  task: "タスク", marker: "マーカー", event: "イベント", weekly: "定例作業", "daily-todo": "Daily ToDo", "daily-file": "デイリーノート",
  "tag-definition": "タグ定義", source: "Daily ToDoのソース", setting: "設定", view: "表示", conversation: "チャット", integration: "外部連携",
};
export function entityKindLabel(kind: string): string { return ENTITY_KIND_LABELS[kind] ?? "その他"; }
const INTERNAL_NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/;
/** Entry heading without internal names: settings use their label, identifier-like display names are replaced. */
export function entryTitle(entry: PreviewEntry): string {
  if (entry.entity.kind === "setting") return fieldLabel(entry.entity.key);
  const name = entry.displayName?.trim();
  if (!name) return entityKindLabel(entry.entity.kind);
  if (entry.entity.kind !== "task" && entry.entity.kind !== "marker" && entry.entity.kind !== "event" && INTERNAL_NAME.test(name)) return FIELD_LABELS[name] ?? entityKindLabel(entry.entity.kind);
  return name;
}

/** One-line text for a value; arrays/objects fall back to JSON so nothing is dropped. */
export function formatScalar(field: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "未設定";
  if (SECRET_KEY.test(field)) return "（表示しません）";
  if (field === "previewId" || field === "conversationId") return "指定済み";
  if (typeof value === "boolean") {
    if (field === "completed") return value ? "完了" : "未完了";
    if (field === "ganttEnabled") return value ? "表示する" : "表示しない";
    return value ? "オン" : "オフ";
  }
  if (typeof value === "number") return field === "ganttOrder" && value >= 100000 ? "末尾（自動）" : field.endsWith("Width") || field === "ganttZoom" ? `${value}px` : String(value);
  if (typeof value === "string") {
    if (field === "statusLabel" || field === "statusFilter") return (DEFAULT_STATUSES as Record<string, string>)[value] ?? (value === "all" ? "すべて" : value);
    if (field === "priorityMode") return value === "auto" ? "自動" : value === "manual" ? "手動" : value;
    if (DATE_FIELDS.has(field)) return fmtDate(value);
    return VALUE_LABELS[field]?.[value] ?? value;
  }
  if (Array.isArray(value) && !value.length) return "なし";
  if (Array.isArray(value)) {
    return value.map((item) => isRecord(item)
      ? Object.entries(item).filter(([key]) => key !== "id").map(([key, value]) => `${fieldLabel(key)}: ${formatScalar(key, value)}`).join(" / ")
      : formatScalar(field, item)).join("、");
  }
  return JSON.stringify(value);
}

/** Renders a value in place. Tags become chips, hour maps become lines, text keeps its line breaks. */
export function renderValue(parent: HTMLElement, field: string, value: unknown): void {
  if (field === "tags" || field === "tagNames") {
    const names = Array.isArray(value) ? value.map(String) : [];
    if (!names.length) { h(parent, "span", "vg-pv-muted", "なし"); return; }
    const chips = h(parent, "span", "vg-pv-chips");
    for (const name of names) h(chips, "span", "vg-pv-chip", name);
    return;
  }
  if ((field === "workloadPlan" || field === "workloadActual") && isRecord(value)) {
    const entries = Object.entries(value);
    if (!entries.length) { h(parent, "span", "vg-pv-muted", "なし"); return; }
    for (const [date, hours] of entries) h(parent, "div", "vg-pv-line", `${date.slice(5).replace("-", "/")} ${typeof hours === "number" ? fmtHours(hours) : String(hours)}`);
    return;
  }
  if (field === "ganttMarkers" && Array.isArray(value)) {
    if (!value.length) { h(parent, "span", "vg-pv-muted", "なし"); return; }
    for (const marker of value) h(parent, "div", "vg-pv-line", isRecord(marker) ? `◆ ${String(marker.title)}（${String(marker.date)}）` : String(marker));
    return;
  }
  if (Array.isArray(value) && value.some(isRecord)) {
    for (const item of value) {
      if (field === "dailyTodoSources" && isRecord(item)) {
        // Stable source IDs stay in the tooltip. Show every editable field,
        // including absent templates, on both sides of the change.
        describeObject(parent, { id: item.key, label: item.label, format: item.format,
          templatePath: item.templatePath ?? null, creatableFromGantt: item.creatableFromGantt });
      } else describeObject(parent, item);
    }
    return;
  }
  const text = formatScalar(field, value);
  const element = h(parent, "span", text === "未設定" || text === "なし" ? "vg-pv-muted" : "vg-pv-text", text);
  if (typeof value === "string" && value.includes("\n")) element.classList.add("is-multiline");
}

/** 前/後 are spelled out so the change never relies on color alone. */
export function beforeAfterRow(parent: HTMLElement, label: string, renderBefore: (el: HTMLElement) => void, renderAfter: (el: HTMLElement) => void, extra = ""): HTMLElement {
  const row = h(parent, "div", "vg-pv-row" + (extra ? " " + extra : ""));
  h(row, "div", "vg-pv-label", label);
  const body = h(row, "div", "vg-pv-values");
  const before = h(body, "div", "vg-pv-before"); h(before, "span", "vg-pv-side", "前"); renderBefore(h(before, "span", "vg-pv-value"));
  const after = h(body, "div", "vg-pv-after"); h(after, "span", "vg-pv-side", "後"); renderAfter(h(after, "span", "vg-pv-value"));
  return row;
}
function fieldRow(parent: HTMLElement, label: string, field: string, before: unknown, after: unknown): void {
  const row = beforeAfterRow(parent, label, (el) => renderValue(el, field, before), (el) => renderValue(el, field, after));
  if (field && !isKnownField(field)) (row.children[0] as HTMLElement).title = field;
}
function note(parent: HTMLElement, text: string, className = "vg-pv-note"): HTMLElement { return h(parent, "p", className, text); }
function badge(parent: HTMLElement, text: string, kind: string): HTMLElement { const element = h(parent, "span", "vg-pv-badge", text); element.dataset.kind = kind; return element; }
function dayShift(before: string, after: string): string {
  const days = diffDays(before, after);
  return days === 0 ? "同じ日" : `${Math.abs(days)}日${days > 0 ? "後ろ" : "前"}へ`;
}

export function buildNameMap(projection: GanttProjectionV1 | null | undefined): Map<string, string> {
  const names = new Map<string, string>();
  if (!projection) return names;
  for (const state of [projection.before, projection.after]) for (const parent of state.parents) {
    names.set(parent.id, parent.name);
    for (const child of parent.children) names.set(child.id, child.name);
  }
  return names;
}
function nameOf(id: string, ctx: RenderContext): string {
  // The id is an internal path; without a projected name it stays out of sight.
  return ctx.names?.get(id) ?? "名前を取得できない項目";
}

/** Date points on one axis (markers/deadlines). Glyph + text, never a zero-day bar. */
export function renderPointTimeline(parent: HTMLElement, glyph: string, noun: string, before: string | null, after: string | null): void {
  const figure = h(parent, "div", "vg-ai-mini-timeline vg-pv-points");
  const dates = [before, after].filter((date): date is string => !!date).sort();
  const summary = `${noun}: 前 ${before ?? "未設定"} → 後 ${after ?? "未設定"}`;
  figure.setAttribute("role", "img"); figure.setAttribute("aria-label", summary); figure.title = summary;
  const base = dates[0]; const span = base ? diffDays(base, dates[dates.length - 1]) + 1 : 0;
  const axis = h(figure, "div", "vg-ai-mini-axis");
  h(axis, "span", "", base?.slice(5).replace("-", "/") ?? "未設定");
  h(axis, "span", "vg-ai-mini-delta", before && after ? dayShift(before, after) : after ? "設定" : before ? "解除" : "未設定");
  h(axis, "span", "", span > 1 ? dates[dates.length - 1].slice(5).replace("-", "/") : "");
  for (const [side, date] of [["before", before], ["after", after]] as const) {
    const row = h(figure, "div", "vg-ai-mini-row vg-ai-mini-" + side);
    h(row, "span", "vg-ai-mini-label", side === "before" ? "前" : "後");
    const track = h(row, "div", "vg-ai-mini-track");
    if (date && base) {
      const point = h(track, "span", "vg-pv-point", glyph);
      point.style.left = `calc(${(span > 1 ? diffDays(base, date) / (span - 1) : 0) * 100}% - 6px)`;
      h(track, "span", "vg-pv-point-note", `${date.slice(5).replace("-", "/")}`);
    } else h(track, "span", "vg-ai-mini-unset", "未設定");
  }
}

/** Daily totals before/after for dates the projector listed as affected. Never sums pages. */
export function renderAggregates(parent: HTMLElement, projection: GanttProjectionV1, limit = 14): void {
  const dates = [...projection.affectedDates].sort();
  if (!dates.length) return;
  const box = h(parent, "div", "vg-pv-aggregates"); box.setAttribute("role", "group"); box.setAttribute("aria-label", "日別の作業時間集計");
  h(box, "div", "vg-pv-subtitle", "日別の集計（前 → 後）");
  const find = (state: GanttStateV1, date: string) => state.aggregates.find((item) => item.date === date);
  for (const date of dates.slice(0, limit)) {
    const before = find(projection.before, date); const after = find(projection.after, date);
    const row = h(box, "div", "vg-pv-agg-row");
    h(row, "span", "vg-pv-agg-date", fmtDate(date).replace(/^\d{4}-/, ""));
    h(row, "span", "vg-pv-agg-plan", `予定 ${before ? fmtHours(before.plan) : "なし"} → ${after ? fmtHours(after.plan) : "なし"}`);
    h(row, "span", "vg-pv-agg-actual", `実績 ${before ? fmtHours(before.actual) : "なし"} → ${after ? fmtHours(after.actual) : "なし"}`);
    const capacity = after?.capacity ?? before?.capacity;
    if (capacity !== undefined) h(row, "span", "vg-pv-agg-cap", `上限 ${fmtHours(capacity)}`);
    if (after?.overCapacity) badge(row, "上限超過", "warn");
    else if (before?.overCapacity) badge(row, "超過解消", "ok");
  }
  if (dates.length > limit) h(box, "div", "vg-pv-muted", `ほか ${dates.length - limit} 日（詳細は日付一覧で確認）`);
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

type Renderer<K extends PreviewEffectKind> = (parent: HTMLElement, effect: Extract<PreviewEffect, { kind: K }>, ctx: RenderContext) => void;

/** `requested` changes stay on top; normalized/derived ones and the update date are folded into a details block. */
function renderFieldChanges(parent: HTMLElement, changes: readonly FieldChange[]): void {
  const main = changes.filter((change) => change.reason === "requested" && change.field !== "updatedAt");
  const folded = changes.filter((change) => !main.includes(change));
  for (const change of main) fieldRow(parent, fieldLabel(change.field), change.field, change.before, change.after);
  if (!folded.length) return;
  const details = h(parent, "details", "vg-pv-derived");
  h(details, "summary", "", `補正・連動した変更（${folded.length}件）`);
  const reasons = { requested: "依頼", normalized: "補正", derived: "連動" } as const;
  for (const change of folded) {
    const row = h(details, "div", "vg-pv-derived-item");
    h(row, "div", "vg-pv-muted", `${reasons[change.reason]} · ${fieldLabel(change.field)}`);
    fieldRow(row, fieldLabel(change.field), change.field, change.before, change.after);
  }
}

/** What disappears with a deleted child, read from the projected "before" snapshot only. */
function renderDeletedContents(parent: HTMLElement, ctx: RenderContext): void {
  const entity = ctx.entity;
  const child = entity?.kind === "task" ? ctx.projection?.before.parents.flatMap((parent) => parent.children).find((item) => item.id === entity.taskId) : undefined;
  if (!child) { note(parent, "関連する時間・マーカーの内訳は取得できませんでした。"); return; }
  const markers = child.markers.map((marker) => `◆ ${marker.title}（${marker.date}）`);
  const planned = child.hours.reduce((sum, cell) => sum + cell.plan, 0); const actual = child.hours.reduce((sum, cell) => sum + cell.actual, 0);
  const list = h(parent, "div", "vg-pv-object is-removed");
  const lines = [`日程: ${child.period.start && child.period.end ? `${child.period.start} ～ ${child.period.end}` : "未設定"}`, `作業時間: 予定 ${fmtHours(planned)} / 実績 ${fmtHours(actual)}（${child.hours.length}日分）`, markers.length ? `マーカー ${markers.length}件` : "マーカー: なし", ...markers];
  for (const text of lines) h(list, "div", "vg-pv-line", text);
}

function describeObject(parent: HTMLElement, value: unknown, removed = false): void {
  const box = h(parent, "div", "vg-pv-object" + (removed ? " is-removed" : ""));
  if (!isRecord(value)) { h(box, "span", "vg-pv-text", formatScalar("", value)); return; }
  // The internal id is not shown; it stays reachable as a tooltip.
  if (typeof value.id === "string") box.title = value.id;
  for (const [key, item] of Object.entries(value)) {
    if (key === "id") continue;
    const line = h(box, "div", "vg-pv-kv");
    h(line, "span", "vg-pv-key", fieldLabel(key));
    renderValue(h(line, "span", "vg-pv-kvvalue"), key, item);
  }
}

function markerLine(parent: HTMLElement, marker: { title: string; date: string; tags: readonly string[] }, removed: boolean): void {
  const line = h(parent, "div", "vg-pv-object" + (removed ? " is-removed" : ""));
  h(line, "div", "vg-pv-text", `◆ ${marker.title}`);
  h(line, "div", "vg-pv-muted", fmtDate(marker.date));
  if (marker.tags.length) renderValue(h(line, "div"), "tags", marker.tags);
}

function totals(cells: readonly { before: { plan: number; actual: number }; after: { plan: number; actual: number } }[]) {
  const sum = (pick: (cell: (typeof cells)[number]) => number) => cells.reduce((total, cell) => total + pick(cell), 0);
  return { planBefore: sum((c) => c.before.plan), planAfter: sum((c) => c.after.plan), actualBefore: sum((c) => c.before.actual), actualAfter: sum((c) => c.after.actual) };
}
function cellText(before: number, after: number): string { return before === after ? `${fmtHours(after)}（変更なし）` : `${fmtHours(before)} → ${fmtHours(after)}（${fmtSigned(after - before, "h")}）`; }

function renderKeyValueDiff(parent: HTMLElement, before: unknown, after: unknown): void {
  const left = isRecord(before) ? before : {}; const right = isRecord(after) ? after : {};
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])];
  const changed = keys.filter((key) => !same(left[key], right[key]));
  if (!isRecord(before) && !isRecord(after)) { fieldRow(parent, "値", "", before, after); return; }
  if (!changed.length) { note(parent, "値の変更はありません。"); return; }
  for (const key of changed) fieldRow(parent, fieldLabel(key), key, left[key], right[key]);
}

const CONVERSATION_ACTIONS = { configure: "接続設定の変更", create: "新しい会話", select: "会話の切り替え", send: "メッセージの送信", stop: "停止", retry: "再試行", "request-approval": "承認の要求", repreview: "再プレビュー" } as const;
const CALENDAR_SOURCES = { manual: "手動の休日", special: "特別休日", national: "祝日" } as const;

export const EFFECT_RENDERERS: { [K in PreviewEffectKind]: Renderer<K> } = {
  fields: (parent, effect) => renderFieldChanges(parent, effect.fields),
  "service-state": (parent, effect) => renderFieldChanges(parent, effect.fields),
  settings: (parent, effect) => renderFieldChanges(parent, effect.fields),
  presence: (parent, effect, ctx) => {
    const labels = { create: "作成", delete: "削除", duplicate: "複製" } as const;
    badge(parent, labels[effect.action], effect.action);
    if (effect.action === "delete") { h(parent, "div", "vg-pv-subtitle", "削除されるもの"); describeObject(parent, effect.before, true); renderDeletedContents(parent, ctx); }
    else if (effect.action === "duplicate") { h(parent, "div", "vg-pv-subtitle", "複製元"); describeObject(parent, effect.before); h(parent, "div", "vg-pv-subtitle", "複製先"); describeObject(parent, effect.after); }
    else { h(parent, "div", "vg-pv-subtitle", "作成されるもの"); describeObject(parent, effect.after); }
  },
  schedule: (parent, effect) => {
    if (same(effect.before, effect.after)) { note(parent, "日程の変更はありません。"); return; }
    renderScheduleTimeline(parent, effect);
    note(parent, effect.unit === "business-day" ? "日数の数え方: 営業日（休日を除く）" : "日数の数え方: 暦日（休日も数える）");
    if (!effect.after.start !== !effect.after.end) note(parent, "片方の日付だけが設定されます。両方そろうまでバーは表示されません。", "vg-pv-note is-warn");
  },
  deadline: (parent, effect) => {
    if (effect.before === effect.after) { note(parent, "期限の変更はありません。"); return; }
    renderPointTimeline(parent, "⚑", "期限", effect.before, effect.after);
  },
  marker: (parent, effect) => {
    const { before, after } = effect;
    if (!before && !after) { note(parent, "マーカーの変更はありません。"); return; }
    if (!before && after) { badge(parent, "追加", "create"); markerLine(parent, after, false); return; }
    if (before && !after) { badge(parent, "削除", "delete"); markerLine(parent, before, true); return; }
    if (!before || !after) return;
    badge(parent, before.date !== after.date ? "移動" : "編集", "update");
    if (before.date !== after.date) renderPointTimeline(parent, "◆", "マーカー", before.date, after.date);
    if (before.title !== after.title) fieldRow(parent, "タイトル", "title", before.title, after.title);
    if (!same(before.tags, after.tags)) fieldRow(parent, "タグ", "tags", before.tags, after.tags);
    if (same(before, after)) note(parent, "マーカーの変更はありません。");
  },
  workload: (parent, effect, ctx) => {
    if (!effect.cells.length) { note(parent, "時間の変更はありません。"); return; }
    const grid = h(parent, "div", "vg-pv-table"); grid.setAttribute("role", "table"); grid.setAttribute("aria-label", "日別の作業時間");
    for (const cell of effect.cells) {
      const row = h(grid, "div", "vg-pv-trow"); row.setAttribute("role", "row");
      h(row, "div", "vg-pv-tdate", fmtDate(cell.date).replace(/^\d{4}-/, ""));
      h(row, "div", "vg-pv-tcell", "予定 " + cellText(cell.before.plan, cell.after.plan));
      h(row, "div", "vg-pv-tcell", "実績 " + cellText(cell.before.actual, cell.after.actual));
    }
    const sum = totals(effect.cells);
    const total = h(grid, "div", "vg-pv-trow is-total"); total.setAttribute("role", "row");
    h(total, "div", "vg-pv-tdate", "合計");
    h(total, "div", "vg-pv-tcell", "予定 " + cellText(sum.planBefore, sum.planAfter));
    h(total, "div", "vg-pv-tcell", "実績 " + cellText(sum.actualBefore, sum.actualAfter));
    if (ctx.projection) renderAggregates(parent, ctx.projection);
  },
  order: (parent, effect, ctx) => {
    if (same(effect.before, effect.after)) { note(parent, "並び順の変更はありません。"); return; }
    const columns = h(parent, "div", "vg-pv-order");
    for (const [side, ids, other] of [["前", effect.before, effect.after], ["後", effect.after, effect.before]] as const) {
      const column = h(columns, "ol", "vg-pv-orderlist"); column.setAttribute("aria-label", `${side}の並び順`);
      h(column, "li", "vg-pv-side-title", side);
      ids.forEach((id, index) => {
        const item = h(column, "li", "vg-pv-orderitem", nameOf(id, ctx));
        item.title = id;
        const position = other.indexOf(id);
        if (position < 0) h(item, "span", "vg-pv-tagmark", side === "前" ? "外れる" : "追加");
        else if (position !== index) h(item, "span", "vg-pv-tagmark", "移動");
      });
    }
  },
  membership: (parent, effect) => {
    beforeAfterRow(parent, "Ganttへの表示", (el) => { el.textContent = effect.before ? "表示対象" : "表示しない"; }, (el) => { el.textContent = effect.after ? "表示対象" : "表示しない"; });
    const labels = { schedule: "日程", workload: "作業時間", markers: "マーカー" } as const;
    note(parent, effect.retained.length ? `保持されるデータ: ${effect.retained.map((item) => labels[item]).join("・")}` : "保持されるデータはありません。");
  },
  "tag-definition": (parent, effect) => {
    const state = effect.before && effect.after ? "変更" : effect.after ? "追加" : "削除";
    badge(parent, state, state === "追加" ? "create" : state === "削除" ? "delete" : "update");
    for (const [side, definition] of [["前", effect.before], ["後", effect.after]] as const) {
      const row = h(parent, "div", side === "前" ? "vg-pv-before" : "vg-pv-after"); h(row, "span", "vg-pv-side", side);
      if (!definition) { h(row, "span", "vg-pv-muted", "なし"); continue; }
      const swatch = h(row, "span", "vg-pv-swatch"); swatch.setAttribute("aria-hidden", "true");
      if (/^(#[0-9a-f]{3,8}|rgba?\([\d\s,.%]+\)|hsla?\([\d\s,.%deg]+\))$/i.test(definition.color)) swatch.style.background = definition.color;
      h(row, "span", "vg-pv-text", `${definition.name} · 色 ${definition.color} · 順序 ${definition.order}`);
    }
    note(parent, effect.affectedCount ? `影響するタグ付け: ${effect.affectedCount}件` : "影響するタグ付けはありません。");
  },
  weekly: (parent, effect, ctx) => {
    const { before, after } = effect;
    if (!before && !after) { note(parent, "定例作業の変更はありません。"); return; }
    badge(parent, !before ? "追加" : !after ? "削除" : "変更", !before ? "create" : !after ? "delete" : "update");
    const text = (state: typeof before) => state ? `${state.title}（毎週${WEEKDAYS[state.dayOfWeek]}曜・${state.minutesPerWeek}分）` : "なし";
    beforeAfterRow(parent, "定例", (el) => { el.textContent = text(before); }, (el) => { el.textContent = text(after); }, !after ? "is-removed" : "");
    if (ctx.projection) renderAggregates(parent, ctx.projection);
  },
  "daily-todo": (parent, effect) => {
    const { before, after } = effect;
    if (!before && !after) { note(parent, "ToDoの変更はありません。"); return; }
    badge(parent, !before ? "追加" : !after ? "削除" : "変更", !before ? "create" : !after ? "delete" : "update");
    const line = (state: typeof before) => state ? `- [${state.completed ? "x" : " "}] ${state.text}` : "なし";
    beforeAfterRow(parent, "ToDo行", (el) => { el.classList.add("is-code"); el.textContent = line(before); }, (el) => { el.classList.add("is-code"); el.textContent = line(after); }, !after ? "is-removed" : "");
    const target = after ?? before;
    if (target) { const where = note(parent, `ファイル: ${target.path}`); where.title = `ソース: ${target.sourceKey}`; }
  },
  calendar: (parent, effect) => {
    if (!effect.added.length && !effect.removed.length) { note(parent, "休日の変更はありません。"); return; }
    h(parent, "div", "vg-pv-subtitle", CALENDAR_SOURCES[effect.source]);
    for (const [label, dates, kind] of [["追加", effect.added, "create"], ["削除", effect.removed, "delete"]] as const) {
      if (!dates.length) continue;
      const group = h(parent, "div", "vg-pv-datelist"); badge(group, `${label} ${dates.length}日`, kind);
      const chips = h(group, "span", "vg-pv-chips");
      for (const date of dates) h(chips, "span", "vg-pv-chip" + (kind === "delete" ? " is-removed" : ""), fmtDate(date).replace(/^\d{4}-/, ""));
    }
    note(parent, "既存の日程は自動で再配置されません。");
  },
  view: (parent, effect, ctx) => {
    renderKeyValueDiff(parent, effect.before, effect.after);
    const before = isRecord(effect.before) ? effect.before.dayWidth : undefined; const after = isRecord(effect.after) ? effect.after.dayWidth : undefined;
    if (typeof before === "number" || typeof after === "number") {
      const strip = h(parent, "div", "vg-pv-zoom"); strip.setAttribute("role", "img"); strip.setAttribute("aria-label", `1日の幅 ${String(before ?? "不明")}px → ${String(after ?? "不明")}px`);
      for (const [side, width] of [["前", before], ["後", after]] as const) {
        const row = h(strip, "div", "vg-ai-mini-row"); h(row, "span", "vg-ai-mini-label", side);
        const track = h(row, "div", "vg-pv-zoomtrack");
        if (typeof width === "number") for (let day = 0; day < 7; day++) { const cell = h(track, "span", "vg-pv-zoomcell"); cell.style.width = `${width}px`; }
        else h(track, "span", "vg-ai-mini-unset", "未設定");
      }
    }
    if (effect.affectedIds.length) {
      const names = effect.affectedIds.slice(0, 10).map((id) => nameOf(id, ctx));
      note(parent, `対象 ${effect.affectedIds.length}件: ${names.join("、")}${effect.affectedIds.length > 10 ? " ほか" : ""}`);
    }
  },
  "external-send": (parent, effect) => {
    note(parent, "承認すると下の内容が外部に送信されます。送信が成功するまで「適用済み」にはなりません。", "vg-pv-note is-warn");
    const rows: [string, string][] = [["送信先", effect.destination], ["対象タスク", `${effect.taskCount}件`], ["送信量", fmtBytes(effect.bytes)]];
    for (const [key, value] of rows) { const line = h(parent, "div", "vg-pv-kv"); h(line, "span", "vg-pv-key", key); const text = h(line, "span", "vg-pv-kvvalue vg-pv-text", value); text.title = key === "送信先" ? `${value}（内容の識別値: ${effect.payloadDigest}）` : value; }
    const sent = h(parent, "div", "vg-pv-kv"); h(sent, "span", "vg-pv-key", "送る項目");
    const chips = h(sent, "span", "vg-pv-chips"); for (const field of effect.fieldsSent) h(chips, "span", "vg-pv-chip", fieldLabel(field));
    if (!effect.fieldsSent.length) h(chips, "span", "vg-pv-muted", "なし");
  },
  diagnostic: (parent, effect) => {
    const rows: [string, string][] = [["ログ記録", effect.recording ? "記録する" : "記録しない"], ["保存先", effect.outputPath ?? "未設定"], ["ログ件数", effect.entryCount === undefined ? "不明" : `${effect.entryCount}件`]];
    for (const [key, value] of rows) { const line = h(parent, "div", "vg-pv-kv"); h(line, "span", "vg-pv-key", key); h(line, "span", "vg-pv-kvvalue vg-pv-text", value); }
    note(parent, "ログ内の秘密情報はここには表示しません。");
  },
  conversation: (parent, effect) => {
    badge(parent, CONVERSATION_ACTIONS[effect.action], "update");
    renderKeyValueDiff(parent, effect.before, effect.after);
  },
};

/** Unknown future kinds still show every field instead of vanishing. */
export function renderGenericEffect(parent: HTMLElement, effect: { readonly kind: string } & Record<string, unknown>): void {
  note(parent, `未対応の変更の種類: ${effect.kind}（内容をそのまま表示します）`, "vg-pv-note is-warn");
  describeObject(parent, Object.fromEntries(Object.entries(effect).filter(([key]) => key !== "kind")));
}

export function effectIsNoop(effect: PreviewEffect): boolean {
  switch (effect.kind) {
    case "fields": case "settings": case "service-state": return effect.fields.every((change) => same(change.before, change.after));
    case "presence": return false;
    case "schedule": case "marker": case "tag-definition": case "weekly": case "daily-todo": case "view": return same(effect.before, effect.after);
    case "deadline": return effect.before === effect.after;
    case "workload": return effect.cells.every((cell) => same(cell.before, cell.after));
    case "order": return same(effect.before, effect.after);
    case "membership": return effect.before === effect.after;
    case "calendar": return !effect.added.length && !effect.removed.length;
    default: return false;
  }
}
/** Only the update date changed: a real change, but not what the user asked for. */
export function onlyUpdatedAt(entry: PreviewEntry): boolean {
  const real = entry.effects.filter((effect) => !effectIsNoop(effect));
  return real.length > 0 && real.every((effect) => effect.kind === "fields" && effect.fields.every((change) => change.field === "updatedAt"));
}

export function renderEffect(parent: HTMLElement, effect: PreviewEffect, ctx: RenderContext = {}): HTMLElement {
  const section = h(parent, "div", "vg-pv-effect");
  section.dataset.kind = effect.kind;
  const title = EFFECT_TITLES[effect.kind] ?? effect.kind;
  section.setAttribute("role", "group"); section.setAttribute("aria-label", title);
  h(section, "div", "vg-pv-effect-title", title);
  const render = EFFECT_RENDERERS[effect.kind] as Renderer<PreviewEffectKind> | undefined;
  if (render) render(section, effect, ctx);
  else renderGenericEffect(section, effect as unknown as { kind: string } & Record<string, unknown>);
  return section;
}

/** All effects of one entry. An empty entry is a request that equals the current state. */
export function renderEntryEffects(parent: HTMLElement, entry: PreviewEntry, ctx: RenderContext = {}, effects: readonly PreviewEffect[] = entry.effects): void {
  const context = { ...ctx, entity: entry.entity };
  const real = effects.filter((effect) => !effectIsNoop(effect));
  if (!real.length) { note(parent, "現在の状態と同じため、変更はありません。", "vg-pv-note is-noop"); return; }
  if (onlyUpdatedAt(entry)) note(parent, "更新日だけが変わります。依頼した内容に差はありません。", "vg-pv-note is-warn");
  for (const effect of real) renderEffect(parent, effect, context);
}

/** Plain Japanese names for all 123 operations. The catalog's own purpose text mixes in UI jargon and is not shown. */
export const OPERATION_LABELS: Record<string, string> = {
  T01: "タスクを検索", T02: "タスクを取得", T03: "親タスクを作成", T04: "子タスクを作成", T05: "Gantt用の親タスクを作成", T06: "指定日に子タスクを作成",
  T07: "名前を変更", T08: "状態を変更", T09: "完了・未完了を切り替え", T10: "現在の状況を更新", T11: "メモを更新", T12: "作成日を変更", T13: "期限を変更",
  T14: "優先度を手動で設定", T15: "優先度を自動に戻す", T16: "タグを変更", T17: "Ganttへの表示を切り替え", T18: "親タスクの並び順を変更",
  T19: "予定の開始日・終了日を設定", T20: "予定をまとめて移動", T21: "予定の開始日を変更", T22: "予定の終了日を変更", T23: "未配置の子タスクを日付に配置",
  T24: "子タスクをGanttから外す", T25: "親の子タスクをまとめて移動", T26: "子タスクを削除", T27: "複数タスクをまとめて更新", T28: "複数タスクの日程をまとめて設定",
  T29: "タスクの項目をまとめて更新", T30: "全タスクの優先度を再計算",
  M01: "マーカーを追加", M02: "マーカーの名前・日付を変更", M03: "マーカーの日付を移動", M04: "マーカーを削除", M05: "マーカーのタグを変更", M06: "マーカーをまとめて置き換え",
  M07: "予定時間を設定", M08: "実績時間を設定",
  E01: "イベントを追加", E02: "イベント名を変更", E03: "イベントを別の日へ移動", E04: "イベントを複製", E05: "イベントを削除", E06: "イベントの予定時間を設定", E07: "イベントの実績時間を設定",
  W01: "定例作業を追加", W02: "定例作業を変更", W03: "定例作業を削除",
  D01: "日別ToDoを取得", D02: "デイリーノートを作成", D03: "ToDoを追加", D04: "ToDoの文面を変更", D05: "ToDoの完了・未完了を切り替え", D06: "ToDoを削除",
  D07: "日別ToDoをまとめて保存", D08: "ToDoの元ノートを開く", D09: "ToDoをすばやく追加",
  S01: "管理タスクのフォルダーを変更", S02: "ファイル名の日付を切り替え", S03: "完了済みを初期表示で隠す設定を変更", S04: "現在の状況の行数を変更", S05: "優先度の自動設定を切り替え",
  S06: "休日を追加・解除", S07: "特別休暇を置き換え", S08: "祝日を更新", S09: "Daily ToDo行の表示を切り替え", S10: "作業時間の表示を切り替え", S11: "その他行の表示を切り替え",
  S12: "同期機能を切り替え", S13: "タグ機能を切り替え", S14: "Gantt差分描画を切り替え", S15: "子バーのタグ名表示を切り替え", S16: "親のタグ名表示を切り替え", S17: "親タスク列のタグ名表示を切り替え",
  S18: "定期的な外部同期を切り替え", S19: "同期先のURLを変更", S20: "同期の間隔を変更", S21: "今すぐ外部同期", S22: "タグ定義を追加", S23: "タグ名を変更", S24: "タグの色を変更",
  S25: "タグの並び順を変更", S26: "タグ定義を削除", S27: "新しいタグを作って付ける", S28: "Daily ToDoのソースを追加", S29: "ソース名を変更", S30: "ソースの書式を変更",
  S31: "ソースのテンプレートを設定", S32: "ソースからのGantt作成を切り替え", S33: "ソースの並び順を変更", S34: "ソースを削除", S35: "Daily Notes設定からソースを取り込む",
  V01: "タスク一覧を開く", V02: "Ganttを開く", V03: "タスク検索を開く", V04: "タスクのノートを開く", V05: "指定日のDaily ToDo編集を開く", V06: "AIチャットを開く",
  V07: "一覧の検索文字を変更", V08: "状態の絞り込みを変更", V09: "並び替えを変更", V10: "期限順の表示を切り替え", V11: "完了タスクの表示を切り替え", V12: "親タスクの展開・折りたたみ",
  V13: "Ganttのタグ絞り込みを変更", V14: "Ganttの拡大率を変更", V15: "日付へ移動", V16: "一覧とGanttを再読み込み", V17: "詳細を表示", V18: "作業時間入力の対象を切り替え",
  V19: "まとめ移動の選択を切り替え", V20: "直前の操作を元に戻す", V21: "元に戻した操作をやり直す", V22: "診断記録を開始", V23: "診断記録を停止して保存",
  Q01: "接続設定を変更", Q02: "会話を作成", Q03: "会話を切り替え", Q04: "メッセージを送信", Q05: "応答を停止", Q06: "失敗した応答を再試行", Q07: "変更案の承認を要求", Q08: "変更案を再プレビュー",
};
export function operationLabel(operationId: string): string { return OPERATION_LABELS[operationId] ?? "操作"; }
