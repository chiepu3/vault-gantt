import { describe, it, expect, vi } from "vitest";
import { runtimeFixture } from "./operation-runtime-fixture";
import { CHILD_ID, CHILD_PATH, PARENT_ID, PARENT_PATH } from "../contracts/fixtures";
import { newNoteText } from "../../src/app/task-operations";
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
  it("snapshots reread only the files whose stat changed", async () => {
    const { service, vault, parent } = await runtimeFixture();
    await service.contextPort.snapshot();
    const read = vi.spyOn(vault, "read");
    const unchanged = await service.contextPort.snapshot();
    expect(read).not.toHaveBeenCalled();
    parent.displayName = "再読込"; parent.title = "再読込";
    await vault.modify(vault.getFileByPath(PARENT_PATH)!, newNoteText(vault, parent));
    read.mockClear();
    const changed = await service.contextPort.snapshot();
    expect(read.mock.calls.map(([file]) => (file as { path: string }).path)).toEqual([PARENT_PATH]);
    expect(changed.revision).not.toBe(unchanged.revision);
  });
  it("memo view state (open, position, visibility) does not change the snapshot revision", async () => {
    const { service, settings } = await runtimeFixture();
    const before = await service.contextPort.snapshot();
    settings.ganttMemoLayout = { "m-aaaaaa": { open: false, dx: 12, dy: -4, w: 200 } };
    settings.ganttMemosVisible = false;
    const after = await service.contextPort.snapshot();
    expect(after.revision).toBe(before.revision);
    expect(after.settingsRevision).toBe(before.settingsRevision);
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
    parent.displayName = "変化"; parent.title = "変化"; await vault.modify(vault.getFileByPath(PARENT_PATH)!, newNoteText(vault, parent));
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
    for (let index = 0; index < 1200; index++) {
      const key = `s-${index.toString(36).padStart(6, "0")}`;
      const row = { ...structuredClone(child), id: key, key, notes: "長い本文".repeat(100), displayName: `child-${index}`, title: `child-${index}`, file: { path: `tasks/リリース/child-${index}.md`, parentPath: parent.file.path } as typeof child.file };
      await vault.create(row.file.path, newNoteText(vault, row, parent));
    }
    const result = await service.contextPort.query("tasks.search", { kind: "subtask", limit: 20 }, context);
    expect(result.status).toBe("success"); if (result.status !== "success") return;
    expect(result.result.data.totalMatched).toBe(1201); expect(result.result.data.returned).toBe(20);
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(15000); expect(JSON.stringify(result)).not.toContain("長い本文");
  });
});

it("unreadable files are explicit and stored/effective priorities remain separate", async () => {
  const { service, context, vault, parent } = await runtimeFixture();
  parent.dueDate = "2001-01-01"; parent.priority = 0;
  await vault.modify(vault.getFileByPath(PARENT_PATH)!, newNoteText(vault, parent));
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

describe("snapshot caching", () => {
  it("unchanged stat signature reuses rows and revision but hands out independent maps and settings", async () => {
    const { service } = await runtimeFixture();
    const first = await service.contextPort.snapshot(), second = await service.contextPort.snapshot();
    expect(second.revision).toBe(first.revision);
    expect(second.parents).toEqual(first.parents);
    expect(second.contents).not.toBe(first.contents);
    expect(second.settings).not.toBe(first.settings);
    first.contents.clear(); first.settings.taskFolder = "mutated";
    const third = await service.contextPort.snapshot();
    expect(third.contents.size).toBe(second.contents.size); expect(third.settings.taskFolder).toBe("tasks");
  });
  it("changed settings, files or the parent order invalidate the cached snapshot", async () => {
    const { service, vault, parent, settings } = await runtimeFixture();
    const a = await service.contextPort.snapshot();
    settings.ganttManualHolidays = ["2026-12-31"];
    const b = await service.contextPort.snapshot();
    expect(b.revision).not.toBe(a.revision); expect(b.settings.ganttManualHolidays).toEqual(["2026-12-31"]);
    settings.ganttParentOrder = [PARENT_ID];
    const c = await service.contextPort.snapshot();
    expect(c.parents[0].ganttOrder).toBe(1000);
    settings.ganttParentOrder = ["other.md", PARENT_ID];
    const d = await service.contextPort.snapshot();
    expect(d.parents[0].ganttOrder).toBe(2000);
    expect(c.parents[0].ganttOrder).toBe(1000);
    parent.title = "再読込みです"; parent.displayName = "再読込みです"; await vault.modify(vault.getFileByPath(PARENT_PATH)!, newNoteText(vault, parent));
    const e = await service.contextPort.snapshot();
    expect(e.revision).not.toBe(d.revision);
  });
  it("persisting the completed parent order does not change the revision (pending previews stay valid)", async () => {
    const { service, settings } = await runtimeFixture();
    settings.ganttParentOrder = undefined;
    const before = await service.contextPort.snapshot();
    expect(before.settings.ganttParentOrder).toEqual([PARENT_ID]);
    settings.ganttParentOrder = [...before.settings.ganttParentOrder!];
    const after = await service.contextPort.snapshot();
    expect(after.settingsRevision).toBe(before.settingsRevision);
    expect(after.revision).toBe(before.revision);
    settings.ganttParentOrder = [PARENT_ID, "other"];
    expect((await service.contextPort.snapshot()).revision).not.toBe(before.revision);
  });
  it("retains old revisions without file bytes and still answers context.changes", async () => {
    const { service, context, vault, parent, child } = await runtimeFixture();
    const overview = await service.contextPort.query("context.overview", { scope: {} }, context);
    if (overview.status !== "success") throw new Error("overview");
    const since = overview.result.snapshotRevision;
    const stored = (service.contextPort as unknown as { snapshots: Map<string, { contents?: unknown }> }).snapshots;
    expect(stored.get(since)).toBeDefined(); expect(stored.get(since)!.contents).toBeUndefined();
    child.title = "変更後です"; child.displayName = "変更後です";
    await vault.modify(vault.getFileByPath(CHILD_PATH)!, newNoteText(vault, child, parent));
    const changes = await service.contextPort.query("context.changes", { sinceRevision: since, scope: {} }, context);
    expect(changes).toMatchObject({ status: "success", result: { data: { kind: "changes", changed: expect.arrayContaining([expect.objectContaining({ id: CHILD_ID, name: "変更後です" })]), added: [], deletedIds: [] } } });
  });
  it("covers() is true only for task-folder and daily-source markdown", async () => {
    const { service } = await runtimeFixture();
    const index = service.contextPort;
    expect(index.covers(PARENT_PATH)).toBe(true);
    expect(index.covers("daily/2026-10-13.md")).toBe(true);
    expect(index.covers("notes/other.md")).toBe(false);
    expect(index.covers("tasks/image.png")).toBe(false);
  });
});
