import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { WorkspaceLeaf } from "obsidian";
import { startMcpServer, DEFAULT_MCP_SETTINGS } from "../../src/mcp/server";
import { ApprovalView } from "../../src/ui/approval-view";
import { ViewStateService } from "../../src/app/view-state-service";
import { project } from "../../src/app/preview-projector";
import { operationPreviewSchema, validatePreviewOutcome, type PreviewEventV1, type PreviewEntry } from "../../src/contracts/preview";
import { createFakeDocument, byTag, deepText, dispatch, type FakeEl } from "../stubs/fake-dom";
import { ChatSession } from "../../src/ai/chat-session";
import type { Capability } from "../../src/contracts/context";
import { runtimeFixture } from "./operation-runtime-fixture";
import { CHILD_ID, PARENT_ID } from "../contracts/fixtures";

afterEach(() => vi.unstubAllGlobals());

describe("P3 real runtime and transport integration", () => {
  it("proposes over loopback HTTP, saves only through an approval card, and revokes pending previews on token rotation", async () => {
    vi.stubGlobal("document", createFakeDocument());
    const { service, vault, historyManager } = await runtimeFixture();
    const events: PreviewEventV1[] = [];
    service.previewPort.subscribeEvents((event) => events.push(event));
    const handle = await startMcpServer({ operations: service, previews: service.previewPort, context: service.contextPort, history: historyManager,
      vaultInstanceId: service.vaultInstanceId, principal: { id: "mcp-integration", label: "Integration client" }, isDesktop: true }, { ...DEFAULT_MCP_SETTINGS, enabled: true, port: 0 });
    const client = new Client({ name: "p3-integration", version: "1" });
    const view = new ApprovalView({} as WorkspaceLeaf, { operationService: service, previewPort: service.previewPort, projectionDetailPort: service.previewPort,
      humanApprovalPort: service.humanApprovalPort, historyPort: historyManager, uiPort: new ViewStateService(service.previewPort) });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(handle.endpoint!), { requestInit: { headers: { Authorization: `Bearer ${handle.sessionToken}` } } }));
      const response = await client.callTool({ name: "operations.T07.propose", arguments: { callerIntentId: "rename", input: { taskId: CHILD_ID, name: "承認後の名前" } } });
      expect(response.isError).not.toBe(true);
      const preview = service.previewPort.list()[0];
      expect(preview.origin.kind).toBe("mcp"); expect(preview.operationLabel).toBeTruthy(); expect(vault.getModifyCallCount()).toBe(0);
      await view.onOpen();
      expect(deepText(view.containerEl as unknown as FakeEl)).toContain("承認待ち 1件");
      const approve = byTag(view.containerEl as unknown as FakeEl, "button").find((button) => button.dataset.action === "approve")!;
      dispatch(approve, "click");
      await vi.waitFor(() => expect(service.previewPort.inspectOutcome(preview.previewId)?.status).toBe("success"));
      expect(vault.getFileContent(PARENT_ID)).toContain("承認後の名前"); expect(vault.getModifyCallCount()).toBe(1);
      expect(events.filter((event) => event.kind === "approved")).toHaveLength(1);
      const status = await client.callTool({ name: "previews.status", arguments: { previewId: preview.previewId } });
      expect(JSON.stringify(status.structuredContent)).toContain("committed");
      expect(JSON.stringify(status.structuredContent)).toContain(events[0].eventId);
      const context = { ...service.legacyContext(), principalId: "mcp-integration" };
      expect(service.inspectOutcome(preview.previewId, context)?.status).toBe("success");
      await client.callTool({ name: "operations.T07.propose", arguments: { callerIntentId: "pending", input: { taskId: CHILD_ID, name: "保存しない名前" } } });
      const pending = service.previewPort.list().find((item) => item.status === "pending")!;
      const oldToken = handle.sessionToken;
      await handle.regenerateToken();
      expect(service.previewPort.inspect(pending.previewId)?.status).toBe("revoked");
      expect(service.previewPort.inspect(preview.previewId)?.status).toBe("success"); expect(vault.getModifyCallCount()).toBe(1);
      expect(events.some((event) => event.kind === "revoked" && event.previewId === pending.previewId)).toBe(true);
      expect((await fetch(handle.endpoint!, { headers: { Authorization: `Bearer ${oldToken}` } })).status).toBe(401);
    } finally { await view.onClose(); await client.close(); await handle.stop(); service.dispose(); }
  }, 15000);

  it("HTTP dispatches merged Daily, view, control, diagnostics, priority and external operations through real runtime", async () => {
    let ui: ViewStateService, session: ChatSession;
    const f = await runtimeFixture({ get ui() { return ui; }, get chatSession() { return session; } });
    session = new ChatSession({}, f.service, { connected: () => true, async *stream() { yield { type: "text", text: "reply" }; } });
    let filterText = "";
    ui = new ViewStateService(f.service.previewPort);
    ui.register("workbench", () => ({ viewId: "workbench", kind: "workbench", filterText, statusFilter: "all", showCompleted: true, tagNames: [] }), async (id, input) => { filterText = (input as { text: string }).text; return { schemaVersion: 1, resultKind: "request", operationId: id, status: "applied", effects: [{ kind: "view", before: null, after: filterText, affectedIds: ["workbench"] }] }; });
    f.settings.ganttSyncUrl = "https://example.test/api/snapshot";
    const capabilities: Capability[] = ["read", "propose", "ui", "external", "diagnostic", "chat-control"];
    const handle = await startMcpServer({ operations: f.service, previews: f.service.previewPort, context: f.service.contextPort, history: f.historyManager,
      vaultInstanceId: f.service.vaultInstanceId, principal: { id: "mcp-wiring", label: "wiring", capabilities }, isDesktop: true }, { ...DEFAULT_MCP_SETTINGS, enabled: true, port: 0 });
    const client = new Client({ name: "p3-wiring", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(handle.endpoint!), { requestInit: { headers: { Authorization: `Bearer ${handle.sessionToken}` } } }));
      const call = async (name: string, input: unknown) => { const result = await client.callTool({ name, arguments: name.endsWith(".propose") ? { input, callerIntentId: name } : input as Record<string, unknown> }); expect(result.isError, name).not.toBe(true); return result; };
      await call("operations.V07.request", { viewId: "workbench", text: "HTTP filter" }); expect(filterText).toBe("HTTP filter");
      const oldConversation = session.active.id; await call("operations.Q02.request", {}); expect(session.active.id).not.toBe(oldConversation);
      await call("operations.V22.request", { name: "http" }); expect(f.logger.inspectRecording().recording).toBe(true);
      for (const [id, input] of [["D03", { date: "2026-10-13", text: "HTTP Daily" }], ["S05", { autoPriorityEnabled: true }], ["T30", { force: true }], ["V23", {}], ["S21", {}]] as const) {
        const response = await call(`operations.${id}.propose`, input);
        const data = response.structuredContent as { data: { previewId: string } };
        const preview = f.service.previewPort.inspect(data.data.previewId)!; expect(preview.status).toBe("pending");
        const outcome = await f.service.humanApprovalPort.approve(preview.previewId); expect(outcome.status, id).toBe("success"); expect(validatePreviewOutcome(preview, outcome)).toEqual(outcome);
      }
      await call("operations.D01.read", { dateRange: { from: "2026-10-13", to: "2026-10-13" } });
      expect(f.vault.getFileContent("daily/2026-10-13.md")).toContain("HTTP Daily"); expect(f.sendExternal).toHaveBeenCalledOnce();
      const tools = await client.listTools(); expect(tools.tools.some((tool) => tool.name.startsWith("operations.V14"))).toBe(false);
    } finally { await client.close(); await handle.stop(); session.dispose(); f.service.dispose(); }
  }, 15000);

  it("authorizes receipt inspection by read capability, Vault, principal and request cancellation", async () => {
    const { service, context } = await runtimeFixture();
    const preview = await service.propose("T07", { taskId: CHILD_ID, name: "認可済み" }, context);
    expect(service.inspectOutcome(preview.previewId, context)).toBeUndefined();
    await service.humanApprovalPort.approve(preview.previewId);
    for (const invalid of [{ ...context, capabilities: [] }, { ...context, vaultInstanceId: "another" }, { ...context, principalId: "another" }, { ...context, signal: AbortSignal.abort() }]) {
      expect(() => service.inspectOutcome(preview.previewId, invalid)).toThrow(expect.objectContaining({ error: expect.objectContaining({ code: "POLICY_DENIED" }) }));
    }
    const receipt = service.inspectOutcome(preview.previewId, context)!;
    expect(validatePreviewOutcome(preview, receipt)).toEqual(receipt);
    service.dispose(); expect(() => service.inspectOutcome(preview.previewId, context)).toThrow();
  });

  it("pages event/weekly identities with edit revisions and rejects cross-principal/stale cursors", async () => {
    const { service, settings, context } = await runtimeFixture();
    settings.ganttEvents.push({ key: "event-2", title: "二件目", date: "2026-10-14" });
    const first = await service.contextPort.query("events.get", { limit: 1 }, context);
    if (first.status !== "success") throw new Error(first.error.code);
    expect(first.result.data.items[0]).toMatchObject({ key: "event-1", title: "イベント", date: "2026-10-13", revision: expect.any(String) });
    expect(first.result.data.truncated).toBe(true);
    const cursor = first.result.data.nextCursor!;
    expect((await service.contextPort.query("events.get", { limit: 1, cursor }, { ...context, principalId: "other" })).status).toBe("error");
    const second = await service.contextPort.query("events.get", { limit: 1, cursor }, context);
    if (second.status !== "success") throw new Error(second.error.code);
    expect(second.result.data.items[0].key).toBe("event-2");
    settings.ganttEvents[1].title = "外部編集";
    expect((await service.contextPort.query("events.get", { limit: 1, cursor }, context)).status).toBe("error");
    const weekly = await service.contextPort.query("weekly.get", { daysOfWeek: [2] }, context);
    if (weekly.status !== "success") throw new Error(weekly.error.code);
    expect(weekly.result.data.items[0]).toMatchObject({ key: "weekly-1", title: "定例", dayOfWeek: 2, minutesPerWeek: 60, revision: expect.any(String) });
    service.dispose();
  });

  it("repreview gets a new intent even when the original MCP proposal had callerIntentId", async () => {
    const { service, context } = await runtimeFixture();
    const preview = await service.propose("T07", { taskId: CHILD_ID, name: "再提案" }, { ...context, callerIntentId: "original-intent" });
    await service.previewPort.invalidate(preview.previewId, "revoked");
    const refreshed = await service.previewPort.requestRepreview(preview.previewId);
    expect(refreshed.previewId).not.toBe(preview.previewId); expect(refreshed.status).toBe("pending"); service.dispose();
  });

  it("validates service-owned save effects independently and rejects unsaved management values", async () => {
    const { service } = await runtimeFixture(), snapshot = await service.contextPort.snapshot();
    const entries: PreviewEntry[] = [{ actionId: "management:0", entity: { kind: "integration", targetId: "priority-service" }, displayName: "優先度の最終計算日", effects: [{ kind: "service-state", fields: [{ field: "lastAutoPriorityUpdate", before: snapshot.settings.lastAutoPriorityUpdate, after: snapshot.today, reason: "derived" }] }] }];
    const afterSettings = { ...snapshot.settings, lastAutoPriorityUpdate: snapshot.today };
    const preview = operationPreviewSchema.parse({ ...await service.propose("T07", { taskId: CHILD_ID, name: "仮" }, service.legacyContext()), previewId: "management", operationId: "T30", entries, summary: { targetCount: 1, actionCount: 1 }, projection: project(snapshot, snapshot.parents, afterSettings, entries) });
    const outcome = { previewId: preview.previewId, status: "success", actions: [{ actionId: entries[0].actionId, state: "committed", actual: entries[0].effects }], actualProjection: preview.projection };
    expect(() => validatePreviewOutcome(preview, outcome)).not.toThrow();
    const corrupted = structuredClone(outcome); corrupted.actualProjection!.after.serviceState = { ...corrupted.actualProjection!.after.serviceState, lastAutoPriorityUpdate: "wrong" };
    expect(() => validatePreviewOutcome(preview, corrupted)).toThrow(); service.dispose();
  });
});
