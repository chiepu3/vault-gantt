import { describe, it, expect, vi, afterEach } from "vitest";
import { runtimeFixture } from "./operation-runtime-fixture";
import { IMPLEMENTED_OPERATION_IDS } from "../../src/app/operation-catalog";
import { OPERATION_CONTRACTS, operationInputSchemas, type WriteOperationId, type OperationInputMap } from "../../src/contracts/operations";
import { operationPreviewSchema, validatePreviewOutcome } from "../../src/contracts/preview";
import { INPUT_FIXTURES, CHILD_ID, PARENT_ID, PARENT_PATH, CHILD_PATH } from "../contracts/fixtures";
import { loadNoteTasks } from "../../src/app/note-store";
import { newNoteText } from "../../src/app/task-operations";
import { dailyItems } from "../../src/app/operations/daily-handlers";
import { contentRevision } from "../../src/app/operations/runtime";
import { buildFileRevision } from "../../src/core/utils";
afterEach(() => vi.useRealTimers());
describe("frozen catalog operation runtime", () => {
  for (const id of [...IMPLEMENTED_OPERATION_IDS].filter((id) => OPERATION_CONTRACTS[id][0] === "write") as WriteOperationId[]) {
    it(`${id}: plan is side effect free; commit passes frozen outcome contract`, async () => {
      const { service, context: baseContext, vault, settings, parent, persistSettings, logger } = await runtimeFixture();
      const context = { ...baseContext, capabilities: ["read", "propose", "ui", "external", "diagnostic", "chat-control"] as import("../../src/contracts/context").Capability[] };
      if (id === "T23") { const child = parent.subtasks!.get(CHILD_ID)!; child.plannedStartDate = undefined; child.plannedEndDate = undefined; await vault.modify(vault.getFileById(CHILD_ID)!, newNoteText(vault, child, parent)); }
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
      vault.resetCounters(); const bytes = vault.snapshot(), beforeSettings = JSON.stringify(settings);
      const preview = await service.propose(id, operationInputSchemas[id].parse(input) as OperationInputMap[typeof id], context);
      expect(operationPreviewSchema.safeParse(preview).success).toBe(true);
      expect(vault.getCreateCallCount()).toBe(0); expect(vault.getModifyCallCount()).toBe(0); expect(vault.snapshot()).toEqual(bytes); expect(JSON.stringify(settings)).toBe(beforeSettings); expect(persistSettings).not.toHaveBeenCalled();
      const outcome = await service.humanApprovalPort.approve(preview.previewId);
      expect(outcome.status).toBe("success"); expect(validatePreviewOutcome(preview, outcome)).toEqual(outcome);
      expect(service.previewPort.inspectOutcome(preview.previewId)).toEqual(outcome);
      if (id.startsWith("T") || id.startsWith("M")) {
        const projected = outcome.actualProjection!;
        const saved = await loadNoteTasks(vault, settings, new Map());
        for (const actual of projected.after.parents) {
          const parsed = saved.find((row) => row.id === actual.id)!;
          expect(parsed.displayName).toBe(actual.name);
          expect([...parsed.subtasks!.values()].map((child) => child.id)).toEqual(actual.children.map((child) => child.id));
          for (const child of actual.children) { const row = parsed.subtasks!.get(child.id)!; expect(row.plannedStartDate || null).toBe(child.period.start); expect(row.plannedEndDate || null).toBe(child.period.end); }
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
      if (kind === "content") { const file = vault.getFileById(CHILD_ID)!; const stat = { ...file.stat! }; await vault.modify(file, vault.getFileContentById(CHILD_ID)!.replace("レビュー", "レビュ一")); Object.assign(file.stat!, stat); }
      if (kind === "settings") settings.ganttManualHolidays.push("2026-10-13");
      if (kind === "date") { vi.useFakeTimers(); vi.setSystemTime(Date.now() + 86400000); }
      vault.resetCounters(); const outcome = await service.humanApprovalPort.approve(preview.previewId);
      expect(outcome.status).toBe("stale"); expect(outcome.actions.every((action) => action.state === "not-attempted")).toBe(true); expect(vault.getModifyCallCount()).toBe(0); vi.useRealTimers();
    }
  });
  it("several E01 previews on the same date stay applicable one after another under their own ids", async () => {
    const { service, context, settings } = await runtimeFixture();
    const first = await service.propose("E01", operationInputSchemas.E01.parse({ title: "会議A", date: "2026-10-14" }), context);
    const second = await service.propose("E01", operationInputSchemas.E01.parse({ title: "会議B", date: "2026-10-14" }), context);
    expect(first.previewId).not.toBe(second.previewId);
    const a = first.entries[0].entity, b = second.entries[0].entity;
    expect(a.kind === "event" && b.kind === "event" && a.eventKey !== b.eventKey).toBe(true);
    expect((await service.humanApprovalPort.approve(first.previewId)).status).toBe("success");
    await service.invalidatePreviews();
    expect(service.previewPort.inspect(second.previewId)!.status).toBe("pending");
    const outcome = await service.humanApprovalPort.approve(second.previewId);
    expect(outcome.status).toBe("success"); expect(service.previewPort.inspect(second.previewId)!.status).toBe("success");
    const added = settings.ganttEvents.filter((event) => ["会議A", "会議B"].includes(event.title));
    expect(added).toHaveLength(2); expect(new Set(settings.ganttEvents.map((event) => event.key)).size).toBe(settings.ganttEvents.length);
  });
  it("a preview rebases when its sibling was applied before it is even looked at again", async () => {
    const { service, context, settings } = await runtimeFixture();
    const first = await service.propose("E01", operationInputSchemas.E01.parse({ title: "会議A", date: "2026-10-14" }), context);
    const second = await service.propose("E01", operationInputSchemas.E01.parse({ title: "会議B", date: "2026-10-14" }), context);
    await service.humanApprovalPort.approve(first.previewId);
    expect((await service.humanApprovalPort.approve(second.previewId)).status).toBe("success");
    expect(settings.ganttEvents.map((event) => event.title)).toEqual(expect.arrayContaining(["会議A", "会議B"]));
  });
  it("a sibling that changes the same thing still makes the preview stale", async () => {
    for (const invalidateFirst of [true, false]) {
      const { service, context, settings } = await runtimeFixture();
      const first = await service.propose("E02", { eventKey: "event-1", title: "改名A" }, context);
      const second = await service.propose("E02", { eventKey: "event-1", title: "改名B" }, context);
      await service.humanApprovalPort.approve(first.previewId);
      if (invalidateFirst) { await service.invalidatePreviews(); expect(service.previewPort.inspect(second.previewId)!.status).toBe("stale"); }
      else expect((await service.humanApprovalPort.approve(second.previewId)).status).toBe("stale");
      expect(settings.ganttEvents[0].title).toBe("改名A");
    }
  });
  it("an edit made between preflight and write is never overwritten", async () => {
    for (const injectAt of [1, 2, 3, 4]) {
      const { service, context, vault } = await runtimeFixture();
      const preview = await service.propose("T07", { taskId: CHILD_ID, name: "改名" }, context);
      const read = vault.read.bind(vault); let count = 0, injected = false;
      vi.spyOn(vault, "read").mockImplementation(async (file) => {
        const text = await read(file);
        if (file.path !== CHILD_PATH || ++count !== injectAt) return text;
        injected = true; await vault.modify(file, vault.getFileContentById(CHILD_ID)! + "外部編集\n"); return text;
      });
      const outcome = await service.humanApprovalPort.approve(preview.previewId);
      if (!injected) continue;
      expect(vault.getFileContentById(CHILD_ID), `injectAt ${injectAt} ${outcome.status}`).toContain("外部編集");
      if (outcome.status === "success") expect(vault.getFileContentById(CHILD_ID)).toContain("改名");
    }
  });
  it("child and parent changes are written to their own notes with normalized dependent effects", async () => {
    const { service, context, vault } = await runtimeFixture();
    const preview = await service.propose("T27", { changes: [{ taskId: CHILD_ID, patch: { statusLabel: "done", completed: false, workloadPlan: { "2026-10-13": 1.3 } } }, { taskId: PARENT_ID, patch: { displayName: "親改名" } }] }, context);
    const workload = preview.entries[0].effects.find((effect) => effect.kind === "workload")!;
    expect(workload.kind === "workload" && workload.cells[0].after).toEqual({ date: "2026-10-13", plan: 1.5, actual: 1 });
    expect(preview.entries[0].effects[0]).toMatchObject({ kind: "fields", fields: expect.arrayContaining([{ field: "completed", before: false, after: true, reason: "normalized" }]) });
    expect(preview.projection!.after.parents[0].progress).toBe(1);
    await service.humanApprovalPort.approve(preview.previewId); expect(vault.getModifyCallCount()).toBe(2);
  });
  it("partial result includes every action and only saved target states", async () => {
    const { service, context, vault, parent } = await runtimeFixture();
    const other = structuredClone(parent); other.id = "t-other1"; other.file.path = "tasks/ン他.md"; other.subtasks = new Map();
    await vault.create(other.file.path, newNoteText(vault, other)); vault.resetCounters();
    const preview = await service.propose("T27", { changes: [{ taskId: CHILD_ID, patch: { displayName: "保存済み" } }, { taskId: other.id, patch: { displayName: "失敗" } }] }, context);
    const modify = vault.modify.bind(vault); vi.spyOn(vault, "modify").mockImplementation(async (file, bytes) => { if (file.path === other.file.path) throw new Error("IO_FAILURE"); await modify(file, bytes); });
    const outcome = await service.humanApprovalPort.approve(preview.previewId);
    expect(outcome.status).toBe("partial"); expect(outcome.actions.map((action) => action.state)).toEqual(["committed", "failed"]);
    expect(outcome.actualProjection!.targets).toEqual([{ kind: "task", taskId: CHILD_ID, parentId: PARENT_ID }]);
    expect(outcome.actualProjection!.after.parents.find((parent) => parent.id === other.id)!.name).toBe("リリース");
    const next = await service.previewPort.requestRepreview(preview.previewId); expect(next.entries).toHaveLength(1); expect(next.entries[0].entity).toEqual({ kind: "task", taskId: other.id });
  });
  it("rejects unsafe Markdown and merged inverted ranges before any writes", async () => {
    const { service, context, vault } = await runtimeFixture();
    await expect(service.propose("T19", { subtaskId: CHILD_ID, start: "2026-10-16" }, context)).rejects.toThrow("plannedStartDate");
    const file = vault.getFileById(CHILD_ID)!;
    await vault.modify(file, vault.getFileContentById(CHILD_ID)! + "\n#### 参考資料\n保持する本文\n"); vault.resetCounters();
    const preview = await service.propose("T07", { taskId: CHILD_ID, name: "改名" }, context); await service.humanApprovalPort.approve(preview.previewId);
    expect(vault.getFileContentById(CHILD_ID)).toContain("#### 参考資料\n保持する本文\n");
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
    const plan = await service.plan("update", { taskId: CHILD_ID, patch: { completed: true }, expectedRevision: buildFileRevision(vault.getFileById(CHILD_ID) as never) });
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
  it("E01 registers plan/actual hours in one preview and stores them on the event", async () => {
    const { service, context, settings } = await runtimeFixture();
    const input = operationInputSchemas.E01.parse({ title: "会議", date: "2026-10-14", plan: { "2026-10-14": 2 }, actual: { "2026-10-14": 1.5 } });
    const preview = await service.propose("E01", input, context);
    expect(preview.entries[0].effects.map((effect) => effect.kind)).toEqual(["presence", "workload"]);
    expect(preview.entries[0].effects[1]).toMatchObject({ kind: "workload", cells: [{ date: "2026-10-14", after: { plan: 2, actual: 1.5 } }] });
    await service.humanApprovalPort.approve(preview.previewId);
    const created = settings.ganttEvents.find((event) => event.title === "会議")!;
    expect(created.workloadPlan).toEqual({ "2026-10-14": 2 });
    expect(created.workloadActual).toEqual({ "2026-10-14": 1.5 });
    const plain = await service.propose("E01", operationInputSchemas.E01.parse({ title: "時間なし", date: "2026-10-14" }), context);
    expect(plain.entries[0].effects.map((effect) => effect.kind)).toEqual(["presence"]);
  });
  it("E01 rejects malformed plan/actual maps", () => {
    const base = { title: "会議", date: "2026-10-14" };
    expect(operationInputSchemas.E01.safeParse({ ...base, plan: { "2026-10-14": -1 } }).success).toBe(false);
    expect(operationInputSchemas.E01.safeParse({ ...base, actual: { "2026-10-14": 25 } }).success).toBe(false);
    expect(operationInputSchemas.E01.safeParse({ ...base, plan: { tomorrow: 1 } }).success).toBe(false);
    expect(operationInputSchemas.E01.safeParse({ ...base, plan: [1] }).success).toBe(false);
    expect(operationInputSchemas.E01.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
  it("settings snapshot revisions are usable from the public context port", async () => {
    const { service, context } = await runtimeFixture();
    const result = await service.contextPort.query("settings.get", { sections: ["display"] }, context);
    if (result.status !== "success") throw new Error("settings read failed");
    expect(await service.propose("S03", { hideCompletedByDefault: false, expectedRevision: result.result.snapshotRevision }, context)).toMatchObject({ status: "pending" });
  });
  it("auto priority is shown but never stored; unrelated children are preserved", async () => {
    const { service, context, vault, parent, child, settings } = await runtimeFixture();
    child.dueDate = "2001-01-01"; child.priority = 0;
    const other = { ...structuredClone(child), id: "s-other1", key: "s-other1", title: "別", displayName: "別", file: { path: "tasks/リリース/別.md", parentPath: parent.file.path } as typeof child.file };
    parent.subtasks!.set(other.id, other);
    await vault.modify(vault.getFileById(CHILD_ID)!, newNoteText(vault, child, parent)); await vault.create(other.file.path, newNoteText(vault, other, parent)); vault.resetCounters();
    const read = await service.contextPort.query("tasks.get-many", { taskIds: [CHILD_ID], include: ["priority"] }, context);
    expect(read).toMatchObject({ status: "success", result: { data: { items: [expect.objectContaining({ priority: { stored: 0, effective: 5, mode: "auto" } })] } } });
    const before = vault.getFileContent(other.file.path);
    const preview = await service.propose("T29", { taskId: CHILD_ID, patch: { currentStatus: "確認中" } }, context); await service.humanApprovalPort.approve(preview.previewId);
    expect(vault.getFileContentById(CHILD_ID)).not.toMatch(/^priority:/m); expect(vault.getFileContentById(CHILD_ID)).toContain("確認中");
    expect(vault.getFileContent(other.file.path)).toBe(before);
    const stored = (await loadNoteTasks(vault, { ...settings, autoPriorityEnabled: false }, new Map())).find((row) => row.id === PARENT_ID)!;
    expect(stored.subtasks!.get(CHILD_ID)!.priority).toBe(0);
  });
  it("cancelled saving publishes all actions and only committed actual projection", async () => {
    const { service, context, vault, parent } = await runtimeFixture();
    const other = structuredClone(parent); other.id = "t-second"; other.file.path = "tasks/ンの二.md"; other.subtasks = new Map(); await vault.create(other.file.path, newNoteText(vault, other)); vault.resetCounters();
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
    const file = vault.getFileById(CHILD_ID)!; const child = parent.subtasks!.get(CHILD_ID)!; child.displayName = "外部改名"; child.title = "外部改名";
    await vault.modify(file, newNoteText(vault, child, parent));
    await service.invalidatePreviews(); expect(service.previewPort.inspect(preview.previewId)!.status).toBe("stale"); expect(service.previewPort.focusedPreviewId()).toBeNull(); expect(listener).toHaveBeenCalled();
    const fresh = await service.request("Q08", { previewId: preview.previewId }, context); expect(fresh.previewId).not.toBe(preview.previewId); expect(fresh.origin).toEqual(context.origin);
    // The stale card is used up: a second re-preview from it creates nothing new.
    expect(service.previewPort.supersededBy(preview.previewId)).toBe(fresh.previewId);
    const count = service.previewPort.list().length;
    await expect(service.request("Q08", { previewId: preview.previewId }, context)).rejects.toThrow(); expect(service.previewPort.list()).toHaveLength(count);
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
  await vault.modify(vault.getFileById(CHILD_ID)!, vault.getFileContentById(CHILD_ID)! + "外部編集\n"); await historyManager.refreshEligibility();
  expect(historyManager.inspectUndo(outcome.undoEntryId!).state).toBe("conflict"); expect(listener).toHaveBeenCalled();
  historyManager.clear(); expect(historyManager.inspectUndo(outcome.undoEntryId!).state).toBe("missing");
});


describe("preserving AI writers", () => {
  const ids = [...IMPLEMENTED_OPERATION_IDS].filter((id) => OPERATION_CONTRACTS[id][0] === "write" && (id.startsWith("T") || id.startsWith("M") || id === "S05" || id === "S27") && !["T03", "T05"].includes(id)) as WriteOperationId[];
  const withExtras = (text: string) => text.replace("type:", "custom: keep\ntype:") + "\n## 参考資料\n保持する本文\n";
  for (const id of ids) it(`${id} preserves custom YAML and Markdown; preview matches saved tasks`, async () => {
    const { service, context, vault, parent, settings } = await runtimeFixture();
    if (id === "T23") { const child = parent.subtasks!.get(CHILD_ID)!; child.plannedStartDate = undefined; child.plannedEndDate = undefined; await vault.modify(vault.getFileById(CHILD_ID)!, newNoteText(vault, child, parent)); }
    for (const path of [PARENT_PATH, CHILD_PATH]) await vault.modify(vault.getFileByPath(path)!, withExtras(vault.getFileContent(path)!));
    const preview = await service.propose(id, operationInputSchemas[id].parse(INPUT_FIXTURES[id]) as OperationInputMap[typeof id], context);
    const outcome = await service.humanApprovalPort.approve(preview.previewId);
    expect(outcome.status).toBe("success");
    for (const path of [PARENT_PATH, CHILD_PATH]) {
      const saved = vault.getFileContent(path);
      if (saved == null) continue;
      expect(saved).toContain("custom: keep"); expect(saved).toContain("## 参考資料\n保持する本文\n");
    }
    const parsed = (await loadNoteTasks(vault, { ...settings, autoPriorityEnabled: false }, new Map())).find((row) => row.id === PARENT_ID);
    const projected = preview.projection!.after.parents.find((row) => row.id === PARENT_ID)!;
    if (parsed) {
      expect(parsed.displayName).toBe(projected.name);
      expect([...parsed.subtasks!.values()].map((row) => row.id)).toEqual(projected.children.map((row) => row.id));
    }
    expect(outcome.actualProjection!.after).toEqual(preview.projection!.after);
  });
  it("Undo/Redo restores exact preserved bytes and supports its preview", async () => {
    const { service, context, vault } = await runtimeFixture();
    const original = withExtras(vault.getFileContentById(CHILD_ID)!);
    await vault.modify(vault.getFileById(CHILD_ID)!, original);
    const change = await service.propose("T07", { taskId: CHILD_ID, name: "改名" }, context); await service.humanApprovalPort.approve(change.previewId);
    const saved = vault.getFileContentById(CHILD_ID)!;
    Object.assign(vault, { process: async (file: { path: string }, transform: (current: string) => string) => { const content = transform(await vault.read(file)); await vault.modify(file, content); return content; } });
    const undo = await service.propose("V20", {}, context); expect((await service.humanApprovalPort.approve(undo.previewId)).status).toBe("success"); expect(vault.getFileContentById(CHILD_ID)).toBe(original);
    const redo = await service.propose("V21", {}, context); expect((await service.humanApprovalPort.approve(redo.previewId)).status).toBe("success"); expect(vault.getFileContentById(CHILD_ID)).toBe(saved);
  });
  it("creating and deleting task notes can be undone and redone", async () => {
    const { service, context, vault, historyManager } = await runtimeFixture();
    Object.assign(vault, { process: async (file: { path: string }, transform: (current: string) => string) => { const content = transform(await vault.read(file)); await vault.modify(file, content); return content; } });
    const created = await service.propose("T04", { parentTaskId: PARENT_ID, name: "追加する子" }, context);
    expect(created.undo.support).toBe("full");
    await service.humanApprovalPort.approve(created.previewId);
    const path = "tasks/リリース/追加する子.md"; expect(vault.getFileContent(path)).toContain("title: 追加する子");
    const undo = await service.propose("V20", {}, context); expect((await service.humanApprovalPort.approve(undo.previewId)).status).toBe("success");
    expect(vault.getFileContent(path)).toBeNull(); expect(vault.trashed).toContain(path);
    const redo = await service.propose("V21", {}, context); expect((await service.humanApprovalPort.approve(redo.previewId)).status).toBe("success");
    expect(vault.getFileContent(path)).toContain("title: 追加する子");
    const remove = await service.propose("T26", { subtaskId: CHILD_ID }, context); await service.humanApprovalPort.approve(remove.previewId);
    expect(vault.getFileContentById(CHILD_ID)).toBeNull();
    const restore = await service.propose("V20", {}, context); expect((await service.humanApprovalPort.approve(restore.previewId)).status).toBe("success");
    expect(vault.getFileContentById(CHILD_ID)).toContain("id: s-bbbbbb"); expect(historyManager.inspectTransition("redo").entry).not.toBeNull();
  });
  for (const id of ["D03", "S01", "V23"] as const) it(`${id} keeps preceding Undo entries`, async () => {
    const { service, context: base, historyManager, logger } = await runtimeFixture();
    const context = { ...base, capabilities: [...base.capabilities, "diagnostic" as const] };
    const change = await service.propose("T07", { taskId: CHILD_ID, name: "改名" }, context); await service.humanApprovalPort.approve(change.previewId);
    const prior = historyManager.inspectTransition("undo").entry;
    if (id === "V23") logger.startRecording("preservation");
    const preview = await service.propose(id, operationInputSchemas[id].parse(INPUT_FIXTURES[id]), context);
    expect((await service.humanApprovalPort.approve(preview.previewId)).status).toBe("success");
    expect(historyManager.inspectTransition("undo").entry).toEqual(prior);
  });
});
