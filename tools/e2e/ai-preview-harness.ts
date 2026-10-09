/* Browser-side harness for tools/e2e/ai-preview.mjs. Bundled into the page of a throw-away Obsidian.
 * It only renders shared contract fixtures through fake ports; nothing here touches a real Vault. */
import * as fixtures from "../../tests/contracts/fixtures";
import { FakePreviewPort, fakePorts } from "../../tests/ui/preview-fakes";
import { renderOperationPreviewCard, renderReadResultCard, PreviewCardController } from "../../src/ui/operation-preview-card";
import { ApprovalView } from "../../src/ui/approval-view";
import { PreviewGanttLayer } from "../../src/ui/preview-gantt-layer";
import type { OperationOutcomeV1, OperationPreviewV1, PreviewEffect } from "../../src/contracts/preview";

const NOW = Date.parse("2026-10-09T03:05:00Z");
const { PARENT_ID, CHILD_ID, DATE } = fixtures;
type Case = { preview: OperationPreviewV1; outcome?: OperationOutcomeV1; options?: Record<string, unknown> };

const EFFECT_META: Record<string, { op: string; entity: unknown; name: string }> = {
  fields: { op: "T09", entity: { kind: "task", taskId: CHILD_ID, parentId: PARENT_ID }, name: "レビュー" },
  presence: { op: "T06", entity: { kind: "task", taskId: CHILD_ID, parentId: PARENT_ID }, name: "新しい子" },
  schedule: { op: "T19", entity: { kind: "task", taskId: CHILD_ID, parentId: PARENT_ID }, name: "レビュー" },
  deadline: { op: "T13", entity: { kind: "task", taskId: CHILD_ID, parentId: PARENT_ID }, name: "レビュー" },
  marker: { op: "M03", entity: { kind: "marker", taskId: CHILD_ID, markerKey: "review-point" }, name: "確認" },
  workload: { op: "M07", entity: { kind: "task", taskId: CHILD_ID, parentId: PARENT_ID }, name: "レビュー" },
  order: { op: "T18", entity: { kind: "task", taskId: PARENT_ID }, name: "親リスト" },
  membership: { op: "T17", entity: { kind: "task", taskId: PARENT_ID }, name: "リリース" },
  "tag-definition": { op: "S22", entity: { kind: "tag-definition", tagKey: "tag-1" }, name: "リリース" },
  weekly: { op: "W01", entity: { kind: "weekly", scheduleKey: "weekly-1" }, name: "定例" },
  "daily-todo": { op: "D03", entity: { kind: "daily-todo", path: "daily/2026-10-13.md", line: 3, itemFingerprint: "line-sha256:fixture" }, name: "確認" },
  calendar: { op: "S06", entity: { kind: "setting", key: "ganttManualHolidays" }, name: "手動の休日" },
  settings: { op: "S10", entity: { kind: "setting", key: "ganttFeatureWorkloadEnabled" }, name: "作業時間機能" },
  view: { op: "V09", entity: { kind: "view", viewId: "gantt-1" }, name: "Gantt" },
  "external-send": { op: "S21", entity: { kind: "integration", targetId: "sync" }, name: "同期" },
  diagnostic: { op: "V22", entity: { kind: "integration", targetId: "diagnostic" }, name: "診断ログ" },
  conversation: { op: "Q07", entity: { kind: "conversation", conversationId: "conversation-2" }, name: "承認の要求" },
};
function wrap(effect: PreviewEffect, index: number): Case {
  const meta = EFFECT_META[effect.kind];
  const base = fixtures.PREVIEW_FIXTURES.create;
  const withProjection = ["schedule", "workload", "marker"].includes(effect.kind);
  const source = effect.kind === "marker" ? fixtures.MARKER_PREVIEW : effect.kind === "workload" ? fixtures.WORKLOAD_PREVIEW : base;
  const preview = {
    ...source, previewId: `effect-${effect.kind}-${index}`, operationId: meta.op,
    entries: [{ actionId: `effect-${index}:0`, entity: meta.entity, displayName: meta.name, effects: [effect] }],
    projection: withProjection ? source.projection : null,
  } as unknown as OperationPreviewV1;
  return { preview };
}
function cases(): Record<string, Case> {
  const out: Record<string, Case> = {};
  fixtures.EFFECT_FIXTURES.forEach((effect, index) => { out[`effect_${String(index).padStart(2, "0")}_${effect.kind}`] = wrap(effect as PreviewEffect, index); });
  const { PREVIEW_FIXTURES: f, BOUNDARY_OUTCOMES: o } = fixtures;
  const saved = (preview: OperationPreviewV1, extra: Partial<OperationOutcomeV1> = {}): OperationOutcomeV1 => ({ previewId: preview.previewId, status: "success", undoEntryId: "undo-1", actions: preview.entries.map((e) => ({ actionId: e.actionId, state: "committed" as const, actual: e.effects })), actualProjection: structuredClone(preview.projection), ...extra });
  out.state_pending = { preview: f.create };
  out.state_applying = { preview: { ...f.create, status: "applying" } };
  out.state_success = { preview: { ...f.marker, status: "success" }, outcome: saved(f.marker) };
  out.state_undone = { preview: { ...f.marker, status: "success" }, outcome: saved(f.marker), options: { undoState: { entryId: "undo-1", historyRevision: "h", state: "already-undone", reason: null } } };
  out.state_partial = { preview: f.partial, outcome: fixtures.PARTIAL_OUTCOME };
  out.state_failed = { preview: f.create, outcome: { previewId: f.create.previewId, status: "failed", actions: [{ actionId: f.create.entries[0].actionId, state: "failed", actual: [], errorCode: "WRITE_FAILED" }], actualProjection: null } };
  out.state_stale = { preview: { ...f.create, status: "stale" } };
  out.state_expired = { preview: f.create, options: { now: Date.parse(f.create.expiresAt) + 60000 } };
  out.state_rejected = { preview: { ...f.create, status: "rejected" } };
  out.state_noop = { preview: { ...f.create, entries: [{ ...f.create.entries[0], effects: [{ kind: "fields", fields: [{ field: "completed", before: true, after: true, reason: "requested" }] }] }], projection: null } };
  out.boundary_one_sided = { preview: f.oneSided };
  out.boundary_filtered = { preview: f.filtered };
  out.boundary_feature_disabled = { preview: f.settings };
  out.boundary_outside_range = { preview: f.outsideRange };
  out.boundary_create = { preview: f.create };
  out.boundary_delete = { preview: f.delete };
  out.boundary_marker = { preview: f.marker };
  out.boundary_workload = { preview: f.workload };
  out.boundary_partial_result = { preview: f.partial, outcome: o.partial };
  out.boundary_truncated = { preview: { ...f.partial, status: "pending", projection: fixtures.PROJECTION_PAGE_FIXTURES[0].projection } };
  out.origin_mcp = { preview: { ...f.mcpOrigin, projection: f.create.projection } };
  out.origin_mcp_empty_client = { preview: { ...f.mcpOrigin, previewId: "mcp-noname", origin: { kind: "mcp", principalId: "principal-2", clientLabel: "" } } };
  out.origin_system = { preview: { ...f.settings, previewId: "system-1", origin: { kind: "system", cause: "holidays" } } };
  const many = Array.from({ length: 24 }, (_, i) => ({ ...f.create.entries[0], actionId: `many:${i}`, displayName: `新しい子 ${i + 1}` }));
  out.many_entries = { preview: { ...f.create, previewId: "many", entries: many, summary: { targetCount: 24, actionCount: 24 } } };
  out.long_names = { preview: { ...f.create, previewId: "long", entries: [{ ...f.create.entries[0], displayName: "とても長い名前のタスクで、サイドバーの狭い幅でも折り返して読めることを確認するための合成データです".repeat(2) }] } };
  return out;
}
function rerender(root: HTMLElement, name: string): HTMLElement {
  const item = cases()[name]; if (!item) throw new Error("unknown case " + name);
  root.empty();
  const section = document.createElement("section"); section.className = "vg-pv-chat-previews"; root.appendChild(section);
  const options = { now: NOW, handlers: { onFocus: () => undefined, onApprove: () => undefined, onReject: () => undefined, onRepreview: () => undefined, onUndo: () => undefined, onLoadMore: () => undefined }, outcome: item.outcome, undoState: item.outcome?.undoEntryId ? { entryId: "undo-1", historyRevision: "h", state: "available" as const, reason: null } : undefined, ...(item.options ?? {}) };
  return renderOperationPreviewCard(section, item.preview, options);
}
/** Same ids as the synthetic Vault so the real Gantt rows line up with fixtures. */
function mapIds<T>(value: T, notePath: string): T {
  return JSON.parse(JSON.stringify(value).split(CHILD_ID).join(`${notePath}::design`).split(PARENT_ID).join(notePath));
}
function movedPreview(notePath: string): OperationPreviewV1 {
  const base = mapIds(fixtures.OUTSIDE_RANGE_PREVIEW, notePath) as any;
  const after = { start: "2026-10-16", end: "2026-10-18" };
  base.previewId = "moved"; base.projection.after.parents[0].children[0].period = after; base.projection.after.parents[0].period = after;
  base.projection.visibility[0] = { entity: base.projection.targets[0], state: "visible", reason: "表示条件に一致" };
  base.entries[0].effects[0].after = after;
  return base;
}
function ganttCases(notePath: string): Record<string, { preview: OperationPreviewV1; outcome?: OperationOutcomeV1 }> {
  const f = fixtures.PREVIEW_FIXTURES;
  const m = <T>(v: T) => mapIds(v, notePath);
  const moved = movedPreview(notePath);
  const markerMoved = m(f.marker); const created = m(f.create); const deleted = m(f.delete); const workload = m(f.workload);
  return {
    moved: { preview: moved },
    moved_saved: { preview: { ...moved, previewId: "moved-saved", status: "success" }, outcome: { previewId: "moved-saved", status: "success", undoEntryId: "undo-1", actions: [{ actionId: moved.entries[0].actionId, state: "committed", actual: moved.entries[0].effects }], actualProjection: moved.projection } },
    outside_range: { preview: m(f.outsideRange) }, one_sided: { preview: m(f.oneSided) }, filtered: { preview: m(f.filtered) }, feature_disabled: { preview: m(f.settings) },
    create: { preview: created }, delete: { preview: deleted }, marker: { preview: markerMoved }, workload: { preview: workload },
    partial: { preview: m(f.partial), outcome: m(fixtures.PARTIAL_OUTCOME) },
  };
}
(window as any).__vgp = {
  caseNames: () => Object.keys(cases()), rerender,
  ganttNames: (notePath: string) => Object.entries(ganttCases(notePath)).map(([name, item]) => [name, item.preview.previewId]),
  makeGanttPort(notePath: string) {
    const port = new FakePreviewPort(); const all = ganttCases(notePath);
    for (const item of Object.values(all)) port.set(item.preview, item.outcome);
    return port;
  },
  readCard(root: HTMLElement) { root.empty(); return renderReadResultCard(root, fixtures.READ_FIXTURES.tasks as any, { onLoadMore: () => undefined }); },
  openApproval(containerEl: HTMLElement) {
    const f = fixtures.PREVIEW_FIXTURES;
    const mcp = (id: string, label: string, createdAt: string, base: OperationPreviewV1, extra: Partial<OperationPreviewV1> = {}) => ({ ...base, previewId: id, origin: { kind: "mcp" as const, principalId: "principal-" + id, clientLabel: label }, createdAt, entries: base.entries.map((e, i) => ({ ...e, actionId: `${id}:${i}` })), ...extra });
    const waiting = mcp("mcp-a", "ローカルMCPクライアント", "2026-10-09T03:04:00Z", f.create);
    const second = mcp("mcp-b", "別のAIツール", "2026-10-09T03:02:00Z", f.marker);
    const done = mcp("mcp-c", "ローカルMCPクライアント", "2026-10-09T03:00:00Z", f.workload, { status: "success" });
    const expired = mcp("mcp-d", "古いクライアント", "2026-10-09T02:00:00Z", f.settings, { expiresAt: "2026-10-09T02:10:00Z" });
    const ports = fakePorts([waiting, second, done, expired]);
    ports.previewPort.outcomes.set("mcp-c", { previewId: "mcp-c", status: "success", undoEntryId: "undo-1", actions: done.entries.map((e) => ({ actionId: e.actionId, state: "committed" as const, actual: e.effects })), actualProjection: structuredClone(done.projection) });
    const view = new (ApprovalView as any)({ containerEl }, { ...ports, openGantt: () => undefined, undoEntry: () => undefined });
    return view.onOpen().then(() => view);
  },
  PreviewGanttLayer, PreviewCardController, fixtures,
};
