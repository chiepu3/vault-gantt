import { describe, expect, expectTypeOf, it } from "vitest";
import type { OperationPlan } from "../../src/app/operation-registry";
import { adaptLegacyOperationPlan } from "../../src/contracts/legacy-operation-plan";
import { operationPreviewSchema, operationOutcomeSchema, previewEffectSchema, ganttProjectionSchema, PREVIEW_EFFECT_KINDS, mergeProjectionPages, validatePreviewOutcome, projectionPageRequestSchema, projectionPageResultSchema, entityRefKey } from "../../src/contracts/preview";
import { OPERATION_CONTRACTS, type ExternalRequestOperationId } from "../../src/contracts/operations";
import { historyEntryUndoStateSchema, historyChangeSchema, type HistoryPort, type HumanApprovalPort, type OperationService, type PreviewPort, type PreviewUiHostPorts } from "../../src/contracts/ports";
import { PREVIEW_FIXTURES, EFFECT_FIXTURES, PARTIAL_PREVIEW, PARTIAL_OUTCOME, CHILD_ID, SECOND_CHILD_ID, SECOND_PARENT_ID, PROJECTION_PAGE_FIXTURES, BOUNDARY_OUTCOMES, PROJECTION_STALE_ERROR } from "./fixtures";

describe("P0 preview contracts", () => {
  it.each(Object.entries(PREVIEW_FIXTURES))("%s is schema-valid JSON", (_name, fixture) => {
    const wire = JSON.parse(JSON.stringify(fixture));
    expect(operationPreviewSchema.parse(wire)).toEqual(fixture);
    const allowed: readonly string[] = OPERATION_CONTRACTS[fixture.operationId][1];
    for (const entry of fixture.entries) for (const effect of entry.effects) expect(allowed).toContain(effect.kind);
  });
  it("has a representative fixture for all 17 effect kinds", () => {
    expect(EFFECT_FIXTURES.map((effect) => effect.kind)).toEqual(PREVIEW_EFFECT_KINDS);
    for (const fixture of EFFECT_FIXTURES) expect(previewEffectSchema.parse(fixture)).toEqual(fixture);
  });
  it("requires the entity's public fields and forbids unknown or secret fields", () => {
    const fixture = PREVIEW_FIXTURES.settings;
    const entry = fixture.entries[0];
    const effect = entry.effects[0];
    if (effect.kind !== "settings") throw new Error("settings fixture required");
    for (const field of ["token", "secret", "completed", "lastAutoPriorityUpdate"]) {
      const tampered = { ...fixture, entries: [{ ...entry, effects: [{ ...effect, fields: [{ ...effect.fields[0], field }] }] }] };
      expect(operationPreviewSchema.safeParse(tampered).success).toBe(false);
    }
  });
  it("rejects missing actions, duplicate IDs, invalid periods and invalid workload dates", () => {
    expect(operationPreviewSchema.safeParse({ ...PARTIAL_PREVIEW, entries: PARTIAL_PREVIEW.entries.slice(0, 1) }).success).toBe(false);
    expect(operationPreviewSchema.safeParse({ ...PARTIAL_PREVIEW, entries: [PARTIAL_PREVIEW.entries[0], PARTIAL_PREVIEW.entries[0], PARTIAL_PREVIEW.entries[2]] }).success).toBe(false);
    expect(operationPreviewSchema.safeParse({ ...PREVIEW_FIXTURES.create, expiresAt: PREVIEW_FIXTURES.create.createdAt }).success).toBe(false);
    expect(operationPreviewSchema.safeParse({ ...PREVIEW_FIXTURES.create, status: "approved" }).success).toBe(false);
    expect(previewEffectSchema.safeParse({ kind: "schedule", before: { start: null, end: null }, after: { start: "2026-10-15", end: "2026-10-13" }, unit: "calendar-day" }).success).toBe(false);
    expect(previewEffectSchema.safeParse({ kind: "workload", cells: [{ date: "2026-10-13", before: { date: "2026-10-14", plan: 1, actual: 0 }, after: { date: "2026-10-13", plan: 2, actual: 0 } }] }).success).toBe(false);
  });
  it("shows explicit truncation and uses independent before/after snapshots", () => {
    const projection = PREVIEW_FIXTURES.workload.projection!;
    expect(projection.before).not.toBe(projection.after);
    expect(projection.before.parents[0].children[0]).not.toBe(projection.after.parents[0].children[0]);
    expect(projection.before.parents[0].children[0].hours[0].plan).toBe(1.5);
    expect(projection.after.parents[0].children[0].hours[0].plan).toBe(2);
    expect(projection.after.aggregates[0].plan).toBe(2);
    const truncated = PROJECTION_PAGE_FIXTURES[0].projection;
    expect(ganttProjectionSchema.safeParse(truncated).success).toBe(true);
    expect(ganttProjectionSchema.safeParse({ ...truncated, coverage: { ...truncated.coverage, nextCursor: null } }).success).toBe(false);
    expect(ganttProjectionSchema.safeParse({ ...truncated, coverage: { ...truncated.coverage, truncated: false } }).success).toBe(false);
    // A single target cannot claim 100 included entities, even when all scalar counts look valid.
    expect(ganttProjectionSchema.safeParse({ ...projection, coverage: { targetCount: 101, offset: 0, includedCount: 100, truncated: true, nextCursor: "projection-cursor" } }).success).toBe(false);
  });
  it("matches partial results to action IDs and preserves only saved actual effects", () => {
    expect(operationOutcomeSchema.parse(PARTIAL_OUTCOME)).toEqual(PARTIAL_OUTCOME);
    expect(PARTIAL_OUTCOME.actions.map((action) => action.actionId)).toEqual(PARTIAL_PREVIEW.entries.map((entry) => entry.actionId));
    expect(PARTIAL_OUTCOME.actions.filter((action) => action.actual.length > 0).map((action) => action.state)).toEqual(["committed"]);
    expect(operationOutcomeSchema.safeParse({ ...PARTIAL_OUTCOME, status: "success" }).success).toBe(false);
    expect(operationOutcomeSchema.safeParse({ ...PARTIAL_OUTCOME, actions: PARTIAL_OUTCOME.actions.map((action) => ({ ...action, actual: PARTIAL_OUTCOME.actions[0].actual })) }).success).toBe(false);
    expect(operationOutcomeSchema.safeParse({ ...PARTIAL_OUTCOME, actions: PARTIAL_OUTCOME.actions.slice(0, 1) }).success).toBe(false);
  });
  it("keeps human approval separate from model service and preview inspection", () => {
    expectTypeOf<keyof HumanApprovalPort>().toEqualTypeOf<"approve">();
    expectTypeOf<keyof OperationService>().toEqualTypeOf<"describe" | "read" | "propose" | "request" | "inspect">();
    expectTypeOf<keyof PreviewPort>().toEqualTypeOf<"list" | "inspect" | "focusedPreviewId" | "inspectOutcome" | "subscribe" | "focus" | "reject" | "requestRepreview" | "getProjectionPage">();
    expectTypeOf<PreviewUiHostPorts["humanApprovalPort"]>().toEqualTypeOf<HumanApprovalPort>();
    expect(PREVIEW_FIXTURES.mcpOrigin.origin).toEqual({ kind: "mcp", principalId: "principal-fixture", clientLabel: "ローカルMCPクライアント" });
    expect(PREVIEW_FIXTURES.mcpOrigin.status).toBe("pending");
    expectTypeOf<Extract<ExternalRequestOperationId, "V14">>().toEqualTypeOf<never>();
  });
});

describe("projection detail pages", () => {
  it("accepts preview+cursor requests and merges real targets without summing repeated aggregates", () => {
    expect(projectionPageRequestSchema.parse({ previewId: PARTIAL_PREVIEW.previewId, cursor: "projection-page-2", projectionKind: "planned" })).toHaveProperty("cursor", "projection-page-2");
    for (const page of PROJECTION_PAGE_FIXTURES) expect(projectionPageResultSchema.safeParse({ status: "success", page }).success).toBe(true);
    expect(projectionPageResultSchema.safeParse({ status: "error", error: PROJECTION_STALE_ERROR }).success).toBe(true);
    const merged = mergeProjectionPages(PROJECTION_PAGE_FIXTURES);
    expect(merged).toEqual(PARTIAL_PREVIEW.projection);
    expect(merged.targets.map(entityRefKey)).toEqual(PARTIAL_PREVIEW.entries.map((entry) => entityRefKey(entry.entity)));
    expect(merged.before.parents).toHaveLength(2);
    expect(merged.after.aggregates[0].plan).toBe(18);
    expect(merged.coverage).toEqual({ targetCount: 3, offset: 0, includedCount: 3, truncated: false, nextCursor: null });
    expect(mergeProjectionPages(PROJECTION_PAGE_FIXTURES.slice(0, 1)).coverage.truncated).toBe(true);
  });
  it("rejects Vault/preview/mode/revision/date/timezone drift", () => {
    const [first, second] = PROJECTION_PAGE_FIXTURES;
    for (const field of ["baseRevision", "settingsRevision", "calendarRevision", "evaluatedDate", "timezone"] as const) {
      const value = field === "evaluatedDate" ? "2026-10-10" : "different";
      expect(() => mergeProjectionPages([first, { ...second, projection: { ...second.projection, [field]: value } }])).toThrow("CURSOR_STALE");
    }
    expect(() => mergeProjectionPages([first, { ...second, previewId: "other-preview" }])).toThrow("CURSOR_STALE");
    expect(() => mergeProjectionPages([first, { ...second, vaultInstanceId: "other-vault" }])).toThrow("CURSOR_STALE");
    expect(() => mergeProjectionPages([first, { ...second, projectionKind: "actual" }])).toThrow("CURSOR_STALE");
    expect(() => mergeProjectionPages([first, { ...second, projection: { ...second.projection, after: { ...second.projection.after, aggregates: [{ ...second.projection.after.aggregates[0], plan: 19 }] } } }])).toThrow("CURSOR_STALE");
  });
  it("rejects out-of-order, skipped, repeated and forged pages", () => {
    const [first, second] = PROJECTION_PAGE_FIXTURES;
    expect(() => mergeProjectionPages([second, first])).toThrow("INVALID_INPUT");
    expect(() => mergeProjectionPages([first, { ...second, requestCursor: "wrong-cursor" }])).toThrow("INVALID_INPUT");
    expect(() => mergeProjectionPages([first, { ...second, projection: { ...second.projection, coverage: { ...second.projection.coverage, offset: 1, truncated: true, nextCursor: "forged" } } }])).toThrow("INVALID_INPUT");
    expect(() => mergeProjectionPages([first, { ...second, projection: { ...second.projection, targets: [first.projection.targets[0]], visibility: [first.projection.visibility[0]] } }])).toThrow("INVALID_INPUT");
    expect(ganttProjectionSchema.safeParse({ ...first.projection, targets: [{ kind: "task", taskId: "missing.md" }, first.projection.targets[1]], visibility: [{ ...first.projection.visibility[0], entity: { kind: "task", taskId: "missing.md" } }, first.projection.visibility[1]] }).success).toBe(false);
  });
});

describe("outcome matching and actual projection", () => {
  it("rejects missing or unknown actions even if the standalone outcome calls itself success", () => {
    const missing = { ...PARTIAL_OUTCOME, status: "success", actions: PARTIAL_OUTCOME.actions.slice(0, 1) };
    expect(operationOutcomeSchema.safeParse(missing).success).toBe(true);
    expect(() => validatePreviewOutcome(PARTIAL_PREVIEW, missing)).toThrow("action ID集合");
    expect(() => validatePreviewOutcome(PARTIAL_PREVIEW, { ...PARTIAL_OUTCOME, actions: PARTIAL_OUTCOME.actions.slice(0, 2) })).toThrow("action ID集合");
    expect(() => validatePreviewOutcome(PARTIAL_PREVIEW, { ...PARTIAL_OUTCOME, actions: PARTIAL_OUTCOME.actions.map((action, index) => index === 1 ? { ...action, actionId: "unknown-action" } : action) })).toThrow("action ID集合");
    expect(() => validatePreviewOutcome(PARTIAL_PREVIEW, { ...PARTIAL_OUTCOME, previewId: "other-preview" })).toThrow("別preview");
    expect(validatePreviewOutcome(PARTIAL_PREVIEW, { ...PARTIAL_OUTCOME, actions: [...PARTIAL_OUTCOME.actions].reverse() })).toHaveProperty("status", "partial");
  });
  it("requires an actual projection and forbids projecting uncommitted actions", () => {
    expect(() => validatePreviewOutcome(PARTIAL_PREVIEW, { ...PARTIAL_OUTCOME, actualProjection: null })).toThrow("actualProjectionが必要");
    expect(() => validatePreviewOutcome(PARTIAL_PREVIEW, { ...PARTIAL_OUTCOME, actualProjection: PARTIAL_PREVIEW.projection })).toThrow("未保存target");
    expect(() => validatePreviewOutcome(PARTIAL_PREVIEW, { ...PARTIAL_OUTCOME, actualProjection: { ...PARTIAL_OUTCOME.actualProjection!, baseRevision: "different" } })).toThrow("同じbefore前提");
    expect(validatePreviewOutcome(PARTIAL_PREVIEW, PARTIAL_OUTCOME)).toEqual(PARTIAL_OUTCOME);
  });
  it("keeps saved totals/color/visibility and failed targets distinct from the planned after state", () => {
    const actual = PARTIAL_OUTCOME.actualProjection!, planned = PARTIAL_PREVIEW.projection!;
    expect(actual.before.aggregates[0]).toEqual({ date: "2026-10-13", plan: 3.5, actual: 1, capacity: 7, overCapacity: false });
    expect(actual.after.aggregates[0]).toEqual({ date: "2026-10-13", plan: 10, actual: 1, capacity: 7, overCapacity: true });
    expect(planned.after.aggregates[0].plan).toBe(18);
    expect(actual.targets).toEqual([PARTIAL_PREVIEW.entries[0].entity]);
    expect(actual.visibility[0]).toMatchObject({ entity: { taskId: CHILD_ID }, state: "filtered", reason: "選択タグ「対象」に一致しない" });
    expect(actual.before.parents[0].children[0].appearance.color).toBe("#4488cc");
    expect(actual.after.parents[0].children[0].appearance.color).toBe("#cc3344");
    expect(actual.after.parents[1].children[0]).toMatchObject({ id: SECOND_CHILD_ID, tags: ["対象"], appearance: { color: "#4488cc" }, hours: [{ date: "2026-10-13", plan: 2, actual: 0 }] });
    expect(actual.after.parents[1]).toMatchObject({ id: SECOND_PARENT_ID, name: "別リリース" });
    expect(PARTIAL_OUTCOME.actions.filter((action) => action.state === "committed").map((action) => action.actionId)).toEqual(["partial-fixture:0"]);
  });
  it.each([
    [PREVIEW_FIXTURES.oneSided, BOUNDARY_OUTCOMES.oneSided, "unscheduled", 1.5],
    [PREVIEW_FIXTURES.filtered, BOUNDARY_OUTCOMES.filtered, "filtered", 1.5],
    [PREVIEW_FIXTURES.settings, BOUNDARY_OUTCOMES.featureDisabled, "feature-disabled", 1.5],
    [PREVIEW_FIXTURES.outsideRange, BOUNDARY_OUTCOMES.outsideRange, "outside-range", 1.5],
  ] as const)("%s has consistent entity, effects, projection and saved outcome", (preview, outcome, visibility, total) => {
    const result = validatePreviewOutcome(preview, outcome);
    expect(result.actualProjection!.targets.map(entityRefKey)).toEqual(preview.entries.map((entry) => entityRefKey(entry.entity)));
    expect(result.actions[0].actual).toEqual(preview.entries[0].effects);
    expect(result.actualProjection!.visibility[0].state).toBe(visibility);
    expect(result.actualProjection!.visibility[0].reason.length).toBeGreaterThan(0);
    expect(result.actualProjection!.after.aggregates[0].plan).toBe(total);
    if (visibility === "unscheduled") expect(result.actualProjection!.after.parents[0].children[0].period).toEqual({ start: null, end: "2026-10-15" });
    if (visibility === "feature-disabled") {
      expect(result.actualProjection!.after.settings.ganttFeatureWorkloadEnabled).toBe(false);
      expect(result.actualProjection!.after.parents[0].children[0].hours).toEqual(result.actualProjection!.before.parents[0].children[0].hours);
    }
    if (visibility === "outside-range") expect(result.actualProjection!.after.parents[0].children[0].period).toEqual({ start: "2026-12-13", end: "2026-12-15" });
  });
});

describe("live entry-specific Undo contract", () => {
  it("includes entry identity, current history revision and explicit blocking reasons", () => {
    for (const state of ["available", "not-latest", "conflict", "invalidated", "missing", "busy", "already-undone"] as const) {
      expect(historyEntryUndoStateSchema.safeParse({ entryId: "undo-1", historyRevision: "history-r2", state, reason: state === "available" ? null : "現在は実行できません" }).success).toBe(true);
    }
    expect(historyEntryUndoStateSchema.safeParse({ state: "available" }).success).toBe(false);
    expect(historyChangeSchema.parse({ historyRevision: "history-r3", changedEntryIds: null })).toHaveProperty("changedEntryIds", null);
    expect(historyChangeSchema.parse({ historyRevision: "history-r4", changedEntryIds: ["undo-1"] })).toHaveProperty("changedEntryIds", ["undo-1"]);
    expectTypeOf<keyof HistoryPort>().toEqualTypeOf<"inspectUndo" | "subscribe">();
    expectTypeOf<PreviewUiHostPorts["historyPort"]>().toEqualTypeOf<HistoryPort>();
  });
});

describe("legacy plan descriptor", () => {
  const metadata = { vaultInstanceId: "vault-1", origin: { kind: "chat", conversationId: "chat-1" } as const, createdAt: "2026-10-09T03:00:00Z", expiresAt: "2026-10-09T03:10:00Z" };
  it("does not show an irrelevant timeline for a non-schedule update", () => {
    const plan: OperationPlan = { previewId: "legacy-1", operation: "update", summary: "1件", count: 1,
      diffs: [{ taskId: CHILD_ID, name: "レビュー", fields: [{ field: "notes", before: "", after: "new" }], schedule: { before: { start: "2026-10-13", end: "2026-10-15" }, after: { start: "2026-10-13", end: "2026-10-15" } } }] };
    const result = adaptLegacyOperationPlan(plan, { ...metadata, input: { taskId: CHILD_ID, patch: { notes: "new" } } });
    expect(result.entries[0].effects.map((effect) => effect.kind)).toEqual(["fields"]);
  });
  it("includes normalized, derived, deadline and marker changes without mutating the old plan", () => {
    const plan: OperationPlan = { previewId: "legacy-2", operation: "update", summary: "1件", count: 1, diffs: [{ taskId: CHILD_ID, name: "レビュー", fields: [
      { field: "displayName", before: "旧名", after: "変更名" }, { field: "title", before: "旧名", after: "変更名" },
      { field: "updatedAt", before: "2026-10-08", after: "2026-10-09" }, { field: "dueDate", before: "2026-10-15", after: "" },
      { field: "ganttMarkers", before: [], after: [{ key: "m1", title: "確認", date: "2026-10-13" }] },
      { field: "workloadPlan", before: { "2026-10-13": 1 }, after: { "2026-10-13": 1.5 } },
    ] }] };
    const before = structuredClone(plan);
    const result = adaptLegacyOperationPlan(plan, { ...metadata, input: { taskId: CHILD_ID, patch: { displayName: " 変更名 ", dueDate: "", ganttMarkers: [{ key: "m1", title: "確認", date: "2026-10-13" }], workloadPlan: { "2026-10-13": 1.3 } } } });
    const effect = result.entries[0].effects[0];
    if (effect.kind !== "fields") throw new Error("field effect required");
    expect(effect.fields.find((field) => field.field === "displayName")?.reason).toBe("normalized");
    expect(effect.fields.find((field) => field.field === "title")?.reason).toBe("derived");
    expect(effect.fields.find((field) => field.field === "updatedAt")?.reason).toBe("derived");
    expect(result.entries[0].effects).toContainEqual({ kind: "deadline", before: "2026-10-15", after: null });
    expect(result.entries[0].effects).toContainEqual({ kind: "marker", before: null, after: { key: "m1", title: "確認", date: "2026-10-13", tags: [] } });
    expect(result.entries[0].effects.some((effect) => effect.kind === "workload")).toBe(false);
    expect(result.warnings.map((warning) => warning.code)).toContain("LEGACY_WORKLOAD_FIELDS_ONLY");
    expect(plan).toEqual(before);
    expect(result.undo.support).toBe("none");
  });
});
