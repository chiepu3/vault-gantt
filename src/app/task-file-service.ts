import { Modal, Notice, Setting, TFile } from "obsidian";
import type { App } from "obsidian";
import { TaskRow, TaskWorkbenchSettings } from "../core/types";
import { parseTaskFile } from "../core/note-format";
import { VaultAdapter, addSubtask, createTask } from "./task-operations";

/**
 * Injectable single-line text prompt.
 * Returns the entered text, or null when the user cancels.
 * Production wires this to PromptModal below; tests inject scripted values.
 */
export type PromptFn = (defaultValue?: string) => Promise<string | null>;

/**
 *
 *
 *
 * Interactive task file creation wizards used by the command palette.
 */
export class TaskFileService {
  /**
 *
 * Runs the "create managed task note" wizard:
 * Prompt until non-empty → createTask → notify → open.
 * Returns the created task row, or null when the user cancelled.
 * The optional onCreated callback fires after creation.
 */
  async createTaskInteractively(
    app: App,
    vault: VaultAdapter,
    settings: TaskWorkbenchSettings,
    promptFn: PromptFn,
    onCreated?: (task: TaskRow) => void,
    create?: (name: string) => Promise<TaskRow>
  ): Promise<TaskRow | null> {
    // the modal "stays open" on empty or whitespace-only
    // input — modeled as a re-prompt loop until valid input or cancellation
    let name: string | null;
    for (;;) {
      name = await promptFn();
      if (name === null) {
        return null; // user cancelled
      }
      if (name.trim() !== "") {
        break;
      }
    }

    // create and save the new managed task note
    const task = create ? await create(name) : await createTask(vault, settings, name);

    // display a notification
    new Notice(`タスクを作成しました: ${task.displayName}`);

    // open the new file automatically
    await this.openInEditor(app, task.file.path);

    // invoke the completion callback
    if (onCreated) {
      onCreated(task);
    }

    return task;
  }

  /**
 *
 * Runs the "add subtask under an explicit parent row" wizard used by the
 * Workbench's 「+」 button. Unlike addSubtaskToCurrentFileInteractively,
 * which resolves the parent from the active file, this method receives the
 * parent TaskRow directly. It uses the same prompt-until-non-empty flow as
 * createTaskInteractively.
 * Returns the created subtask row, or null on cancel.
 */
  async addSubtaskInteractively(
    app: App,
    vault: VaultAdapter,
    settings: TaskWorkbenchSettings,
    parentRow: TaskRow,
    promptFn: PromptFn,
    onCreated?: (task: TaskRow) => void
  ): Promise<TaskRow | null> {
    let name: string | null;
    for (;;) {
      name = await promptFn();
      if (name === null) {
        return null; // user cancelled
      }
      if (name.trim() !== "") {
        break;
      }
    }

    const subtask = await addSubtask(vault, settings, parentRow, name);
    new Notice(`サブタスクを追加しました: ${subtask.displayName}`);
    await this.openInEditor(app, parentRow.file.path);

    if (onCreated) {
      onCreated(subtask);
    }

    return subtask;
  }

  /**
 *
 * Runs the "add subtask to current note" wizard.
 * The current file must be a managed task file; otherwise an error
 * message is shown and nothing is written.
 * Returns the created subtask row, or null on cancel / non-managed file.
 */
  async addSubtaskToCurrentFileInteractively(
    app: App,
    vault: VaultAdapter,
    settings: TaskWorkbenchSettings,
    currentFilePath: string,
    promptFn: PromptFn
  ): Promise<TaskRow | null> {
    void app; // reserved for future post-write navigation

    // managed-task detection for the current file
    const file = vault.getFileByPath(currentFilePath);
    let parent: TaskRow | null = null;
    if (file) {
      const content = await vault.read(file);
      parent = parseTaskFile({ path: file.path }, content, settings);
    }

    if (!parent) {
      // error message when not under management
      new Notice(
        "現在のファイルは Task Workbench の管理下タスクではありません"
      );
      return null;
    }

    // Start the subtask wizard with the same prompt validation as above.
    let name: string | null;
    for (;;) {
      name = await promptFn();
      if (name === null) {
        return null; // user cancelled
      }
      if (name.trim() !== "") {
        break;
      }
    }

    // addSubtask writes the subtask into the file and re-parses
    const subtask = await addSubtask(vault, settings, parent, name);
    new Notice(`サブタスクを追加しました: ${subtask.displayName}`);
    return subtask;
  }

  /**
 * Opens a vault file in a new editor leaf.
 */
  private async openInEditor(app: App, path: string): Promise<void> {
    const abstract = app.vault.getAbstractFileByPath(path);
    if (!(abstract instanceof TFile)) {
      return; // file vanished between create and open — nothing to open
    }
    const leaf = app.workspace.getLeaf(true);
    await leaf.openFile(abstract);
  }
}

/**
 * minimal single-input prompt modal used by the production
 * promptFn. Resolves the prompt promise with the entered text on OK/Enter,
 * or null on cancel (Escape / close without submit).
 */
class PromptModal extends Modal {
  private value: string;
  private settled = false;

  constructor(
    app: App,
    defaultValue: string,
    private readonly onSubmit: (value: string | null) => void
  ) {
    super(app);
    this.value = defaultValue;
  }

  onOpen(): void {
    this.contentEl.replaceChildren();
    new Setting(this.contentEl)
      .setName("タスク名")
      .addText((text) => {
        text.setValue(this.value);
        text.onChange((value: string) => {
          this.value = value;
        });
        text.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
          if (event.key === "Enter") {
            event.preventDefault();
            this.submit();
          }
        });
      })
      .addButton((button) => {
        button.setButtonText("OK").setCta().onClick(() => this.submit());
      });
  }

  onClose(): void {
    // Escape / programmatic close without submit counts as cancellation
    this.finish(null);
    this.contentEl.replaceChildren();
  }

  private submit(): void {
    this.finish(this.value);
    this.close();
  }

  private finish(value: string | null): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.onSubmit(value);
  }
}

/**
 * Production PromptFn factory: opens a PromptModal and resolves on submit
 * or cancel.
 */
export function modalPrompt(app: App): PromptFn {
  return (defaultValue?: string) =>
    new Promise<string | null>((resolve) => {
      new PromptModal(app, defaultValue ?? "", resolve).open();
    });
}
