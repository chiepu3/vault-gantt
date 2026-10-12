export type ChatCompletionKind = "proposal-created" | "no-proposal" | "tool-refused" | "timeout" | "step-limit" | "connection-error" | "cancelled";
export interface ChatCompletion {
  kind: ChatCompletionKind;
  proposalIds: string[];
  toolErrors: number;
  httpStatus?: number;
}
export const completionText: Record<ChatCompletionKind, string> = {
  "proposal-created": "変更案を作成しました。カードの内容を確認して承認してください。まだ保存していません。",
  "no-proposal": "変更案は作成していません。保存も行っていません。",
  "tool-refused": "操作を完了できませんでした。ツールの入力または対象の状態を確認してください。新しい変更は保存していません。",
  "timeout": "応答が時間切れになりました。作成済みの案がある場合はカードを確認してください。承認前の変更は保存していません。",
  "step-limit": "確認手順の上限に達しました。変更案は作成しておらず、保存していません。対象と変更内容を絞って再試行してください。",
  "connection-error": "接続先から正常な応答を取得できませんでした。接続設定を確認して再試行してください。",
  "cancelled": "停止しました。保存済みの変更は戻しません。",
};
export function providerFailure(error: unknown, proposalIds: string[], toolErrors: number): ChatCompletion {
  const value = error && typeof error === "object" ? error as { name?: unknown; statusCode?: unknown; cause?: { name?: unknown } } : {};
  return { kind: value.name === "TimeoutError" || value.cause?.name === "TimeoutError" ? "timeout" : "connection-error", proposalIds, toolErrors,
    ...(typeof value.statusCode === "number" ? { httpStatus: value.statusCode } : {}),
  };
}
