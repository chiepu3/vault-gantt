import type { WorkspaceLeaf } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentView } from "../../src/ui/agent-view";
import { ChatSession, type Proposal } from "../../src/ai/chat-session";
import { OperationRegistry, type OperationResult } from "../../src/app/operation-registry";
import { HistoryManager } from "../../src/app/history-manager";
import { DEFAULT_SETTINGS } from "../../src/core/constants";
import { FakeVault } from "../app/fake-vault";
import { FakeProvider } from "../ai/fake-provider";
import { createFakeDocument, findAll, type FakeEl } from "../stubs/fake-dom";

afterEach(() => vi.unstubAllGlobals());

async function setup(result: OperationResult, canUndo: () => boolean) {
  vi.stubGlobal("document", createFakeDocument());
  const vault = new FakeVault();
  const registry = new OperationRegistry({ settings: { ...DEFAULT_SETTINGS }, historyManager: new HistoryManager(), invalidate: () => undefined }, () => vault);
  const session = new ChatSession(vault, registry, new FakeProvider());
  const proposal: Proposal = {
    operation: "update", input: {}, consumed: true,
    plan: { previewId: "synthetic", operation: "update", summary: "Synthetic", count: 1, diffs: result.diffs }, result,
  };
  session.active.messages = [{ role: "assistant", text: "Synthetic result", proposals: [proposal] }];
  const undo = vi.fn();
  const view = new AgentView({} as WorkspaceLeaf, { session, openSettings: vi.fn(), openGantt: vi.fn(), undo, canUndo });
  await view.onOpen();
  const root = view.containerEl as unknown as FakeEl;
  const undoButton = () => findAll(root, el => el.tagName === "BUTTON" && el.textContent === "元に戻す")[0];
  const close = async () => { await view.onClose(); session.dispose(); };
  return { view, proposal, undo, root, undoButton, close };
}

function result(kind: OperationResult["kind"], committed: number, undoLabel?: string): OperationResult {
  return {
    kind, committed, total: 2, results: [], message: "Synthetic outcome", undoLabel,
    diffs: committed ? [{ taskId: "synthetic", name: "Synthetic child", fields: [{ field: "notes", before: "Old", after: "New" }], schedule: { before: { start: "2026-10-01", end: "2026-10-03" }, after: { start: "2026-10-04", end: "2026-10-06" } } }] : [],
  };
}

describe("result history feature coverage", () => {
  it.each(["success", "partial", "cancelled"] as const)("%s without undoLabel never claims an available undo", async (kind) => {
    // Even an overly permissive host cannot invent a recorded history entry.
    const a = await setup(result(kind, 1), () => true);
    try {
      expect(a.undoButton()?.disabled ?? true).toBe(true);
      for (const listener of a.undoButton()?.listeners.click ?? []) listener({});
      expect(a.undo).not.toHaveBeenCalled();
      expect(findAll(a.root, el => el.className === "vg-ai-mini-timeline")).toHaveLength(1);
    } finally { await a.close(); }
  });

  it.each(["failed", "stale", "cancelled"] as const)("%s with zero writes offers no undo", async (kind) => {
    const a = await setup(result(kind, 0), () => true);
    try { expect(a.undoButton()).toBeUndefined(); expect(a.undo).not.toHaveBeenCalled(); }
    finally { await a.close(); }
  });

  it.each(["success", "partial", "cancelled"] as const)("%s with recorded top history remains undoable", async (kind) => {
    let available = true;
    const a = await setup(result(kind, 1, "synthetic-history"), () => available);
    try {
      expect(a.undoButton().disabled).toBe(false);
      available = false;
      for (const listener of a.undoButton().listeners.click) listener({});
      expect(a.undo).not.toHaveBeenCalled(); expect(a.undoButton().disabled).toBe(true);
      available = true; a.view.render();
      for (const listener of a.undoButton().listeners.click) listener({});
      expect(a.undo).toHaveBeenCalledWith(a.proposal.result);
    } finally { await a.close(); }
  });
});
