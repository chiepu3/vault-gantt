import type { OperationInputMap } from "../../contracts/operations";
import type { PreviewEntry } from "../../contracts/preview";
import type { TaskRow, TaskWorkbenchSettings } from "../../core/types";
import { generateTaskId } from "../../core/ids";
import { applyPatchToRow, normalizeWorkloadMap } from "../../core/task-patch";
import { todayStr } from "../../core/utils";
import { collectTaskIds, getAvailableSubtaskPath, newSubtaskRow, type VaultAdapter } from "../task-operations";
import { holidaySet } from "../gantt-actions";
import { snapForward } from "../gantt-drag";
import { taskEffects } from "../preview-projector";
import { eventWeeklyPlan } from "./event-weekly-handlers";
import { fail, findTask, flatten, type TaskSnapshot } from "./runtime";

type Entry = OperationInputMap["T31"]["entries"][number];
export interface WorklogPlan {
  afterParents: TaskRow[]; afterSettings: TaskWorkbenchSettings; settingKeys: (keyof TaskWorkbenchSettings)[];
  entries: Omit<PreviewEntry, "actionId">[];
}
const keyOf = (entry: Entry) => "subtaskId" in entry ? `s:${entry.subtaskId}` : "parentId" in entry ? `n:${entry.parentId}:${entry.newSubtaskName.normalize("NFKC")}` : "eventKey" in entry ? `e:${entry.eventKey}` : `t:${entry.eventTitle.normalize("NFKC")}`;

/** One approval for a whole day's log: actual hours on existing subtasks, new subtasks under existing projects, and events. */
export async function worklogPlan(input: OperationInputMap["T31"], snapshot: TaskSnapshot, vault: VaultAdapter): Promise<WorklogPlan> {
  const { date } = input;
  const merged = new Map<string, Entry>();
  for (const entry of input.entries) { const key = keyOf(entry), prior = merged.get(key); merged.set(key, prior ? { ...prior, hours: prior.hours + entry.hours } : entry); }
  for (const entry of merged.values()) if (entry.hours > 24) fail("INVALID_INPUT", "同じ対象の合計が24hを超えます。時間を見直してください。", "hours");
  const afterParents = structuredClone(snapshot.parents), entries: Omit<PreviewEntry, "actionId">[] = [];
  const parentOf = (id: string) => afterParents.find((row) => row.id === id)!;
  // Existing subtasks: replace this date's actual only, keeping every other day.
  const existing: { before: TaskRow }[] = [];
  for (const entry of merged.values()) {
    if (!("subtaskId" in entry)) continue;
    const before = findTask(snapshot, entry.subtaskId, "subtask");
    applyPatchToRow(parentOf(before.parentId!).subtasks!.get(before.id)!, { workloadActual: { ...before.workloadActual, [date]: entry.hours } }, snapshot.settings);
    existing.push({ before });
  }
  // New subtasks under existing projects, scheduled on the logged day.
  const created: { parentId: string; id: string }[] = [];
  const usedIds = collectTaskIds(vault, snapshot.settings), reserved = new Set<string>();
  for (const entry of merged.values()) {
    if (!("parentId" in entry)) continue;
    const prior = snapshot.parents.find((row) => row.id === entry.parentId);
    if (!prior) fail("NOT_FOUND", "実在するparentIdを取得してください。", "parentId");
    const copy = parentOf(prior.id), day = snapForward(date, holidaySet(snapshot.settings));
    const name = entry.newSubtaskName.trim();
    const path = getAvailableSubtaskPath(vault, prior.file.path, name, reserved);
    reserved.add(path);
    const row = newSubtaskRow(generateTaskId("subtask", usedIds), path, copy, name, { plannedStartDate: day, plannedEndDate: day, workloadActual: normalizeWorkloadMap({ [date]: entry.hours }) }, snapshot.today || todayStr());
    copy.subtasks!.set(row.id, row);
    created.push({ parentId: prior.id, id: row.id });
  }
  for (const { before } of existing) {
    const after = flatten(afterParents).find((row) => row.id === before.id)!;
    entries.push({ entity: { kind: "task", taskId: before.id, parentId: before.parentId! }, displayName: after.displayName, effects: taskEffects(before, after, { workloadActual: after.workloadActual }) });
  }
  for (const { parentId, id } of created) {
    const row = parentOf(parentId).subtasks!.get(id)!;
    entries.push({ entity: { kind: "task", taskId: row.id, parentId }, displayName: row.displayName, effects: taskEffects(undefined, row) });
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
  return { afterParents, afterSettings: settings, settingKeys: eventCount ? ["ganttEvents"] : [], entries };
}
