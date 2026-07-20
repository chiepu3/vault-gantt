<script lang="ts">
  import { Notice } from 'obsidian';
  import { DEFAULT_STATUSES } from '../../domain/status';
  import { filterTaskRecords, sortTaskRecords, buildWorkbenchRows } from './workbench-logic';
  import type { WorkbenchFilter, WorkbenchSort } from './workbench-logic';
  import type { CoreTaskAPI, TaskRecord } from '../../application/core-task-api';

  interface Props {
    api: CoreTaskAPI;
    openFile: (path: string) => void;
    openCreateTaskModal: () => void;
    openCreateSubtaskModal: (record: TaskRecord) => void;
  }

  let { api, openFile, openCreateTaskModal, openCreateSubtaskModal }: Props = $props();

  // State
  let records: TaskRecord[] = $state([]);
  let filter: WorkbenchFilter = $state({
    query: '',
    statusKeys: [],
    showCompleted: true,
    tags: [],
  });
  let sort: WorkbenchSort = $state({
    field: 'displayName',
    direction: 'asc',
  });
  let collapsed: Set<string> = $state(new Set());
  let editingCell: {
    path: string;
    field: 'displayName' | 'statusLabel' | 'dueDate';
    value: string;
  } | null = $state(null);

  let subtaskEdit: {
    parentPath: string;
    subtaskKey: string;
    field: 'title' | 'statusLabel' | 'plannedStartDate' | 'plannedEndDate' | 'dueDate';
    value: string;
  } | null = $state(null);

  // Derived state
  let filteredSorted = $derived(sortTaskRecords(filterTaskRecords(records, filter), sort));
  let rows = $derived(buildWorkbenchRows(filteredSorted, collapsed));

  let unreadableCount = $state(0);

  // Load data on mount; refresh (debounced) on any change notification.
  $effect(() => {
    let live = true;
    let debounceTimer: number | undefined;

    const reload = async () => {
      try {
        const r = await api.listTasks();
        if (live) {
          records = r;
          unreadableCount = api.getUnreadableFiles().length;
        }
      } catch (err) {
        console.error('[vault-gantt] タスク一覧の読み込みに失敗:', err);
        if (live) new Notice('タスク一覧の読み込みに失敗しました');
      }
    };

    void reload();
    const unsub = api.subscribe(() => {
      // External events (metadataCache/vault) can fire in bursts during sync;
      // trailing debounce collapses them into one listTasks call.
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => void reload(), 250);
    });
    return () => {
      live = false;
      window.clearTimeout(debounceTimer);
      unsub();
    };
  });

  // Helper functions
  function statusLabel(key: string): string {
    return DEFAULT_STATUSES.find((s) => s.key === key)?.label ?? key;
  }

  function truncate(s: string, n: number): string {
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function sortBy(field: WorkbenchSort['field']) {
    if (sort.field === field) {
      sort = { ...sort, direction: sort.direction === 'asc' ? 'desc' : 'asc' };
    } else {
      sort = { field, direction: 'asc' };
    }
  }

  function toggleCollapse(path: string) {
    const next = new Set(collapsed);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    collapsed = next;
  }

  function isEditing(path: string, field: string): boolean {
    return editingCell?.path === path && editingCell?.field === field;
  }

  function startEdit(record: TaskRecord, field: 'displayName' | 'statusLabel' | 'dueDate') {
    const value: string =
      field === 'displayName'
        ? record.note.displayName
        : field === 'statusLabel'
          ? record.note.statusLabel
          : record.note.dueDate ?? '';
    editingCell = { path: record.path, field, value };
  }

  function cancelEdit() {
    editingCell = null;
  }

  async function commitEdit(record: TaskRecord, rawValue: string) {
    if (!editingCell) return;
    const field = editingCell.field as 'displayName' | 'statusLabel' | 'dueDate';
    editingCell = null;
    const val = field === 'dueDate' ? (rawValue || null) : rawValue;
    await patchParent(record, { [field]: val });
  }

  function handleEditKey(e: KeyboardEvent, record: TaskRecord) {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit(record, (e.target as HTMLInputElement).value);
    }
  }

  async function patchParent(record: TaskRecord, fields: Record<string, unknown>) {
    const result = await api.updateTaskItem({ path: record.path, expectedRevision: record.revision, parent: fields });
    if (!result.ok) {
      new Notice(result.error.code === 'REVISION_CONFLICT'
        ? 'ファイルが別の操作で更新されました。再度お試しください。'
        : `更新に失敗しました: ${result.error.code}`);
    }
  }

  async function patchSubtask(parentPath: string, key: string, fields: Record<string, unknown>) {
    const record = records.find((r) => r.path === parentPath);
    if (!record) return;
    const result = await api.updateTaskItem({ path: parentPath, expectedRevision: record.revision, subtasks: [{ key, fields }] });
    if (!result.ok) {
      new Notice(result.error.code === 'REVISION_CONFLICT'
        ? 'ファイルが別の操作で更新されました。再度お試しください。'
        : `更新に失敗しました: ${result.error.code}`);
    }
  }

  function isEditingSubtask(parentPath: string, key: string, field: string): boolean {
    return subtaskEdit?.parentPath === parentPath && subtaskEdit?.subtaskKey === key && subtaskEdit?.field === field;
  }

  function startEditSubtask(parentPath: string, subtask: { key: string; title: string; statusLabel: string; plannedStartDate: string | null; plannedEndDate: string | null; dueDate: string | null }, field: 'title' | 'statusLabel' | 'plannedStartDate' | 'plannedEndDate' | 'dueDate') {
    const value = field === 'title' ? subtask.title
      : field === 'statusLabel' ? subtask.statusLabel
      : field === 'plannedStartDate' ? (subtask.plannedStartDate ?? '')
      : field === 'plannedEndDate' ? (subtask.plannedEndDate ?? '')
      : (subtask.dueDate ?? '');
    subtaskEdit = { parentPath, subtaskKey: subtask.key, field, value };
  }

  async function commitSubtaskEdit(parentPath: string, subtaskKey: string, rawValue: string) {
    if (!subtaskEdit) return;
    const field = subtaskEdit.field;
    subtaskEdit = null;
    const val = (field === 'plannedStartDate' || field === 'plannedEndDate' || field === 'dueDate')
      ? (rawValue || null)
      : rawValue;
    await patchSubtask(parentPath, subtaskKey, { [field]: val });
  }

  function handleSubtaskEditKey(e: KeyboardEvent, parentPath: string, subtaskKey: string) {
    if (e.key === 'Escape') { e.preventDefault(); subtaskEdit = null; }
    if (e.key === 'Enter') {
      e.preventDefault();
      commitSubtaskEdit(parentPath, subtaskKey, (e.target as HTMLInputElement).value);
    }
  }

  function addSubtask(record: TaskRecord) {
    openCreateSubtaskModal(record);
  }

  async function handleKeyDown(e: KeyboardEvent) {
    if (e.ctrlKey && e.key === 'z' && !editingCell) {
      e.preventDefault();
      const result = await api.undo();
      if (!result.ok) new Notice('元に戻せる操作がありません');
    }
  }
</script>

<div class="vg-workbench" onkeydown={handleKeyDown} tabindex="-1">
  <div class="vg-filter-bar">
    <input
      type="text"
      placeholder="タスク名で検索..."
      bind:value={filter.query}
    />
    <label>
      <input
        type="checkbox"
        bind:checked={filter.showCompleted}
      />
      完了を表示
    </label>
    <button class="vg-add-task-btn" onclick={openCreateTaskModal}>＋ タスク追加</button>
  </div>

  {#if unreadableCount > 0}
    <div class="vg-unreadable-banner">
      ⚠ {unreadableCount}件のタスクノートを読み込めませんでした（詳細は開発者コンソール）
    </div>
  {/if}

  <div class="vg-workbench-table-wrapper">
    <table class="vg-workbench-table">
      <thead>
        <tr>
          <th class="col-expand"></th>
          <th onclick={() => sortBy('displayName')}>タスク名</th>
          <th onclick={() => sortBy('priority')}>優先度</th>
          <th onclick={() => sortBy('statusLabel')}>状態</th>
          <th>現在のステータス</th>
          <th onclick={() => sortBy('createdAt')}>作成日</th>
          <th onclick={() => sortBy('updatedAt')}>更新日</th>
          <th onclick={() => sortBy('dueDate')}>期限</th>
          <th>予定開始</th>
          <th>予定終了</th>
          <th>タグ</th>
          <th>完了</th>
          <th>Gantt</th>
          <th>開く</th>
          <th>+</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.kind === 'parent' ? row.record.path : row.parentPath + '/' + row.subtask.key)}
          {#if row.kind === 'parent'}
            <tr class="vg-row-parent" class:vg-completed={row.record.note.completed}>
              <td class="col-expand">
                <button onclick={() => toggleCollapse(row.record.path)}>
                  {row.expanded ? '▼' : '▶'}{row.record.note.subtasks.length}
                </button>
              </td>
              <td class="col-name" ondblclick={() => startEdit(row.record, 'displayName')}>
                {#if isEditing(row.record.path, 'displayName')}
                  <input
                    type="text"
                    value={editingCell!.value}
                    oninput={(e) => {
                      editingCell = { ...editingCell!, value: (e.target as HTMLInputElement).value };
                    }}
                    onkeydown={(e) => handleEditKey(e, row.record)}
                    onblur={(e) => commitEdit(row.record, (e.target as HTMLInputElement).value)}
                    autofocus
                  />
                {:else}
                  {row.record.note.displayName}
                {/if}
              </td>
              <td class="col-priority">{row.record.note.priority}</td>
              <td class="col-status" ondblclick={() => startEdit(row.record, 'statusLabel')}>
                {#if isEditing(row.record.path, 'statusLabel')}
                  <select
                    value={editingCell!.value}
                    onchange={(e) => commitEdit(row.record, (e.target as HTMLSelectElement).value)}
                    onkeydown={(e) => {
                      if (e.key === 'Escape') cancelEdit();
                    }}
                    autofocus
                  >
                    {#if !DEFAULT_STATUSES.some((s) => s.key === editingCell!.value)}
                      <option value={editingCell!.value}>{editingCell!.value}</option>
                    {/if}
                    {#each DEFAULT_STATUSES as s}
                      <option value={s.key}>{s.label}</option>
                    {/each}
                  </select>
                {:else}
                  {statusLabel(row.record.note.statusLabel)}
                {/if}
              </td>
              <td class="col-current-status" title={row.record.note.currentStatus}>
                {truncate(row.record.note.currentStatus, 30)}
              </td>
              <td class="col-date">{row.record.note.createdAt}</td>
              <td class="col-date">{row.record.note.updatedAt}</td>
              <td class="col-date" ondblclick={() => startEdit(row.record, 'dueDate')}>
                {#if isEditing(row.record.path, 'dueDate')}
                  <input
                    type="date"
                    value={editingCell!.value}
                    onchange={(e) => commitEdit(row.record, (e.target as HTMLInputElement).value)}
                    onkeydown={(e) => handleEditKey(e, row.record)}
                    autofocus
                  />
                {:else}
                  {row.record.note.dueDate ?? ''}
                {/if}
              </td>
              <td></td>
              <td></td>
              <td class="col-tags">{row.record.note.tags.join(', ')}</td>
              <td class="col-check">
                <input
                  type="checkbox"
                  checked={row.record.note.completed}
                  onchange={(e) =>
                    patchParent(row.record, { completed: (e.target as HTMLInputElement).checked })}
                />
              </td>
              <td class="col-check">
                <input
                  type="checkbox"
                  checked={row.record.note.ganttEnabled}
                  onchange={(e) =>
                    patchParent(row.record, { ganttEnabled: (e.target as HTMLInputElement).checked })}
                />
              </td>
              <td>
                <button onclick={() => openFile(row.record.path)}>開く</button>
              </td>
              <td>
                <button onclick={() => addSubtask(row.record)}>+</button>
              </td>
            </tr>
          {:else}
            <tr class="vg-row-subtask" class:vg-completed={row.subtask.completed}>
              <td></td>
              <td class="col-name col-subtask-name" ondblclick={() => startEditSubtask(row.parentPath, row.subtask, 'title')}>
                {#if isEditingSubtask(row.parentPath, row.subtask.key, 'title')}
                  <input type="text" value={subtaskEdit!.value}
                    oninput={(e) => { subtaskEdit = { ...subtaskEdit!, value: (e.target as HTMLInputElement).value }; }}
                    onkeydown={(e) => handleSubtaskEditKey(e, row.parentPath, row.subtask.key)}
                    onblur={(e) => commitSubtaskEdit(row.parentPath, row.subtask.key, (e.target as HTMLInputElement).value)}
                    autofocus />
                {:else}
                  {row.subtask.title}
                {/if}
              </td>
              <td>{row.subtask.priority}</td>
              <td ondblclick={() => startEditSubtask(row.parentPath, row.subtask, 'statusLabel')}>
                {#if isEditingSubtask(row.parentPath, row.subtask.key, 'statusLabel')}
                  <select value={subtaskEdit!.value}
                    onchange={(e) => commitSubtaskEdit(row.parentPath, row.subtask.key, (e.target as HTMLSelectElement).value)}
                    onkeydown={(e) => { if (e.key === 'Escape') subtaskEdit = null; }}
                    autofocus>
                    {#each DEFAULT_STATUSES as s}
                      <option value={s.key}>{s.label}</option>
                    {/each}
                  </select>
                {:else}
                  {statusLabel(row.subtask.statusLabel)}
                {/if}
              </td>
              <td title={row.subtask.currentStatus}>{truncate(row.subtask.currentStatus, 30)}</td>
              <td>{row.subtask.createdAt}</td>
              <td>{row.subtask.updatedAt}</td>
              <td>{row.subtask.dueDate ?? ''}</td>
              <td ondblclick={() => startEditSubtask(row.parentPath, row.subtask, 'plannedStartDate')}>
                {#if isEditingSubtask(row.parentPath, row.subtask.key, 'plannedStartDate')}
                  <input type="date" value={subtaskEdit!.value}
                    onchange={(e) => commitSubtaskEdit(row.parentPath, row.subtask.key, (e.target as HTMLInputElement).value)}
                    onkeydown={(e) => handleSubtaskEditKey(e, row.parentPath, row.subtask.key)}
                    autofocus />
                {:else}
                  {row.subtask.plannedStartDate ?? ''}
                {/if}
              </td>
              <td ondblclick={() => startEditSubtask(row.parentPath, row.subtask, 'plannedEndDate')}>
                {#if isEditingSubtask(row.parentPath, row.subtask.key, 'plannedEndDate')}
                  <input type="date" value={subtaskEdit!.value}
                    onchange={(e) => commitSubtaskEdit(row.parentPath, row.subtask.key, (e.target as HTMLInputElement).value)}
                    onkeydown={(e) => handleSubtaskEditKey(e, row.parentPath, row.subtask.key)}
                    autofocus />
                {:else}
                  {row.subtask.plannedEndDate ?? ''}
                {/if}
              </td>
              <td>{row.subtask.tags.join(', ')}</td>
              <td class="col-check">
                <input type="checkbox" checked={row.subtask.completed}
                  onchange={(e) => patchSubtask(row.parentPath, row.subtask.key, { completed: (e.target as HTMLInputElement).checked })} />
              </td>
              <td></td>
              <td></td>
              <td></td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  </div>
</div>

<style>
  .vg-workbench {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    font-size: var(--font-ui-small);
  }

  .vg-filter-bar {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    padding: 0.5rem;
    border-bottom: 1px solid var(--background-modifier-border);
    flex-shrink: 0;
  }

  .vg-filter-bar input[type='text'] {
    flex: 1;
    min-width: 0;
  }

  .vg-workbench-table-wrapper {
    flex: 1;
    overflow: auto;
  }

  .vg-workbench-table {
    width: 100%;
    border-collapse: collapse;
    white-space: nowrap;
  }

  .vg-workbench-table th {
    position: sticky;
    top: 0;
    background: var(--background-primary);
    border-bottom: 2px solid var(--background-modifier-border);
    padding: 0.25rem 0.5rem;
    text-align: left;
    cursor: pointer;
    user-select: none;
  }

  .vg-workbench-table td {
    padding: 0.2rem 0.5rem;
    border-bottom: 1px solid var(--background-modifier-border);
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .vg-row-subtask td {
    padding-left: 1.5rem;
    background: var(--background-secondary);
  }

  .vg-completed {
    opacity: 0.5;
  }

  .vg-completed td {
    text-decoration: line-through;
  }

  .col-expand {
    width: 2rem;
  }

  .col-name {
    min-width: 8rem;
  }

  .col-date {
    width: 6rem;
  }

  .col-check {
    width: 3rem;
    text-align: center;
  }

  .vg-workbench-table input[type='text'],
  .vg-workbench-table input[type='date'],
  .vg-workbench-table select {
    width: 100%;
    background: var(--background-primary);
    border: 1px solid var(--interactive-accent);
    border-radius: 2px;
    font-size: inherit;
    color: inherit;
  }

  button {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-normal);
    padding: 0.1rem 0.3rem;
  }

  button:hover {
    color: var(--interactive-accent);
  }

  .vg-add-task-btn {
    margin-left: auto;
    background: var(--interactive-accent);
    color: var(--text-on-accent);
    border-radius: 4px;
    padding: 0.2rem 0.75rem;
    font-weight: 500;
    white-space: nowrap;
  }

  .vg-add-task-btn:hover {
    background: var(--interactive-accent-hover);
    color: var(--text-on-accent);
  }

  .vg-unreadable-banner {
    padding: 0.35rem 0.75rem;
    background: var(--background-modifier-error);
    color: var(--text-error);
    border-bottom: 1px solid var(--background-modifier-border);
    flex-shrink: 0;
    font-size: var(--font-ui-smaller);
  }
</style>
