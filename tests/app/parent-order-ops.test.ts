import { describe, it, expect, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/core/constants";
import { HistoryManager } from "../../src/app/history-manager";
import { OperationRegistry } from "../../src/app/operation-registry";
import { createTask, loadTasks } from "../../src/app/task-operations";
import { FakeVault } from "./fake-vault";

async function setup(withOldNotes = false) {
  const vault = new FakeVault();
  const settings = { ...DEFAULT_SETTINGS, autoPriorityEnabled: false };
  const history = new HistoryManager();
  const persistSettings = vi.fn(async (candidate: typeof settings) => { settings.ganttParentOrder = candidate.ganttParentOrder; });
  const registry = new OperationRegistry({ settings, historyManager: history, invalidate: vi.fn(), persistSettings }, () => vault);
  let store = settings.ganttParentOrder;
  history.attachOrderStore({ get: () => settings.ganttParentOrder, set: async (order) => { settings.ganttParentOrder = order; store = order; } });
  void store;
  const names = ["Alpha", "Beta", "Gamma"];
  const parents = [];
  for (const name of names) parents.push(await createTask(vault, settings, name));
  if (withOldNotes) {
    // Old-style notes carry their own ganttOrder line.
    for (const [index, parent] of parents.entries()) {
      const file = vault.getFileByPath(parent.id)!;
      const content = await vault.read(file);
      await vault.modify(file, content.replace("ganttEnabled: false", `ganttEnabled: true\nganttOrder: ${(3 - index) * 10}`));
    }
  }
  vault.resetCounters();
  return { vault, settings, history, registry, parents, persistSettings };
}

describe("parent order stored in settings", () => {
  it("migrates the order from the notes' ganttOrder without touching the notes", async () => {
    const a = await setup(true);
    const rows = await loadTasks(a.vault, a.settings, new Map());
    expect(a.settings.ganttParentOrder).toEqual([a.parents[2].id, a.parents[1].id, a.parents[0].id]);
    expect(rows.find((r) => r.id === a.parents[2].id)!.ganttOrder).toBe(1000);
    expect(a.vault.getModifyCallCount()).toBe(0);
  });

  it("reordering N parents writes no notes and updates the store; undo/redo restore it", async () => {
    const a = await setup();
    const rows = await loadTasks(a.vault, a.settings, new Map());
    const before = [...a.settings.ganttParentOrder!];
    const contents = a.parents.map((p) => a.vault.getFileContent(p.id));
    const [x, y, z] = before;
    const result = await a.registry.updateFromUI([
      { row: rows.find((r) => r.id === z)!, patch: { ganttOrder: 1000 } },
      { row: rows.find((r) => r.id === x)!, patch: { ganttOrder: 2000 } },
      { row: rows.find((r) => r.id === y)!, patch: { ganttOrder: 3000 } },
    ]);
    expect(result.length).toBe(3);
    expect(a.vault.getModifyCallCount()).toBe(0);
    expect(a.parents.map((p) => a.vault.getFileContent(p.id))).toEqual(contents);
    expect(a.settings.ganttParentOrder).toEqual([z, x, y]);
    expect(a.history.canUndo()).toBe(true);

    expect((await a.history.undo(a.vault as never)).kind).toBe("success");
    expect(a.settings.ganttParentOrder).toEqual(before);
    expect((await a.history.redo(a.vault as never)).kind).toBe("success");
    expect(a.settings.ganttParentOrder).toEqual([z, x, y]);
  });

  it("ganttEnabled + order writes only ganttEnabled to the note", async () => {
    const a = await setup();
    const rows = await loadTasks(a.vault, a.settings, new Map());
    const target = rows[0];
    await a.registry.updateFromUI([{ row: target, patch: { ganttEnabled: true, ganttOrder: 99999 } }]);
    expect(a.vault.getModifyCallCount()).toBe(1);
    const text = a.vault.getFileContent(target.id);
    expect(text).toContain("ganttEnabled: true");
    expect(text).not.toContain("ganttOrder");
    expect(a.settings.ganttParentOrder![a.settings.ganttParentOrder!.length - 1]).toBe(target.id);
  });
});

describe("AI operation pipeline with parent order", () => {
  it("T18 previews the order change and applies it to settings without writing notes", async () => {
    const { runtimeFixture } = await import("./operation-runtime-fixture");
    const { PARENT_ID } = await import("../contracts/fixtures");
    const { service, context, vault, settings, persistSettings } = await runtimeFixture();
    const second = await createTask(vault, settings, "Second");
    vault.resetCounters();
    const preview = await service.propose("T18", { orderedParentIds: [PARENT_ID, second.id] }, context);
    expect(JSON.stringify(preview.entries)).toContain("ganttOrder");
    expect(vault.getModifyCallCount()).toBe(0);
    const outcome = await service.humanApprovalPort.approve(preview.previewId);
    expect(outcome.status).toBe("success");
    expect(vault.getModifyCallCount()).toBe(0);
    expect(persistSettings).toHaveBeenCalledWith(expect.anything(), ["ganttParentOrder"]);
    expect(outcome.undoEntryId).toBeDefined();
  });
});
