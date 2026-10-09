/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { CREATE_PREVIEW, MCP_PREVIEW, PARTIAL_PREVIEW, PARTIAL_OUTCOME } from "../contracts/fixtures";
import { ApprovalView, VIEW_TYPE_AI_APPROVAL } from "../../src/ui/approval-view";
import { createFakeDocument, byClass, byTag, deepText, dispatch, type FakeEl } from "../stubs/fake-dom";
import { fakePorts } from "./preview-fakes";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.parse("2026-10-09T03:05:00Z")); vi.stubGlobal("document", createFakeDocument()); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const text = (el: unknown) => deepText(el as FakeEl);
const second = { ...MCP_PREVIEW, previewId: "mcp-second", createdAt: "2026-10-09T03:02:00Z", entries: MCP_PREVIEW.entries.map((entry) => ({ ...entry, actionId: "mcp-second:0" })) };
async function open(ports = fakePorts([MCP_PREVIEW, CREATE_PREVIEW]), extras: any = {}) {
  const view = new ApprovalView({} as any, { ...ports, ...extras });
  await view.onOpen();
  return { view, ports, root: view.containerEl as unknown as FakeEl };
}
const action = (root: FakeEl, previewId: string, name: string) => byTag(root, "button").find((el) => el.dataset.action === name && el.dataset.focusKey === `${previewId}:${name}`) as (FakeEl & { disabled: boolean }) | undefined;

describe("MCP approval list", () => {
  it("is its own view with a plain title", () => {
    const view = new ApprovalView({} as any, fakePorts());
    expect(view.getViewType()).toBe(VIEW_TYPE_AI_APPROVAL); expect(view.getDisplayText()).toBe("承認一覧");
  });
  it("lists MCP requests only, newest first, and never invents chat entries", async () => {
    const { root } = await open(fakePorts([CREATE_PREVIEW, MCP_PREVIEW, second]));
    const cards = byClass(root, "vg-pv-card");
    expect(cards.map((card) => card.dataset.previewId)).toEqual(["mcp-second", "mcp-fixture"]);
    expect(cards.every((card) => card.dataset.origin === "mcp")).toBe(true);
    expect(text(root)).toContain("承認待ち 2件 · 処理済み 0件"); expect(text(root)).toContain("ここで承認するまでVaultは変更されません");
    expect(text(root)).toContain("ローカルMCPクライアント");
  });
  it("shows an empty state when nothing is waiting", async () => {
    const { root } = await open(fakePorts([CREATE_PREVIEW]));
    expect(text(root)).toContain("承認待ちの要求はありません"); expect(byClass(root, "vg-pv-card")).toHaveLength(0);
  });
  it("approves with the human port, then moves the card to the processed group with its result", async () => {
    const { root, ports } = await open();
    dispatch(action(root, "mcp-fixture", "approve")!, "click");
    await vi.waitFor(() => expect(ports.approved).toEqual(["mcp-fixture"]));
    await vi.advanceTimersByTimeAsync(100);
    expect(text(root)).toContain("承認待ち 0件 · 処理済み 1件");
    const card = byClass(root, "vg-pv-card")[0]; expect(card.dataset.state).toBe("success");
    expect(text(byClass(card, "vg-pv-status")[0])).toBe("適用済み");
  });
  it("shows the failure under the card when approval throws and keeps it pending", async () => {
    const ports = fakePorts([MCP_PREVIEW]); ports.approve.fail = new Error("前提が変わりました");
    const { root } = await open(ports);
    dispatch(action(root, "mcp-fixture", "approve")!, "click");
    await vi.advanceTimersByTimeAsync(100);
    expect(text(byClass(root, "is-error")[0])).toBe("保存できませんでした: 前提が変わりました");
    expect(byClass(root, "vg-pv-card")[0].dataset.state).toBe("pending");
  });
  it("rejects, focuses the Gantt and opens it, and toggles focus off", async () => {
    const openGantt = vi.fn();
    const withGantt = { ...MCP_PREVIEW, projection: CREATE_PREVIEW.projection };
    const { root, ports } = await open(fakePorts([withGantt]), { openGantt });
    dispatch(action(root, "mcp-fixture", "focus")!, "click");
    expect(ports.previewPort.focused).toBe("mcp-fixture"); expect(openGantt).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(byClass(root, "vg-pv-card")[0].dataset.focused).toBe("true");
    dispatch(action(root, "mcp-fixture", "reject")!, "click");
    await vi.advanceTimersByTimeAsync(100);
    expect(ports.previewPort.rejected).toEqual(["mcp-fixture"]); expect(text(byClass(root, "vg-pv-status")[0])).toBe("却下");
  });
  it("flips a waiting card to 期限切れ when the expiry passes, without any port event", async () => {
    const { root } = await open();
    expect(byClass(root, "vg-pv-card")[0].dataset.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);
    const card = byClass(root, "vg-pv-card")[0];
    expect(card.dataset.state).toBe("expired"); expect(action(root, "mcp-fixture", "approve")!.disabled).toBe(true); expect(action(root, "mcp-fixture", "repreview")).toBeTruthy();
  });
  it("keeps undo gated by the live history state and re-renders when history changes", async () => {
    const preview = { ...PARTIAL_PREVIEW, origin: MCP_PREVIEW.origin };
    const ports = fakePorts([preview]); ports.previewPort.outcomes.set(preview.previewId, PARTIAL_OUTCOME);
    const undoEntry = vi.fn();
    const { root } = await open(ports, { undoEntry });
    expect(action(root, preview.previewId, "undo")!.disabled).toBe(false);
    ports.historyPort.states.set("undo-1", { entryId: "undo-1", historyRevision: "h2", state: "not-latest", reason: null }); ports.historyPort.emit();
    await vi.advanceTimersByTimeAsync(100);
    expect(action(root, preview.previewId, "undo")!.disabled).toBe(true);
    ports.historyPort.states.delete("undo-1"); ports.historyPort.emit(); await vi.advanceTimersByTimeAsync(100);
    dispatch(action(root, preview.previewId, "undo")!, "click"); await vi.waitFor(() => expect(undoEntry).toHaveBeenCalledWith("undo-1"));
  });
  it("on close releases only its own Gantt focus and leaves pending plans in the store", async () => {
    const { view, ports } = await open();
    ports.previewPort.focused = "mcp-fixture"; await view.onClose();
    expect(ports.previewPort.focused).toBeNull(); expect(ports.previewPort.previews.has("mcp-fixture")).toBe(true);
    const other = await open(fakePorts([CREATE_PREVIEW, MCP_PREVIEW])); other.ports.previewPort.focused = "create-fixture"; await other.view.onClose();
    expect(other.ports.previewPort.focused).toBe("create-fixture");
  });
});
