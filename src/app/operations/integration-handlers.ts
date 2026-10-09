import type { OperationInputMap } from "../../contracts/operations";
import { operationInputSchemas } from "../../contracts/operations";
import type { OperationPreviewV1, PreviewEntry, PreviewEffect } from "../../contracts/preview";
import type { TaskWorkbenchSettings } from "../../core/types";
import { buildFullNote, parseTaskFile } from "../../core/note-format";
import { applyPatchToParent } from "../../core/task-patch";
import { normalizeHolidayDates, shouldRefreshNationalHolidays } from "../holiday-service";
import { buildReadonlyGanttSnapshotFromTasks, getGanttSyncEndpoint, hashString } from "../gantt-sync-service";
import type { ConfiguredDailyNoteSettings } from "../daily-note-creation";
import { taskEffects } from "../preview-projector";
import { canonical, checkRevision, contentRevision, fail, findTask, type TaskChange, type TaskSnapshot } from "./runtime";

export const INTEGRATION_OPERATION_IDS = ["S08", "S18", "S19", "S20", "S21", "S27", "S35"] as const;
export type IntegrationId = typeof INTEGRATION_OPERATION_IDS[number];
/** Read-only inputs. Existing mutating HolidayService/sync functions must not run during planning. */
export interface IntegrationPlanHost {
  pluginVersion: string;
  fetchNationalHolidays?(current: string[]): Promise<string[]>;
  detectDailyNoteSettings?(): ConfiguredDailyNoteSettings | null;
}
export interface PreparedExternalSend { destination: string; body: string; payloadDigest: string }
export interface IntegrationPlan {
  settings: TaskWorkbenchSettings;
  keys: (keyof TaskWorkbenchSettings)[];
  entries: Omit<PreviewEntry, "actionId">[];
  changes: TaskChange[];
  externalSend: PreparedExternalSend | null;
  restartSync: boolean;
  warnings: OperationPreviewV1["warnings"][number][];
}
function endpoint(settings: TaskWorkbenchSettings): string {
  const destination = getGanttSyncEndpoint(settings);
  try {
    const url = new URL(destination);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { fail("INVALID_INPUT", "認証情報・query・fragmentを含まないHTTP(S)同期URLを指定してください。", "ganttSyncUrl"); }
  return destination;
}
export async function integrationPlan<K extends IntegrationId>(id: K, input: OperationInputMap[K], snapshot: TaskSnapshot, host: IntegrationPlanHost): Promise<IntegrationPlan> {
  const args = operationInputSchemas[id].parse(input) as OperationInputMap["S08"] & OperationInputMap["S18"] & OperationInputMap["S19"] & OperationInputMap["S20"] & OperationInputMap["S27"];
  const settings = structuredClone(snapshot.settings);
  const plan: IntegrationPlan = { settings, keys: [], entries: [], changes: [], externalSend: null, restartSync: false, warnings: [] };
  if (id !== "S27" && args.expectedRevision && ![snapshot.settingsRevision, snapshot.revision].includes(args.expectedRevision)) fail("REVISION_CONFLICT", "settingsを再取得してください。");
  if (id === "S08") {
    if (!args.force && !shouldRefreshNationalHolidays(settings)) return plan;
    if (!host.fetchNationalHolidays) fail("POLICY_DENIED", "祝日取得portが未接続です。");
    const before = settings.ganttNationalHolidays;
    settings.ganttNationalHolidays = normalizeHolidayDates(await host.fetchNationalHolidays([...before]));
    settings.ganttNationalHolidaysUpdatedAt = snapshot.today;
    settings.ganttHolidays = [...new Set([...settings.ganttManualHolidays, ...settings.ganttSpecialHolidays, ...settings.ganttNationalHolidays])].sort();
    plan.keys = ["ganttNationalHolidays", "ganttNationalHolidaysUpdatedAt", "ganttHolidays"];
    plan.entries.push({ entity: { kind: "integration", targetId: "national-holidays" }, displayName: "国民祝日更新", effects: [{ kind: "calendar", added: settings.ganttNationalHolidays.filter((date) => !before.includes(date)), removed: before.filter((date) => !settings.ganttNationalHolidays.includes(date)), source: "national" }] });
  } else if (["S18", "S19", "S20", "S21"].includes(id)) {
    if (id !== "S21") {
      const key = id === "S18" ? "ganttSyncEnabled" : id === "S19" ? "ganttSyncUrl" : "ganttSyncIntervalMinutes";
      const value = id === "S18" ? args.enabled : id === "S19" ? args.ganttSyncUrl.trim() : Math.max(1, args.ganttSyncIntervalMinutes);
      if (id === "S19" && value !== "") endpoint({ ...settings, ganttSyncUrl: String(value) });
      Object.assign(settings, { [key]: value }); plan.keys = [key]; plan.restartSync = true;
      plan.entries.push({ entity: { kind: "setting", key }, displayName: key, effects: canonical(snapshot.settings[key]) === canonical(value) ? [] : [{ kind: "settings", fields: [{ field: key, before: snapshot.settings[key], after: value, reason: canonical((input as Record<string, unknown>)[key] ?? args.enabled) === canonical(value) ? "requested" : "normalized" }] }] });
    }
    if (id === "S21" || settings.ganttSyncEnabled && settings.ganttFeatureSyncEnabled && settings.ganttSyncUrl.trim()) {
      const destination = endpoint(settings);
      const payload = buildReadonlyGanttSnapshotFromTasks(snapshot.parents, settings, host.pluginVersion);
      const body = JSON.stringify({ ...payload, hash: hashString(JSON.stringify({ ...payload, generatedAt: "" })) });
      const payloadDigest = await contentRevision(body);
      plan.externalSend = { destination, body, payloadDigest };
      const effect: PreviewEffect = { kind: "external-send", destination, payloadDigest, taskCount: payload.parents.reduce((count, parent) => count + 1 + parent.subtasks.length, 0), fieldsSent: ["parents.id", "parents.path", "parents.title", "parents.displayName", "parents.statusLabel", "parents.completed", "parents.dueDate", "parents.currentStatus", "parents.tags", "parents.subtasks", "events", "tagDefinitions", "settings", "holidays", "dayWidth", "pluginVersion", "generatedAt", "hash"], bytes: new TextEncoder().encode(body).length };
      plan.entries.push({ entity: { kind: "integration", targetId: "gantt-sync" }, displayName: destination, effects: [effect] });
      plan.warnings.push({ code: "EXTERNAL_SEND", detail: "タスク本文(Current Status)、path、タグ、予定・時間等を送信します。送信済み情報はUndoで回収できません。承認したpayloadだけを送信してください。" });
    }
    if (plan.restartSync && settings.ganttSyncEnabled) plan.warnings.push({ code: "RECURRING_EXTERNAL_SEND", detail: "同期timerの再起動により、今後の変更も設定した送信先へ定期送信されます。" });
  } else if (id === "S35") {
    if (!host.detectDailyNoteSettings) fail("POLICY_DENIED", "Daily Notes設定取得portが未接続です。");
    const detected = host.detectDailyNoteSettings();
    if (!detected) fail("NOT_FOUND", "有効なDaily NotesまたはPeriodic Notes設定がありません。");
    const folder = detected.folder.trim().replace(/^\/+|\/+$/g, "");
    if (["[", "]", "\\"].some((character) => folder.includes(character)) || folder.split("/").some((part) => part === "." || part === "..")) fail("INVALID_INPUT", "安全なDaily Notesフォルダーを指定してください。");
    let index = 1; while (settings.dailyTodoSources.some((source) => source.key === `source-${index}`)) index++;
    settings.dailyTodoSources.push({ key: `source-${index}`, label: "Daily Notes", format: folder ? `[${folder}]/${detected.format}` : detected.format, creatableFromGantt: true, ...(detected.templatePath ? { templatePath: detected.templatePath } : {}) });
    plan.keys = ["dailyTodoSources"];
    plan.entries.push({ entity: { kind: "setting", key: "dailyTodoSources" }, displayName: "Daily Notesソース取込", effects: [{ kind: "settings", fields: [{ field: "dailyTodoSources", before: snapshot.settings.dailyTodoSources.map((source) => ({ ...source })), after: settings.dailyTodoSources.map((source) => ({ ...source })), reason: "requested" }] }] });
  } else {
    const target = findTask(snapshot, args.target.taskId, args.target.kind === "marker" ? "subtask" : undefined);
    checkRevision(snapshot, target, args.expectedRevision);
    const parent = findTask(snapshot, target.file.path, "parent");
    if (snapshot.contents.get(parent.id) !== buildFullNote(parent, parent.subtasks)) fail("INVALID_INPUT", "未モデル化Markdownを保全できないため保存を拒否します。");
    let definition = settings.ganttTags.find((tag) => tag.name.toLocaleLowerCase() === args.name.toLocaleLowerCase() || tag.key === args.name);
    if (!definition) {
      let index = 1; while (settings.ganttTags.some((tag) => tag.key === `tag-${index}`)) index++;
      definition = { key: `tag-${index}`, name: args.name, color: "", order: Math.max(0, ...settings.ganttTags.map((tag) => tag.order)) + 1000 };
      settings.ganttTags.push(definition); plan.keys = ["ganttTags"];
      plan.entries.push({ entity: { kind: "tag-definition", tagKey: definition.key }, displayName: definition.name, effects: [{ kind: "tag-definition", before: null, after: definition, affectedCount: 1 }] });
    }
    const add = (tags: readonly string[]) => [...new Set([...tags.map((name) => settings.ganttTags.find((tag) => tag.key === name || tag.name.toLocaleLowerCase() === name.toLocaleLowerCase())?.name ?? name), definition!.name])];
    let patch: TaskChange["patch"];
    if (args.target.kind === "marker") {
      const markerKey = args.target.markerKey;
      if (!target.ganttMarkers?.some((marker) => marker.key === markerKey)) fail("NOT_FOUND", "実在するmarkerKeyを取得してください。");
      patch = { ganttMarkers: target.ganttMarkers.map((marker) => marker.key === markerKey ? { ...marker, tags: add(marker.tags ?? []) } : { ...marker }) };
    } else patch = { tags: add(target.tags) };
    const copy = structuredClone(parent); applyPatchToParent(copy, patch, target.id, settings);
    const reparsed = parseTaskFile({ path: parent.id }, buildFullNote(copy, copy.subtasks), { ...settings, autoPriorityEnabled: false });
    if (!reparsed || canonical(copy) !== canonical(reparsed)) {
      // File handles carry runtime metadata; compare the affected public effects instead.
      const after = target.kind === "parent" ? copy : copy.subtasks!.get(target.key!)!;
      const parsed = target.kind === "parent" ? reparsed : reparsed?.subtasks?.get(target.key!);
      if (!parsed || canonical(taskEffects(target, after, { ...patch })) !== canonical(taskEffects(target, parsed, { ...patch }))) fail("INVALID_INPUT", "タグ付与のMarkdown round tripを確認できません。");
    }
    const after = target.kind === "parent" ? copy : copy.subtasks!.get(target.key!)!;
    plan.changes.push({ taskId: target.id, patch, expectedRevision: snapshot.revisions.get(target.file.path) });
    plan.entries.push({ entity: { kind: "task", taskId: target.id, ...(target.kind === "subtask" ? { parentId: parent.id } : {}) }, displayName: target.displayName, effects: taskEffects(target, after, { ...patch }) });
  }
  return plan;
}

/** Approval executor sends the exact frozen bytes once; it must never rebuild a newer snapshot. */
export async function executeExternalSend(prepared: PreparedExternalSend, send: (destination: string, body: string) => Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) fail("POLICY_DENIED", "送信前に停止しました。");
  if (await contentRevision(prepared.body) !== prepared.payloadDigest) fail("REVISION_CONFLICT", "承認payloadが変更されています。再プレビューしてください。");
  if (signal?.aborted) fail("POLICY_DENIED", "送信前に停止しました。");
  await send(prepared.destination, prepared.body);
}
