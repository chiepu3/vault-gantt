/** Japanese names for the tools the assistant calls; shown on the tool rows of the chat. */
const LABELS: Record<string, string> = {
  tasks_search: "タスクを検索",
  tasks_get_many: "タスクの詳細を取得",
  context_read: "情報を取得",
  operations_describe: "操作の詳細を確認",
  operations_propose: "変更案を作成",
  worklog_candidates: "日報の対象を照合",
  worklog_propose: "実績の変更案を作成",
  search: "タスクを検索",
  get: "タスクを取得",
  update: "変更案を作成",
  "update-batch": "変更案を作成",
  "schedule-batch": "日程の変更案を作成",
};
export function toolLabel(name: string): string { return LABELS[name] ?? "ツールを実行"; }
