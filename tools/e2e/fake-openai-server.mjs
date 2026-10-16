// A tiny OpenAI-compatible server for looking at the chat UI end to end (no real model, no network).
// POST /v1/chat/completions with stream:true answers with SSE: reasoning deltas, a tool call to tasks_search,
// a tool call to operations_propose for the task found, then a short text. `hold(stage)` pauses the reply at
// "reasoning", "tool-args" or "text" until `release()`, so a screenshot can catch the mid-stream state.
import http from "node:http";

const chunk = (delta, finish = null) => "data: " + JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findSubtaskId(messages) {
  for (const message of messages) {
    if (message.role !== "tool") continue;
    const match = /"id":"([^"]*::design[^"]*)"/.exec(typeof message.content === "string" ? message.content : JSON.stringify(message.content));
    if (match) return match[1];
  }
  return undefined;
}
function findRevision(messages) {
  for (const message of messages) {
    if (message.role !== "tool") continue;
    const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    const match = /"revision":"([^"]+)"/.exec(text);
    if (match) return match[1];
  }
  return undefined;
}

export async function startFakeOpenAI({ port = 0, tokenDelayMs = 25 } = {}) {
  let holdStage; let releaseHold;
  const requests = []; const state = { dates: ["2026-10-13", "2026-10-15"] };
  const waitHold = async (stage) => {
    if (holdStage !== stage) return;
    await new Promise((resolve) => { releaseHold = resolve; });
  };
  const server = http.createServer((req, res) => {
    // Obsidian calls from app://obsidian.md, so the server answers the CORS preflight like a real local server does.
    res.setHeader("access-control-allow-origin", "*"); res.setHeader("access-control-allow-headers", "*"); res.setHeader("access-control-allow-methods", "POST, GET, OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) { res.writeHead(404); res.end(); return; }
    let body = "";
    req.on("data", (part) => { body += part; });
    req.on("end", async () => {
      const request = JSON.parse(body); requests.push(request);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (delta, finish) => { if (!res.destroyed) res.write(chunk(delta, finish)); };
      const speak = async (text, stage) => {
        let index = 0;
        for (const piece of text.match(/.{1,4}/gs) ?? []) {
          send({ content: piece }); await sleep(tokenDelayMs);
          if (++index === 6 && stage) await waitHold(stage);
        }
      };
      const think = async (parts, stage) => {
        for (const [index, part] of parts.entries()) { send({ reasoning_content: part }); await sleep(tokenDelayMs * 3); if (index === 0 && stage) await waitHold(stage); }
      };
      try {
        const messages = request.messages ?? [];
        const lastUser = messages.map((message) => message.role).lastIndexOf("user");
        const afterUser = messages.slice(lastUser + 1);
        const toolResults = afterUser.filter((message) => message.role === "tool").length;
        const userText = String(messages[lastUser]?.content ?? "");
        send({ role: "assistant", content: "" });
        if (!request.tools) {
          await speak("デザイン確認を10/13〜10/15に動かす案を作りました。いまの日程から3日後ろにずれます。カードの内容でよければ「承認して保存」を押してください。押すまでは保存されません。", "text");
          send({}, "stop");
        } else if (/ありがとう/.test(userText)) {
          await speak("どういたしまして。ほかにも日程で気になるところがあれば、いつでも声をかけてください。", undefined);
          send({}, "stop");
        } else if (!/ずら|移動|変更|動か/.test(userText)) {
          await speak("こんにちは。タスクの日程の確認や、変更の相談ができます。たとえば「デザイン確認を3日後ろへずらして」のように話しかけてください。", "text");
          send({}, "stop");
        } else if (toolResults === 0) {
          await think(["まず「デザイン確認」というタスクを探して、", "いまの日程を確認します。"], "reasoning");
          await sleep(tokenDelayMs * 4);
          send({ tool_calls: [{ index: 0, id: "call-search", type: "function", function: { name: "tasks_search", arguments: '{"name":"デザイン確認",' } }] });
          await waitHold("tool-args");
          await sleep(tokenDelayMs * 4);
          send({ tool_calls: [{ index: 0, function: { arguments: '"fields":["identity","schedule"]}' } }] });
          send({}, "tool_calls");
        } else if (toolResults === 1) {
          const id = findSubtaskId(messages) ?? "missing";
          const revision = findRevision(messages);
          await think(["見つかりました。10/10〜10/12なので、", "3日後ろの10/13〜10/15へ変更する案を作ります。"], undefined);
          const input = { operationId: "T19", input: { subtaskId: id, start: state.dates[0], end: state.dates[1], ...(revision ? { expectedRevision: revision } : {}) } };
          send({ tool_calls: [{ index: 0, id: "call-propose", type: "function", function: { name: "operations_propose", arguments: JSON.stringify(input) } }] });
          send({}, "tool_calls");
        } else {
          await speak("対応する案を作成しました。", undefined);
          send({}, "stop");
        }
      } finally {
        if (!res.destroyed) { res.write("data: [DONE]\n\n"); res.end(); }
      }
    });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    port: server.address().port, requests, state,
    hold(stage) { holdStage = stage; },
    release() { holdStage = undefined; releaseHold?.(); releaseHold = undefined; },
    close() { holdStage = undefined; releaseHold?.(); server.closeAllConnections?.(); return new Promise((resolve) => server.close(() => resolve())); },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fake = await startFakeOpenAI({ port: Number(process.argv[2] ?? 8787) });
  console.log("fake OpenAI-compatible server on http://127.0.0.1:" + fake.port + "/v1");
}
