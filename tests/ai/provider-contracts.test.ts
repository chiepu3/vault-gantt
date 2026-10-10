import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatSession, type ConnectionConfig } from "../../src/ai/chat-session";
import { completionText } from "../../src/ai/chat-completion";
import { SdkChatProvider } from "../../src/ai/sdk-provider";
import { runtimeFixture } from "../app/operation-runtime-fixture";
import { CHILD_ID } from "../contracts/fixtures";

const config: ConnectionConfig = { provider: "openai-compatible", endpoint: "http://localhost:1234/v1", model: "synthetic", auth: "none", secretId: "" };
const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function frame(delta: object, finishReason: string | null = null): string {
  return "data: " + JSON.stringify({ id: "contract-fixture", object: "chat.completion.chunk", created: 1, model: "synthetic", choices: [{ index: 0, delta, finish_reason: finishReason }] }) + "\n\n";
}
function response(options: { text?: string; reasoning?: string; tool?: { name: string; input: unknown } } = {}): Response {
  const { text = "", reasoning, tool } = options;
  const delta = tool ? { tool_calls: [{ index: 0, id: "call-fixture", type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.input) } }] } : { content: text, ...(reasoning ? { reasoning_content: reasoning } : {}) };
  return new Response(frame({ role: "assistant" }) + frame(delta) + frame({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
async function setup() {
  const fixture = await runtimeFixture();
  const session = new ChatSession(fixture.vault, fixture.registry, new SdkChatProvider(fixture.registry, () => null, fixture.service));
  session.configure(config);
  disposers.push(() => session.dispose(), () => fixture.service.dispose());
  return { ...fixture, session };
}
function stalledResponse(signal: AbortSignal, partial: boolean): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (partial) controller.enqueue(new TextEncoder().encode(frame({ role: "assistant", content: "途中の応答" })));
      const abort = () => controller.error(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

describe("provider terminal contracts through the actual SDK and fake HTTP", () => {
  it.each([false, true])("classifies the SDK total timeout separately from caller cancellation (partial: %s)", async (partial) => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let callerSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (_input: unknown, init?: Parameters<typeof fetch>[1]) => stalledResponse(init!.signal!, partial));
    vi.stubGlobal("fetch", fetchMock);
    const f = await setup();
    const originalStream = SdkChatProvider.prototype.stream;
    vi.spyOn(SdkChatProvider.prototype, "stream").mockImplementation(function (this: SdkChatProvider, request) {
      callerSignal = request.signal;
      return originalStream.call(this, request);
    });
    const run = f.session.send("合成のタイムアウト確認");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    if (partial) await vi.waitFor(() => expect(f.session.active.messages.at(-1)?.text).toBe("途中の応答"));
    expect(timeout).toHaveBeenCalledWith(120000);
    deadline.abort(new DOMException("SYNTHETIC-SECRET-TIMEOUT", "TimeoutError"));
    await run;
    expect(callerSignal?.aborted).toBe(false);
    expect(f.session.active.completion?.kind).toBe("timeout");
    expect(f.session.active.status).toBe("failed");
    expect(f.session.active.context).toEqual([]);
    expect(JSON.stringify(f.session.active)).not.toContain("SYNTHETIC-SECRET-TIMEOUT");
    expect(f.vault.getModifyCallCount()).toBe(0);
  });

  it("keeps an explicit user stop cancelled while the HTTP body is stalled", async () => {
    const fetchMock = vi.fn(async (_input: unknown, init?: Parameters<typeof fetch>[1]) => stalledResponse(init!.signal!, true));
    vi.stubGlobal("fetch", fetchMock);
    const f = await setup();
    const run = f.session.send("合成の停止確認");
    await vi.waitFor(() => expect(f.session.active.messages.at(-1)?.text).toBe("途中の応答"));
    f.session.stop();
    await run;
    expect(f.session.active.completion?.kind).toBe("cancelled");
    expect(f.session.active.status).toBe("cancelled");
    expect(f.session.active.context).toEqual([]);
    expect(f.vault.getModifyCallCount()).toBe(0);
  });

  it.each([false, true])("does not classify a natural sixth-step answer as a step limit (unresolved refusal: %s)", async (refused) => {
    let round = 0;
    const fetchMock = vi.fn(async () => {
      round++;
      if (refused && round === 1) return response({ tool: { name: "operations_propose", input: { operationId: "V20", input: {} } } });
      if (round < 6) return response({ tool: { name: "operations_describe", input: {} } });
      return response({ text: "確認結果です。" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const f = await setup();
    await f.session.send("合成の六手目確認");
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(f.session.active.completion?.kind).toBe(refused ? "tool-refused" : "no-proposal");
    expect(f.session.active.messages.at(-1)?.text).toContain("確認結果です。");
    expect(f.session.active.messages.at(-1)?.text).not.toContain(completionText["step-limit"]);
    expect(f.vault.getModifyCallCount()).toBe(0);
  });

  it.each([
    { name: "empty", text: "" },
    { name: "whitespace", text: " \n\t" },
    { name: "reasoning only", text: "", reasoning: "synthetic reasoning" },
  ])("rejects a $name stop response without adding successful conversation context", async ({ text, reasoning }) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response({ text: "前の正常な応答" })).mockResolvedValueOnce(response({ text, reasoning }));
    vi.stubGlobal("fetch", fetchMock);
    const f = await setup();
    await f.session.send("前の質問");
    expect(f.session.active.status).toBe("idle");
    const priorContext = structuredClone(f.session.active.context);
    await f.session.send("回答がない質問");
    expect(f.session.active.status).toBe("failed");
    expect(f.session.active.completion?.kind).toBe("connection-error");
    expect(f.session.active.context).toEqual(priorContext);
    expect(f.session.active.error).toBe(completionText["connection-error"]);
    expect(f.vault.getModifyCallCount()).toBe(0);
    fetchMock.mockResolvedValueOnce(response({ text: "再試行の応答" }));
    await f.session.retry();
    expect(f.session.active.status).toBe("idle");
    expect(f.session.active.messages.at(-1)?.text).toBe("再試行の応答");
  });

  it("accepts a sixth-step proposal with no answer text without saving", async () => {
    let round = 0;
    const fetchMock = vi.fn(async () => ++round < 6 ? response({ tool: { name: "operations_describe", input: {} } }) : response({ tool: { name: "operations_propose", input: { operationId: "T07", input: { taskId: CHILD_ID, name: "合成の変更案" } } } }));
    vi.stubGlobal("fetch", fetchMock);
    const f = await setup();
    await f.session.send("合成の変更案確認");
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(f.session.active.status).toBe("preview");
    expect(f.session.active.completion?.kind).toBe("proposal-created");
    expect(f.session.active.messages.at(-1)?.proposals).toHaveLength(1);
    expect(f.vault.getModifyCallCount()).toBe(0);
  });
});
