import type { RequestContext, Json } from "../../contracts/context";
import { operationOutputSchemas, type OperationInputMap, type OperationOutputMap } from "../../contracts/operations";
import type { ChatSession, Conversation } from "../../ai/chat-session";
import { validEndpoint } from "../../ai/sdk-provider";
import { handlerInput, fail } from "./runtime";

export const CONTROL_OPERATION_IDS = ["Q01", "Q02", "Q03", "Q04", "Q05", "Q06"] as const;
export type ControlId = typeof CONTROL_OPERATION_IDS[number];
function conversationState(conversation: Conversation): Json {
  return { activeConversationId: conversation.id, title: conversation.title, status: conversation.status, messageCount: conversation.messages.length };
}
export async function controlRequest<K extends ControlId>(id: K, input: OperationInputMap[K], context: RequestContext, session?: ChatSession): Promise<OperationOutputMap[K]> {
  const args = handlerInput(id, input, context);
  if (!session) fail("POLICY_DENIED", "会話制御portが未接続です。");
  const before = conversationState(session.active);
  let acted = session.active;
  let after: Json;
  if (id === "Q01") {
    const config = args as OperationInputMap["Q01"];
    if (config.provider !== "disconnected" && (!validEndpoint(config.endpoint) || !config.model.trim() || config.auth === "secret" && !config.secretId.trim())) fail("INVALID_INPUT", "HTTP/HTTPS接続先（認証情報・クエリ・ハッシュなし）、モデル、既存secret IDを指定してください。");
    // Configuration is kept in memory; configuring does not call the provider.
    const old = { ...session.config };
    session.configure({ ...config });
    return operationOutputSchemas[id].parse({ schemaVersion: 1, resultKind: "request", operationId: id, status: "applied", effects: [{ kind: "conversation", action: "configure", before: old, after: { ...session.config } }] }) as OperationOutputMap[K];
  }
  if (id === "Q02") { session.newConversation(); acted = session.active; }
  else {
    const conversationId = (args as OperationInputMap["Q03"]).conversationId;
    const target = session.conversations.find((conversation) => conversation.id === conversationId);
    if (!target) fail("NOT_FOUND", "実在するconversationIdを指定してください。");
    if (id === "Q03") { session.select(conversationId); acted = target; }
    else {
      // A send/stop/retry must never silently switch/stop a different conversation.
      if (target !== session.active) fail("POLICY_DENIED", "先に対象会話を選択してください。");
      if (id === "Q05") session.stop();
      else {
        if (target.status === "running") fail("BUSY_CONVERSATION", "応答完了または停止後に送信してください。");
        if (!session.connected) fail("POLICY_DENIED", "接続先・モデル・認証を確認してください。");
        if (target.messages.length + 2 > 100) fail("INVALID_INPUT", "会話の上限です。新しい会話を作成してください。");
        if (id === "Q06" && (target.status !== "failed" || !target.messages.some((message) => message.role === "user"))) fail("INVALID_INPUT", "再試行できる失敗応答がありません。");
        const stop = () => { if (session!.active === target && target.status === "running") session!.stop(); };
        context.signal?.addEventListener("abort", stop, { once: true });
        // A stopped/switched request may still be draining its stream. Its signal must not
        // stop a later request that now owns the session's controller.
        const unsubscribe = session.subscribe(() => {
          if (session!.active !== target || target.status !== "running") context.signal?.removeEventListener("abort", stop);
        });
        try { if (id === "Q04") await session.send((args as OperationInputMap["Q04"]).text); else await session.retry(); }
        finally { unsubscribe(); context.signal?.removeEventListener("abort", stop); }
      }
    }
  }
  after = conversationState(acted);
  const actions = { Q02: "create", Q03: "select", Q04: "send", Q05: "stop", Q06: "retry" } as const;
  return operationOutputSchemas[id].parse({ schemaVersion: 1, resultKind: "request", operationId: id, status: context.signal?.aborted ? "cancelled" : "applied", effects: [{ kind: "conversation", action: actions[id as keyof typeof actions], before, after }] }) as OperationOutputMap[K];
}
