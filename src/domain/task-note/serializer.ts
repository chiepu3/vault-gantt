import type { TaskNote, Subtask } from './types';

/**
 * Serializes the structured fields of a TaskNote to a frontmatter object.
 * This object is passed to app.fileManager.processFrontMatter() in Obsidian.
 *
 * Note: currentStatus and notes are NOT included here — they are serialized
 * into the body text only.
 */
export function serializeTaskNoteFrontmatter(note: TaskNote): Record<string, unknown> {
  return {
    type: 'task',
    cssclass: 'vault-gantt-task',
    statusLabel: note.statusLabel,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    dueDate: note.dueDate || null,
    priority: note.priority,
    priorityMode: note.priorityMode,
    tags: note.tags,
    completed: note.completed,
    displayName: note.displayName,
    ganttEnabled: note.ganttEnabled,
    ganttOrder: note.ganttOrder,
    subtaskOrder: note.subtaskOrder,
    subtasks: note.subtasks.map((st) => ({
      key: st.key,
      title: st.title,
      statusLabel: st.statusLabel,
      createdAt: st.createdAt,
      updatedAt: st.updatedAt,
      dueDate: st.dueDate || null,
      plannedStartDate: st.plannedStartDate || null,
      plannedEndDate: st.plannedEndDate || null,
      workloadPlan: st.workloadPlan,
      workloadActual: st.workloadActual,
      priority: st.priority,
      priorityMode: st.priorityMode,
      tags: st.tags,
      completed: st.completed,
      markers: st.markers,
    })),
  };
}

/**
 * Serializes a TaskNote to its body (markdown) representation.
 *
 * The body includes:
 * 1. Title heading
 * 2. Read-only summary of structured fields (regenerated each time)
 * 3. ## Current Status section with verbatim content
 * 4. ## Notes section with verbatim content
 * 5. ## Subtasks section (if subtasks present) with each subtask's sections
 */
export function serializeTaskNoteBody(note: TaskNote): string {
  const lines: string[] = [];

  // 1. Title
  lines.push(`# ${note.displayName}`);
  lines.push('');

  // 2. Read-only summary of structured fields
  lines.push(renderSummaryBlock(note));
  lines.push('');

  // 3. Current Status section
  lines.push('## Current Status');
  lines.push(note.currentStatus);
  lines.push('');

  // 4. Notes section
  lines.push('## Notes');
  lines.push(note.notes);
  lines.push('');

  // 5. Subtasks section (only if there are subtasks)
  if (note.subtasks.length > 0) {
    lines.push('## Subtasks');
    lines.push('');

    for (const subtask of note.subtasks) {
      lines.push(`### ${subtask.title}`);
      lines.push('');

      lines.push(renderSubtaskSummaryBlock(subtask));
      lines.push('');

      lines.push('#### Current Status');
      lines.push(subtask.currentStatus);
      lines.push('');

      lines.push('#### Notes');
      lines.push(subtask.notes);
      lines.push('');
    }
  }

  return lines.join('\n').trimEnd();
}

/**
 * Renders a read-only summary block of the task's structured fields.
 * This is regenerated on every serialize and never parsed back.
 */
function renderSummaryBlock(note: TaskNote): string {
  const lines: string[] = [];

  // Format as a simple list of key structured fields
  lines.push('> [!info]- タスク情報');

  if (note.statusLabel) {
    lines.push(`> - 状態: ${note.statusLabel}`);
  }

  if (note.dueDate) {
    lines.push(`> - 期限: ${note.dueDate}`);
  }

  if (note.priority > 0) {
    lines.push(`> - 優先度: ${note.priority}`);
  }

  if (note.tags.length > 0) {
    const tagStr = note.tags.join(', ');
    lines.push(`> - タグ: ${tagStr}`);
  }

  if (note.completed) {
    lines.push(`> - ✓ 完了`);
  }

  if (lines.length === 1) {
    // No actual fields, just return the header
    return lines[0];
  }

  return lines.join('\n');
}

/**
 * Renders a read-only summary block for a subtask.
 */
function renderSubtaskSummaryBlock(subtask: Subtask): string {
  const lines: string[] = [];

  lines.push('> [!info]- サブタスク情報');

  if (subtask.statusLabel) {
    lines.push(`> - 状態: ${subtask.statusLabel}`);
  }

  if (subtask.dueDate) {
    lines.push(`> - 期限: ${subtask.dueDate}`);
  }

  if (subtask.plannedStartDate && subtask.plannedEndDate) {
    lines.push(`> - 予定: ${subtask.plannedStartDate} ～ ${subtask.plannedEndDate}`);
  }

  if (subtask.priority > 0) {
    lines.push(`> - 優先度: ${subtask.priority}`);
  }

  if (subtask.tags.length > 0) {
    const tagStr = subtask.tags.join(', ');
    lines.push(`> - タグ: ${tagStr}`);
  }

  if (subtask.markers.length > 0) {
    const markerStr = subtask.markers
      .map((m) => `${m.title}(${m.date})`)
      .join(', ');
    lines.push(`> - マイルストーン: ${markerStr}`);
  }

  if (subtask.completed) {
    lines.push(`> - ✓ 完了`);
  }

  if (lines.length === 1) {
    return lines[0];
  }

  return lines.join('\n');
}
