import { Notice, TFile } from "obsidian";
import type { App, TFolder, Vault } from "obsidian";


interface TemplaterApi {
  create_new_note_from_template(
    template: TFile | string,
    folder?: TFolder | string,
    filename?: string,
    open_new_note?: boolean
  ): Promise<TFile | undefined>;
}

interface ObsidianAppInternals {
  plugins?: {
    plugins?: Record<string, unknown>;
  };
  internalPlugins?: {
    getPluginById?: (id: string) => unknown;
  };
}

export interface ConfiguredDailyNoteSettings {
  folder: string;
  format: string;
  templatePath?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function readDailyNoteSettings(
  value: unknown,
  requireEnabled: boolean
): ConfiguredDailyNoteSettings | null {
  const options = asRecord(value);
  if (!options || (requireEnabled && options.enabled !== true)) {
    return null;
  }
  if (
    typeof options.folder !== "string" ||
    typeof options.format !== "string"
  ) {
    return null;
  }

  const result: ConfiguredDailyNoteSettings = {
    folder: options.folder,
    format: options.format,
  };
  if (typeof options.template === "string" && options.template !== "") {
    result.templatePath = options.template;
  }
  return result;
}

function getTemplaterApi(app: App): TemplaterApi | null {
  const internals = app as unknown as ObsidianAppInternals;
  const plugin = asRecord(
    internals.plugins?.plugins?.["templater-obsidian"]
  );
  const templater = asRecord(plugin?.templater);
  if (
    !templater ||
    typeof templater.create_new_note_from_template !== "function"
  ) {
    return null;
  }
  return templater as unknown as TemplaterApi;
}

/**
 *
 * Ensures the parent folder of `path` exists. Obsidian's createFolder also
 * creates missing intermediate folders, so one call is sufficient. Only the
 * documented already-exists race is swallowed; all other errors propagate.
 */
export async function ensureParentFolderExists(
  vault: Vault,
  path: string
): Promise<void> {
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash === -1) {
    // No parent folder component — nothing to create.
    return;
  }
  const parentPath = path.slice(0, lastSlash);
  if (vault.getAbstractFileByPath(parentPath)) {
    return;
  }
  try {
    await vault.createFolder(parentPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/already exists/i.test(message)) {
      throw err;
    }
  }
}

/**
 *
 * Creates a daily note at an already-resolved vault-relative path. Templater
 * receives the template file, parent folder, and basename without `.md`; its
 * API appends the markdown extension and processes the template before the
 * newly-created file is returned.
 */
export async function createDailyTodoFile(
  app: App,
  path: string,
  templatePath?: string
): Promise<TFile | null> {
  await ensureParentFolderExists(app.vault, path);

  if (!templatePath) {
    return app.vault.create(path, "");
  }

  const templateAbstract = app.vault.getAbstractFileByPath(templatePath);
  if (!(templateAbstract instanceof TFile)) {
    new Notice(
      `テンプレートが見つからないため、空のデイリーノートを作成しました: ${templatePath}`
    );
    return app.vault.create(path, "");
  }

  const folderEnd = path.lastIndexOf("/");
  const folder = folderEnd === -1 ? undefined : path.slice(0, folderEnd);
  const filename = path.slice(folderEnd + 1).replace(/\.md$/i, "");
  const templater = getTemplaterApi(app);
  if (templater) {
    try {
      const created = await templater.create_new_note_from_template(
        templateAbstract,
        folder,
        filename,
        false
      );
      if (created) {
        return created;
      }
    } catch (error) {
      // A failed Templater run is recoverable by copying the raw template.
      console.warn(
        "Daily ToDo: Templaterでテンプレートを処理できませんでした",
        error
      );
    }
  }

  const rawText = await app.vault.cachedRead(templateAbstract);
  new Notice(
    "テンプレートを展開できなかったため、そのままコピーしました（Templaterが無効か、テンプレート処理に失敗しました）"
  );
  return app.vault.create(path, rawText);
}

/**
 *
 * Reads the user's configured daily-note settings for a future import UI.
 * Periodic Notes takes precedence over the core Daily notes plugin.
 */
export function detectConfiguredDailyNoteSettings(
  app: App
): ConfiguredDailyNoteSettings | null {
  const internals = app as unknown as ObsidianAppInternals;
  const periodic = asRecord(
    internals.plugins?.plugins?.["periodic-notes"]
  );
  const periodicSettings = asRecord(periodic?.settings);
  const periodicDaily = periodicSettings?.daily ?? periodic?.daily;
  const periodicResult = readDailyNoteSettings(periodicDaily, true);
  if (periodicResult) {
    return periodicResult;
  }

  const dailyNotesPlugin = asRecord(
    internals.internalPlugins?.getPluginById?.("daily-notes")
  );
  if (!dailyNotesPlugin || dailyNotesPlugin.enabled !== true) {
    return null;
  }
  const instance = asRecord(dailyNotesPlugin.instance);
  return readDailyNoteSettings(instance?.options, false);
}
