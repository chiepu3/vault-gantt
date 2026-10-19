import { describe, it, expect } from "vitest";
import { z } from "zod";
import { operationInputSchemas } from "../../src/contracts/operations";
import { OPERATION_MANIFEST } from "../../src/app/operation-registry";
import { tagNamesSchema, markerStateSchema } from "../../src/contracts/context";

// OpenAI models (via OpenRouter) end the reply instantly ("length") when a tool schema carries a pattern with `\0`; `\u0000` is accepted everywhere.
const patterns = (schema: unknown): string[] => JSON.stringify(z.toJSONSchema(schema as z.ZodType, { unrepresentable: "any", io: "input" }))
  .match(/"pattern":"((?:[^"\\]|\\.)*)"/g) ?? [];
describe("tool schema patterns", () => {
  it("never use the \\0 escape, which some providers reject", () => {
    const all = [...Object.values(operationInputSchemas), ...Object.values(OPERATION_MANIFEST).map((entry) => entry.schema), tagNamesSchema, markerStateSchema].flatMap(patterns);
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter((pattern) => /\\\\0(?![0-9])/.test(pattern))).toEqual([]);
  });
});
