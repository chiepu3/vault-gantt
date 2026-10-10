import { contextQueryInputSchemas, contextQueryOutputSchemas, publicSettingsSchema, readResultSchema, type ContextQueryId, type ContextQueryMap, type ContextQueryResult, type CompactTaskV1, type TaskFieldGroup, type ReadResultV1, type RequestContext, type TaskReadV1 } from "../contracts/context";
import type { ContextReadPort } from "../contracts/ports";
import type { TaskRow, TaskWorkbenchSettings } from "../core/types";
import { parseTaskFile } from "../core/note-format";
import { todayStr, getEffectivePriority, buildFileRevision } from "../core/utils";
import type { VaultAdapter } from "./task-operations";
import { canonical, contentRevision, fail, flatten, findTask, OperationFailure, type TaskSnapshot } from "./operations/runtime";
import { publicSettings, period, progress, hours, aggregates } from "./preview-projector";
import { holidaySet } from "./gantt-actions";
import { addDays } from "./gantt-layout";
import { getDailyTodoSourceForPath, extractDateFromDailyPath } from "./daily-todo-service";
import { DailyReadHandler } from "./operations/daily-handlers";
const DEFAULT_FIELDS: readonly TaskFieldGroup[] = ["identity", "status", "schedule", "priority", "tags"];
export function compactTask(row: TaskRow, snapshot: TaskSnapshot, fields: readonly TaskFieldGroup[]): CompactTaskV1 {
  const common = { id: row.id, name: row.displayName || row.title, revision: snapshot.revisions.get(row.file.path)!,
    ...(fields.includes("status") ? { status: row.statusLabel, completed: row.completed } : {}),
    ...(fields.includes("priority") ? { priority: { stored: row.priority, effective: getEffectivePriority(row, snapshot.settings.autoPriorityEnabled), mode: row.priorityMode } } : {}),
    ...(fields.includes("tags") ? { tags: [...row.tags] } : {}),
    ...(fields.includes("content") ? { content: { currentStatus: row.currentStatus, notes: row.notes, createdAt: row.createdAt || null, updatedAt: row.updatedAt || null } } : {}),
  };
  return row.kind === "parent" ? { ...common, kind: "parent", parentId: null,
    ...(fields.includes("schedule") ? { due: row.dueDate || null, gantt: { enabled: row.ganttEnabled, order: row.ganttOrder ?? 999999 } } : {}),
    ...(fields.includes("derived") ? { derived: { period: period(row), progress: progress(row), effectivePriority: getEffectivePriority(row, snapshot.settings.autoPriorityEnabled) } } : {}),
    ...(fields.includes("children") ? { children: [...row.subtasks?.values() ?? []].map((child) => child.id) } : {}),
  } : { ...common, kind: "subtask", parentId: row.file.path,
    ...(fields.includes("schedule") ? { schedule: { start: row.plannedStartDate || null, end: row.plannedEndDate || null, due: row.dueDate || null } } : {}),
    ...(fields.includes("markers") ? { markers: (row.ganttMarkers ?? []).map((marker) => ({ ...marker, tags: [...marker.tags ?? []] })) } : {}),
    ...(fields.includes("workload") ? { hours: hours(row) } : {}),
  };
}
interface Cursor { binding: string; revision: string; offset: number }
export class ContextIndex implements ContextReadPort {
  private readonly parsed = new Map<string, { revision: string; parent: TaskRow | null }>();
  private readonly snapshots = new Map<string, TaskSnapshot>();
  private readonly cursors = new Map<string, Cursor>();
  private readonly dailyReader = new DailyReadHandler();
  private counter = 0;
  constructor(private readonly vaultFactory: () => VaultAdapter, private readonly settings: () => TaskWorkbenchSettings, readonly vaultInstanceId: string) {}
  async snapshot(): Promise<TaskSnapshot> {
    const vault = this.vaultFactory(), settings = structuredClone(this.settings());
    const today = todayStr(), timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const parseSettings = { ...settings, autoPriorityEnabled: false };
    const contents = new Map<string, string>(), revisions = new Map<string, string>(), statRevisions = new Map<string, string>(), parents: TaskRow[] = [], parseFailures: string[] = [];
    const root = settings.taskFolder.replace(/\/$/, "");
    for (const file of vault.getFiles().filter((file) => file.path.endsWith(".md") && (file.path.startsWith(root + "/") || getDailyTodoSourceForPath(file.path, settings))).sort((a, b) => a.path.localeCompare(b.path))) {
      try {
        const content = await vault.read(file), revision = await contentRevision(content);
        contents.set(file.path, content); revisions.set(file.path, revision); statRevisions.set(file.path, buildFileRevision(file as TaskRow["file"]));
        // Daily bytes participate in conflict checks, but are never task models.
        if (!file.path.startsWith(root + "/") || getDailyTodoSourceForPath(file.path, settings) && /^\d{4}-\d{2}-\d{2}$/.test(extractDateFromDailyPath(file.path, settings))) { this.parsed.delete(file.path); continue; }
        const parseRevision = revision + ":" + today;
        const cached = this.parsed.get(file.path);
        let parent: TaskRow | null;
        if (cached?.revision === parseRevision) parent = cached.parent;
        else { parent = parseTaskFile({ path: file.path }, content, parseSettings); this.parsed.set(file.path, { revision: parseRevision, parent }); }
        if (parent) parents.push(structuredClone(parent));
        else if (/^type:\s*task\s*$/m.test(content)) parseFailures.push(file.path);
      } catch { parseFailures.push(file.path); this.parsed.delete(file.path); }
    }
    for (const path of this.parsed.keys()) if (!contents.has(path)) this.parsed.delete(path);
    const settingsRevision = await contentRevision(settings), calendarRevision = await contentRevision([...holidaySet(settings)].sort());
    const revision = await contentRevision({ files: [...revisions], settingsRevision, today, timezone, parseFailures });
    const snapshot = { parents, contents, revisions, statRevisions, settings, revision, settingsRevision, calendarRevision, today, timezone, parseFailures };
    this.snapshots.set(revision, structuredClone(snapshot));
    while (this.snapshots.size > 5) this.snapshots.delete(this.snapshots.keys().next().value!);
    return snapshot;
  }
  private page(rows: readonly TaskRow[], snapshot: TaskSnapshot, fields: readonly TaskFieldGroup[], limit: number, cursor: string | undefined, binding: string): TaskReadV1 {
    let offset = 0;
    if (cursor) {
      const saved = this.cursors.get(cursor);
      if (!saved || saved.binding !== binding || saved.revision !== snapshot.revision) fail("CURSOR_STALE", "取得済みページを破棄し、cursorなしで同じ検索を再取得してください。", "cursor");
      offset = saved.offset;
    }
    const items = rows.slice(offset, offset + limit).map((row) => compactTask(row, snapshot, fields));
    const truncated = offset + items.length < rows.length;
    const nextCursor = truncated ? `context-${++this.counter}` : null;
    if (nextCursor) { this.cursors.set(nextCursor, { binding, revision: snapshot.revision, offset: offset + items.length }); while (this.cursors.size > 500) this.cursors.delete(this.cursors.keys().next().value!); }
    return { kind: "tasks", fieldsIncluded: [...fields], items, totalMatched: rows.length, returned: items.length, truncated, nextCursor };
  }
  private definitionPage<T>(rows: readonly T[], snapshot: TaskSnapshot, limit: number, cursor: string | undefined, binding: string) {
    let offset = 0;
    if (cursor) {
      const saved = this.cursors.get(cursor);
      if (!saved || saved.binding !== binding || saved.revision !== snapshot.revision) fail("CURSOR_STALE", "cursorを破棄し同じqueryを先頭から再取得してください。", "cursor");
      offset = saved.offset;
    }
    const items = rows.slice(offset, offset + limit), truncated = offset + items.length < rows.length;
    const nextCursor = truncated ? `context-${++this.counter}` : null;
    if (nextCursor) { this.cursors.set(nextCursor, { binding, revision: snapshot.revision, offset: offset + items.length }); while (this.cursors.size > 500) this.cursors.delete(this.cursors.keys().next().value!); }
    return { items, totalMatched: rows.length, returned: items.length, truncated, nextCursor };
  }
  async query<K extends ContextQueryId>(id: K, input: ContextQueryMap[K], context: RequestContext): Promise<ContextQueryResult<K>> {
    try {
      if (context.vaultInstanceId !== this.vaultInstanceId || !context.capabilities.includes("read")) fail("POLICY_DENIED", "このVaultに対するread権限が必要です。");
      if (context.signal?.aborted) fail("POLICY_DENIED", "要求は停止済みです。");
      const parsed = contextQueryInputSchemas[id].safeParse(input);
      if (!parsed.success) fail("INVALID_INPUT", parsed.error.issues.map((issue) => issue.path.join(".") + ": " + issue.message).join("; "));
      const snapshot = await this.snapshot();
      if (id === "daily.get") {
        const args = contextQueryInputSchemas["daily.get"].parse(input);
        const result = await this.dailyReader.read({ dateRange: args.dateRange, sourceKeys: args.sourceKeys, cursor: args.cursor }, context, snapshot, this.vaultFactory(), { limit: args.limit, includeItems: args.includeItems });
        return contextQueryOutputSchemas[id].parse({ status: "success", result });
      }
      const base: Omit<ReadResultV1, "data" | "errors"> & { errors: Array<ReadResultV1["errors"][number]> } = { schemaVersion: 1 as const, resultKind: "read" as const, today: snapshot.today, timezone: snapshot.timezone, snapshotRevision: snapshot.revision,
        errors: snapshot.parseFailures.map((targetId) => ({ code: "PARSE_FAILED" as const, targetId, detail: "管理タスクを解析できません。" })) };
      const binding = canonical({ query: id, input: { ...parsed.data, cursor: undefined }, principal: context.principalId, vault: context.vaultInstanceId });
      let data: ReadResultV1["data"];
      if (id === "tasks.search") {
        const args = parsed.data as ReturnType<typeof contextQueryInputSchemas["tasks.search"]["parse"]>;
        const fields = [...new Set<TaskFieldGroup>(["identity", ...args.fields ?? DEFAULT_FIELDS])];
        const rows = flatten(snapshot.parents).filter((row) => {
          const parent = row.kind === "parent" ? row : snapshot.parents.find((parent) => parent.id === row.file.path)!;
          const text = `${row.displayName} ${row.title} ${row.currentStatus} ${row.notes}`.toLowerCase();
          return (!args.name || `${row.displayName} ${row.title}`.toLowerCase().includes(args.name.toLowerCase())) && (!args.text || text.includes(args.text.toLowerCase()))
            && (!args.kind || row.kind === args.kind) && (!args.parentId || row.kind === "subtask" && row.file.path === args.parentId)
            && (!args.statuses || args.statuses.includes(row.statusLabel)) && (!args.tags || args.tags.every((tag) => row.tags.includes(tag)))
            && (!args.dueRange || !!row.dueDate && row.dueDate >= args.dueRange.from && row.dueDate <= args.dueRange.to)
            && (!args.plannedRange || !!row.plannedStartDate && !!row.plannedEndDate && row.plannedStartDate <= args.plannedRange.to && row.plannedEndDate >= args.plannedRange.from)
            && (args.placed === undefined || row.kind === "subtask" && (!!row.plannedStartDate && !!row.plannedEndDate) === args.placed)
            && (args.gantt === undefined || parent.ganttEnabled === args.gantt);
        });
        data = this.page(rows, snapshot, fields, args.limit, args.cursor, binding);
      } else if (id === "tasks.get-many") {
        const args = parsed.data as ContextQueryMap["tasks.get-many"];
        const fields = [...new Set<TaskFieldGroup>(["identity", ...args.include ?? DEFAULT_FIELDS])];
        const rows = args.taskIds.flatMap((taskId) => { const row = flatten(snapshot.parents).find((row) => row.id === taskId); if (!row) base.errors.push({ code: "NOT_FOUND", targetId: taskId, detail: "タスクがありません。" }); return row ? [row] : []; });
        data = this.page(rows, snapshot, fields, 20, undefined, binding);
      } else if (id === "projects.get") {
        const args = parsed.data as ReturnType<typeof contextQueryInputSchemas["projects.get"]["parse"]>;
        const parent = findTask(snapshot, args.parentTaskId, "parent");
        data = { kind: "project", parent: compactTask(parent, snapshot, DEFAULT_FIELDS) as Extract<CompactTaskV1, { kind: "parent" }>, derived: { period: period(parent), progress: progress(parent) },
          ...(args.includeChildren ? { children: this.page([...parent.subtasks?.values() ?? []], snapshot, [...new Set<TaskFieldGroup>(["identity", ...args.childFields ?? DEFAULT_FIELDS])], args.limit, args.cursor, binding) } : {}) };
      } else if (id === "context.overview") {
        const args = parsed.data as ContextQueryMap["context.overview"];
        if (args.dateRange) fail("INVALID_INPUT", "overviewの日付範囲絞り込みは未実装です。tasks.searchのplannedRange/dueRangeを使用してください。", "dateRange");
        const parents = snapshot.parents.filter((parent) => !args.scope?.parentIds || args.scope.parentIds.includes(parent.id)), children = parents.flatMap((parent) => [...parent.subtasks?.values() ?? []]);
        data = { kind: "overview", counts: { parents: parents.length, children: children.length, unplaced: children.filter((child) => !child.plannedStartDate || !child.plannedEndDate).length, completed: flatten(parents).filter((row) => row.completed).length, parseFailures: snapshot.parseFailures.length }, settings: publicSettings(snapshot.settings), capabilities: [...context.capabilities], summaryRevision: snapshot.revision };
      } else if (id === "calendar.get") {
        const args = parsed.data as ContextQueryMap["calendar.get"];
        data = { kind: "calendar", ...args, revision: snapshot.calendarRevision, calendar: { weekends: [0, 6], manual: [...snapshot.settings.ganttManualHolidays], special: [...snapshot.settings.ganttSpecialHolidays], national: [...snapshot.settings.ganttNationalHolidays] } };
      } else if (id === "settings.get") {
        const args = parsed.data as ContextQueryMap["settings.get"];
        const sections = { storage: ["taskFolder", "filenameUsesDatePrefix", "autoPriorityEnabled"], display: ["hideCompletedByDefault", "currentStatusRows", "ganttZoom", "incrementalGanttRender", "ganttFeatureDailyTodoEnabled", "ganttFeatureWorkloadEnabled", "ganttFeatureEventsEnabled", "ganttFeatureSyncEnabled", "ganttFeatureTagsEnabled", "ganttShowTagsOnBars", "ganttShowTagsOnParents", "ganttShowParentTagsOnChildBars"], calendar: ["ganttManualHolidays", "ganttSpecialHolidays", "ganttNationalHolidays"], sources: ["dailyTodoSources"], tags: ["ganttTags"], sync: ["ganttSyncEnabled", "ganttSyncUrl", "ganttSyncIntervalMinutes"], workload: ["ganttWorkloadMaxHours", "ganttWorkloadDailyCapacityHours"] };
        const keys = args.sections.flatMap((section) => sections[section]);
        const values = publicSettingsSchema.parse(Object.fromEntries(Object.entries(publicSettings(snapshot.settings)).filter(([key]) => keys.includes(key))));
        data = { kind: "settings", sections: [...args.sections], values };
      } else if (id === "context.changes") {
        const args = parsed.data as ContextQueryMap["context.changes"], old = this.snapshots.get(args.sinceRevision);
        if (!old) fail("RESET_REQUIRED", "古い差分を破棄し、overviewと対象の詳細を再取得してください。");
        const scoped = (state: TaskSnapshot) => flatten(state.parents).filter((row) => !args.scope.parentIds || args.scope.parentIds.includes(row.file.path));
        const oldRows = new Map(scoped(old).map((row) => [row.id, row])), newRows = new Map(scoped(snapshot).map((row) => [row.id, row]));
        const allFields: TaskFieldGroup[] = ["identity", "status", "schedule", "priority", "tags", "content", "markers", "workload", "children", "derived"];
        data = { kind: "changes", sinceRevision: args.sinceRevision, added: [...newRows.values()].filter((row) => !oldRows.has(row.id)).map((row) => compactTask(row, snapshot, allFields)), changed: [...newRows.values()].filter((row) => oldRows.has(row.id) && canonical(compactTask(oldRows.get(row.id)!, old, allFields)) !== canonical(compactTask(row, snapshot, allFields))).map((row) => compactTask(row, snapshot, allFields)), deletedIds: [...oldRows.keys()].filter((taskId) => !newRows.has(taskId)) };
      } else if (id === "events.get") {
        const args = contextQueryInputSchemas["events.get"].parse(input);
        const rows = snapshot.settings.ganttEvents.filter((event) => (!args.eventKeys || args.eventKeys.includes(event.key)) && (!args.dateRange || event.date >= args.dateRange.from && event.date <= args.dateRange.to))
          .slice().sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key))
          .map((event) => ({ key: event.key, title: event.title, date: event.date, hours: hours(event), revision: snapshot.settingsRevision }));
        data = { kind: "events", ...this.definitionPage(rows, snapshot, args.limit, args.cursor, binding) };
      } else if (id === "weekly.get") {
        const args = contextQueryInputSchemas["weekly.get"].parse(input);
        const rows = snapshot.settings.weeklyWorkSchedules.filter((weekly) => (!args.scheduleKeys || args.scheduleKeys.includes(weekly.key)) && (!args.daysOfWeek || args.daysOfWeek.includes(weekly.dayOfWeek)))
          .slice().sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.key.localeCompare(b.key)).map((weekly) => ({ ...weekly, revision: snapshot.settingsRevision }));
        data = { kind: "weekly", ...this.definitionPage(rows, snapshot, args.limit, args.cursor, binding) };
      } else if (id === "workload.get") {
        const args = parsed.data as ReturnType<typeof contextQueryInputSchemas["workload.get"]["parse"]>;
        const from = args.from ?? snapshot.today, to = args.to ?? addDays(from, 30), dates: string[] = [];
        for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date);
        const parents = snapshot.parents.filter((parent) => !args.parentIds || args.parentIds.includes(parent.id));
        const mask = <T extends { plan: number; actual: number }>(cell: T): T => ({ ...cell, plan: args.mode === "actual" ? 0 : cell.plan, actual: args.mode === "plan" ? 0 : cell.actual });
        data = { kind: "workload", days: aggregates(parents, snapshot.settings, dates).map((day) => { const masked = mask(day); return { ...masked, overCapacity: masked.plan > day.capacity || masked.actual > day.capacity }; }),
          ...(args.detail ? { contributions: [
            ...parents.flatMap((parent) => [...parent.subtasks?.values() ?? []]).map((row) => ({ kind: "task" as const, id: row.id, cells: hours(row).filter((cell) => cell.date >= from && cell.date <= to).map(mask) })),
            ...snapshot.settings.ganttEvents.map((event) => ({ kind: "event" as const, id: event.key, cells: hours(event).filter((cell) => cell.date >= from && cell.date <= to).map(mask) })),
            ...snapshot.settings.weeklyWorkSchedules.map((weekly) => ({ kind: "weekly" as const, id: weekly.key, cells: dates.filter((date) => new Date(date + "T00:00:00Z").getUTCDay() === weekly.dayOfWeek).map((date) => mask({ date, plan: weekly.minutesPerWeek / 60, actual: 0 })) })),
          ] } : {}) };
      } else fail("INVALID_INPUT", "対応するcontext queryを指定してください。");
      const result = readResultSchema.parse({ ...base, data });
      return contextQueryOutputSchemas[id].parse({ status: "success", result });
    } catch (error) {
      const failure = error instanceof OperationFailure ? error.error : { code: "INVALID_INPUT" as const, retryable: false, nextAction: error instanceof Error ? error.message : "入力と管理ノートを確認してください。" };
      return { status: "error", error: failure };
    }
  }
}
