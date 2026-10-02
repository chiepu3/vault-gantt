import { TFile } from "obsidian";
import type { App } from "obsidian";
import type { TaskRow, TaskWorkbenchSettings } from "../core/types";

import type { Logger } from "../core/logger";

import type { TaskCache } from "./auto-priority";
import { VaultAdapter, loadTasks } from "./task-operations";
import { TaskFinderModal } from "../ui/task-finder-modal";

/**
 * Live plugin state the NavigationService needs. Everything is read lazily
 * at call time, so the service may be constructed before settings load.
 */
export interface NavigationHost {

  readonly logger: Logger;

  readonly app: App;
  readonly settings: TaskWorkbenchSettings;
  readonly taskCache: TaskCache;
}

/**
 *
 *
 *
 *
 *
 * Concrete NavigationService used by commands, ribbon buttons and the task
 * finder modal. Implements the NavigationService port declared in
 * src/main.ts (activateView, activateGanttView, openTaskFinder) plus
 * openTaskItem, which TaskFinderModal calls.
 *
 * Views open in the active window. Task loading has no timeout.
 */
export class NavigationService {
  constructor(
    private readonly host: NavigationHost,
    private readonly vaultFactory: () => VaultAdapter,
    private readonly workbenchViewType: string,
    private readonly ganttViewType: string
  ) {}

  /**
 *
 * Opens (or brings to front) the Task Workbench view.
 */
  async activateView(): Promise<void> {
    await this.activateViewOfType(this.workbenchViewType);
  }

  /**
 *
 * Opens or brings the Task Gantt view to the front using the same leaf
 * handling as `activateView`, with the Gantt view type. Workbench and Gantt
 * can coexist in separate tabs; Obsidian handles tab switching.
 */
  async activateGanttView(): Promise<void> {
    await this.activateViewOfType(this.ganttViewType);
  }

  private async activateViewOfType(viewType: string): Promise<void> {
    const ws = this.host.app.workspace;

    // reuse an already-open leaf.
    // The view instance is NOT recreated; its in-memory state (scroll
    // position, focus, filters) survives repeated command invocations.
    let leaf = ws.getLeavesOfType(viewType)[0];

    if (!leaf) {
      // first open, or re-open after the view was
      // closed (previous state is gone — a fresh instance is created).
      try {
        leaf = ws.getLeaf("tab");
      } catch {
        // getLeaf("tab") failures fall back to a
        // split/new-window leaf. The exception is intentionally swallowed.
        leaf = ws.getLeaf(true);
      }
    }


    await leaf.setViewState({ type: viewType, active: true });

    await ws.revealLeaf(leaf);
  }

  /**
 *
 * Loads every managed task from disk, flattens parents and subtasks into
 * a single list, and opens the TaskFinderModal over it.
 *
 * Errors from loadTasks, including failures while listing a task folder,
 * are not caught. They propagate to the caller, and the dialog never opens.
 */
  async openTaskFinder(): Promise<void> {
    const tasks = await loadTasks(
      this.vaultFactory(),
      this.host.settings,

      this.host.taskCache,
      this.host.logger

    );

    // flat list of every parent and its subtasks
    const items: TaskRow[] = [];
    for (const task of tasks) {
      items.push(task);
      if (task.subtasks) {
        for (const subtask of task.subtasks.values()) {
          items.push(subtask);
        }
      }
    }


    new TaskFinderModal(this.host.app, this, items).open();
  }

  /**
 *
 * Opens a task row in an editor leaf.
 *
 * Subtasks jump through an Obsidian wiki link with a heading anchor
 * ("filename#heading"); when that jump fails (heading renamed/missing)
 * the exception is caught and the parent file is opened instead.
 *
 * Parent tasks reuse the most recently used leaf, creating a new one
 * only when none exists.
 *
 * openFile failures propagate uncaptured.
 */
  async openTaskItem(item: TaskRow): Promise<void> {
    if (item.kind === "subtask") {
      // "[filename]#[subtask heading]" anchor link
      const link = subtaskLink(item);
      try {
        await this.host.app.workspace.openLinkText(link, item.file.path);
        return;
      } catch {
        // If the subtask jump fails, continue by opening the parent file.
      }
    }

    const ws = this.host.app.workspace;

    // reuse the most recently used leaf when one exists
    let leaf = ws.getMostRecentLeaf();
    if (!leaf) {
      // otherwise create a new leaf
      leaf = ws.getLeaf(true);
    }


    // a plain {path,...} object (not a real TFile) for testability, so it
    // cannot be handed to Obsidian's openFile as-is — resolve the genuine
    // TFile by path first (same pattern as TaskFileService.openInEditor).
    // The `!` assertion still stands in for the documented uncertainty when
    // even the path is missing/stale: openFile(undefined) is then an
    // Obsidian-side error or no-op, not guarded here.
    const resolved = item.file
      ? this.host.app.vault.getAbstractFileByPath(item.file.path)
      : null;
    await leaf.openFile(resolved instanceof TFile ? resolved : item.file!);
  }
}

/**
 * link form "[filename]#[subtask heading]".
 * The filename is the parent file's basename without the.md extension;
 * the heading falls back to the subtask title when the parsed heading is
 * unavailable.
 */
function subtaskLink(item: TaskRow): string {
  const path = item.file.parentPath ?? item.file.path;
  const fileName = path.split("/").pop() ?? path;
  const baseName = fileName.replace(/\.md$/i, "");
  const heading = item.file.heading ?? item.title;
  return `${baseName}#${heading}`;
}
