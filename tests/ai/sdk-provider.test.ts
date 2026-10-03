import { describe, it, expect, vi, afterEach } from "vitest";
import { SdkChatProvider, registryTools, validEndpoint } from "../../src/ai/sdk-provider";
import { OPERATION_MANIFEST, OperationRegistry } from "../../src/app/operation-registry";
import { HistoryManager } from "../../src/app/history-manager";
import { DEFAULT_SETTINGS } from "../../src/core/constants";
import { FakeVault } from "../app/fake-vault";
import type { ConnectionConfig } from "../../src/ai/chat-session";
const config: ConnectionConfig = { provider: "openai-compatible", endpoint: "http://localhost:1234/v1", model: "synthetic-model", auth: "none", secretId: "" };
function registry() { return new OperationRegistry({ settings: { ...DEFAULT_SETTINGS }, historyManager: new HistoryManager(), invalidate: () => undefined }, () => new FakeVault()); }
afterEach(() => vi.unstubAllGlobals());
describe("AI SDK Core compatible adapter (fake HTTP only)", () => {
  it("tool manifest parity includes every operation", () => {
    const tools = registryTools(registry(), new AbortController().signal, () => undefined);
    expect(Object.keys(tools)).toEqual(Object.keys(OPERATION_MANIFEST));
    for (const [name, definition] of Object.entries(tools)) expect(definition.description).toBe(OPERATION_MANIFEST[name as keyof typeof OPERATION_MANIFEST].description);
  });
  it("rejects secret-bearing and insecure remote URLs", () => {
    for (const endpoint of ["http://remote.example/v1", "https://key@remote.example/v1", "https://remote.example?token=secret", "file:///tmp/test"]) expect(validEndpoint(endpoint)).toBe(false);
    expect(validEndpoint("http://127.0.0.1:1234/v1")).toBe(true);
    expect(validEndpoint("https://example.test/v1")).toBe(true);
  });
  it("reads only existing secret references and never configures a model implicitly", () => {
    const provider = new SdkChatProvider(registry(), (id) => id === "synthetic-id" ? "synthetic-token" : null);
    expect(provider.connected({ ...config, model: "" })).toBe(false);
    expect(provider.connected({ ...config, auth: "secret", secretId: "missing" })).toBe(false);
    expect(provider.connected({ ...config, auth: "secret", secretId: "synthetic-id" })).toBe(true);
  });
  it("streams through the actual SDK on Node22 and forwards the selected model without real network", async () => {
    // eslint-disable-next-line no-undef
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string).model).toBe("synthetic-model");
      expect(init?.redirect).toBe("error");
      const frames = [
        { id: "fake", object: "chat.completion.chunk", created: 1, model: "synthetic-model", choices: [{ index: 0, delta: { role: "assistant", content: "合成" }, finish_reason: null }] },
        { id: "fake", object: "chat.completion.chunk", created: 1, model: "synthetic-model", choices: [{ index: 0, delta: { content: "応答" }, finish_reason: null }] },
        { id: "fake", object: "chat.completion.chunk", created: 1, model: "synthetic-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ];
      return new Response(frames.map((frame) => "data: " + JSON.stringify(frame) + "\n\n").join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new SdkChatProvider(registry(), () => null);
    const events = [];
    for await (const event of provider.stream({ config, messages: [{ role: "user", content: "synthetic test" }], signal: new AbortController().signal })) events.push(event);
    expect(events.filter((event) => event.type === "text").map((event) => event.text).join("")).toBe("合成応答");
    expect(events.at(-1)?.type).toBe("context"); expect(fetchMock).toHaveBeenCalledOnce();
  });
});
