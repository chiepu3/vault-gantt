import type { OperationId, OperationInputMap } from "../../contracts/operations";
import type { PreviewEntry, FieldChange } from "../../contracts/preview";
import type { EditableSettingKey } from "../../contracts/context";
import { canonical, fail, type TaskSnapshot } from "./runtime";
export const SETTING_OPERATIONS = {
  S01: "taskFolder", S02: "filenameUsesDatePrefix", S03: "hideCompletedByDefault", S04: "currentStatusRows",
  S09: "ganttFeatureDailyTodoEnabled", S10: "ganttFeatureWorkloadEnabled", S11: "ganttFeatureEventsEnabled", S12: "ganttFeatureSyncEnabled", S13: "ganttFeatureTagsEnabled", S14: "incrementalGanttRender", S15: "ganttShowTagsOnBars", S16: "ganttShowParentTagsOnChildBars", S17: "ganttShowTagsOnParents",
} as const;
export const SETTINGS_OPERATION_IDS = [...Object.keys(SETTING_OPERATIONS), "S06", "S07", "S22", "S23", "S24", "S25", "S26", "S28", "S29", "S30", "S31", "S32", "S33", "S34"] as OperationId[];
function reorder<T extends { key: string }>(items: readonly T[], keys: readonly string[]): T[] {
  if (keys.length !== items.length || items.some((item) => !keys.includes(item.key))) fail("INVALID_INPUT", "全ての定義keyを重複なしで指定してください。");
  return keys.map((key) => structuredClone(items.find((item) => item.key === key)!));
}
function newKey(prefix: string, keys: readonly string[]): string { let index = 1; while (keys.includes(`${prefix}-${index}`)) index++; return `${prefix}-${index}`; }
export function settingsPlan<K extends OperationId>(id: K, input: OperationInputMap[K], snapshot: TaskSnapshot) {
  const settings = structuredClone(snapshot.settings);
  const args = input as OperationInputMap["S01"] & OperationInputMap["S04"] & OperationInputMap["S06"] & OperationInputMap["S07"] & OperationInputMap["S22"] & OperationInputMap["S23"] & OperationInputMap["S25"] & OperationInputMap["S28"] & OperationInputMap["S29"] & OperationInputMap["S30"] & OperationInputMap["S31"];
  if (args.expectedRevision && args.expectedRevision !== snapshot.settingsRevision && args.expectedRevision !== snapshot.revision) fail("REVISION_CONFLICT", "settingsを再取得して再プレビューしてください。");
  const entries: Omit<PreviewEntry, "actionId">[] = [];
  let key: EditableSettingKey;
  if (id in SETTING_OPERATIONS) {
    key = SETTING_OPERATIONS[id as keyof typeof SETTING_OPERATIONS];
    const record = input as unknown as Record<string, unknown>;
    let value = id >= "S09" ? args.enabled : record[key];
    if (id === "S01") { value = args.taskFolder.trim().replace(/^\/+|\/+$/g, ""); if (!value || String(value).split("/").some((part) => part === "." || part === "..")) fail("INVALID_INPUT", "Vault相対の安全なtaskFolderを指定してください。"); }
    if (id === "S04") value = Math.max(3, Math.round(args.currentStatusRows));
    const before = settings[key];
    Object.assign(settings, { [key]: value });
    const fields: FieldChange[] = canonical(before) === canonical(value) ? [] : [{ field: key, before, after: value as import("../../contracts/context").Json, reason: canonical(record[key] ?? args.enabled) === canonical(value) ? "requested" : "normalized" }];
    entries.push({ entity: { kind: "setting", key }, displayName: key, effects: fields.length ? [{ kind: "settings", fields }] : [] });
  } else if (id === "S06" || id === "S07") {
    key = id === "S06" ? "ganttManualHolidays" : "ganttSpecialHolidays";
    const before = settings[key];
    const after = id === "S06" ? args.enabled ? [...new Set([...before, args.date])].sort() : before.filter((date) => date !== args.date) : [...new Set(args.dates)].sort();
    settings[key] = after;
    settings.ganttHolidays = [...new Set([...settings.ganttManualHolidays, ...settings.ganttSpecialHolidays, ...settings.ganttNationalHolidays])].sort();
    entries.push({ entity: { kind: "setting", key }, displayName: key, effects: [{ kind: "settings", fields: [{ field: key, before, after, reason: "requested" }] }, { kind: "calendar", added: after.filter((date) => !before.includes(date)), removed: before.filter((date) => !after.includes(date)), source: id === "S06" ? "manual" : "special" }] });
  } else if (id >= "S22" && id <= "S26") {
    key = "ganttTags";
    const before = settings.ganttTags.find((tag) => tag.key === args.tagKey);
    if (id !== "S22" && id !== "S25" && !before) fail("NOT_FOUND", "実在するtagKeyを取得してください。");
    let targetKey = args.tagKey;
    if (id === "S22") { targetKey = newKey("tag", settings.ganttTags.map((tag) => tag.key)); settings.ganttTags.push({ key: targetKey, name: args.name, color: args.color ?? "", order: args.order }); }
    if (id === "S23" && args.name.trim()) settings.ganttTags.find((tag) => tag.key === targetKey)!.name = args.name.trim();
    if (id === "S24") settings.ganttTags.find((tag) => tag.key === targetKey)!.color = args.color!.trim();
    if (id === "S26") settings.ganttTags = settings.ganttTags.filter((tag) => tag.key !== targetKey);
    if (id === "S25") settings.ganttTags = reorder(settings.ganttTags, args.orderedKeys).map((tag, index) => ({ ...tag, order: (index + 1) * 1000 }));
    for (const tagKey of id === "S25" ? args.orderedKeys : [targetKey]) {
      const old = snapshot.settings.ganttTags.find((tag) => tag.key === tagKey), after = settings.ganttTags.find((tag) => tag.key === tagKey);
      const affectedCount = snapshot.parents.reduce((total, parent) => total + Number(parent.tags.includes(old?.name ?? after!.name)) + [...parent.subtasks?.values() ?? []].reduce((sum, child) => sum + Number(child.tags.includes(old?.name ?? after!.name)) + (child.ganttMarkers ?? []).filter((marker) => marker.tags?.includes(old?.name ?? after!.name)).length, 0), 0);
      entries.push({ entity: { kind: "tag-definition", tagKey }, displayName: after?.name ?? old!.name, effects: [{ kind: "tag-definition", before: old ?? null, after: after ?? null, affectedCount }] });
    }
  } else {
    key = "dailyTodoSources";
    const before = settings.dailyTodoSources.find((source) => source.key === args.sourceKey);
    if (id !== "S28" && id !== "S33" && !before) fail("NOT_FOUND", "実在するsourceKeyを取得してください。");
    let sourceKey = args.sourceKey;
    if (id === "S28") { sourceKey = newKey("source", settings.dailyTodoSources.map((source) => source.key)); settings.dailyTodoSources.push({ key: sourceKey, label: args.label, format: args.format, creatableFromGantt: args.creatableFromGantt ?? false, ...(args.templatePath ? { templatePath: args.templatePath } : {}) }); }
    if (id === "S29") settings.dailyTodoSources.find((source) => source.key === sourceKey)!.label = args.label.trim();
    if (id === "S30") settings.dailyTodoSources.find((source) => source.key === sourceKey)!.format = args.momentFormat;
    if (id === "S31") { const source = settings.dailyTodoSources.find((source) => source.key === sourceKey)!; if (args.templatePath.trim()) source.templatePath = args.templatePath.trim(); else delete source.templatePath; }
    if (id === "S32") settings.dailyTodoSources.find((source) => source.key === sourceKey)!.creatableFromGantt = args.creatableFromGantt!;
    if (id === "S34") settings.dailyTodoSources = settings.dailyTodoSources.filter((source) => source.key !== sourceKey);
    if (id === "S33") settings.dailyTodoSources = reorder(settings.dailyTodoSources, args.orderedKeys);
    entries.push({ entity: { kind: "setting", key }, displayName: key, effects: [{ kind: "settings", fields: [{ field: key, before: snapshot.settings.dailyTodoSources.map((source) => ({ ...source })), after: settings.dailyTodoSources.map((source) => ({ ...source })), reason: "requested" }] }] });
  }
  return { settings, entries, keys: [key, ...(id === "S06" || id === "S07" ? ["ganttHolidays" as const] : [])] };
}
