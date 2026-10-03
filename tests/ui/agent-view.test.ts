/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, afterEach } from "vitest";
import { AgentView, diffText } from "../../src/ui/agent-view";
import { ChatSession } from "../../src/ai/chat-session";
import { OperationRegistry } from "../../src/app/operation-registry";
import { HistoryManager } from "../../src/app/history-manager";
import { DEFAULT_SETTINGS } from "../../src/core/constants";
import { FakeVault } from "../app/fake-vault";
import { FakeProvider } from "../ai/fake-provider";
import { createFakeDocument, findAll, type FakeEl } from "../stubs/fake-dom";
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
    const input = findAll(root, (el) => el.tagName.toLowerCase() === "textarea")[0];
    const event = { key: "z", ctrlKey: true, preventDefault: vi.fn() };
    for (const listener of input.listeners.keydown) listener(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    await reopened.onClose(); session.dispose();
  });
  it("diff text conveys old/new dates and non-date changes without relying on color", () => {
    expect(diffText([{ taskId: "synthetic", name: "作業", fields: [{ field: "plannedStartDate", before: "2026-10-01", after: "2026-10-03" }, { field: "notes", before: "旧", after: "新" }] }])).toBe("作業\n開始日: 2026-10-01 → 2026-10-03\nメモ: 旧 → 新");
  });
});
