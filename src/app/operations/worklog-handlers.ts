import type { OperationInputMap } from "../../contracts/operations";
import type { PreviewEntry } from "../../contracts/preview";
import type { TaskRow, TaskWorkbenchSettings } from "../../core/types";
import { buildFullNote, parseTaskFile } from "../../core/note-format";
import { mergeTaskNote } from "../../core/note-update";
import { applyPatchToParent, normalizeWorkloadMap } from "../../core/task-patch";
import { addSubtask, type VaultAdapter } from "../task-operations";
import { holidaySet } from "../gantt-actions";
import { snapForward } from "../gantt-drag";
import { taskEffects } from "../preview-projector";
import { eventWeeklyPlan } from "./event-weekly-handlers";
import { fail, findTask, flatten, type TaskSnapshot } from "./runtime";

type Entry = OperationInputMap["T31"]["entries"][number];
export interface WorklogPlan {
  afterParents: TaskRow[]; afterSettings: TaskWorkbenchSettings; settingKeys: (keyof TaskWorkbenchSettings)[];
  createdContents: Map<string, string>; entries: Omit<PreviewEntry, "actionId">[];
}
const keyOf = (entry: Entry) => "subtaskId" in entry ? `s:${entry.subtaskId}` : "parentId" in entry ? `n:${entry.parentId}:${entry.newSubtaskName.normalize("NFKC")}` : "eventKey" in entry ? `e:${entry.eventKey}` : `t:${entry.eventTitle.normalize("NFKC")}`;

/** One approval for a whole day's log: actual hours on existing subtasks, new subtasks under existing projects, and events. */
export async function worklogPlan(input: OperationInputMap["T31"], snapshot: TaskSnapshot, vault: VaultAdapter): Promise<WorklogPlan> {
  const { date } = input, parseSettings = { ...snapshot.settings, autoPriorityEnabled: false };
  const merged = new Map<string, Entry>();
  for (const entry of input.entries) { const key = keyOf(entry), prior = merged.get(key); merged.set(key, prior ? { ...prior, hours: prior.hours + entry.hours } : entry); }
  for (const entry of merged.values()) if (entry.hours > 24) fail("INVALID_INPUT", "同じ対象の合計が24hを超えます。時間を見直してください。", "hours");
  const afterParents = structuredClone(snapshot.parents), createdContents = new Map<string, string>(), entries: Omit<PreviewEntry, "actionId">[] = [];
  const parentOf = (path: string) => afterParents.find((row) => row.file.path === path)!;
  const touched = new Set<string>();
  // Existing subtasks: replace this date's actual only, keeping every other day.
  const existing: { before: TaskRow }[] = [];
  for (const entry of merged.values()) {
    if (!("subtaskId" in entry)) continue;
    const before = findTask(snapshot, entry.subtaskId, "subtask");
    applyPatchToParent(parentOf(before.file.path), { workloadActual: { ...before.workloadActual, [date]: entry.hours } }, before.id, snapshot.settings);
    touched.add(before.file.path); existing.push({ before });
  }
  // New subtasks under existing projects, scheduled on the logged day.
  const virtual: VaultAdapter = { getFiles: () => vault.getFiles(), getFileByPath: (path) => createdContents.has(path) ? { path } : vault.getFileByPath(path),
    read: async (file) => createdContents.get(file.path) ?? snapshot.contents.get(file.path) ?? "",
    create: async (path, content) => { createdContents.set(path, content); return { path }; }, modify: async (file, content) => { createdContents.set(file.path, content); } };
  const created: { path: string; key: string }[] = [];
  for (const entry of merged.values()) {
    if (!("parentId" in entry)) continue;
    const prior = snapshot.parents.find((row) => row.id === entry.parentId);
    if (!prior) fail("NOT_FOUND", "実在するparentIdを取得してください。", "parentId");
    const copy = parentOf(prior.file.path), day = snapForward(date, holidaySet(snapshot.settings));
    const row = await addSubtask(virtual, parseSettings, copy, entry.newSubtaskName, { plannedStartDate: day, plannedEndDate: day, workloadActual: normalizeWorkloadMap({ [date]: entry.hours }) });
    copy.subtasks!.set(row.key!, row);
    createdContents.set(prior.file.path, mergeTaskNote(snapshot.contents.get(prior.file.path)!, buildFullNote(prior, prior.subtasks), buildFullNote(copy, copy.subtasks)));
    touched.add(prior.file.path); created.push({ path: prior.file.path, key: row.key! });
  }
  for (const path of touched) {
    const reparsed = parseTaskFile({ path }, createdContents.get(path) ?? buildFullNote(parentOf(path), parentOf(path).subtasks), parseSettings);
    if (!reparsed) fail("INVALID_INPUT", "正規化後の内容を安全に保存できません。入力の記号を確認してください。");
    afterParents[afterParents.findIndex((row) => row.file.path === path)] = reparsed;
  }
  for (const { before } of existing) {
    const after = flatten(afterParents).find((row) => row.id === before.id)!;
    entries.push({ entity: { kind: "task", taskId: before.id, parentId: before.file.path }, displayName: after.displayName, effects: taskEffects(before, after, { workloadActual: after.workloadActual }) });
  }
  for (const { path, key } of created) {
    const row = parentOf(path).subtasks!.get(key)!;
    entries.push({ entity: { kind: "task", taskId: row.id, parentId: path }, displayName: row.displayName, effects: taskEffects(undefined, row) });
  }
  // Events chain through the settings clone so several events land in one settings write.
  let settings = snapshot.settings, eventCount = 0;
  for (const entry of merged.values()) {
    let plan;
    if ("eventKey" in entry) {
      const event = settings.ganttEvents.find((row) => row.key === entry.eventKey);
      if (!event) fail("NOT_FOUND", "実在するeventKeyを取得してください。", "eventKey");
      plan = eventWeeklyPlan("E07", { eventKey: entry.eventKey, actual: { ...event.workloadActual, [date]: entry.hours } }, { ...snapshot, settings });
    } else if ("eventTitle" in entry) plan = eventWeeklyPlan("E01", { title: entry.eventTitle, date, actual: { [date]: entry.hours } }, { ...snapshot, settings });
    else continue;
    settings = plan.settings; eventCount++; entries.push(...plan.entries);
  }
  return { afterParents, afterSettings: settings, settingKeys: eventCount ? ["ganttEvents"] : [], createdContents, entries };
}
