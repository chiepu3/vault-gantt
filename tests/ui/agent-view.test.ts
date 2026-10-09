/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, afterEach } from "vitest";
import { AgentView, diffText, renderChatText } from "../../src/ui/agent-view";
import { ChatSession } from "../../src/ai/chat-session";
import { OperationRegistry } from "../../src/app/operation-registry";
import { HistoryManager } from "../../src/app/history-manager";
import { DEFAULT_SETTINGS } from "../../src/core/constants";
import { FakeVault } from "../app/fake-vault";
import { FakeProvider } from "../ai/fake-provider";
import { createFakeDocument, findAll, type FakeEl } from "../stubs/fake-dom";
import { CREATE_PREVIEW, MCP_PREVIEW } from "../contracts/fixtures";
import { fakePorts } from "./preview-fakes";
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("independent AgentView", () => {
  it("pane close/reopen preserves the vault session, draft and streaming state", async () => {
    vi.stubGlobal("document", createFakeDocument());
    const vault = new FakeVault();
    const registry = new OperationRegistry({ settings: { ...DEFAULT_SETTINGS }, historyManager: new HistoryManager(), invalidate: () => undefined }, () => vault);
    const session = new ChatSession(vault, registry, new FakeProvider());
    session.configure({ provider: "openai-compatible", endpoint: "http://localhost:1234", model: "synthetic", auth: "none", secretId: "" });
    const host = { session, secretIds: () => [], openGantt: vi.fn(), undo: vi.fn(), canUndo: () => false };
    const view = new AgentView({} as any, host); await view.onOpen();
    await session.send("合成会話"); session.active.draft = "未送信"; await view.onClose();
    const reopened = new AgentView({} as any, host); await reopened.onOpen();
    const root = reopened.containerEl as unknown as FakeEl;
    expect(findAll(root, (el) => el.textContent === "合成応答")).toHaveLength(1);
    expect(findAll(root, (el) => el.tagName.toLowerCase() === "textarea")[0].value).toBe("未送信");
    expect((findAll(root, el => el.className === "vg-ai-context")[0] as any).hidden).toBe(true);
    const input = findAll(root, (el) => el.tagName.toLowerCase() === "textarea")[0];
    const event = { key: "z", ctrlKey: true, preventDefault: vi.fn() };
    for (const listener of input.listeners.keydown) listener(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    await reopened.onClose(); session.dispose();
  });
  it("keeps history/settings behind menus and composer actions mutually exclusive", async () => {
    vi.stubGlobal("document", createFakeDocument());
    const vault = new FakeVault();
    const registry = new OperationRegistry({ settings: { ...DEFAULT_SETTINGS }, historyManager: new HistoryManager(), invalidate: () => undefined }, () => vault);
    const session = new ChatSession(vault, registry, new FakeProvider());
    session.configure({ provider: "openai-compatible", endpoint: "http://localhost:1234", model: "synthetic", auth: "none", secretId: "" });
    const undo = vi.fn();
    const view = new AgentView({} as any, { session, secretIds: () => [], selectedTask: () => "合成タスク", openGantt: vi.fn(), undo, canUndo: () => true });
    await view.onOpen();
    const root = view.containerEl as unknown as FakeEl;
    const button = (text: string) => findAll(root, (el) => el.tagName === "BUTTON" && el.textContent === text)[0] as any;
    expect(findAll(root, (el) => el.tagName === "HEADER")).toHaveLength(1);
    expect(findAll(root, (el) => el.tagName === "SELECT")).toHaveLength(3); // Connection settings only; model uses Obsidian Menu.
    const model = findAll(root, (el) => el.getAttribute("aria-label") === "モデルを選択")[0];
    expect(model.tagName).toBe("BUTTON"); expect(model.dataset.model).toBe("synthetic");
    expect(model.getAttribute("aria-haspopup")).toBe("menu");
    session.configure({ ...session.config, model: "synthetic-2" }); view.render();
    const event = { key: "ArrowDown", preventDefault: vi.fn() };
    for (const listener of model.listeners.keydown) listener(event);
    expect(event.preventDefault).toHaveBeenCalled(); expect(model.getAttribute("aria-expanded")).toBe("true");
    const menuItems = findAll(document.body as unknown as FakeEl, el => el.classList.contains("menu-item"));
    expect(menuItems.map(el => el.textContent)).toEqual(["synthetic", "synthetic-2"]);
    expect(menuItems[1].getAttribute("aria-checked")).toBe("true");
    for (const listener of menuItems[0].listeners.click) listener({});
    expect(session.config.model).toBe("synthetic"); expect(model.getAttribute("aria-expanded")).toBe("false");
    expect(findAll(root, el => el.classList.contains("vg-ai-icon-button"))).toHaveLength(3);
    for (const control of findAll(root, el => el.classList.contains("vg-ai-icon-button"))) {
      expect(control.getAttribute("aria-label")).toBeTruthy(); expect(control.title).toBeTruthy(); expect(control.children[0].tagName).toBe("SVG");
    }
    expect(findAll(root, (el) => el.getAttribute("aria-label") === "新しい会話")).toHaveLength(1);
    expect(findAll(root, (el) => el.textContent.startsWith("選択中: 合成タスク"))).toHaveLength(1);
    expect(button("送信 ↑").hidden).toBe(false); expect(button("停止 ■").hidden).toBe(true);
    expect(button("応答を再試行")).toBeUndefined();
    session.active.messages = [{ role: "assistant", text: "**確認**しました", proposals: [] }];
    session.active.status = "running"; view.render();
    expect(button("送信 ↑").hidden).toBe(true); expect(button("停止 ■").hidden).toBe(false);
    session.active.status = "failed"; session.active.error = "合成エラー"; view.render();
    expect(button("応答を再試行").parentNode.className).toBe("vg-ai-message vg-ai-assistant");
    session.active.status = "idle";
    const result = { kind: "success" as const, committed: 1, total: 1, results: [], undoLabel: "synthetic-history", message: "合成保存", diffs: [{ taskId: "fake", name: "合成タスク", fields: [{ field: "notes", before: "旧", after: "新" }] }] };
    session.active.messages[0].proposals = [{ operation: "update", input: {}, consumed: true, plan: { previewId: "fake", operation: "update", summary: "合成", count: 1, diffs: result.diffs }, result }];
    session.active.context = [{ role: "tool", content: [{ type: "tool-result", toolCallId: "fake", toolName: "search", output: { type: "text", value: "not rendered" } }] }];
    view.render();
    expect(findAll(root, (el) => el.textContent === "タスク検索")).toHaveLength(1);
    expect(findAll(root, (el) => el.textContent === "メモ: 旧 → 新")).toHaveLength(1);
    for (const listener of button("元に戻す").listeners.click) listener({});
    expect(undo).toHaveBeenCalledWith(result);
    const input = findAll(root, (el) => el.tagName === "TEXTAREA")[0];
    input.scrollHeight = 220; input.value = "複数行";
    for (const listener of input.listeners.input) listener({});
    expect(input.style.height).toBe("160px"); expect(session.active.draft).toBe("複数行");
    await view.onClose(); session.dispose();
  });
  it("shows periods/delta and proposed, applied and undone states without changing proposals", async () => {
    vi.stubGlobal("document", createFakeDocument());
    const vault = new FakeVault(); const history = new HistoryManager();
    const registry = new OperationRegistry({ settings: { ...DEFAULT_SETTINGS }, historyManager: history, invalidate: () => undefined }, () => vault);
    const session = new ChatSession(vault, registry, new FakeProvider());
    const diff = { taskId: "synthetic", name: "デザイン確認", fields: [{ field: "plannedStartDate", before: "2026-10-01", after: "2026-10-04" }, { field: "notes", before: "旧", after: "新" }], schedule: { before: { start: "2026-10-01", end: "2026-10-03" }, after: { start: "2026-10-04", end: "2026-10-06" } } };
    const proposal: any = { operation: "update", input: {}, consumed: false, plan: { previewId: "synthetic", operation: "update", summary: "合成", count: 1, diffs: [diff] } };
    session.active.messages = [{ role: "assistant", text: "合成提案", proposals: [proposal] }];
    let canUndo = false; let undone = false;
    const undo = vi.fn(async () => { canUndo = false; undone = true; });
    const view = new AgentView({} as any, { session, secretIds: () => [], openGantt: vi.fn(), undo, canUndo: () => canUndo, undoStatus: () => undone ? "undone" : "unavailable" });
    await view.onOpen(); const root = view.containerEl as unknown as FakeEl;
    const text = (value: string) => findAll(root, el => el.textContent === value);
    const button = (value: string) => findAll(root, el => el.tagName === "BUTTON" && el.textContent === value)[0];
    expect(text("変更案")).toHaveLength(1); expect(text("デザイン確認")).toHaveLength(1);
    const timeline = findAll(root, el => el.className === "vg-ai-mini-timeline")[0];
    expect(timeline.getAttribute("aria-label")).toContain("2026-10-01 ～ 2026-10-03");
    expect(timeline.getAttribute("aria-label")).toContain("2026-10-04 ～ 2026-10-06");
    expect(text("+3d")).toHaveLength(1); expect(text("メモ: 旧 → 新")).toHaveLength(1);
    expect(findAll(root, el => el.className.includes("vg-ai-mini-row"))).toHaveLength(2);
    expect(button("元に戻す")).toBeUndefined();
    proposal.consumed = true;
    proposal.result = { kind: "success", committed: 1, total: 1, results: [], message: "保存しました", diffs: [diff], undoLabel: "synthetic-top" };
    const snapshot = structuredClone(proposal);
    view.render(); expect(button("元に戻す").disabled).toBe(true);
    expect(button("元に戻す").title).toContain("履歴の先頭ではない");
    expect(text("適用済み")).toHaveLength(1); expect(text("保存しました")).toHaveLength(0);
    canUndo = true; view.render(); expect(button("元に戻す").disabled).toBe(false);
    // A concurrent top-history change must be rechecked even before a UI refresh.
    canUndo = false; for (const listener of button("元に戻す").listeners.click) listener({});
    expect(undo).not.toHaveBeenCalled(); expect(button("元に戻す").disabled).toBe(true);
    canUndo = true; view.render();
    for (const listener of button("元に戻す").listeners.click) listener({});
    await Promise.resolve(); await Promise.resolve();
    expect(undo).toHaveBeenCalledOnce(); expect(text("元に戻しました")).toHaveLength(1);
    expect(button("元に戻す").disabled).toBe(true); expect(proposal).toEqual(snapshot);
    await view.onClose(); session.dispose();
  });
  it("renders a safe Markdown subset without HTML, images or links", () => {
    vi.stubGlobal("document", createFakeDocument());
    const root = document.createElement("div");
    renderChatText(root, '**強調**と`コード`\n- 箇条書き\n<img src=x onerror=alert(1)> [リンク](javascript:alert(1))');
    const fake = root as unknown as FakeEl;
    expect(findAll(fake, (el) => el.tagName === "STRONG" && el.textContent === "強調")).toHaveLength(1);
    expect(findAll(fake, (el) => el.tagName === "CODE" && el.textContent === "コード")).toHaveLength(1);
    expect(findAll(fake, (el) => ["IMG", "A", "SCRIPT"].includes(el.tagName))).toHaveLength(0);
    expect(findAll(fake, (el) => el.textContent.includes("<img"))).toHaveLength(1);
  });
  it("diff text conveys old/new dates and non-date changes without relying on color", () => {
    expect(diffText([{ taskId: "synthetic", name: "作業", fields: [{ field: "plannedStartDate", before: "2026-10-01", after: "2026-10-03" }, { field: "notes", before: "旧", after: "新" }] }])).toBe("作業\n開始日: 2026-10-01 → 2026-10-03\nメモ: 旧 → 新");
  });
});

describe("AgentView operation preview cards", () => {
  async function open(previews: readonly any[], extras: Record<string, unknown> = {}) {
    vi.stubGlobal("document", createFakeDocument());
    const vault = new FakeVault();
    const registry = new OperationRegistry({ settings: { ...DEFAULT_SETTINGS }, historyManager: new HistoryManager(), invalidate: () => undefined }, () => vault);
    const session = new ChatSession(vault, registry, new FakeProvider());
    session.configure({ provider: "openai-compatible", endpoint: "http://localhost:1234", model: "synthetic", auth: "none", secretId: "" });
    const ports = fakePorts(previews.map((preview) => ({ ...preview, origin: preview.origin.kind === "chat" ? { kind: "chat", conversationId: session.active.id } : preview.origin })));
    const view = new AgentView({} as any, { session, secretIds: () => [], openGantt: vi.fn(), undo: vi.fn(), canUndo: () => false, previewPorts: ports, ...extras });
    await view.onOpen();
    return { view, session, ports, root: view.containerEl as unknown as FakeEl };
  }
  it("shows this conversation's chat previews as cards, not other origins or conversations", async () => {
    const other = { ...CREATE_PREVIEW, previewId: "elsewhere", origin: { kind: "chat", conversationId: "other-conversation" } };
    const { root, ports, view, session } = await open([CREATE_PREVIEW, MCP_PREVIEW]);
    ports.previewPort.set({ ...other, origin: { kind: "chat", conversationId: "other-conversation" } } as any);
    view.render();
    const cards = findAll(root, (el) => el.classList.contains("vg-pv-card"));
    expect(cards.map((card) => card.dataset.previewId)).toEqual(["create-fixture"]);
    await view.onClose(); session.dispose();
  });
  it("renders nothing extra without preview ports (legacy view unchanged)", async () => {
    const { root, view, session } = await open([], { previewPorts: undefined });
    expect(findAll(root, (el) => el.classList.contains("vg-pv-card"))).toHaveLength(0);
    await view.onClose(); session.dispose();
  });
  it("keeps keyboard focus on the same button across re-renders", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse("2026-10-09T03:05:00Z"));
    const { root, view, session } = await open([CREATE_PREVIEW]);
    const reject = findAll(root, (el) => el.dataset?.action === "reject")[0];
    (document as any).activeElement = reject;
    view.render();
    const again = findAll(root, (el) => el.dataset?.action === "reject")[0];
    expect(again).not.toBe(reject); expect(again.focused).toBe(true);
    await view.onClose(); session.dispose();
  });
  it("approves through the human port and re-renders with the saved result", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse("2026-10-09T03:05:00Z"));
    const { root, ports, view, session } = await open([CREATE_PREVIEW]);
    const approve = findAll(root, (el) => el.dataset?.action === "approve")[0];
    expect(approve.disabled).toBe(false);
    for (const listener of approve.listeners.click) listener({});
    await vi.waitFor(() => expect(ports.approved).toEqual(["create-fixture"]));
    await vi.waitFor(() => expect(findAll(root, (el) => el.classList.contains("vg-pv-card"))[0]?.dataset.state).toBe("success"));
    await view.onClose(); session.dispose();
  });
  it("drops the Gantt overlay of a chat plan on conversation switch and on close, but keeps the plan", async () => {
    const { ports, view, session } = await open([CREATE_PREVIEW]);
    ports.previewPort.focused = "create-fixture";
    session.newConversation(); view.render();
    expect(ports.previewPort.focused).toBeNull();
    ports.previewPort.focused = "create-fixture"; await view.onClose();
    expect(ports.previewPort.focused).toBeNull(); expect(ports.previewPort.previews.has("create-fixture")).toBe(true);
    session.dispose();
  });
  it("leaves another origin's Gantt focus alone when the chat closes", async () => {
    const { ports, view, session } = await open([CREATE_PREVIEW, MCP_PREVIEW]);
    ports.previewPort.focused = "mcp-fixture"; await view.onClose();
    expect(ports.previewPort.focused).toBe("mcp-fixture"); session.dispose();
  });
});
