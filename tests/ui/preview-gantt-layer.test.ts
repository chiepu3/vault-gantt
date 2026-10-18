/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { PARENT_ID, CHILD_ID, BOUNDARY_OUTCOMES, D02_EMPTY_FILE_PREVIEW, CREATE_PREVIEW, DATE, DELETE_PREVIEW, FILTERED_PREVIEW, MARKER_PREVIEW, MCP_PREVIEW, ONE_SIDED_PREVIEW, OUTSIDE_RANGE_PREVIEW, PARTIAL_OUTCOME, PARTIAL_PREVIEW, PROJECTION_PAGE_FIXTURES, PROJECTION_STALE_ERROR, SETTINGS_PREVIEW, WORKLOAD_PREVIEW } from "../contracts/fixtures";
import { deriveOverlay, PreviewGanttLayer } from "../../src/ui/preview-gantt-layer";
import { renderPointGhosts, renderGhost } from "../../src/ui/ghost-layer";
import { deriveHighlights, displayedHours, eventWorkloadKey, hoursChangeText } from "../../src/ui/preview-highlights";
import { createFakeDocument, makeFakeEl, byClass } from "../stubs/fake-dom";
import { FakePreviewPort } from "./preview-fakes";

beforeEach(() => { vi.stubGlobal("document", createFakeDocument()); });
afterEach(() => vi.unstubAllGlobals());

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
    expect([...created.created]).toEqual(["s-eeeeee"]);
    expect(created.parents[0].children.map((child) => child.state)).toEqual(["context", "created"]);
    expect(created.unplaced).toHaveLength(0);
    const deleted = deriveOverlay(DELETE_PREVIEW.projection!);
    expect([...deleted.deleted]).toEqual([CHILD_ID]);
    expect(deleted.parents[0].children[0].before?.name).toBe("レビュー"); expect(deleted.parents[0].children[0].after).toBeUndefined();
    expect(deleted.parents[0].notes.join()).toContain("集計期間");
  });
  it("lists created rows without a schedule as unplaced instead of drawing a bar", () => {
    const projection = structuredClone(CREATE_PREVIEW.projection!) as any;
    projection.after.parents[0].children[1].period = { start: null, end: null };
    const overlay = deriveOverlay(projection);
    expect(overlay.unplaced).toEqual([{ id: "s-eeeeee", name: "新しい子", reason: "日程が未設定のため、Ganttには置かれません" }]);
  });
  it("tracks marker moves as point changes separate from the schedule ghost", () => {
    const overlay = deriveOverlay(MARKER_PREVIEW.projection!);
    expect(overlay.ghosts.size).toBe(0);
    expect([...overlay.points.values()][0]).toEqual([{ taskId: CHILD_ID, kind: "marker", key: "確認", label: "確認", before: DATE, after: "2026-10-14" }]);
  });
  it("detects deadline changes", () => {
    const projection = structuredClone(MARKER_PREVIEW.projection!) as any;
    projection.after.parents[0].children[0].markers = projection.before.parents[0].children[0].markers; projection.after.parents[0].children[0].due = "2026-10-20";
    expect([...deriveOverlay(projection).points.values()][0][0]).toMatchObject({ kind: "deadline", before: null, after: "2026-10-20" });
  });
});

describe("deriveHighlights (what the real chart marks)", () => {
  const PARENT = PARENT_ID;
  const withState = (mutate: (projection: any) => void): any => { const projection = structuredClone(WORKLOAD_PREVIEW.projection!) as any; mutate(projection); return projection; };
  const highlights = (projection: any) => deriveHighlights(projection, deriveOverlay(projection));
  it("marks changed rows and the parent that holds them, with created and deleted rows told apart", () => {
    const changed = highlights(OUTSIDE_RANGE_PREVIEW.projection!);
    expect(changed.rows.get(CHILD_ID)).toBe("changed"); expect(changed.rows.get(PARENT)).toBe("changed");
    expect(highlights(CREATE_PREVIEW.projection!).rows.get("s-eeeeee")).toBe("created");
    expect(highlights(DELETE_PREVIEW.projection!).rows.get(CHILD_ID)).toBe("deleted");
    expect(highlights(CREATE_PREVIEW.projection!).rows.has(CHILD_ID)).toBe(false);
  });
  it("lists changed plan/actual cells per task and date, and the day totals of the workload row", () => {
    const marks = highlights(WORKLOAD_PREVIEW.projection!);
    const cell = marks.workload.get(CHILD_ID)!.get(DATE)!;
    expect(cell.before).toEqual({ plan: 1.5, actual: 1 }); expect(cell.after).toEqual({ plan: 2, actual: 1 });
    expect(hoursChangeText(cell.before, cell.after)).toBe("計画 1.5h → 2h");
    expect(hoursChangeText({ plan: 0, actual: 0 }, { plan: 3, actual: 1 })).toBe("計画 0h → 3h / 実績 0h → 1h");
    expect(marks.totals.get(DATE)).toEqual({ date: DATE, before: { plan: 1.5, actual: 1 }, after: { plan: 2, actual: 1 } });
    expect(displayedHours(cell)).toEqual({ hours: { plan: 2, actual: 1 }, removed: false });
    const emptied = { date: DATE, before: { plan: 2, actual: 1 }, after: { plan: 0, actual: 0 } };
    expect(displayedHours(emptied)).toEqual({ hours: { plan: 2, actual: 1 }, removed: true });
  });
  it("marks a changed Daily ToDo day with the item lines and a day that gains or loses all items", () => {
    const projection = withState((p) => {
      p.after.daily = [{ date: DATE, totalCount: 2, completedCount: 1, items: [{ path: "d.md", sourceKey: "main", text: "確認", completed: true, line: 1, itemFingerprint: "a", revision: "r" }, { path: "d.md", sourceKey: "main", text: "新規", completed: false, line: 2, itemFingerprint: "b", revision: "r" }] }];
      p.before.daily = [{ date: DATE, totalCount: 1, completedCount: 0, items: [{ path: "d.md", sourceKey: "main", text: "確認", completed: false, line: 1, itemFingerprint: "a", revision: "r" }] }];
      p.after.daily.push({ date: "2026-10-20", totalCount: 1, completedCount: 0 });
      p.before.daily.push({ date: "2026-10-21", totalCount: 2, completedCount: 0 });
    });
    const marks = highlights(projection);
    expect(marks.daily.get(DATE)).toMatchObject({ state: "changed", before: { total: 1, completed: 0 }, after: { total: 2, completed: 1 }, lines: ["☑ 確認", "＋ 新規"] });
    expect(marks.daily.get("2026-10-20")!.state).toBe("created"); expect(marks.daily.get("2026-10-21")!.state).toBe("deleted");
    expect(highlights(WORKLOAD_PREVIEW.projection!).daily.size).toBe(0);
  });
  it("marks created, moved and deleted events and the hours on them", () => {
    const projection = withState((p) => {
      p.before.events = [{ key: "e-moved", title: "会議", date: DATE, hours: [] }, { key: "e-gone", title: "削除", date: DATE, hours: [] }, { key: "e-hours", title: "作業", date: DATE, hours: [{ date: DATE, plan: 1, actual: 0 }] }];
      p.after.events = [{ key: "e-moved", title: "会議", date: "2026-10-16", hours: [] }, { key: "e-new", title: "追加", date: "2026-10-17", hours: [{ date: "2026-10-17", plan: 2, actual: 0 }] }, { key: "e-hours", title: "作業", date: DATE, hours: [{ date: DATE, plan: 3, actual: 0 }] }];
    });
    const marks = highlights(projection);
    expect([...marks.events.values()].map((event) => [event.key, event.state])).toEqual([["e-moved", "changed"], ["e-gone", "deleted"], ["e-hours", "changed"], ["e-new", "created"]]);
    expect(marks.workload.get(eventWorkloadKey("e-hours"))!.get(DATE)!.after.plan).toBe(3);
    expect(marks.workload.get(eventWorkloadKey("e-new"))!.get("2026-10-17")).toBeTruthy();
  });
  it("places created rows (proposal) or deleted rows (saved) as preview-only bars, never rows the chart already holds", () => {
    const port = new FakePreviewPort([CREATE_PREVIEW, DELETE_PREVIEW]); const layer = new PreviewGanttLayer(port);
    port.focus("create-fixture");
    expect(layer.phantomBars(PARENT)).toEqual([{ id: "s-eeeeee", name: "新しい子", start: expect.any(String), end: expect.any(String), state: "created" }]);
    port.focus("delete-fixture"); expect(layer.phantomBars(PARENT)).toEqual([]);
    port.outcomes.set("delete-fixture", { previewId: "delete-fixture", status: "success", actions: [], actualProjection: DELETE_PREVIEW.projection } as any); port.emit();
    expect(layer.ghostMode).toBe("saved"); expect(layer.phantomBars(PARENT).map((bar) => bar.state)).toEqual(["deleted"]);
    layer.dispose();
  });
  it("shows a proposed new or moved event at its new date, and after saving a removed or moved one at its old date", () => {
    const projection = withState((p) => {
      p.before.events = [{ key: "m", title: "移動", date: DATE, hours: [] }, { key: "d", title: "削除", date: DATE, hours: [] }];
      p.after.events = [{ key: "m", title: "移動", date: "2026-10-16", hours: [] }, { key: "n", title: "新規", date: "2026-10-17", hours: [] }];
    });
    const preview = { ...WORKLOAD_PREVIEW, previewId: "events", projection } as any;
    const port = new FakePreviewPort([preview]); const layer = new PreviewGanttLayer(port); port.focus("events");
    expect(layer.phantomEvents().map((item) => [item.event.title, item.event.date, item.state])).toEqual([["移動", "2026-10-16", "changed"], ["新規", "2026-10-17", "created"]]);
    port.outcomes.set("events", { previewId: "events", status: "success", actions: [], actualProjection: projection } as any); port.emit();
    expect(layer.phantomEvents().map((item) => [item.event.title, item.event.date, item.state])).toEqual([["移動", DATE, "deleted"], ["削除", DATE, "deleted"]]);
    layer.dispose();
  });
  it("tells where to scroll: the first changed row and the earliest changed date", () => {
    const marks = highlights(OUTSIDE_RANGE_PREVIEW.projection!);
    expect(marks.firstTaskId).toBe(CHILD_ID); expect(marks.firstDate).toBe(DATE);
  });
});

describe("PreviewGanttLayer", () => {
  it("projects only the focused preview, as a proposal; nothing without focus", () => {
    const port = new FakePreviewPort([OUTSIDE_RANGE_PREVIEW, CREATE_PREVIEW]);
    const layer = new PreviewGanttLayer(port); const onChange = vi.fn(); layer.subscribe(onChange);
    expect(layer.active).toBe(false); expect(layer.fingerprint(PARENT_ID)).toBe(""); expect(layer.highlights).toBeUndefined(); expect(layer.markKey).toBe("");
    port.focus("outside-fixture");
    expect(layer.active).toBe(true); expect(layer.ghostMode).toBe("proposed"); expect(layer.scheduleGhost(CHILD_ID)).toBeTruthy();
    expect(layer.legend()!.text).toBe("変更案を表示中"); expect(layer.legend()!.title).not.toContain("表示範囲外");
    expect(layer.rowState(CHILD_ID)).toBe("changed"); expect(layer.markKey).toContain("outside-fixture");
    const fingerprint = layer.fingerprint(PARENT_ID); expect(fingerprint).toContain("outside-fixture");
    expect(layer.fingerprint("tasks/other.md")).toBe("");
    port.focus("create-fixture");
    expect(layer.scheduleGhost(CHILD_ID)).toBeUndefined(); expect(layer.fingerprint(PARENT_ID)).not.toBe(fingerprint);
    expect(layer.isDeleted("x")).toBe(false);
    port.focus(null); expect(layer.active).toBe(false); expect(onChange).toHaveBeenCalledTimes(3);
    layer.dispose();
  });
  it("uses the actual projection after saving and treats a null one as no Gantt impact", () => {
    const port = new FakePreviewPort([PARTIAL_PREVIEW]); port.outcomes.set(PARTIAL_PREVIEW.previewId, PARTIAL_OUTCOME);
    const layer = new PreviewGanttLayer(port); port.focus(PARTIAL_PREVIEW.previewId);
    expect(layer.ghostMode).toBe("saved"); expect(layer.projection!.targets).toHaveLength(1); expect(layer.legend()!.text).toBe("保存した変更を表示中");
    const none = { ...PARTIAL_OUTCOME, actualProjection: null } as any; port.outcomes.set(PARTIAL_PREVIEW.previewId, none); port.emit();
    expect(layer.projection).toBeNull(); expect(layer.highlights).toBeUndefined(); expect(layer.active).toBe(true);
  });
  it("closing the highlight only moves the focus", () => {
    const port = new FakePreviewPort([ONE_SIDED_PREVIEW]); const layer = new PreviewGanttLayer(port); port.focus("one-sided-fixture");
    layer.close(); expect(port.focused).toBeNull(); expect(port.rejected).toEqual([]);
  });
  it("fetches further pages by itself, merges them and recomputes the highlights", async () => {
    const first = PROJECTION_PAGE_FIXTURES[0].projection;
    const port = new FakePreviewPort([{ ...PARTIAL_PREVIEW, status: "pending", projection: first }]);
    port.pageResults = [{ status: "success", page: PROJECTION_PAGE_FIXTURES[1] }];
    const layer = new PreviewGanttLayer(port); port.focus("partial-fixture");
    await vi.waitFor(() => expect(layer.projection!.coverage.truncated).toBe(false));
    expect(port.pageRequests[0]).toEqual({ previewId: "partial-fixture", cursor: "projection-page-2", projectionKind: "planned" });
  });
  it("on a stale cursor falls back to the first page and stops fetching", async () => {
    const first = PROJECTION_PAGE_FIXTURES[0].projection;
    const port = new FakePreviewPort([{ ...PARTIAL_PREVIEW, status: "pending", projection: first }]);
    port.pageResults = [{ status: "error", error: PROJECTION_STALE_ERROR as any }];
    const layer = new PreviewGanttLayer(port); port.focus("partial-fixture");
    await vi.waitFor(() => expect(port.pageRequests).toHaveLength(1)); await Promise.resolve();
    expect(layer.projection!.coverage.truncated).toBe(true); expect(port.pageRequests).toHaveLength(1);
  });
  it("never writes to the preview port beyond focus, and releases everything on dispose", () => {
    const port = new FakePreviewPort([CREATE_PREVIEW]); const layer = new PreviewGanttLayer(port); port.focus("create-fixture"); layer.dispose();
    expect(port.rejected).toEqual([]); expect(port.reprevied).toEqual([]); expect(layer.active).toBe(false); expect(layer.highlights).toBeUndefined();
    port.focus(null); expect(layer.active).toBe(false);
  });
  it("focuses a newly created chat proposal, but not old ones, other origins, or when something else is focused", () => {
    const old = { ...OUTSIDE_RANGE_PREVIEW, previewId: "old" } as any; const port = new FakePreviewPort([old]); const layer = new PreviewGanttLayer(port);
    expect(port.focused).toBeNull();
    port.set({ ...CREATE_PREVIEW, previewId: "fresh", status: "pending" } as any); expect(port.focused).toBe("fresh");
    port.set({ ...MCP_PREVIEW, previewId: "from-mcp", status: "pending" } as any); expect(port.focused).toBe("fresh");
    port.focus("from-mcp"); port.set({ ...CREATE_PREVIEW, previewId: "later", status: "pending" } as any); expect(port.focused).toBe("from-mcp");
    layer.dispose();
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
  it("derives highlights for every boundary outcome without throwing", () => {
    for (const [name, outcome] of Object.entries(BOUNDARY_OUTCOMES)) {
      const preview = { oneSided: ONE_SIDED_PREVIEW, filtered: FILTERED_PREVIEW, featureDisabled: SETTINGS_PREVIEW, outsideRange: OUTSIDE_RANGE_PREVIEW, partial: PARTIAL_PREVIEW, emptyDailyFile: D02_EMPTY_FILE_PREVIEW }[name as "partial"];
      const port = new FakePreviewPort([preview]); port.outcomes.set(preview.previewId, outcome); const layer = new PreviewGanttLayer(port); port.focus(preview.previewId);
      expect(() => { layer.phantomBars("x"); layer.phantomEvents(); layer.focusTarget(); layer.legend(); }, name).not.toThrow();
    }
  });
  it("describes parent changes in plain Japanese without raw order numbers", () => {
    const projection = structuredClone(CREATE_PREVIEW.projection!) as any;
    projection.after.parents[0].order = projection.before.parents[0].order + 3;
    projection.after.parents[0].enabled = !projection.before.parents[0].enabled;
    const notes = deriveOverlay(projection).parents.flatMap((parent) => parent.notes).join("\n");
    expect(notes).toContain("並び順が変わります"); expect(notes).toContain("Ganttに表示");
    expect(notes).not.toMatch(/Gantt順|順序|ganttOrder/); expect(notes).not.toMatch(/\d+ → \d+/);
  });
});
