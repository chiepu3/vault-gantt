/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { requestUrl } from "obsidian";
import {
  buildReadonlyGanttSnapshotFromTasks,
  getGanttSyncEndpoint,
  hashString,
  normalizeWorkloadMapForSnapshot,
  snapshotTags,
  syncReadonlyGanttSnapshot,
} from "../../src/app/gantt-sync-service";
import type { GanttSyncState } from "../../src/app/gantt-sync-service";
import { DEFAULT_SETTINGS } from "../../src/core/constants";
import type { TaskRow, TaskWorkbenchSettings } from "../../src/core/types";

vi.mock("obsidian", async (importOriginal) => {
  const actual = await importOriginal<typeof import("obsidian")>();
  return { ...actual, requestUrl: vi.fn() };
});

const requestUrlMock = requestUrl as unknown as Mock;

let seq = 0;

function makeParent(overrides: Record<string, unknown> = {}): TaskRow {
  seq += 1;
  const path = `tasks/parent-${seq}.md`;
  return {
    kind: "parent",
    id: path,
    file: { path },
    title: `Parent ${seq}`,
    displayName: `Parent ${seq}`,
    statusLabel: "active",
    completed: false,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    dueDate: "",
    priority: 0,
    priorityMode: "auto",
    currentStatus: "",
    notes: "",
    tags: [],
    ganttEnabled: false,
    subtasks: new Map(),
    ...overrides,
  } as unknown as TaskRow;
}

function makeSubtask(
  parent: TaskRow,
  key: string,
  overrides: Record<string, unknown> = {}
): TaskRow {
  return {
    kind: "subtask",
    id: `${parent.id}::${key}`,
    key,
    file: { path: parent.file.path, parentPath: parent.file.path },
    title: key,
    displayName: key,
    statusLabel: "active",
    completed: false,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    dueDate: "",
    priority: 0,
    priorityMode: "auto",
    currentStatus: "",
    notes: "",
    tags: [],
    ganttEnabled: false,
    ...overrides,
  } as unknown as TaskRow;
}

function makeSettings(overrides: Record<string, unknown> = {}): TaskWorkbenchSettings {
  return { ...DEFAULT_SETTINGS, ...overrides } as TaskWorkbenchSettings;
}


// getGanttSyncEndpoint


describe("getGanttSyncEndpoint", () => {
  it("empty string -> empty string", () => {
    expect(getGanttSyncEndpoint(makeSettings({ ganttSyncUrl: "" }))).toBe("");
  });

  it("trims whitespace-only URLs to an empty string", () => {
    expect(getGanttSyncEndpoint(makeSettings({ ganttSyncUrl: "   " }))).toBe("");
  });

  it("appends /api/snapshot when absent", () => {
    expect(
      getGanttSyncEndpoint(makeSettings({ ganttSyncUrl: "http://localhost:8787" }))
    ).toBe("http://localhost:8787/api/snapshot");
  });

  it("collapses multiple trailing slashes before appending", () => {
    expect(
      getGanttSyncEndpoint(makeSettings({ ganttSyncUrl: "http://localhost:8787///" }))
    ).toBe("http://localhost:8787/api/snapshot");
  });

  it("a value already ending in /api/snapshot passes through unchanged", () => {
    expect(getGanttSyncEndpoint(makeSettings({ ganttSyncUrl: "/api/snapshot" }))).toBe(
      "/api/snapshot"
    );
    expect(
      getGanttSyncEndpoint(
        makeSettings({ ganttSyncUrl: "http://localhost:8787/api/snapshot" })
      )
    ).toBe("http://localhost:8787/api/snapshot");
  });
});


// hashString: FNV-1a 32-bit, hand-verified expected
// values (offset basis 2166136261 = 0x811c9dc5 IS the hash of "" since no
// character ever XORs/multiplies it; "a" = 0xe40c292c is the well-known
// FNV-1a-32 test vector for a single-character input — both independently
// re-derived with a scratch script before writing these assertions).


describe("hashString", () => {
  it("hash of the empty string is the raw FNV offset basis in hex", () => {
    expect(hashString("")).toBe("811c9dc5");
  });

  it("hash of a known single-character string matches the canonical FNV-1a-32 vector", () => {
    expect(hashString("a")).toBe("e40c292c");
  });

  it("returns an 8-digit lowercase hex string", () => {
    expect(hashString("hello world")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("hashes null and undefined as empty strings", () => {
    expect(hashString(null)).toBe(hashString(undefined));
    expect(hashString(null)).toBe(hashString(""));
  });

  it("a number and its string form hash identically", () => {
    expect(hashString(123)).toBe(hashString("123"));
  });

  it("produces different hashes for different inputs", () => {
    expect(hashString("a")).not.toBe(hashString("b"));
    expect(hashString("abc")).not.toBe(hashString("acb"));
  });
});



// of the write-path normalizeWorkloadMap in core/task-patch.ts.


describe("normalizeWorkloadMapForSnapshot", () => {
  it("skips invalid date keys instead of throwing", () => {
    expect(() =>
      normalizeWorkloadMapForSnapshot({ "not-a-date": 3, "2026-01-01": 2 })
    ).not.toThrow();
    expect(normalizeWorkloadMapForSnapshot({ "not-a-date": 3, "2026-01-01": 2 })).toEqual(
      { "2026-01-01": 2 }
    );
  });

  it("rounds to 0.5h increments", () => {
    expect(normalizeWorkloadMapForSnapshot({ "2026-01-01": 1.3 })).toEqual({
      "2026-01-01": 1.5,
    });
  });

  it("drops non-positive hours after rounding", () => {
    expect(normalizeWorkloadMapForSnapshot({ "2026-01-01": 0, "2026-01-02": -1 })).toEqual(
      {}
    );
  });

  it("does not throw or cap snapshot workload values above 24 hours", () => {
    expect(() =>
      normalizeWorkloadMapForSnapshot({ "2026-01-01": 30 })
    ).not.toThrow();
    expect(normalizeWorkloadMapForSnapshot({ "2026-01-01": 30 })).toEqual({
      "2026-01-01": 30,
    });
  });

  it("non-object / array / null input returns {}", () => {
    expect(normalizeWorkloadMapForSnapshot(undefined)).toEqual({});
    expect(normalizeWorkloadMapForSnapshot(null)).toEqual({});
    expect(normalizeWorkloadMapForSnapshot([1, 2, 3])).toEqual({});
    expect(normalizeWorkloadMapForSnapshot("x")).toEqual({});
  });
});


// snapshotTags


describe("snapshotTags", () => {
  it("non-array input returns []", () => {
    expect(snapshotTags(undefined)).toEqual([]);
    expect(snapshotTags(null)).toEqual([]);
    expect(snapshotTags("x")).toEqual([]);
  });

  it("array elements are stringified, trimmed, and blank-filtered", () => {
    expect(snapshotTags(["a", "  b  ", "", null, undefined, "  "])).toEqual(["a", "b"]);
  });
});





describe("buildReadonlyGanttSnapshotFromTasks", () => {
  it("metadata fields", () => {
    const snap = buildReadonlyGanttSnapshotFromTasks([], makeSettings(), "1.2.3");
    expect(snap.schemaVersion).toBe(2);
    expect(snap.source).toBe("obsidian-task-workbench");
    expect(snap.pluginVersion).toBe("1.2.3");
    expect(() => new Date(snap.generatedAt).toISOString()).not.toThrow();
  });

  it("includes all tag display flags in the settings snapshot", () => {
    const snap = buildReadonlyGanttSnapshotFromTasks(
      [],
      makeSettings({
        ganttShowTagsOnBars: false,
        ganttShowTagsOnParents: true,
        ganttShowParentTagsOnChildBars: false,
      }),
      "1.0.0"
    );
    expect(snap.settings.ganttShowTagsOnBars).toBe(false);
    expect(snap.settings.ganttShowTagsOnParents).toBe(true);
    expect(snap.settings.ganttShowParentTagsOnChildBars).toBe(false);
  });

  it("dayWidth mirrors ganttZoom", () => {
    const snap = buildReadonlyGanttSnapshotFromTasks(
      [],
      makeSettings({ ganttZoom: 42 }),
      "1.0.0"
    );
    expect(snap.dayWidth).toBe(42);
  });

  it("holidays is the 3-layer union, deduped+sorted", () => {
    const snap = buildReadonlyGanttSnapshotFromTasks(
      [],
      makeSettings({
        ganttNationalHolidays: ["2026-01-01"],
        ganttManualHolidays: ["2026-06-01", "2026-01-01"],
        ganttSpecialHolidays: ["2025-12-31"],
      }),
      "1.0.0"
    );
    expect(snap.holidays).toEqual(["2025-12-31", "2026-01-01", "2026-06-01"]);
  });

  it("G4: tagDefinitions pass through the registry, trim names, and drop empty names", () => {
    const snap = buildReadonlyGanttSnapshotFromTasks(
      [],
      makeSettings({
        ganttTags: [
          { key: "urgent-key", name: " urgent ", color: "", order: 25 },
          { key: "blank", name: "  ", color: "#000000", order: 50 },
          { key: "review-key", name: "review", color: "#ff0000", order: 75 },
        ],
      }),
      "1.0.0"
    );
    expect(snap.tagDefinitions).toEqual([
      { key: "urgent-key", name: "urgent", color: "", order: 25 },
      { key: "review-key", name: "review", color: "#ff0000", order: 75 },
    ]);
  });

  it("G3: events with empty/null/undefined date are dropped; empty title alone is kept", () => {
    const snap = buildReadonlyGanttSnapshotFromTasks(
      [],
      makeSettings({
        ganttEvents: [
          { key: "e1", title: "", date: "2026-03-01" },
          { key: "e2", title: "no date", date: "" },
          { key: "e3", title: "kept", date: "2026-04-01" },
        ] as any,
      }),
      "1.0.0"
    );
    expect(snap.events.map((e) => e.key)).toEqual(["e1", "e3"]);
  });

  it("only kind=parent && ganttEnabled=true tasks become snapshot parents", () => {
    const enabled = makeParent({ ganttEnabled: true });
    const disabled = makeParent({ ganttEnabled: false });
    const snap = buildReadonlyGanttSnapshotFromTasks(
      [enabled, disabled],
      makeSettings(),
      "1.0.0"
    );
    expect(snap.parents).toHaveLength(1);
    expect(snap.parents[0].id).toBe(enabled.id);
    expect(snap.parents[0].ganttEnabled).toBe(true); // forced true
  });

  it("finite ganttOrder is used as-is; missing/non-finite falls back to (sourceOrder+1)*1000", () => {
    const withOrder = makeParent({ ganttEnabled: true, ganttOrder: 500 });
    const withoutOrder = makeParent({ ganttEnabled: true, ganttOrder: undefined });
    const tasks = [withOrder, withoutOrder]; // sourceOrder 0 and 1 respectively
    const snap = buildReadonlyGanttSnapshotFromTasks(tasks, makeSettings(), "1.0.0");

    const byId = new Map(snap.parents.map((p) => [p.id, p]));
    expect(byId.get(withOrder.id)!.ganttOrder).toBe(500);
    expect(byId.get(withoutOrder.id)!.ganttOrder).toBe((1 + 1) * 1000); // sourceOrder=1
  });

  it("boundary values: string ganttOrder -> NaN -> fallback; negative -> valid; Infinity -> fallback; 0 -> valid frontmost", () => {
    const strOrder = makeParent({ ganttEnabled: true, ganttOrder: "abc" as any });
    const negOrder = makeParent({ ganttEnabled: true, ganttOrder: -5 });
    const infOrder = makeParent({ ganttEnabled: true, ganttOrder: Infinity });
    const zeroOrder = makeParent({ ganttEnabled: true, ganttOrder: 0 });
    const tasks = [strOrder, negOrder, infOrder, zeroOrder];
    const snap = buildReadonlyGanttSnapshotFromTasks(tasks, makeSettings(), "1.0.0");
    const byId = new Map(snap.parents.map((p) => [p.id, p]));

    expect(byId.get(strOrder.id)!.ganttOrder).toBe((0 + 1) * 1000); // fallback, sourceOrder=0
    expect(byId.get(negOrder.id)!.ganttOrder).toBe(-5); // valid, used as-is
    expect(byId.get(infOrder.id)!.ganttOrder).toBe((2 + 1) * 1000); // fallback, sourceOrder=2
    expect(byId.get(zeroOrder.id)!.ganttOrder).toBe(0); // valid, sorts frontmost

    // effectiveOrder ascending: -5 (negOrder) sorts before 0 (zeroOrder)
    expect(snap.parents[0].id).toBe(negOrder.id);
    expect(snap.parents[1].id).toBe(zeroOrder.id);
  });

  it("ties on effectiveOrder break by sourceOrder ascending", () => {
    const first = makeParent({ ganttEnabled: true, ganttOrder: 100 });
    const second = makeParent({ ganttEnabled: true, ganttOrder: 100 });
    // reversed insertion into `tasks` still resolves by sourceOrder, not array push order below
    const tasks = [second, first];
    const snap = buildReadonlyGanttSnapshotFromTasks(tasks, makeSettings(), "1.0.0");
    expect(snap.parents[0].id).toBe(second.id); // sourceOrder 0 in `tasks`
    expect(snap.parents[1].id).toBe(first.id); // sourceOrder 1
  });

  it("subtask fields, plan-date/workload/tags fallbacks", () => {
    const parent = makeParent({ ganttEnabled: true });
    const sub = makeSubtask(parent, "step-1", {
      plannedStartDate: undefined,
      plannedEndDate: undefined,
      workloadPlan: { "bad-date": 3, "2026-02-01": 4 },
      workloadActual: undefined,
      tags: ["x", "", null],
      ganttMarkers: undefined,
    });
    parent.subtasks!.set("step-1", sub);

    const snap = buildReadonlyGanttSnapshotFromTasks([parent], makeSettings(), "1.0.0");
    const subtaskOut = snap.parents[0].subtasks[0];

    expect(subtaskOut.kind).toBe("subtask");
    expect(subtaskOut.parentPath).toBe(parent.file.path);
    expect(subtaskOut.sourceOrder).toBe(0);
    expect(subtaskOut.plannedStartDate).toBe("");
    expect(subtaskOut.plannedEndDate).toBe("");
    expect(subtaskOut.workloadPlan).toEqual({ "2026-02-01": 4 }); // invalid date skipped, not thrown
    expect(subtaskOut.workloadActual).toEqual({});
    expect(subtaskOut.tags).toEqual(["x"]);
    expect(subtaskOut.ganttMarkers).toEqual([]);
  });

  it("parent id/path fall back to empty string when missing", () => {
    const parent = makeParent({ ganttEnabled: true, id: "", file: { path: "" } });
    const snap = buildReadonlyGanttSnapshotFromTasks([parent], makeSettings(), "1.0.0");
    expect(snap.parents[0].id).toBe("");
    expect(snap.parents[0].path).toBe("");
  });

  it("parent id falls back to file.path (not just to empty string) when id itself is blank but path is present", () => {
    const parent = makeParent({
      ganttEnabled: true,
      id: "",
      file: { path: "tasks/parent-a.md" },
    });
    const snap = buildReadonlyGanttSnapshotFromTasks([parent], makeSettings(), "1.0.0");
    expect(snap.parents[0].id).toBe("tasks/parent-a.md");
  });

  it("subtask id falls back to key (not just to empty string) when id itself is blank but key is present", () => {
    const parent = makeParent({ ganttEnabled: true });
    const sub = makeSubtask(parent, "step-1", { id: "" });
    parent.subtasks!.set("step-1", sub);

    const snap = buildReadonlyGanttSnapshotFromTasks([parent], makeSettings(), "1.0.0");
    expect(snap.parents[0].subtasks[0].id).toBe(sub.key);
  });
});





describe("syncReadonlyGanttSnapshot", () => {
  let state: GanttSyncState;

  beforeEach(() => {
    requestUrlMock.mockReset();
    state = { lastGanttSyncHash: "", lastGanttSyncAt: "" };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("no endpoint configured -> returns false, no request made, state untouched", async () => {
    const result = await syncReadonlyGanttSnapshot(
      [],
      makeSettings({ ganttSyncUrl: "" }),
      "1.0.0",
      state,
      false
    );
    expect(result).toBe(false);
    expect(requestUrlMock).not.toHaveBeenCalled();
    expect(state.lastGanttSyncHash).toBe("");
  });

  it("first sync (lastGanttSyncHash='') always runs even with force=false", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      json: {},
      text: "",
    });
    const settings = makeSettings({ ganttSyncUrl: "http://localhost:8787" });

    const result = await syncReadonlyGanttSnapshot([], settings, "1.0.0", state, false);

    expect(result).toBe(true);
    expect(requestUrlMock).toHaveBeenCalledTimes(1);
    expect(state.lastGanttSyncHash).not.toBe("");
  });

  it("unchanged content (same tasks/settings) hash-matches and is skipped when force=false", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      json: {},
      text: "",
    });
    const settings = makeSettings({ ganttSyncUrl: "http://localhost:8787" });

    await syncReadonlyGanttSnapshot([], settings, "1.0.0", state, false);
    requestUrlMock.mockClear();

    const result = await syncReadonlyGanttSnapshot([], settings, "1.0.0", state, false);

    expect(result).toBe(false);
    expect(requestUrlMock).not.toHaveBeenCalled();
  });

  it("ignores generatedAt-only changes when deciding whether to skip a hash", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      json: {},
      text: "",
    });
    const settings = makeSettings({ ganttSyncUrl: "http://localhost:8787" });

    await syncReadonlyGanttSnapshot([], settings, "1.0.0", state, false);
    requestUrlMock.mockClear();
    await new Promise((resolve) => setTimeout(resolve, 5)); // real clock tick

    const result = await syncReadonlyGanttSnapshot([], settings, "1.0.0", state, false);
    expect(result).toBe(false);
    expect(requestUrlMock).not.toHaveBeenCalled();
  });

  it("force=true bypasses the hash-unchanged skip and re-POSTs", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      json: {},
      text: "",
    });
    const settings = makeSettings({ ganttSyncUrl: "http://localhost:8787" });

    await syncReadonlyGanttSnapshot([], settings, "1.0.0", state, false);
    requestUrlMock.mockClear();

    const result = await syncReadonlyGanttSnapshot([], settings, "1.0.0", state, true);
    expect(result).toBe(true);
    expect(requestUrlMock).toHaveBeenCalledTimes(1);
  });

  it("a changed snapshot re-POSTs and updates lastGanttSyncHash", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      json: {},
      text: "",
    });
    const settings = makeSettings({ ganttSyncUrl: "http://localhost:8787", ganttZoom: 28 });
    await syncReadonlyGanttSnapshot([], settings, "1.0.0", state, false);
    const firstHash = state.lastGanttSyncHash;

    settings.ganttZoom = 99; // content changed
    const result = await syncReadonlyGanttSnapshot([], settings, "1.0.0", state, false);

    expect(result).toBe(true);
    expect(state.lastGanttSyncHash).not.toBe(firstHash);
  });

  it("POST body is {...snapshot, hash} to the normalized endpoint with the JSON content-type header", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      json: {},
      text: "",
    });
    const settings = makeSettings({ ganttSyncUrl: "http://localhost:8787" });

    await syncReadonlyGanttSnapshot([], settings, "1.0.0", state, false);

    expect(requestUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://localhost:8787/api/snapshot",
        method: "POST",
        headers: { "content-type": "application/json" },
      })
    );
    const call = requestUrlMock.mock.calls[0][0];
    const body = JSON.parse(call.body);
    expect(body.hash).toBe(state.lastGanttSyncHash);
    expect(body.schemaVersion).toBe(2);
  });

  it("a non-2xx response throws and does not update lastGanttSyncHash/lastGanttSyncAt", async () => {
    requestUrlMock.mockResolvedValue({
      status: 500,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      json: {},
      text: "",
    });
    const settings = makeSettings({ ganttSyncUrl: "http://localhost:8787" });

    await expect(
      syncReadonlyGanttSnapshot([], settings, "1.0.0", state, false)
    ).rejects.toThrow("Gantt sync failed: 500");
    expect(state.lastGanttSyncHash).toBe("");
    expect(state.lastGanttSyncAt).toBe("");
  });

  it("a network error (rejected request) propagates for the caller to catch", async () => {
    requestUrlMock.mockRejectedValue(new Error("network down"));
    const settings = makeSettings({ ganttSyncUrl: "http://localhost:8787" });

    await expect(
      syncReadonlyGanttSnapshot([], settings, "1.0.0", state, false)
    ).rejects.toThrow("network down");
  });

  it("G6: no auth header is ever attached", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      json: {},
      text: "",
    });
    const settings = makeSettings({ ganttSyncUrl: "http://localhost:8787" });

    await syncReadonlyGanttSnapshot([], settings, "1.0.0", state, false);

    const call = requestUrlMock.mock.calls[0][0];
    expect(Object.keys(call.headers)).toEqual(["content-type"]);
  });
});
