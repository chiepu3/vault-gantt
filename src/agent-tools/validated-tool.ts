import { jsonSchema, tool } from "ai";
import { z } from "zod";
import { OperationFailure } from "../app/operations/runtime";

export function parseObject(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : value; }
  catch { return value; }
}
export function inputError(error: z.ZodError, schema: z.ZodType) {
  return { status: "error", error: { code: "INVALID_INPUT", retryable: true,
    issues: error.issues.map((issue) => ({ argument: issue.path.join(".") || "input", code: issue.code, detail: issue.message })),
    nextAction: "入力schemaの型・必須引数に合わせて修正して再試行してください。objectはJSONオブジェクトで渡します。保存は行っていません。",
    inputSchema: z.toJSONSchema(schema),
  } };
}
/** Validate inside execute so invalid arguments become repairable tool results.
 * The wire schema remains precise; bypassing SDK validation never bypasses Zod/runtime validation.
 */
export function validatedTool<T>(description: string, schema: z.ZodType<T>, execute: (input: T) => Promise<unknown> | unknown, normalize: (input: unknown) => unknown = parseObject) {
  return tool({ description,
    inputSchema: jsonSchema<unknown>(z.toJSONSchema(schema), { validate: async (value) => ({ success: true, value }) }),
    execute: async (value) => {
      const parsed = schema.safeParse(normalize(value));
      if (!parsed.success) return inputError(parsed.error, schema);
      try { return await execute(parsed.data); }
      catch (error) {
        if (error instanceof OperationFailure) return { status: "error", error: error.error };
        if (error instanceof z.ZodError) return inputError(error, schema);
        return { status: "error", error: { code: "TOOL_FAILED", retryable: false, nextAction: "操作が完了していません。対象を再取得して確認してください。" } };
      }
    },
  });
}
