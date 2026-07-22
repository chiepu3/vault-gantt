import type { MarkdownPostProcessorContext } from 'obsidian';
import type { CoreTaskAPI, TaskRecord } from '../../application/core-task-api';
import { GanttRenderer } from './gantt-renderer';
import { GanttViewState } from './gantt-view-state';
import { todayStr, addDays } from './gantt-date-utils';

// Module-level API reference (set by main.ts)
let embedApiInstance: CoreTaskAPI | null = null;
let embedGetSettings: (() => { ganttZoom: number; enableHolidays: boolean }) | null = null;

export function setEmbedApi(api: CoreTaskAPI): void {
  embedApiInstance = api;
}

export function setEmbedSettingsGetter(fn: () => { ganttZoom: number; enableHolidays: boolean }): void {
  embedGetSettings = fn;
}

interface EmbedConfig {
  range: number;
  zoom: number | null;
  taskPaths: string[];
}

function parseConfig(source: string): EmbedConfig {
  const config: EmbedConfig = { range: 90, zoom: null, taskPaths: [] };
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [key, ...rest] = trimmed.split(':');
    const value = rest.join(':').trim();
    switch (key.trim()) {
      case 'range':
        config.range = Math.max(7, Math.min(365, parseInt(value, 10) || 90));
        break;
      case 'zoom':
        config.zoom = Math.max(8, Math.min(60, parseInt(value, 10) || 20));
        break;
      case 'task':
        if (value) config.taskPaths.push(value);
        break;
    }
  }
  return config;
}

export async function renderGanttEmbed(
  source: string,
  el: HTMLElement,
  _ctx: MarkdownPostProcessorContext,
): Promise<void> {
  if (!embedApiInstance) {
    el.createDiv({ cls: 'vg-embed-error', text: 'Vault Gantt: プラグインが読み込まれていません' });
    return;
  }

  const config = parseConfig(source);
  const settings = embedGetSettings?.() ?? { ganttZoom: 28, enableHolidays: true };
  const dayWidth = config.zoom ?? settings.ganttZoom;

  let tasks: TaskRecord[];
  try {
    tasks = await embedApiInstance.listTasks();
  } catch {
    el.createDiv({ cls: 'vg-embed-error', text: 'Vault Gantt: タスクの読み込みに失敗しました' });
    return;
  }

  // Filter tasks
  let filtered = tasks.filter((t) => t.note.ganttEnabled);
  if (config.taskPaths.length > 0) {
    filtered = filtered.filter((t) => config.taskPaths.includes(t.path));
  }

  if (filtered.length === 0) {
    el.createDiv({ cls: 'vg-embed-empty', text: 'タスクがありません' });
    return;
  }

  // Build dates array
  const start = todayStr();
  const dates: string[] = [];
  for (let i = 0; i < config.range; i++) {
    dates.push(addDays(start, i));
  }

  // Create read-only view state
  const viewState = new GanttViewState(start);
  viewState.dayWidth = dayWidth;

  // Container
  el.addClass('vg-embed-container');

  const renderer = new GanttRenderer(viewState);
  renderer.enableHolidays = settings.enableHolidays;
  renderer.mount(el);
  renderer.renderHeader(dates);
  renderer.renderAll(filtered, dates);
  renderer.setTimelineWidth(dates);
}
