import { afterEach, describe, expect, it, vi } from "vitest";
import { SdkChatProvider } from "../../src/ai/sdk-provider";
import type { ChatEvent, ConnectionConfig } from "../../src/ai/chat-session";
import { runtimeFixture } from "../app/operation-runtime-fixture";
import { CHILD_ID, PARENT_ID } from "../contracts/fixtures";
const config: ConnectionConfig = { provider: "openai-compatible", endpoint: "http://localhost:1234/v1", model: "synthetic", auth: "none", secretId: "" };
afterEach(() => vi.unstubAllGlobals());
function response(tool?: { name: string; input: unknown }, text = "") {
  const base = { id: "chat-fixture", object: "chat.completion.chunk", created: 1, model: "synthetic" };
  const chunks = [
    { ...base, choices: [{ index: 0, delta: tool ? { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call-" + tool.name, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.input) } }] } : { role: "assistant", content: text }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] },
  ];
  return new Response(chunks.map((part) => "data: " + JSON.stringify(part) + "\n\n").join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
describe("daily work log through the real provider loop", () => {
  it("looks up candidates, proposes one card, then explains it", async () => {
    const f = await runtimeFixture(); let round = 0;
    // eslint-disable-next-line no-undef
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(init!.body as string);
      ++round;
      if (round === 1) { expect(request.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(expect.arrayContaining(["worklog_candidates", "worklog_propose"])); return response({ name: "worklog_candidates", input: { date: "2026-10-13", labels: ["リリース レビュー", "リリース 不具合修正", "部長の呼び出し"] } }); }
      if (round === 2) {
        const result = JSON.parse(request.messages.find((message: { role: string }) => message.role === "tool").content);
        expect(result.results[0].subtasks[0].subtaskId).toBe(CHILD_ID);
        return response({ name: "worklog_propose", input: { date: "2026-10-13", entries: [{ subtaskId: CHILD_ID, hours: 3 }, { parentId: PARENT_ID, newSubtaskName: "不具合修正", hours: 1.5 }, { eventTitle: "部長の呼び出し", hours: 0.5 }] } });
      }
      expect(request.tools).toBeUndefined();
      return response(undefined, "3件の実績を登録する案を作りました。カードで承認すると保存されます。");
    });
    vi.stubGlobal("fetch", fetchMock);
    const events: ChatEvent[] = [];
    for await (const event of new SdkChatProvider(f.registry, () => null, f.service).stream({ config, messages: [{ role: "user", content: "今日はリリースのレビュー3h、不具合修正1.5h、部長の呼び出し30minでした" }], signal: new AbortController().signal })) events.push(event);
    expect(events.filter((event) => event.type === "plan")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "completion", completion: { kind: "proposal-created", toolErrors: 0 } });
    f.service.dispose();
  });
});
