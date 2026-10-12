import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OPERATION_IDS, OPERATION_CONTRACTS, operationIdSchema, operationInputSchemas, operationOutputSchemas, taskPatchInputSchema, IMMEDIATE_PERSISTENCE, DIRECT_UI_ONLY_OPERATION_IDS, operationRequestDenial } from "../../src/contracts/operations";
import { PREVIEW_EFFECT_KINDS } from "../../src/contracts/preview";
import { DEFAULT_CAPABILITIES, INITIAL_POLICY } from "../../src/contracts/context";
import { adaptLegacyOperationInput, adaptLegacyOperationPlan, LEGACY_OPERATION_IDS } from "../../src/contracts/legacy-operation-plan";
import { OPERATION_MANIFEST, OperationRegistry, patchSchema } from "../../src/app/operation-registry";
import { HistoryManager } from "../../src/app/history-manager";
import { createTask, addSubtask } from "../../src/app/task-operations";
import { DEFAULT_SETTINGS } from "../../src/core/constants";
import { FakeVault } from "../app/fake-vault";
import { INPUT_FIXTURES, PREVIEW_FIXTURES, READ_FIXTURES } from "./fixtures";

describe("P0 operation ledger", () => {
  it("matches all 123 design ledger IDs with no duplicates or gaps", () => {
    const design = readFileSync(new URL("../../docs/ai/DESIGN.md", import.meta.url), "utf8");
    const ledgerSection = design.slice(design.indexOf("### 3.1"), design.indexOf("### 3.8"));
    const ledger = [...ledgerSection.matchAll(/^\| ([TMEWDSVQ]\d{2}) \|/gm)].map((match) => match[1]);
    expect(OPERATION_IDS).toHaveLength(123);
    expect(new Set(OPERATION_IDS).size).toBe(123);
    expect(OPERATION_IDS).toEqual(ledger);
    expect(Object.keys(operationInputSchemas)).toEqual(OPERATION_IDS);
    expect(Object.keys(operationOutputSchemas)).toEqual(OPERATION_IDS);
    expect(Object.keys(OPERATION_CONTRACTS)).toEqual(OPERATION_IDS);
    expect(operationIdSchema.safeParse("T31").success).toBe(false);
  });
  it.each(OPERATION_IDS)("%s has a valid example, JSON input schema, classification and effect mapping", (id) => {
    expect(operationInputSchemas[id].safeParse(INPUT_FIXTURES[id]).success).toBe(true);
    expect(z.toJSONSchema(operationInputSchemas[id]).type).toBe("object");
    expect(z.toJSONSchema(operationOutputSchemas[id]).type).toBe("object");
    const [classification, effects, capabilities] = OPERATION_CONTRACTS[id];
    expect(["read", "view", "write", "control"]).toContain(classification);
    expect(capabilities.length).toBeGreaterThan(0);
    expect(new Set(effects).size).toBe(effects.length);
    for (const kind of effects) expect(PREVIEW_EFFECT_KINDS).toContain(kind);
    if (classification === "read") expect(effects).toEqual([]);
    else expect(effects.length).toBeGreaterThan(0);
  });
  it("classifies hidden persistence and external side effects explicitly", () => {
    const ids = OPERATION_IDS.filter((id) => OPERATION_CONTRACTS[id][0] === "read");
    expect(ids).toEqual(["T01", "T02", "D01"]);
    expect(OPERATION_CONTRACTS.D08[0]).toBe("view");
    expect(OPERATION_CONTRACTS.D09[0]).toBe("write");
    expect(OPERATION_CONTRACTS.V14).toEqual(["view", ["view", "settings"], ["ui"]]);
    expect(OPERATION_CONTRACTS.V20[0]).toBe("write");
    expect(OPERATION_CONTRACTS.V23[0]).toBe("write");
    for (const id of ["S18", "S19", "S20", "S21"] as const) {
      expect(OPERATION_CONTRACTS[id][1]).toContain("external-send");
      expect(OPERATION_CONTRACTS[id][2]).toContain("external");
    }
    expect(OPERATION_CONTRACTS.Q07[0]).toBe("control");
    expect(DEFAULT_CAPABILITIES).toEqual(["read", "propose"]);
    expect(INITIAL_POLICY.autoExecute).toBe(false);
  });
  it("keeps read, pending preview and immediate request outputs separate", () => {
    expect(operationOutputSchemas.T01.safeParse(READ_FIXTURES.tasks).success).toBe(true);
    expect(operationOutputSchemas.T02.safeParse(READ_FIXTURES.tasks).success).toBe(true);
    expect(operationOutputSchemas.D01.safeParse(READ_FIXTURES.daily).success).toBe(true);
    expect(operationOutputSchemas.T01.safeParse(PREVIEW_FIXTURES.create).success).toBe(false);
    expect(operationOutputSchemas.D01.safeParse(READ_FIXTURES.tasks).success).toBe(false);
    expect(operationOutputSchemas.T06.safeParse(PREVIEW_FIXTURES.create).success).toBe(true);
    expect(operationOutputSchemas.T26.safeParse(PREVIEW_FIXTURES.create).success).toBe(false);
    const request = { schemaVersion: 1, resultKind: "request", operationId: "Q07", status: "requested", effects: [] };
    expect(operationOutputSchemas.Q07.safeParse(request).success).toBe(true);
    expect(operationOutputSchemas.V01.safeParse(request).success).toBe(false);
    expect(operationOutputSchemas.Q08.safeParse(PREVIEW_FIXTURES.delete).success).toBe(true);
  });
  it("audits every view/control persistence boundary and rejects V14 outside direct human UI", () => {
    const immediate = OPERATION_IDS.filter((id) => ["view", "control"].includes(OPERATION_CONTRACTS[id][0]));
    expect(Object.keys(IMMEDIATE_PERSISTENCE).sort()).toEqual([...immediate].sort());
    const persistent = Object.entries(IMMEDIATE_PERSISTENCE).filter(([, persistence]) => persistence !== "none").map(([id]) => id);
    expect(persistent).toEqual(DIRECT_UI_ONLY_OPERATION_IDS);
    for (const origin of [
      { kind: "mcp", principalId: "all-capabilities", clientLabel: "UIでも承認済みと申告" },
      { kind: "chat", conversationId: "conversation-1" },
      { kind: "system", cause: "sync" },
    ] as const) expect(operationRequestDenial("V14", origin)).toMatchObject({ code: "POLICY_DENIED", retryable: false });
    expect(operationRequestDenial("V14", { kind: "ui", viewId: "gantt-1" })).toBeUndefined();
    expect(operationRequestDenial("V02", { kind: "mcp", principalId: "principal-1", clientLabel: "MCP" })).toBeUndefined();
    expect(IMMEDIATE_PERSISTENCE.Q07).toBe("none");
  });
  it("rejects authority in arguments, duplicate batch IDs and invalid days/hours", () => {
    for (const id of OPERATION_IDS) {
      expect(operationInputSchemas[id].safeParse({ ...INPUT_FIXTURES[id], origin: { kind: "ui", viewId: "fake" }, confirmed: true }).success).toBe(false);
    }
    expect(operationInputSchemas.T27.safeParse({ changes: [INPUT_FIXTURES.T27.changes[0], INPUT_FIXTURES.T27.changes[0]] }).success).toBe(false);
    expect(operationInputSchemas.T28.safeParse({ changes: [] }).success).toBe(false);
    expect(operationInputSchemas.M01.safeParse({ ...INPUT_FIXTURES.M01, date: "2026-02-30" }).success).toBe(false);
    expect(operationInputSchemas.M07.safeParse({ ...INPUT_FIXTURES.M07, workloadPlan: { "": 1 } }).success).toBe(false);
    expect(operationInputSchemas.M08.safeParse({ ...INPUT_FIXTURES.M08, workloadActual: { "2026-10-13": 25 } }).success).toBe(false);
    expect(operationInputSchemas.W01.safeParse({ ...INPUT_FIXTURES.W01, dayOfWeek: 7 }).success).toBe(false);
    expect(operationInputSchemas.D03.safeParse({ ...INPUT_FIXTURES.D03, sourceKey: "other" }).success).toBe(false);
    expect(operationInputSchemas.D04.safeParse({ path: "daily/file.md", line: 1, text: "changed" }).success).toBe(false);
  });
});

describe("legacy six-tool compatibility", () => {
  it("preserves the tool names and 19-field compatibility patch", () => {
    expect(Object.keys(LEGACY_OPERATION_IDS)).toEqual(Object.keys(OPERATION_MANIFEST));
    expect(Object.keys(taskPatchInputSchema.shape)).toEqual(Object.keys(patchSchema.shape));
    expect(Object.keys(taskPatchInputSchema.shape)).toHaveLength(19);
    expect(adaptLegacyOperationInput("create", { name: "Parent" }).operationId).toBe("T03");
    expect(adaptLegacyOperationInput("create", { name: "Child", parentTaskId: "tasks/parent.md" }).operationId).toBe("T04");
  });
  it("normalizes empty revisions accepted by old schemas and the real registry, without mutating inputs", async () => {
    const vault = new FakeVault(), settings = { ...DEFAULT_SETTINGS };
    const registry = new OperationRegistry({ settings, historyManager: new HistoryManager(), invalidate: () => undefined }, () => vault);
    const parent = await createTask(vault, settings, "Boundary parent"), child = await addSubtask(vault, settings, parent, "Boundary child");
    const cases = [
      ["update", { taskId: parent.id, expectedRevision: "", patch: { notes: "x".repeat(20000), dueDate: "", priority: 0, tags: [] } }],
      ["schedule-batch", { changes: [{ taskId: child.id, expectedRevision: "", patch: { plannedStartDate: "2026-10-13", plannedEndDate: "2026-10-15" } }] }],
      ["update-batch", { changes: [{ taskId: child.id, expectedRevision: "", patch: { notes: "", completed: true, priority: 5, priorityMode: "manual", workloadPlan: { "2026-10-13": 0 }, ganttMarkers: [] } }] }],
    ] as const;
    for (const [operation, input] of cases) {
      const original = structuredClone(input);
      expect(OPERATION_MANIFEST[operation].schema.safeParse(input).success).toBe(true);
      const adapted = adaptLegacyOperationInput(operation, input);
      if (adapted.operationId === "T29") expect(adapted.input).not.toHaveProperty("expectedRevision");
      else if (adapted.operationId === "T27" || adapted.operationId === "T28") expect(adapted.input.changes[0]).not.toHaveProperty("expectedRevision");
      const plan = await registry.plan(operation, input);
      expect(adaptLegacyOperationPlan(plan, { input, vaultInstanceId: "vault-1", origin: { kind: "ui", viewId: "gantt-1" }, createdAt: "2026-10-09T03:00:00Z", expiresAt: "2026-10-09T03:10:00Z" }).previewId).toBe(plan.previewId);
      expect((await registry.commit(plan.previewId)).kind).toBe("success");
      expect(input).toEqual(original);
    }
    expect(operationInputSchemas.T29.safeParse(cases[0][1]).success).toBe(false);
    expect(adaptLegacyOperationInput("update", { taskId: child.id, expectedRevision: "nonempty-revision", patch: {} }).input).toHaveProperty("expectedRevision", "nonempty-revision");
    expect(() => adaptLegacyOperationInput("update", { taskId: child.id, expectedRevision: 1, patch: {} })).toThrow();
  });
  it("adapts real registry plans without changing plans or writing Vault content", async () => {
    const vault = new FakeVault();
    const settings = { ...DEFAULT_SETTINGS };
    const registry = new OperationRegistry({ settings, historyManager: new HistoryManager(), invalidate: () => undefined }, () => vault);
    const parent = await createTask(vault, settings, "Parent");
    const child = await addSubtask(vault, settings, parent, "Child");
    const content = await vault.read(vault.getFileByPath(parent.id)!);
    vault.resetCounters();
    const read = await registry.invoke("search", { query: "Parent" });
    expect(Array.isArray(read)).toBe(true);
    expect(await registry.invoke("get", { taskId: child.id })).toHaveProperty("id", child.id);
    expect(adaptLegacyOperationInput("search", { query: "Parent" }).operationId).toBe("T01");
    expect(adaptLegacyOperationInput("get", { taskId: child.id }).operationId).toBe("T02");
    const inputs = [
      ["create", { name: "New parent" }], ["create", { name: "New child", parentTaskId: parent.id }],
      ["update", { taskId: child.id, patch: { notes: "changed" } }],
      ["schedule-batch", { changes: [{ taskId: child.id, patch: { plannedStartDate: "2026-10-13", plannedEndDate: "2026-10-15" } }] }],
      ["update-batch", { changes: [{ taskId: child.id, patch: { completed: true } }] }],
    ] as const;
    for (const [operation, input] of inputs) {
      const plan = await registry.plan(operation, input);
      const original = structuredClone(plan);
      const adapted = adaptLegacyOperationPlan(plan, { input, vaultInstanceId: "vault-1", origin: { kind: "ui", viewId: "view-1" }, createdAt: "2026-10-09T03:00:00Z", expiresAt: "2026-10-09T03:10:00Z" });
      expect(adapted.previewId).toBe(plan.previewId);
      expect(adapted.summary.actionCount).toBe(plan.count);
      expect(adapted.projection).toBeNull();
      expect(plan).toEqual(original);
      expect(operationOutputSchemas[adapted.operationId].safeParse(adapted).success).toBe(true);
    }
    expect(vault.getCreateCallCount()).toBe(0);
    expect(vault.getModifyCallCount()).toBe(0);
    expect(await vault.read(vault.getFileByPath(parent.id)!)).toBe(content);
  });
});
