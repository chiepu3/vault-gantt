import { applyFrontmatterChanges, diffFrontmatter, managedFrontmatter, replaceSections, type Frontmatter } from "../core/note-v2";
import type { TaskRow } from "../core/types";
import type { NoteVault } from "./note-vault";

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
    const fm = diffFrontmatter(managedFrontmatter(old), managedFrontmatter(row));
    const sections: NoteChange["sections"] = {};
    if ((old.currentStatus ?? "").trim() !== (row.currentStatus ?? "").trim()) sections.currentStatus = row.currentStatus ?? "";
    if ((old.notes ?? "").trim() !== (row.notes ?? "").trim()) sections.notes = row.notes ?? "";
    const hasSections = Object.keys(sections).length > 0;
    if (!Object.keys(fm).length && !hasSections) continue;
    changes.push({
      kind: "update", path: old.file.path, taskId: row.id,
      ...(Object.keys(fm).length ? { fm } : {}), ...(hasSections ? { sections } : {}),
      ...((old.displayName || old.title) !== (row.displayName || row.title) ? { title: row.displayName || row.title } : {}),
    });
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
