import { describe, it, expect, vi } from "vitest";
import type { App, Vault } from "obsidian";
import type { UiPort } from "../../src/contracts/ports";
import type { OperationInputMap } from "../../src/contracts/operations";
import { OPERATION_EXAMPLES } from "../../src/agent-tools/definitions";
import { viewRequest, diagnosticRequest, diagnosticPlan, executeDiagnosticPlan, historyPlan, executeHistoryPlan, type ViewRequestId } from "../../src/app/operations/view-handlers";
import { previewEntrySchema } from "../../src/contracts/preview";
import { Logger } from "../../src/core/logger";
import { runtimeFixture } from "./operation-runtime-fixture";
import { buildFullNote } from "../../src/core/note-format";

const ui: UiPort = {
  listViews: () => [],
  inspectView: (viewId) => ({ viewId, kind: "gantt", filterText: "", statusFilter: "all", showCompleted: false, tagNames: [] }),
  request: vi.fn(async (id) => ({ schemaVersion: 1 as const, resultKind: "request" as const, operationId: id, status: "applied" as const, effects: [{ kind: "view" as const, before: null, after: { displayed: true }, affectedIds: [] }] })),
  requestApproval: async () => { throw new Error("unused"); },
};
const ids: ViewRequestId[] = ["D08", "V01", "V02", "V03", "V04", "V05", "V06", "V07", "V08", "V09", "V10", "V11", "V12", "V13", "V14", "V15", "V16", "V17", "V18", "V19"];
function entriesValid(entries: ReturnType<typeof historyPlan>["entries"]) {
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
    const f = await runtimeFixture(), file = f.vault.getFileByPath(f.parent.id)!, before = await f.vault.read(file);
    const copy = structuredClone(f.parent); copy.subtasks!.get("review")!.displayName = "変更"; copy.subtasks!.get("review")!.title = "変更";
    const historyVault = { getFileByPath: (path: string) => f.vault.getFileByPath(path), read: f.vault.read.bind(f.vault), process: async (file: { path: string }, transform: (current: string) => string) => { await f.vault.modify(file, transform(await f.vault.read(file))); } } as unknown as Vault;
    const after = buildFullNote(copy, copy.subtasks); await f.vault.modify(file, after); f.historyManager.push({ label: "rename", files: [{ path: f.parent.id, before, after }] });
    const undo = historyPlan("V20", {}, await f.service.contextPort.snapshot(), f.historyManager);
    entriesValid(undo.entries); expect(undo.writes).toEqual([{ path: f.parent.id, before: after, after: before }]); expect(await f.vault.read(file)).toBe(after);
    await executeHistoryPlan(undo, f.historyManager, historyVault); expect(await f.vault.read(file)).toBe(before);
    const redo = historyPlan("V21", {}, await f.service.contextPort.snapshot(), f.historyManager); entriesValid(redo.entries);
    await executeHistoryPlan(redo, f.historyManager, historyVault); expect(await f.vault.read(file)).toBe(after);
    await expect(executeHistoryPlan(undo, f.historyManager, historyVault)).rejects.toMatchObject({ error: { code: "REVISION_CONFLICT" } });
  });
  it("history plans reject empty, changed files and unmodeled Markdown", async () => {
    const f = await runtimeFixture(), snapshot = await f.service.contextPort.snapshot();
    expect(() => historyPlan("V20", {}, snapshot, f.historyManager)).toThrow();
    const before = snapshot.contents.get(f.parent.id)!;
    f.historyManager.push({ label: "bad", files: [{ path: f.parent.id, before: before + "\ntext", after: before }] });
    expect(() => historyPlan("V20", {}, snapshot, f.historyManager)).toThrow(/未モデル化/);
    f.historyManager.push({ label: "conflict", files: [{ path: f.parent.id, before, after: before + "changed" }] });
    expect(() => historyPlan("V20", {}, snapshot, f.historyManager)).toThrow(/一致/);
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
    expect(await executeDiagnosticPlan(plan, logger, vault)).toEqual({ recording: true });
    expect(logger.inspectRecording()).toMatchObject({ recording: true, name: "new" });
  });
});
