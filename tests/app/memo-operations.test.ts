import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runtimeFixture } from "./operation-runtime-fixture";
import { catalogTools } from "../../src/agent-tools/catalog-tools";
import { operationInputSchemas } from "../../src/contracts/operations";
import { INPUT_FIXTURES, CHILD_ID, PARENT_ID } from "../contracts/fixtures";

const memoPath = (vault: { getFiles(): { path: string }[] }) => vault.getFiles().filter((file) => file.path.startsWith("tasks/_memos/")).map((file) => file.path);
const args = { toolCallId: "test", messages: [], context: undefined };

async function setup(overrides: Parameters<typeof runtimeFixture>[0] = {}) {
  const f = await runtimeFixture(overrides);
  const context = { ...f.context, capabilities: ["read", "propose", "ui"] as import("../../src/contracts/context").Capability[] };
  const add = async (text: string, extra: Record<string, unknown> = {}) => {
    const preview = await f.service.propose("N02", { text, taskId: CHILD_ID, date: "2026-10-14", ...extra } as never, context);
    await f.service.humanApprovalPort.approve(preview.previewId);
    return preview.entries[0].entity.kind === "memo" ? preview.entries[0].entity.memoId : "";
  };
  const list = async (input: Record<string, unknown> = {}) => (await f.service.read("N01", input as never, context)).data.items;
  return { ...f, context, add, list };
}

describe("memo operations (N01-N05)", () => {
  it("N02 proposes without writing, then creates the note and records it for undo", async () => {
    const f = await setup();
    f.vault.resetCounters();
    const preview = await f.service.propose("N02", { text: "レビューの観点\n・性能", taskId: CHILD_ID, date: "2026-10-14" }, f.context);
    expect(f.vault.getCreateCallCount()).toBe(0);
    expect(preview.projection).toBeNull();
    expect(preview.undo.support).toBe("full");
    expect(preview.entries[0].effects[0]).toMatchObject({ kind: "memo", before: null, after: { text: "レビューの観点\n・性能", taskId: CHILD_ID, taskName: "レビュー", date: "2026-10-14" } });
    const outcome = await f.service.humanApprovalPort.approve(preview.previewId);
    expect(outcome.status).toBe("success");
    expect(outcome.undoEntryId).toBeTruthy();
    const [path] = memoPath(f.vault);
    expect(path).toMatch(/^tasks\/_memos\/\d{4}-\d{2}-\d{2} レビューの観点\.md$/);
    const note = f.vault.getFileContent(path)!;
    expect(note).toContain("type: gantt-memo");
    expect(note).toContain(`task: ${CHILD_ID}`);
    expect(note).toContain("at: 1");
    expect(note.endsWith("レビューの観点\n・性能\n")).toBe(true);
    // Undo removes the note again.
    await f.historyManager.undo(f.vault as never);
    expect(memoPath(f.vault)).toEqual([]);
  });

  it("N02 without a task puts the memo on the その他 row; a subtask date outside its bar is refused", async () => {
    const f = await setup();
    const free = await f.service.propose("N02", { text: "雑多なメモ", date: "2026-11-02" }, f.context);
    expect(free.entries[0].effects[0]).toMatchObject({ after: { date: "2026-11-02" } });
    expect((free.entries[0].effects[0] as { after: Record<string, unknown> }).after).not.toHaveProperty("taskId");
    await expect(f.service.propose("N02", { text: "範囲外", taskId: CHILD_ID, date: "2026-12-01" }, f.context)).rejects.toMatchObject({ error: { code: "INVALID_INPUT" } });
    // No date: the bar's range contains the default.
    const dated = await f.service.propose("N02", { text: "日付なし", taskId: CHILD_ID }, f.context);
    const after = (dated.entries[0].effects[0] as { after: { date: string } }).after;
    expect(after.date >= "2026-10-13" && after.date <= "2026-10-15").toBe(true);
  });

  it("N02 with open:false adds a closed pin through the view state, not the proposal", async () => {
    const setMemosOpen = vi.fn(async () => undefined);
    const f = await setup({ setMemosOpen });
    const id = await f.add("閉じて追加", { open: false });
    expect(setMemosOpen).toHaveBeenCalledWith([id], false);
    expect(f.persistSettings).not.toHaveBeenCalled();
  });

  it("N01 lists memos with real dates, hides closed ones unless asked, and filters", async () => {
    const f = await setup();
    const a = await f.add("最初のメモ", { date: "2026-10-13" });
    const b = await f.add("二番目のメモ", { date: "2026-10-15" });
    await f.add("その他のメモ", { taskId: undefined, date: "2026-10-20" });
    f.settings.ganttMemoLayout = { [b]: { open: false, dx: 0, dy: 0, w: 220 } };
    const items = await f.list();
    expect(items.map((item) => item.text)).toEqual(["最初のメモ", "その他のメモ"]);
    expect(items[0]).toMatchObject({ memoId: a, open: true, anchor: { kind: "subtask", taskId: CHILD_ID, taskName: "レビュー", date: "2026-10-13" } });
    expect(JSON.stringify(items)).not.toContain('"at"');
    expect(items[1].anchor).toEqual({ kind: "free", date: "2026-10-20" });
    expect((await f.list({ includeClosed: true })).map((item) => item.memoId)).toContain(b);
    expect((await f.list({ includeClosed: true, taskId: CHILD_ID })).map((item) => item.text)).toEqual(["最初のメモ", "二番目のメモ"]);
    expect((await f.list({ includeClosed: true, taskId: PARENT_ID })).map((item) => item.text)).toEqual(["最初のメモ", "二番目のメモ"]);
    expect((await f.list({ from: "2026-10-14", to: "2026-10-16", includeClosed: true })).map((item) => item.text)).toEqual(["二番目のメモ"]);
    expect((await f.list({ query: "その他" })).map((item) => item.text)).toEqual(["その他のメモ"]);
    expect(await f.list({ limit: 1 })).toHaveLength(1);
  });

  it("N03 replaces the text only against the revision that was read, and is undoable", async () => {
    const f = await setup();
    const id = await f.add("元の本文");
    const [item] = await f.list();
    await expect(f.service.propose("N03", { memoId: id, text: "x", expectedRevision: "sha256:stale" }, f.context)).rejects.toMatchObject({ error: { code: "REVISION_CONFLICT" } });
    const preview = await f.service.propose("N03", { memoId: id, text: "新しい本文", expectedRevision: item.revision }, f.context);
    expect(preview.entries[0].effects[0]).toMatchObject({ before: { text: "元の本文" }, after: { text: "新しい本文" } });
    expect((await f.service.humanApprovalPort.approve(preview.previewId)).status).toBe("success");
    expect((await f.list())[0].text).toBe("新しい本文");
    await f.historyManager.undo(f.vault as never);
    expect((await f.list())[0].text).toBe("元の本文");
  });

  it("N03 with the same text changes nothing but still reports success", async () => {
    const f = await setup();
    const id = await f.add("同じ本文");
    const [item] = await f.list();
    f.vault.resetCounters();
    const preview = await f.service.propose("N03", { memoId: id, text: "同じ本文", expectedRevision: item.revision }, f.context);
    const outcome = await f.service.humanApprovalPort.approve(preview.previewId);
    expect(outcome.status).toBe("success");
    expect(f.vault.getModifyCallCount()).toBe(0);
  });

  it("N04 moves a memo to the その他 row with an empty taskId and keeps the text", async () => {
    const f = await setup();
    const id = await f.add("付け替え対象");
    const [item] = await f.list();
    const preview = await f.service.propose("N04", { memoId: id, taskId: "", date: "2026-11-05", expectedRevision: item.revision }, f.context);
    expect((await f.service.humanApprovalPort.approve(preview.previewId)).status).toBe("success");
    const [moved] = await f.list();
    expect(moved).toMatchObject({ text: "付け替え対象", anchor: { kind: "free", date: "2026-11-05" } });
    const note = f.vault.getFileContent(memoPath(f.vault)[0])!;
    expect(note).not.toContain("task:");
    expect(note).not.toContain("at:");
    expect(note).toContain("date: 2026-11-05");
    await f.historyManager.undo(f.vault as never);
    expect((await f.list())[0].anchor).toMatchObject({ kind: "subtask", taskId: CHILD_ID });
  });

  it("N04 keeps the current task when only the date changes", async () => {
    const f = await setup();
    const id = await f.add("日付だけ", { date: "2026-10-13" });
    const [item] = await f.list();
    const preview = await f.service.propose("N04", { memoId: id, date: "2026-10-15", expectedRevision: item.revision }, f.context);
    await f.service.humanApprovalPort.approve(preview.previewId);
    expect((await f.list())[0].anchor).toMatchObject({ kind: "subtask", taskId: CHILD_ID, date: "2026-10-15" });
  });

  it("N05 deletes the note and undo brings it back", async () => {
    const f = await setup();
    const id = await f.add("消すメモ");
    const [item] = await f.list();
    const preview = await f.service.propose("N05", { memoId: id, expectedRevision: item.revision }, f.context);
    expect(preview.entries[0].effects[0]).toMatchObject({ kind: "memo", after: null });
    expect((await f.service.humanApprovalPort.approve(preview.previewId)).status).toBe("success");
    expect(await f.list()).toEqual([]);
    await f.historyManager.undo(f.vault as never);
    expect((await f.list()).map((memo) => memo.text)).toEqual(["消すメモ"]);
  });

  it("a pending N02 survives another proposal being applied first (rebase keeps the generated id out of the comparison)", async () => {
    const f = await setup();
    const first = await f.service.propose("N02", { text: "ひとつめ", taskId: CHILD_ID, date: "2026-10-14" }, f.context);
    const second = await f.service.propose("N02", { text: "ふたつめ", taskId: CHILD_ID, date: "2026-10-15" }, f.context);
    expect((await f.service.humanApprovalPort.approve(first.previewId)).status).toBe("success");
    expect((await f.service.humanApprovalPort.approve(second.previewId)).status).toBe("success");
    expect(memoPath(f.vault)).toHaveLength(2);
  });

  it("N06 is a view request that never needs approval", async () => {
    const request = vi.fn(async (id: string) => ({ schemaVersion: 1, resultKind: "request", operationId: id, status: "applied", effects: [] }));
    const f = await setup({ ui: { request, inspectView: () => undefined } as never });
    const result = await f.service.request("N06", { memoIds: ["*"], open: false }, f.context);
    expect(request).toHaveBeenCalledWith("N06", { memoIds: ["*"], open: false });
    expect(result).toMatchObject({ operationId: "N06", status: "applied" });
  });
});

describe("memo tools through the real registry path", () => {
  it("accepts every N fixture through the strict schemas the SDK tool exposes, and rejects unknown keys", async () => {
    const f = await setup();
    const tools = catalogTools(f.service, f.context, ["memos"], () => undefined);
    const propose = tools.memos_propose.inputSchema as z.ZodType;
    for (const id of ["N02", "N03", "N04", "N05"] as const) expect(propose.safeParse({ operationId: id, input: INPUT_FIXTURES[id] }).success, id).toBe(true);
    expect(propose.safeParse({ operationId: "N02", input: { text: "x", at: 3 } }).success).toBe(false);
    expect(propose.safeParse({ operationId: "N02", input: { text: "   " } }).success).toBe(false);
    expect(operationInputSchemas.N04.safeParse({ memoId: "m-aaaaaa", expectedRevision: "sha256:x" }).success).toBe(false);
    expect(operationInputSchemas.N01.safeParse({ from: "2026-10-20", to: "2026-10-01" }).success).toBe(false);
  });

  it("proposes N02 through operations_propose and the memo shows up in N01", async () => {
    const f = await setup();
    const events: unknown[] = [];
    const tools = catalogTools(f.service, f.context, ["memos"], (event) => events.push(event));
    const result = await tools.memos_propose.execute!({ operationId: "N02", input: { text: "AIが書いたメモ", taskId: CHILD_ID, date: "2026-10-14" } }, args);
    expect(result).toMatchObject({ status: "pending", operationId: "N02" });
    expect(events).toHaveLength(1);
    const pending = f.service.previewPort.list!().find((preview) => preview.operationId === "N02")!;
    await f.service.humanApprovalPort.approve(pending.previewId);
    const listed = await tools.operations_N01.execute!({ includeClosed: true }, args) as { data: { items: { text: string }[] } };
    expect(listed.data.items.map((item) => item.text)).toEqual(["AIが書いたメモ"]);
  });
});
