import { describe, it, expect } from "vitest";
import type { ToolSet } from "ai";
import { chatTools } from "../../src/agent-tools/chat-tools";
import { matchScore } from "../../src/core/fuzzy-match";
import { loadNoteTasks } from "../../src/app/note-store";
import { runtimeFixture } from "../app/operation-runtime-fixture";
import { CHILD_ID, PARENT_ID } from "../contracts/fixtures";
async function invoke(tools: ToolSet, name: string, input: unknown) {
  return tools[name].execute!(input, { toolCallId: "fixture", messages: [], context: undefined }) as Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}
describe("fuzzy task matching", () => {
  it("ignores spaces, width, case and punctuation, and matches multi-word queries", () => {
    expect(matchScore("モックサブタスク146", ["モックサブタスク 146"])).toBe(3);
    expect(matchScore("ﾓｯｸ 146", ["モックサブタスク 146"])).toBe(2);
    expect(matchScore("モック 延長", ["モックサブタスク 146"])).toBe(1);
    expect(matchScore("モック146", ["モックサブタスク 146"])).toBe(2);
    expect(matchScore("無関係", ["モックサブタスク 146"])).toBe(0);
  });
  it("tasks_search finds a subtask despite space and parent-name differences", async () => {
    const f = await runtimeFixture(), tools = chatTools(f.service, f.context, "", () => undefined);
    for (const name of ["ﾚﾋﾞｭｰ", "リリース　レビュー", "レビュー リリース"]) {
      const found = await invoke(tools, "tasks_search", { name, fields: ["identity"] });
      expect(found.result.data.items.some((item: { id: string }) => item.id === CHILD_ID), name).toBe(true);
    }
    f.service.dispose();
  });
  it("workload group reports explicit totals even when nothing is recorded", async () => {
    const f = await runtimeFixture(), tools = chatTools(f.service, f.context, "", () => undefined);
    const detail = await invoke(tools, "tasks_get_many", { taskIds: [CHILD_ID, PARENT_ID], include: ["workload"] });
    for (const item of detail.result.data.items) expect(item.hoursTotal).toMatchObject({ plan: expect.any(Number), actual: expect.any(Number) });
    f.service.dispose();
  });
});
describe("worklog tools", () => {
  it("resolves labels to candidates and proposes everything as one card without saving", async () => {
    const f = await runtimeFixture(), events: { preview: { entries: unknown[]; operationId: string; projection: { after: { parents: { children: { id: string; name: string; hours?: { date: string; actual: number }[] }[] }[] } } } }[] = [], tools = chatTools(f.service, f.context, "", (event) => events.push(event as never));
    const candidates = await invoke(tools, "worklog_candidates", { date: "2026-10-13", labels: ["リリース レビュー", "リリース", "部長の呼び出し"] });
    expect(candidates.results[0].subtasks[0].subtaskId).toBe(CHILD_ID);
    expect(candidates.results[1].parents[0].parentId).toBe(PARENT_ID);
    expect(candidates.results[2].matchQuality).toBe("near-or-none");
    const before = f.vault.snapshot();
    const proposed = await invoke(tools, "worklog_propose", { date: "2026-10-13", entries: [
      { subtaskId: CHILD_ID, hours: 1 }, { subtaskId: CHILD_ID, hours: 2 },
      { parentId: PARENT_ID, newSubtaskName: "不具合修正", hours: 1.5 }, { eventTitle: "部長の呼び出し", hours: 0.5 },
    ] });
    expect(proposed.status).toBe("proposal-created"); expect(proposed.entries).toHaveLength(3);
    expect(events).toHaveLength(1); expect(events[0].preview.operationId).toBe("T31"); expect(f.vault.snapshot()).toEqual(before);
    const children = events[0].preview.projection.after.parents.flatMap((p) => p.children);
    expect(children.find((c) => c.name === "不具合修正")?.hours).toContainEqual(expect.objectContaining({ date: "2026-10-13", actual: 1.5 }));
    expect(children.find((c) => c.id === CHILD_ID)?.hours).toContainEqual(expect.objectContaining({ date: "2026-10-13", actual: 3 }));
    f.service.dispose();
  });
  it("persists hours on a single approval, including a newly created subtask and event", async () => {
    const f = await runtimeFixture(), tools = chatTools(f.service, f.context, "", () => undefined);
    const proposed = await invoke(tools, "worklog_propose", { date: "2026-10-13", entries: [{ subtaskId: CHILD_ID, hours: 2 }, { parentId: PARENT_ID, newSubtaskName: "不具合修正", hours: 1.5 }, { parentId: PARENT_ID, newSubtaskName: "打ち合わせ", hours: 1 }, { eventTitle: "割り込み", hours: 0.5 }] });
    expect((await f.service.humanApprovalPort.approve(proposed.previewId)).status).toBe("success");
    const parent = (await loadNoteTasks(f.vault, f.settings, new Map())).find((row) => row.id === PARENT_ID)!;
    const rows = [...parent.subtasks!.values()];
    expect(rows.find((r) => r.id === CHILD_ID)?.workloadActual).toMatchObject({ "2026-10-13": 2 });
    expect(rows.find((r) => r.displayName === "不具合修正")?.workloadActual).toMatchObject({ "2026-10-13": 1.5 });
    expect(rows.find((r) => r.displayName === "打ち合わせ")?.workloadActual).toMatchObject({ "2026-10-13": 1 });
    expect(f.persistSettings).toHaveBeenCalled();
    f.service.dispose();
  });
  it("rejects unknown targets and non half-hour values with repairable errors", async () => {
    const f = await runtimeFixture(), tools = chatTools(f.service, f.context, "", () => undefined);
    expect((await invoke(tools, "worklog_propose", { date: "2026-10-13", entries: [{ subtaskId: "nope", hours: 1 }] })).error.code).toBe("NOT_FOUND");
    expect((await invoke(tools, "worklog_propose", { date: "2026-10-13", entries: [{ subtaskId: CHILD_ID, hours: 1.3 }] })).error.code).toBe("INVALID_INPUT");
    f.service.dispose();
  });
});
