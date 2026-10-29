import { stringifyYaml } from "obsidian";
import { generateMemoId } from "../core/ids";
import { uniqueFileStem } from "../core/file-names";
import { MEMO_TEXT_LIMIT, buildMemoNote, memoBody, memoFileStem, memoRoot, normalizeMemoText, replaceMemoBody, type MemoMeta } from "../core/memo";
import type { TaskRow, TaskWorkbenchSettings } from "../core/types";
import { todayStr } from "../core/utils";
import { memoAnchorFields } from "./memo-anchor";
import type { HistoryManager } from "./history-manager";
import type { TaskCache } from "./note-store";
import { collectTaskIds, type VaultAdapter } from "./task-operations";

/** What a memo is attached to. `task` omitted = the 「その他」 row. */
export interface MemoTarget {
  task?: TaskRow;
  /** The day the memo points at; a subtask memo stores it as an offset from the bar's start. */
  date: string;
}

function memoPath(vault: VaultAdapter, settings: TaskWorkbenchSettings, text: string, today: string): string {
  const folder = memoRoot(settings), prefix = `${folder}/`;
  const taken = new Set(vault.getFiles().filter((file) => file.path.startsWith(prefix)).map((file) => file.path.slice(prefix.length).replace(/\.md$/i, "").toLowerCase()));
  return `${prefix}${uniqueFileStem(memoFileStem(text, today), (candidate) => taken.has(candidate.toLowerCase()))}.md`;
}

function checkText(text: string): string {
  const clean = normalizeMemoText(text);
  if (!clean) throw new Error("Memo text cannot be empty");
  if (clean.length > MEMO_TEXT_LIMIT) throw new Error("Memo text is too long");
  return clean;
}

/** Offset stored for a subtask memo; a subtask without a planned start has no bar to follow. */
const anchorFields = (target: MemoTarget): Pick<MemoMeta, "taskId" | "at" | "date"> => memoAnchorFields(target.task, target.date);

/** The memo text, read through the cache (only open memos and hovered pins need it). */
export async function readMemoText(vault: VaultAdapter, meta: Pick<MemoMeta, "path">): Promise<string> {
  const file = vault.getFileByPath(meta.path);
  if (!file) throw new Error("Memo note not found");
  return memoBody(await vault.cachedRead(file));
}

/** The id, path and whole text of a new memo note; nothing is written. */
export function newMemoNote(vault: VaultAdapter, settings: TaskWorkbenchSettings, input: MemoTarget & { text: string }): { meta: MemoMeta; content: string } {
  const text = checkText(input.text), today = todayStr();
  const meta: MemoMeta = { id: generateMemoId(collectTaskIds(vault, settings)), path: memoPath(vault, settings, text, today), ...anchorFields(input), created: today, updated: today };
  const { path: _path, ...fields } = meta; void _path;
  return { meta, content: buildMemoNote(fields, text, stringifyYaml) };
}

/** Creates the memo note `<taskFolder>/_memos/YYYY-MM-DD <first line>.md`. Recorded for undo. */
export async function createMemo(
  vault: VaultAdapter,
  settings: TaskWorkbenchSettings,
  input: MemoTarget & { text: string },
  historyManager?: HistoryManager,
  cache?: TaskCache
): Promise<MemoMeta> {
  const { meta, content } = newMemoNote(vault, settings, input);
  const file = await vault.create(meta.path, content);
  await vault.afterWrite(file, true);
  cache?.delete(meta.path);
  historyManager?.push({ label: "メモ追加", files: [{ path: meta.path, before: null, after: content }] });
  return meta;
}

/** Rewrites the body (and `updated`) of one memo note; nothing else is touched. */
export async function updateMemoText(
  vault: VaultAdapter,
  meta: Pick<MemoMeta, "path">,
  text: string,
  historyManager?: HistoryManager,
  cache?: TaskCache
): Promise<void> {
  const clean = checkText(text);
  const file = vault.getFileByPath(meta.path);
  if (!file) throw new Error("Memo note not found");
  const before = await vault.read(file);
  if (memoBody(before) === clean) return;
  const transform = (content: string) => replaceMemoBody(content, clean, todayStr());
  if (vault.process) await vault.process(file, transform); else await vault.modify(file, transform(before));
  const after = await vault.read(file);
  await vault.afterWrite(file, after !== before);
  cache?.delete(meta.path);
  historyManager?.push({ label: "メモ編集", files: [{ path: meta.path, before, after }] });
}

/** Attaches the memo to another task, or to another day. Only the anchor keys of the frontmatter change. */
export async function reanchorMemo(
  vault: VaultAdapter,
  meta: Pick<MemoMeta, "path">,
  target: MemoTarget,
  historyManager?: HistoryManager,
  cache?: TaskCache
): Promise<void> {
  const fields = anchorFields(target);
  const file = vault.getFileByPath(meta.path);
  if (!file) throw new Error("Memo note not found");
  const before = await vault.read(file);
  await vault.processFrontMatter(file, (fm) => {
    for (const [key, value] of [["task", fields.taskId], ["at", fields.at], ["date", fields.date]] as const) {
      if (value === undefined) delete fm[key]; else fm[key] = value;
    }
    fm.updated = todayStr();
  });
  const after = await vault.read(file);
  await vault.afterWrite(file, after !== before);
  cache?.delete(meta.path);
  historyManager?.push({ label: "メモ移動", files: [{ path: meta.path, before, after }] });
}

/** Moves the memo note to the trash. Recorded for undo. */
export async function deleteMemo(vault: VaultAdapter, meta: Pick<MemoMeta, "path">, historyManager?: HistoryManager, cache?: TaskCache): Promise<void> {
  const file = vault.getFileByPath(meta.path);
  if (!file) throw new Error("Memo note not found");
  const before = await vault.read(file);
  await vault.trash(file);
  cache?.delete(meta.path);
  historyManager?.push({ label: "メモ削除", files: [{ path: meta.path, before, after: null }] });
}
