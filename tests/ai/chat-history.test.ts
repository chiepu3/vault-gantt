import { describe, expect, it } from "vitest";
import { restoreChatHistory, serializeChatHistory } from "../../src/ai/chat-history";
import { ChatSession, type ChatProvider, type Conversation } from "../../src/ai/chat-session";

const conversation = (id: string, title: string): Conversation => ({ id, title, status: "running", error: "x", draft: "", context: [{ role: "user", content: "q" }], messages: [
  { role: "user", text: "q", proposals: [], parts: [{ type: "text", id: "t", text: "q" }] },
  { role: "assistant", text: "a", proposals: [], parts: [{ type: "tool", id: "c", name: "n", state: "running" }, { type: "proposal", id: "proposal:p", previewId: "p" }, { type: "text", id: "t2", text: "a" }] },
] });

describe("chat history", () => {
  it("round-trips conversations, drops proposal cards and idles the status", () => {
    const stored = JSON.parse(JSON.stringify(serializeChatHistory([conversation("1", "q"), { ...conversation("2", "新しい会話"), messages: [] }], "1")));
    expect(stored.conversations).toHaveLength(1);
    const { conversations, activeId } = restoreChatHistory(stored);
    expect(activeId).toBe("1");
    expect(conversations[0].status).toBe("idle");
    expect(conversations[0].messages[1].parts?.map((part) => part.type)).toEqual(["tool", "text"]);
    expect(conversations[0].context).toHaveLength(1);
  });
  it("starts empty from corrupt data", () => {
    expect(restoreChatHistory(null).conversations).toEqual([]);
    expect(restoreChatHistory({ conversations: [{ id: 1 }, { id: "a", messages: "x" }] }).conversations).toEqual([]);
  });
  it("restores into a session and titles from the first message only", async () => {
    const provider: ChatProvider = { connected: () => true, async *stream() { yield { type: "text", text: "ok" }; } };
    const registry = { plan: async () => { throw new Error("n/a"); }, commit: async () => { throw new Error("n/a"); }, discard: () => undefined };
    const session = new ChatSession({}, registry, provider);
    session.configure({ provider: "openai-compatible", endpoint: "http://x/v1", model: "m", auth: "none", secretId: "" });
    session.restore(restoreChatHistory(serializeChatHistory([conversation("7", "q")], "7")).conversations, "7");
    expect(session.active.id).toBe("7");
    await session.send("  second   question  ");
    expect(session.active.title).toBe("q");
    session.newConversation();
    expect(Number(session.active.id)).toBeGreaterThan(7);
    await session.send("first\nline");
    expect(session.active.title).toBe("first line");
  });
});
