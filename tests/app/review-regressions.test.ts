import { afterEach, describe, it, expect, vi } from "vitest";
import { runtimeFixture } from "./operation-runtime-fixture";
import { CHILD_ID, PARENT_ID } from "../contracts/fixtures";
import { buildFullNote, parseTaskFile } from "../../src/core/note-format";
import { snapMarkerDate } from "../../src/app/gantt-drag";
import { holidaySet } from "../../src/app/gantt-actions";

afterEach(() => vi.useRealTimers());
describe("final review operation regressions", () => {
  it.each(["V20", "V21"] as const)("keeps %s's own focused saved projection when no external change occurs", async (operationId) => {
    const f = await runtimeFixture();
    const saved = await f.service.propose("T07", { taskId: CHILD_ID, name: "saved" }, f.context);
    await f.service.humanApprovalPort.approve(saved.previewId);
    if (operationId === "V21") {
      const undo = await f.service.propose("V20", {}, f.context);
      await f.service.humanApprovalPort.approve(undo.previewId);
    }
    const preview = await f.service.propose(operationId, {}, f.context);
    f.service.previewPort.focus(preview.previewId);
    const outcome = await f.service.humanApprovalPort.approve(preview.previewId);
    expect(outcome.status).toBe("success");
    expect(outcome.actualProjection).toBeTruthy();
    expect(f.service.previewPort.focusedPreviewId()).toBe(preview.previewId);
    expect(f.service.previewPort.inspectOutcome(preview.previewId)).toEqual(outcome);
    f.service.dispose();
  });
  it("also detects an external change while an approved operation is waiting for the queue", async () => {
    const f = await runtimeFixture();
    const preview = await f.service.propose("T07", { taskId: CHILD_ID, name: "saved" }, f.context);
    f.service.previewPort.focus(preview.previewId);
    let release!: () => void, started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    const blocked = f.registry.coordinate(() => new Promise<void>((resolve) => { release = resolve; started(); }));
    await waiting;
    const approved = f.service.humanApprovalPort.approve(preview.previewId);
    expect(f.service.previewPort.inspect(preview.previewId)?.status).toBe("applying");
    await f.vault.create("outside.md", "external"); await f.service.handleVaultChange("outside.md", "create");
    release(); await blocked; const outcome = await approved;
    expect(outcome.status).toBe("success"); expect(f.service.previewPort.focusedPreviewId()).toBeNull();
    expect(f.service.previewPort.inspectOutcome(preview.previewId)).toEqual(outcome); f.service.dispose();
  });
  it("clears applying focus when an external edit precedes outcome publication and keeps the receipt", async () => {
    const f = await runtimeFixture();
    const preview = await f.service.propose("T07", { taskId: CHILD_ID, name: "saved" }, f.context);
    f.service.previewPort.focus(preview.previewId);
    let release!: () => void, started!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const writing = new Promise<void>((resolve) => { started = resolve; });
    const original = f.vault.modify.bind(f.vault);
    vi.spyOn(f.vault, "modify").mockImplementationOnce(async (file, content) => { await original(file, content); started(); await blocked; });
    const approved = f.service.humanApprovalPort.approve(preview.previewId); await writing;
    expect(f.service.previewPort.inspect(preview.previewId)?.status).toBe("applying");
    expect(f.service.previewPort.inspectOutcome(preview.previewId)).toBeUndefined();
    await original(f.vault.getFileByPath(PARENT_ID)!, f.vault.getFileContent(PARENT_ID)! + "\nexternal edit\n");
    await f.service.handleVaultChange(PARENT_ID, "modify");
    release(); const outcome = await approved;
    expect(f.service.previewPort.focusedPreviewId()).toBeNull();
    expect(outcome.status).toBe("success"); expect(f.service.previewPort.inspectOutcome(preview.previewId)).toEqual(outcome); f.service.dispose();
  });
  it("does not mistake an external edit matching a failed write for its own successful save", async () => {
    const f = await runtimeFixture();
    const saved = await f.service.propose("T07", { taskId: CHILD_ID, name: "saved" }, f.context);
    await f.service.humanApprovalPort.approve(saved.previewId); f.service.previewPort.focus(saved.previewId);
    const next = await f.service.propose("T07", { taskId: CHILD_ID, name: "failed" }, f.context);
    const modify = vi.spyOn(f.vault, "modify").mockRejectedValueOnce(new Error("disk"));
    expect((await f.service.humanApprovalPort.approve(next.previewId)).status).toBe("failed");
    const plannedBytes = modify.mock.calls[0][1];
    await f.vault.modify(f.vault.getFileByPath(PARENT_ID)!, plannedBytes);
    await f.service.handleVaultChange(PARENT_ID, "modify"); expect(f.service.previewPort.focusedPreviewId()).toBeNull(); f.service.dispose();
  });
  it("own save events preserve the focused result, while external edits clear it", async () => {
    const f = await runtimeFixture();
    const preview = await f.service.propose("T07", { taskId: CHILD_ID, name: "saved" }, f.context);
    f.service.previewPort.focus(preview.previewId);
    const original = f.vault.modify.bind(f.vault);
    vi.spyOn(f.vault, "modify").mockImplementation(async (file, content) => { await original(file, content); await f.service.handleVaultChange(file.path, "modify"); });
    await f.service.humanApprovalPort.approve(preview.previewId);
    expect(f.service.previewPort.focusedPreviewId()).toBe(preview.previewId);
    await f.service.handleVaultChange(PARENT_ID, "modify");
    expect(f.service.previewPort.focusedPreviewId()).toBe(preview.previewId);
    await f.vault.modify(f.vault.getFileByPath(PARENT_ID)!, f.vault.getFileContent(PARENT_ID)! + "\nexternal\n");
    expect(f.service.previewPort.focusedPreviewId()).toBeNull();
    expect(f.service.previewPort.inspectOutcome(preview.previewId)?.status).toBe("success"); f.service.dispose();
  });
  it("history Undo and Redo clear earlier result focus", async () => {
    const f = await runtimeFixture();
    const preview = await f.service.propose("T07", { taskId: CHILD_ID, name: "saved" }, f.context);
    await f.service.humanApprovalPort.approve(preview.previewId); f.service.previewPort.focus(preview.previewId);
    const undo = await f.service.propose("V20", {}, f.context); await f.service.humanApprovalPort.approve(undo.previewId);
    expect(f.service.previewPort.focusedPreviewId()).toBeNull();
    f.service.previewPort.focus(undo.previewId);
    const redo = await f.service.propose("V21", {}, f.context); await f.service.humanApprovalPort.approve(redo.previewId);
    expect(f.service.previewPort.focusedPreviewId()).toBeNull(); f.service.dispose();
  });
  it("expires the saved afterimage after 60 seconds without removing its receipt or another proposal", async () => {
    vi.useFakeTimers(); const f = await runtimeFixture();
    const preview = await f.service.propose("T07", { taskId: CHILD_ID, name: "saved" }, f.context);
    f.service.previewPort.focus(preview.previewId); await f.service.humanApprovalPort.approve(preview.previewId);
    await vi.advanceTimersByTimeAsync(59_999); expect(f.service.previewPort.focusedPreviewId()).toBe(preview.previewId);
    await vi.advanceTimersByTimeAsync(1); expect(f.service.previewPort.focusedPreviewId()).toBeNull(); expect(f.service.previewPort.inspectOutcome(preview.previewId)).toBeDefined();
    f.service.previewPort.focus(preview.previewId);
    const next = await f.service.propose("T07", { taskId: CHILD_ID, name: "next" }, f.context); f.service.previewPort.focus(next.previewId);
    await vi.advanceTimersByTimeAsync(60_000); expect(f.service.previewPort.focusedPreviewId()).toBe(next.previewId); f.service.dispose();
  });
  it("publishing another receipt does not extend the focused result's 60-second lifetime", async () => {
    vi.useFakeTimers(); const f = await runtimeFixture();
    const first = await f.service.propose("T07", { taskId: CHILD_ID, name: "first" }, f.context);
    f.service.previewPort.focus(first.previewId); await f.service.humanApprovalPort.approve(first.previewId);
    await vi.advanceTimersByTimeAsync(30_000);
    const second = await f.service.propose("T07", { taskId: CHILD_ID, name: "second" }, f.context); await f.service.humanApprovalPort.approve(second.previewId);
    await vi.advanceTimersByTimeAsync(30_000); expect(f.service.previewPort.focusedPreviewId()).toBeNull(); f.service.dispose();
  });
  it.each(["2026-10-10", "2026-09-01", "2026-12-01", "2026-10-14"])("M03 %s uses exactly the drag's holiday snap and bar clamp in plan and commit", async (date) => {
    const f = await runtimeFixture(); f.settings.ganttNationalHolidays = ["2026-10-14"];
    const expected = snapMarkerDate(date, f.child.plannedStartDate!, f.child.plannedEndDate!, holidaySet(f.settings));
    const preview = await f.service.propose("M03", { subtaskId: CHILD_ID, markerKey: "review-point", date }, f.context);
    const effect = preview.entries.flatMap((entry) => entry.effects).find((effect) => effect.kind === "marker");
    if (expected !== f.child.ganttMarkers![0].date) expect(effect).toMatchObject({ after: { date: expected } });
    await f.service.humanApprovalPort.approve(preview.previewId);
    const saved = parseTaskFile({ path: PARENT_ID }, f.vault.getFileContent(PARENT_ID)!, { ...f.settings, autoPriorityEnabled: false })!;
    expect(saved.subtasks!.get("review")!.ganttMarkers![0].date).toBe(expected); f.service.dispose();
  });
  it("M03 refuses unscheduled markers instead of persisting an unbounded drag", async () => {
    const f = await runtimeFixture(); f.child.plannedStartDate = ""; f.child.plannedEndDate = "";
    await f.vault.modify(f.vault.getFileByPath(PARENT_ID)!, buildFullNote(f.parent, f.parent.subtasks));
    await expect(f.service.propose("M03", { subtaskId: CHILD_ID, markerKey: "review-point", date: "2026-10-14" }, f.context)).rejects.toMatchObject({ error: { code: "INVALID_INPUT" } }); f.service.dispose();
  });
  it("Friday to Monday is a three-calendar-day delta even though planning preserves working-day duration", async () => {
    const f = await runtimeFixture(); f.child.plannedStartDate = "2026-10-09"; f.child.plannedEndDate = "2026-10-09";
    await f.vault.modify(f.vault.getFileByPath(PARENT_ID)!, buildFullNote(f.parent, f.parent.subtasks));
    const preview = await f.service.propose("T20", { subtaskId: CHILD_ID, calendarDelta: 3 }, f.context);
    const effect = preview.entries.flatMap((entry) => entry.effects).find((effect) => effect.kind === "schedule");
    expect(effect).toMatchObject({ before: { start: "2026-10-09" }, after: { start: "2026-10-12" }, unit: "calendar-day" });
    const outcome = await f.service.humanApprovalPort.approve(preview.previewId);
    expect(outcome.actions.flatMap((action) => action.actual).find((effect) => effect.kind === "schedule")).toEqual(effect); f.service.dispose();
  });
});
