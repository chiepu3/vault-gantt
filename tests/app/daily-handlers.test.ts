import { describe, it, expect } from "vitest";
import { DailyReadHandler, dailyItems, dailyPlan, dailyProjection, executeDailyPlan } from "../../src/app/operations/daily-handlers";
import { previewEntrySchema, operationPreviewSchema, validatePreviewOutcome } from "../../src/contracts/preview";
import { runtimeFixture } from "./operation-runtime-fixture";

const date = "2026-10-13", path = `daily/${date}.md`;
async function fixture(content = "## ToDoリスト\n- [ ] first\n- [x] second\n\n## Notes\n本文を保持\n") {
  const runtime = await runtimeFixture();
  await runtime.vault.create(path, content); runtime.vault.resetCounters();
  const snapshot = await runtime.service.contextPort.snapshot();
  const items = await dailyItems(path, content, snapshot);
  const target = { path, line: items[0].line, itemFingerprint: items[0].itemFingerprint, expectedRevision: items[0].revision };
  return { ...runtime, snapshot, items, target, content };
}
function validEntries(plan: Awaited<ReturnType<typeof dailyPlan>>) {
  for (const [index, entry] of plan.entries.entries()) expect(() => previewEntrySchema.parse({ ...entry, actionId: `daily-${index}` })).not.toThrow();
}
describe("Daily operation handlers", () => {
  it("D01 returns resolvable fingerprints and counts without writes", async () => {
    const f = await fixture();
    const result = await new DailyReadHandler().read({ dateRange: { from: date, to: date } }, f.context, f.snapshot, f.vault);
    expect(result.data.days[0]).toMatchObject({ date, totalCount: 2, completedCount: 1, items: f.items });
    expect(f.vault.getModifyCallCount()).toBe(0);
  });
  it("D01 binds pagination to the caller and live file content", async () => {
    const f = await fixture(), reader = new DailyReadHandler();
    for (let day = 1; day <= 25; day++) await f.vault.create(`daily/2026-11-${String(day).padStart(2, "0")}.md`, "- [ ] task");
    const input = { dateRange: { from: "2026-11-01", to: "2026-11-30" } };
    const page = await reader.read(input, f.context, f.snapshot, f.vault);
    expect(page.data.returned).toBe(20); expect(page.data.truncated).toBe(true);
    const cursor = page.data.nextCursor!;
    expect((await reader.read({ ...input, cursor }, f.context, f.snapshot, f.vault)).data.returned).toBe(5);
    await expect(reader.read({ ...input, cursor }, { ...f.context, principalId: "other" }, f.snapshot, f.vault)).rejects.toMatchObject({ error: { code: "CURSOR_STALE" } });
    await f.vault.modify(f.vault.getFileByPath("daily/2026-11-25.md")!, "- [x] changed");
    await expect(reader.read({ ...input, cursor }, f.context, f.snapshot, f.vault)).rejects.toMatchObject({ error: { code: "CURSOR_STALE" } });
  });
  it("D02 creates only an absent creatable main and D09 actually adds the placeholder", async () => {
    const f = await fixture();
    const empty = await dailyPlan("D02", { date: "2026-10-14" }, f.snapshot, f.vault);
    expect(empty.writes).toEqual([{ path: "daily/2026-10-14.md", before: null, after: "" }]); validEntries(empty);
    expect((await dailyPlan("D02", { date }, f.snapshot, f.vault)).writes).toEqual([]);
    const quick = await dailyPlan("D09", { date }, f.snapshot, f.vault);
    expect(quick.writes[0].after).toContain("- [ ] 新しいタスク"); validEntries(quick);
    expect(f.vault.getCreateCallCount()).toBe(0);
    f.snapshot.settings.dailyTodoSources[0].creatableFromGantt = false;
    await expect(dailyPlan("D02", { date: "2026-10-14" }, f.snapshot, f.vault)).rejects.toMatchObject({ error: { code: "POLICY_DENIED" } });
  });
  it("D03 inserts inside the ToDo section and preserves prose", async () => {
    const f = await fixture(), plan = await dailyPlan("D03", { date, text: " new ", completed: true }, f.snapshot, f.vault);
    expect(plan.writes[0].after).toContain("- [x] new\n## Notes\n本文を保持"); validEntries(plan);
    expect(f.vault.getModifyCallCount()).toBe(0);
    const saved: string[] = []; await executeDailyPlan(plan, f.vault, (path) => saved.push(path));
    expect(saved).toEqual([path]); expect(await f.vault.read(f.vault.getFileByPath(path)!)).toBe(plan.writes[0].after);
  });
  it("D04/D05 retain CRLF, bullet/indent and the other field; D06 only deletes the target line", async () => {
    const f = await fixture("## ToDoリスト\r\n  * [X] first\r\n- [ ] second\r\n");
    const renamed = await dailyPlan("D04", { ...f.target, text: "renamed" }, f.snapshot, f.vault);
    expect(renamed.writes[0].after).toBe("## ToDoリスト\r\n  * [x] renamed\r\n- [ ] second\r\n"); validEntries(renamed);
    const toggled = await dailyPlan("D05", { ...f.target, completed: false }, f.snapshot, f.vault);
    expect(toggled.writes[0].after).toContain("  * [ ] first\r\n"); validEntries(toggled);
    const deleted = await dailyPlan("D06", f.target, f.snapshot, f.vault);
    expect(deleted.writes[0].after).toBe("## ToDoリスト\r\n- [ ] second\r\n"); validEntries(deleted);
  });
  it("D07 preserves omitted/blank rows and identifies all edits before applying them", async () => {
    const f = await fixture();
    const omitted = await dailyPlan("D07", { date, nextItems: [] }, f.snapshot, f.vault);
    expect(omitted.writes).toEqual([]);
    const blank = await dailyPlan("D07", { date, nextItems: [{ kind: "existing", ...f.target, text: "", completed: true }, { kind: "new", text: "", completed: false }] }, f.snapshot, f.vault);
    expect(blank.writes).toEqual([]);
    const plan = await dailyPlan("D07", { date, nextItems: [{ kind: "existing", ...f.target, text: "updated", completed: true }, { kind: "new", text: "added", completed: false }] }, f.snapshot, f.vault);
    expect(plan.writes[0].after).toContain("- [x] updated\n- [x] second"); expect(plan.writes[0].after).toContain("- [ ] added"); validEntries(plan);
    await expect(dailyPlan("D07", { date, nextItems: [{ kind: "existing", ...f.target, text: "a", completed: true }, { kind: "existing", ...f.target, text: "b", completed: true }] }, f.snapshot, f.vault)).rejects.toMatchObject({ error: { code: "INVALID_INPUT" } });
  });
  it("D04 refuses stale revision/fingerprint and unmodeled Markdown", async () => {
    const f = await fixture();
    await expect(dailyPlan("D04", { ...f.target, expectedRevision: "stale", text: "x" }, f.snapshot, f.vault)).rejects.toThrow();
    await expect(dailyPlan("D04", { ...f.target, itemFingerprint: "sha256:wrong", text: "x" }, f.snapshot, f.vault)).rejects.toMatchObject({ error: { code: "REVISION_CONFLICT" } });
    await f.vault.modify(f.vault.getFileByPath(path)!, "```md\n- [ ] code\n```");
    await expect(dailyPlan("D03", { date, text: "x" }, f.snapshot, f.vault)).rejects.toMatchObject({ error: { code: "INVALID_INPUT" } });
    await f.vault.modify(f.vault.getFileByPath(path)!, "## ToDoリスト\n```md\n### Code heading\n```");
    await expect(dailyPlan("D03", { date, text: "x" }, f.snapshot, f.vault)).rejects.toMatchObject({ error: { code: "INVALID_INPUT" } });
  });
  it("Templater preview is explicitly undetermined and cannot be saved", async () => {
    const f = await fixture(); f.snapshot.settings.dailyTodoSources[0].templatePath = "templates/daily.md";
    const plan = await dailyPlan("D03", { date: "2026-10-14", text: "x" }, f.snapshot, f.vault);
    expect(plan.warnings[0].detail).toContain("未確定"); expect(plan.unresolvedTemplates).toHaveLength(1); expect(plan.writes).toEqual([]); validEntries(plan);
    await expect(executeDailyPlan(plan, f.vault, () => undefined)).rejects.toMatchObject({ error: { code: "POLICY_DENIED" } });
    expect(f.vault.getCreateCallCount()).toBe(0);
  });
  it("execution rechecks bytes and reports already saved paths if stopped between files", async () => {
    const f = await fixture(), plan = await dailyPlan("D03", { date, text: "new" }, f.snapshot, f.vault);
    await f.vault.modify(f.vault.getFileByPath(path)!, f.content + "external");
    await expect(executeDailyPlan(plan, f.vault, () => undefined)).rejects.toMatchObject({ error: { code: "REVISION_CONFLICT" } });
    const controller = new AbortController(), saved: string[] = [];
    await expect(executeDailyPlan({ ...plan, files: [], writes: [{ path: "daily/a.md", before: null, after: "a" }, { path: "daily/b.md", before: null, after: "b" }] }, f.vault, (path) => { saved.push(path); controller.abort(); }, controller.signal)).rejects.toMatchObject({ error: { code: "POLICY_DENIED" } });
    expect(saved).toEqual(["daily/a.md"]); expect(f.vault.getFileByPath("daily/b.md")).toBeNull();
  });
  it("projects Daily counts/items and empty-file existence under the frozen outcome contract", async () => {
    const f = await fixture();
    for (const operationId of ["D02", "D03", "D06"] as const) {
      const input = operationId === "D02" ? { date: "2026-10-14" } : operationId === "D03" ? { date, text: "added" } : f.target;
      const plan = await dailyPlan(operationId, input, f.snapshot, f.vault);
      const entries = plan.entries.map((entry, index) => ({ ...entry, actionId: `daily-${index}` }));
      const projection = await dailyProjection(plan, f.snapshot, entries);
      const preview = operationPreviewSchema.parse({ schemaVersion: 1, previewId: "daily-preview", vaultInstanceId: "test-vault", operationId, origin: f.context.origin, status: "pending", createdAt: "2026-10-13T00:00:00Z", expiresAt: "2026-10-13T00:10:00Z", summary: { targetCount: entries.length, actionCount: entries.length }, entries, warnings: [], undo: { support: "none", reason: "Daily history barrier" }, projection });
      expect(() => validatePreviewOutcome(preview, { previewId: preview.previewId, status: "success", actions: entries.map((entry) => ({ actionId: entry.actionId, state: "committed", actual: entry.effects })), actualProjection: projection })).not.toThrow();
      if (operationId === "D02") expect(projection?.after.dailyFiles).toEqual([{ path: "daily/2026-10-14.md", sourceKey: "main", exists: true }]);
      if (operationId === "D03") expect(projection?.after.daily[0]).toMatchObject({ totalCount: 3, completedCount: 1 });
      if (operationId === "D06") expect(projection?.after.daily[0]).toMatchObject({ totalCount: 1, completedCount: 1 });
    }
  });
  it("merges unchanged source siblings into Daily counts and guards their frozen bytes", async () => {
    const f = await fixture(); f.snapshot.settings.dailyTodoSources.push({ key: "meeting", label: "Meeting", format: "[meeting/]YYYY-MM-DD", creatableFromGantt: false });
    const meetingPath = `meeting/${date}.md`; await f.vault.create(meetingPath, "- [x] meeting");
    const plan = await dailyPlan("D03", { date, text: "added" }, f.snapshot, f.vault);
    const projection = await dailyProjection(plan, f.snapshot, plan.entries.map((entry, index) => ({ ...entry, actionId: `daily-${index}` })));
    expect(projection?.before.daily[0]).toMatchObject({ totalCount: 3, completedCount: 2 });
    expect(projection?.after.daily[0]).toMatchObject({ totalCount: 4, completedCount: 2 });
    expect(plan.writes).toHaveLength(1);
    await f.vault.modify(f.vault.getFileByPath(meetingPath)!, "- [ ] external");
    await expect(executeDailyPlan(plan, f.vault, () => undefined)).rejects.toMatchObject({ error: { code: "REVISION_CONFLICT" } });
    expect(await f.vault.read(f.vault.getFileByPath(path)!)).toBe(f.content);
  });
});
