import type { RequestContext } from "../../contracts/context";
import { operationInputSchemas, operationOutputSchemas, type OperationInputMap, type OperationOutputMap, type ViewOperationId } from "../../contracts/operations";
import type { UiPort } from "../../contracts/ports";
import type { PreviewEntry } from "../../contracts/preview";
import type { Logger } from "../../core/logger";
import type { TaskRow } from "../../core/types";
import { parseTaskFile, buildFullNote } from "../../core/note-format";
import { mergeTaskNote } from "../../core/note-update";
import { taskEffects } from "../preview-projector";
import type { HistoryManager } from "../history-manager";
import type { VaultAdapter } from "../task-operations";
import { canonical, fail, flatten, handlerInput, type TaskSnapshot } from "./runtime";
import { getDailyTodoSourceForPath, extractDateFromDailyPath, parseDailyTodos } from "../daily-todo-service";
import { dailyItems, checkModeled, type DailyPlan, safeDailyPath } from "./daily-handlers";

export const VIEW_OPERATION_IDS = ["V01", "V02", "V03", "V04", "V05", "V06", "V07", "V08", "V09", "V10", "V11", "V12", "V13", "V14", "V15", "V16", "V17", "V18", "V19", "V20", "V21", "V22", "V23"] as const;
export type ViewRequestId = Extract<typeof VIEW_OPERATION_IDS[number], ViewOperationId> | "D08";
export async function viewRequest<K extends ViewRequestId>(id: K, input: OperationInputMap[K], context: RequestContext, ui?: UiPort): Promise<OperationOutputMap[K]> {
  const args = handlerInput(id, input, context);
  if (!ui) fail("UI_UNAVAILABLE", "Obsidian UIが未接続です。");
  if ("viewId" in args && args.viewId && !ui.inspectView(args.viewId)) fail("UI_UNAVAILABLE", "稼働中のviewIdを取得してください。");
  if (id === "D08") safeDailyPath((args as OperationInputMap["D08"]).path);
  // The human-only UiPort stays in the application host; transports receive this guarded function.
  return operationOutputSchemas[id].parse(await ui.request(id, args)) as OperationOutputMap[K];
}
export async function diagnosticRequest(input: OperationInputMap["V22"], context: RequestContext, logger?: Pick<Logger, "startRecording">): Promise<OperationOutputMap["V22"]> {
  const args = handlerInput("V22", input, context);
  if (!logger) fail("POLICY_DENIED", "診断portが未接続です。");
  logger.startRecording(args.name);
  return operationOutputSchemas.V22.parse({ schemaVersion: 1, resultKind: "request", operationId: "V22", status: "applied", effects: [{ kind: "diagnostic", recording: true, entryCount: 0 }] });
}
export interface HistoryPlan {
  daily?: DailyPlan;
  direction: "undo" | "redo";
  historyRevision: string;
  label: string;
  entries: Omit<PreviewEntry, "actionId">[];
  afterParents: TaskRow[];
  writes: { path: string; before: string; after: string }[];
}
export async function historyPlan(id: "V20" | "V21", input: OperationInputMap["V20"], snapshot: TaskSnapshot, history: HistoryManager): Promise<HistoryPlan> {
  operationInputSchemas[id].parse(input);
  const direction = id === "V20" ? "undo" : "redo", transition = history.inspectTransition(direction);
  if (transition.busy) fail("POLICY_DENIED", "履歴操作の完了後に再プレビューしてください。");
  if (!transition.entry) fail("NOT_FOUND", "対象のUndo/Redo履歴がありません。");
  const plan: HistoryPlan = { direction, historyRevision: transition.historyRevision, label: transition.entry.label, entries: [], afterParents: structuredClone(snapshot.parents), writes: [] };
  for (const file of transition.entry.files) {
    const before = direction === "undo" ? file.after : file.before, after = direction === "undo" ? file.before : file.after;
    if (snapshot.contents.get(file.path) !== before) fail("REVISION_CONFLICT", "履歴と現在のファイル内容が一致しません。");
    const source = getDailyTodoSourceForPath(file.path, snapshot.settings);
    if (source && !snapshot.parents.some((parent) => parent.id === file.path)) {
      safeDailyPath(file.path); checkModeled(before); checkModeled(after);
      const unmodeled = (content: string) => {
        const todos = new Set(parseDailyTodos(content).map((item) => item.line));
        return content.split("\n").filter((_, line) => !todos.has(line)).join("\n");
      };
      if (unmodeled(before) !== unmodeled(after)) fail("INVALID_INPUT", "未モデル化Markdownの変更を含むDaily履歴は安全にプレビューできません。");
      const daily = plan.daily ??= { entries: [], writes: [], warnings: [], unresolvedTemplates: [], files: [] };
      const prior = await dailyItems(file.path, before, snapshot), next = await dailyItems(file.path, after, snapshot);
      // Match unchanged rows first, including duplicates and rows shifted by insertions.
      const remaining = [...next];
      const removed = prior.filter((item) => {
        const index = remaining.findIndex((other) => other.text === item.text && other.completed === item.completed);
        if (index < 0) return true;
        remaining.splice(index, 1); return false;
      });
      if (!removed.length && !remaining.length) fail("INVALID_INPUT", "ToDoの変更として表現できないDaily履歴です。");
      for (let index = 0; index < Math.max(removed.length, remaining.length); index++) {
        const old = removed[index], current = remaining[index], item = old ?? current;
        const state = (value: typeof item | undefined) => value ? { path: value.path, sourceKey: value.sourceKey, text: value.text, completed: value.completed } : null;
        daily.entries.push({ entity: { kind: "daily-todo", path: file.path, line: item.line, itemFingerprint: item.itemFingerprint }, displayName: (current ?? old).text, effects: [{ kind: "daily-todo", before: state(old), after: state(current) }] });
      }
      daily.writes.push({ path: file.path, before, after });
      daily.files.push({ path: file.path, sourceKey: source.key, date: extractDateFromDailyPath(file.path, snapshot.settings), before, after });
      plan.writes.push({ path: file.path, before, after });
      continue;
    }
    const old = parseTaskFile({ path: file.path }, before, { ...snapshot.settings, autoPriorityEnabled: false });
    const next = parseTaskFile({ path: file.path }, after, { ...snapshot.settings, autoPriorityEnabled: false });
    if (!old || !next) fail("INVALID_INPUT", "履歴のタスクを安全にプレビューできません。");
    const oldNote = buildFullNote(old, old.subtasks), nextNote = buildFullNote(next, next.subtasks);
    // Either direction may be the original preserving write (Undo restores its exact bytes).
    let preserving = false;
    try {
      preserving = mergeTaskNote(before, oldNote, nextNote) === after;
    } catch {
      // Undo may only be reproducible by the original forward write.
    }
    if (!preserving) {
      try {
        preserving = mergeTaskNote(after, nextNote, oldNote) === before;
      } catch {
        // Report either direction's refusal through the operation error contract.
      }
    }
    if (!preserving) fail("INVALID_INPUT", "未モデル化Markdownの変更を含む履歴は安全にプレビューできません。");
    const oldRows = flatten([old]), newRows = flatten([next]);
    for (const taskId of new Set([...oldRows, ...newRows].map((row) => row.id))) {
      const prior = oldRows.find((row) => row.id === taskId), current = newRows.find((row) => row.id === taskId);
      const effects = taskEffects(prior, current);
      if (effects.length) plan.entries.push({ entity: { kind: "task", taskId, ...(taskId !== file.path ? { parentId: file.path } : {}) }, displayName: (current ?? prior)!.displayName, effects });
    }
    const index = plan.afterParents.findIndex((parent) => parent.id === file.path);
    if (index < 0) fail("NOT_FOUND", "履歴の親タスクを再取得してください。");
    plan.afterParents[index] = next; plan.writes.push({ path: file.path, before, after });
  }
  if (plan.daily) {
    const dates = new Set(plan.daily.files.map((file) => file.date));
    for (const [path, content] of snapshot.contents) {
      const source = getDailyTodoSourceForPath(path, snapshot.settings), date = extractDateFromDailyPath(path, snapshot.settings);
      if (source && dates.has(date) && !plan.daily.files.some((file) => file.path === path)) plan.daily.files.push({ path, sourceKey: source.key, date, before: content, after: content });
    }
    plan.entries.push(...plan.daily.entries);
  }
  return plan;
}
/** Run inside OperationService's shared coordinator after consuming an approved plan once. */
export async function executeHistoryPlan(plan: HistoryPlan, history: HistoryManager, vault: Parameters<HistoryManager["undo"]>[0], signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) fail("POLICY_DENIED", "履歴操作を停止しました。");
  const current = history.inspectTransition(plan.direction);
  if (current.busy || current.historyRevision !== plan.historyRevision || current.entry?.label !== plan.label || canonical(current.entry.files) !== canonical(plan.writes.map((file) => ({ path: file.path, before: plan.direction === "undo" ? file.after : file.before, after: plan.direction === "undo" ? file.before : file.after })))) fail("REVISION_CONFLICT", "履歴先頭が変更されました。再プレビューしてください。");
  const result = await history[plan.direction](vault);
  if (result.kind !== "success") fail(result.kind === "empty" ? "NOT_FOUND" : result.kind === "invalidated" ? "PARTIAL" : "REVISION_CONFLICT", `履歴操作結果: ${result.kind}。${result.kind === "invalidated" ? result.reason : "再取得してください。"}`);
}

export interface DiagnosticPlan {
  recordingRevision: number;
  entries: Omit<PreviewEntry, "actionId">[];
  writes: { path: string; before: null; after: string }[];
}
export function diagnosticPlan(input: OperationInputMap["V23"], logger: Pick<Logger, "inspectRecording">, now = new Date()): DiagnosticPlan {
  operationInputSchemas.V23.parse(input);
  const recording = logger.inspectRecording();
  const plan: DiagnosticPlan = { recordingRevision: recording.revision, entries: [], writes: [] };
  if (!recording.recording) return plan;
  if (recording.entryCount > 20000) fail("INVALID_INPUT", "診断ログの上限を超えています。");
  const path = `_vault-gantt-logs/${recording.name}_${now.toISOString().replace(/[:.]/g, "-")}.log`;
  safeDailyPath(path);
  plan.writes.push({ path, before: null, after: recording.content });
  plan.entries.push({ entity: { kind: "integration", targetId: "diagnostic-recording" }, displayName: path, effects: [{ kind: "diagnostic", recording: false, outputPath: path, entryCount: recording.entryCount }, { kind: "presence", action: "create", before: null, after: { path, entryCount: recording.entryCount } }] });
  return plan;
}
export async function executeDiagnosticPlan(plan: DiagnosticPlan, logger: Pick<Logger, "inspectRecording" | "finishRecording">, vault: VaultAdapter, signal?: AbortSignal): Promise<{ recording: boolean }> {
  if (!plan.writes.length) return { recording: logger.inspectRecording().recording };
  if (signal?.aborted) fail("POLICY_DENIED", "診断保存を停止しました。");
  const current = logger.inspectRecording(), write = plan.writes[0];
  if (!current.recording || current.revision !== plan.recordingRevision || current.content !== write.after) fail("REVISION_CONFLICT", "診断ログが更新されました。再プレビューしてください。");
  if (vault.getFileByPath(write.path)) fail("REVISION_CONFLICT", "診断出力pathが既に存在します。");
  await vault.create(write.path, write.after);
  // A new recording/log appended while create was awaited must never be discarded.
  logger.finishRecording(plan.recordingRevision);
  return { recording: logger.inspectRecording().recording };
}
