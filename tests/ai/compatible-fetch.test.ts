import { afterEach, expect, it, vi } from "vitest";
import { compatibleFetch } from "../../src/ai/compatible-fetch";
afterEach(() => vi.unstubAllGlobals());
const rejection = () => new Response(JSON.stringify({ error: { message: "Provider returned error", metadata: { provider_name: "Sail Research", provider_error_code: "invalid_request_error", raw: "invalid parameters" } } }), { status: 400 });
it("passes a non-JSON OpenRouter body through unchanged, even after learning a rejected upstream", async () => {
  const response = rejection();
  const mock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", mock);
  const endpoint = "https://openrouter.ai/api/v1/chat/completions";
  const request = compatibleFetch("https://openrouter.ai/api/v1");
  const init = { method: "POST", body: "not JSON", headers: { authorization: "Bearer sk-synthetic" } };
  expect(await request(endpoint, init)).toBe(response);
  expect(mock).toHaveBeenCalledOnce();
  expect(mock).toHaveBeenLastCalledWith(endpoint, { ...init, redirect: "error" });
  mock.mockResolvedValueOnce(rejection()).mockResolvedValueOnce(new Response("ok"));
  await request(endpoint, { body: "{}" });
  expect(await request(endpoint, init)).toBe(response);
  expect(mock).toHaveBeenCalledTimes(4);
  expect(mock).toHaveBeenLastCalledWith(endpoint, { ...init, redirect: "error" });
});
it("retries a confirmed upstream rejection once and preserves tool IDs, content, schemas, model and routing privacy", async () => {
  const mock = vi.fn().mockResolvedValueOnce(rejection()).mockResolvedValueOnce(new Response("ok")).mockResolvedValueOnce(rejection()); vi.stubGlobal("fetch", mock);
  const request = compatibleFetch("https://openrouter.ai/api/v1"), body = { model: "deepseek/fixture", tools: [{ function: { parameters: { type: "object" } } }], messages: [{ role: "tool", tool_call_id: "fixture", content: "{}" }], provider: { data_collection: "deny", max_price: { prompt: 1 } } };
  await request("https://openrouter.ai/api/v1/chat/completions", { body: JSON.stringify(body), method: "POST" });
  expect(mock).toHaveBeenCalledTimes(2);
  expect(JSON.parse(mock.mock.calls[1][1].body)).toEqual({ ...body, provider: { ...body.provider, ignore: ["sail-research"] } });
  expect(mock.mock.calls[1][1].redirect).toBe("error");
  await request("https://openrouter.ai/api/v1/chat/completions", { body: JSON.stringify(body), method: "POST" });
  expect(mock).toHaveBeenCalledTimes(3); expect(JSON.parse(mock.mock.calls[2][1].body).provider.ignore).toEqual(["sail-research"]);
});
it.each(["https://example.test/v1", "https://openrouter.ai/api/v1"])("does not retry ordinary 400/authentication failures at %s", async (endpoint) => {
  const mock = vi.fn().mockResolvedValue(new Response('{"error":{"message":"Bad schema"}}', { status: 400 })); vi.stubGlobal("fetch", mock);
  await compatibleFetch(endpoint)(endpoint, { body: "{}" }); expect(mock).toHaveBeenCalledOnce();
});
it.each([{ only: ["sail-research"] }, { allow_fallbacks: false }])("preserves explicit routing restrictions %j", async (provider) => {
  const mock = vi.fn().mockResolvedValue(rejection()); vi.stubGlobal("fetch", mock);
  await compatibleFetch("https://openrouter.ai/api/v1")("https://openrouter.ai/api/v1/chat/completions", { body: JSON.stringify({ provider }) }); expect(mock).toHaveBeenCalledOnce();
});
