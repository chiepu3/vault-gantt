// Sample vault: Japanese task notes written with the branch's own buildNewNote (so the note format always matches the code
// under test), dated relative to "today" so the Gantt always has bars around the current date.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { stringifyYaml } from "obsidian";
import { buildNewNote } from "@app/core/note-v2";
import { buildMemoNote, memoFileStem, type MemoMeta } from "@app/core/memo";
import { FAKE_ORIGIN } from "./fake-llm";

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const today = () => iso(new Date());
const plus = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
const range = (a: number, b: number, h: number) => { const o: Record<string, number> = {}; for (let i = a; i <= b; i++) { const d = new Date(); d.setDate(d.getDate() + i); if (d.getDay() % 6) o[iso(d)] = h; } return o; };

interface Sub { key: string; title: string; from: number; to: number; status?: string; tags?: string[]; plan?: number; actual?: [number, number, number]; markers?: Array<[string, string, number]>; note?: string; status_text?: string; due?: number }
interface Parent { name: string; tags: string[]; due?: number; milestones?: Array<[string, number, string[]?]>; prio: number; created: number; gantt?: boolean; completed?: boolean; status?: string; subs: Sub[]; current?: string; notes?: string }

const PARENTS: Parent[] = [
  { name: "新機能リリース準備", tags: ["開発"], due: 14, milestones: [["仕様確定", 5], ["β版公開", 14, ["開発"]], ["正式リリース", 24]], prio: 4, created: -12, current: "仕様はレビュー済み。実装を進めつつ、デザイン確認の日程を調整中。", notes: "リリース判定は来週後半。", subs: [
    { key: "spec", title: "仕様書レビュー", from: -8, to: -4, status: "done", plan: 3, actual: [-8, -4, 3] },
    { key: "impl", title: "実装", from: -3, to: 6, status: "in_progress", tags: ["開発"], plan: 5, actual: [-3, 0, 4.5], markers: [["m1", "中間レビュー", 2]], status_text: "API層まで完了。画面は着手前。" },
    { key: "design", title: "デザイン確認", from: 1, to: 3, status: "active", tags: ["デザイン"], plan: 2 },
    { key: "qa", title: "結合テスト", from: 7, to: 10, status: "active", plan: 4 },
    { key: "judge", title: "リリース判定会議", from: 12, to: 12, status: "active", markers: [["m2", "判定", 12]] },
  ] },
  { name: "社内ポータル改善", tags: ["開発", "デザイン"], due: 20, prio: 3, created: -20, subs: [
    { key: "survey", title: "利用状況の調査", from: -6, to: -1, status: "done", tags: ["調査"], plan: 2, actual: [-6, -1, 2] },
    { key: "wire", title: "ワイヤーフレーム作成", from: 0, to: 4, status: "in_progress", tags: ["デザイン"], plan: 3, actual: [0, 0, 3] },
    { key: "build", title: "トップページ実装", from: 5, to: 13, status: "active", tags: ["開発"], plan: 5 },
    { key: "feedback", title: "社内フィードバック収集", from: 14, to: 18, status: "waiting", tags: ["調査"], plan: 1 },
  ] },
  { name: "月次レポート作成", tags: ["運用"], due: 9, prio: 2, created: -5, subs: [
    { key: "data", title: "売上データの集計", from: -2, to: 1, status: "in_progress", plan: 3, actual: [-2, 0, 3] },
    { key: "chart", title: "グラフ・コメント作成", from: 2, to: 5, status: "active", plan: 3 },
    { key: "send", title: "上長レビューと配布", from: 6, to: 8, status: "active", plan: 1 },
  ] },
  { name: "顧客ヒアリング（Q4）", tags: ["調査"], due: 25, prio: 3, created: -9, subs: [
    { key: "list", title: "対象顧客リストの作成", from: -4, to: -2, status: "done", plan: 2, actual: [-4, -2, 2] },
    { key: "mail", title: "依頼メール送付", from: 0, to: 1, status: "in_progress", plan: 1 },
    { key: "session", title: "ヒアリング実施（5社）", from: 4, to: 12, status: "active", plan: 3 },
    { key: "summary", title: "結果の取りまとめ", from: 13, to: 17, status: "hold", plan: 2 },
  ] },
  { name: "オフィス移転準備", tags: ["運用"], due: -3, prio: 1, created: -40, completed: true, status: "done", gantt: true, subs: [
    { key: "box", title: "荷造りと搬出", from: -14, to: -8, status: "done", plan: 2, actual: [-14, -8, 2] },
    { key: "net", title: "ネットワーク設定", from: -9, to: -5, status: "done", plan: 3, actual: [-9, -5, 3] },
  ] },
  { name: "採用面接の日程調整", tags: [], due: 6, prio: 2, created: -2, gantt: false, subs: [] },
];

/** Floating memos: `at` counts days from the subtask's start, `date` is the day for parent and その他 rows. The last one is kept closed (see ganttMemoLayout below). */
const MEMOS: Array<{ id: string; text: string; anchor: Pick<MemoMeta, "taskId" | "at"> & { date?: number } }> = [
  { id: "m-sd0001", text: "API層の認可まわりを木曜までに確認\n・トークンの期限\n・権限チェックの抜け", anchor: { taskId: "s-sd0001", at: 2 } },
  { id: "m-sd0002", text: "先方のデザイナーは午後のみ対応可。日程は午後に寄せる。", anchor: { taskId: "s-sd0002", at: 1 } },
  { id: "m-sd0003", text: "判定会議の資料は前日までに共有する", anchor: { taskId: "t-sd0000", date: 5 } },
  { id: "m-sd0004", text: "全社会議の前に月次の数字を見直す", anchor: { date: 2 } },
];

/** v2 notes: one parent note and one note per subtask (in a folder named like the parent). */
function toNotes(p: Parent, idx: number): { files: Record<string, string>; parentId: string; subIds: string[] } {
  const t = today();
  const stem = `${plus(p.created)} ${p.name}`;
  const parentPath = `tasks/${stem}.md`;
  const parentId = `t-sd${String(idx).padStart(4, "0")}`;
  const common = { createdAt: plus(p.created), updatedAt: t, completed: false, priority: 0, priorityMode: "auto", currentStatus: "", notes: "", tags: [] as string[] };
  const files: Record<string, string> = {};
  const subs = new Map<string, any>();
  const subIds: string[] = [];
  p.subs.forEach((s, j) => {
    const id = `s-sd${String(idx)}${String(j).padStart(3, "0")}`;
    const path = `tasks/${stem}/${s.title}.md`;
    const done = s.status === "done";
    const row = { ...common, kind: "subtask", id, key: id, parentId, file: { path, parentPath }, title: s.title, displayName: s.title,
      statusLabel: s.status ?? "active", completed: done, dueDate: s.due !== undefined ? plus(s.due) : undefined, tags: s.tags ?? [], ganttEnabled: false, currentStatus: s.status_text ?? "", notes: s.note ?? "",
      plannedStartDate: plus(s.from), plannedEndDate: plus(s.to), workloadPlan: s.plan ? range(s.from, s.to, s.plan) : undefined, workloadActual: s.actual ? range(s.actual[0], s.actual[1], s.actual[2]) : undefined,
      ganttMarkers: s.markers?.map(([key, title, day]) => ({ key, title, date: plus(day), tags: [] })) };
    subs.set(id, row); subIds.push(id);
    files[path] = buildNewNote(row as any, stringifyYaml, { parentLink: `[[${stem}]]` });
  });
  // Named milestones win over `due`, which then mirrors the earliest one (same rule as the plugin's note reader).
  const milestones = p.milestones?.map(([title, offset, tags]) => ({ key: title, title, date: plus(offset), tags }));
  const parent = { ...common, kind: "parent", id: parentId, file: { path: parentPath }, title: p.name, displayName: p.name, statusLabel: p.status ?? "in_progress", completed: !!p.completed, milestones, dueDate: milestones ? milestones.map((m) => m.date).sort()[0] : p.due !== undefined ? plus(p.due) : undefined,
    priority: p.prio, priorityMode: "manual", tags: p.tags, ganttEnabled: p.gantt ?? true, currentStatus: p.current ?? "", notes: p.notes ?? "", subtasks: subs };
  files[parentPath] = buildNewNote(parent as any, stringifyYaml);
  return { files, parentId, subIds };
}

export function makeSeed(): { files: Record<string, string>; data: any; secrets: Record<string, string> } {
  const files: Record<string, string> = {};
  const subtaskOrder: Record<string, string[]> = {}, ganttParentOrder: string[] = [];
  PARENTS.forEach((p, i) => { const n = toNotes(p, i); Object.assign(files, n.files); ganttParentOrder.push(n.parentId); if (n.subIds.length) subtaskOrder[n.parentId] = n.subIds; });
  for (const memo of MEMOS) {
    const created = plus(-1), date = memo.anchor.date !== undefined ? plus(memo.anchor.date) : undefined;
    const fields = { id: memo.id, ...(memo.anchor.taskId ? { taskId: memo.anchor.taskId } : {}), ...(memo.anchor.at !== undefined ? { at: memo.anchor.at } : {}), ...(date ? { date } : {}), created, updated: created };
    files[`tasks/_memos/${memoFileStem(memo.text, created)}.md`] = buildMemoNote(fields, memo.text, stringifyYaml);
  }
  const t = new Date(), ymd = (d: Date) => ({ y: d.getFullYear(), m: String(d.getMonth() + 1).padStart(2, "0"), d: String(d.getDate()).padStart(2, "0") });
  for (const off of [-2, -1, 0, 1, 2]) {
    const d = new Date(t); d.setDate(d.getDate() + off); const { y, m, d: dd } = ymd(d);
    const todos = [["朝会の議事録を共有する", off < 0], ["月次レポートのデータ確認", off <= 0], ["デザイン確認の日程を調整する", false]];
    files[`デイリー/${y}/${m}/${String(y).slice(2)}${m}${dd}_デイリー.md`] = `# ${y}-${m}-${dd}\n\n## ToDo\n${todos.map(([x, c]) => `- [${c ? "x" : " "}] ${x}`).join("\n")}\n\n## メモ\n- 午後は集中作業\n`;
  }
  { const { y, m, d } = ymd(t); files[`デイリーミーティング/${y}/${m}/${m}${d}_デイリーミーティング.md`] = `# 定例ミーティング\n\n## ToDo\n- [ ] 先週の振り返りを共有\n- [x] 新機能のスコープ確認\n`; }
  files["README.md"] = `# Vault Gantt プレビュー\n\nこれはブラウザだけで動くサンプルVaultです。編集内容はこの端末のブラウザに保存されます。\n\n## 今あるタスク\n\n\`\`\`task-list\nshowCompleted=false\nsort=dueDate\n\`\`\`\n\n[[メモ/会議メモ]] も見てみてください。\n`;
  files["メモ/会議メモ.md"] = `# 会議メモ\n\n- リリース判定は **${plus(12)}** を想定\n- デザイン確認は[[README]]のタスク一覧から日程を確認\n`;

  const holidays = ["2026-01-01", "2026-01-12", "2026-02-11", "2026-02-23", "2026-03-20", "2026-04-29", "2026-05-03", "2026-05-04", "2026-05-05", "2026-05-06", "2026-07-20", "2026-08-11", "2026-09-21", "2026-09-22", "2026-09-23", "2026-10-12", "2026-11-03", "2026-11-23", "2027-01-01", "2027-01-11", "2027-02-11", "2027-02-23"];
  const data = {
    taskFolder: "tasks", autoPriorityEnabled: true, ganttParentOrder, subtaskOrder, ganttNationalHolidays: holidays, ganttNationalHolidaysUpdatedAt: today(), ganttZoom: 28,
    ganttTags: [["dev", "開発", "#2563eb"], ["design", "デザイン", "#7c3aed"], ["ops", "運用", "#12883e"], ["research", "調査", "#b16105"]].map(([key, name, color], order) => ({ key, name, color, order })),
    ganttEvents: [{ key: "ev1", title: "全社会議", date: plus(3) }, { key: "ev2", title: "リリース", date: plus(14), workloadPlan: { [plus(14)]: 2 } }],
    weeklyWorkSchedules: [{ key: "w1", title: "定例会議", dayOfWeek: 1, minutesPerWeek: 60 }, { key: "w2", title: "1on1", dayOfWeek: 3, minutesPerWeek: 30 }],
    dailyTodoTargetSourceKey: "main",
    ganttMemoLayout: { "m-sd0004": { open: false, dx: 28, dy: -70, w: 220 } },
    ai: { preset: "custom", baseUrl: FAKE_ORIGIN + "/v1", model: "fake-model", useApiKey: true, apiKeyOrigin: FAKE_ORIGIN },
  };
  return { files, data, secrets: { "vault-gantt-ai-api-key": "sk-preview-dummy-key" } };
}
