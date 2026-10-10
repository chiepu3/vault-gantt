import { describe, it, expect, vi } from "vitest";
import { AI_SECRET_ID, aiKeyOriginError, connectionOrigin, defaultAiSettings, listModels, normalizeAiSettings, toConnectionConfig } from "../../src/ai/connection-settings";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("AI connection settings", () => {
  it("compares scheme, host and port while ignoring paths and default ports", () => {
    const saved = { ...defaultAiSettings(), apiKeyOrigin: "https://openrouter.ai" };
    expect(connectionOrigin(" https://OPENROUTER.ai:443/other/v1 ")).toBe(saved.apiKeyOrigin);
    expect(aiKeyOriginError({ ...saved, baseUrl: "https://openrouter.ai:443/other/v1" })).toBeUndefined();
    for (const baseUrl of ["https://other.example/v1", "https://openrouter.ai:8443/v1", "http://openrouter.ai/v1", "not a URL"]) {
      expect(aiKeyOriginError({ ...saved, baseUrl })).toBe("保存済みのキーは https://openrouter.ai 用です。この接続先で使うにはキーを入れ直してください。");
      expect(toConnectionConfig({ ...saved, baseUrl }).connectionError).toBe(aiKeyOriginError({ ...saved, baseUrl }));
    }
    expect(aiKeyOriginError({ ...saved, baseUrl: "http://localhost:1234/v1", useApiKey: false })).toBeUndefined();
  });
  it("never echoes credentials or paths from malformed stored origins", () => {
    const settings = normalizeAiSettings({ apiKeyOrigin: "https://sk-synthetic@example.com/secret?key=sk-synthetic" });
    expect(settings.apiKeyOrigin).toBe("");
    expect(aiKeyOriginError(settings)).toBe("保存済みのキーの接続先を確認できません。この接続先で使うにはキーを入れ直してください。");
    expect(normalizeAiSettings({ apiKeyOrigin: "https://OPENROUTER.ai:443/api/v1" }).apiKeyOrigin).toBe("https://openrouter.ai");
    expect(normalizeAiSettings({ apiKeyOrigin: null }).apiKeyOrigin).toBe("");
  });
  it("falls back to OpenRouter defaults for missing or malformed stored data", () => {
    for (const raw of [undefined, null, 5, "x", [], {}]) expect(normalizeAiSettings(raw)).toEqual(defaultAiSettings());
    expect(defaultAiSettings()).toMatchObject({ preset: "openrouter", baseUrl: "https://openrouter.ai/api/v1", useApiKey: true });
  });
  it("keeps valid stored values, drops unknown fields and repairs bad ones", () => {
    expect(normalizeAiSettings({ preset: "local", baseUrl: " http://localhost:1234/v1 ", model: " m ", useApiKey: false, extra: 1 }))
      .toEqual({ preset: "local", baseUrl: "http://localhost:1234/v1", model: "m", useApiKey: false });
    expect(normalizeAiSettings({ preset: "nope", baseUrl: 3, model: 4, useApiKey: "yes" })).toEqual(defaultAiSettings());
    expect(normalizeAiSettings({ preset: "local" })).toMatchObject({ baseUrl: "http://localhost:1234/v1", useApiKey: false });
    expect(normalizeAiSettings({ preset: "custom" })).toMatchObject({ baseUrl: "" });
  });
  it("maps to the chat connection without carrying a key", () => {
    expect(toConnectionConfig({ preset: "openrouter", baseUrl: "https://openrouter.ai/api/v1/", model: " a/b ", useApiKey: true }))
      .toEqual({ provider: "openai-compatible", endpoint: "https://openrouter.ai/api/v1", model: "a/b", auth: "secret", secretId: AI_SECRET_ID });
    expect(toConnectionConfig({ preset: "local", baseUrl: "http://localhost:1234/v1", model: "m", useApiKey: false, apiKey: "sk-x" }))
      .toEqual({ provider: "openai-compatible", endpoint: "http://localhost:1234/v1", model: "m", auth: "none", secretId: "" });
  });
});

describe("listModels", () => {
  it("blocks a saved key at another origin before any request", async () => {
    const fetchImpl = vi.fn();
    const result = await listModels({ baseUrl: "https://other.example/v1", apiKey: "sk-synthetic", apiKeyOrigin: "https://openrouter.ai", fetchImpl });
    expect(result).toEqual({ ok: false, reason: "保存済みのキーは https://openrouter.ai 用です。この接続先で使うにはキーを入れ直してください。" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("sk-synthetic");
  });
  it("returns sorted unique ids and sends the key only as a bearer header", async () => {
    const fetchImpl = vi.fn(async () => json({ data: [{ id: "b" }, { id: "a" }, { id: "b" }, { nope: 1 }] }));
    const result = await listModels({ baseUrl: "https://openrouter.ai/api/v1/", apiKey: "sk-synthetic", apiKeyOrigin: "https://openrouter.ai", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ ok: true, models: ["a", "b"] });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, Parameters<typeof fetch>[1] & object];
    expect(url).toBe("https://openrouter.ai/api/v1/models");
    expect(init.headers).toMatchObject({ authorization: "Bearer sk-synthetic" });
    expect(init.redirect).toBe("error");
  });
  it("sends no authorization header without a key (local LLM)", async () => {
    const fetchImpl = vi.fn(async () => json({ data: [{ id: "local-model" }] }));
    await listModels({ baseUrl: "http://localhost:1234/v1", apiKeyOrigin: "https://openrouter.ai", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((fetchImpl.mock.calls[0] as unknown as [string, Parameters<typeof fetch>[1] & object])[1].headers).not.toHaveProperty("authorization");
  });
  it("uses the global fetch by default", async () => {
    const stub = vi.fn(async () => json({ data: [{ id: "x" }] }));
    vi.stubGlobal("fetch", stub);
    try { expect(await listModels({ baseUrl: "http://localhost:11434/v1" })).toEqual({ ok: true, models: ["x"] }); expect(stub).toHaveBeenCalledTimes(1); }
    finally { vi.unstubAllGlobals(); }
  });
  it.each([
    [401, "APIキー"], [403, "APIキー"], [404, "/v1"], [500, "HTTP 500"],
  ])("reports HTTP %i with a fixed message that never echoes the key or body", async (status, hint) => {
    const fetchImpl = vi.fn(async () => json({ error: "echo sk-synthetic" }, status));
    const result = await listModels({ baseUrl: "https://example.com/v1", apiKey: "sk-synthetic", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.ok).toBe(false);
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain(hint); expect(reason).not.toContain("sk-synthetic"); expect(reason).not.toContain("example.com");
  });
  it("fails without throwing on network errors, bad JSON, wrong shape and empty lists", async () => {
    const key = "sk-synthetic";
    const run = (fetchImpl: () => Promise<Response>) => listModels({ baseUrl: "http://localhost:1234/v1", apiKey: key, fetchImpl: fetchImpl as unknown as typeof fetch });
    const results = await Promise.all([
      run(async () => { throw new TypeError("fetch failed " + key); }),
      run(async () => new Response("<html>", { status: 200 })),
      run(async () => json({ models: [] })),
      run(async () => json({ data: [] })),
    ]);
    for (const result of results) { expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain(key); }
    expect((results[0] as { reason: string }).reason).toContain("接続できませんでした");
  });
  it("rejects empty and unsafe URLs before any request", async () => {
    const fetchImpl = vi.fn();
    for (const baseUrl of ["", "  ", "http://example.com/v1", "ftp://x/v1", "not a url", "https://user:pw@example.com/v1"]) {
      expect((await listModels({ baseUrl, apiKey: "sk-synthetic", fetchImpl: fetchImpl as unknown as typeof fetch })).ok).toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("times out", async () => {
    const fetchImpl = (_url: string, init: Parameters<typeof fetch>[1] & object) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))));
    const result = await listModels({ baseUrl: "http://localhost:1234/v1", fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 5 });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("タイムアウト") });
  });
});
