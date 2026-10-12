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
  it("allows HTTP/HTTPS on any host but rejects credentials, queries, hashes and other protocols", () => {
    for (const protocol of ["http", "https"]) {
      for (const suffix of ["user@remote.example/v1", "user:pw@remote.example/v1", "remote.example/v1?token=secret", "remote.example/v1#fragment"]) expect(validEndpoint(`${protocol}://${suffix}`)).toBe(false);
    }
    for (const endpoint of ["file:///tmp/test", "ftp://remote.example/v1", "not a URL"]) expect(validEndpoint(endpoint)).toBe(false);
    for (const endpoint of ["http://localhost:1234/v1", "http://127.0.0.1:1234/v1", "http://[::1]:1234/v1", "http://192.168.1.20:1234/v1", "http://ai-server:8000/v1", "http://remote.example/v1", "https://example.test/v1"]) expect(validEndpoint(endpoint)).toBe(true);
  });
  it("reads only existing secret references and never configures a model implicitly", () => {
    const provider = new SdkChatProvider(registry(), (id) => id === "synthetic-id" ? "synthetic-token" : null);
    expect(provider.connected({ ...config, model: "" })).toBe(false);
    expect(provider.connected({ ...config, auth: "secret", secretId: "missing" })).toBe(false);
    expect(provider.connected({ ...config, auth: "secret", secretId: "synthetic-id" })).toBe(true);
  });
  it("resolves secrets for the request endpoint and blocks mismatched or stale configurations before fetch", async () => {
    const secret = vi.fn((_id: string, endpoint: string) => new URL(endpoint).origin === "https://openrouter.ai" ? "sk-synthetic" : null);
    const provider = new SdkChatProvider(registry(), secret);
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const allowed = { ...config, endpoint: "https://openrouter.ai/api/v1", auth: "secret" as const, secretId: "test" };
    expect(provider.connected(allowed)).toBe(true);
    expect(secret).toHaveBeenCalledWith("test", allowed.endpoint);
    for (const blocked of [{ ...allowed, endpoint: "https://other.example/v1" }, { ...allowed, connectionError: "キーを入れ直してください。" }]) {
      await expect(async () => {
        for await (const event of provider.stream({ config: blocked, messages: [], signal: new AbortController().signal })) void event;
      }).rejects.toThrow("DISCONNECTED");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    ["http://localhost:1234/v1", false], ["http://localhost:1234/v1", true],
    ["http://192.168.1.20:1234/v1", false], ["http://192.168.1.20:1234/v1", true],
    ["http://ai-server:8000/v1", false], ["http://ai-server:8000/v1", true],
  ])("streams through the actual SDK without real network (%s, uses key: %s)", async (endpoint, useApiKey) => {
    // eslint-disable-next-line no-undef
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string).model).toBe("synthetic-model");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe(useApiKey ? "Bearer sk-synthetic" : null);
      const frames = [
        { id: "fake", object: "chat.completion.chunk", created: 1, model: "synthetic-model", choices: [{ index: 0, delta: { role: "assistant", content: "合成" }, finish_reason: null }] },
        { id: "fake", object: "chat.completion.chunk", created: 1, model: "synthetic-model", choices: [{ index: 0, delta: { content: "応答" }, finish_reason: null }] },
        { id: "fake", object: "chat.completion.chunk", created: 1, model: "synthetic-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ];
      return new Response(frames.map((frame) => "data: " + JSON.stringify(frame) + "\n\n").join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const selected = { ...config, endpoint, auth: useApiKey ? "secret" as const : "none" as const, secretId: useApiKey ? "test" : "" };
    const provider = new SdkChatProvider(registry(), (_id, endpoint) => endpoint === selected.endpoint ? "sk-synthetic" : null);
    const events = [];
    for await (const event of provider.stream({ config: selected, messages: [{ role: "user", content: "synthetic test" }], signal: new AbortController().signal })) events.push(event);
    expect(events.filter((event) => event.type === "text").map((event) => event.text).join("")).toBe("合成応答");
    expect(events.at(-1)?.type).toBe("completion"); expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toBe(endpoint + "/chat/completions");
  });
});
