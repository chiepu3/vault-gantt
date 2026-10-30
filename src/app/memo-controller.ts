import type { Logger } from "../core/logger";
import type { MemoMeta } from "../core/memo";
import type { MemoLayout, TaskWorkbenchSettings } from "../core/types";
import type { HistoryManager } from "./history-manager";
import { createMemo, deleteMemo, readMemoText, reanchorMemo, updateMemoText, type MemoTarget } from "./memo-service";
import { loadMemos, type TaskCache } from "./note-store";
import type { VaultAdapter } from "./task-operations";

/** What the Gantt memo layer asks of the plugin. Every write is recorded for undo. */
export interface MemoHost {
  /** The memo notes in the task folder (front matter only; text is read lazily). */
  load(): Promise<MemoMeta[]>;
  readText(meta: MemoMeta): Promise<string>;
  create(input: MemoTarget & { text: string }): Promise<MemoMeta>;
  updateText(meta: MemoMeta, text: string): Promise<void>;
  reanchor(meta: MemoMeta, target: MemoTarget): Promise<void>;
  remove(meta: MemoMeta): Promise<void>;
  openNote(meta: MemoMeta): Promise<void>;
  /** Records a bubble move or resize for undo/redo; the settings are already updated. */
  recordLayout(label: string, id: string, before: MemoLayout | null, after: MemoLayout): void;
  /** Persists the open/closed and placement state (settings only; nothing is invalidated). */
  saveLayout(): void;
}

export interface MemoHostDeps {
  vault(): VaultAdapter;
  settings(): TaskWorkbenchSettings;
  history: HistoryManager;
  cache: TaskCache;
  logger: Logger;
  /** Runs a write in the plugin's write queue. */
  coordinate<T>(run: () => Promise<T>): Promise<T>;
  openFile(path: string): Promise<void>;
  saveSettings(): Promise<void>;
}

export function createMemoHost(deps: MemoHostDeps): MemoHost {
  const { history, cache, logger } = deps;
  return {
    load: () => loadMemos(deps.vault(), deps.settings(), cache, logger),
    readText: (meta) => readMemoText(deps.vault(), meta),
    create: (input) => deps.coordinate(() => createMemo(deps.vault(), deps.settings(), input, history, cache)),
    updateText: (meta, text) => deps.coordinate(() => updateMemoText(deps.vault(), meta, text, history, cache)),
    reanchor: (meta, target) => deps.coordinate(() => reanchorMemo(deps.vault(), meta, target, history, cache)),
    remove: (meta) => deps.coordinate(() => deleteMemo(deps.vault(), meta, history, cache)),
    openNote: (meta) => deps.openFile(meta.path),
    recordLayout: (label, id, before, after) => history.push({ label, files: [], memoLayout: { id, before, after } }),
    saveLayout: () => { void deps.saveSettings().catch((error: unknown) => logger.error("MemoHost", "failed to save memo layout", error)); },
  };
}
