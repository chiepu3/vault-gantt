import { z } from "zod";
import { describe, it, expect } from "vitest";
import { OperationCatalog } from "../../src/app/operation-catalog";
import { OPERATION_IDS, operationInputSchemas } from "../../src/contracts/operations";
import { fullDescription } from "../../src/agent-tools/descriptions";
import { catalogTools } from "../../src/agent-tools/catalog-tools";
import { runtimeFixture } from "../app/operation-runtime-fixture";
describe("123-entry catalog documentation", () => {
  it("every frozen ID has a valid example, schema, explicit availability and sufficient semantics", () => {
    const catalog = new OperationCatalog(); expect(catalog.describe()).toHaveLength(123); expect(catalog.describe().filter((row) => row.available)).toHaveLength(76); expect(new Set(catalog.ids).size).toBe(123);
    for (const id of OPERATION_IDS) {
      const definition = catalog.get(id); expect(definition.id).toBe(id); expect(definition.description.purpose).toBeTruthy();
      for (const example of definition.description.examples) expect(operationInputSchemas[id].safeParse(example.input).success, id).toBe(true);
      const description = fullDescription(id); expect(description).toContain("Undo:"); expect(description).toContain("例:");
      if (definition.classification === "write") { expect(description).toContain("人間"); expect(description).toContain("保存しない"); }
    }
    expect(fullDescription("T20")).toContain("計画・実績mapを保持"); expect(fullDescription("T25")).toContain("計画/実績mapは営業日相対位置で移動"); expect(fullDescription("M07")).toContain("0.5h"); expect(fullDescription("T26")).toContain("親ファイルを残し");
    expect(catalog.describe().filter((definition) => !definition.available).every((definition) => definition.denial?.code === "POLICY_DENIED")).toBe(true);
  });
  it("SDK exposes implemented proposal/read tools and never exposes human approval or unimplemented operations", async () => {
    const { service, context, vault } = await runtimeFixture();
    const events: unknown[] = [];
    const tools = catalogTools(service, context, ["tasks", "schedule", "markers", "workload", "events", "weekly", "settings"], (event) => events.push(event));
    expect(Object.keys(tools).some((name) => /approve|commit|confirm/i.test(name))).toBe(false); expect(tools).toHaveProperty("operations_describe"); for (const name of ["search", "get", "create", "update", "schedule-batch", "update-batch"]) expect(tools).toHaveProperty(name); expect(tools).not.toHaveProperty("daily_get");
    const describeSchema = z.toJSONSchema(tools.operations_describe.inputSchema as z.ZodType); expect(JSON.stringify(describeSchema)).not.toContain("T30"); expect(JSON.stringify(describeSchema)).not.toContain("D03");
    const result = await tools.operations_propose.execute!({ operationId: "M07", input: { subtaskId: "tasks/2026/10/リリース.md::review", workloadPlan: { "2026-10-13": 1.3 } } }, { toolCallId: "test", messages: [], context: undefined });
    expect(result).toMatchObject({ status: "pending", operationId: "M07", resultKind: "proposal-summary", projectionOmitted: true }); expect(result).not.toHaveProperty("projection"); expect(events).toHaveLength(1); expect(vault.getModifyCallCount()).toBe(0);
    expect(await tools.operations_propose.execute!({ operationId: "D03", input: {} }, { toolCallId: "test", messages: [], context: undefined })).toMatchObject({ status: "error", error: { code: "POLICY_DENIED" } });
  });
});
