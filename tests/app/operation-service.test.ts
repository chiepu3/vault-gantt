import { describe, it, expect, vi, afterEach } from "vitest";
import { runtimeFixture } from "./operation-runtime-fixture";
import { IMPLEMENTED_OPERATION_IDS } from "../../src/app/operation-catalog";
import { OPERATION_CONTRACTS, operationInputSchemas, type WriteOperationId, type OperationInputMap } from "../../src/contracts/operations";
import { operationPreviewSchema, validatePreviewOutcome } from "../../src/contracts/preview";
import { INPUT_FIXTURES, CHILD_ID, PARENT_ID } from "../contracts/fixtures";
import { buildFullNote, parseTaskFile } from "../../src/core/note-format";
import { dailyItems } from "../../src/app/operations/daily-handlers";
import { contentRevision } from "../../src/app/operations/runtime";
import { buildFileRevision } from "../../src/core/utils";
afterEach(() => vi.useRealTimers());
describe("frozen catalog operation runtime", () => {
  for (const id of [...IMPLEMENTED_OPERATION_IDS].filter((id) => OPERATION_CONTRACTS[id][0] === "write") as WriteOperationId[]) {
    it(`${id}: plan is side effect free; commit passes frozen outcome contract`, async () => {
      const { service, context: baseContext, vault, settings, parent, persistSettings, logger } = await runtimeFixture();
      const context = { ...baseContext, capabilities: ["read", "propose", "ui", "external", "diagnostic", "chat-control"] as import("../../src/contracts/context").Capability[] };
      if (id === "T23") { const child = parent.subtasks!.get("review")!; child.plannedStartDate = undefined; child.plannedEndDate = undefined; await vault.modify(vault.getFileByPath(PARENT_ID)!, buildFullNote(parent, parent.subtasks)); }
      let input = structuredClone(INPUT_FIXTURES[id]) as unknown as Record<string, unknown>;
      if (["D04", "D05", "D06", "D07"].includes(id)) {
        const path = "daily/2026-10-13.md", content = "# Daily\n\n- [ ] 確認\n";
        await vault.create(path, content);
        const item = (await dailyItems(path, content, await service.contextPort.snapshot()))[0];
        const target = { path, line: item.line, expectedRevision: await contentRevision(content), itemFingerprint: item.itemFingerprint };
        input = id === "D07" ? { date: "2026-10-13", nextItems: [{ kind: "existing", ...target, text: "確認する", completed: true }, { kind: "new", text: "新規", completed: false }] } : { ...input, ...target };
      }
      if (id === "V20" || id === "V21") {
        const prior = await service.propose("T07", { taskId: CHILD_ID, name: "履歴準備" }, context); await service.humanApprovalPort.approve(prior.previewId);
        if (id === "V21") { const undo = await service.propose("V20", {}, context); await service.humanApprovalPort.approve(undo.previewId); }
        persistSettings.mockClear();
      }
      if (id === "S21") settings.ganttSyncUrl = "https://example.test/api/snapshot";
      if (id === "V23") logger.startRecording("fixture");
      vault.resetCounters(); const bytes = vault.getFileContent(PARENT_ID), beforeSettings = JSON.stringify(settings);
      const preview = await service.propose(id, operationInputSchemas[id].parse(input) as OperationInputMap[typeof id], context);
      expect(operationPreviewSchema.safeParse(preview).success).toBe(true);
      expect(vault.getCreateCallCount()).toBe(0); expect(vault.getModifyCallCount()).toBe(0); expect(vault.getFileContent(PARENT_ID)).toBe(bytes); expect(JSON.stringify(settings)).toBe(beforeSettings); expect(persistSettings).not.toHaveBeenCalled();
      const outcome = await service.humanApprovalPort.approve(preview.previewId);
      expect(outcome.status).toBe("success"); expect(validatePreviewOutcome(preview, outcome)).toEqual(outcome);
      expect(service.previewPort.inspectOutcome(preview.previewId)).toEqual(outcome);
      if (id.startsWith("T") || id.startsWith("M")) {
        const projected = outcome.actualProjection!;
        for (const actual of projected.after.parents) {
          const parsed = parseTaskFile({ path: actual.id }, vault.getFileContent(actual.id)!, settings)!;
          expect(parsed.displayName).toBe(actual.name);
          expect([...parsed.subtasks!.values()].map((child) => child.id)).toEqual(actual.children.map((child) => child.id));
          for (const child of actual.children) { const row = parsed.subtasks!.get(child.id.split("::").at(-1)!)!; expect(row.plannedStartDate || null).toBe(child.period.start); expect(row.plannedEndDate || null).toBe(child.period.end); }
        }
      }
    });
  }
  it("human approval is idempotent and consumes a plan once", async () => {
    const { service, context, vault } = await runtimeFixture();
    const preview = await service.propose("T07", { taskId: CHILD_ID, name: "改名" }, context);
    const [first, second] = await Promise.all([service.humanApprovalPort.approve(preview.previewId), service.humanApprovalPort.approve(preview.previewId)]);
    expect(first).toEqual(second); expect(vault.getModifyCallCount()).toBe(1);
    expect(await service.humanApprovalPort.approve(preview.previewId)).toEqual(first); expect(vault.getModifyCallCount()).toBe(1);
  });
  it("same stat content edits, settings changes and date changes invalidate plans", async () => {
    for (const kind of ["content", "settings", "date"]) {
      const { service, context, vault, settings } = await runtimeFixture();
      const preview = await service.propose("T07", { taskId: CHILD_ID, name: "改名" }, context);
      if (kind === "content") { const file = vault.getFileByPath(PARENT_ID)!; const stat = { ...file.stat! }; await vault.modify(file, vault.getFileContent(PARENT_ID)!.replace("レビュー", "レビュ一")); Object.assign(file.stat!, stat); }
      if (kind === "settings") settings.ganttManualHolidays.push("2026-10-13");
      if (kind === "date") { vi.useFakeTimers(); vi.setSystemTime(Date.now() + 86400000); }
      vault.resetCounters(); const outcome = await service.humanApprovalPort.approve(preview.previewId);
      expect(outcome.status).toBe("stale"); expect(outcome.actions.every((action) => action.state === "not-attempted")).toBe(true); expect(vault.getModifyCallCount()).toBe(0); vi.useRealTimers();
    }
  });
  it("guards each atomic process against a race after preflight", async () => {
    const { service, context, vault } = await runtimeFixture();
    const preview = await service.propose("T07", { taskId: CHILD_ID, name: "改名" }, context);
    const process = vi.fn(async (file, transform) => { const external = vault.getFileContent(file.path)! + "外部編集\n"; await vault.modify(file, external); transform(external); return external; });
    Object.assign(vault, { process });
    const outcome = await service.humanApprovalPort.approve(preview.previewId);
    expect(process).toHaveBeenCalledOnce(); expect(outcome.status).toBe("stale"); expect(vault.getFileContent(PARENT_ID)).toContain("外部編集");
  });
  it("one parent write combines child/parent changes and normalized dependent effects", async () => {
    const { service, context, vault } = await runtimeFixture();
    const preview = await service.propose("T27", { changes: [{ taskId: CHILD_ID, patch: { statusLabel: "done", completed: false, workloadPlan: { "2026-10-13": 1.3 } } }, { taskId: PARENT_ID, patch: { displayName: "親改名" } }] }, context);
    const workload = preview.entries[0].effects.find((effect) => effect.kind === "workload")!;
    expect(workload.kind === "workload" && workload.cells[0].after).toEqual({ date: "2026-10-13", plan: 1.5, actual: 1 });
    expect(preview.entries[0].effects[0]).toMatchObject({ kind: "fields", fields: expect.arrayContaining([{ field: "completed", before: false, after: true, reason: "normalized" }]) });
    expect(preview.projection!.after.parents[0].progress).toBe(1);
    await service.humanApprovalPort.approve(preview.previewId); expect(vault.getModifyCallCount()).toBe(1);
  });
  it("partial result includes every action and only saved target states", async () => {
    const { service, context, vault, parent } = await runtimeFixture();
    const other = structuredClone(parent); other.id = "tasks/other.md"; other.file.path = other.id; other.subtasks = new Map();
    await vault.create(other.id, buildFullNote(other, other.subtasks)); vault.resetCounters();
    const preview = await service.propose("T27", { changes: [{ taskId: CHILD_ID, patch: { displayName: "保存済み" } }, { taskId: other.id, patch: { displayName: "失敗" } }] }, context);
    const modify = vault.modify.bind(vault); vi.spyOn(vault, "modify").mockImplementation(async (file, bytes) => { if (file.path === other.id) throw new Error("IO_FAILURE"); await modify(file, bytes); });
    const outcome = await service.humanApprovalPort.approve(preview.previewId);
    expect(outcome.status).toBe("partial"); expect(outcome.actions.map((action) => action.state)).toEqual(["committed", "failed"]);
    expect(outcome.actualProjection!.targets).toEqual([{ kind: "task", taskId: CHILD_ID, parentId: PARENT_ID }]);
    expect(outcome.actualProjection!.after.parents.find((parent) => parent.id === other.id)!.name).toBe("リリース");
    const next = await service.previewPort.requestRepreview(preview.previewId); expect(next.entries).toHaveLength(1); expect(next.entries[0].entity).toEqual({ kind: "task", taskId: other.id });
  });
  it("rejects unsafe Markdown and merged inverted ranges before any writes", async () => {
    const { service, context, vault } = await runtimeFixture();
    await expect(service.propose("T19", { subtaskId: CHILD_ID, start: "2026-10-16" }, context)).rejects.toThrow("plannedStartDate");
    const file = vault.getFileByPath(PARENT_ID)!; await vault.modify(file, vault.getFileContent(PARENT_ID)!.replace("type: task", "type: task\ncustom: keep")); vault.resetCounters();
    await expect(service.propose("T07", { taskId: CHILD_ID, name: "改名" }, context)).rejects.toThrow("保全"); expect(vault.getModifyCallCount()).toBe(0);
  });
  it("ownership/capability/request-approval cannot forge an approval", async () => {
    const { service, context, vault } = await runtimeFixture();
    await expect(service.propose("T07", { taskId: CHILD_ID, name: "改名" }, { ...context, capabilities: ["read"] })).rejects.toThrow("capability");
    const preview = await service.propose("T07", { taskId: CHILD_ID, name: "改名" }, context);
    expect(() => service.inspect(preview.previewId, { ...context, principalId: "different" })).toThrow();
    expect(await service.request("Q07", { previewId: preview.previewId }, context)).toMatchObject({ status: "requested" }); expect(vault.getModifyCallCount()).toBe(0);
    await service.previewPort.reject(preview.previewId); await expect(service.humanApprovalPort.approve(preview.previewId)).rejects.toThrow("PLAN_CONSUMED");
    await expect(service.request("V07", { viewId: "missing", text: "x" }, context)).rejects.toThrow("未実装");
  });
  it("legacy six-tool inputs/results and stat revision remain compatible", async () => {
    const { service, vault } = await runtimeFixture();
    const rows = await service.invoke("search", { query: "レビュー" }); expect(Array.isArray(rows) && rows[0]).toMatchObject({ id: CHILD_ID, kind: "subtask" });
    expect(await service.invoke("get", { taskId: CHILD_ID })).toMatchObject({ id: CHILD_ID });
    const plan = await service.plan("update", { taskId: CHILD_ID, patch: { completed: true }, expectedRevision: buildFileRevision(vault.getFileByPath(PARENT_ID) as never) });
    expect(plan.operation).toBe("update"); expect(await service.commit(plan.previewId)).toMatchObject({ kind: "success", committed: 1, total: 1 });
    const created = await service.plan("create", { name: "子追加", parentTaskId: PARENT_ID }); expect((await service.commit(created.previewId)).created?.kind).toBe("subtask");
  });
  it("expiry, retained snapshots and focus never mutate live data", async () => {
    const { service, context, vault } = await runtimeFixture(); vi.useFakeTimers();
    const preview = await service.propose("T07", { taskId: CHILD_ID, name: "改名" }, context); service.previewPort.focus(preview.previewId);
    const copy = service.previewPort.inspect(preview.previewId)!; (copy as { status: string }).status = "success"; expect(service.previewPort.inspect(preview.previewId)!.status).toBe("pending");
    vi.setSystemTime(Date.now() + 600001); expect(service.previewPort.inspect(preview.previewId)!.status).toBe("expired"); expect(service.previewPort.focusedPreviewId()).toBeNull(); expect(vault.getModifyCallCount()).toBe(0);
  });
});

describe("operation meaning and lifecycle boundaries", () => {
  it("event duplicate and delete match ledger E04/E05; moving keeps map dates", async () => {
    const { service, context, settings } = await runtimeFixture();
    const duplicate = await service.propose("E04", { eventKey: "event-1" }, context);
    expect(duplicate.entries[0].effects[0]).toMatchObject({ kind: "presence", action: "duplicate" });
    await service.humanApprovalPort.approve(duplicate.previewId); expect(settings.ganttEvents).toHaveLength(2);
    expect(settings.ganttEvents[0].workloadPlan).not.toBe(settings.ganttEvents[1].workloadPlan);
    const move = await service.propose("E03", { eventKey: "event-1", date: "2026-10-16" }, context); await service.humanApprovalPort.approve(move.previewId);
    expect(settings.ganttEvents[0].workloadPlan).toEqual({ "2026-10-13": 2 });
    const remove = await service.propose("E05", { eventKey: "event-1" }, context); expect(remove.entries[0].effects[0]).toMatchObject({ kind: "presence", action: "delete" });
    await service.humanApprovalPort.approve(remove.previewId); expect(settings.ganttEvents).toHaveLength(1);
  });
  it("settings snapshot revisions are usable from the public context port", async () => {
    const { service, context } = await runtimeFixture();
    const result = await service.contextPort.query("settings.get", { sections: ["display"] }, context);
    if (result.status !== "success") throw new Error("settings read failed");
    expect(await service.propose("S03", { hideCompletedByDefault: false, expectedRevision: result.result.snapshotRevision }, context)).toMatchObject({ status: "pending" });
  });
  it("stored priorities stay distinct from effective priorities and unrelated children are preserved", async () => {
    const { service, context, vault, parent, child, settings } = await runtimeFixture();
    parent.subtasks!.get("review")!.dueDate = "2001-01-01";
    parent.subtasks!.get("review")!.priority = 0;
    const other = { ...structuredClone(child), id: PARENT_ID + "::other", key: "other", dueDate: "2001-01-01", priority: 0 };
    parent.subtasks!.set("other", other);
    await vault.modify(vault.getFileByPath(PARENT_ID)!, buildFullNote(parent, parent.subtasks)); vault.resetCounters();
    const read = await service.contextPort.query("tasks.get-many", { taskIds: [CHILD_ID], include: ["priority"] }, context);
    expect(read).toMatchObject({ status: "success", result: { data: { items: [expect.objectContaining({ priority: { stored: 0, effective: 5, mode: "auto" } })] } } });
    const preview = await service.propose("T29", { taskId: CHILD_ID, patch: { currentStatus: "確認中" } }, context); await service.humanApprovalPort.approve(preview.previewId);
    const stored = parseTaskFile({ path: PARENT_ID }, vault.getFileContent(PARENT_ID)!, { ...settings, autoPriorityEnabled: false })!;
    expect(stored.subtasks!.get("review")!.priority).toBe(5); expect(stored.subtasks!.get("other")!.priority).toBe(0);
  });
  it("cancelled saving publishes all actions and only committed actual projection", async () => {
    const { service, context, vault, parent } = await runtimeFixture();
    const other = structuredClone(parent); other.id = "tasks/second.md"; other.file.path = other.id; other.subtasks = new Map(); await vault.create(other.id, buildFullNote(other, other.subtasks)); vault.resetCounters();
    const preview = await service.propose("T27", { changes: [{ taskId: CHILD_ID, patch: { displayName: "保存" } }, { taskId: other.id, patch: { displayName: "未保存" } }] }, context);
    const controller = new AbortController(), modify = vault.modify.bind(vault);
    vi.spyOn(vault, "modify").mockImplementation(async (file, bytes) => { await modify(file, bytes); controller.abort(); });
    const result = await service.commit(preview.previewId, controller.signal); expect(result.kind).toBe("cancelled");
    const outcome = service.previewPort.inspectOutcome(preview.previewId)!; expect(outcome.actions.map((action) => action.state)).toEqual(["committed", "not-attempted"]); expect(validatePreviewOutcome(preview, outcome)).toEqual(outcome);
  });
  it("pending invalidation is observable, ownership stays unchanged and repreview has a fresh ID", async () => {
    const { service, context, vault, parent } = await runtimeFixture();
    const preview = await service.propose("T07", { taskId: CHILD_ID, name: "改名" }, context), listener = vi.fn();
    service.previewPort.subscribe(listener); service.previewPort.focus(preview.previewId);
    const file = vault.getFileByPath(PARENT_ID)!; parent.subtasks!.get("review")!.displayName = "外部改名"; parent.subtasks!.get("review")!.title = "外部改名";
    await vault.modify(file, buildFullNote(parent, parent.subtasks));
    await service.invalidatePreviews(); expect(service.previewPort.inspect(preview.previewId)!.status).toBe("stale"); expect(service.previewPort.focusedPreviewId()).toBeNull(); expect(listener).toHaveBeenCalled();
    const fresh = await service.request("Q08", { previewId: preview.previewId }, context); expect(fresh.previewId).not.toBe(preview.previewId); expect(fresh.origin).toEqual(context.origin);
  });
  it("retains at most 50 pending plans and unload prevents saving queued work", async () => {
    const { service, context, vault } = await runtimeFixture();
    const first = await service.propose("T07", { taskId: CHILD_ID, name: "1" }, context);
    for (let index = 0; index < 50; index++) await service.propose("T07", { taskId: CHILD_ID, name: String(index + 2) }, context);
    expect(service.previewPort.inspect(first.previewId)!.status).toBe("expired"); expect(service.previewPort.list().filter((preview) => preview.status === "pending")).toHaveLength(50);
    const last = service.previewPort.list().at(-1)!; service.dispose(); await expect(service.humanApprovalPort.approve(last.previewId)).rejects.toThrow(); expect(vault.getModifyCallCount()).toBe(0);
  });
});

it("explicit intent retries reuse previews and receipts without duplicate writes", async () => {
  const { service, context, vault } = await runtimeFixture();
  const replayContext = { ...context, callerIntentId: "same-intent" };
  const first = await service.propose("T07", { taskId: CHILD_ID, name: "改名" }, replayContext);
  expect((await service.propose("T07", { taskId: CHILD_ID, name: "改名" }, { ...replayContext, requestId: "retry" })).previewId).toBe(first.previewId);
  await service.humanApprovalPort.approve(first.previewId);
  expect((await service.propose("T07", { taskId: CHILD_ID, name: "改名" }, replayContext)).status).toBe("success"); expect(vault.getModifyCallCount()).toBe(1);
  await expect(service.propose("T07", { taskId: CHILD_ID, name: "別の操作" }, replayContext)).rejects.toThrow("callerIntentId");
});

it("HistoryPort publishes live conflict/barrier eligibility for each outcome entry", async () => {
  const { service, context, vault, historyManager } = await runtimeFixture();
  historyManager.attachVault(() => vault);
  const listener = vi.fn(); historyManager.subscribe(listener);
  const preview = await service.propose("T07", { taskId: CHILD_ID, name: "改名" }, context); const outcome = await service.humanApprovalPort.approve(preview.previewId);
  await historyManager.refreshEligibility(); expect(historyManager.inspectUndo(outcome.undoEntryId!).state).toBe("available");
  await vault.modify(vault.getFileByPath(PARENT_ID)!, vault.getFileContent(PARENT_ID)! + "外部編集\n"); await historyManager.refreshEligibility();
  expect(historyManager.inspectUndo(outcome.undoEntryId!).state).toBe("conflict"); expect(listener).toHaveBeenCalled();
  historyManager.clear(); expect(historyManager.inspectUndo(outcome.undoEntryId!).state).toBe("missing");
});
