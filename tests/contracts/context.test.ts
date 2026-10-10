import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { dateOnlySchema, jsonSchema, readResultSchema, compactTaskSchema, publicSettingsSchema, contextQueryInputSchemas, contextQueryOutputSchemas, taskHoursCellSchema, contributionHoursCellSchema, workloadContributionSchema, CONTEXT_CURSOR_RULES, CONTEXT_QUERY_LIMITS, operationErrorSchema, type ContextQueryId } from "../../src/contracts/context";
import { operationPreviewSchema, previewEntrySchema } from "../../src/contracts/preview";
import { operationInputSchemas } from "../../src/contracts/operations";
import type { ContextReadPort } from "../../src/contracts/ports";
import { READ_FIXTURES, PREVIEW_FIXTURES, PARENT_ID, DATE, CONTEXT_QUERY_FIXTURES, CONTEXT_QUERY_OUTPUT_FIXTURES, STALE_CURSOR_ERROR } from "./fixtures";

describe("P0 read DTO", () => {
  it.each(Object.entries(READ_FIXTURES))("%s survives a JSON roundtrip", (_name, fixture) => {
    expect(readResultSchema.parse(JSON.parse(JSON.stringify(fixture)))).toEqual(fixture);
  });
  it("keeps missing fields, null dates, empty arrays and children not fetched distinct", () => {
    const parent = { id: PARENT_ID, kind: "parent", parentId: null, name: "リリース", revision: "content-sha256:parent" };
    const absent = compactTaskSchema.parse(parent);
    expect(absent).not.toHaveProperty("children");
    expect(compactTaskSchema.parse({ ...parent, children: [] })).toHaveProperty("children", []);
    expect(compactTaskSchema.parse({ ...parent, due: null })).toHaveProperty("due", null);
    expect(compactTaskSchema.safeParse({ ...parent, schedule: { start: "2026-10-13", end: "2026-10-15", due: null } }).success).toBe(false);
    expect(compactTaskSchema.safeParse({ ...READ_FIXTURES.tasks.data.items[0], parentId: null }).success).toBe(false);
    expect(READ_FIXTURES.tasks.data.items[0]).not.toHaveProperty("content");
  });
  it("rejects silent truncation, incorrect counts and fields falsely marked fetched", () => {
    const fixture = READ_FIXTURES.tasks;
    expect(readResultSchema.safeParse({ ...fixture, data: { ...fixture.data, nextCursor: null } }).success).toBe(false);
    expect(readResultSchema.safeParse({ ...fixture, data: { ...fixture.data, returned: 20 } }).success).toBe(false);
    expect(readResultSchema.safeParse({ ...fixture, data: { ...fixture.data, fieldsIncluded: [...fixture.data.fieldsIncluded, "markers"] } }).success).toBe(false);
    expect(readResultSchema.safeParse({ ...fixture, data: { ...fixture.data, items: [{ ...fixture.data.items[0], markers: [] }] } }).success).toBe(false);
  });
  it("reports parse failures separately from empty data", () => {
    const fixture = READ_FIXTURES.tasks;
    const result = readResultSchema.parse({ ...fixture, data: { kind: "tasks", fieldsIncluded: ["identity"], items: [], totalMatched: 0, returned: 0, truncated: false, nextCursor: null },
      errors: [{ code: "PARSE_FAILED", targetId: "tasks/broken.md", detail: "不正なfrontmatter" }] });
    expect(result.errors).toHaveLength(1);
    expect(readResultSchema.safeParse({ ...result, errors: [] }).success).toBe(true);
  });
  it("validates real calendar dates and never treats an empty date as DateOnly", () => {
    for (const date of ["2024-02-29", "2026-10-09", "2000-02-29"]) expect(dateOnlySchema.safeParse(date).success).toBe(true);
    for (const date of ["", "2026-02-29", "2026-04-31", "1900-02-29", "2026-1-01", "2026-10-09T00:00:00Z"]) expect(dateOnlySchema.safeParse(date).success).toBe(false);
  });
  it("excludes management fields, tokens and non-JSON values", () => {
    for (const value of [{ token: "secret" }, { lastAutoPriorityUpdate: "2026-10-09" }, { agentToolsEnabled: true }]) expect(publicSettingsSchema.safeParse(value).success).toBe(false);
    for (const value of [new Map(), new Date(), { callback: () => undefined }, { value: undefined }, NaN, Infinity]) expect(jsonSchema.safeParse(value).success).toBe(false);
    expect(readResultSchema.safeParse(PREVIEW_FIXTURES.create).success).toBe(false);
    expect(operationPreviewSchema.safeParse(READ_FIXTURES.tasks).success).toBe(false);
  });
});

describe("section 7 context acquisition contracts", () => {
  it.each(Object.keys(CONTEXT_QUERY_FIXTURES) as ContextQueryId[])("%s has validated input, typed read output and JSON schemas", (id) => {
    expect(contextQueryInputSchemas[id].safeParse(CONTEXT_QUERY_FIXTURES[id]).success).toBe(true);
    expect(contextQueryOutputSchemas[id].safeParse({ status: "success", result: CONTEXT_QUERY_OUTPUT_FIXTURES[id] }).success).toBe(true);
    expect(z.toJSONSchema(contextQueryInputSchemas[id]).type).toBe("object");
    expect(z.toJSONSchema(contextQueryOutputSchemas[id]).oneOf).toHaveLength(2);
    expect(contextQueryInputSchemas[id].safeParse({ ...CONTEXT_QUERY_FIXTURES[id], origin: { kind: "ui" } }).success).toBe(false);
  });
  it("bounds pages/details and fixes workload's 31-day default and 366-day maximum", () => {
    expect(contextQueryInputSchemas["tasks.search"].parse({}).limit).toBe(20);
    expect(contextQueryInputSchemas["projects.get"].parse({ parentTaskId: PARENT_ID }).includeChildren).toBe(false);
    expect(contextQueryInputSchemas["tasks.search"].safeParse({ limit: 101 }).success).toBe(false);
    expect(contextQueryInputSchemas["tasks.get-many"].safeParse({ taskIds: Array(21).fill(PARENT_ID) }).success).toBe(false);
    expect(contextQueryInputSchemas["workload.get"].parse({})).toEqual({ mode: "both", detail: false });
    expect(CONTEXT_QUERY_LIMITS.workloadDefaultDays).toBe(31);
    expect(contextQueryInputSchemas["workload.get"].safeParse({ from: "2026-01-01", to: "2027-01-01" }).success).toBe(true);
    expect(contextQueryInputSchemas["workload.get"].safeParse({ from: "2026-01-01", to: "2027-01-02" }).success).toBe(false);
    expect(contextQueryInputSchemas["workload.get"].safeParse({ from: DATE }).success).toBe(false);
    expect(contextQueryInputSchemas["calendar.get"].safeParse({ from: "2026-10-15", to: DATE }).success).toBe(false);
    expect(contextQueryInputSchemas["settings.get"].safeParse({ sections: ["secrets"] }).success).toBe(false);
    expectTypeOf<keyof ContextReadPort>().toEqualTypeOf<"query">();
  });
  it("accepts CURSOR_STALE and RESET_REQUIRED with explicit restart instructions", () => {
    expect(operationErrorSchema.safeParse(STALE_CURSOR_ERROR).success).toBe(true);
    expect(operationErrorSchema.safeParse({ ...STALE_CURSOR_ERROR, nextAction: "" }).success).toBe(false);
    for (const id of Object.keys(contextQueryOutputSchemas) as ContextQueryId[]) expect(contextQueryOutputSchemas[id].safeParse({ status: "error", error: STALE_CURSOR_ERROR }).success).toBe(true);
    expect(contextQueryOutputSchemas["calendar.get"].safeParse({ status: "success", result: CONTEXT_QUERY_OUTPUT_FIXTURES["settings.get"] }).success).toBe(false);
    const error = { code: "CURSOR_STALE", detail: "対象が更新されました", nextAction: CONTEXT_CURSOR_RULES.CURSOR_STALE };
    expect(readResultSchema.safeParse({ ...READ_FIXTURES.tasks, errors: [error] }).success).toBe(true);
    expect(readResultSchema.safeParse({ ...READ_FIXTURES.tasks, errors: [{ code: "CURSOR_STALE", detail: "対象が更新されました" }] }).success).toBe(false);
    expect(contextQueryOutputSchemas["context.changes"].safeParse({ status: "error", error: { code: "RESET_REQUIRED", retryable: true, nextAction: CONTEXT_CURSOR_RULES.RESET_REQUIRED } }).success).toBe(true);
  });
  it("allows a normalized 1500-minute weekly contribution while preserving task/event limits", () => {
    expect(operationInputSchemas.W01.safeParse({ title: "長い定例", dayOfWeek: 2, minutesPerWeek: 1500 }).success).toBe(true);
    const cell = { date: DATE, plan: 1500 / 60, actual: 0 };
    expect(contributionHoursCellSchema.safeParse(cell).success).toBe(true);
    expect(taskHoursCellSchema.safeParse(cell).success).toBe(false);
    expect(workloadContributionSchema.safeParse({ kind: "weekly", id: "weekly-1500", cells: [cell] }).success).toBe(true);
    for (const kind of ["task", "event"]) expect(workloadContributionSchema.safeParse({ kind, id: "id-1", cells: [cell] }).success).toBe(false);
    const output = CONTEXT_QUERY_OUTPUT_FIXTURES["workload.get"];
    expect(output.data.contributions[1].cells[0].plan).toBe(25);
    expect(output.data.days[0]).toMatchObject({ plan: 26.5, capacity: 7, overCapacity: true });
    expect(output.data.contributions.reduce((sum, contribution) => sum + contribution.cells[0].plan, 0)).toBe(output.data.days[0].plan);
    const entry = { actionId: "weekly-action", entity: { kind: "weekly", scheduleKey: "weekly-1500" }, displayName: "長い定例", effects: [{ kind: "workload", cells: [{ date: DATE, before: { ...cell, plan: 0 }, after: cell }] }] };
    expect(previewEntrySchema.safeParse(entry).success).toBe(true);
    expect(previewEntrySchema.safeParse({ ...entry, entity: { kind: "event", eventKey: "event-1" } }).success).toBe(false);
  });
});
