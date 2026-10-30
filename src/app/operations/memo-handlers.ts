import { parseYaml, stringifyYaml } from "obsidian";
import type { RequestContext, MemoReadResultV1 } from "../../contracts/context";
import { operationInputSchemas, operationOutputSchemas, type OperationInputMap } from "../../contracts/operations";
import type { MemoStateV1, PreviewEntry } from "../../contracts/preview";
import { isMemoPath, memoBody, memoHeadline, parseMemoMeta, replaceMemoAnchor, replaceMemoBody, type MemoMeta } from "../../core/memo";
import { splitFrontmatter } from "../../core/note-v2";
import type { MemoLayout, TaskRow } from "../../core/types";
import { memoAnchorFields, resolveMemoAnchor, type MemoAnchor } from "../memo-anchor";
import { newMemoNote } from "../memo-service";
import type { VaultAdapter } from "../task-operations";
import { fail, findTask, flatten, handlerInput, type TaskSnapshot } from "./runtime";

export const MEMO_OPERATION_IDS = ["N01", "N02", "N03", "N04", "N05", "N06"] as const;
export type MemoWriteId = "N02" | "N03" | "N04" | "N05";

/** One memo note as the operations see it: front matter, text and the revision of the note's bytes. */
export interface MemoRecord { meta: MemoMeta; text: string; revision: string; content: string }
export interface MemoFileWrite { path: string; before: string | null; after: string | null; entry: number }
export interface MemoPlan {
  entries: Omit<PreviewEntry, "actionId">[];
  /** Whole-note writes; an entry without one changes nothing. */
  writes: MemoFileWrite[];
  /** A memo added closed: the view state is merged into the settings after the note exists (undo keeps working). */
  closed?: string;
}

/** The memo notes in the snapshot (they sit in the task folder, so their bytes are part of it). */
export function memoRecords(snapshot: TaskSnapshot): MemoRecord[] {
  const records: MemoRecord[] = [], seen = new Set<string>();
  for (const [path, content] of snapshot.contents) {
    if (!isMemoPath(path, snapshot.settings)) continue;
    let fm: Record<string, unknown> | null = null;
    try { const front = splitFrontmatter(content).front.replace(/^---[ \t]*\r?\n/, "").replace(/\r?\n?---[ \t]*\r?\n?$/, ""); fm = front ? (parseYaml(front) as Record<string, unknown> | null) : null; } catch { fm = null; }
    const meta = parseMemoMeta(path, fm);
    if (!meta || seen.has(meta.id)) continue;
    seen.add(meta.id);
    records.push({ meta, text: memoBody(content), revision: snapshot.revisions.get(path) ?? "", content });
  }
  return records;
}

const rowMap = (snapshot: TaskSnapshot): Map<string, TaskRow> => new Map(flatten(snapshot.parents).map((row) => [row.id, row]));
const anchorOf = (record: MemoRecord, rows: ReadonlyMap<string, TaskRow>, today: string): MemoAnchor => {
  const anchor = resolveMemoAnchor(record.meta, rows);
  return /^\d{4}-\d{2}-\d{2}$/.test(anchor.date) ? anchor : { ...anchor, date: today };
};
const stateOf = (text: string, anchor: Pick<MemoAnchor, "taskId" | "taskName" | "date">, open?: boolean): MemoStateV1 =>
  ({ text, ...(anchor.taskId ? { taskId: anchor.taskId, ...(anchor.taskName ? { taskName: anchor.taskName } : {}) } : {}), date: anchor.date, ...(open !== undefined ? { open } : {}) });

export class MemoReadHandler {
  /** `open` per memo comes from the live view state (the snapshot leaves it out so dragging a bubble never makes a proposal stale). */
  read(input: OperationInputMap["N01"], context: RequestContext, snapshot: TaskSnapshot, layout: Readonly<Record<string, MemoLayout>>): MemoReadResultV1 {
    const args = handlerInput("N01", input, context);
    const rows = rowMap(snapshot), query = args.query?.trim().toLowerCase();
    const items = memoRecords(snapshot).map((record) => ({ record, anchor: anchorOf(record, rows, snapshot.today), open: layout[record.meta.id]?.open !== false }))
      .filter(({ record, anchor, open }) => (args.includeClosed || open)
        && (!args.from || anchor.date >= args.from) && (!args.to || anchor.date <= args.to)
        && (!args.taskId || anchor.taskId === args.taskId || anchor.parentId === args.taskId)
        && (!query || record.text.toLowerCase().includes(query)))
      .sort((a, b) => a.anchor.date.localeCompare(b.anchor.date) || a.record.meta.path.localeCompare(b.record.meta.path));
    const page = items.slice(0, args.limit ?? 50);
    return operationOutputSchemas.N01.parse({ schemaVersion: 1, resultKind: "read", today: snapshot.today, timezone: snapshot.timezone, snapshotRevision: snapshot.revision, errors: [],
      data: { kind: "memos", items: page.map(({ record, anchor, open }) => ({ memoId: record.meta.id, text: record.text, open, revision: record.revision,
        anchor: { kind: anchor.kind, ...(anchor.taskId ? { taskId: anchor.taskId, ...(anchor.taskName ? { taskName: anchor.taskName } : {}) } : {}), date: anchor.date } })),
        totalMatched: items.length, returned: page.length, truncated: page.length < items.length, nextCursor: null } }) as MemoReadResultV1;
  }
}

/** The task a memo is placed on and the date, checked against what the bar can hold. `taskId` empty = the 「その他」 row. */
function placement(snapshot: TaskSnapshot, taskId: string | undefined, date: string | undefined, fallbackDate: string): { task?: TaskRow; date: string } {
  if (!taskId) return { date: date ?? fallbackDate };
  const task = findTask(snapshot, taskId);
  if (task.kind === "parent") return { task, date: date ?? fallbackDate };
  const start = task.plannedStartDate;
  if (!start) fail("INVALID_INPUT", "予定日のない子タスクにはメモを付けられません。日程を設定するか、親タスク・その他に付けてください。", "taskId");
  const end = task.plannedEndDate && task.plannedEndDate >= start ? task.plannedEndDate : start;
  if (date !== undefined && (date < start || date > end)) fail("INVALID_INPUT", `dateは子タスクの期間内（${start}〜${end}）にしてください。`, "date");
  return { task, date: date ?? (fallbackDate < start ? start : fallbackDate > end ? end : fallbackDate) };
}

function findRecord(snapshot: TaskSnapshot, memoId: string, expectedRevision: string): MemoRecord {
  const record = memoRecords(snapshot).find((item) => item.meta.id === memoId);
  if (!record) fail("NOT_FOUND", "memoIdを一覧から取得し直してください。", "memoId");
  if (record.revision !== expectedRevision) fail("REVISION_CONFLICT", "メモが変更されています。N01で再取得してください。", "expectedRevision");
  return record;
}

export function memoPlan(id: MemoWriteId, input: OperationInputMap[MemoWriteId], snapshot: TaskSnapshot, vault: VaultAdapter): MemoPlan {
  const args = operationInputSchemas[id].parse(input) as OperationInputMap["N02"] & OperationInputMap["N03"] & OperationInputMap["N04"] & OperationInputMap["N05"];
  const rows = rowMap(snapshot), today = snapshot.today;
  if (id === "N02") {
    const target = placement(snapshot, args.taskId, args.date, today);
    const { meta, content } = newMemoNote(vault, snapshot.settings, { text: args.text, task: target.task, date: target.date });
    const anchor = { taskId: target.task?.id, taskName: target.task ? target.task.displayName || target.task.title : undefined, date: target.date };
    return { entries: [{ entity: { kind: "memo", memoId: meta.id }, displayName: memoHeadline(args.text), effects: [{ kind: "memo", before: null, after: stateOf(memoBody(content), anchor, args.open === false ? false : undefined) }] }],
      writes: [{ path: meta.path, before: null, after: content, entry: 0 }], ...(args.open === false ? { closed: meta.id } : {}) };
  }
  const record = findRecord(snapshot, (args as { memoId: string }).memoId, (args as { expectedRevision: string }).expectedRevision), anchor = anchorOf(record, rows, today);
  const before = stateOf(record.text, anchor);
  if (id === "N05") return { entries: [{ entity: { kind: "memo", memoId: record.meta.id }, displayName: memoHeadline(record.text), effects: [{ kind: "memo", before, after: null }] }], writes: [{ path: record.meta.path, before: record.content, after: null, entry: 0 }] };
  let after: string, afterState: MemoStateV1;
  if (id === "N03") {
    after = replaceMemoBody(record.content, args.text, today);
    afterState = stateOf(memoBody(after), anchor);
  } else {
    // An omitted taskId keeps the current task (a memo whose task is gone stays on the 「その他」 row); "" moves it there.
    const taskId = args.taskId === undefined ? anchor.taskId : args.taskId;
    const target = placement(snapshot, taskId, args.date, anchor.date);
    const fields = memoAnchorFields(target.task, target.date);
    after = replaceMemoAnchor(record.content, fields, today, stringifyYaml);
    afterState = stateOf(record.text, { taskId: target.task?.id, taskName: target.task ? target.task.displayName || target.task.title : undefined, date: target.date });
  }
  const changed = after !== record.content;
  return { entries: [{ entity: { kind: "memo", memoId: record.meta.id }, displayName: memoHeadline(afterState.text), effects: [{ kind: "memo", before, after: afterState }] }],
    writes: changed ? [{ path: record.meta.path, before: record.content, after, entry: 0 }] : [] };
}

/** Called only after approval, inside the shared coordinator. `saved` runs after each note so partial outcomes stay exact. */
export async function executeMemoPlan(plan: MemoPlan, vault: VaultAdapter, saved: (write: MemoFileWrite) => void, signal?: AbortSignal): Promise<void> {
  const check = (current: string | null, expected: string | null) => {
    if (signal?.aborted) fail("POLICY_DENIED", "メモの保存を停止しました。");
    if (current !== expected) fail("REVISION_CONFLICT", "メモが変更されました。再プレビューしてください。");
  };
  for (const write of plan.writes) {
    const file = vault.getFileByPath(write.path);
    check(file ? await vault.read(file) : null, write.before);
    if (write.before === null) {
      const created = await vault.create(write.path, write.after!);
      await vault.afterWrite(created, true);
    } else if (!file) fail("REVISION_CONFLICT", "メモが削除されました。");
    else if (write.after === null) await vault.trash(file);
    else {
      if (vault.process) await vault.process(file, (current) => { check(current, write.before); return write.after!; });
      else await vault.modify(file, write.after);
      await vault.afterWrite(file, true);
    }
    saved(write);
  }
}
