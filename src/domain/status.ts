/**
 * Status definitions and completed↔statusLabel sync rules.
 * Per CURRENT_SPEC.md §3.2: "done→completed:true、completed:true→done、
 * completed:false→active（statusLabel未指定時）"
 */

/**
 * Definition of a status value.
 */
export interface StatusDefinition {
  key: string;
  label: string;
}

/**
 * Default status definitions.
 */
export const DEFAULT_STATUSES: StatusDefinition[] = [
  { key: 'active', label: '未着手' },
  { key: 'in_progress', label: '進行中' },
  { key: 'waiting', label: '待ち' },
  { key: 'hold', label: '保留' },
  { key: 'done', label: '完了' },
];

/**
 * Partial patch describing updates to a task's completion/status fields.
 * Only fields that are being explicitly set are present.
 */
export interface CompletedStatusPatch {
  statusLabel?: string;
  completed?: boolean;
}

/**
 * Resolve the completed↔statusLabel sync rules for a partial patch.
 *
 * This function models applying a patch to a task note. It does NOT need the
 * prior state of the note — only the fields being set in this operation.
 *
 * Rules applied in precedence order:
 * 1. If patch.statusLabel === 'done' → return patch with completed: true added (keep statusLabel: 'done')
 * 2. Else if patch.completed === true → return patch with statusLabel: 'done' added (keep completed: true)
 * 3. Else if patch.completed === false and patch.statusLabel is undefined
 *    → return patch with statusLabel: 'active' added (keep completed: false)
 * 4. Otherwise, return the patch unchanged
 *
 * @param patch - Partial patch with statusLabel and/or completed fields
 * @returns Updated patch with sync rules applied
 */
export function resolveCompletedStatusSync(
  patch: CompletedStatusPatch
): CompletedStatusPatch {
  // Rule 1: statusLabel === 'done' takes precedence
  if (patch.statusLabel === 'done') {
    return {
      ...patch,
      completed: true,
    };
  }

  // Rule 2: completed === true → statusLabel: 'done'
  if (patch.completed === true) {
    return {
      ...patch,
      statusLabel: 'done',
    };
  }

  // Rule 3: completed === false AND statusLabel is undefined
  if (patch.completed === false && patch.statusLabel === undefined) {
    return {
      ...patch,
      statusLabel: 'active',
    };
  }

  // Rule 4: Otherwise, return unchanged
  return patch;
}
