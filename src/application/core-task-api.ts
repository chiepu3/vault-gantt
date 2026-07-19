/**
 * Core Task API - application service for task note operations.
 * Coordinates parsing, validation, persistence, notifications, and undo.
 *
 * All methods that touch the vault are async: the real Obsidian VaultAdapterPort
 * implementation wraps Promise-based APIs (processFrontMatter/vault.create/vault.delete).
 * Mutating calls (createTask/updateTaskItemsBatch/deleteTask/undo) are serialized
 * through an internal queue so that one call's "validate everything, then write
 * everything" two-phase logic can never interleave with another call on the same
 * CoreTaskAPI instance — that's the guarantee revision-conflict checking here is
 * built on top of.
 */

import type { TaskNote, Subtask } from '../domain/task-note/types';
import { parseTaskNote } from '../domain/task-note/parser';
import { serializeTaskNoteFrontmatter, serializeTaskNoteBody } from '../domain/task-note/serializer';
import { resolveCompletedStatusSync } from '../domain/status';
import { calculateAutoPriority } from '../domain/priority';
import type { VaultAdapterPort } from './ports';
import { UndoStack, type UndoInversePatch } from './undo-stack';
import type { ChangeEvent } from './change-notifier';
import { ChangeNotifier } from './change-notifier';
import { isRevisionConflict } from './revision';
import { validateParentPatch, validateSubtaskPatch } from './patch-validation';

export interface CreateTaskInput {
  displayName: string;
  dueDate?: string | null;
  tags?: string[];
}

export interface TaskPatch {
  path: string;
  expectedRevision: string;
  parent?: Record<string, unknown>;
  subtasks?: { key: string; fields: Record<string, unknown> }[];
  /** `createdAt` is optional and normally omitted (defaults to today); undo uses it
   * to restore a deleted subtask's original creation date instead of stamping "today". */
  newSubtasks?: { key: string; title: string; createdAt?: string }[];
  deleteSubtaskKeys?: string[];
}

export interface TaskRecord {
  path: string;
  revision: string;
  note: TaskNote;
}

export type ApiError =
  | { code: 'VALIDATION_ERROR'; errors: string[] }
  | { code: 'REVISION_CONFLICT'; path: string; currentRevision: string }
  | { code: 'NOT_FOUND'; path: string };

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

/**
 * Patchable field whitelists (matching the validation module).
 */
const PARENT_PATCHABLE_FIELDS = new Set([
  'displayName',
  'statusLabel',
  'dueDate',
  'priority',
  'priorityMode',
  'tags',
  'completed',
  'ganttEnabled',
  'ganttOrder',
  'currentStatus',
  'notes',
  'subtaskOrder',
]);

const SUBTASK_PATCHABLE_FIELDS = new Set([
  'title',
  'statusLabel',
  'dueDate',
  'plannedStartDate',
  'plannedEndDate',
  'workloadPlan',
  'workloadActual',
  'priority',
  'priorityMode',
  'tags',
  'completed',
  'markers',
  'currentStatus',
  'notes',
]);

/** Deep clone a TaskNote to avoid mutating cached values. */
function cloneTaskNote(note: TaskNote): TaskNote {
  return {
    ...note,
    tags: [...note.tags],
    subtaskOrder: [...note.subtaskOrder],
    subtasks: note.subtasks.map(cloneSubtask),
  };
}

/** Deep clone a Subtask. */
function cloneSubtask(st: Subtask): Subtask {
  return {
    ...st,
    tags: [...st.tags],
    markers: st.markers.map((m) => ({ ...m, tags: [...m.tags] })),
    workloadPlan: { ...st.workloadPlan },
    workloadActual: { ...st.workloadActual },
  };
}

/**
 * Apply auto-priority projection to a note and its subtasks.
 * Returns a modified copy; does not mutate the input, and the projected value
 * is never persisted back to the file — it's a read-time-only replacement for
 * the legacy daily-batch recompute job.
 */
function applyAutoPriorityProjection(note: TaskNote, today: string): TaskNote {
  const projected = cloneTaskNote(note);

  if (projected.priorityMode === 'auto') {
    projected.priority = calculateAutoPriority(projected.dueDate, today);
  }

  for (const st of projected.subtasks) {
    if (st.priorityMode === 'auto') {
      st.priority = calculateAutoPriority(st.dueDate, today);
    }
  }

  return projected;
}

export class CoreTaskAPI {
  private vaultAdapter: VaultAdapterPort;
  private parseCache: Map<string, { revision: string; note: TaskNote }>;
  private undoStack: UndoStack;
  private changeNotifier: ChangeNotifier;
  private now: () => string;
  private taskFolder: string;
  /** Serializes mutating calls so their validate-then-write phases never interleave. */
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(
    vaultAdapter: VaultAdapterPort,
    options?: { undoStack?: UndoStack; notifier?: ChangeNotifier; now?: () => string; taskFolder?: string }
  ) {
    this.vaultAdapter = vaultAdapter;
    this.parseCache = new Map();
    this.undoStack = options?.undoStack ?? new UndoStack();
    this.changeNotifier = options?.notifier ?? new ChangeNotifier();
    this.now = options?.now ?? (() => new Date().toISOString().slice(0, 10));
    this.taskFolder = options?.taskFolder ?? 'tasks';
  }

  /** Update the folder used for new task file paths (called when settings change). */
  setTaskFolder(folder: string): void {
    this.taskFolder = folder.trim() || 'tasks';
  }

  /** Run `fn` after every previously-enqueued mutation has settled. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(fn, fn);
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * List all tasks in the vault.
   * Skips files that were deleted concurrently or fail to parse.
   */
  async listTasks(): Promise<TaskRecord[]> {
    const results: TaskRecord[] = [];
    const paths = this.vaultAdapter.listTaskFilePaths();
    const today = this.now();

    for (const path of paths) {
      const record = await this.vaultAdapter.readTaskFile(path);
      if (!record) continue;

      const note = await this.resolveNote(path, record);
      if (!note) continue;

      results.push({
        path,
        revision: record.revision,
        note: applyAutoPriorityProjection(note, today),
      });
    }

    return results;
  }

  /**
   * Get a single task by path.
   * Returns null if not found or fails to parse.
   */
  async getTask(path: string): Promise<TaskRecord | null> {
    const record = await this.vaultAdapter.readTaskFile(path);
    if (!record) return null;

    const note = await this.resolveNote(path, record);
    if (!note) return null;

    const today = this.now();
    return {
      path,
      revision: record.revision,
      note: applyAutoPriorityProjection(note, today),
    };
  }

  /** Parse-cache-aware note resolution shared by listTasks/getTask. */
  private async resolveNote(
    path: string,
    record: { frontmatter: Record<string, unknown>; body: string; revision: string }
  ): Promise<TaskNote | null> {
    const cached = this.parseCache.get(path);
    if (cached && cached.revision === record.revision) {
      return cached.note;
    }
    const parseResult = parseTaskNote(record.frontmatter, record.body);
    if (!parseResult.ok) return null;
    this.parseCache.set(path, { revision: record.revision, note: parseResult.note });
    return parseResult.note;
  }

  /** Create a new task. */
  createTask(input: CreateTaskInput): Promise<ApiResult<TaskRecord>> {
    return this.enqueue(() => this.doCreateTask(input));
  }

  private async doCreateTask(input: CreateTaskInput): Promise<ApiResult<TaskRecord>> {
    // displayName/dueDate/tags are all parent-patchable fields, so the same whitelist
    // validator that guards updateTaskItem also guards task creation input.
    const fieldsToValidate: Record<string, unknown> = { displayName: input.displayName };
    if (input.dueDate !== undefined) fieldsToValidate.dueDate = input.dueDate;
    if (input.tags !== undefined) fieldsToValidate.tags = input.tags;
    const validation = validateParentPatch(fieldsToValidate);
    if (!validation.ok) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', errors: validation.errors } };
    }

    const today = this.now();

    // Path scheme: <taskFolder>/<slugified displayName>-<random suffix>.md
    const slug =
      input.displayName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'task';
    const suffix = Math.random().toString(36).slice(2, 8);
    const path = `${this.taskFolder}/${slug}-${suffix}.md`;

    const note: TaskNote = {
      displayName: input.displayName,
      statusLabel: 'active',
      createdAt: today,
      updatedAt: today,
      dueDate: input.dueDate ?? null,
      priority: 0,
      priorityMode: 'auto',
      tags: input.tags ?? [],
      completed: false,
      ganttEnabled: true,
      ganttOrder: 0,
      subtaskOrder: [],
      subtasks: [],
      currentStatus: '',
      notes: '',
    };

    const frontmatter = serializeTaskNoteFrontmatter(note);
    const body = serializeTaskNoteBody(note);

    // createTaskFile has no ApiResult-shaped failure case (VaultAdapterPort just
    // returns Promise<TaskFileRecord>): the real Obsidian adapter's vault.create()
    // throws if the generated path already exists. That's astronomically unlikely
    // given the random suffix, but must still surface as a normal error result
    // rather than an uncaught rejection reaching UI/agent callers.
    let record;
    try {
      record = await this.vaultAdapter.createTaskFile(path, frontmatter, body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: { code: 'VALIDATION_ERROR', errors: [`Failed to create task file at "${path}": ${message}`] },
      };
    }

    this.parseCache.set(path, { revision: record.revision, note });
    this.undoStack.push({ deletedPaths: [path] });
    this.changeNotifier.notify({ type: 'created', path });

    const projected = applyAutoPriorityProjection(note, today);
    return { ok: true, value: { path, revision: record.revision, note: projected } };
  }

  /** Update a task via a single patch. */
  async updateTaskItem(patch: TaskPatch): Promise<ApiResult<TaskRecord>> {
    const result = await this.updateTaskItemsBatch([patch]);
    return result.ok ? { ok: true, value: result.value[0] } : result;
  }

  /**
   * Update multiple tasks in a batch.
   * Validates everything first, then applies mutations, then writes.
   */
  updateTaskItemsBatch(patches: TaskPatch[]): Promise<ApiResult<TaskRecord[]>> {
    return this.enqueue(() => this.doUpdateTaskItemsBatch(patches));
  }

  private async doUpdateTaskItemsBatch(patches: TaskPatch[]): Promise<ApiResult<TaskRecord[]>> {
    const today = this.now();

    // Group patches by path.
    const groupsByPath = new Map<string, TaskPatch[]>();
    for (const patch of patches) {
      const group = groupsByPath.get(patch.path);
      if (group) {
        group.push(patch);
      } else {
        groupsByPath.set(patch.path, [patch]);
      }
    }

    // All patches for the same path must share one expectedRevision.
    for (const [path, pathPatches] of groupsByPath) {
      const firstRev = pathPatches[0].expectedRevision;
      if (pathPatches.some((p) => p.expectedRevision !== firstRev)) {
        return {
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            errors: [`All patches for path "${path}" in a single batch call must share the same expectedRevision`],
          },
        };
      }
    }

    // Read, check revision, parse, and validate every path before writing anything.
    const fileRecords = new Map<string, { frontmatter: Record<string, unknown>; body: string; revision: string }>();
    const parsedNotes = new Map<string, TaskNote>();
    const allValidationErrors: string[] = [];

    for (const [path, pathPatches] of groupsByPath) {
      const record = await this.vaultAdapter.readTaskFile(path);
      if (!record) {
        return { ok: false, error: { code: 'NOT_FOUND', path } };
      }

      const expectedRevision = pathPatches[0].expectedRevision;
      if (isRevisionConflict(expectedRevision, record.revision)) {
        return {
          ok: false,
          error: { code: 'REVISION_CONFLICT', path, currentRevision: record.revision },
        };
      }

      const parseResult = parseTaskNote(record.frontmatter, record.body);
      if (!parseResult.ok) {
        return { ok: false, error: { code: 'NOT_FOUND', path } };
      }

      fileRecords.set(path, record);
      parsedNotes.set(path, parseResult.note);

      // Key bookkeeping accumulates across every TaskPatch object in this path's
      // group (a batch call may legitimately send several patches for the same
      // path — see the expectedRevision-sharing check above), not just within one
      // patch object, so a key created by an earlier patch in the group is
      // recognized as valid by a later patch in the same group.
      const existingKeys = new Set(parseResult.note.subtasks.map((s) => s.key));
      const keysAddedInGroup = new Set<string>();

      for (const patch of pathPatches) {
        if (patch.parent) {
          const parentValidation = validateParentPatch(patch.parent);
          if (!parentValidation.ok) allValidationErrors.push(...parentValidation.errors);
        }

        if (patch.newSubtasks) {
          for (const { key } of patch.newSubtasks) {
            if (keysAddedInGroup.has(key)) {
              allValidationErrors.push(`Duplicate new subtask key "${key}" on ${path}`);
            } else if (existingKeys.has(key)) {
              allValidationErrors.push(`New subtask key "${key}" already exists on ${path}`);
            } else {
              keysAddedInGroup.add(key);
            }
          }
        }

        if (patch.subtasks) {
          for (const st of patch.subtasks) {
            const stValidation = validateSubtaskPatch(st.fields);
            if (!stValidation.ok) allValidationErrors.push(...stValidation.errors);

            if (!existingKeys.has(st.key) && !keysAddedInGroup.has(st.key)) {
              allValidationErrors.push(`Subtask key "${st.key}" not found on ${path}`);
            }
          }
        }

        if (patch.deleteSubtaskKeys) {
          for (const key of patch.deleteSubtaskKeys) {
            if (!existingKeys.has(key) && !keysAddedInGroup.has(key)) {
              allValidationErrors.push(`Subtask key "${key}" not found on ${path}`);
            }
          }
        }
      }
    }

    if (allValidationErrors.length > 0) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', errors: allValidationErrors } };
    }

    // Apply mutations and write. Writes happen one path at a time; if a later path's
    // write fails (a genuine race against an external writer), the earlier writes in
    // this same call already landed on disk and must not be silently forgotten — we
    // still bank their undo entry and notifications before reporting the failure.
    const succeeded: { path: string; inversePatch: UndoInversePatch; record: TaskRecord }[] = [];
    let writeFailure: ApiError | null = null;

    for (const [path, pathPatches] of groupsByPath) {
      const record = fileRecords.get(path)!;
      const parsedNote = parsedNotes.get(path)!;
      const workingNote = cloneTaskNote(parsedNote);

      const originalSubtaskOrder = [...workingNote.subtaskOrder];
      const originalSubtasks = workingNote.subtasks.map(cloneSubtask);

      let parentTouched = false;
      let subtasksAddedOrDeleted = false;

      for (const patch of pathPatches) {
        if (patch.parent) {
          parentTouched = true;
          const parentClone = { ...patch.parent };
          applyCompletedStatusSync(parentClone);
          Object.assign(workingNote, parentClone);
        }

        // newSubtasks runs before subtasks[] field-patches so a combined patch can
        // create a subtask and immediately set its fields in one call (this is also
        // how undoing a subtask deletion restores the deleted subtask's full state:
        // the inverse patch pairs a `newSubtasks` recreate with a `subtasks` field
        // patch for that same key).
        if (patch.newSubtasks) {
          subtasksAddedOrDeleted = true;
          for (const { key, title, createdAt } of patch.newSubtasks) {
            workingNote.subtaskOrder.push(key);
            workingNote.subtasks.push(makeDefaultSubtask(key, title, today, createdAt));
          }
        }

        if (patch.subtasks) {
          for (const stPatch of patch.subtasks) {
            const subtask = workingNote.subtasks.find((s) => s.key === stPatch.key);
            if (!subtask) continue;

            const stClone = { ...stPatch.fields };
            applyCompletedStatusSync(stClone);
            normalizeWorkloadDeletions(stClone, 'workloadPlan');
            normalizeWorkloadDeletions(stClone, 'workloadActual');
            Object.assign(subtask, stClone);
            subtask.updatedAt = today;
          }
        }

        if (patch.deleteSubtaskKeys) {
          subtasksAddedOrDeleted = true;
          const toDelete = new Set(patch.deleteSubtaskKeys);
          workingNote.subtasks = workingNote.subtasks.filter((s) => !toDelete.has(s.key));
          workingNote.subtaskOrder = workingNote.subtaskOrder.filter((k) => !toDelete.has(k));
        }
      }

      if (parentTouched || subtasksAddedOrDeleted) {
        workingNote.updatedAt = today;
      }

      const inversePatch = buildInversePatch(
        path,
        pathPatches,
        parsedNote,
        originalSubtaskOrder,
        originalSubtasks,
        parentTouched,
        subtasksAddedOrDeleted
      );

      const frontmatter = serializeTaskNoteFrontmatter(workingNote);
      const body = serializeTaskNoteBody(workingNote);
      const writeResult = await this.vaultAdapter.writeTaskFile(path, frontmatter, body, record.revision);

      if (!writeResult.ok) {
        writeFailure = { code: 'REVISION_CONFLICT', path, currentRevision: writeResult.currentRevision };
        break;
      }

      inversePatch.expectedRevision = writeResult.revision;
      this.parseCache.set(path, { revision: writeResult.revision, note: workingNote });

      const projected = applyAutoPriorityProjection(workingNote, today);
      succeeded.push({
        path,
        inversePatch,
        record: { path, revision: writeResult.revision, note: projected },
      });
    }

    // Bank whatever succeeded before returning (partial or full).
    if (succeeded.length > 0) {
      this.undoStack.push({ inversePatches: succeeded.map((s) => s.inversePatch) });
      for (const s of succeeded) {
        this.changeNotifier.notify({ type: 'updated', path: s.path });
      }
    }

    if (writeFailure) {
      return { ok: false, error: writeFailure };
    }

    return { ok: true, value: succeeded.map((s) => s.record) };
  }

  /** Delete a task by path. */
  deleteTask(path: string, expectedRevision: string): Promise<ApiResult<void>> {
    return this.enqueue(() => this.doDeleteTask(path, expectedRevision));
  }

  private async doDeleteTask(path: string, expectedRevision: string): Promise<ApiResult<void>> {
    const record = await this.vaultAdapter.readTaskFile(path);
    if (!record) {
      return { ok: false, error: { code: 'NOT_FOUND', path } };
    }

    if (isRevisionConflict(expectedRevision, record.revision)) {
      return {
        ok: false,
        error: { code: 'REVISION_CONFLICT', path, currentRevision: record.revision },
      };
    }

    await this.vaultAdapter.deleteTaskFile(path);
    this.parseCache.delete(path);

    this.undoStack.push({
      recreatedFiles: [{ path, frontmatter: record.frontmatter, body: record.body }],
    });

    this.changeNotifier.notify({ type: 'deleted', path });
    return { ok: true, value: undefined };
  }

  /** Undo the most recent operation. */
  undo(): Promise<ApiResult<TaskRecord[] | void>> {
    return this.enqueue(() => this.doUndo());
  }

  private async doUndo(): Promise<ApiResult<TaskRecord[] | void>> {
    const entry = this.undoStack.pop();
    if (!entry) {
      return { ok: true, value: undefined };
    }

    const today = this.now();

    if (entry.deletedPaths) {
      for (const path of entry.deletedPaths) {
        await this.vaultAdapter.deleteTaskFile(path);
        this.parseCache.delete(path);
        this.changeNotifier.notify({ type: 'deleted', path });
      }
      return { ok: true, value: undefined };
    }

    if (entry.recreatedFiles) {
      const results: TaskRecord[] = [];
      for (const file of entry.recreatedFiles) {
        const record = await this.vaultAdapter.createTaskFile(file.path, file.frontmatter, file.body);
        const parseResult = parseTaskNote(record.frontmatter, record.body);
        if (!parseResult.ok) continue;
        this.parseCache.set(file.path, { revision: record.revision, note: parseResult.note });
        results.push({
          path: file.path,
          revision: record.revision,
          note: applyAutoPriorityProjection(parseResult.note, today),
        });
        this.changeNotifier.notify({ type: 'created', path: file.path });
      }
      return { ok: true, value: results };
    }

    if (entry.inversePatches) {
      // doUpdateTaskItemsBatch's own read+revision-check on each affected path
      // (before it writes anything) is exactly the "did anything drift since the
      // original operation" check undo needs — if it has, the call returns
      // REVISION_CONFLICT/NOT_FOUND and this popped entry is simply not re-pushed,
      // i.e. the undo is lost and the caller is told why. Called as the private
      // doUpdateTaskItemsBatch (not the public, self-enqueuing updateTaskItemsBatch)
      // so this runs as part of the current queued undo turn rather than deadlocking
      // on its own enqueue() call, and pushes its own inverse-of-the-inverse entry
      // (i.e. redo material) rather than us re-pushing the popped entry.
      return this.doUpdateTaskItemsBatch(entry.inversePatches);
    }

    return { ok: true, value: undefined };
  }

  /** Subscribe to change notifications. Returns an unsubscribe function. */
  subscribe(listener: (event: ChangeEvent) => void): () => void {
    return this.changeNotifier.subscribe(listener);
  }
}

/** Mutates `fields` in place, applying the completed<->statusLabel sync rule. */
function applyCompletedStatusSync(fields: Record<string, unknown>): void {
  if (!('statusLabel' in fields) && !('completed' in fields)) return;
  const synced = resolveCompletedStatusSync({
    statusLabel: fields.statusLabel as string | undefined,
    completed: fields.completed as boolean | undefined,
  });
  if (synced.statusLabel !== undefined) fields.statusLabel = synced.statusLabel;
  if (synced.completed !== undefined) fields.completed = synced.completed;
}

/** Mutates `fields[field]` in place, dropping any date entry whose value is exactly 0. */
function normalizeWorkloadDeletions(fields: Record<string, unknown>, field: 'workloadPlan' | 'workloadActual'): void {
  const value = fields[field];
  if (typeof value !== 'object' || value === null) return;
  const updated: Record<string, number> = {};
  for (const [dateKey, hours] of Object.entries(value as Record<string, number>)) {
    if (hours !== 0) updated[dateKey] = hours;
  }
  fields[field] = updated;
}

function makeDefaultSubtask(key: string, title: string, today: string, createdAt?: string): Subtask {
  return {
    key,
    title,
    statusLabel: 'active',
    createdAt: createdAt ?? today,
    updatedAt: today,
    dueDate: null,
    plannedStartDate: null,
    plannedEndDate: null,
    workloadPlan: {},
    workloadActual: {},
    priority: 0,
    priorityMode: 'auto',
    tags: [],
    completed: false,
    markers: [],
    currentStatus: '',
    notes: '',
  };
}

/**
 * Build the patch that reverses the given group of patches for one path, capturing
 * pre-modification values from `parsedNote` (the raw, non-auto-priority-projected
 * cached note) so undo never persists a transient projected value.
 */
function buildInversePatch(
  path: string,
  pathPatches: TaskPatch[],
  parsedNote: TaskNote,
  originalSubtaskOrder: string[],
  originalSubtasks: Subtask[],
  parentTouched: boolean,
  subtasksAddedOrDeleted: boolean
): UndoInversePatch {
  const inverseParent: Record<string, unknown> = {};
  if (parentTouched) {
    for (const patch of pathPatches) {
      if (!patch.parent) continue;
      for (const key of Object.keys(patch.parent)) {
        if (PARENT_PATCHABLE_FIELDS.has(key) && !(key in inverseParent)) {
          inverseParent[key] = (parsedNote as unknown as Record<string, unknown>)[key];
        }
      }
    }
  }
  if (subtasksAddedOrDeleted) {
    inverseParent.subtaskOrder = originalSubtaskOrder;
  }

  const inverseSubtasks: { key: string; fields: Record<string, unknown> }[] = [];
  for (const patch of pathPatches) {
    if (!patch.subtasks) continue;
    for (const stPatch of patch.subtasks) {
      const original = originalSubtasks.find((s) => s.key === stPatch.key);
      if (!original) continue;
      const inverseFields: Record<string, unknown> = {};
      for (const key of Object.keys(stPatch.fields)) {
        if (SUBTASK_PATCHABLE_FIELDS.has(key)) {
          inverseFields[key] = (original as unknown as Record<string, unknown>)[key];
        }
      }
      if (Object.keys(inverseFields).length > 0) {
        inverseSubtasks.push({ key: stPatch.key, fields: inverseFields });
      }
    }
  }

  // Reversing a delete = recreate via newSubtasks (with the original createdAt, not
  // the undo's own date) + restore the rest of its field state.
  let inverseNewSubtasks: { key: string; title: string; createdAt?: string }[] | undefined;
  for (const patch of pathPatches) {
    if (!patch.deleteSubtaskKeys) continue;
    inverseNewSubtasks ??= [];
    for (const key of patch.deleteSubtaskKeys) {
      const deleted = originalSubtasks.find((s) => s.key === key);
      if (!deleted) continue;
      inverseNewSubtasks.push({ key: deleted.key, title: deleted.title, createdAt: deleted.createdAt });
      inverseSubtasks.push({
        key: deleted.key,
        fields: {
          statusLabel: deleted.statusLabel,
          dueDate: deleted.dueDate,
          plannedStartDate: deleted.plannedStartDate,
          plannedEndDate: deleted.plannedEndDate,
          workloadPlan: deleted.workloadPlan,
          workloadActual: deleted.workloadActual,
          priority: deleted.priority,
          priorityMode: deleted.priorityMode,
          tags: deleted.tags,
          completed: deleted.completed,
          markers: deleted.markers,
          currentStatus: deleted.currentStatus,
          notes: deleted.notes,
        },
      });
    }
  }

  // Reversing a create-of-a-subtask = delete it again.
  const inverseDeleteSubtaskKeys = pathPatches.flatMap((p) => p.newSubtasks ?? []).map((ns) => ns.key);

  return {
    path,
    expectedRevision: '', // filled in by the caller once the forward write's new revision is known
    parent: Object.keys(inverseParent).length > 0 ? inverseParent : undefined,
    subtasks: inverseSubtasks.length > 0 ? inverseSubtasks : undefined,
    newSubtasks: inverseNewSubtasks,
    deleteSubtaskKeys: inverseDeleteSubtaskKeys.length > 0 ? inverseDeleteSubtaskKeys : undefined,
  };
}
