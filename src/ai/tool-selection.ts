import type { OperationId } from "../contracts/operations";
export type ToolFamily = "tasks" | "schedule" | "markers" | "workload" | "events" | "weekly" | "settings" | "daily" | "view" | "control";
export function operationFamily(id: OperationId): ToolFamily {
  if (id.startsWith("D")) return "daily";
  if (id.startsWith("V")) return "view";
  if (id.startsWith("Q")) return "control";
  if (id.startsWith("M")) return id === "M07" || id === "M08" ? "workload" : "markers";
  if (id.startsWith("E")) return "events";
  if (id.startsWith("W")) return "weekly";
  if (id.startsWith("S")) return "settings";
  return id >= "T19" && id <= "T25" ? "schedule" : "tasks";
}
export function selectToolFamilies(text: string): readonly ToolFamily[] {
  const families = new Set<ToolFamily>(["tasks", "schedule"]);
  for (const [family, words] of [["daily", /daily|デイリー|日次|ToDo/i], ["view", /画面|表示|ビュー|view|filter/i], ["control", /チャット|会話|conversation/i], ["markers", /マーカー|marker/i], ["workload", /時間|工数|実績|workload|hours/i], ["events", /イベント|event/i], ["weekly", /定例|毎週|weekly/i], ["settings", /設定(?:画面|値|変更)|プラグイン設定|休日|タグ定義|ソース|settings|holiday|source/i]] as const) if (words.test(text)) families.add(family);
  return [...families];
}

/** Hints only: authorization and the full catalog remain available on demand. */
export function selectOperationIds(text: string): readonly OperationId[] {
  if (/元に戻|undo/i.test(text)) return ["V20"];
  if (/やり直|redo/i.test(text)) return ["V21"];
  if (/Daily|ToDo|デイリー|日次/i.test(text)) return ["D07", "D03", "D05"];
  if (/マーカー|marker/i.test(text)) return /移動|動か|ずら/.test(text) ? ["M03"] : ["M01"];
  if (/実績|作業した/.test(text)) return ["M08"];
  if (/計画.*時間|工数/.test(text)) return ["M07"];
  if (/設定.*完了|完了済み.*隠/.test(text)) return ["S03"];
  if (/優先度|タグ/.test(text)) return ["T27"];
  if (/名前変更|名前を|名を|名称/.test(text)) return ["T07"];
  if (/追加|作成/.test(text)) return ["T04", "T03"];
  if (/削除/.test(text)) return ["T26"];
  if (/期限|締切.*変更/.test(text)) return ["T13"];
  if (/完了に/.test(text)) return ["T09"];
  if (/ずら|後ろ|前倒/.test(text)) return ["T20"];
  if (/開始|動か|移動/.test(text)) return ["T19", "T20"];
  return [];
}
