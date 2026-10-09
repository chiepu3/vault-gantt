import { it, expect, vi, afterEach } from "vitest";
import { SdkChatProvider } from "../../src/ai/sdk-provider";
import { runtimeFixture } from "../app/operation-runtime-fixture";
afterEach(() => vi.unstubAllGlobals());
it("the actual SDK serializes selected catalog schemas, six legacy tools and compact overview", async () => {
  const { registry, service, vault } = await runtimeFixture();
  // eslint-disable-next-line no-undef
  const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const request = JSON.parse(init!.body as string);
    const names = request.tools.map((tool: { function: { name: string } }) => tool.function.name);
    for (const name of ["search", "get", "create", "update", "schedule-batch", "update-batch", "workload_propose", "tasks_search", "tasks_get_many", "operations_describe"]) expect(names).toContain(name);
    expect(names.some((name: string) => /^(approve|commit|confirm)$/.test(name))).toBe(false);
    expect(names).not.toContain("events_propose"); expect(names).not.toContain("daily_get");
    expect(request.messages[0].content).toContain("snapshotRevision"); expect(request.messages[0].content).not.toContain("review-point");
    const chunk = { id: "fake", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "確認します" }, finish_reason: null }] };
    const finish = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
    return new Response("data: " + JSON.stringify(chunk) + "\n\ndata: " + JSON.stringify(finish) + "\n\ndata: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const provider = new SdkChatProvider(registry, () => null, service), events = [];
  for await (const event of provider.stream({ config: { provider: "openai-compatible", endpoint: "http://localhost:1234/v1", model: "fixture", auth: "none", secretId: "" }, messages: [{ role: "user", content: "計画時間を確認" }], signal: new AbortController().signal, conversationId: "fixture-chat" })) events.push(event);
  expect(events.at(-1)?.type).toBe("context"); expect(fetchMock).toHaveBeenCalledOnce(); expect(vault.getModifyCallCount()).toBe(0);
});
