import type { OperationInputMap } from "../../contracts/operations";
import type { PreviewEntry } from "../../contracts/preview";
import type { TaskWorkbenchSettings } from "../../core/types";
import { canonical, fail, type TaskSnapshot } from "./runtime";

/** Freeze the setting change and the run date; nothing is saved during planning. */
export function priorityPlan(id: "T30" | "S05", input: OperationInputMap["T30"] | OperationInputMap["S05"], snapshot: TaskSnapshot) {
  if ("expectedRevision" in input && input.expectedRevision && ![snapshot.revision, snapshot.settingsRevision].includes(input.expectedRevision)) fail("REVISION_CONFLICT", "最新のタスク・設定を取得してください。");
  const settings = structuredClone(snapshot.settings), parents = structuredClone(snapshot.parents);
  const entries: Omit<PreviewEntry, "actionId">[] = [], keys: (keyof TaskWorkbenchSettings)[] = [];
  if (id === "S05") {
    settings.autoPriorityEnabled = (input as OperationInputMap["S05"]).autoPriorityEnabled;
    keys.push("autoPriorityEnabled");
    entries.push({ entity: { kind: "setting", key: "autoPriorityEnabled" }, displayName: "自動優先度", effects: [{ kind: "settings", fields: [{ field: "autoPriorityEnabled", before: snapshot.settings.autoPriorityEnabled, after: settings.autoPriorityEnabled, reason: "requested" }] }] });
  }
  if (settings.autoPriorityEnabled && (id === "S05" || (input as OperationInputMap["T30"]).force || settings.lastAutoPriorityUpdate !== snapshot.today)) {
    // Auto priority is computed when shown and never written to notes; only the run date is kept.
    settings.lastAutoPriorityUpdate = snapshot.today; keys.push("lastAutoPriorityUpdate");
    if (canonical(snapshot.settings.lastAutoPriorityUpdate) !== canonical(snapshot.today)) entries.push({ entity: { kind: "integration", targetId: "auto-priority" }, displayName: "自動優先度の更新日", effects: [{ kind: "service-state", fields: [{ field: "lastAutoPriorityUpdate", before: snapshot.settings.lastAutoPriorityUpdate, after: snapshot.today, reason: "normalized" }] }] });
  }
  return { settings, parents, entries, keys };
}
