import { describe, it, expect, vi } from "vitest";
import { integrationPlan, executeExternalSend } from "../../src/app/operations/integration-handlers";
import { previewEntrySchema } from "../../src/contracts/preview";
import { contentRevision } from "../../src/app/operations/runtime";
import { runtimeFixture } from "./operation-runtime-fixture";
async function fixture() {
  const f = await runtimeFixture();
  f.settings.ganttSyncUrl = "https://sync.example.test"; f.settings.ganttSyncEnabled = true; f.settings.ganttFeatureSyncEnabled = true;
  return { ...f, snapshot: await f.service.contextPort.snapshot(), host: { pluginVersion: "test" } };
}
function validEntries(plan: Awaited<ReturnType<typeof integrationPlan>>) {
  for (const [index, entry] of plan.entries.entries()) expect(() => previewEntrySchema.parse({ ...entry, actionId: `integration-${index}` })).not.toThrow();
}
describe("settings and integration operation handlers", () => {
  it("S08 fetches on an isolated copy, normalizes holidays and retains live settings on failure", async () => {
    const f = await fixture(), original = structuredClone(f.settings);
    const fetch = vi.fn(async () => ["2026-10-13", "invalid", "2026-10-13"]);
    const plan = await integrationPlan("S08", { force: true }, f.snapshot, { ...f.host, fetchNationalHolidays: fetch });
    expect(plan.settings.ganttNationalHolidays).toEqual(["2026-10-13"]); expect(plan.settings.ganttNationalHolidaysUpdatedAt).toBe(f.snapshot.today); validEntries(plan);
    expect(f.settings).toEqual(original); expect(f.persistSettings).not.toHaveBeenCalled();
    await expect(integrationPlan("S08", { force: true }, f.snapshot, { ...f.host, fetchNationalHolidays: async () => { throw new Error("network"); } })).rejects.toThrow("network");
    expect(f.settings).toEqual(original);
    f.snapshot.settings.ganttNationalHolidaysUpdatedAt = f.snapshot.today; f.snapshot.settings.ganttNationalHolidays = ["2026-10-13"];
    expect((await integrationPlan("S08", {}, f.snapshot, { ...f.host, fetchNationalHolidays: fetch })).keys).toEqual([]); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("S18 disable changes settings with no send; enable previews immediate and recurring sends", async () => {
    const f = await fixture();
    const off = await integrationPlan("S18", { enabled: false }, f.snapshot, f.host);
    expect(off.externalSend).toBeNull(); expect(off.settings.ganttSyncEnabled).toBe(false); expect(off.restartSync).toBe(true); validEntries(off);
    f.snapshot.settings.ganttSyncEnabled = false;
    const on = await integrationPlan("S18", { enabled: true }, f.snapshot, f.host);
    expect(on.externalSend?.destination).toBe("https://sync.example.test/api/snapshot"); expect(on.warnings.some((warning) => warning.code === "RECURRING_EXTERNAL_SEND")).toBe(true); validEntries(on);
  });
  it("S19/S20 normalize settings and preview payload from the candidate settings", async () => {
    const f = await fixture();
    const url = await integrationPlan("S19", { ganttSyncUrl: " https://new.example.test/ " }, f.snapshot, f.host);
    expect(url.settings.ganttSyncUrl).toBe("https://new.example.test/"); expect(url.externalSend?.destination).toBe("https://new.example.test/api/snapshot"); validEntries(url);
    const interval = await integrationPlan("S20", { ganttSyncIntervalMinutes: -2 }, f.snapshot, f.host);
    expect(interval.settings.ganttSyncIntervalMinutes).toBe(1); expect(interval.entries[0].effects).toMatchObject([{ kind: "settings", fields: [{ reason: "normalized" }] }]); validEntries(interval);
    for (const value of ["file:///tmp/x", "https://user:secret@example.test", "https://example.test?q=secret"]) await expect(integrationPlan("S19", { ganttSyncUrl: value }, f.snapshot, f.host)).rejects.toMatchObject({ error: { code: "INVALID_INPUT" } });
  });
  it("S21 freezes exact payload bytes/digest and never sends during preview", async () => {
    const f = await fixture(), plan = await integrationPlan("S21", {}, f.snapshot, f.host), prepared = plan.externalSend!;
    validEntries(plan); expect(plan.keys).toEqual([]); expect(plan.restartSync).toBe(false);
    expect(prepared.payloadDigest).toBe(await contentRevision(prepared.body));
    const effect = plan.entries[0].effects[0]; expect(effect).toMatchObject({ kind: "external-send", bytes: new TextEncoder().encode(prepared.body).length, taskCount: 2 });
    f.settings.ganttSyncUrl = "https://changed.example.test";
    const send = vi.fn(async () => undefined); await executeExternalSend(prepared, send);
    expect(send).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledWith(prepared.destination, prepared.body);
    await expect(executeExternalSend({ ...prepared, body: "tampered" }, send)).rejects.toMatchObject({ error: { code: "REVISION_CONFLICT" } });
    const controller = new AbortController(); controller.abort();
    await expect(executeExternalSend(prepared, send, controller.signal)).rejects.toMatchObject({ error: { code: "POLICY_DENIED" } }); expect(send).toHaveBeenCalledTimes(1);
  });
  it("S27 creates a definition and task assignment as distinct actions, reuses canonical names", async () => {
    const f = await fixture();
    const created = await integrationPlan("S27", { name: "New Tag", target: { kind: "task", taskId: f.child.id } }, f.snapshot, f.host);
    expect(created.entries).toHaveLength(2); expect(created.keys).toEqual(["ganttTags"]); expect(created.changes[0].patch.tags).toEqual(["リリース", "New Tag"]); validEntries(created);
    const reused = await integrationPlan("S27", { name: "tag-1", target: { kind: "task", taskId: f.child.id } }, f.snapshot, f.host);
    expect(reused.keys).toEqual([]); expect(reused.changes[0].patch.tags).toEqual(["リリース"]); validEntries(reused);
    expect(f.settings.ganttTags).toHaveLength(1); expect(f.vault.getModifyCallCount()).toBe(0);
  });
  it("S27 supports marker assignment and refuses unknown keys, conflicts and unmodeled notes", async () => {
    const f = await fixture();
    const target = { kind: "marker" as const, taskId: f.child.id, markerKey: "review-point" };
    const plan = await integrationPlan("S27", { name: "リリース", target }, f.snapshot, f.host);
    expect(plan.changes[0].patch.ganttMarkers?.[0].tags).toEqual(["リリース"]); validEntries(plan);
    await expect(integrationPlan("S27", { name: "a", target: { ...target, markerKey: "missing" } }, f.snapshot, f.host)).rejects.toMatchObject({ error: { code: "NOT_FOUND" } });
    await expect(integrationPlan("S27", { name: "a", target, expectedRevision: "stale" }, f.snapshot, f.host)).rejects.toMatchObject({ error: { code: "REVISION_CONFLICT" } });
    f.snapshot.contents.set(f.parent.id, f.snapshot.contents.get(f.parent.id)! + "\nUnmodeled");
    await expect(integrationPlan("S27", { name: "a", target }, f.snapshot, f.host)).rejects.toMatchObject({ error: { code: "INVALID_INPUT" } });
  });
  it("S35 imports detected configuration without mutating settings; no configuration fails", async () => {
    const f = await fixture();
    const plan = await integrationPlan("S35", {}, f.snapshot, { ...f.host, detectDailyNoteSettings: () => ({ folder: "daily-import", format: "YYYY-MM-DD", templatePath: "templates/daily.md" }) });
    expect(plan.settings.dailyTodoSources.at(-1)).toMatchObject({ format: "[daily-import]/YYYY-MM-DD", templatePath: "templates/daily.md", creatableFromGantt: true }); validEntries(plan);
    expect(f.settings.dailyTodoSources).toHaveLength(1);
    await expect(integrationPlan("S35", {}, f.snapshot, { ...f.host, detectDailyNoteSettings: () => null })).rejects.toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});
