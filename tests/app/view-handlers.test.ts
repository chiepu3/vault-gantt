import { describe, it, expect, vi } from "vitest";
import type { App } from "obsidian";
import type { UiPort } from "../../src/contracts/ports";
import type { OperationInputMap } from "../../src/contracts/operations";
import { OPERATION_EXAMPLES } from "../../src/agent-tools/definitions";
import { viewRequest, diagnosticRequest, diagnosticPlan, executeDiagnosticPlan, historyPlan, executeHistoryPlan, type ViewRequestId } from "../../src/app/operations/view-handlers";
import { previewEntrySchema } from "../../src/contracts/preview";
import { Logger } from "../../src/core/logger";
import { runtimeFixture } from "./operation-runtime-fixture";
import { newNoteText } from "../../src/app/task-operations";
import { CHILD_ID, CHILD_PATH } from "../contracts/fixtures";
import type { HistoryVault } from "../../src/app/history-manager";

const ui: UiPort = {
  listViews: () => [],
  inspectView: (viewId) => ({ viewId, kind: "gantt", filterText: "", statusFilter: "all", showCompleted: false, tagNames: [] }),
  request: vi.fn(async (id) => ({ schemaVersion: 1 as const, resultKind: "request" as const, operationId: id, status: "applied" as const, effects: [{ kind: "view" as const, before: null, after: { displayed: true }, affectedIds: [] }] })),
  requestApproval: async () => { throw new Error("unused"); },
};
const ids: ViewRequestId[] = ["D08", "V01", "V02", "V03", "V04", "V05", "V06", "V07", "V08", "V09", "V10", "V11", "V12", "V13", "V14", "V15", "V16", "V17", "V18", "V19"];
function entriesValid(entries: Awaited<ReturnType<typeof historyPlan>>["entries"]) {
  for (const [index, entry] of entries.entries()) expect(() => previewEntrySchema.parse({ ...entry, actionId: `view-${index}` })).not.toThrow();
}
describe("view, history and diagnostics operation handlers", () => {
  it.each(ids)("%s routes validated input through the UI port", async (id) => {
    const f = await runtimeFixture(), context = { ...f.context, origin: { kind: "ui" as const, viewId: "gantt" }, capabilities: ["ui" as const] };
    const input = OPERATION_EXAMPLES[id] as OperationInputMap[typeof id];
    expect(await viewRequest(id, input, context, ui)).toMatchObject({ operationId: id, status: "applied" });
    expect(f.vault.getModifyCallCount()).toBe(0);
  });
  it("refuses external persistence, missing capabilities/port/view and invalid schemas", async () => {
    const f = await runtimeFixture(); const context = { ...f.context, capabilities: ["ui" as const] };
    await expect(viewRequest("V14", { viewId: "gantt", dayWidth: 30 }, context, ui)).rejects.toMatchObject({ error: { code: "POLICY_DENIED" } });
    await expect(viewRequest("V01", {}, context)).rejects.toMatchObject({ error: { code: "UI_UNAVAILABLE" } });
    await expect(viewRequest("V01", {}, f.context, ui)).rejects.toMatchObject({ error: { code: "POLICY_DENIED" } });
    await expect(viewRequest("V07", { viewId: "missing", text: "x" }, context, { ...ui, inspectView: () => undefined })).rejects.toMatchObject({ error: { code: "UI_UNAVAILABLE" } });
    await expect(viewRequest("D08", { path: "../escape.md" }, context, ui)).rejects.toMatchObject({ error: { code: "INVALID_INPUT" } });
  });
  it("V20/V21 preview the history transition and execute through existing undo/redo", async () => {
    const f = await runtimeFixture(), file = f.vault.getFileByPath(CHILD_PATH)!, before = await f.vault.read(file);
    const copy = structuredClone(f.child); copy.displayName = "変更"; copy.title = "変更";
    const historyVault = { getFileByPath: (path: string) => f.vault.getFileByPath(path), read: f.vault.read.bind(f.vault), process: async (file: { path: string }, transform: (current: string) => string) => { const next = transform(await f.vault.read(file)); await f.vault.modify(file, next); return next; } } as unknown as HistoryVault;
    const after = newNoteText(f.vault, copy, f.parent); await f.vault.modify(file, after); f.historyManager.push({ label: "rename", files: [{ path: CHILD_PATH, before, after }] });
    const undo = await historyPlan("V20", {}, await f.service.contextPort.snapshot(), f.historyManager);
    entriesValid(undo.entries); expect(undo.writes).toEqual([{ path: CHILD_PATH, before: after, after: before, taskId: CHILD_ID }]); expect(await f.vault.read(file)).toBe(after);
    await executeHistoryPlan(undo, f.historyManager, historyVault); expect(await f.vault.read(file)).toBe(before);
    const redo = await historyPlan("V21", {}, await f.service.contextPort.snapshot(), f.historyManager); entriesValid(redo.entries);
    await executeHistoryPlan(redo, f.historyManager, historyVault); expect(await f.vault.read(file)).toBe(after);
    await expect(executeHistoryPlan(undo, f.historyManager, historyVault)).rejects.toMatchObject({ error: { code: "REVISION_CONFLICT" } });
  });
  it("history plans cover created and deleted notes", async () => {
    const f = await runtimeFixture();
    const created = { ...structuredClone(f.child), id: "s-new001", key: "s-new001", title: "追加", displayName: "追加", file: { path: "tasks/リリース/追加.md", parentPath: f.parent.file.path } as typeof f.child.file };
    const text = newNoteText(f.vault, created, f.parent); await f.vault.create(created.file.path, text);
    f.historyManager.push({ label: "create", files: [{ path: created.file.path, before: null, after: text }] });
    const undo = await historyPlan("V20", {}, await f.service.contextPort.snapshot(), f.historyManager);
    entriesValid(undo.entries); expect(undo.writes).toEqual([{ path: created.file.path, before: text, after: null, taskId: "s-new001" }]);
    expect(undo.afterParents[0].subtasks!.has("s-new001")).toBe(false);
    expect(undo.entries[0].effects.some((effect) => effect.kind === "presence" && effect.action === "delete")).toBe(true);
  });
  it("history returns INVALID_INPUT for notes that are not task notes", async () => {
    const f = await runtimeFixture(), snapshot = await f.service.contextPort.snapshot();
    const content = snapshot.contents.get(CHILD_PATH)!;
    f.historyManager.push({ label: "unsafe", files: [{ path: CHILD_PATH, before: "ただのメモ\n", after: content }] });
    await expect(historyPlan("V20", {}, snapshot, f.historyManager)).rejects.toThrow(expect.objectContaining({ error: expect.objectContaining({ code: "INVALID_INPUT" }) }));
  });
  it("history plans reject empty and changed files", async () => {
    const f = await runtimeFixture(), snapshot = await f.service.contextPort.snapshot();
    await expect(historyPlan("V20", {}, snapshot, f.historyManager)).rejects.toThrow();
    const before = snapshot.contents.get(CHILD_PATH)!;
    f.historyManager.push({ label: "conflict", files: [{ path: CHILD_PATH, before, after: before + "changed" }] });
    await expect(historyPlan("V20", {}, snapshot, f.historyManager)).rejects.toThrow(/一致/);
  });
  it("V22 is diagnostic-gated; V23 previews without stopping and saves only frozen logs", async () => {
    const f = await runtimeFixture(), logger = new Logger({} as App), context = { ...f.context, capabilities: ["diagnostic" as const] };
    await expect(diagnosticRequest({}, f.context, logger)).rejects.toMatchObject({ error: { code: "POLICY_DENIED" } });
    expect(await diagnosticRequest({ name: "recording" }, context, logger)).toMatchObject({ operationId: "V22", status: "applied" });
    const consoleSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    logger.info("test", "first"); const plan = diagnosticPlan({}, logger, new Date("2026-10-13T00:00:00Z")); entriesValid(plan.entries);
    expect(logger.inspectRecording().recording).toBe(true); expect(f.vault.getCreateCallCount()).toBe(0);
    expect(await executeDiagnosticPlan(plan, logger, f.vault)).toEqual({ recording: false });
    expect(await f.vault.read(f.vault.getFileByPath(plan.writes[0].path)!)).toContain("first");
    expect(diagnosticPlan({}, logger).writes).toEqual([]); consoleSpy.mockRestore();
  });
  it("diagnostic save refuses changed buffers and retains logs on failed writes", async () => {
    const f = await runtimeFixture(), logger = new Logger({} as App);
    logger.startRecording(); const old = diagnosticPlan({}, logger);
    const consoleSpy = vi.spyOn(console, "info").mockImplementation(() => undefined); logger.info("test", "new");
    await expect(executeDiagnosticPlan(old, logger, f.vault)).rejects.toMatchObject({ error: { code: "REVISION_CONFLICT" } });
    const plan = diagnosticPlan({}, logger);
    await expect(executeDiagnosticPlan(plan, logger, { ...f.vault, getFileByPath: () => null, create: async () => { throw new Error("disk"); } } as unknown as typeof f.vault)).rejects.toThrow("disk");
    expect(logger.inspectRecording().recording).toBe(true); expect(logger.inspectRecording().content).toContain("new"); consoleSpy.mockRestore();
  });
  it("saving an older diagnostic snapshot never clears a new recording started during file creation", async () => {
    const f = await runtimeFixture(), logger = new Logger({} as App);
    logger.startRecording("old"); const plan = diagnosticPlan({}, logger);
    const vault = { getFiles: f.vault.getFiles.bind(f.vault), getFileByPath: f.vault.getFileByPath.bind(f.vault), read: f.vault.read.bind(f.vault), modify: f.vault.modify.bind(f.vault), create: async (path: string, content: string) => { logger.startRecording("new"); return f.vault.create(path, content); } };
    expect(await executeDiagnosticPlan(plan, logger, vault as never)).toEqual({ recording: true });
    expect(logger.inspectRecording()).toMatchObject({ recording: true, name: "new" });
  });
});
