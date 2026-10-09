/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { BOUNDARY_OUTCOMES, D02_EMPTY_FILE_PREVIEW, CREATE_PREVIEW, DATE, DELETE_PREVIEW, FILTERED_PREVIEW, MARKER_PREVIEW, MCP_PREVIEW, ONE_SIDED_PREVIEW, OUTSIDE_RANGE_PREVIEW, PARTIAL_OUTCOME, PARTIAL_PREVIEW, PROJECTION_PAGE_FIXTURES, PROJECTION_STALE_ERROR, SETTINGS_PREVIEW, WORKLOAD_PREVIEW } from "../contracts/fixtures";
import { deriveOverlay, PreviewGanttLayer } from "../../src/ui/preview-gantt-layer";
import { renderPointGhosts, renderGhost } from "../../src/ui/ghost-layer";
import { renderNonGanttPanel, panelEffects } from "../../src/ui/preview-panels";
import { createFakeDocument, makeFakeEl, byClass, byTag, deepText, dispatch, type FakeEl } from "../stubs/fake-dom";
import { FakePreviewPort } from "./preview-fakes";

beforeEach(() => { vi.stubGlobal("document", createFakeDocument()); });
afterEach(() => vi.unstubAllGlobals());
const text = (el: unknown) => deepText(el as FakeEl);
const host = () => makeFakeEl("div") as unknown as HTMLElement & FakeEl;

describe("deriveOverlay (presentation diff of the projector's snapshots)", () => {
  it("turns a moved period into a ghost and keeps one-sided dates as empty strings, not 0-day bars", () => {
    const moved = deriveOverlay(OUTSIDE_RANGE_PREVIEW.projection!);
    const ghost = [...moved.ghosts.values()][0];
    expect(ghost.before).toEqual({ start: DATE, end: "2026-10-15" }); expect(ghost.after).toEqual({ start: "2026-12-13", end: "2026-12-15" });
    const oneSided = [...deriveOverlay(ONE_SIDED_PREVIEW.projection!).ghosts.values()][0];
    expect(oneSided.after).toEqual({ start: "", end: "2026-10-15" });
  });
  it("marks created and deleted rows; a deleted row keeps its before state", () => {
    const created = deriveOverlay(CREATE_PREVIEW.projection!);
    expect([...created.created]).toEqual(["tasks/2026/10/リリース.md::new"]);
    expect(created.parents[0].children.map((child) => child.state)).toEqual(["context", "created"]);
    expect(created.unplaced).toHaveLength(0);
    const deleted = deriveOverlay(DELETE_PREVIEW.projection!);
    expect([...deleted.deleted]).toEqual(["tasks/2026/10/リリース.md::review"]);
    expect(deleted.parents[0].children[0].before?.name).toBe("レビュー"); expect(deleted.parents[0].children[0].after).toBeUndefined();
    expect(deleted.parents[0].notes.join()).toContain("集計期間");
  });
  it("lists created rows without a schedule as unplaced instead of drawing a bar", () => {
    const projection = structuredClone(CREATE_PREVIEW.projection!) as any;
    projection.after.parents[0].children[1].period = { start: null, end: null };
    const overlay = deriveOverlay(projection);
    expect(overlay.unplaced).toEqual([{ id: "tasks/2026/10/リリース.md::new", name: "新しい子", reason: "日程が未設定のため、Ganttには置かれません" }]);
  });
  it("tracks marker moves as point changes separate from the schedule ghost", () => {
    const overlay = deriveOverlay(MARKER_PREVIEW.projection!);
    expect(overlay.ghosts.size).toBe(0);
    expect([...overlay.points.values()][0]).toEqual([{ taskId: "tasks/2026/10/リリース.md::review", kind: "marker", key: "review-point", label: "確認", before: DATE, after: "2026-10-14" }]);
  });
  it("detects deadline changes", () => {
    const projection = structuredClone(MARKER_PREVIEW.projection!) as any;
    projection.after.parents[0].children[0].markers = projection.before.parents[0].children[0].markers; projection.after.parents[0].children[0].due = "2026-10-20";
    expect([...deriveOverlay(projection).points.values()][0][0]).toMatchObject({ kind: "deadline", before: null, after: "2026-10-20" });
  });
});

describe("PreviewGanttLayer", () => {
  it("projects only the focused preview, as a proposal; nothing without focus", () => {
    const port = new FakePreviewPort([OUTSIDE_RANGE_PREVIEW, CREATE_PREVIEW]);
    const layer = new PreviewGanttLayer(port); const onChange = vi.fn(); layer.subscribe(onChange);
    expect(layer.active).toBe(false); expect(layer.fingerprint("tasks/2026/10/リリース.md")).toBe("");
    port.focus("outside-fixture");
    expect(layer.active).toBe(true); expect(layer.ghostMode).toBe("proposed"); expect(layer.scheduleGhost("tasks/2026/10/リリース.md::review")).toBeTruthy();
    expect(layer.legend()!.text).toBe("変更案 · チャット · 実線: 現在 / 破線: 変更案（後）");
    const fingerprint = layer.fingerprint("tasks/2026/10/リリース.md"); expect(fingerprint).toContain("outside-fixture");
    expect(layer.fingerprint("tasks/other.md")).toBe("");
    port.focus("create-fixture");
    expect(layer.scheduleGhost("tasks/2026/10/リリース.md::review")).toBeUndefined(); expect(layer.fingerprint("tasks/2026/10/リリース.md")).not.toBe(fingerprint);
    expect(layer.isDeleted("x")).toBe(false);
    port.focus(null); expect(layer.active).toBe(false); expect(onChange).toHaveBeenCalledTimes(3);
    layer.dispose();
  });
  it("uses the actual projection after saving and treats a null one as no Gantt impact", () => {
    const port = new FakePreviewPort([PARTIAL_PREVIEW]); port.outcomes.set(PARTIAL_PREVIEW.previewId, PARTIAL_OUTCOME);
    const layer = new PreviewGanttLayer(port); port.focus(PARTIAL_PREVIEW.previewId);
    expect(layer.ghostMode).toBe("saved"); expect(layer.projection!.targets).toHaveLength(1); expect(layer.legend()!.text).toContain("保存結果");
    const none = { ...PARTIAL_OUTCOME, actualProjection: null } as any; port.outcomes.set(PARTIAL_PREVIEW.previewId, none); port.emit();
    expect(layer.projection).toBeNull(); const dock = host(); layer.renderDock(dock);
    expect(text(dock)).toContain("保存された内容はGanttの表示に影響しません");
  });
  it("renders the preview region with legend, origin, hidden reasons and the close button", () => {
    const port = new FakePreviewPort([{ ...ONE_SIDED_PREVIEW, origin: MCP_PREVIEW.origin }]); const layer = new PreviewGanttLayer(port); port.focus("one-sided-fixture");
    const dock = host(); const region = layer.renderDock(dock) as unknown as FakeEl;
    expect(region.getAttribute("aria-label")).toBe("変更案のGantt確認");
    expect(text(region)).toContain("要求元: MCP · ローカルMCPクライアント"); expect(text(region)).toContain("日程未設定"); expect(text(region)).toContain("開始日が未設定のためbarを描画できない");
    expect(text(region)).toContain("開始日未設定");
    expect(byClass(region, "vg-pv-gbar")).toHaveLength(1);
    dispatch(byTag(region, "button").find((el) => text(el) === "閉じる")!, "click"); expect(port.focused).toBeNull();
  });
  it("shows created and deleted rows with labels, strikethrough and hatch classes", () => {
    const port = new FakePreviewPort([CREATE_PREVIEW, DELETE_PREVIEW]); const layer = new PreviewGanttLayer(port);
    port.focus("create-fixture"); let dock = host(); layer.renderDock(dock);
    expect(byClass(dock, "vg-pv-grow").map((row) => row.dataset.state)).toEqual(["context", "created"]); expect(text(dock)).toContain("新しい子");
    port.focus("delete-fixture"); dock = host(); layer.renderDock(dock);
    const row = byClass(dock, "vg-pv-grow")[0]; expect(row.dataset.state).toBe("deleted");
    expect(byClass(row, "vg-pv-gname")[0].classList.contains("is-removed")).toBe(true); expect(byClass(row, "vg-pv-gbar")[0].classList.contains("is-removed")).toBe(true);
    expect(text(dock)).toContain("削除");
  });
  it("shows daily totals with the over-capacity warning for workload changes and plain panels for settings", () => {
    const port = new FakePreviewPort([PARTIAL_PREVIEW, SETTINGS_PREVIEW, WORKLOAD_PREVIEW]); const layer = new PreviewGanttLayer(port);
    port.focus("partial-fixture"); let dock = host(); layer.renderDock(dock);
    expect(text(dock)).toContain("上限超過"); expect(text(dock)).toContain("予定 3.5h → 18h"); expect(text(dock)).toContain("絞り込みで非表示");
    port.focus("settings-fixture"); dock = host(); layer.renderDock(dock);
    expect(text(dock)).toContain("Ganttに表示されない変更"); expect(text(dock)).toContain("設定の変更"); expect(text(dock)).toContain("機能オフで非表示");
    expect(text(dock)).toContain("作業時間機能: オン → オフ");
    expect(byClass(dock, "vg-pv-grow")).toHaveLength(0);
    port.focus("workload-fixture"); dock = host(); layer.renderDock(dock);
    expect(text(dock)).toContain("予定 1.5h → 2h");
  });
  it("fetches further pages through the port, merges them and recomputes the overlay", async () => {
    const first = PROJECTION_PAGE_FIXTURES[0].projection;
    const port = new FakePreviewPort([{ ...PARTIAL_PREVIEW, status: "pending", projection: first }]);
    port.pageResults = [{ status: "success", page: PROJECTION_PAGE_FIXTURES[1] }];
    const layer = new PreviewGanttLayer(port); port.focus("partial-fixture");
    let dock = host(); layer.renderDock(dock); expect(text(dock)).toContain("全3件中2件");
    dispatch(byClass(dock, "vg-pv-coverage")[0].children.find((el) => el.dataset.action === "load-more")!, "click");
    await vi.waitFor(() => expect(layer.projection!.coverage.truncated).toBe(false));
    expect(port.pageRequests[0]).toEqual({ previewId: "partial-fixture", cursor: "projection-page-2", projectionKind: "planned" });
    dock = host(); layer.renderDock(dock); expect(text(dock)).not.toContain("一部だけ表示");
  });
  it("on a stale cursor falls back to the first page and reports the port's instruction", async () => {
    const first = PROJECTION_PAGE_FIXTURES[0].projection;
    const port = new FakePreviewPort([{ ...PARTIAL_PREVIEW, status: "pending", projection: first }]);
    port.pageResults = [{ status: "error", error: PROJECTION_STALE_ERROR as any }];
    const layer = new PreviewGanttLayer(port); port.focus("partial-fixture"); await layer.loadMore();
    const dock = host(); layer.renderDock(dock);
    expect(text(byClass(dock, "is-error")[0])).toBe(PROJECTION_STALE_ERROR.nextAction); expect(layer.projection!.coverage.truncated).toBe(true);
  });
  it("never writes to the preview port beyond focus, and releases everything on dispose", () => {
    const port = new FakePreviewPort([CREATE_PREVIEW]); const layer = new PreviewGanttLayer(port); port.focus("create-fixture"); layer.dispose();
    expect(port.rejected).toEqual([]); expect(port.reprevied).toEqual([]); expect(layer.active).toBe(false);
    port.focus(null); expect(layer.active).toBe(false);
  });
});

describe("panels", () => {
  it("lists only effects without a Gantt shape and omits the panel otherwise", () => {
    expect(panelEffects(SETTINGS_PREVIEW)).toHaveLength(1); expect(panelEffects(MARKER_PREVIEW)).toHaveLength(0);
    expect(renderNonGanttPanel(host(), MARKER_PREVIEW)).toBeUndefined();
  });
  it("renders sync, diagnostic and chat control panels with an explanation, not bars", () => {
    const base = { ...SETTINGS_PREVIEW, projection: null };
    const withEffect = (effect: any) => ({ ...base, entries: [{ ...base.entries[0], entity: { kind: "integration", targetId: "sync" }, effects: [effect] }] });
    const panelFor = (effect: any) => host() && (() => { const parent = host(); renderNonGanttPanel(parent, withEffect(effect) as any); return text(parent); })();
    expect(panelFor({ kind: "external-send", destination: "https://example.test", payloadDigest: "d", taskCount: 2, fieldsSent: ["title"], bytes: 2048 })).toContain("同期の状態");
    expect(panelFor({ kind: "diagnostic", recording: true, outputPath: "log.txt", entryCount: 3 })).toContain("時間軸には何も表示されません");
    expect(panelFor({ kind: "conversation", action: "send", before: null, after: { messageCount: 3 } })).toContain("チャットの状態");
    expect(panelFor({ kind: "view", before: { sortKey: "dueDate" }, after: { sortKey: "name" }, affectedIds: [] })).toContain("表示の変更");
  });
});

describe("live chart ghosts", () => {
  const timeline = () => { const el = makeFakeEl("div"); el.style.width = "400px"; return el as any; };
  it("draws old and new marker points on the same day scale with glyph and range-aware labels", () => {
    const parent = timeline();
    renderPointGhosts(parent, [{ kind: "marker", key: "k", label: "確認", before: "2026-10-02", after: "2026-10-04" }], "2026-10-01", 20, 10);
    const before = byClass(parent, "vg-pv-live-point").find((el) => el.classList.contains("is-before"))!; const after = byClass(parent, "vg-pv-live-point").find((el) => el.classList.contains("is-after"))!;
    expect(before.style.left).toBe("24px"); expect(after.style.left).toBe("64px"); expect(before.textContent).toBe("◆");
    expect(after.getAttribute("aria-label")).toContain("前 2026-10-02 → 後 2026-10-04");
  });
  it("uses the flag glyph for deadlines, marks additions and deletions, and annotates out-of-range dates", () => {
    const parent = timeline();
    renderPointGhosts(parent, [
      { kind: "deadline", key: "due", label: "a", before: null, after: "2026-10-03" },
      { kind: "marker", key: "m", label: "b", before: "2026-10-03", after: null },
      { kind: "marker", key: "n", label: "c", before: "2026-09-01", after: "2026-12-01" },
    ], "2026-10-01", 20, 10);
    expect(byClass(parent, "vg-pv-live-point").map((el) => el.textContent)).toContain("⚑");
    expect(byClass(parent, "vg-pv-live-note").map((el) => el.textContent)).toEqual(["追加", "削除"]);
    expect(byClass(parent, "vg-pv-live-edge").map((el) => el.textContent)).toEqual(["◀ マーカー前は範囲外", "マーカー後は範囲外 ▶"]);
    expect(byClass(parent, "vg-pv-live-point").some((el) => el.classList.contains("is-removed"))).toBe(false);
  });
  it("proposed mode puts the dashed band on the new period and labels it 案", () => {
    const parent = timeline();
    const ghost = { taskId: "t", name: "子", before: { start: "2026-10-01", end: "2026-10-02" }, after: { start: "2026-10-05", end: "2026-10-06" } };
    const current = makeFakeEl("div"); parent.appendChild(current);
    renderGhost(parent, ghost, "2026-10-01", 20, 10, current as any, "proposed");
    const band = byClass(parent, "vg-ai-ghost")[0]; expect(band.style.left).toBe("80px"); expect(band.classList.contains("is-proposed")).toBe(true); expect(band.textContent).toBe("案");
    expect(band.getAttribute("aria-label")).toContain("変更前 2026-10-01 ～ 2026-10-02 → 変更後 2026-10-05 ～ 2026-10-06");
    expect(byClass(parent, "vg-ai-target-label")[0].textContent).toBe("→ 4日後ろへ");
    const far = timeline(); renderGhost(far, { ...ghost, after: { start: "2026-12-01", end: "2026-12-02" } }, "2026-10-01", 20, 10, undefined, "proposed");
    expect(byClass(far, "vg-ai-ghost")[0].textContent).toBe("前は範囲外 ▶".replace("前", "案"));
  });
  it("a boundary outcome set renders without throwing for the dock", () => {
    for (const [name, outcome] of Object.entries(BOUNDARY_OUTCOMES)) {
      const preview = { oneSided: ONE_SIDED_PREVIEW, filtered: FILTERED_PREVIEW, featureDisabled: SETTINGS_PREVIEW, outsideRange: OUTSIDE_RANGE_PREVIEW, partial: PARTIAL_PREVIEW, emptyDailyFile: D02_EMPTY_FILE_PREVIEW }[name as "partial"];
      const port = new FakePreviewPort([preview]); port.outcomes.set(preview.previewId, outcome); const layer = new PreviewGanttLayer(port); port.focus(preview.previewId);
      expect(() => layer.renderDock(host()), name).not.toThrow();
    }
  });
});
