import type { RequestContext, DailyReadResultV1, DailyState } from "../../contracts/context";
import { dailyItemSchema, dateOnlySchema } from "../../contracts/context";
import { operationInputSchemas, operationOutputSchemas, type OperationInputMap } from "../../contracts/operations";
import { ganttProjectionSchema, entityRefKey, type PreviewEntry, type OperationPreviewV1, type GanttProjectionV1 } from "../../contracts/preview";
import type { VaultAdapter } from "../task-operations";
import { getDailyTodoPathForDate, getDailyTodoSourceForPath, extractDateFromDailyPath, parseDailyTodos, getDailyTodoInsertIndex } from "../daily-todo-service";
import { canonical, contentRevision, fail, handlerInput, type TaskSnapshot } from "./runtime";
import { ganttState } from "../preview-projector";

export const DAILY_OPERATION_IDS = ["D01", "D02", "D03", "D04", "D05", "D06", "D07", "D08", "D09"] as const;
export type DailyWriteId = Exclude<typeof DAILY_OPERATION_IDS[number], "D01" | "D08">;
export interface DailyFileWrite { path: string; before: string | null; after: string }
export interface DailyPlan {
  entries: Omit<PreviewEntry, "actionId">[];
  writes: DailyFileWrite[];
  warnings: OperationPreviewV1["warnings"][number][];
  /** Never execute templates during planning. These creations require execution and a fresh preview. */
  unresolvedTemplates: { path: string; sourceKey: string; templatePath: string }[];
  /** Frozen bytes for before/after Daily projections, including unchanged rows in touched files. */
  files: { path: string; sourceKey: string; date: string; before: string | null; after: string | null }[];
}
export function safeDailyPath(path: string): void {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..") || [...path].some((character) => character.charCodeAt(0) < 32)) fail("INVALID_INPUT", "安全なVault相対pathを指定してください。", "path");
}
type DailyItem = ReturnType<typeof dailyItemSchema.parse>;
export async function dailyItems(path: string, content: string, snapshot: TaskSnapshot): Promise<DailyItem[]> {
  const source = getDailyTodoSourceForPath(path, snapshot.settings);
  if (!source) fail("NOT_FOUND", "設定済みDailyソースのpathを指定してください。", "path");
  const lines = content.split("\n").map((line) => line.replace(/\r$/, ""));
  const revision = await contentRevision(content);
  return Promise.all(parseDailyTodos(content).map(async (item) => dailyItemSchema.parse({ path, sourceKey: source.key, text: item.text, completed: item.completed, line: item.line, revision, itemFingerprint: await contentRevision(lines[item.line]) })));
}

/** Own cursors per runtime instance, bound to principal, query, settings, date/TZ and file bytes. */
export class DailyReadHandler {
  private readonly cursors = new Map<string, { binding: string; revision: string; offset: number }>();
  private counter = 0;
  async read(input: OperationInputMap["D01"], context: RequestContext, snapshot: TaskSnapshot, vault: VaultAdapter): Promise<DailyReadResultV1> {
    const args = handlerInput("D01", input, context);
    if (context.signal?.aborted) fail("POLICY_DENIED", "要求は停止済みです。");
    const byDate = new Map<string, DailyItem[]>(), files: [string, string][] = [];
    for (const file of vault.getFiles().filter((file) => file.path.endsWith(".md")).sort((a, b) => a.path.localeCompare(b.path))) {
      const source = getDailyTodoSourceForPath(file.path, snapshot.settings);
      if (!source || args.sourceKeys && !args.sourceKeys.includes(source.key)) continue;
      const date = extractDateFromDailyPath(file.path, snapshot.settings);
      if (!dateOnlySchema.safeParse(date).success || date < args.dateRange.from || date > args.dateRange.to) continue;
      const content = await vault.read(file);
      files.push([file.path, await contentRevision(content)]);
      byDate.set(date, [...byDate.get(date) ?? [], ...await dailyItems(file.path, content, snapshot)]);
    }
    const revision = await contentRevision({ files, settings: snapshot.settingsRevision, today: snapshot.today, timezone: snapshot.timezone });
    const binding = canonical([context.vaultInstanceId, context.principalId, context.origin, args.dateRange, args.sourceKeys ?? null]);
    let offset = 0;
    if (args.cursor) {
      const saved = this.cursors.get(args.cursor);
      if (!saved || saved.binding !== binding || saved.revision !== revision) fail("CURSOR_STALE", "cursorなしでDailyを再取得してください。");
      offset = saved.offset;
    }
    const days = [...byDate].filter(([, items]) => items.length).sort(([a], [b]) => a.localeCompare(b)).map(([date, items]) => ({ date, items, totalCount: items.length, completedCount: items.filter((item) => item.completed).length }));
    const page = days.slice(offset, offset + 20), truncated = offset + page.length < days.length;
    const nextCursor = truncated ? `daily-cursor-${++this.counter}` : null;
    if (nextCursor) {
      this.cursors.set(nextCursor, { binding, revision, offset: offset + page.length });
      while (this.cursors.size > 100) this.cursors.delete(this.cursors.keys().next().value!);
    }
    if (context.signal?.aborted) fail("POLICY_DENIED", "要求は停止済みです。");
    return operationOutputSchemas.D01.parse({ schemaVersion: 1, resultKind: "read", today: snapshot.today, timezone: snapshot.timezone, snapshotRevision: revision, errors: [], data: { kind: "daily", days: page, totalMatched: days.length, returned: page.length, truncated, nextCursor } });
  }
}

/** Refuse ambiguous checkbox syntax in YAML/code blocks instead of treating it as a ToDo. */
function checkModeled(content: string): void {
  let fence = "", yaml = false;
  const lines = content.split("\n");
  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/\r$/, "");
    if (line === "---" && (index === 0 || yaml)) { yaml = !yaml; continue; }
    const match = line.match(/^\s*(`{3,}|~{3,})/);
    if (match) { if (!fence) fence = match[1]; else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = ""; continue; }
    if ((fence || yaml || /^ {4}|^\t/.test(line)) && parseDailyTodos(line).length) fail("INVALID_INPUT", "未モデル化Markdown内のcheckboxがあります。安全に保存できません。");
  }
}
function state(item: DailyItem): DailyState { return { path: item.path, sourceKey: item.sourceKey, text: item.text, completed: item.completed }; }

export async function dailyPlan<K extends DailyWriteId>(id: K, input: OperationInputMap[K], snapshot: TaskSnapshot, vault: VaultAdapter): Promise<DailyPlan> {
  const args = operationInputSchemas[id].parse(input) as OperationInputMap["D03"] & OperationInputMap["D04"] & OperationInputMap["D05"] & OperationInputMap["D07"];
  const plan: DailyPlan = { entries: [], writes: [], warnings: [], unresolvedTemplates: [], files: [] };
  const originals = new Map<string, string | null>(), contents = new Map<string, string>();
  const load = async (path: string): Promise<string> => {
    safeDailyPath(path);
    if (contents.has(path)) return contents.get(path)!;
    const file = vault.getFileByPath(path);
    if (!file) fail("NOT_FOUND", "Dailyファイルを再取得してください。", "path");
    const content = await vault.read(file); checkModeled(content);
    originals.set(path, content); contents.set(path, content); return content;
  };
  const main = async (): Promise<string | null> => {
    const source = snapshot.settings.dailyTodoSources.find((source) => source.key === "main");
    if (!source) fail("NOT_FOUND", "mainソースを設定してください。");
    const path = getDailyTodoPathForDate(args.date, "main", snapshot.settings); safeDailyPath(path);
    if (getDailyTodoSourceForPath(path, snapshot.settings)?.key !== "main") fail("INVALID_INPUT", "mainのpathが先行ソースと重複しています。");
    if (contents.has(path)) return path;
    if (vault.getFileByPath(path)) { await load(path); return path; }
    if (!source.creatableFromGantt) fail("POLICY_DENIED", "mainソースで新規作成が許可されていません。");
    originals.set(path, null); contents.set(path, "");
    plan.entries.push({ entity: { kind: "daily-file", path, sourceKey: "main" }, displayName: path, effects: [{ kind: "presence", action: "create", before: null, after: { path, sourceKey: "main", ...(source.templatePath ? { templatePath: source.templatePath } : {}) } }] });
    if (source.templatePath) {
      safeDailyPath(source.templatePath);
      plan.unresolvedTemplates.push({ path, sourceKey: "main", templatePath: source.templatePath });
      plan.warnings.push({ code: "TEMPLATE_UNDETERMINED", detail: "未確定: templateはpreviewで実行しません。展開後の本文・挿入位置・副作用は未確定です。人間用UIで作成後、再プレビューしてください。" });
      return null;
    }
    return path;
  };
  const edit = async (target: OperationInputMap["D06"], text?: string, completed?: boolean, remove = false) => {
    // All targets refer to original line positions; apply replacements/deletions together later.
    const content = await load(target.path), original = originals.get(target.path)!;
    if (await contentRevision(original) !== target.expectedRevision) fail("REVISION_CONFLICT", "Dailyファイルを再取得してください。", "expectedRevision");
    const item = (await dailyItems(target.path, original, snapshot)).find((item) => item.line === target.line);
    if (!item || item.itemFingerprint !== target.itemFingerprint) fail("REVISION_CONFLICT", "checkbox行のfingerprintを再取得してください。", "itemFingerprint");
    if (id === "D07" && extractDateFromDailyPath(target.path, snapshot.settings) !== args.date) fail("INVALID_INPUT", "指定日の既存行だけを編集してください。");
    const key = canonical([target.path, target.line]);
    if (edits.has(key)) fail("INVALID_INPUT", "同じDaily行を重複指定しないでください。");
    const after = remove ? null : { ...state(item), text: text ?? item.text, completed: completed ?? item.completed };
    edits.set(key, { path: target.path, line: target.line, after });
    if (canonical(state(item)) !== canonical(after)) plan.entries.push({ entity: { kind: "daily-todo", path: target.path, line: target.line, itemFingerprint: item.itemFingerprint }, displayName: after?.text ?? item.text, effects: [{ kind: "daily-todo", before: state(item), after }] });
    return content;
  };
  const edits = new Map<string, { path: string; line: number; after: DailyState | null }>();
  const additions: { text: string; completed: boolean }[] = [];
  if (id === "D02") await main();
  if (id === "D03" || id === "D09") additions.push({ text: id === "D09" ? "新しいタスク" : args.text, completed: args.completed ?? false });
  if (id === "D04") await edit(args, args.text);
  if (id === "D05") await edit(args, undefined, args.completed);
  if (id === "D06") await edit(args, undefined, undefined, true);
  if (id === "D07") for (const item of args.nextItems) {
    if (item.kind === "existing") { await edit(item, item.text.trim() || undefined, item.text.trim() ? item.completed : undefined); }
    else if (item.text.trim()) additions.push({ text: item.text.trim(), completed: item.completed });
  }
  for (const path of contents.keys()) {
    const changes = [...edits.values()].filter((edit) => edit.path === path).sort((a, b) => b.line - a.line);
    if (!changes.length) continue;
    const content = contents.get(path)!, lines = content.split("\n");
    for (const edit of changes) {
      if (!edit.after) lines.splice(edit.line, 1);
      else { const prefix = lines[edit.line].match(/^(\s*[-*]\s+\[)[ xX](\]\s+)/)!; lines[edit.line] = `${prefix[1]}${edit.after.completed ? "x" : " "}${prefix[2]}${edit.after.text}${lines[edit.line].endsWith("\r") ? "\r" : ""}`; }
    }
    contents.set(path, lines.join("\n"));
  }
  if (additions.length) {
    const path = await main();
    if (path) {
      const content = contents.get(path)!, lines = content === "" ? [] : content.split("\n"), cr = content.includes("\r\n") ? "\r" : "";
      const index = getDailyTodoInsertIndex(lines.map((line) => line.replace(/\r$/, "")));
      const addedLines = additions.map((item) => `- [${item.completed ? "x" : " "}] ${item.text}${cr}`);
      lines.splice(index, 0, ...addedLines); contents.set(path, lines.join("\n"));
      for (const [offset, item] of additions.entries()) plan.entries.push({ entity: { kind: "daily-todo", path, line: index + offset, itemFingerprint: await contentRevision(addedLines[offset].replace(/\r$/, "")) }, displayName: item.text, effects: [{ kind: "daily-todo", before: null, after: { path, sourceKey: "main", ...item } }] });
    }
  }
  for (const [path, after] of contents) {
    const before = originals.get(path)!;
    if (before !== after && !plan.unresolvedTemplates.some((template) => template.path === path)) { checkModeled(after); plan.writes.push({ path, before, after }); }
    const source = getDailyTodoSourceForPath(path, snapshot.settings)!;
    plan.files.push({ path, sourceKey: source.key, date: extractDateFromDailyPath(path, snapshot.settings), before, after: plan.unresolvedTemplates.some((template) => template.path === path) ? null : after });
  }
  // Daily counts merge all configured sources for affected dates, including unchanged files.
  const dates = new Set(plan.files.map((file) => file.date));
  for (const file of vault.getFiles().filter((file) => file.path.endsWith(".md")).sort((a, b) => a.path.localeCompare(b.path))) {
    if (contents.has(file.path)) continue;
    const source = getDailyTodoSourceForPath(file.path, snapshot.settings);
    if (!source) continue;
    const date = extractDateFromDailyPath(file.path, snapshot.settings);
    if (!dates.has(date)) continue;
    const content = await vault.read(file);
    plan.files.push({ path: file.path, sourceKey: source.key, date, before: content, after: content });
  }
  return plan;
}

export async function dailyProjection(plan: DailyPlan, snapshot: TaskSnapshot, entries: readonly PreviewEntry[]): Promise<GanttProjectionV1 | null> {
  // Unknown template output has no trustworthy after snapshot; its warning remains on the card.
  if (plan.unresolvedTemplates.length) return null;
  if (!entries.length) return null;
  const targets = [...new Map(entries.map((entry) => [entityRefKey(entry.entity), entry.entity])).values()];
  const affectedDates = [...new Set(plan.files.map((file) => file.date))].sort();
  const base = ganttState(snapshot.parents, snapshot.settings, affectedDates);
  const summary = async (side: "before" | "after") => {
    const days = new Map<string, DailyItem[]>();
    for (const file of plan.files) {
      if (file[side] === null) continue;
      if (!dateOnlySchema.safeParse(file.date).success) fail("INVALID_INPUT", "Dailyのpathから実在日を取得できません。");
      days.set(file.date, [...days.get(file.date) ?? [], ...await dailyItems(file.path, file[side]!, snapshot)]);
    }
    return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, items]) => ({ date, totalCount: items.length, completedCount: items.filter((item) => item.completed).length, items }));
  };
  return ganttProjectionSchema.parse({ schemaVersion: 1, baseRevision: snapshot.revision, settingsRevision: snapshot.settingsRevision, calendarRevision: snapshot.calendarRevision, evaluatedDate: snapshot.today, timezone: snapshot.timezone,
    before: { ...base, daily: await summary("before"), dailyFiles: plan.files.map((file) => ({ path: file.path, sourceKey: file.sourceKey, exists: file.before !== null })) },
    after: { ...base, daily: await summary("after"), dailyFiles: plan.files.map((file) => ({ path: file.path, sourceKey: file.sourceKey, exists: file.after !== null })) },
    targets, affectedDates, affectedParentIds: [], coverage: { targetCount: targets.length, offset: 0, includedCount: targets.length, truncated: false, nextCursor: null },
    visibility: targets.map((entity) => ({ entity, state: snapshot.settings.ganttFeatureDailyTodoEnabled ? "visible" : "feature-disabled", reason: snapshot.settings.ganttFeatureDailyTodoEnabled ? "Dailyの確定内容を投影します。" : "Daily表示が無効です。" })),
  });
}

/** Called only after the service consumes human approval, inside its shared coordinator.
 * saved is called after each successful file so partial/cancelled outcomes retain exact receipts.
 */
export async function executeDailyPlan(plan: DailyPlan, vault: VaultAdapter, saved: (path: string) => void, signal?: AbortSignal): Promise<void> {
  if (plan.unresolvedTemplates.length) fail("POLICY_DENIED", "template結果が未確定です。人間用UIで作成後に再プレビューしてください。");
  const check = (current: string | null, expected: string | null) => {
    if (signal?.aborted) fail("POLICY_DENIED", "Daily保存を停止しました。");
    if (current !== expected) fail("REVISION_CONFLICT", "Dailyファイルが変更されました。再プレビューしてください。");
  };
  for (const frozen of [...plan.files, ...plan.writes]) {
    const file = vault.getFileByPath(frozen.path);
    check(file ? await vault.read(file) : null, frozen.before);
  }
  for (const write of plan.writes) {
    const file = vault.getFileByPath(write.path);
    if (write.before === null) { check(file ? await vault.read(file) : null, null); await vault.create(write.path, write.after); }
    else {
      if (!file) fail("REVISION_CONFLICT", "Dailyファイルが削除されました。");
      if (vault.process) await vault.process(file, (current) => { check(current, write.before); return write.after; });
      else { check(await vault.read(file), write.before); await vault.modify(file, write.after); }
    }
    saved(write.path);
  }
}
