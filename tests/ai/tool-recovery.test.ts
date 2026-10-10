import { afterEach, describe, expect, it, vi } from "vitest";
import { SdkChatProvider, CHAT_SYSTEM_PROMPT } from "../../src/ai/sdk-provider";
import { ChatSession, type ChatEvent, type ConnectionConfig } from "../../src/ai/chat-session";
import { runtimeFixture } from "../app/operation-runtime-fixture";
import { CHILD_ID } from "../contracts/fixtures";
import { FakeProvider } from "./fake-provider";
const config: ConnectionConfig = { provider: "openai-compatible", endpoint: "http://localhost:1234/v1", model: "synthetic", auth: "none", secretId: "" };
afterEach(() => vi.unstubAllGlobals());
function response(tool?: { name: string; input: string }, text = "確認しました") {
  const base = { id: "chat-fixture", object: "chat.completion.chunk", created: 1, model: "synthetic" };
  const chunks = [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "", reasoning_content: "reasoning fixture" }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: tool ? { content: null, tool_calls: [{ index: 0, id: "call-fixture", type: "function", function: { name: tool.name, arguments: tool.input } }] } : { content: text }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] },
  ];
  return new Response(chunks.map((part) => "data: " + JSON.stringify(part) + "\n\n").join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
async function collect(provider: SdkChatProvider): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of provider.stream({ config, messages: [{ role: "user", content: "名前変更して" }], signal: new AbortController().signal })) events.push(event);
  return events;
}
describe("actual SDK tool recovery", () => {
  it("returns argument/type errors with matching tool_call_id, preserves reasoning and accepts the retry", async () => {
    const f = await runtimeFixture(); let round = 0;
    // eslint-disable-next-line no-undef
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(init!.body as string);
      if (++round === 1) return response({ name: "operations_propose", input: JSON.stringify({ operationId: "T07", input: { taskId: CHILD_ID, name: 123 } }) });
      const assistant = request.messages.find((message: { tool_calls?: unknown }) => message.tool_calls);
      expect(assistant.content).toBeNull(); expect(assistant.reasoning_content).toBe("reasoning fixture");
      expect(assistant.tool_calls[0].id).toBe("call-fixture");
      const toolMessage = request.messages.find((message: { role: string }) => message.role === "tool");
      expect(toolMessage.tool_call_id).toBe("call-fixture");
      const result = JSON.parse(toolMessage.content); expect(result.error.issues[0].argument).toBe("name");
      return response({ name: "operations_propose", input: JSON.stringify({ operationId: "T07", input: JSON.stringify({ taskId: CHILD_ID, name: "更新" }) }) });
    });
    vi.stubGlobal("fetch", fetchMock);
    const events = await collect(new SdkChatProvider(f.registry, () => null, f.service));
    expect(fetchMock).toHaveBeenCalledTimes(2); expect(events.filter((event) => event.type === "plan")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "completion", completion: { kind: "proposal-created", toolErrors: 1 } });
    expect(f.vault.getModifyCallCount()).toBe(0); f.service.dispose();
  });
  it("does not stop the conversation on malformed JSON tool input", async () => {
    const f = await runtimeFixture(); let round = 0;
    vi.stubGlobal("fetch", vi.fn(async () => ++round === 1 ? response({ name: "tasks_search", input: '{"name":' }) : response(undefined, "入力を確認してください")));
    const events = await collect(new SdkChatProvider(f.registry, () => null, f.service));
    expect(round).toBe(2); expect(events.at(-1)).toMatchObject({ type: "completion", completion: { kind: "tool-refused", toolErrors: 1 } }); f.service.dispose();
  });
  it("reports an empty-history Undo refusal as a tool result and a final refusal, never as a connection error", async () => {
    const f = await runtimeFixture(); let round = 0;
    vi.stubGlobal("fetch", vi.fn(async () => ++round === 1 ? response({ name: "operations_propose", input: JSON.stringify({ operationId: "V20", input: {} }) }) : response(undefined, "名前変更は保存されていないため、元に戻す変更はありません。")));
    const events = await collect(new SdkChatProvider(f.registry, () => null, f.service));
    expect(events.filter((event) => event.type === "plan")).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "completion", completion: { kind: "tool-refused", proposalIds: [] } });
    expect(f.vault.getModifyCallCount()).toBe(0); f.service.dispose();
  });
  it("returns a distinct step-limit ending after six nonproductive calls", async () => {
    const f = await runtimeFixture(); vi.stubGlobal("fetch", vi.fn(async () => response({ name: "operations_describe", input: "{}" })));
    const events = await collect(new SdkChatProvider(f.registry, () => null, f.service));
    expect(events.at(-1)).toMatchObject({ type: "completion", completion: { kind: "step-limit" } }); expect(fetch).toHaveBeenCalledTimes(6); f.service.dispose();
  });
  it.each([400, 401])("retains a safe HTTP %i diagnostic without error body or credentials", async (status) => {
    const f = await runtimeFixture(); vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":{"message":"SYNTHETIC-SECRET"}}', { status })));
    const session = new ChatSession({}, f.registry, new SdkChatProvider(f.registry, () => null, f.service)); session.configure(config); await session.send("test");
    expect(session.active.completion).toMatchObject({ kind: "connection-error", httpStatus: status }); expect(session.active.status).toBe("failed");
    expect(JSON.stringify(session.active)).not.toContain("SYNTHETIC-SECRET"); session.dispose(); f.service.dispose();
  });
  it("distinguishes a provider timeout from a connection failure", async () => {
    const f = await runtimeFixture(); vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("timeout", "TimeoutError"); }));
    const events = await collect(new SdkChatProvider(f.registry, () => null, f.service));
    expect(events.at(-1)).toMatchObject({ type: "completion", completion: { kind: "timeout" } }); f.service.dispose();
  });
  it.each(["no-proposal", "tool-refused", "timeout", "proposal-created"] as const)("keeps %s as data for the chat UI", async (kind) => {
    const f = await runtimeFixture(); const session = new ChatSession({}, f.registry, new FakeProvider(async function* () { yield { type: "completion", completion: { kind, proposalIds: [], toolErrors: kind === "tool-refused" ? 1 : 0 } }; }));
    session.configure(config); await session.send("test"); expect(session.active.completion?.kind).toBe(kind); expect(session.active.messages.at(-1)?.completion?.kind).toBe(kind); session.dispose(); f.service.dispose();
  });
  it("instructs factual progress, nonpublic IDs, and refusal to Undo unsaved changes", () => {
    expect(CHAT_SYSTEM_PROMPT).toContain("未記録は作業なしや未消化を意味しない");
    expect(CHAT_SYSTEM_PROMPT).toContain("操作ID"); expect(CHAT_SYSTEM_PROMPT).toContain("未保存・失敗した変更を別の履歴のUndoで戻さない");
  });
});
