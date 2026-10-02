import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { Notice, TFile, TFolder } from "obsidian";
import type { App, Vault } from "obsidian";
import {
  createDailyTodoFile,
  detectConfiguredDailyNoteSettings,
} from "../../src/app/daily-note-creation";


vi.mock("obsidian", async (importOriginal) => {
  const actual = await importOriginal<typeof import("obsidian")>();
  return { ...actual, Notice: vi.fn() };
});

const NoticeMock = Notice as unknown as Mock;

function makeFile(path: string, content: string): TFile {
  const file = new TFile();
  file.path = path;
  file.name = path.slice(path.lastIndexOf("/") + 1);
  file.basename = file.name.replace(/\.md$/i, "");
  file.extension = "md";
  (file as unknown as { stat: { mtime: number; size: number; ctime: number } }).stat = {
    mtime: 1,
    size: content.length,
    ctime: 1,
  };
  return file;
}

function makeFakeApp(initialFiles: Record<string, string> = {}): {
  app: App;
  createSpy: ReturnType<typeof vi.fn>;
  createFolderSpy: ReturnType<typeof vi.fn>;
  getContent: (path: string) => string | undefined;
} {
  const files = new Map(Object.entries(initialFiles));
  const folders = new Set<string>();
  const addFolderAndParents = (path: string): void => {
    const parts = path.split("/");
    for (let index = 1; index <= parts.length; index += 1) {
      folders.add(parts.slice(0, index).join("/"));
    }
  };
  const createFolderSpy = vi.fn(async (path: string) => {
    addFolderAndParents(path);
  });
  const createSpy = vi.fn(async (path: string, content: string) => {
    files.set(path, content);
    return makeFile(path, content);
  });
  const cachedReadSpy = vi.fn(async (file: TFile) => {
    const content = files.get(file.path);
    if (content === undefined) {
      throw new Error(`fake vault: file not found: ${file.path}`);
    }
    return content;
  });
  const vault = {
    getAbstractFileByPath: (path: string): TFile | TFolder | null => {
      const content = files.get(path);
      if (content !== undefined) {
        return makeFile(path, content);
      }
      if (folders.has(path)) {
        const folder = new TFolder();
        folder.path = path;
        folder.name = path.slice(path.lastIndexOf("/") + 1);
        return folder;
      }
      return null;
    },
    createFolder: createFolderSpy,
    create: createSpy,
    cachedRead: cachedReadSpy,
  } as unknown as Vault;

  return {
    app: { vault } as unknown as App,
    createSpy,
    createFolderSpy,
    getContent: (path: string) => files.get(path),
  };
}

describe("daily-note-creation", () => {
  beforeEach(() => {
    NoticeMock.mockClear();
  });

  it("creates missing parent folders before creating a blank note", async () => {
    const { app, createFolderSpy, createSpy, getContent } = makeFakeApp();

    const file = await createDailyTodoFile(
      app,
      "デイリー/2026/08/260828_デイリー.md"
    );

    expect(file?.path).toBe("デイリー/2026/08/260828_デイリー.md");
    expect(createFolderSpy).toHaveBeenCalledWith("デイリー/2026/08");
    expect(createSpy).toHaveBeenCalledWith(
      "デイリー/2026/08/260828_デイリー.md",
      ""
    );
    expect(getContent("デイリー/2026/08/260828_デイリー.md")).toBe("");
    expect(NoticeMock).not.toHaveBeenCalled();
  });

  it("copies raw template text when Templater is unavailable", async () => {
    const templatePath = "templates/daily.md";
    const rawText = "# 日記\n<% tp.date.now() %>";
    const { app, getContent } = makeFakeApp({ [templatePath]: rawText });
    (app as unknown as { plugins: unknown }).plugins = { plugins: {} };

    await createDailyTodoFile(
      app,
      "デイリー/2026/08/260829_デイリー.md",
      templatePath
    );

    expect(getContent("デイリー/2026/08/260829_デイリー.md")).toBe(rawText);
    expect(NoticeMock).toHaveBeenCalledWith(
      "テンプレートを展開できなかったため、そのままコピーしました（Templaterが無効か、テンプレート処理に失敗しました）"
    );
  });

  it("uses Templater processing and passes an extensionless basename", async () => {
    const templatePath = "templates/daily.md";
    const { app, getContent, createSpy } = makeFakeApp({
      [templatePath]: "raw",
    });
    const templaterCall = vi.fn(async () =>
      app.vault.create("デイリー/2026/08/260830_デイリー.md", "processed")
    );
    (app as unknown as { plugins: unknown }).plugins = {
      plugins: {
        "templater-obsidian": {
          templater: { create_new_note_from_template: templaterCall },
        },
      },
    };

    const file = await createDailyTodoFile(
      app,
      "デイリー/2026/08/260830_デイリー.md",
      templatePath
    );

    expect(file?.path).toBe("デイリー/2026/08/260830_デイリー.md");
    expect(templaterCall).toHaveBeenCalledWith(
      expect.any(TFile),
      "デイリー/2026/08",
      "260830_デイリー",
      false
    );
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(getContent("デイリー/2026/08/260830_デイリー.md")).toBe("processed");
    expect(NoticeMock).not.toHaveBeenCalled();
  });

  it("falls back to raw text when Templater returns undefined", async () => {
    const templatePath = "templates/daily.md";
    const rawText = "raw <% dynamic %>";
    const { app, getContent } = makeFakeApp({ [templatePath]: rawText });
    const templaterCall = vi.fn(async () => undefined);
    (app as unknown as { plugins: unknown }).plugins = {
      plugins: {
        "templater-obsidian": {
          templater: { create_new_note_from_template: templaterCall },
        },
      },
    };

    await createDailyTodoFile(
      app,
      "デイリー/2026/08/260831_デイリー.md",
      templatePath
    );

    expect(templaterCall).toHaveBeenCalledTimes(1);
    expect(getContent("デイリー/2026/08/260831_デイリー.md")).toBe(rawText);
    expect(NoticeMock).toHaveBeenCalledTimes(1);
  });

  it("creates a blank note and warns when the template path is stale", async () => {
    const { app, getContent } = makeFakeApp();

    await createDailyTodoFile(
      app,
      "デイリー/2026/08/260832_デイリー.md",
      "templates/missing.md"
    );

    expect(getContent("デイリー/2026/08/260832_デイリー.md")).toBe("");
    expect(NoticeMock).toHaveBeenCalledWith(
      "テンプレートが見つからないため、空のデイリーノートを作成しました: templates/missing.md"
    );
  });

  it("detects enabled Periodic Notes daily settings first", () => {
    const app = {
      plugins: {
        plugins: {
          "periodic-notes": {
            settings: {
              daily: {
                enabled: true,
                folder: "定期ノート/日次",
                format: "YYYY-MM-DD",
                template: "templates/periodic.md",
              },
            },
          },
        },
        internalPlugins: {
          getPluginById: vi.fn(),
        },
      },
    } as unknown as App;

    expect(detectConfiguredDailyNoteSettings(app)).toEqual({
      folder: "定期ノート/日次",
      format: "YYYY-MM-DD",
      templatePath: "templates/periodic.md",
    });
  });

  it("detects enabled core Daily notes settings", () => {
    const getPluginById = vi.fn(() => ({
      enabled: true,
      instance: {
        options: {
          folder: "デイリー",
          format: "YYYY/MM/DD",
          template: "templates/core.md",
        },
      },
    }));
    const app = {
      internalPlugins: { getPluginById },
    } as unknown as App;

    expect(detectConfiguredDailyNoteSettings(app)).toEqual({
      folder: "デイリー",
      format: "YYYY/MM/DD",
      templatePath: "templates/core.md",
    });
    expect(getPluginById).toHaveBeenCalledWith("daily-notes");
  });

  it("returns null when neither daily-note plugin is configured", () => {
    const getPluginById = vi.fn(() => ({ enabled: false }));
    const app = {
      plugins: { plugins: {} },
      internalPlugins: { getPluginById },
    } as unknown as App;

    expect(detectConfiguredDailyNoteSettings(app)).toBeNull();
  });
});
