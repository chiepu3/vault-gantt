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
  if (change.fm && Object.keys(change.fm).length) {
    await vault.processFrontMatter(file, (fm) => applyFrontmatterChanges(fm, change.fm!));
  }
  if (change.sections) {
    const sections = change.sections;
    if (vault.process) await vault.process(file, (content) => replaceSections(content, sections));
    else await vault.modify(file, replaceSections(await vault.read(file), sections));
  }
  const after = await vault.read(file);
  await vault.afterWrite(file, after !== before);
  return { path: change.path, before, after };
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
