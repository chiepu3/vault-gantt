import { describe, it, expect, vi } from "vitest";
import { runtimeFixture } from "./operation-runtime-fixture";
import { CHILD_ID, PARENT_ID } from "../contracts/fixtures";
import { buildFullNote } from "../../src/core/note-format";
import { contextQueryOutputSchemas } from "../../src/contracts/context";

describe("content-hash ContextReadPort", () => {
  it("compact default reads preserve identity/hierarchy and omit body/maps", async () => {
    const { service, context } = await runtimeFixture();
    const result = await service.contextPort.query("tasks.search", { name: "レビュー" }, context);
    expect(result.status).toBe("success"); if (result.status !== "success") return;
    expect(result.result.data.items).toHaveLength(1); expect(result.result.data.items[0]).toMatchObject({ id: CHILD_ID, parentId: PARENT_ID, kind: "subtask", revision: expect.stringMatching(/^sha256:/) });
    expect(result.result.data.items[0]).not.toHaveProperty("content"); expect(result.result.data.items[0]).not.toHaveProperty("hours"); expect(result.result.data.items[0]).not.toHaveProperty("markers");
    const detail = await service.contextPort.query("tasks.get-many", { taskIds: [CHILD_ID], include: ["content", "markers", "workload"] }, context);
    expect(detail.status === "success" && detail.result.data.items[0]).toHaveProperty("content"); expect(contextQueryOutputSchemas["tasks.get-many"].safeParse(detail).success).toBe(true);
  });
  it("pages have no gaps/duplicates and are bound to snapshot/query/principal", async () => {
    const { service, context, vault, parent } = await runtimeFixture();
    const first = await service.contextPort.query("tasks.search", { limit: 1 }, context);
    if (first.status !== "success") throw new Error(JSON.stringify(first));
    expect(first.result.data.totalMatched).toBe(2); expect(first.result.data.truncated).toBe(true);
    const cursor = first.result.data.nextCursor!;
    const second = await service.contextPort.query("tasks.search", { limit: 1, cursor }, context);
    expect(second.status === "success" && second.result.data.items[0].id).not.toBe(first.result.data.items[0].id);
    expect(second.status === "success" && second.result.data.nextCursor).toBeNull();
    const wrong = await service.contextPort.query("tasks.search", { limit: 1, cursor }, { ...context, principalId: "other" }); expect(wrong).toMatchObject({ status: "error", error: { code: "CURSOR_STALE", nextAction: expect.any(String) } });
    const changedQuery = await service.contextPort.query("tasks.search", { limit: 1, cursor, name: "レビュー" }, context); expect(changedQuery).toMatchObject({ status: "error", error: { code: "CURSOR_STALE" } });
    parent.displayName = "変化"; parent.title = "変化"; await vault.modify(vault.getFileByPath(PARENT_ID)!, buildFullNote(parent, parent.subtasks));
    const stale = await service.contextPort.query("tasks.search", { limit: 1, cursor }, context); expect(stale).toMatchObject({ status: "error", error: { code: "CURSOR_STALE" } });
  });
  it("parent derived periods and child writable schedule are distinguished", async () => {
    const { service, context } = await runtimeFixture();
    const project = await service.contextPort.query("projects.get", { parentTaskId: PARENT_ID, includeChildren: true, childFields: ["schedule"] }, context);
    expect(project.status).toBe("success"); if (project.status !== "success") return;
    expect(project.result.data.derived).toEqual({ period: { start: "2026-10-13", end: "2026-10-15" }, progress: 0 });
    expect(project.result.data.parent).not.toHaveProperty("schedule"); expect(project.result.data.children!.items[0]).toHaveProperty("schedule");
    expect(await service.contextPort.query("tasks.get-many", { taskIds: ["missing", CHILD_ID] }, context)).toMatchObject({ status: "success", result: { errors: [expect.objectContaining({ code: "NOT_FOUND", targetId: "missing" })] } });
  });
  it("settings queries use a section allowlist and keep authentication values private", async () => {
    const { service, context, settings } = await runtimeFixture();
    Object.assign(settings, { mcpToken: "do-not-leak", openaiApiKey: "do-not-leak", secretId: "do-not-leak" });
    const result = await service.contextPort.query("settings.get", { sections: ["tags"] }, context);
    expect(JSON.stringify(result)).not.toContain("do-not-leak"); expect(result).toMatchObject({ status: "success", result: { data: { kind: "settings", values: { ganttTags: settings.ganttTags } } } });
    expect(result.status === "success" && Object.keys(result.result.data.values)).toEqual(["ganttTags"]);
  });
  it("workload includes hidden task/event maps, weekend recurring contributions and mode selection", async () => {
    const { service, context, settings } = await runtimeFixture();
    settings.weeklyWorkSchedules = [{ key: "weekend", title: "休日定例", dayOfWeek: 0, minutesPerWeek: 1500 }];
    settings.ganttFeatureWorkloadEnabled = false;
    const result = await service.contextPort.query("workload.get", { from: "2026-10-11", to: "2026-10-13", detail: true }, context);
    expect(result.status).toBe("success"); if (result.status !== "success") return;
    expect(result.result.data.days[0]).toMatchObject({ date: "2026-10-11", plan: 25, capacity: 0, overCapacity: true });
    expect(result.result.data.days[2]).toMatchObject({ plan: 4, actual: 2 });
    expect(contextQueryOutputSchemas["workload.get"].safeParse(result).success).toBe(true);
    const actual = await service.contextPort.query("workload.get", { from: "2026-10-13", to: "2026-10-13", mode: "actual" }, context); expect(actual).toMatchObject({ status: "success", result: { data: { days: [expect.objectContaining({ plan: 0, actual: 2 })] } } });
  });
  it("bounded changes retain complete fetched groups and signal unknown history", async () => {
    const { service, context } = await runtimeFixture();
    const before = await service.contextPort.snapshot();
    const preview = await service.propose("T07", { taskId: CHILD_ID, name: "改名" }, context); await service.humanApprovalPort.approve(preview.previewId);
    const changes = await service.contextPort.query("context.changes", { sinceRevision: before.revision, scope: { parentIds: [PARENT_ID] } }, context);
    expect(changes.status).toBe("success"); if (changes.status === "success") expect(changes.result.data.changed.map((task) => task.id)).toContain(CHILD_ID);
    expect(await service.contextPort.query("context.changes", { sinceRevision: "unknown", scope: {} }, context)).toMatchObject({ status: "error", error: { code: "RESET_REQUIRED", nextAction: expect.any(String) } });
    expect(await service.contextPort.query("daily.get", { dateRange: { from: "2026-10-13", to: "2026-10-13" } }, context)).toMatchObject({ status: "success", result: { data: { kind: "daily", days: [] } } });
  });
  it("scales compact search over 1200 children while fetching only requested page", async () => {
    const { service, context, vault, parent, child } = await runtimeFixture();
    parent.subtasks = new Map(Array.from({ length: 1200 }, (_, index) => { const key = `child-${index}`; return [key, { ...structuredClone(child), id: `${PARENT_ID}::${key}`, key, notes: "長い本文".repeat(100), displayName: key, title: key }]; }));
    await vault.modify(vault.getFileByPath(PARENT_ID)!, buildFullNote(parent, parent.subtasks));
    const result = await service.contextPort.query("tasks.search", { kind: "subtask", limit: 20 }, context);
    expect(result.status).toBe("success"); if (result.status !== "success") return;
    expect(result.result.data.totalMatched).toBe(1200); expect(result.result.data.returned).toBe(20);
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(15000); expect(JSON.stringify(result)).not.toContain("長い本文");
  });
});

it("unreadable files are explicit and stored/effective priorities remain separate", async () => {
  const { service, context, vault, parent } = await runtimeFixture();
  parent.dueDate = "2001-01-01"; parent.priority = 0;
  await vault.modify(vault.getFileByPath(PARENT_ID)!, buildFullNote(parent, parent.subtasks));
  await vault.create("tasks/broken.md", "---\ntype: task\ninvalid: [\n---\n");
  const read = vault.read.bind(vault);
  vi.spyOn(vault, "read").mockImplementation((file) => { if (file.path === "tasks/broken.md") return Promise.reject(new Error("READ_FAILED")); return read(file); });
  const result = await service.contextPort.query("tasks.get-many", { taskIds: [PARENT_ID], include: ["priority"] }, context);
  expect(result).toMatchObject({ status: "success", result: { data: { items: [expect.objectContaining({ priority: { stored: 0, effective: 5, mode: "auto" } })] }, errors: [expect.objectContaining({ code: "PARSE_FAILED", targetId: "tasks/broken.md" })] } });
});

it("unplaced filtering refers to children and never mistakes a parent for an unplaced child", async () => {
  const { service, context } = await runtimeFixture();
  const result = await service.contextPort.query("tasks.search", { placed: false }, context);
  expect(result).toMatchObject({ status: "success", result: { data: { items: [], totalMatched: 0, returned: 0 } } });
});

it("does not silently ignore an unsupported overview date range", async () => {
  const { service, context } = await runtimeFixture();
  const result = await service.contextPort.query("context.overview", { dateRange: { from: "2026-10-13", to: "2026-10-15" } }, context);
  expect(result).toMatchObject({ status: "error", error: { code: "INVALID_INPUT", field: "dateRange", nextAction: expect.stringContaining("tasks.search") } });
});
