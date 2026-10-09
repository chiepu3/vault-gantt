import { describe, it, expect, vi } from "vitest";
import { ChatSession, type ChatProvider, type ChatEvent } from "../../src/ai/chat-session";
import { controlRequest } from "../../src/app/operations/control-handlers";
import { runtimeFixture } from "./operation-runtime-fixture";
async function fixture() {
  const f = await runtimeFixture();
  const provider: ChatProvider = { connected: () => true, stream: vi.fn(async function* () { yield { type: "text", text: "response" } as ChatEvent; }) };
  const discard = vi.fn();
  const session = new ChatSession({}, { plan: async () => { throw new Error("unused"); }, commit: async () => { throw new Error("unused"); }, discard }, provider);
  const context = { ...f.context, capabilities: ["chat-control" as const, "external" as const] };
  return { ...f, provider, discard, session, context };
}
describe("chat control operation handlers", () => {
  it("Q01 changes in-memory configuration without sending; refuses unsafe endpoints", async () => {
    const f = await fixture();
    const config = { provider: "openai-compatible" as const, endpoint: "https://model.example.test/v1", model: "configured-model", auth: "secret" as const, secretId: "existing-secret" };
    expect(await controlRequest("Q01", config, f.context, f.session)).toMatchObject({ status: "applied", effects: [{ kind: "conversation", action: "configure" }] });
    expect(f.session.config).toEqual(config); expect(f.provider.stream).not.toHaveBeenCalled(); expect(f.persistSettings).not.toHaveBeenCalled();
    for (const endpoint of ["http://public.example.test", "https://secret:password@example.test", "https://example.test?q=secret", "file:///tmp/x"]) await expect(controlRequest("Q01", { ...config, endpoint }, f.context, f.session)).rejects.toMatchObject({ error: { code: "INVALID_INPUT" } });
    await controlRequest("Q01", { ...config, endpoint: "http://127.0.0.1:8080/v1" }, f.context, f.session);
  });
  it("Q02 bounds conversations to 10 and discards old proposals; Q03 selects only existing conversations", async () => {
    const f = await fixture(), first = f.session.active.id;
    for (let i = 0; i < 12; i++) await controlRequest("Q02", {}, f.context, f.session);
    expect(f.session.conversations).toHaveLength(10); expect(f.session.conversations.some((conversation) => conversation.id === first)).toBe(false);
    const target = f.session.conversations[0].id;
    expect(await controlRequest("Q03", { conversationId: target }, f.context, f.session)).toMatchObject({ effects: [{ action: "select" }] }); expect(f.session.active.id).toBe(target);
    await expect(controlRequest("Q03", { conversationId: "missing" }, f.context, f.session)).rejects.toMatchObject({ error: { code: "NOT_FOUND" } });
  });
  it("Q04 sends through the existing provider and Q05 stops only the selected conversation", async () => {
    const f = await fixture(), conversationId = f.session.active.id;
    expect(await controlRequest("Q04", { conversationId, text: " hello " }, f.context, f.session)).toMatchObject({ status: "applied", effects: [{ action: "send", after: { messageCount: 2 } }] });
    expect(f.session.active.messages[0].text).toBe("hello"); expect(f.session.active.messages[1].text).toBe("response");
    expect(await controlRequest("Q05", { conversationId }, f.context, f.session)).toMatchObject({ effects: [{ action: "stop" }] });
    f.session.newConversation();
    await expect(controlRequest("Q05", { conversationId }, f.context, f.session)).rejects.toMatchObject({ error: { code: "POLICY_DENIED" } });
    expect(f.vault.getModifyCallCount()).toBe(0);
  });
  it("Q06 retries only failed replies and preserves the existing message context", async () => {
    const f = await fixture(), conversationId = f.session.active.id;
    await controlRequest("Q04", { conversationId, text: "original" }, f.context, f.session);
    await expect(controlRequest("Q06", { conversationId }, f.context, f.session)).rejects.toMatchObject({ error: { code: "INVALID_INPUT" } });
    f.session.active.status = "failed";
    expect(await controlRequest("Q06", { conversationId }, f.context, f.session)).toMatchObject({ effects: [{ action: "retry", after: { messageCount: 4 } }] });
    expect(f.session.active.messages[2].text).toBe("original");
  });
  it("refuses capability, abort, busy and message-limit violations", async () => {
    const f = await fixture(), input = { conversationId: f.session.active.id, text: "hello" };
    await expect(controlRequest("Q04", input, { ...f.context, capabilities: ["chat-control"] }, f.session)).rejects.toMatchObject({ error: { code: "POLICY_DENIED" } });
    f.session.active.status = "running";
    await expect(controlRequest("Q04", input, f.context, f.session)).rejects.toMatchObject({ error: { code: "BUSY_CONVERSATION" } });
    f.session.active.status = "idle";
    f.session.active.messages = Array.from({ length: 99 }, () => ({ role: "user", text: "x", proposals: [] }));
    await expect(controlRequest("Q04", input, f.context, f.session)).rejects.toMatchObject({ error: { code: "INVALID_INPUT" } });
    const controller = new AbortController(); controller.abort();
    await expect(controlRequest("Q02", {}, { ...f.context, signal: controller.signal }, f.session)).rejects.toMatchObject({ error: { code: "POLICY_DENIED" } });
  });
  it("maps request aborts to the current send and removes the listener afterwards", async () => {
    const f = await fixture(), controller = new AbortController();
    f.provider.stream = async function* ({ signal }) { await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })); if (!signal.aborted) yield { type: "text", text: "unused" }; };
    const request = controlRequest("Q04", { conversationId: f.session.active.id, text: "hello" }, { ...f.context, signal: controller.signal }, f.session);
    controller.abort();
    expect(await request).toMatchObject({ status: "cancelled", effects: [{ after: { status: "cancelled" } }] });
  });
  it("an old request abort cannot stop a newer conversation while the old stream drains", async () => {
    const f = await fixture(), oldAbort = new AbortController();
    const requests: { signal: AbortSignal; release: () => void }[] = [];
    f.provider.stream = async function* ({ signal }) {
      await new Promise<void>((resolve) => requests.push({ signal, release: resolve }));
      if (!signal.aborted) yield { type: "text", text: "done" };
    };
    const oldId = f.session.active.id;
    const old = controlRequest("Q04", { conversationId: oldId, text: "old" }, { ...f.context, signal: oldAbort.signal }, f.session);
    f.session.newConversation();
    const fresh = controlRequest("Q04", { conversationId: f.session.active.id, text: "fresh" }, f.context, f.session);
    oldAbort.abort(); expect(requests[1].signal.aborted).toBe(false);
    requests[0].release(); expect(await old).toMatchObject({ effects: [{ after: { activeConversationId: oldId, status: "cancelled" } }] });
    expect(f.session.active.status).toBe("running");
    requests[1].release(); await fresh; expect(f.session.active.status).toBe("idle");
  });
});
