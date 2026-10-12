import { describe, it, expect } from "vitest";
import type { ToolSet } from "ai";
import { chatTools } from "../../src/agent-tools/chat-tools";
import { runtimeFixture } from "../app/operation-runtime-fixture";
import { CHILD_ID, PARENT_ID } from "../contracts/fixtures";
import { parseTaskFile } from "../../src/core/note-format";
async function invoke(tools: ToolSet, name: string, input: unknown) {
  return tools[name].execute!(input, { toolCallId: "fixture", messages: [], context: undefined }) as Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}
describe("compact chat entries", () => {
  it("accepts legacy query without offering two search tools and returns concrete validation errors", async () => {
    const f = await runtimeFixture(), tools = chatTools(f.service, f.context, "", () => undefined);
    const found = await invoke(tools, "tasks_search", { query: "レビュー", fields: ["identity"] });
    expect(found.status).toBe("success"); expect(found.result.data.items.some((item: { id: string }) => item.id === CHILD_ID)).toBe(true);
    const invalid = await invoke(tools, "tasks_search", { name: 3 });
    expect(invalid.error.code).toBe("INVALID_INPUT"); expect(invalid.error.issues[0]).toMatchObject({ argument: "name", code: "invalid_type" });
    expect(invalid.error.inputSchema.properties.name.type).toBe("string"); f.service.dispose();
  });
  it("parses an object string safely and validates every operation-specific field before planning", async () => {
    const f = await runtimeFixture(), events: unknown[] = [], tools = chatTools(f.service, f.context, "名前変更", (event) => events.push(event));
    const invalid = await invoke(tools, "operations_propose", { operationId: "T07", input: JSON.stringify({ taskId: CHILD_ID, name: 42 }) });
    expect(invalid.error.issues[0].argument).toBe("name"); expect(events).toHaveLength(0);
    const valid = await invoke(tools, "operations_propose", { operationId: "T07", input: JSON.stringify({ taskId: CHILD_ID, name: "名前" }) });
    expect(valid.status).toBe("proposal-created"); expect(events).toHaveLength(1); expect(f.vault.getModifyCallCount()).toBe(0); f.service.dispose();
  });
  it("returns a retryable validation result for malformed JSON or an array, and never plans", async () => {
    const f = await runtimeFixture(), tools = chatTools(f.service, f.context, "", () => undefined);
    for (const input of ['{"name":', '[1,2]', '"text"']) {
      expect((await invoke(tools, "operations_propose", { operationId: "T04", input })).error.code).toBe("INVALID_INPUT");
    }
    expect(f.service.previewPort.list()).toHaveLength(0); f.service.dispose();
  });
  it("keeps capability and external-request denials at the generic entry", async () => {
    const f = await runtimeFixture(), tools = chatTools(f.service, { ...f.context, capabilities: ["read"] }, "", () => undefined);
    for (const id of ["T07", "S21", "Q04", "unknown", "copy-subtask"]) expect((await invoke(tools, "operations_propose", { operationId: id, input: {} })).error.code).toBe("POLICY_DENIED");
    f.service.dispose();
  });
  it("does not automatically return the full catalog schemas", async () => {
    const f = await runtimeFixture(), tools = chatTools(f.service, f.context, "", () => undefined);
    const index = await invoke(tools, "operations_describe", {});
    expect(index.length).toBeGreaterThan(40); expect(index[0]).not.toHaveProperty("inputSchema");
    expect((await invoke(tools, "operations_describe", { ids: ["T07"] }))[0].inputSchema.properties.name.type).toBe("string");
    expect((await invoke(tools, "operations_describe", { ids: Array(7).fill("T07") })).error.code).toBe("INVALID_INPUT"); f.service.dispose();
  });
  it("copies a child in one approval, preserves the source and supports Undo and repreview", async () => {
    const f = await runtimeFixture(); const before = f.vault.getFileContent(PARENT_ID);
    const preview = await f.service.proposeTaskCopy(CHILD_ID, "レビュー予備", f.context);
    expect(f.vault.getFileContent(PARENT_ID)).toBe(before);
    const source = preview.projection!.before.parents.flatMap((parent) => parent.children).find((task) => task.id === CHILD_ID);
    const target = preview.projection!.after.parents.flatMap((parent) => parent.children).find((task) => task.name === "レビュー予備");
    expect(target).toMatchObject({ period: source!.period, hours: source!.hours, markers: source!.markers });
    expect(target!.id).not.toBe(CHILD_ID);
    const refreshed = await f.service.previewPort.requestRepreview(preview.previewId);
    const outcome = await f.service.humanApprovalPort.approve(refreshed.previewId); expect(outcome.status).toBe("success");
    const saved = parseTaskFile({ path: PARENT_ID }, f.vault.getFileContent(PARENT_ID)!, f.settings)!;
    expect(saved.subtasks!.get(f.child.key!)!.displayName).toBe(f.child.displayName);
    expect([...saved.subtasks!.values()].find((task) => task.displayName === "レビュー予備")!.workloadActual).toEqual(f.child.workloadActual);
    const undo = await f.service.propose("V20", {}, f.context); expect((await f.service.humanApprovalPort.approve(undo.previewId)).status).toBe("success");
    expect(f.vault.getFileContent(PARENT_ID)).toBe(before); f.service.dispose();
  });
});
