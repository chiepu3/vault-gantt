/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, afterEach } from "vitest";
import { AgentView } from "../../src/ui/agent-view";
import { ChatSession, type ChatMessage } from "../../src/ai/chat-session";
import { OperationRegistry } from "../../src/app/operation-registry";
import { HistoryManager } from "../../src/app/history-manager";
import { DEFAULT_SETTINGS } from "../../src/core/constants";
import { FakeVault } from "../app/fake-vault";
import { FakeProvider } from "../ai/fake-provider";
import { createFakeDocument, deepText, findAll, type FakeEl } from "../stubs/fake-dom";
import { CREATE_PREVIEW } from "../contracts/fixtures";
import { fakePorts } from "./preview-fakes";
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

async function open(previews: readonly any[] = [], provider = new FakeProvider()) {
  vi.stubGlobal("document", createFakeDocument());
  const vault = new FakeVault();
  const registry = new OperationRegistry({ settings: { ...DEFAULT_SETTINGS }, historyManager: new HistoryManager(), invalidate: () => undefined }, () => vault);
  const session = new ChatSession(vault, registry, provider);
  session.configure({ provider: "openai-compatible", endpoint: "http://localhost:1234", model: "synthetic", auth: "none", secretId: "" });
  const ports = fakePorts(previews.map((preview) => ({ ...preview, origin: { kind: "chat", conversationId: session.active.id } })));
  const view = new AgentView({} as any, { session, openSettings: vi.fn(), openGantt: vi.fn(), undo: vi.fn(), canUndo: () => false, previewPorts: ports });
  await view.onOpen();
  return { view, session, ports, root: view.containerEl as unknown as FakeEl };
}
const order = (root: FakeEl, test: (el: FakeEl) => boolean): number[] => {
  const all = findAll(root, () => true);
  return findAll(root, test).map((el) => all.indexOf(el));
};
const assistant = (parts: ChatMessage["parts"], extra: Partial<ChatMessage> = {}): ChatMessage => ({ role: "assistant", text: "", proposals: [], parts, ...extra });
const user = (text: string): ChatMessage => ({ role: "user", text, proposals: [], parts: [{ type: "text", id: "t", text }] });

describe("AgentView streams ordered parts", () => {
  it("renders reasoning, tool rows, text and the card in the order they happened, with later messages below the card", async () => {
    const { view, session, root } = await open([CREATE_PREVIEW]);
    session.active.messages = [
      user("予定を追加して"),
      assistant([
        { type: "reasoning", id: "0:r", text: "候補を探す", state: "done" },
        { type: "tool", id: "c1", name: "tasks_search", input: { name: "A" }, output: { items: [] }, state: "done" },
        { type: "text", id: "t1", text: "見つけました。" },
        { type: "tool", id: "c2", name: "operations_propose", state: "done" },
        { type: "proposal", id: "p", previewId: "create-fixture" },
        { type: "text", id: "t2", text: "この予定を追加する案です。" },
      ]),
      user("ありがとう"),
      assistant([{ type: "text", id: "t3", text: "どういたしまして" }]),
    ];
    view.render();
    const at = (text: string) => order(root, (el) => el.tagName === "SUMMARY" ? deepText(el).includes(text) : el.classList.contains("vg-ai-text") && deepText(el) === text)[0];
    const card = order(root, (el) => el.classList.contains("vg-pv-card"))[0];
    const sequence = [at("考えた内容"), at("タスクを検索"), at("見つけました。"), at("変更案を作成"), card, at("この予定を追加する案です。"), at("ありがとう"), at("どういたしまして")];
    expect(sequence.every((index) => index >= 0)).toBe(true);
    expect([...sequence].sort((a, b) => a - b)).toEqual(sequence);
    // One card, inside the assistant message that proposed it, none appended after the conversation.
    expect(findAll(root, (el) => el.classList.contains("vg-pv-card"))).toHaveLength(1);
    expect(findAll(root, (el) => el.classList.contains("vg-pv-chat-previews"))).toHaveLength(0);
    const message = findAll(root, (el) => el.classList.contains("vg-ai-assistant"))[0];
    expect(findAll(message, (el) => el.classList.contains("vg-pv-card"))).toHaveLength(1);
    await view.onClose(); session.dispose();
  });
  it("places a re-preview next to the original card", async () => {
    const second = { ...CREATE_PREVIEW, previewId: "second-fixture" };
    const { view, session, root } = await open([CREATE_PREVIEW, second]);
    session.active.messages = [user("追加"), assistant([{ type: "proposal", id: "p", previewId: "create-fixture" }, { type: "text", id: "t", text: "後続の文" }])];
    view.render();
    // Not yet linked to a part: it follows the reply rather than being lost.
    expect(order(root, (el) => el.dataset?.previewId === "second-fixture")[0]).toBeGreaterThan(order(root, (el) => el.classList.contains("vg-ai-text") && deepText(el) === "後続の文")[0]);
    session.attachPreview("create-fixture", "second-fixture"); view.render();
    const ids = findAll(root, (el) => el.classList.contains("vg-pv-card")).map((card) => card.dataset.previewId);
    expect(ids).toEqual(["create-fixture", "second-fixture"]);
    expect(order(root, (el) => el.dataset?.previewId === "second-fixture")[0]).toBeLessThan(order(root, (el) => el.classList.contains("vg-ai-text") && deepText(el) === "後続の文")[0]);
    await view.onClose(); session.dispose();
  });
  it("keeps open details open and unchanged rows in place while text streams", async () => {
    const { view, session, root } = await open();
    const tool = { type: "tool" as const, id: "c1", name: "tasks_search", input: { name: "A" }, state: "running" as const };
    const reply = assistant([tool, { type: "text", id: "t1", text: "見つけ" }]);
    session.active.messages = [user("検索"), reply]; session.active.status = "running"; view.render();
    const row = () => findAll(root, (el) => el.classList.contains("vg-ai-tool"))[0] as any;
    const first = row();
    first.open = true; for (const listener of first.listeners.toggle ?? []) listener({});
    (reply.parts![1] as any).text = "見つけました"; view.render();
    expect(row()).toBe(first); expect(row().open).toBe(true);
    // The tool finishes: its row is rebuilt but stays open, and shows input and output.
    Object.assign(reply.parts![0], { state: "done", output: { items: [{ name: "A" }] } }); view.render();
    expect(row()).not.toBe(first); expect(row().open).toBe(true); expect(row().dataset.state).toBe("done");
    const blocks = findAll(row(), (el) => el.className === "vg-ai-json").map((el) => deepText(el));
    expect(blocks).toHaveLength(2); expect(blocks[0]).toContain('"name": "A"'); expect(blocks[1]).toContain('"items"');
    expect(findAll(root, (el) => el.classList.contains("vg-ai-text") && deepText(el) === "見つけました")).toHaveLength(1);
    await view.onClose(); session.dispose();
  });
  it("shows reasoning open while streaming and collapsed when done, unless the reader chose", async () => {
    const { view, session, root } = await open();
    const part = { type: "reasoning" as const, id: "0:r", text: "考え中の内容", state: "streaming" as "streaming" | "done" };
    session.active.messages = [user("質問"), assistant([part])]; session.active.status = "running"; view.render();
    const details = () => findAll(root, (el) => el.classList.contains("vg-ai-reasoning"))[0] as any;
    expect(deepText(details().children[0])).toBe("考え中…"); expect(details().open).toBe(true);
    part.state = "done"; view.render();
    expect(deepText(details().children[0])).toBe("考えた内容"); expect(details().open).toBe(false);
    await view.onClose(); session.dispose();
  });
  it("truncates long tool output behind もっと見る", async () => {
    const { view, session, root } = await open();
    const output = { text: "あ".repeat(4000) };
    session.active.messages = [user("検索"), assistant([{ type: "tool", id: "c1", name: "tasks_get_many", input: {}, output, state: "done" }])];
    view.render();
    const pre = findAll(root, (el) => el.className === "vg-ai-json")[1];
    const more = findAll(root, (el) => el.tagName === "BUTTON" && el.textContent === "もっと見る")[0];
    expect(deepText(pre).length).toBeLessThan(1700);
    for (const listener of more.listeners.click) listener({});
    expect(deepText(pre).length).toBeGreaterThan(4000);
    await view.onClose(); session.dispose();
  });
  it("animates only items that appear after the first render, and only once", async () => {
    const { view, session, root } = await open();
    const reply = assistant([{ type: "text", id: "t1", text: "既存" }]);
    // A conversation that is switched to appears at once.
    session.active.messages = [user("最初"), reply]; const original = session.active.id;
    session.newConversation(); view.render(); session.select(original); view.render();
    expect(findAll(root, (el) => el.classList.contains("vg-ai-enter"))).toHaveLength(0);
    session.active.messages.push(user("次")); view.render();
    const entering = findAll(root, (el) => el.classList.contains("vg-ai-enter"));
    expect(entering).toHaveLength(1); expect(entering[0].classList.contains("vg-ai-user")).toBe(true);
    (reply.parts![0] as any).text = "既存の続き"; view.render(); view.render();
    expect(findAll(root, (el) => el.classList.contains("vg-ai-enter"))).toHaveLength(1);
    expect(findAll(root, (el) => el.classList.contains("vg-ai-text") && deepText(el) === "既存の続き")[0].classList.contains("vg-ai-enter")).toBe(false);
    await view.onClose(); session.dispose();
  });
  it("shows a typing indicator only while waiting for something to show", async () => {
    const { view, session, root } = await open();
    const reply = assistant([]);
    session.active.messages = [user("質問"), reply]; session.active.status = "running"; view.render();
    const typing = () => findAll(root, (el) => el.classList.contains("vg-ai-typing"));
    expect(typing()).toHaveLength(1);
    reply.parts!.push({ type: "text", id: "t", text: "答え" }); view.render();
    expect(typing()).toHaveLength(0);
    reply.parts!.push({ type: "tool", id: "c", name: "tasks_search", state: "done" }); view.render();
    expect(typing()).toHaveLength(1);
    session.active.status = "idle"; view.render();
    expect(typing()).toHaveLength(0);
    await view.onClose(); session.dispose();
  });
});

describe("AgentView composer", () => {
  const key = (init: Record<string, unknown>) => ({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, keyCode: 13, preventDefault: vi.fn(), ...init });
  it("sends on Enter, breaks the line on Shift+Enter and ignores Enter while composing", async () => {
    const provider = new FakeProvider();
    const { view, session, root } = await open([], provider);
    const input = findAll(root, (el) => el.tagName === "TEXTAREA")[0];
    expect(input.placeholder).toContain("Shift+Enter");
    input.value = "こんにちは";
    const fire = (event: ReturnType<typeof key>) => { for (const listener of input.listeners.keydown) listener(event); return event; };
    const shift = fire(key({ shiftKey: true })); expect(shift.preventDefault).not.toHaveBeenCalled();
    const composing = fire(key({ isComposing: true })); expect(composing.preventDefault).not.toHaveBeenCalled();
    const ime = fire(key({ keyCode: 229 })); expect(ime.preventDefault).not.toHaveBeenCalled();
    const other = fire(key({ key: "a" })); expect(other.preventDefault).not.toHaveBeenCalled();
    expect(provider.requests).toHaveLength(0);
    const send = fire(key({})); expect(send.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
    expect(provider.requests[0].messages.at(-1)).toMatchObject({ content: "こんにちは" });
    await view.onClose(); session.dispose();
  });
});
