<script lang="ts">
  import { Notice } from 'obsidian';
  import { SvelteSet } from 'svelte/reactivity';
  import { DEFAULT_STATUSES } from '../../domain/status';
  import { filterTaskRecords, sortTaskRecords, buildWorkbenchRows, buildFlatRows, effectivePriority } from './workbench-logic';
  import type { WorkbenchFilter, WorkbenchSort } from './workbench-logic';
  import type { CoreTaskAPI, TaskRecord } from '../../application/core-task-api';

  interface Props {
    api: CoreTaskAPI;
    openFile: (path: string) => void;
    openCreateTaskModal: () => void;
    openCreateSubtaskModal: (record: TaskRecord) => void;
    hideCompletedByDefault?: boolean;
  }

  let { api, openFile, openCreateTaskModal, openCreateSubtaskModal, hideCompletedByDefault = false }: Props = $props();

  // State
  let records: TaskRecord[] = $state([]);
  let filter: WorkbenchFilter = $state({
    query: '',
    statusKeys: [],
    showCompleted: !hideCompletedByDefault,
    tags: [],
  });
  let sort: WorkbenchSort = $state({
    field: 'displayName',
    direction: 'asc',
  });
  let collapsed = new SvelteSet<string>();
  let editingCell: {
    path: string;
    field: 'displayName' | 'statusLabel' | 'dueDate' | 'currentStatus' | 'tags' | 'priority';
    value: string;
  } | null = $state(null);

  const todayIso = new Date().toISOString().slice(0, 10);

  let subtaskEdit: {
    parentPath: string;
    subtaskKey: string;
    field: 'title' | 'statusLabel' | 'plannedStartDate' | 'plannedEndDate' | 'dueDate' | 'tags' | 'currentStatus';
    value: string;
  } | null = $state(null);

  let flatView = $state(false);

  // Derived state
  let filteredSorted = $derived(sortTaskRecords(filterTaskRecords(records, filter), sort, todayIso));
  let rows = $derived(buildWorkbenchRows(filteredSorted, collapsed));
  let flatRows = $derived(buildFlatRows(filteredSorted, filter.showCompleted));
  let allTags = $derived(
    Array.from(new Set(records.flatMap((r) => r.note.tags))).sort()
  );

  let unreadableCount = $state(0);

  // today for overdue detection
  function todayStr(): string {
    return new Date().toISOString().slice(0, 10);
  }

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
    if (collapsed.has(path)) {
      collapsed.delete(path);
    } else {
      collapsed.add(path);
    }
  }

  function isEditing(path: string, field: string): boolean {
    return editingCell?.path === path && editingCell?.field === field;
  }

  function startEdit(record: TaskRecord, field: 'displayName' | 'statusLabel' | 'dueDate' | 'currentStatus' | 'tags' | 'priority') {
    const value: string =
      field === 'displayName' ? record.note.displayName
      : field === 'statusLabel' ? record.note.statusLabel
      : field === 'dueDate' ? (record.note.dueDate ?? '')
      : field === 'currentStatus' ? record.note.currentStatus
      : field === 'priority' ? String(effectivePriority(record, todayIso))
      : record.note.tags.join(', ');
    editingCell = { path: record.path, field, value };
  }

  function cancelEdit() {
    editingCell = null;
  }

  async function commitEdit(record: TaskRecord, rawValue: string) {
    if (!editingCell) return;
    const field = editingCell.field;
    editingCell = null;
    let val: unknown;
    if (field === 'dueDate') {
      val = rawValue || null;
    } else if (field === 'tags') {
      val = rawValue.split(',').map((t) => t.trim()).filter(Boolean);
    } else if (field === 'priority') {
      const n = Math.max(0, Math.min(5, parseInt(rawValue, 10) || 0));
      await patchParent(record, { priority: n, priorityMode: 'manual' });
      return;
    } else {
      val = rawValue;
    }
    await patchParent(record, { [field]: val });
  }

  function handleEditKey(e: KeyboardEvent, record: TaskRecord) {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
      return;
    }
    // currentStatus: Ctrl+Enter to submit, plain Enter is newline
    const isTextarea = editingCell?.field === 'currentStatus';
    if (e.key === 'Enter' && (!isTextarea || e.ctrlKey)) {
      e.preventDefault();
      commitEdit(record, (e.target as HTMLInputElement | HTMLTextAreaElement).value);
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

  function startEditSubtask(
    parentPath: string,
    subtask: { key: string; title: string; statusLabel: string; plannedStartDate: string | null; plannedEndDate: string | null; dueDate: string | null; tags: string[]; currentStatus: string },
    field: 'title' | 'statusLabel' | 'plannedStartDate' | 'plannedEndDate' | 'dueDate' | 'tags' | 'currentStatus'
  ) {
    const value =
      field === 'title' ? subtask.title
      : field === 'statusLabel' ? subtask.statusLabel
      : field === 'plannedStartDate' ? (subtask.plannedStartDate ?? '')
      : field === 'plannedEndDate' ? (subtask.plannedEndDate ?? '')
      : field === 'dueDate' ? (subtask.dueDate ?? '')
      : field === 'tags' ? subtask.tags.join(', ')
      : subtask.currentStatus;
    subtaskEdit = { parentPath, subtaskKey: subtask.key, field, value };
  }

  async function commitSubtaskEdit(parentPath: string, subtaskKey: string, rawValue: string) {
    if (!subtaskEdit) return;
    const field = subtaskEdit.field;
    subtaskEdit = null;
    let val: unknown;
    if (field === 'plannedStartDate' || field === 'plannedEndDate' || field === 'dueDate') {
      val = rawValue || null;
    } else if (field === 'tags') {
      val = rawValue.split(',').map((t) => t.trim()).filter(Boolean);
    } else {
      val = rawValue;
    }
    await patchSubtask(parentPath, subtaskKey, { [field]: val });
  }

  function handleSubtaskEditKey(e: KeyboardEvent, parentPath: string, subtaskKey: string) {
    if (e.key === 'Escape') { e.preventDefault(); subtaskEdit = null; return; }
    const isTextarea = subtaskEdit?.field === 'currentStatus';
    if (e.key === 'Enter' && (!isTextarea || e.ctrlKey)) {
      e.preventDefault();
      commitSubtaskEdit(parentPath, subtaskKey, (e.target as HTMLInputElement | HTMLTextAreaElement).value);
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

  function isOverdue(record: TaskRecord): boolean {
    return !record.note.completed && !!record.note.dueDate && record.note.dueDate < todayStr();
  }
</script>

<div class="vg-workbench" onkeydown={handleKeyDown} tabindex="-1">
  <div class="vg-filter-bar">
    <input
      type="text"
      placeholder="タスクを検索..."
      bind:value={filter.query}
      class="vg-search-input"
    />
    <select
      class="vg-status-filter"
      value={filter.statusKeys[0] ?? ''}
      onchange={(e) => {
        const val = (e.target as HTMLSelectElement).value;
        filter = { ...filter, statusKeys: val ? [val] : [] };
      }}
    >
      <option value="">すべての状態</option>
      {#each DEFAULT_STATUSES as s (s.key)}
        <option value={s.key}>{s.label}</option>
      {/each}
    </select>
    {#if allTags.length > 0}
      <select
        class="vg-status-filter"
        value={filter.tags[0] ?? ''}
        onchange={(e) => {
          const val = (e.target as HTMLSelectElement).value;
          filter = { ...filter, tags: val ? [val] : [] };
        }}
      >
        <option value="">すべてのタグ</option>
        {#each allTags as tag (tag)}
          <option value={tag}>{tag}</option>
        {/each}
      </select>
    {/if}
    <label class="vg-filter-label">
      <input type="checkbox" bind:checked={filter.showCompleted} />
      完了を表示
    </label>
    <button
      class="vg-flat-view-btn"
      class:is-active={flatView}
      onclick={() => { flatView = !flatView; }}
      title="サブタスクを期限順にフラット表示"
    >一覧</button>
    <button class="vg-add-task-btn" onclick={openCreateTaskModal}>＋ タスク追加</button>
  </div>

  {#if unreadableCount > 0}
    <div class="vg-unreadable-banner">
      ⚠ {unreadableCount}件のタスクノートを読み込めませんでした（詳細は開発者コンソール）
    </div>
  {/if}

  <div class="vg-workbench-table-wrapper">
    {#if flatView}
      <table class="vg-workbench-table">
        <thead>
          <tr>
            <th class="col-name">親タスク</th>
            <th class="col-name">サブタスク</th>
            <th class="col-status">状態</th>
            <th class="col-date">期限</th>
            <th class="col-date">予定開始</th>
            <th class="col-date">予定終了</th>
            <th class="col-check">完了</th>
          </tr>
        </thead>
        <tbody>
          {#each flatRows as fr (fr.record.path + '/' + fr.subtask.key)}
            <tr class="vg-row-subtask" class:vg-completed={fr.subtask.completed}>
              <td class="col-name vg-flat-parent-name">{fr.record.note.displayName}</td>
              <td class="col-name">{fr.subtask.title}</td>
              <td class="col-status">{statusLabel(fr.subtask.statusLabel)}</td>
              <td class="col-date" class:vg-overdue-cell={!fr.subtask.completed && !!fr.subtask.dueDate && fr.subtask.dueDate < todayStr()}>{fr.subtask.dueDate ?? ''}</td>
              <td class="col-date">{fr.subtask.plannedStartDate ?? ''}</td>
              <td class="col-date">{fr.subtask.plannedEndDate ?? ''}</td>
              <td class="col-check">
                <input type="checkbox" checked={fr.subtask.completed}
                  onchange={(e) => patchSubtask(fr.record.path, fr.subtask.key, { completed: (e.target as HTMLInputElement).checked })} />
              </td>
            </tr>
          {/each}
          {#if flatRows.length === 0}
            <tr><td colspan="7" class="vg-flat-empty">サブタスクがありません</td></tr>
          {/if}
        </tbody>
      </table>
    {:else}
    <table class="vg-workbench-table">
      <thead>
        <tr>
          <th class="col-expand"></th>
          <th class="col-name" onclick={() => sortBy('displayName')}>タスク名</th>
          <th class="col-priority" onclick={() => sortBy('priority')}>優先度</th>
          <th class="col-status" onclick={() => sortBy('statusLabel')}>状態</th>
          <th class="col-current-status">現在のステータス</th>
          <th class="col-date" onclick={() => sortBy('createdAt')}>作成日</th>
          <th class="col-date" onclick={() => sortBy('updatedAt')}>更新日</th>
          <th class="col-date" onclick={() => sortBy('dueDate')}>期限</th>
          <th class="col-date">予定開始</th>
          <th class="col-date">予定終了</th>
          <th class="col-tags">タグ</th>
          <th class="col-check">完了</th>
          <th class="col-check">Gantt</th>
          <th class="col-action">開く</th>
          <th class="col-action">+</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.kind === 'parent' ? row.record.path : row.parentPath + '/' + row.subtask.key)}
          {#if row.kind === 'parent'}
            <tr class="vg-row-parent"
              class:vg-completed={row.record.note.completed}
              class:vg-overdue={isOverdue(row.record)}>
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
                    oninput={(e) => { editingCell = { ...editingCell!, value: (e.target as HTMLInputElement).value }; }}
                    onkeydown={(e) => handleEditKey(e, row.record)}
                    onblur={(e) => commitEdit(row.record, (e.target as HTMLInputElement).value)}
                    autofocus
                  />
                {:else}
                  <span class="vg-task-name">{row.record.note.displayName}</span>
                  {#if row.previewSubtask}
                    <span class="vg-preview-chip" title={row.previewSubtask.title}>
                      {truncate(row.previewSubtask.title, 24)}
                      {#if row.previewSubtask.dueDate}<span class="vg-preview-due">{row.previewSubtask.dueDate}</span>{/if}
                    </span>
                  {/if}
                {/if}
              </td>
              <td class="col-priority" ondblclick={() => startEdit(row.record, 'priority')}>
                {#if isEditing(row.record.path, 'priority')}
                  <select
                    value={editingCell!.value}
                    onchange={(e) => commitEdit(row.record, (e.target as HTMLSelectElement).value)}
                    onkeydown={(e) => { if (e.key === 'Escape') cancelEdit(); }}
                    autofocus
                  >
                    <option value="0">0 – なし</option>
                    <option value="1">1 – 低</option>
                    <option value="2">2 – 普通</option>
                    <option value="3">3 – やや高</option>
                    <option value="4">4 – 高</option>
                    <option value="5">5 – 最高</option>
                  </select>
                {:else}
                  {effectivePriority(row.record, todayIso)}
                  {#if row.record.note.priorityMode === 'auto'}<span class="vg-auto-badge">auto</span>{/if}
                {/if}
              </td>
              <td class="col-status" ondblclick={() => startEdit(row.record, 'statusLabel')}>
                {#if isEditing(row.record.path, 'statusLabel')}
                  <select
                    value={editingCell!.value}
                    onchange={(e) => commitEdit(row.record, (e.target as HTMLSelectElement).value)}
                    onkeydown={(e) => { if (e.key === 'Escape') cancelEdit(); }}
                    autofocus
                  >
                    {#if !DEFAULT_STATUSES.some((s) => s.key === editingCell!.value)}
                      <option value={editingCell!.value}>{editingCell!.value}</option>
                    {/if}
                    {#each DEFAULT_STATUSES as s (s.key)}
                      <option value={s.key}>{s.label}</option>
                    {/each}
                  </select>
                {:else}
                  {statusLabel(row.record.note.statusLabel)}
                {/if}
              </td>
              <td class="col-current-status"
                title={row.record.note.currentStatus}
                ondblclick={() => startEdit(row.record, 'currentStatus')}>
                {#if isEditing(row.record.path, 'currentStatus')}
                  <textarea
                    value={editingCell!.value}
                    oninput={(e) => { editingCell = { ...editingCell!, value: (e.target as HTMLTextAreaElement).value }; }}
                    onkeydown={(e) => handleEditKey(e, row.record)}
                    onblur={(e) => commitEdit(row.record, (e.target as HTMLTextAreaElement).value)}
                    rows="3"
                    autofocus
                  ></textarea>
                {:else}
                  {truncate(row.record.note.currentStatus, 50)}
                {/if}
              </td>
              <td class="col-date">{row.record.note.createdAt}</td>
              <td class="col-date">{row.record.note.updatedAt}</td>
              <td class="col-date vg-due-date"
                class:vg-overdue-cell={isOverdue(row.record)}
                ondblclick={() => startEdit(row.record, 'dueDate')}>
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
              <td class="col-tags" ondblclick={() => startEdit(row.record, 'tags')}>
                {#if isEditing(row.record.path, 'tags')}
                  <input
                    type="text"
                    value={editingCell!.value}
                    placeholder="タグ1, タグ2"
                    oninput={(e) => { editingCell = { ...editingCell!, value: (e.target as HTMLInputElement).value }; }}
                    onkeydown={(e) => handleEditKey(e, row.record)}
                    onblur={(e) => commitEdit(row.record, (e.target as HTMLInputElement).value)}
                    autofocus
                  />
                {:else}
                  {row.record.note.tags.join(', ')}
                {/if}
              </td>
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
              <td class="col-action">
                <button onclick={() => openFile(row.record.path)}>開く</button>
              </td>
              <td class="col-action">
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
                    {#each DEFAULT_STATUSES as s (s.key)}
                      <option value={s.key}>{s.label}</option>
                    {/each}
                  </select>
                {:else}
                  {statusLabel(row.subtask.statusLabel)}
                {/if}
              </td>
              <td title={row.subtask.currentStatus} ondblclick={() => startEditSubtask(row.parentPath, row.subtask, 'currentStatus')}>
                {#if isEditingSubtask(row.parentPath, row.subtask.key, 'currentStatus')}
                  <textarea rows={3} value={subtaskEdit!.value}
                    oninput={(e) => { subtaskEdit = { ...subtaskEdit!, value: (e.target as HTMLTextAreaElement).value }; }}
                    onkeydown={(e) => handleSubtaskEditKey(e, row.parentPath, row.subtask.key)}
                    onblur={(e) => commitSubtaskEdit(row.parentPath, row.subtask.key, (e.target as HTMLTextAreaElement).value)}
                    autofocus></textarea>
                {:else}
                  {truncate(row.subtask.currentStatus, 50)}
                {/if}
              </td>
              <td>{row.subtask.createdAt}</td>
              <td>{row.subtask.updatedAt}</td>
              <td ondblclick={() => startEditSubtask(row.parentPath, row.subtask, 'dueDate')}>
                {#if isEditingSubtask(row.parentPath, row.subtask.key, 'dueDate')}
                  <input type="date" value={subtaskEdit!.value}
                    onchange={(e) => commitSubtaskEdit(row.parentPath, row.subtask.key, (e.target as HTMLInputElement).value)}
                    onkeydown={(e) => handleSubtaskEditKey(e, row.parentPath, row.subtask.key)}
                    onblur={(e) => commitSubtaskEdit(row.parentPath, row.subtask.key, (e.target as HTMLInputElement).value)}
                    autofocus />
                {:else}
                  {row.subtask.dueDate ?? ''}
                {/if}
              </td>
              <td ondblclick={() => startEditSubtask(row.parentPath, row.subtask, 'plannedStartDate')}>
                {#if isEditingSubtask(row.parentPath, row.subtask.key, 'plannedStartDate')}
                  <input type="date" value={subtaskEdit!.value}
                    onchange={(e) => commitSubtaskEdit(row.parentPath, row.subtask.key, (e.target as HTMLInputElement).value)}
                    onkeydown={(e) => handleSubtaskEditKey(e, row.parentPath, row.subtask.key)}
                    onblur={(e) => commitSubtaskEdit(row.parentPath, row.subtask.key, (e.target as HTMLInputElement).value)}
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
                    onblur={(e) => commitSubtaskEdit(row.parentPath, row.subtask.key, (e.target as HTMLInputElement).value)}
                    autofocus />
                {:else}
                  {row.subtask.plannedEndDate ?? ''}
                {/if}
              </td>
              <td ondblclick={() => startEditSubtask(row.parentPath, row.subtask, 'tags')}>
                {#if isEditingSubtask(row.parentPath, row.subtask.key, 'tags')}
                  <input type="text" value={subtaskEdit!.value}
                    placeholder="tag1, tag2"
                    oninput={(e) => { subtaskEdit = { ...subtaskEdit!, value: (e.target as HTMLInputElement).value }; }}
                    onkeydown={(e) => handleSubtaskEditKey(e, row.parentPath, row.subtask.key)}
                    onblur={(e) => commitSubtaskEdit(row.parentPath, row.subtask.key, (e.target as HTMLInputElement).value)}
                    autofocus />
                {:else}
                  {row.subtask.tags.join(', ')}
                {/if}
              </td>
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
    {/if}
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

  /* ===== Filter Bar ===== */
  .vg-filter-bar {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    padding: 6px 8px;
    border-bottom: 1px solid var(--background-modifier-border);
    background: var(--background-secondary);
    flex-shrink: 0;
  }

  .vg-search-input {
    flex: 1;
    min-width: 120px;
  }

  .vg-status-filter {
    min-width: 110px;
    font-size: var(--font-ui-smaller);
    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
    padding: 2px 4px;
    color: var(--text-normal);
  }

  .vg-filter-label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
  }

  .vg-add-task-btn {
    margin-left: auto;
    background: var(--interactive-accent);
    color: var(--text-on-accent);
    border-radius: 4px;
    padding: 3px 10px;
    font-weight: 500;
    white-space: nowrap;
    border: none;
    cursor: pointer;
  }

  .vg-add-task-btn:hover {
    background: var(--interactive-accent-hover);
    color: var(--text-on-accent);
  }

  /* ===== Table ===== */
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
    background: var(--background-secondary);
    border-bottom: 2px solid var(--background-modifier-border);
    padding: 4px 6px;
    text-align: left;
    cursor: pointer;
    user-select: none;
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    font-weight: 600;
    z-index: 1;
  }

  .vg-workbench-table td {
    padding: 3px 6px;
    border-bottom: 1px solid var(--background-modifier-border);
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
    vertical-align: middle;
  }

  /* ===== Column widths ===== */
  .col-expand  { width: 2.5rem; }
  .col-name    { min-width: 160px; width: 20%; }
  .col-priority { width: 3.5rem; text-align: center; }
  .col-status  { width: 90px; }
  .col-current-status { width: 28%; min-width: 200px; white-space: normal; }
  .col-date    { width: 90px; }
  .col-tags    { min-width: 80px; }
  .col-check   { width: 3rem; text-align: center; }
  .col-action  { width: 3rem; text-align: center; }

  /* ===== Row states ===== */
  .vg-row-parent:hover td {
    background: var(--background-modifier-hover);
  }

  .vg-row-subtask td {
    background: var(--background-secondary);
  }

  .vg-row-subtask:hover td {
    background: var(--background-modifier-hover);
  }

  .vg-row-subtask .col-subtask-name {
    padding-left: 1.5rem;
  }

  .vg-completed {
    opacity: 0.45;
  }

  .vg-completed td {
    text-decoration: line-through;
  }

  .vg-overdue-cell {
    color: var(--text-error);
    font-weight: 600;
  }

  /* Collapsed preview chip */
  .vg-task-name {
    display: inline;
  }

  .vg-preview-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-left: 6px;
    padding: 1px 6px;
    border-radius: 10px;
    background: var(--background-modifier-border);
    color: var(--text-muted);
    font-size: 11px;
    font-weight: normal;
    vertical-align: middle;
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .vg-preview-due {
    color: var(--text-accent);
    font-weight: 600;
    flex-shrink: 0;
  }

  /* ===== Inline edit inputs ===== */
  .vg-workbench-table input[type='text'],
  .vg-workbench-table input[type='date'],
  .vg-workbench-table select,
  .vg-workbench-table textarea {
    width: 100%;
    box-sizing: border-box;
    background: var(--background-primary);
    border: 1px solid var(--interactive-accent);
    border-radius: 2px;
    font-size: inherit;
    color: inherit;
    font-family: inherit;
  }

  .vg-workbench-table textarea {
    min-height: 60px;
    resize: vertical;
    white-space: pre-wrap;
  }

  /* ===== Buttons ===== */
  button {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-normal);
    padding: 1px 4px;
    font-size: inherit;
  }

  button:hover {
    color: var(--interactive-accent);
  }

  /* ===== Unreadable banner ===== */
  /* ===== Flat view ===== */
  .vg-flat-view-btn {
    background: none;
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
    padding: 3px 8px;
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    cursor: pointer;
    white-space: nowrap;
  }
  .vg-flat-view-btn.is-active {
    background: var(--interactive-accent);
    color: var(--text-on-accent);
    border-color: var(--interactive-accent);
  }
  .vg-flat-parent-name {
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
  }
  .vg-flat-empty {
    text-align: center;
    color: var(--text-muted);
    padding: 20px;
  }

  /* ===== Unreadable banner ===== */
  .vg-unreadable-banner {
    padding: 4px 8px;
    background: var(--background-modifier-error);
    color: var(--text-error);
    border-bottom: 1px solid var(--background-modifier-border);
    flex-shrink: 0;
    font-size: var(--font-ui-smaller);
  }
</style>
