import { describe, it, expect, vi } from "vitest";
import { ChatSession } from "../../src/ai/chat-session";
import { ViewStateService } from "../../src/app/view-state-service";
import { catalogTools } from "../../src/agent-tools/catalog-tools";
import { validatePreviewOutcome } from "../../src/contracts/preview";
import type { Capability } from "../../src/contracts/context";
import { buildFullNote, parseTaskFile } from "../../src/core/note-format";
import { todayStr } from "../../src/core/utils";
import { contentRevision } from "../../src/app/operations/runtime";
import { runtimeFixture } from "./operation-runtime-fixture";
import { PARENT_ID } from "../contracts/fixtures";

const capabilities: Capability[] = ["read", "propose", "ui", "external", "diagnostic", "chat-control"];
describe("P3 merged operation wiring", () => {
  it("123 operations are implemented with connected ports; disconnected ports are hidden", async () => {
    let ui: ViewStateService, session: ChatSession;
    const f = await runtimeFixture({ get ui() { return ui; }, get chatSession() { return session; } });
    ui = new ViewStateService(f.service.previewPort); session = new ChatSession({}, f.service, { connected: () => true, async *stream() { yield { type: "text", text: "fixture" }; } });
    expect(f.service.describe().filter((row) => row.available)).toHaveLength(123);
    expect(f.service.describe().filter((row) => row.available && row.capabilities.every((capability) => f.context.capabilities.includes(capability)))).toHaveLength(91);
    const bare = await runtimeFixture({ ui: undefined, chatSession: undefined, logger: undefined, integration: undefined, sendExternal: undefined });
    for (const id of ["V01", "V22", "V23", "Q01", "Q04", "S08", "S21", "S35"]) expect(bare.service.describe().find((row) => row.id === id)?.available).toBe(false);
    session.dispose(); f.service.dispose(); bare.service.dispose();
  });

  it("UI/control requests dispatch, and SDK tools preserve capability/origin boundaries", async () => {
    let ui: ViewStateService, session: ChatSession;
    const f = await runtimeFixture({ get ui() { return ui; }, get chatSession() { return session; } });
    ui = new ViewStateService(f.service.previewPort);
    let text = "";
    ui.register("workbench", () => ({ viewId: "workbench", kind: "workbench", filterText: text, statusFilter: "all", showCompleted: false, tagNames: [] }), async (id, input) => {
      text = (input as { text: string }).text;
      return { schemaVersion: 1, resultKind: "request", operationId: id, status: "applied", effects: [{ kind: "view", before: null, after: text, affectedIds: ["workbench"] }] };
    });
    session = new ChatSession({}, f.service, { connected: () => true, async *stream() { yield { type: "text", text: "reply" }; } });
    const context = { ...f.context, capabilities };
    expect(await f.service.request("V07", { viewId: "workbench", text: "検索" }, context)).toMatchObject({ status: "applied" }); expect(text).toBe("検索");
    await expect(f.service.request("V14" as never, { viewId: "workbench", dayWidth: 36 } as never, context)).rejects.toMatchObject({ error: { code: "POLICY_DENIED" } });
    await expect(f.service.request("Q02", {}, f.context)).rejects.toMatchObject({ error: { code: "POLICY_DENIED" } });
    const prior = session.active.id; await f.service.request("Q02", {}, context); expect(session.active.id).not.toBe(prior);
    await f.service.request("Q01", { provider: "openai-compatible", endpoint: "http://localhost:1/v1", model: "fake", auth: "none", secretId: "" }, context);
    await f.service.request("Q04", { conversationId: session.active.id, text: "確認" }, context); expect(session.active.messages.at(-1)?.text).toBe("reply");
    const tools = catalogTools(f.service, context, ["daily", "view", "control"], () => {});
    for (const name of ["daily_propose", "operations_D01", "operations_V07", "operations_Q02", "operations_V22"]) expect(tools).toHaveProperty(name);
    expect(tools).not.toHaveProperty("operations_V14");
    const restricted = catalogTools(f.service, f.context, ["daily", "view", "control"], () => {});
    expect(restricted).not.toHaveProperty("operations_V07"); expect(restricted).not.toHaveProperty("operations_Q02"); expect(restricted).not.toHaveProperty("operations_V22");
    session.dispose(); f.service.dispose();
  });

  it.each(["T30", "S05"] as const)("%s freezes auto priorities, preserves manual values and saves service-state only after bytes", async (id) => {
    const f = await runtimeFixture(); f.settings.autoPriorityEnabled = id === "T30"; f.settings.lastAutoPriorityUpdate = "";
    const row = f.parent.subtasks!.get("review")!; row.dueDate = todayStr(); row.priority = 0;
    f.parent.priorityMode = "manual"; f.parent.priority = 2;
    await f.vault.modify(f.vault.getFileByPath(PARENT_ID)!, buildFullNote(f.parent, f.parent.subtasks)); f.vault.resetCounters();
    const preview = await f.service.propose(id, id === "T30" ? { force: true } : { autoPriorityEnabled: true }, f.context);
    expect(preview.entries.some((entry) => entry.effects.some((effect) => effect.kind === "service-state"))).toBe(true);
    expect(f.settings.lastAutoPriorityUpdate).toBe(""); expect(f.vault.getModifyCallCount()).toBe(0);
    const outcome = await f.service.humanApprovalPort.approve(preview.previewId); expect(outcome.status).toBe("success"); expect(validatePreviewOutcome(preview, outcome)).toEqual(outcome);
    const saved = parseTaskFile({ path: PARENT_ID }, f.vault.getFileContent(PARENT_ID)!, { ...f.settings, autoPriorityEnabled: false })!;
    expect(saved.priority).toBe(2); expect(saved.subtasks!.get("review")!.priority).toBe(5); expect(f.settings.lastAutoPriorityUpdate).toBe(todayStr()); f.service.dispose();
  });

  it("failed management persistence reports the saved priority without claiming the run date", async () => {
    const f = await runtimeFixture(); f.settings.lastAutoPriorityUpdate = ""; const row = f.parent.subtasks!.get("review")!; row.dueDate = todayStr(); row.priority = 0;
    await f.vault.modify(f.vault.getFileByPath(PARENT_ID)!, buildFullNote(f.parent, f.parent.subtasks));
    const preview = await f.service.propose("T30", { force: true }, f.context);
    f.persistSettings.mockRejectedValueOnce(new Error("disk"));
    const outcome = await f.service.humanApprovalPort.approve(preview.previewId);
    expect(outcome.status).toBe("partial"); expect(outcome.actualProjection?.after.serviceState?.lastAutoPriorityUpdate).toBe(""); expect(f.settings.lastAutoPriorityUpdate).toBe("");
    expect(outcome.actions.find((action) => preview.entries.find((entry) => entry.actionId === action.actionId)?.entity.kind === "integration")?.state).toBe("failed");
    expect(validatePreviewOutcome(preview, outcome)).toEqual(outcome); f.service.dispose();
  });

  it("a priority file failure leaves both the toggle and management date unsaved", async () => {
    const f = await runtimeFixture(); f.settings.autoPriorityEnabled = false; f.settings.lastAutoPriorityUpdate = "";
    f.parent.subtasks!.get("review")!.dueDate = todayStr(); await f.vault.modify(f.vault.getFileByPath(PARENT_ID)!, buildFullNote(f.parent, f.parent.subtasks));
    const preview = await f.service.propose("S05", { autoPriorityEnabled: true }, f.context);
    vi.spyOn(f.vault, "modify").mockRejectedValueOnce(new Error("disk"));
    const outcome = await f.service.humanApprovalPort.approve(preview.previewId);
    expect(outcome.status).toBe("failed"); expect(outcome.actualProjection).toBeNull(); expect(f.persistSettings).not.toHaveBeenCalled(); expect(f.settings.autoPriorityEnabled).toBe(false); expect(f.settings.lastAutoPriorityUpdate).toBe(""); f.service.dispose();
  });

  it("Daily read/query uses real hashes, bound cursors and optional items", async () => {
    const f = await runtimeFixture(); await f.vault.create("daily/2026-10-13.md", "# Daily\n\n- [ ] 確認\n"); await f.vault.create("daily/2026-10-14.md", "- [x] 完了\n");
    const input = { dateRange: { from: "2026-10-13", to: "2026-10-14" }, limit: 1, includeItems: true };
    const first = await f.service.contextPort.query("daily.get", input, f.context); if (first.status !== "success") throw new Error(first.error.code);
    expect(first.result.data.days[0].items?.[0].revision).toBe(await contentRevision("# Daily\n\n- [ ] 確認\n")); expect(first.result.data.truncated).toBe(true);
    const foreign = await f.service.contextPort.query("daily.get", { ...input, cursor: first.result.data.nextCursor! }, { ...f.context, principalId: "foreign" }); expect(foreign).toMatchObject({ status: "error", error: { code: "CURSOR_STALE" } });
    const compact = await f.service.contextPort.query("daily.get", { ...input, includeItems: false }, f.context); if (compact.status !== "success") throw new Error(compact.error.code); expect(compact.result.data.days[0]).not.toHaveProperty("items");
    const read = await f.service.read("D01", { dateRange: input.dateRange }, f.context); expect(read.data.days).toHaveLength(2); f.service.dispose();
  });

  it("Daily partial saving projects only saved file content and counts", async () => {
    const f = await runtimeFixture(); f.settings.dailyTodoSources.push({ key: "secondary", label: "別", format: "[other/]YYYY-MM-DD", creatableFromGantt: false });
    await f.vault.create("daily/2026-10-13.md", "- [ ] first\n"); await f.vault.create("other/2026-10-13.md", "- [ ] second\n");
    const read = await f.service.read("D01", { dateRange: { from: "2026-10-13", to: "2026-10-13" } }, f.context), items = read.data.days[0].items!;
    const preview = await f.service.propose("D07", { date: "2026-10-13", nextItems: items.map((item) => ({ kind: "existing" as const, path: item.path, line: item.line, itemFingerprint: item.itemFingerprint, expectedRevision: item.revision, text: item.text, completed: true })) }, f.context);
    const modify = f.vault.modify.bind(f.vault); vi.spyOn(f.vault, "modify").mockImplementation(async (file, content) => { if (file.path.startsWith("other/")) throw new Error("disk"); await modify(file, content); });
    const outcome = await f.service.humanApprovalPort.approve(preview.previewId);
    expect(outcome.status).toBe("partial"); expect(outcome.actualProjection?.after.daily).toMatchObject([{ date: "2026-10-13", totalCount: 2, completedCount: 1 }]); expect(outcome.actualProjection?.targets).toHaveLength(1); expect(validatePreviewOutcome(preview, outcome)).toEqual(outcome); f.service.dispose();
  });

  it("external send failure keeps settings committed and sends frozen bytes once", async () => {
    const f = await runtimeFixture(); f.settings.ganttSyncEnabled = true; f.settings.ganttFeatureSyncEnabled = true; f.settings.ganttSyncUrl = "https://example.test/api/snapshot";
    const preview = await f.service.propose("S20", { ganttSyncIntervalMinutes: 5 }, { ...f.context, capabilities });
    expect(f.sendExternal).not.toHaveBeenCalled(); f.sendExternal.mockRejectedValueOnce(new Error("offline"));
    const outcome = await f.service.humanApprovalPort.approve(preview.previewId);
    expect(outcome.status).toBe("partial"); expect(f.sendExternal).toHaveBeenCalledOnce(); expect(f.restartSync).toHaveBeenCalledOnce(); expect(outcome.actualProjection?.after.settings.ganttSyncIntervalMinutes).toBe(5);
    expect(outcome.actions.at(-1)?.state).toBe("failed"); expect(validatePreviewOutcome(preview, outcome)).toEqual(outcome);
    await f.service.humanApprovalPort.approve(preview.previewId); expect(f.sendExternal).toHaveBeenCalledOnce(); f.service.dispose();
  });
  it("history compensation failure publishes only files still matching the approved transition", async () => {
    const f = await runtimeFixture(), other = structuredClone(f.parent);
    other.id = "tasks/second.md"; other.file.path = other.id; other.subtasks = new Map();
    await f.vault.create(other.id, buildFullNote(other, other.subtasks));
    const changed = await f.service.propose("T27", { changes: [{ taskId: PARENT_ID, patch: { displayName: "親変更" } }, { taskId: other.id, patch: { displayName: "別変更" } }] }, f.context);
    await f.service.humanApprovalPort.approve(changed.previewId);
    const undo = await f.service.propose("V20", {}, f.context);
    let calls = 0;
    Object.assign(f.vault, { process: async (file: { path: string }, transform: (content: string) => string) => {
      if (++calls > 1) throw new Error("disk/compensation");
      const content = transform(await f.vault.read(file)); await f.vault.modify(file, content); return content;
    } });
    const outcome = await f.service.humanApprovalPort.approve(undo.previewId);
    expect(outcome.status).toBe("partial"); expect(outcome.actions.filter((action) => action.state === "committed")).toHaveLength(1); expect(outcome.actualProjection?.targets).toHaveLength(1);
    expect(f.vault.getFileContent(PARENT_ID)).not.toContain("親変更"); expect(f.vault.getFileContent(other.id)).toContain("別変更"); expect(validatePreviewOutcome(undo, outcome)).toEqual(outcome); f.service.dispose();
  });

  it("diagnostic receipt reports a new recording retained during approved file creation", async () => {
    const f = await runtimeFixture(); f.logger.startRecording("old");
    const preview = await f.service.propose("V23", {}, { ...f.context, capabilities });
    const create = f.vault.create.bind(f.vault); vi.spyOn(f.vault, "create").mockImplementation(async (path, content) => { f.logger.startRecording("new"); return create(path, content); });
    const outcome = await f.service.humanApprovalPort.approve(preview.previewId);
    expect(outcome.status).toBe("success"); expect(outcome.actions[0].actual.find((effect) => effect.kind === "diagnostic")).toMatchObject({ recording: true }); expect(f.logger.inspectRecording().name).toBe("new"); expect(validatePreviewOutcome(preview, outcome)).toEqual(outcome); f.service.dispose();
  });

  it.each(["abort", "unload"] as const)("Daily %s stops later files and returns a validated partial receipt", async (stop) => {
    const f = await runtimeFixture(); f.settings.dailyTodoSources.push({ key: "secondary", label: "別", format: "[other/]YYYY-MM-DD", creatableFromGantt: false });
    await f.vault.create("daily/2026-10-13.md", "- [ ] first\n"); await f.vault.create("other/2026-10-13.md", "- [ ] second\n");
    const read = await f.service.read("D01", { dateRange: { from: "2026-10-13", to: "2026-10-13" } }, f.context), items = read.data.days[0].items!;
    const preview = await f.service.propose("D07", { date: "2026-10-13", nextItems: items.map((item) => ({ kind: "existing" as const, path: item.path, line: item.line, itemFingerprint: item.itemFingerprint, expectedRevision: item.revision, text: item.text, completed: true })) }, f.context);
    const controller = new AbortController(), modify = f.vault.modify.bind(f.vault);
    vi.spyOn(f.vault, "modify").mockImplementation(async (file, content) => { await modify(file, content); if (stop === "abort") controller.abort(); else f.service.dispose(); });
    const outcome = stop === "abort" ? (await f.service.commit(preview.previewId, controller.signal), f.service.previewPort.inspectOutcome(preview.previewId)!) : await f.service.humanApprovalPort.approve(preview.previewId);
    expect(outcome.status).toBe("cancelled"); expect(outcome.actions.filter((action) => action.state === "committed")).toHaveLength(1); expect(outcome.actions.filter((action) => action.state === "not-attempted")).toHaveLength(1);
    expect(f.vault.getFileContent("other/2026-10-13.md")).toBe("- [ ] second\n"); expect(validatePreviewOutcome(preview, outcome)).toEqual(outcome); f.service.dispose();
  });

});
