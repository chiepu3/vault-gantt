import type { OperationId } from "../contracts/operations";
export type ToolFamily = "tasks" | "schedule" | "markers" | "workload" | "events" | "weekly" | "settings";
export function operationFamily(id: OperationId): ToolFamily {
  if (id.startsWith("M")) return id === "M07" || id === "M08" ? "workload" : "markers";
  if (id.startsWith("E")) return "events";
  if (id.startsWith("W")) return "weekly";
  if (id.startsWith("S")) return "settings";
  return id >= "T19" && id <= "T25" ? "schedule" : "tasks";
}
export function selectToolFamilies(text: string): readonly ToolFamily[] {
  const families = new Set<ToolFamily>(["tasks", "schedule"]);
  for (const [family, words] of [["markers", /マーカー|marker/i], ["workload", /時間|工数|実績|workload|hours/i], ["events", /イベント|event/i], ["weekly", /定例|毎週|weekly/i], ["settings", /設定(?:画面|値|変更)|プラグイン設定|休日|タグ定義|ソース|settings|holiday|source/i]] as const) if (words.test(text)) families.add(family);
  return [...families];
}
