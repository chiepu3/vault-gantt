import type { Logger } from "../core/logger";
import { parseNote, readSections, noteKindOf, type ParsedNote } from "../core/note-v2";
import { reconcileParentOrder } from "../core/parent-order";
import { sortSubtasks } from "../core/subtask-order";
import type { TaskRow, TaskWorkbenchSettings } from "../core/types";
import { buildFileRevision, todayStr } from "../core/utils";
import { linkTarget, type NoteVault } from "./note-vault";
import type { VaultFile } from "./task-operations";

/** One note's parse result. `taskRow` is a single note (a parent without subtasks yet, or a subtask); null = not a task note. */
export interface NoteCacheEntry { revision: string; taskRow: TaskRow | null; parentLink?: string }
export type TaskCache = Map<string, NoteCacheEntry>;

interface Assembled { source: TaskRow; kids: TaskRow[]; order: string; row: TaskRow }
const attachedTo = new WeakMap<TaskRow, { from: string; parent: string }>();
const assembledByCache = new WeakMap<TaskCache, Map<string, Assembled>>();

export const taskRoot = (settings: Pick<TaskWorkbenchSettings, "taskFolder">): string => settings.taskFolder.replace(/\/$/, "");
export const isUnderRoot = (path: string, root: string): boolean => path.startsWith(root + "/") && path.endsWith(".md");

/** Cache key of a parsed note: the file's stat plus everything else the parse result depends on. */
export function noteRevision(file: VaultFile, settings: Pick<TaskWorkbenchSettings, "autoPriorityEnabled">, today: string): string {
  return `${buildFileRevision(file as Parameters<typeof buildFileRevision>[0])}|${settings.autoPriorityEnabled ? 1 : 0}|${today}`;
}

/**
 * Parses one note from the metadataCache (and its body through cachedRead). Returns undefined while
 * Obsidian has not indexed the file yet; the caller must not cache that.
 */
export async function readNote(vault: NoteVault, file: VaultFile, settings: TaskWorkbenchSettings, content?: string): Promise<{ row: TaskRow; parentLink?: string } | null | undefined> {
  const fm = vault.getFrontmatter(file);
  if (fm === undefined) return undefined;
  if (!noteKindOf(fm)) return null;
  const text = content ?? await vault.cachedRead(file);
  const parsed: ParsedNote | null = parseNote(file, fm, readSections(text), settings);
  return parsed ? { row: parsed.row, parentLink: parsed.parentLink } : null;
}

/** Ids must be unique; a later note with an id that is already taken is left out. */
function dedupe(entries: { path: string; row: TaskRow; parentLink?: string }[], logger?: Logger, problems?: string[]): typeof entries {
  const seen = new Map<string, string>();
  return entries.filter((entry) => {
    const owner = seen.get(entry.row.id);
    if (owner === undefined) { seen.set(entry.row.id, entry.path); return true; }
    logger?.warn("note-store", `duplicate task id ${entry.row.id}: ${entry.path} is ignored (first seen in ${owner})`);
    problems?.push(entry.path);
    return false;
  });
}

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** True when a link target (`Name`, `dir/Name`, with or without `.md`) can only mean the note at `path`. */
function namesNote(target: string, path: string): boolean {
  const note = path.replace(/\.md$/, "");
  const wanted = target.replace(/\.md$/, "");
  return wanted !== "" && (note === wanted || note.endsWith("/" + wanted));
}

/**
 * Builds the parent rows with their subtasks. A subtask belongs to the note its `parent` link
 * resolves to; if the link does not resolve, to a parent note named like the subtask's folder
 * and next to it. Rows of unchanged notes are reused as they are.
 */
export type AssembleMemo = Map<string, Assembled>;
export function assembleTasks(
  vault: NoteVault,
  entries: { path: string; row: TaskRow; parentLink?: string }[],
  settings: TaskWorkbenchSettings,
  memo: Map<string, Assembled>,
  logger?: Logger,
  problems?: string[]
): TaskRow[] {
  const unique = dedupe(entries, logger, problems);
  const parentsByPath = new Map<string, TaskRow>();
  const parents: TaskRow[] = [];
  for (const entry of unique) if (entry.row.kind === "parent") { parentsByPath.set(entry.path, entry.row); parents.push(entry.row); }
  const kidsOf = new Map<string, TaskRow[]>();
  for (const entry of unique) {
    if (entry.row.kind !== "subtask") continue;
    // A subtask row stays the same object until its note changes, so where it was attached last time is reused
    // while that parent still exists. Otherwise: the usual layout keeps a subtask in its parent's folder
    // (`Parent/Sub.md` next to `Parent.md`) with a link naming that parent, which is confirmed by text;
    // anything else goes through link resolution.
    const known = attachedTo.get(entry.row);
    let parentPath: string | undefined = known && known.from === entry.path && parentsByPath.has(known.parent) ? known.parent : undefined;
    const folder = dirname(entry.path);
    const sibling = folder ? `${folder}.md` : undefined;
    if (!parentPath) {
      if (sibling && parentsByPath.has(sibling) && entry.parentLink && namesNote(linkTarget(entry.parentLink), sibling)) parentPath = sibling;
      else {
        parentPath = entry.parentLink ? vault.resolveLink(entry.parentLink, entry.path)?.path : undefined;
        if (!parentPath || !parentsByPath.has(parentPath)) parentPath = sibling;
      }
      if (parentPath && parentsByPath.has(parentPath)) attachedTo.set(entry.row, { from: entry.path, parent: parentPath });
    }
    const parent = parentPath ? parentsByPath.get(parentPath) : undefined;
    if (!parent || !parentPath) {
      logger?.warn("note-store", `subtask ${entry.path} has no parent note (parent: ${entry.parentLink ?? "-"})`);
      problems?.push(entry.path);
      continue;
    }
    const row = entry.row;
    if (row.parentId !== parent.id || row.file.parentPath !== parentPath) {
      row.parentId = parent.id;
      row.file = { ...row.file, parentPath } as TaskRow["file"];
    }
    let list = kidsOf.get(parent.id);
    if (!list) kidsOf.set(parent.id, list = []);
    list.push(row);
  }
  const live = new Set<string>();
  const result = parents.map((source) => {
    live.add(source.id);
    const kids = sortSubtasks(settings, source.id, kidsOf.get(source.id) ?? []);
    const order = kids.map((kid) => kid.id).join("\n");
    const prior = memo.get(source.id);
    if (prior && prior.source === source && prior.order === order && prior.kids.length === kids.length && prior.kids.every((kid, index) => kid === kids[index])) return prior.row;
    const row: TaskRow = { ...source, subtasks: new Map(kids.map((kid) => [kid.id, kid] as const)) };
    memo.set(source.id, { source, kids, order, row });
    return row;
  });
  for (const id of memo.keys()) if (!live.has(id)) memo.delete(id);
  return result;
}

/**
 * Loads every task note under the task folder. Unchanged notes (same mtime:size) are not read or parsed
 * again, so after one edit only that note is re-read. Frontmatter comes from the metadataCache.
 */
export async function loadNoteTasks(
  vault: NoteVault,
  settings: TaskWorkbenchSettings,
  cache: TaskCache,
  logger?: Logger,
  onOrderChanged?: () => void
): Promise<TaskRow[]> {
  const startedAt = Date.now();
  const root = taskRoot(settings), today = todayStr();
  const files = vault.getFiles().filter((file) => isUnderRoot(file.path, root));
  const revisions = new Map<string, string>();
  const stale = files.filter((file) => {
    const revision = noteRevision(file, settings, today);
    revisions.set(file.path, revision);
    return cache.get(file.path)?.revision !== revision;
  });
  const unindexed = stale.filter((file) => vault.getFrontmatter(file) === undefined);
  if (unindexed.length) await vault.whenIndexed(unindexed);
  await Promise.all(stale.map(async (file) => {
    const revision = revisions.get(file.path)!;
    try {
      const note = await readNote(vault, file, settings);
      if (note === undefined) { cache.delete(file.path); return; }
      cache.set(file.path, { revision, taskRow: note?.row ?? null, parentLink: note?.parentLink });
    } catch (error) {
      logger?.error("loadTasks", `Failed to read task note ${file.path}:`, error);
      cache.delete(file.path);
    }
  }));
  const present = new Set(files.map((file) => file.path));
  for (const path of [...cache.keys()]) if (!present.has(path)) cache.delete(path);

  const entries: { path: string; row: TaskRow; parentLink?: string }[] = [];
  for (const file of files) {
    const entry = cache.get(file.path);
    if (entry?.taskRow) entries.push({ path: file.path, row: entry.taskRow, parentLink: entry.parentLink });
  }
  let memo = assembledByCache.get(cache);
  if (!memo) assembledByCache.set(cache, memo = new Map());
  const result = assembleTasks(vault, entries, settings, memo, logger);
  if (reconcileParentOrder(settings, result)) onOrderChanged?.();
  logger?.debug("loadTasks", "load completed", { durationMs: Date.now() - startedAt, fileCount: files.length, taskCount: result.length });
  return result;
}
