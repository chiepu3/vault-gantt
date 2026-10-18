import { datePrefixOf, MAX_FILE_STEM, parentFileStem, sanitizeFileStem, uniqueFileStem } from "../core/file-names";
import { applyFrontmatterChanges, bodiesOfRow, diffFrontmatter, managedFrontmatter, newNoteFrontmatter, parseNote, replaceSections, type Frontmatter } from "../core/note-v2";
import type { TaskRow, TaskWorkbenchSettings } from "../core/types";
import type { VaultAdapter as NoteVault } from "./task-operations";

/** One note's worth of change, derived by comparing the rows before and after an edit. */
export interface NoteChange {
  kind: "update" | "create" | "delete";
  /** The note's path when the change is made (for a create: the path to create). */
  path: string;
  taskId: string;
  /** update: frontmatter keys to change; `undefined` removes the key. Nothing else in the frontmatter is touched. */
  fm?: Frontmatter;
  /** update: body sections to replace. The rest of the body stays as it is. */
  sections?: { currentStatus?: string; notes?: string };
  /** create: complete note text. */
  content?: string;
  /** update: the new title, when it changed (the file name follows it). */
  title?: string;
}

/** What actually happened to one note, as the history needs it. null = the note did not exist (before) / does not exist (after). */
export interface AppliedNote {
  path: string;
  before: string | null;
  after: string | null;
  /** Where the note lives afterwards, when it was renamed. */
  afterPath?: string;
  /** Other notes the rename moved or fixed (a parent's subtasks, links in siblings). */
  extra?: AppliedNote[];
}

/** The note itself plus whatever its rename changed, as history entries. */
export const flattenApplied = (applied: AppliedNote): AppliedNote[] => [applied, ...applied.extra ?? []];

/**
 * Subtask changes go before parent title changes: a parent rename moves its subtasks' folder,
 * which would leave the paths of later subtask changes stale.
 */
export function byApplyOrder<T>(items: readonly T[], change: (item: T) => NoteChange): T[] {
  const rank = (item: T): number => { const c = change(item); return c.kind === "update" && c.taskId.startsWith("t-") ? 1 : 0; };
  return items.map((item, index) => ({ item, index })).sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index).map(({ item }) => item);
}

/** One history entry per note: a note that was edited and then moved (or moved twice) keeps its first path and last state. */
export function mergeApplied(list: readonly AppliedNote[]): AppliedNote[] {
  const merged: AppliedNote[] = [];
  for (const note of list) {
    const earlier = merged.find((item) => (item.afterPath ?? item.path) === note.path && item.after !== null);
    if (!earlier) { merged.push({ ...note }); continue; }
    earlier.after = note.after;
    if (note.afterPath !== undefined) earlier.afterPath = note.afterPath;
    if (earlier.afterPath === earlier.path) delete earlier.afterPath;
  }
  return merged;
}

let notifier: (message: string) => void = () => {};
/** Where rename problems are shown to the user (main.ts wires this to a Notice). */
export function setNoteNotifier(fn: (message: string) => void): void { notifier = fn; }

const dirOf = (path: string): string => path.slice(0, path.lastIndexOf("/") + 1);
const stemOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A v2 note that has v1 keys again (an old plugin version or a sync wrote it): saving would mix two formats. */
export class LegacyWriteError extends Error {
  constructor(readonly path: string) { super(`v1 形式の書き込みを検出したため保存を中止しました: ${path}`); }
}

export class NoteConflictError extends Error {
  readonly code = "REVISION_CONFLICT";
  constructor(readonly path: string) { super(`Revision conflict on ${path}`); }
}

const flat = (parents: readonly TaskRow[]): { row: TaskRow; parent?: TaskRow }[] =>
  parents.flatMap((parent) => [{ row: parent }, ...[...parent.subtasks?.values() ?? []].map((row) => ({ row, parent }))]);

/** The change that turns `old` into `row` (same task), or null when the note would stay as it is. */
export function diffRow(old: TaskRow, row: TaskRow): NoteChange | null {
  const fm = diffFrontmatter(managedFrontmatter(old), managedFrontmatter(row));
  const sections: NonNullable<NoteChange["sections"]> = {};
  if ((old.currentStatus ?? "").trim() !== (row.currentStatus ?? "").trim()) sections.currentStatus = row.currentStatus ?? "";
  if ((old.notes ?? "").trim() !== (row.notes ?? "").trim()) sections.notes = row.notes ?? "";
  const hasFm = Object.keys(fm).length > 0, hasSections = Object.keys(sections).length > 0;
  if (!hasFm && !hasSections) return null;
  return {
    kind: "update", path: old.file.path, taskId: row.id,
    ...(hasFm ? { fm } : {}), ...(hasSections ? { sections } : {}),
    ...((old.displayName || old.title) !== (row.displayName || row.title) ? { title: row.displayName || row.title } : {}),
  };
}

/**
 * Compares two row trees and lists the note changes that turn the first into the second.
 * Only managed keys that differ are listed; a subtask edit never produces a change for its parent.
 * `createText` renders the whole text of a note that does not exist yet.
 */
export function diffTasks(before: readonly TaskRow[], after: readonly TaskRow[], createText: (row: TaskRow, parent?: TaskRow) => string): NoteChange[] {
  const prior = new Map(flat(before).map(({ row }) => [row.id, row] as const));
  const next = new Map(flat(after).map(({ row }) => [row.id, row] as const));
  const changes: NoteChange[] = [];
  for (const { row, parent } of flat(after)) {
    const old = prior.get(row.id);
    if (!old) {
      changes.push({ kind: "create", path: row.file.path, taskId: row.id, content: createText(row, parent) });
      continue;
    }
    const change = diffRow(old, row);
    if (change) changes.push(change);
  }
  for (const { row } of flat(before)) {
    if (row.kind === "subtask" && !next.has(row.id)) changes.push({ kind: "delete", path: row.file.path, taskId: row.id });
  }
  return changes;
}

/** Applies one change. `expectedBefore` (the note text the plan was made from) guards against edits made in between. */
export async function applyNoteChange(vault: NoteVault, change: NoteChange, expectedBefore?: string | null): Promise<AppliedNote> {
  const file = vault.getFileByPath(change.path);
  if (change.kind === "create") {
    if (file) throw new NoteConflictError(change.path);
    const created = await vault.create(change.path, change.content ?? "");
    await vault.afterWrite(created, true);
    return { path: change.path, before: null, after: change.content ?? "" };
  }
  if (!file) throw new NoteConflictError(change.path);
  const before = await vault.read(file);
  if (expectedBefore !== undefined && expectedBefore !== before) throw new NoteConflictError(change.path);
  if (change.kind === "delete") {
    await vault.trash(file);
    return { path: change.path, before, after: null };
  }
  const present = vault.getFrontmatter(file);
  if (present && Object.keys(present).some((key) => key.startsWith("subtask__") || key === "subtaskOrder")) {
    notifier(`${stemOf(change.path)} に v1 形式の書き込みが見つかりました。保存を止めました。古いバージョンのプラグインや同期が原因の可能性があります。「ノート形式を v2 に変換」を実行してください。`);
    throw new LegacyWriteError(change.path);
  }
  if (change.fm && Object.keys(change.fm).length) {
    await vault.processFrontMatter(file, (fm) => applyFrontmatterChanges(fm, change.fm!));
  }
  if (change.sections) {
    const sections = change.sections;
    if (vault.process) await vault.process(file, (content) => replaceSections(content, sections));
    else await vault.modify(file, replaceSections(await vault.read(file), sections));
  }
  let after = await vault.read(file);
  await vault.afterWrite(file, after !== before);
  const applied: AppliedNote = { path: change.path, before, after };
  if (change.title !== undefined) {
    try {
      const moved = await renameForTitle(vault, change, change.title);
      if (moved) {
        applied.afterPath = moved.path;
        applied.extra = moved.extra;
        after = await vault.read(vault.getFileByPath(moved.path) ?? file);
        applied.after = after;
      }
    } catch (error) {
      // The title and data are saved; only the file name stays as it was.
      notifier(`ファイル名を変更できませんでした(${stemOf(change.path)}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return applied;
}

/** The stem a note should have for its title. A parent keeps the date prefix it already has. */
export function wantedStem(path: string, taskId: string, title: string): string {
  const stem = stemOf(path);
  if (!taskId.startsWith("t-")) return sanitizeFileStem(title);
  const prefix = datePrefixOf(stem);
  return prefix ? parentFileStem(title, prefix, true) : sanitizeFileStem(title, MAX_FILE_STEM);
}

async function renameForTitle(vault: NoteVault, change: NoteChange, title: string): Promise<{ path: string; extra: AppliedNote[] } | null> {
  const dir = dirOf(change.path), stem = stemOf(change.path), isParent = change.taskId.startsWith("t-");
  const all = vault.getFiles();
  const taken = (candidate: string): boolean => {
    const path = `${dir}${candidate}.md`;
    if (path === change.path) return false;
    const lower = path.toLowerCase();
    return all.some((f) => f.path.toLowerCase() === lower || (isParent && f.path.toLowerCase().startsWith(`${dir}${candidate}/`.toLowerCase())));
  };
  const next = uniqueFileStem(wantedStem(change.path, change.taskId, title), taken);
  if (next === stem) return null;
  const newPath = `${dir}${next}.md`;
  const subs = isParent ? all.filter((f) => f.path.startsWith(`${dir}${stem}/`)) : [];
  const subBefore = new Map<string, string>();
  for (const sub of subs) subBefore.set(sub.path, await vault.read(sub));

  await vault.rename(change.path, newPath);
  if (subs.length) {
    try { await vault.rename(`${dir}${stem}`, `${dir}${next}`); }
    catch (error) {
      try { await vault.rename(newPath, change.path); } catch { /* the original error is the one to report */ }
      throw error;
    }
  }

  const extra: AppliedNote[] = [];
  const fixLinks = async (path: string, key: "parent" | "dependsOn"): Promise<void> => {
    const file = vault.getFileByPath(path);
    if (!file) return;
    const text = await vault.read(file);
    if (!text.includes(`[[${stem}]]`) && !text.includes(`[[${stem}|`)) return;
    const swap = (value: unknown): unknown => typeof value === "string" ? value.replace(new RegExp(`\\[\\[${escapeRe(stem)}(\\||\\]\\])`), (_m, tail: string) => `[[${next}${tail}`) : value;
    await vault.processFrontMatter(file, (fm) => { fm[key] = Array.isArray(fm[key]) ? (fm[key] as unknown[]).map(swap) : swap(fm[key]); });
    await vault.afterWrite(file, true);
    const fixed = await vault.read(file);
    if (key === "dependsOn") extra.push({ path, before: text, after: fixed });
  };
  for (const sub of subs) {
    const to = `${dir}${next}/${sub.path.slice(`${dir}${stem}/`.length)}`;
    await fixLinks(to, "parent");
    const moved = vault.getFileByPath(to);
    extra.push({ path: sub.path, before: subBefore.get(sub.path)!, after: moved ? await vault.read(moved) : subBefore.get(sub.path)!, afterPath: to });
  }
  if (!isParent) {
    for (const sibling of vault.getFiles()) if (sibling.path !== newPath && dirOf(sibling.path) === dir && sibling.path.endsWith(".md")) await fixLinks(sibling.path, "dependsOn");
  }
  await vault.afterWrite(vault.getFileByPath(newPath) ?? { path: newPath }, true);
  return { path: newPath, extra };
}

/**
 * Serializes a row the way a note stores it and reads it back. What differs from the original is
 * what the format cannot hold, so callers refuse to save such an edit instead of losing data.
 */
export function roundTripRow(row: TaskRow, settings: Pick<TaskWorkbenchSettings, "autoPriorityEnabled">): TaskRow | null {
  const fm = newNoteFrontmatter(row, row.kind === "subtask" ? { parentLink: "[[parent]]" } : {});
  const parsed = parseNote({ path: row.file.path }, fm, bodiesOfRow(row), settings);
  if (!parsed) return null;
  parsed.row.file = row.file;
  if (row.parentId) parsed.row.parentId = row.parentId;
  if (row.kind === "parent") parsed.row.subtasks = row.subtasks;
  return parsed.row;
}
