import { describe, it, expect, vi } from "vitest";
import { ChatSession, partsOf, type ChatEvent, type ConnectionConfig } from "../../src/ai/chat-session";
import { OperationRegistry } from "../../src/app/operation-registry";
import { HistoryManager } from "../../src/app/history-manager";
import { DEFAULT_SETTINGS } from "../../src/core/constants";
import { FakeVault } from "../app/fake-vault";
import { FakeProvider } from "./fake-provider";
const config: ConnectionConfig = { provider: "openai-compatible", endpoint: "http://localhost:1234/v1", model: "synthetic-a", auth: "none", secretId: "" };
function setup(events: (snapshot: () => string[]) => AsyncIterable<ChatEvent>) {
  const vault = new FakeVault();
  const registry = new OperationRegistry({ settings: { ...DEFAULT_SETTINGS }, historyManager: new HistoryManager(), invalidate: vi.fn() }, () => vault);
  const holder: { session?: ChatSession } = {};
  const states = () => partsOf(holder.session!.active.messages.at(-1)!).map((part) => part.type === "tool" || part.type === "reasoning" ? part.type + ":" + part.state : part.type);
  const session = new ChatSession(vault, registry, new FakeProvider(() => events(states))); session.configure(config); holder.session = session;
  return session;
}
const plan = (id: string): ChatEvent => ({ type: "plan", plan: { previewId: id, operation: "update", summary: "", count: 0, diffs: [] }, operation: "update", input: {} });
describe("ordered assistant parts", () => {
  it("keeps interleaved reasoning, text, tool calls and proposals in arrival order and updates them live", async () => {
    const seen: string[][] = [];
    const session = setup(async function* (snapshot) {
      yield { type: "reasoning", id: "0:r", text: "探す" }; seen.push(snapshot());
      yield { type: "reasoning", id: "0:r", text: "べき" };
      yield { type: "reasoning-end", id: "0:r" };
      yield { type: "tool", id: "c1", name: "tasks_search", state: "running" }; seen.push(snapshot());
      yield { type: "tool", id: "c1", name: "tasks_search", input: { name: "A" }, state: "running" };
      yield { type: "tool", id: "c1", name: "tasks_search", input: { name: "A" }, output: { items: [] }, state: "done" }; seen.push(snapshot());
      yield { type: "text", text: "見つけ" }; yield { type: "text", text: "ました" };
      yield { type: "tool", id: "c2", name: "operations_propose", state: "running" };
      yield plan("p1");
      yield { type: "tool", id: "c2", name: "operations_propose", output: {}, state: "done" };
      yield { type: "text", text: "変更案です。" };
    });
    await session.send("A を動かして");
    const parts = partsOf(session.active.messages[1]);
    expect(parts.map((part) => part.type)).toEqual(["reasoning", "tool", "text", "tool", "proposal", "text"]);
    expect(parts[0]).toMatchObject({ text: "探すべき", state: "done" });
    expect(parts[1]).toMatchObject({ name: "tasks_search", input: { name: "A" }, output: { items: [] }, state: "done" });
    expect(parts[2]).toMatchObject({ text: "見つけました" });
    expect(parts[4]).toMatchObject({ previewId: "p1" });
    expect(parts[5]).toMatchObject({ text: "変更案です。" });
    expect(session.active.messages[1].text).toBe("見つけました変更案です。");
    // Visible while the turn was still running.
    expect(seen).toEqual([["reasoning:streaming"], ["reasoning:done", "tool:running"], ["reasoning:done", "tool:done"]]);
  });
  it("closes spinners when the turn ends or fails", async () => {
    const session = setup(async function* () {
      yield { type: "reasoning", id: "0:r", text: "考え中" };
      yield { type: "tool", id: "c1", name: "tasks_search", state: "running" };
      throw new Error("boom");
    });
    await session.send("x");
    const parts = partsOf(session.active.messages[1]);
    expect(parts.map((part) => part.type === "tool" || part.type === "reasoning" ? part.state : "")).toEqual(["done", "error"]);
  });
  it("derives parts from text and proposals for messages without them", () => {
    expect(partsOf({ role: "assistant", text: "答え", proposals: [] }).map((part) => part.type)).toEqual(["text"]);
  });
});
