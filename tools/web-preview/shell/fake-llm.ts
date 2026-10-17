// window.fetch patch: answers an OpenAI-compatible API at FAKE_ORIGIN with scripted SSE streams, so the AI chat view can be tried
// without a model. The scenario is picked by keywords in the latest user message (see SCENARIOS / EXAMPLE_PROMPTS); anything else gets
// a short help listing example prompts. Tool names and operation inputs follow the real plugin (tasks_search, operations_propose with
// {operationId, input}); the script adapts to the branch at runtime by reading the request's `tools` array and tool results.
/* eslint-disable @typescript-eslint/no-explicit-any */
export const FAKE_ORIGIN = "https://fake-llm.invalid";
const TICK = 20, THINK_TICK = 60, CALL_TICK = 90; // fixed delays (ms): text chunk / reasoning chunk / between tool-call argument pieces
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chunk = (delta: any, finish: string | null = null) => "data: " + JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n";
const text = (m: any): string => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));

/** Prompts shown in the shell's "AIに試す例" dropdown; each contains the keyword of its scenario. */
export const EXAMPLE_PROMPTS: Array<[label: string, prompt: string]> = [
  ["ずらして: サブタスクの日程移動", "デザイン確認を3日後ろへずらして"],
  ["タスクを作って: 親+サブタスク2件", "「社内勉強会の準備」というタスクを作って。サブタスクを2つ、日付つきでお願い"],
  ["予定を追加: イベント+計画/実績時間", "予定を追加して。「デザインレビュー会議」、計画2時間・実績1.5時間"],
  ["複数: 複数の変更を一度に提案", "複数の変更をまとめて提案して"],
  ["調べて: 検索のみ(提案なし)", "進行中のタスクを調べて"],
  ["エラー: 不正な入力でエラー表示", "エラーになる操作を試して"],
];
const HELP = "これはプレビュー用の台本AIです。次のように送ると動作を試せます。\n"
  + EXAMPLE_PROMPTS.map(([, p]) => `・${p}`).join("\n") + "\n(キーワード: ずらして / タスクを作って / 予定を追加 / 複数 / 調べて / エラー)";

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today = () => iso(new Date());
function shiftDays(d: string, n: number): string { const [y, m, day] = d.split("-").map(Number); return iso(new Date(y, m - 1, day + n)); }

interface Entity { id: string; name: string; start?: string; end?: string; revision?: string; parent: boolean }
/** Walk every tool result of the request and collect tasks (objects with a string id and a name/title). */
function entities(messages: any[]): Entity[] {
  const found: Entity[] = [];
  const walk = (v: any) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    const name = v.name ?? v.title ?? v.displayName;
    if (typeof v.id === "string" && typeof name === "string") {
      const sch = v.schedule ?? v.fields?.schedule ?? v;
      found.push({ id: v.id, name, parent: !v.id.includes("::"), revision: v.revision ?? v.expectedRevision, start: sch.start ?? sch.plannedStartDate, end: sch.end ?? sch.plannedEndDate });
    }
    Object.values(v).forEach(walk);
  };
  for (const m of messages) {
    if (m.role !== "tool") continue;
    try { let j = JSON.parse(text(m)); if (typeof j === "string") j = JSON.parse(j); walk(j); } catch { /* not JSON */ }
  }
  return found;
}
const find = (es: Entity[], re: RegExp, parent?: boolean) => es.find((e) => re.test(e.name) && (parent === undefined || e.parent === parent));

interface Call { name: string; args: any }
interface Ctx { callText: string; messages: any[]; tools: Set<string>; user: string; round: number; es: Entity[]; toolText: string }
interface Io { think(parts: string[]): Promise<void>; speak(s: string): Promise<void>; calls(cs: Call[]): Promise<void> }

// --- tool-name adaptation: which tools does this branch expose? ---
const searchCall = (c: Ctx, name: string, extra: any = {}): Call =>
  c.tools.has("tasks_search") ? { name: "tasks_search", args: { name, fields: ["identity", "status", "schedule"], ...extra } } : { name: "search", args: { query: name } };
const opFamily = (id: string) => id.startsWith("E") ? "events" : id.startsWith("M") ? (id === "M07" || id === "M08" ? "workload" : "markers") : id >= "T19" && id <= "T25" ? "schedule" : "tasks";
function propose(c: Ctx, operationId: string, input: any): Call {
  if (c.tools.has("operations_propose")) return { name: "operations_propose", args: { operationId, input } };
  const fam = opFamily(operationId) + "_propose";
  return { name: c.tools.has(fam) ? fam : "operations_propose", args: { operationId, input } };
}

type Scenario = (c: Ctx, io: Io) => Promise<void>;
const noTarget = (io: Io, what: string) => io.speak(`サンプルデータに「${what}」が見つかりませんでした。「サンプルデータを初期化」を押してからもう一度お試しください。`);
const closing = "内容を確認して、よければ「承認して保存」を押してください。押すまでは保存されません。";

const SCENARIOS: Array<{ re: RegExp; run: Scenario }> = [
  // 6. error path: invalid date + unknown operation id -> validation errors come back as tool results
  { re: /エラー|失敗|error/i, run: async (c, io) => {
    if (c.round === 0) {
      await io.think(["日程を変更する提案を作ります。", "(わざと不正な入力を送って、エラー表示を確認します)"]);
      await io.calls([propose(c, "T19", { subtaskId: "tasks/none.md::missing", start: "2026-13-45", end: "来週" }), propose(c, "ZZ99", { foo: 1 })]);
    } else await io.speak("提案の作成に失敗しました。日付が実在しない形式で、操作IDも存在しませんでした。このチャットでは変更は何も保存されていません。");
  } },
  // 4. multi-proposal: two searches in parallel, then three proposals in one turn
  { re: /複数|まとめて|一括/, run: async (c, io) => {
    if (c.round === 0) {
      await io.think(["複数の変更をまとめて提案します。", "まず対象の「デザイン確認」と「結合テスト」を探します。"]);
      await io.calls([searchCall(c, "デザイン確認"), searchCall(c, "結合テスト")]);
    } else if (c.round === 1) {
      const a = find(c.es, /デザイン確認/, false), b = find(c.es, /結合テスト/, false);
      if (!a || !b) return noTarget(io, "デザイン確認」「結合テスト");
      await io.think(["2つとも見つかりました。", "デザイン確認を2日後ろへ、結合テストも2日後ろへずらし、", "最終確認のイベントも追加する3件の案を作ります。"]);
      const rev = (e: Entity) => (e.revision ? { expectedRevision: e.revision } : {});
      await io.calls([
        propose(c, "T20", { subtaskId: a.id, calendarDelta: 2, ...rev(a) }),
        propose(c, "T20", { subtaskId: b.id, calendarDelta: 2, ...rev(b) }),
        propose(c, "E01", { title: "リリース前の最終確認", date: shiftDays(today(), 8) }),
      ]);
    } else await io.speak("3件の変更案を作成しました(デザイン確認+2日、結合テスト+2日、最終確認イベントの追加)。それぞれのカードを確認して承認してください。" + "押すまでは保存されません。");
  } },
  // 5. read-only: search and summarise, no proposal
  { re: /調べ|検索|教えて|一覧/, run: async (c, io) => {
    if (c.round === 0) {
      await io.think(["進行中のタスクを検索して、", "日程と状態を確認します。"]);
      await io.calls([searchCall(c, "", { kind: "subtask", statuses: ["in_progress"] })]);
    } else {
      const subs = c.es.filter((e) => !e.parent);
      if (!subs.length) return io.speak("進行中のサブタスクは見つかりませんでした。");
      await io.think(["結果を整理します。"]);
      const lines = subs.slice(0, 6).map((e) => `・${e.name}${e.start ? `(${e.start}〜${e.end ?? e.start})` : ""}`);
      await io.speak(`進行中のサブタスクは${subs.length}件あります。\n${lines.join("\n")}\n検索しただけなので、変更案は作っておらず、何も保存されません。`);
    }
  } },
  // 3. event with planned/actual hours (hours only when this branch's E01 schema has them)
  { re: /予定を追加|イベント/, run: async (c, io) => {
    const date = today(), title = "デザインレビュー会議";
    if (c.round === 0 && c.tools.has("operations_describe")) {
      await io.think(["イベントの追加には E01 を使います。", "入力schemaを確認します。"]);
      await io.calls([{ name: "operations_describe", args: { ids: ["E01"] } }]);
    } else if (c.round <= 1) {
      const hours = c.round === 0 || /\\?"plan\\?"/.test(c.toolText); // no describe tool -> assume the newest schema
      await io.think([`「${title}」を${date}に追加する案を作ります。`, hours ? "計画2時間・実績1.5時間も入れます。" : "このブランチのE01は時間(plan/actual)を受け付けないので、タイトルと日付だけにします。"]);
      await io.calls([propose(c, "E01", { title, date, ...(hours ? { plan: { [date]: 2 }, actual: { [date]: 1.5 } } : {}) })]);
    } else await io.speak(`イベント「${title}」の追加案を作りました。` + (/plan/.test(c.callText) ? "計画2時間・実績1.5時間が入っています。" : "(このブランチのスキーマでは時間は指定できません。)") + closing);
  } },
  // 2. new parent task + 2 dated subtasks. A subtask can only be proposed against a parent that already exists, so this is two-step:
  //    first send -> propose the parent (T05, shown on the Gantt); after approving it, send again -> propose 2 subtasks with dates (T06).
  { re: /作って|作成|新規|タスクを追加/, run: async (c, io) => {
    const name = "社内勉強会の準備", d1 = shiftDays(today(), 2), d2 = shiftDays(today(), 5);
    if (c.round === 0) {
      await io.think([`まず「${name}」がすでにあるか探します。`]);
      await io.calls([searchCall(c, name, { kind: "parent" })]);
    } else if (c.round === 1) {
      const parent = find(c.es, new RegExp(name), true);
      if (!parent) {
        await io.think([`「${name}」はまだ無いので、親タスクを新しく作ります。`, "サブタスクは親が保存されてから追加できるので、まず親だけ提案します。"]);
        await io.calls([propose(c, "T05", { name })]);
      } else {
        await io.think([`「${name}」が見つかりました。`, `サブタスクを2つ、${d1}と${d2}の日付つきで追加します。`]);
        const rev = parent.revision ? { expectedRevision: parent.revision } : {};
        await io.calls([propose(c, "T06", { parentId: parent.id, name: "資料作成", date: d1, ...rev }), propose(c, "T06", { parentId: parent.id, name: "リハーサル", date: d2, ...rev })]);
      }
    } else if (find(c.es, new RegExp(name), true)) await io.speak(`サブタスク「資料作成」(${d1})と「リハーサル」(${d2})の追加案を作りました。` + closing);
    else await io.speak(`親タスク「${name}」の作成案を作りました(Gantt表示つき)。承認して保存したあと、もう一度「タスクを作って」と送ると、サブタスク2件を日付つきで続けて提案します。` + closing);
  } },
  // 1. move a subtask (search -> propose T19)
  { re: /ずら|移動|変更|動か/, run: async (c, io) => {
    if (c.round === 0) {
      await io.think(["まず「デザイン確認」というタスクを探して、", "いまの日程を確認します。"]);
      await io.calls([searchCall(c, "デザイン確認")]);
    } else if (c.round === 1) {
      const t = find(c.es, /デザイン確認/, false);
      if (!t) return noTarget(io, "デザイン確認");
      const [s, e] = t.start ? [shiftDays(t.start, 3), shiftDays(t.end ?? t.start, 3)] : [shiftDays(today(), 4), shiftDays(today(), 6)];
      await io.think(["見つかりました。", `${s}〜${e}へ3日後ろにずらす案を作ります。`]);
      await io.calls([propose(c, "T19", { subtaskId: t.id, start: s, end: e, ...(t.revision ? { expectedRevision: t.revision } : {}) })]);
    } else await io.speak("デザイン確認を3日後ろにずらす案を作りました。" + closing);
  } },
];

async function script(request: any, out: (s: string) => void): Promise<void> {
  const messages: any[] = request.messages ?? [];
  const lastUser = messages.map((m) => m.role).lastIndexOf("user");
  const after = messages.slice(lastUser + 1);
  const c: Ctx = {
    messages, tools: new Set((request.tools ?? []).map((t: any) => t?.function?.name).filter(Boolean)), user: text(messages[lastUser]).replace(/^"|"$/g, ""),
    callText: JSON.stringify(after.filter((m) => m.role === "assistant").map((m) => m.tool_calls ?? [])),
    round: after.filter((m) => m.role === "assistant").length, es: entities(after), toolText: after.filter((m) => m.role === "tool").map(text).join("\n"),
  };
  const send = (d: any, f: string | null = null) => out(chunk(d, f));
  let called = false;
  const io: Io = {
    think: async (parts) => { for (const p of parts) { send({ reasoning_content: p }); await sleep(THINK_TICK); } },
    speak: async (s) => { for (const p of s.match(/.{1,4}/gs) ?? []) { send({ content: p }); await sleep(TICK); } },
    calls: async (cs) => {
      called = true;
      for (const [index, cl] of cs.entries()) {
        const json = JSON.stringify(cl.args), mid = Math.max(1, Math.floor(json.length / 2));
        send({ tool_calls: [{ index, id: `call-${c.round}-${index}`, type: "function", function: { name: cl.name, arguments: json.slice(0, mid) } }] }); await sleep(CALL_TICK);
        send({ tool_calls: [{ index, function: { arguments: json.slice(mid) } }] }); await sleep(TICK);
      }
      send({}, "tool_calls");
    },
  };
  send({ role: "assistant", content: "" });
  const sc = SCENARIOS.find((s) => s.re.test(c.user));
  // The plugin ends a turn with a tool-less request after the proposals exist: that one gets the scenario's closing text.
  if (c.tools.size === 0) c.round = 99;
  if (!sc) { await io.speak(HELP); send({}, "stop"); return; }
  await sc.run(c, io);
  // a scenario that only spoke ends the turn with "stop"; one that issued tool calls already sent finish_reason "tool_calls"
  if (!called) send({}, "stop");
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
