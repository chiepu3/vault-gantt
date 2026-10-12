import { describe, expect, it } from "vitest";
import { runtimeFixture } from "./operation-runtime-fixture";
import { dailyItems } from "../../src/app/operations/daily-handlers";
import { buildFullNote } from "../../src/core/note-format";

const date = "2026-10-10";
const content = "---\r\ntitle: 日記\r\n---\r\n# メモ\r\n本文を保持\r\n- [ ] 同じ\r\n- [ ] 同じ\r\n- [x] 完了\r\n";

describe("AI Daily history previews and approval", () => {
  it.each(["D03", "D04", "D05", "D06", "D07", "D09"] as const)("%s can undo and redo exact bytes without parsing a task", async (id) => {
    const f = await runtimeFixture(), path = `daily/${date}.md`;
    await f.vault.create(path, content);
    const snapshot = await f.service.contextPort.snapshot();
    const item = (await dailyItems(path, content, snapshot))[1];
    const target = { path, line: item.line, expectedRevision: item.revision, itemFingerprint: item.itemFingerprint };
    const input = id === "D03" ? { date, text: "追加" } : id === "D04" ? { ...target, text: "更新" } : id === "D05" ? { ...target, completed: true } : id === "D06" ? target : id === "D07" ? { date, nextItems: [{ kind: "existing" as const, ...target, text: "更新", completed: true }, { kind: "new" as const, text: "追加", completed: false }] } : { date };
    const change = await f.service.propose(id, input, f.context);
    expect((await f.service.humanApprovalPort.approve(change.previewId)).status).toBe("success");
    const file = f.vault.getFileByPath(path)!, after = await f.vault.read(file);
    expect(after).not.toBe(content);
    for (const direction of ["V20", "V21"] as const) {
      const beforeApproval = await f.vault.read(file);
      const preview = await f.service.propose(direction, {}, f.context);
      expect(preview.entries.length).toBeGreaterThan(0);
      expect(preview.entries.every((entry) => entry.entity.kind === "daily-todo")).toBe(true);
      expect(preview.projection?.before.daily[0].totalCount).toBe(direction === "V20" ? change.projection?.after.daily[0].totalCount : 3);
      expect(preview.projection?.after.daily[0].totalCount).toBe(direction === "V20" ? 3 : change.projection?.after.daily[0].totalCount);
      expect(await f.vault.read(file)).toBe(beforeApproval);
      const outcome = await f.service.humanApprovalPort.approve(preview.previewId);
      expect(outcome.status).toBe("success");
      expect(outcome.actions.every((action) => action.state === "committed")).toBe(true);
      expect(outcome.actualProjection?.after.daily).toEqual(preview.projection?.after.daily);
      expect(await f.vault.read(file)).toBe(direction === "V20" ? content : after);
    }
    expect((await f.service.contextPort.snapshot()).parents.map((parent) => parent.id)).toEqual([f.parent.id]);
  });

  it("supports configured sources under tasks and mixed task/Daily history, including sibling counts", async () => {
    const f = await runtimeFixture(), path = `tasks/daily/${date}.md`, sibling = `daily/${date}.md`;
    f.settings.dailyTodoSources.push({ key: "meeting", label: "会議", format: "[tasks/daily/]YYYY-MM-DD", creatableFromGantt: false });
    await f.vault.create(path, content);
    await f.vault.create(sibling, "- [x] 別ソース");
    const file = f.vault.getFileByPath(path)!, task = f.vault.getFileByPath(f.parent.id)!;
    const taskBefore = await f.vault.read(task), copy = structuredClone(f.parent);
    copy.subtasks!.get("review")!.title = "変更"; copy.subtasks!.get("review")!.displayName = "変更";
    const taskAfter = buildFullNote(copy, copy.subtasks), after = content.replace("同じ", "変更");
    await f.vault.modify(task, taskAfter); await f.vault.modify(file, after);
    f.historyManager.push({ label: "mixed", files: [{ path, before: content, after }, { path: f.parent.id, before: taskBefore, after: taskAfter }] });
    for (const id of ["V20", "V21"] as const) {
      const preview = await f.service.propose(id, {}, f.context);
      expect(preview.entries.some((entry) => entry.entity.kind === "task")).toBe(true);
      expect(preview.entries.some((entry) => entry.entity.kind === "daily-todo")).toBe(true);
      expect(preview.projection?.after.daily[0]).toMatchObject({ totalCount: 4, completedCount: 2 });
      expect((await f.service.humanApprovalPort.approve(preview.previewId)).status).toBe("success");
      expect(await f.vault.read(file)).toBe(id === "V20" ? content : after);
      expect(await f.vault.read(task)).toBe(id === "V20" ? taskBefore : taskAfter);
    }
  });

  it("rejects external edits before preview and approval without moving history", async () => {
    const f = await runtimeFixture(), path = `daily/${date}.md`;
    await f.vault.create(path, content);
    const change = await f.service.propose("D03", { date, text: "追加" }, f.context);
    await f.service.humanApprovalPort.approve(change.previewId);
    const file = f.vault.getFileByPath(path)!, after = await f.vault.read(file);
    await f.vault.modify(file, after + "外部編集");
    await expect(f.service.propose("V20", {}, f.context)).rejects.toMatchObject({ error: { code: "REVISION_CONFLICT" } });
    await f.vault.modify(file, after);
    const undo = await f.service.propose("V20", {}, f.context), revision = f.historyManager.inspectTransition("undo").historyRevision;
    await f.vault.modify(file, after + "外部編集");
    expect((await f.service.humanApprovalPort.approve(undo.previewId)).status).toBe("stale");
    expect(f.historyManager.inspectTransition("undo").historyRevision).toBe(revision);
    expect(await f.vault.read(file)).toBe(after + "外部編集");
  });

  it("rejects history changing non-ToDo Markdown", async () => {
    const f = await runtimeFixture(), path = `daily/${date}.md`, after = content.replace("本文を保持", "別の本文");
    await f.vault.create(path, after);
    f.historyManager.push({ label: "unsafe", files: [{ path, before: content, after }] });
    await expect(f.service.propose("V20", {}, f.context)).rejects.toMatchObject({ error: { code: "INVALID_INPUT" } });
    expect(await f.vault.read(f.vault.getFileByPath(path)!)).toBe(after);
  });
});
