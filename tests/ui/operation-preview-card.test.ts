/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { BOUNDARY_OUTCOMES, D02_EMPTY_FILE_PREVIEW, CREATE_PREVIEW, DELETE_PREVIEW, FILTERED_PREVIEW, MARKER_PREVIEW, MCP_PREVIEW, ONE_SIDED_PREVIEW, OUTSIDE_RANGE_PREVIEW, PARTIAL_OUTCOME, PARTIAL_PREVIEW, PREVIEW_FIXTURES, PROJECTION_PAGE_FIXTURES, PROJECTION_STALE_ERROR, READ_FIXTURES, SETTINGS_PREVIEW, WORKLOAD_PREVIEW } from "../contracts/fixtures";
import { operationPreviewSchema, validatePreviewOutcome, type OperationPreviewV1 } from "../../src/contracts/preview";
import { cardState, CardProjectionPager, originLabel, PreviewCardController, renderOperationPreviewCard, renderReadResultCard } from "../../src/ui/operation-preview-card";
import { createFakeDocument, makeFakeEl, byClass, byTag, deepText, dispatch, type FakeEl } from "../stubs/fake-dom";
import { fakePorts } from "./preview-fakes";

beforeEach(() => { vi.stubGlobal("document", createFakeDocument()); });
afterEach(() => vi.unstubAllGlobals());
const root = () => makeFakeEl("div") as unknown as HTMLElement & FakeEl;
const text = (el: unknown) => deepText(el as FakeEl);
const NOW = Date.parse("2026-10-09T03:05:00Z");
const buttons = (card: unknown) => byTag(card as FakeEl, "button");
const button = (card: unknown, action: string) => buttons(card).find((el) => el.dataset.action === action) as FakeEl & { disabled: boolean } | undefined;
const render = (preview: OperationPreviewV1, options = {}) => renderOperationPreviewCard(root(), preview, { now: NOW, ...options }) as unknown as FakeEl;

describe("shared fixtures are valid contract data", () => {
  it.each(Object.entries(PREVIEW_FIXTURES))("%s parses", (_name, preview) => { expect(operationPreviewSchema.safeParse(preview).success).toBe(true); });
  it.each(Object.entries(BOUNDARY_OUTCOMES))("outcome %s validates against its preview", (name, outcome) => {
    const preview = { oneSided: ONE_SIDED_PREVIEW, filtered: FILTERED_PREVIEW, featureDisabled: SETTINGS_PREVIEW, outsideRange: OUTSIDE_RANGE_PREVIEW, partial: PARTIAL_PREVIEW, emptyDailyFile: D02_EMPTY_FILE_PREVIEW }[name as "partial"];
    expect(() => validatePreviewOutcome(preview, outcome)).not.toThrow();
  });
});

describe("pending card", () => {
  it("shows target, operation, origin and the three actions in order", () => {
    const card = render(CREATE_PREVIEW, { handlers: { onFocus: vi.fn(), onApprove: vi.fn(), onReject: vi.fn() } });
    expect(card.dataset.state).toBe("pending");
    expect(text(byClass(card, "vg-pv-status")[0])).toBe("未承認");
    expect(text(byClass(card, "vg-pv-title")[0])).toBe("タスク · T06");
    expect(text(card)).toContain("要求元: チャット"); expect(text(card)).toContain("対象 1件 · 操作 1件");
    expect(text(card)).toContain("新しい子"); expect(text(card)).toContain("作成");
    expect(buttons(card).map(text)).toEqual(["Ganttで確認", "承認して保存", "却下"]);
    expect(card.getAttribute("aria-label")).toBe("タスク · T06（未承認）");
    expect(text(byClass(card, "vg-pv-undo")[0])).toContain("保存後、全体を元に戻せます");
  });
  it("wires focus, approve and reject to the handlers", () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const handlers = { onFocus: vi.fn(), onApprove: vi.fn(), onReject: vi.fn(), onRepreview: vi.fn() };
    const card = render(CREATE_PREVIEW, { handlers, focused: true });
    expect(button(card, "focus")!.getAttribute("aria-pressed")).toBe("true");
    for (const action of ["focus", "approve", "reject"]) dispatch(button(card, action)!, "click");
    expect(handlers.onFocus).toHaveBeenCalledOnce(); expect(handlers.onApprove).toHaveBeenCalledOnce(); expect(handlers.onReject).toHaveBeenCalledOnce();
    expect(handlers.onRepreview).not.toHaveBeenCalled(); vi.useRealTimers();
  });
  it("hides the Gantt button when the preview has no Gantt projection", () => {
    const noGantt = { ...CREATE_PREVIEW, projection: null };
    expect(button(render(noGantt, { handlers: { onFocus: vi.fn() } }), "focus")).toBeUndefined();
  });
  it("disables approval while busy and when no approval handler exists", () => {
    expect(button(render(CREATE_PREVIEW, { busy: true, handlers: { onApprove: vi.fn() } }), "approve")!.disabled).toBe(true);
    expect(text(button(render(CREATE_PREVIEW, { busy: true, handlers: { onApprove: vi.fn() } }), "approve"))).toBe("適用中…");
    expect(button(render(CREATE_PREVIEW, {}), "approve")!.disabled).toBe(true);
  });
  it("turns into 期限切れ after expiry, blocks saving and offers a re-preview", () => {
    const after = Date.parse(CREATE_PREVIEW.expiresAt) + 1000;
    expect(cardState(CREATE_PREVIEW, undefined, undefined, after)).toBe("expired");
    const handlers = { onApprove: vi.fn(), onRepreview: vi.fn(), onReject: vi.fn() };
    const card = render(CREATE_PREVIEW, { now: after, handlers });
    expect(text(byClass(card, "vg-pv-status")[0])).toBe("期限切れ");
    expect(button(card, "approve")!.disabled).toBe(true);
    dispatch(button(card, "repreview")!, "click"); expect(handlers.onRepreview).toHaveBeenCalledOnce(); expect(handlers.onApprove).not.toHaveBeenCalled();
    expect(text(card)).toContain("承認の期限が過ぎました");
  });
  it("re-checks the expiry at click time even if the card is stale", () => {
    vi.useFakeTimers(); vi.setSystemTime(Date.parse(CREATE_PREVIEW.expiresAt) + 5000);
    const handlers = { onApprove: vi.fn(), onRepreview: vi.fn() };
    const card = render(CREATE_PREVIEW, { now: NOW, handlers });
    dispatch(button(card, "approve")!, "click");
    expect(handlers.onApprove).not.toHaveBeenCalled(); expect(handlers.onRepreview).toHaveBeenCalledOnce(); vi.useRealTimers();
  });
  it.each([["stale", "失効"], ["rejected", "却下"], ["applying", "適用中"]] as const)("status %s is labelled %s and cannot be approved", (status, label) => {
    const card = render({ ...CREATE_PREVIEW, status }, { handlers: { onApprove: vi.fn(), onRepreview: vi.fn(), onReject: vi.fn() } });
    expect(text(byClass(card, "vg-pv-status")[0])).toBe(label);
    const approve = button(card, "approve"); if (approve) expect(approve.disabled).toBe(true);
    expect(!!button(card, "repreview")).toBe(status === "stale");
  });
});

describe("MCP and other origins", () => {
  it("shows the client's claimed name, principal and Vault, and says the AI only proposes", () => {
    const card = render(MCP_PREVIEW, { handlers: { onApprove: vi.fn() } });
    expect(card.dataset.origin).toBe("mcp");
    expect(text(card)).toContain("要求元: MCP · ローカルMCPクライアント");
    expect(text(card)).toContain("認証済みの名前ではありません"); expect(text(card)).toContain("principal-fixture"); expect(text(card)).toContain("vault-fixture");
    expect(text(card)).toContain("保存はこの画面で承認したあとに行われます");
  });
  it("labels every origin kind in plain Japanese", () => {
    expect(originLabel({ kind: "chat", conversationId: "c" })).toBe("チャット");
    expect(originLabel({ kind: "mcp", principalId: "p", clientLabel: "  " })).toBe("MCP · 名称なし");
    expect(originLabel({ kind: "ui", viewId: "v" })).toBe("画面操作");
    expect(originLabel({ kind: "system", cause: "holidays" })).toBe("自動処理 · 祝日の更新");
  });
});

describe("results", () => {
  it("separates saved effects from unsaved ones after a partial save", () => {
    const card = render(PARTIAL_PREVIEW, { outcome: PARTIAL_OUTCOME, undoState: { entryId: "undo-1", historyRevision: "h", state: "available", reason: null }, handlers: { onFocus: vi.fn(), onUndo: vi.fn(), onRepreview: vi.fn() } });
    expect(card.dataset.state).toBe("partial");
    expect(text(byClass(card, "vg-pv-status")[0])).toBe("一部適用");
    expect(text(byClass(card, "vg-pv-result")[0])).toBe("保存済み 1件 · 失敗 1件 · 未実行 1件");
    const entries = byClass(card, "vg-pv-entry");
    expect(entries.map((entry) => entry.dataset.state)).toEqual(["committed", "failed", "not-attempted"]);
    expect(text(entries[0])).toContain("保存された内容"); expect(text(entries[0])).toContain("保存済み");
    expect(text(entries[1])).toContain("保存されていません（WRITE_FAILED）"); expect(byClass(entries[1], "vg-pv-unsaved")).toHaveLength(1);
    expect(text(entries[2])).toContain("実行されなかった変更案"); expect(byClass(entries[0], "vg-pv-unsaved")).toHaveLength(0);
    expect(text(card)).toContain("保存できたのは一部だけです");
    expect(buttons(card).map(text)).toEqual(["Ganttで確認", "元に戻す", "未保存分を再プレビュー"]);
  });
  it("renders only the committed (actual) effects for a saved action, not the planned ones", () => {
    const outcome = { ...PARTIAL_OUTCOME, actions: [{ ...PARTIAL_OUTCOME.actions[0], actual: [PARTIAL_PREVIEW.entries[0].effects[0]] }, ...PARTIAL_OUTCOME.actions.slice(1)] };
    const entry = byClass(render(PARTIAL_PREVIEW, { outcome }), "vg-pv-entry")[0];
    expect(text(entry)).toContain("重点"); expect(byClass(entry, "vg-pv-effect").map((el) => el.dataset.kind)).toEqual(["fields"]);
  });
  it("shows the actual projection only for saved targets, with its filtered reason", () => {
    const card = render(PARTIAL_PREVIEW, { outcome: PARTIAL_OUTCOME });
    expect(text(byClass(card, "vg-pv-projection")[0])).toContain("保存された分のGantt表示");
    expect(text(card)).toContain("絞り込みで非表示: 1件");
  });
  it("success offers undo only when the latest history allows it, with the reason", () => {
    const outcome = BOUNDARY_OUTCOMES.featureDisabled;
    const withUndo = { ...outcome, undoEntryId: "undo-9" };
    const ok = render(SETTINGS_PREVIEW, { outcome: withUndo, undoState: { entryId: "undo-9", historyRevision: "h", state: "available", reason: null }, handlers: { onUndo: vi.fn() } });
    expect(text(byClass(ok, "vg-pv-status")[0])).toBe("適用済み"); expect(button(ok, "undo")!.disabled).toBe(false);
    const blocked = render(SETTINGS_PREVIEW, { outcome: withUndo, undoState: { entryId: "undo-9", historyRevision: "h", state: "not-latest", reason: "別の変更があります" }, handlers: { onUndo: vi.fn() } });
    expect(button(blocked, "undo")!.disabled).toBe(true); expect(text(blocked)).toContain("履歴の先頭ではないため元に戻せません（別の変更があります）");
    const undone = render(SETTINGS_PREVIEW, { outcome: withUndo, undoState: { entryId: "undo-9", historyRevision: "h", state: "already-undone", reason: null } });
    expect(undone.dataset.state).toBe("undone"); expect(text(byClass(undone, "vg-pv-status")[0])).toBe("元に戻しました");
  });
  it("failed and stale outcomes offer re-preview and no undo", () => {
    const outcome = { previewId: CREATE_PREVIEW.previewId, status: "failed" as const, actions: [{ actionId: CREATE_PREVIEW.entries[0].actionId, state: "failed" as const, actual: [], errorCode: "WRITE_FAILED" }], actualProjection: null };
    const card = render(CREATE_PREVIEW, { outcome, handlers: { onRepreview: vi.fn() } });
    expect(text(byClass(card, "vg-pv-status")[0])).toBe("失敗"); expect(button(card, "undo")).toBeUndefined(); expect(text(button(card, "repreview"))).toBe("再プレビュー");
    expect(text(card)).toContain("保存された内容はGanttの表示に影響しません");
  });
});

describe("boundary cases from the shared fixtures", () => {
  it("one-sided period: shows the unscheduled reason and the one-sided timeline", () => {
    const card = render(ONE_SIDED_PREVIEW);
    expect(text(card)).toContain("日程が未設定のため描画なし: 1件"); expect(text(card)).toContain("開始日が未設定のためbarを描画できない");
    expect(byClass(card, "vg-ai-mini-tick")).toHaveLength(1); expect(byClass(card, "vg-ai-mini-bar")).toHaveLength(1);
  });
  it("filtered: explains why the Gantt shows nothing", () => {
    const card = render(FILTERED_PREVIEW);
    expect(text(card)).toContain("絞り込みで非表示: 1件"); expect(text(card)).toContain("選択タグ「対象」に一致しない"); expect(text(card)).toContain("表示対象 0件 / 表示されない 1件");
  });
  it("feature disabled: names the disabled feature and the retained data", () => {
    const card = render(SETTINGS_PREVIEW);
    expect(text(card)).toContain("機能がオフで非表示: 1件"); expect(text(card)).toContain("保存済み時間は保持"); expect(text(card)).toContain("作業時間機能");
  });
  it("outside range: reports the range reason and still shows both dates", () => {
    const card = render(OUTSIDE_RANGE_PREVIEW);
    expect(text(card)).toContain("表示範囲の外: 1件"); expect(text(card)).toContain("viewport 2026-10-01〜2026-10-31の範囲外"); expect(byClass(card, "vg-ai-mini-timeline")[0].getAttribute("aria-label")).toContain("2026-12-13 ～ 2026-12-15");
  });
  it("create, delete, marker and workload cards show their dedicated renderers", () => {
    expect(byClass(render(CREATE_PREVIEW), "vg-pv-effect").map((el) => el.dataset.kind)).toEqual(["presence", "schedule"]);
    expect(text(render(DELETE_PREVIEW))).toContain("削除されるもの");
    expect(byClass(render(MARKER_PREVIEW), "vg-pv-effect").map((el) => el.dataset.kind)).toEqual(["marker"]);
    expect(byClass(render(WORKLOAD_PREVIEW), "vg-pv-effect").map((el) => el.dataset.kind)).toEqual(["workload"]);
  });
  it("many entries keep every action: the first ones inline, the rest in a details block", () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({ ...CREATE_PREVIEW.entries[0], actionId: "a" + i, displayName: "行" + i }));
    const card = render({ ...CREATE_PREVIEW, entries, summary: { targetCount: 25, actionCount: 25 } });
    expect(byClass(card, "vg-pv-entry")).toHaveLength(25);
    expect(byClass(card, "vg-pv-rest")).toHaveLength(1); expect(text(byClass(card, "vg-pv-rest")[0])).toContain("残りの操作 5件を表示");
  });
  it("shows a notice instead of an empty card when there are no actions", () => {
    expect(text(render({ ...CREATE_PREVIEW, entries: [], summary: { targetCount: 0, actionCount: 0 } }))).toContain("変更する操作はありません");
  });
});

describe("truncated projection and cursor paging", () => {
  const first = PROJECTION_PAGE_FIXTURES[0].projection;
  const truncated = { ...PARTIAL_PREVIEW, status: "pending" as const, projection: first };
  it("says how many targets are shown and fetches the next page with the cursor", () => {
    const onLoadMore = vi.fn();
    const card = render(truncated, { handlers: { onLoadMore } });
    expect(text(byClass(card, "vg-pv-coverage")[0])).toContain("一部だけ表示しています: 全3件中2件");
    dispatch(button(card, "load-more")!, "click"); expect(onLoadMore).toHaveBeenCalledWith("projection-page-2");
    expect(button(render(truncated, { handlers: { onLoadMore }, loadingMore: true }), "load-more")!.disabled).toBe(true);
    expect(byClass(render(truncated, { loadError: "再プレビューしてください" }), "is-error")).toHaveLength(1);
  });
  it("merges loaded pages through the contract and replaces the partial display", async () => {
    const ports = fakePorts([truncated]);
    ports.previewPort.pageResults = [{ status: "success", page: PROJECTION_PAGE_FIXTURES[1] }];
    const onChange = vi.fn(); const pager = new CardProjectionPager(ports.previewPort, onChange);
    await pager.loadMore(truncated);
    expect(ports.previewPort.pageRequests).toEqual([{ previewId: "partial-fixture", cursor: "projection-page-2", projectionKind: "planned" }]);
    const merged = pager.projectionFor(truncated)!;
    expect(merged.targets).toHaveLength(3); expect(merged.coverage.truncated).toBe(false);
    expect(text(byClass(render(truncated, { projection: merged }), "vg-pv-projection")[0])).not.toContain("一部だけ表示");
    expect(onChange).toHaveBeenCalledTimes(2);
  });
  it("on a stale cursor drops every extra page and shows the port's instruction", async () => {
    const ports = fakePorts([truncated]);
    ports.previewPort.pageResults = [{ status: "error", error: PROJECTION_STALE_ERROR as any }];
    const pager = new CardProjectionPager(ports.previewPort, vi.fn());
    await pager.loadMore(truncated);
    expect(pager.error("partial-fixture")).toBe(PROJECTION_STALE_ERROR.nextAction);
    expect(pager.projectionFor(truncated)!.coverage.truncated).toBe(true);
  });
  it("does not request pages for an outcome without a projection", async () => {
    const ports = fakePorts([CREATE_PREVIEW]); const pager = new CardProjectionPager(ports.previewPort, vi.fn());
    await pager.loadMore(CREATE_PREVIEW, { previewId: CREATE_PREVIEW.previewId, status: "failed", actions: [{ actionId: CREATE_PREVIEW.entries[0].actionId, state: "failed", actual: [] }], actualProjection: null });
    expect(ports.previewPort.pageRequests).toHaveLength(0);
  });
});

describe("controller", () => {
  it("approves through the human port, shows busy, and surfaces failures on the card", async () => {
    const ports = fakePorts([CREATE_PREVIEW]); const onChange = vi.fn();
    const controller = new PreviewCardController(ports, { openGantt: vi.fn() }, onChange);
    controller.optionsFor(CREATE_PREVIEW).handlers!.onApprove!();
    expect(controller.optionsFor(CREATE_PREVIEW).busy).toBe(true);
    await vi.waitFor(() => expect(ports.approved).toEqual(["create-fixture"]));
    await vi.waitFor(() => expect(controller.optionsFor(CREATE_PREVIEW).busy).toBe(false));
    expect(ports.previewPort.outcomes.get("create-fixture")!.status).toBe("success");
    ports.approve.fail = new Error("conflict");
    controller.optionsFor(CREATE_PREVIEW).handlers!.onApprove!();
    await vi.waitFor(() => expect(controller.optionsFor(CREATE_PREVIEW).actionError).toBe("保存できませんでした: conflict"));
  });
  it("toggles the Gantt focus and opens the Gantt only when focusing", () => {
    const ports = fakePorts([CREATE_PREVIEW]); const openGantt = vi.fn();
    const controller = new PreviewCardController(ports, { openGantt }, vi.fn());
    controller.optionsFor(CREATE_PREVIEW).handlers!.onFocus!();
    expect(ports.previewPort.focused).toBe("create-fixture"); expect(openGantt).toHaveBeenCalledOnce();
    controller.optionsFor(CREATE_PREVIEW).handlers!.onFocus!();
    expect(ports.previewPort.focused).toBeNull(); expect(openGantt).toHaveBeenCalledOnce();
  });
  it("rejects, re-previews (moving focus only if it was focused) and gates undo on a host callback", async () => {
    const ports = fakePorts([CREATE_PREVIEW]);
    const controller = new PreviewCardController(ports, {}, vi.fn());
    expect(controller.optionsFor(CREATE_PREVIEW).handlers!.onUndo).toBeUndefined();
    controller.optionsFor(CREATE_PREVIEW).handlers!.onReject!();
    await vi.waitFor(() => expect(ports.previewPort.rejected).toEqual(["create-fixture"]));
    ports.previewPort.focused = "create-fixture";
    controller.optionsFor(CREATE_PREVIEW).handlers!.onRepreview!();
    await vi.waitFor(() => expect(ports.previewPort.focused).toBe("create-fixture:again"));
    const undo = vi.fn(); const withUndo = new PreviewCardController(ports, { undoEntry: undo }, vi.fn());
    withUndo.optionsFor(CREATE_PREVIEW).handlers!.onUndo!("undo-1"); await vi.waitFor(() => expect(undo).toHaveBeenCalledWith("undo-1"));
  });
});

describe("read result card", () => {
  it("shows scope, omission and a continue button with the cursor", () => {
    const onLoadMore = vi.fn();
    const card = renderReadResultCard(root(), READ_FIXTURES.tasks as any, { onLoadMore }) as unknown as FakeEl;
    expect(text(card)).toContain("該当 21件のうち 1件を取得"); expect(text(card)).toContain("省略あり: 残り 20件"); expect(text(card)).toContain("レビュー");
    dispatch(button(card, "load-more")!, "click"); expect(onLoadMore).toHaveBeenCalledWith("opaque-query-snapshot-cursor");
    const daily = renderReadResultCard(root(), READ_FIXTURES.daily as any) as unknown as FakeEl;
    expect(text(daily)).toContain("2026-10-13 · 0/1件完了"); expect(button(daily, "load-more")).toBeUndefined();
  });
});
