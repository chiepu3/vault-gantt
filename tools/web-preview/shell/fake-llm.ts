// window.fetch patch: answers an OpenAI-compatible API at FAKE_ORIGIN with a scripted SSE stream, so the AI chat view can be
// tried without a model. Script (same shape as tools/e2e/fake-openai-server.mjs): reasoning -> tasks_search -> reasoning ->
// operations_propose (shift "デザイン確認" by +3 days) -> short text. Other messages get a canned reply.
/* eslint-disable @typescript-eslint/no-explicit-any */
export const FAKE_ORIGIN = "https://fake-llm.invalid";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chunk = (delta: any, finish: string | null = null) => "data: " + JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n";
const text = (m: any): string => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));

function shiftDays(d: string, n: number): string {
  const [y, m, day] = d.split("-").map(Number); const t = new Date(y, m - 1, day + n);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}
function findTarget(messages: any[]): { id?: string; revision?: string; dates: string[] } {
  for (const m of messages) {
    if (m.role !== "tool") continue;
    const t = text(m), id = /"id":"([^"]*::design[^"]*)"/.exec(t)?.[1];
    if (!id) continue;
    const sch = /"schedule":\{"start":"([\d-]+)","end":"([\d-]+)"/.exec(t);
    return { id, revision: /"revision":"([^"]+)"/.exec(t)?.[1], dates: sch ? [sch[1], sch[2]] : [] };
  }
  return { dates: [] };
}

async function script(request: any, out: (s: string) => void): Promise<void> {
  const messages: any[] = request.messages ?? [];
  const lastUser = messages.map((m) => m.role).lastIndexOf("user");
  const userText = text(messages[lastUser]).replace(/^"|"$/g, "");
  const toolResults = messages.slice(lastUser + 1).filter((m) => m.role === "tool").length;
  const send = (d: any, f: string | null = null) => out(chunk(d, f));
  const speak = async (s: string) => { for (const p of s.match(/.{1,4}/gs) ?? []) { send({ content: p }); await sleep(20); } };
  const think = async (parts: string[]) => { for (const p of parts) { send({ reasoning_content: p }); await sleep(60); } };
  send({ role: "assistant", content: "" });
  const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
  if (!hasTools) { await speak("デザイン確認を3日後ろにずらす案を作りました。カードの内容でよければ「承認して保存」を押してください。押すまでは保存されません。"); send({}, "stop"); }
  else if (!/ずら|移動|変更|動か/.test(userText)) { await speak("こんにちは。これはプレビュー用の台本AIです。「デザイン確認を3日後ろへずらして」と送ると、検索→変更案の作成までを再現します。"); send({}, "stop"); }
  else if (toolResults === 0) {
    await think(["まず「デザイン確認」というタスクを探して、", "いまの日程を確認します。"]);
    send({ tool_calls: [{ index: 0, id: "call-search", type: "function", function: { name: "tasks_search", arguments: '{"name":"デザイン確認",' } }] }); await sleep(150);
    send({ tool_calls: [{ index: 0, function: { arguments: '"fields":["identity","schedule"]}' } }] }); send({}, "tool_calls");
  } else if (toolResults === 1) {
    const t = findTarget(messages);
    const [s, e] = t.dates.length === 2 ? [shiftDays(t.dates[0], 3), shiftDays(t.dates[1], 3)] : [shiftDays(new Date().toISOString().slice(0, 10), 4), shiftDays(new Date().toISOString().slice(0, 10), 6)];
    await think(["見つかりました。", `${s}〜${e}へ3日後ろにずらす案を作ります。`]);
    const input = { operationId: "T19", input: { subtaskId: t.id ?? "missing", start: s, end: e, ...(t.revision ? { expectedRevision: t.revision } : {}) } };
    send({ tool_calls: [{ index: 0, id: "call-propose", type: "function", function: { name: "operations_propose", arguments: JSON.stringify(input) } }] }); send({}, "tool_calls");
  } else { await speak("対応する案を作成しました。内容を確認して、よければ承認してください。"); send({}, "stop"); }
}

export function installFakeLlm(): void {
  const real = window.fetch.bind(window);
  window.fetch = async (input: any, init?: any) => {
    const req = input instanceof Request ? input : null;
    const url = String(req?.url ?? input);
    if (!url.startsWith(FAKE_ORIGIN)) return real(input, init);
    const path = new URL(url).pathname;
    const json = (o: any) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    if (path.endsWith("/models")) return json({ object: "list", data: [{ id: "fake-model", object: "model" }, { id: "fake-model-large", object: "model" }] });
    if (!path.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
    const body = JSON.parse(String(init?.body ?? (req ? await req.text() : "{}")));
    const signal: AbortSignal | undefined = init?.signal ?? req?.signal;
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(ctl) {
        const out = (s: string) => { if (!signal?.aborted) ctl.enqueue(enc.encode(s)); };
        try { await script(body, out); } finally { out("data: [DONE]\n\n"); try { ctl.close(); } catch { /* aborted */ } }
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
}
