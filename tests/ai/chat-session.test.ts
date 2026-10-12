import { describe, it, expect, vi } from "vitest";
import { ChatSession, type ConnectionConfig } from "../../src/ai/chat-session";
import { OperationRegistry } from "../../src/app/operation-registry";
import { HistoryManager } from "../../src/app/history-manager";
import { DEFAULT_SETTINGS } from "../../src/core/constants";
import { FakeVault } from "../app/fake-vault";
import { createTask } from "../../src/app/task-operations";
import { buildFileRevision } from "../../src/core/utils";
import type { TaskRow } from "../../src/core/types";
import { FakeProvider } from "./fake-provider";
const config: ConnectionConfig = { provider: "openai-compatible", endpoint: "http://localhost:1234/v1", model: "synthetic-a", auth: "none", secretId: "" };
function setup(provider = new FakeProvider()) {
  const vault = new FakeVault();
  const registry = new OperationRegistry({ settings: { ...DEFAULT_SETTINGS }, historyManager: new HistoryManager(), invalidate: vi.fn() }, () => vault);
  const changed = vi.fn();
  const session = new ChatSession(vault, registry, provider, changed);
  return { session, registry, vault, changed, provider };
}
describe("vault-scoped chat session (deterministic fake, not real LLM)", () => {
  it("streams user/assistant roles and preserves context for the next turn", async () => {
    const a = setup(); a.session.configure(config);
    const states: string[] = []; a.session.subscribe(() => states.push(a.session.active.messages.at(-1)?.text ?? ""));
    await a.session.send("テスト");
    expect(states).toContain("合成");
    expect(a.session.active.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(a.session.active.messages[1].text).toBe("合成応答");
    await a.session.send("次の質問");
    expect(a.provider.requests[1].messages).toHaveLength(3);
    expect(a.session.active.status).toBe("idle");
  });
  it("missing configuration is disconnected, not a fake success", async () => {
    const a = setup(); await a.session.send("hello");
    expect(a.session.connected).toBe(false);
    expect(a.session.active.status).toBe("failed");
    expect(a.provider.requests).toHaveLength(0);
  });
  it("model changes affect only subsequent requests", async () => {
    const a = setup(); a.session.configure(config); await a.session.send("one");
    a.session.configure({ ...config, model: "synthetic-b" }); await a.session.send("two");
    expect(a.provider.requests.map((request) => request.config.model)).toEqual(["synthetic-a", "synthetic-b"]);
  });
  it("failures are sanitized and retry performs a new request", async () => {
    let attempt = 0;
    const provider = new FakeProvider(async function* () { if (++attempt === 1) throw new Error("DO-NOT-LOG-SYNTHETIC-SECRET"); yield { type: "text", text: "ok" }; });
    const a = setup(provider); a.session.configure(config); await a.session.send("hello");
    expect(a.session.active.status).toBe("failed"); expect(a.session.active.error).not.toContain("SECRET");
    await a.session.retry(); expect(a.session.active.status).toBe("idle"); expect(provider.requests).toHaveLength(2);
  });
  it("stop rejects late output and late plans without writing", async () => {
    let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; });
    const a = setup(new FakeProvider(async function* () { yield { type: "text", text: "early" }; await wait; yield { type: "text", text: "late" }; }));
    a.session.configure(config); const run = a.session.send("hello");
    for (let tick = 0; tick < 10; tick++) await Promise.resolve();
    a.session.stop(); release(); await run;
    expect(a.session.active.status).toBe("cancelled");
    expect(a.session.active.messages[1].text).toBe("early"); expect(a.vault.getCreateCallCount()).toBe(0);
  });
  it("a preview never commits without user confirmation; duplicate confirmation is harmless", async () => {
    const a = setup();
    const plan = await a.registry.plan("create", { name: "Synthetic" });
    const session = new ChatSession(a.vault, a.registry, new FakeProvider(async function* () { yield { type: "plan", plan, operation: "create", input: { name: "Synthetic" } }; }), a.changed);
    session.configure(config); await session.send("create");
    const proposal = session.active.messages[1].proposals[0];
    expect(session.active.status).toBe("preview"); expect(a.vault.getCreateCallCount()).toBe(0);
    await Promise.all([session.confirm(proposal), session.confirm(proposal)]);
    expect(a.vault.getCreateCallCount()).toBe(1); expect(a.changed).toHaveBeenCalledOnce();
    expect(proposal.result?.committed).toBe(1);
  });
  it("new conversations retain older histories within the vault and never leak to another vault", async () => {
    const a = setup(); a.session.configure(config); await a.session.send("first");
    const first = a.session.active.id;
    a.session.newConversation(); expect(a.session.active.messages).toHaveLength(0);
    a.session.select(first); expect(a.session.active.messages).toHaveLength(2);
    const b = setup(); expect(b.session.active.messages).toHaveLength(0); expect(b.session.scope).not.toBe(a.session.scope);
  });
});

describe("chat review regressions", () => {
  function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
  async function tick() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
  it("an old aborted send cannot replace a newer send's running state or stop controller", async () => {
    const first = deferred(); const second = deferred(); let requests = 0;
    const provider = new FakeProvider(async function* () { const gate = ++requests === 1 ? first : second; yield { type: "text", text: "start" }; await gate.promise; yield { type: "text", text: "end" }; });
    const a = setup(provider); a.session.configure(config);
    const old = a.session.send("A"); await tick(); a.session.stop();
    const current = a.session.send("B"); await tick(); first.resolve(); await old;
    expect(a.session.active.status).toBe("running");
    expect(provider.requests[1].signal.aborted).toBe(false);
    a.session.stop(); expect(provider.requests[1].signal.aborted).toBe(true); second.resolve(); await current;
  });
  it("stale re-preview refreshes old revision guards and retains the failed result", async () => {
    const a = setup(); const row = await createTask(a.vault, { ...DEFAULT_SETTINGS }, "Example");
    const expectedRevision = buildFileRevision(a.vault.getFileByPath(row.id)! as TaskRow["file"]);
    const input = { taskId: row.id, patch: { notes: "new" }, expectedRevision };
    const plan = await a.registry.plan("update", input);
    const session = new ChatSession(a.vault, a.registry, new FakeProvider(async function* () { yield { type: "plan", plan, operation: "update", input }; }));
    session.configure(config); await session.send("change");
    const proposal = session.active.messages[1].proposals[0];
    const file = a.vault.getFileByPath(row.id)!; await a.vault.modify(file, (await a.vault.read(file)) + "\n");
    await session.confirm(proposal); expect(proposal.result?.kind).toBe("stale");
    await session.repreview(proposal);
    expect(session.active.status).toBe("preview");
    expect(session.active.messages[1].proposals).toHaveLength(2);
    expect(proposal.result?.kind).toBe("stale");
  });
});

describe("cancelled confirmation ownership", () => {
  it("retains committed results without clobbering a later stream and carries the result forward", async () => {
    const a = setup(); const plan = await a.registry.plan("create", { name: "Synthetic" });
    let releaseCommit!: (result: import("../../src/app/operation-registry").OperationResult) => void;
    const commitResult = new Promise<import("../../src/app/operation-registry").OperationResult>((resolve) => { releaseCommit = resolve; });
    let releaseStream!: () => void; const gate = new Promise<void>((resolve) => { releaseStream = resolve; });
    let calls = 0;
    const provider = new FakeProvider(async function* () {
      if (++calls === 1) yield { type: "plan", plan, operation: "create", input: { name: "Synthetic" } };
      else { yield { type: "text", text: "new" }; await gate; yield { type: "text", text: " done" }; }
    });
    const session = new ChatSession(a.vault, a.registry, provider, a.changed); session.configure(config); await session.send("create");
    vi.spyOn(a.registry, "commit").mockReturnValue(commitResult);
    const proposal = session.active.messages[1].proposals[0]; const old = session.confirm(proposal); session.stop();
    const next = session.send("B"); for (let i = 0; i < 10; i++) await Promise.resolve();
    releaseCommit({ kind: "success", committed: 1, total: 1, results: [], diffs: plan.diffs, message: "synthetic saved" }); await old;
    expect(session.active.status).toBe("running"); expect(proposal.result?.committed).toBe(1);
    releaseStream(); await next; expect(session.active.context.at(-1)?.content).toContain("操作の実際の結果");
  });
});
