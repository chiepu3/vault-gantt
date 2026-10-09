import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Mock } from "vitest";

import { Notice, TFile, moment } from "obsidian";

import type { App, Vault, Workspace } from "obsidian";
import { DEFAULT_SETTINGS } from "../../src/core/constants";
import {
  DailyTodoService,
  deleteDailyTodoItem,
  extractDateFromDailyPath as extractConfiguredDate,
  getDailyTodoInsertIndex,
  getDailyTodoPathForDate,
  getDailyTodoSourceForPath,
  getDailyTodoSources,
  getMainDailyTodoFile,
  insertDailyTodoItems,
  isDailyNoteFile,
  openDailyTodoEditor,
  openDailyTodoFile,
  openOrCreateMainDailyTodoForDate,
  parseDailyTodos,
  requireMainDailyTodoFile,
  updateDailyTodoItem,
  updateDailyTodos,
} from "../../src/app/daily-todo-service";
import type { DailyTodoItem, DailyTodoSummary, TaskWorkbenchSettings } from "../../src/core/types";

vi.mock("obsidian", async (importOriginal) => {
  const actual = await importOriginal<typeof import("obsidian")>();
  return { ...actual, Notice: vi.fn() };
});

const NoticeMock = Notice as unknown as Mock;
const extractDefaultDate = (path?: string): string =>
  extractConfiguredDate(path, DEFAULT_SETTINGS);

/**
 * Minimal fake Vault: a Map of path -> {content, mtime, size} plus every
 * method the read half (loadDailyTodoSummaries: getMarkdownFiles,
 * cachedRead) and the write half (updateDailyTodoItem/deleteDailyTodoItem/
 * insertDailyTodoItems/updateDailyTodos: getAbstractFileByPath, read,
 * modify, process) actually call. Mirrors the fakeApp/vaultApi idiom already used in
 * tests/main.test.ts (plain object + `as unknown as Vault` cast), which is
 * this repo's established pattern for faking Obsidian's Vault API without
 * needing a full obsidian App instance. Files are real `TFile` instances
 * (not plain-object casts) so production code's `instanceof TFile` checks
 * — used throughout the write-half functions below — actually pass.
 */
function makeFile(path: string, mtime: number, size: number): TFile {
  const file = new TFile();
  file.path = path;
  (file as unknown as { stat: { mtime: number; size: number; ctime: number } }).stat = {
    mtime,
    size,
    ctime: mtime,
  };
  return file;
}

function makeFakeVault(
  initialFiles: Record<string, string> = {}
): {
  vault: Vault;
  app: App;
  cachedReadSpy: ReturnType<typeof vi.fn>;
  createSpy: ReturnType<typeof vi.fn>;
  modifySpy: ReturnType<typeof vi.fn>;
  setFile: (path: string, content: string, mtime?: number) => void;
  removeFile: (path: string) => void;
  getContent: (path: string) => string | undefined;
} {
  const files = new Map<
    string,
    { content: string; mtime: number; size: number }
  >();
  let clock = 1;

  for (const [path, content] of Object.entries(initialFiles)) {
    files.set(path, { content, mtime: clock++, size: content.length });
  }

  const cachedReadSpy = vi.fn(async (file: TFile) => {
    const entry = files.get(file.path);
    if (!entry) {
      throw new Error(`fake vault: file not found: ${file.path}`);
    }
    return entry.content;
  });

  const modifySpy = vi.fn(async (file: TFile, content: string) => {
    const entry = files.get(file.path);
    if (!entry) {
      throw new Error(`fake vault: file not found: ${file.path}`);
    }
    entry.content = content;
    entry.mtime = clock++;
    entry.size = content.length;
  });

  const createSpy = vi.fn(async (path: string, content: string) => {
    const mtime = clock++;
    files.set(path, { content, mtime, size: content.length });
    return makeFile(path, mtime, content.length);
  });

  const vault = {
    getMarkdownFiles: () =>
      Array.from(files.entries()).map(([path, e]) =>
        makeFile(path, e.mtime, e.size)
      ),
    cachedRead: cachedReadSpy,
    read: vi.fn(async (file: TFile) => {
      const entry = files.get(file.path);
      if (!entry) {
        throw new Error(`fake vault: file not found: ${file.path}`);
      }
      return entry.content;
    }),
    modify: modifySpy,
    process: vi.fn(async (file: TFile, transform: (content: string) => string) => {
      const entry = files.get(file.path);
      if (!entry) {
        throw new Error(`fake vault: file not found: ${file.path}`);
      }
      const content = transform(entry.content);
      await modifySpy(file, content);
      return content;
    }),
    create: createSpy,
    createFolder: vi.fn(async () => undefined),
    getAbstractFileByPath: (path: string) => {
      const entry = files.get(path);
      if (!entry) {
        return null;
      }
      return makeFile(path, entry.mtime, entry.size);
    },
  } as unknown as Vault;

  const app = { vault } as unknown as App;

  return {
    vault,
    app,
    cachedReadSpy,
    createSpy,
    modifySpy,
    setFile: (path: string, content: string, mtime?: number) => {
      files.set(path, {
        content,
        mtime: mtime ?? clock++,
        size: content.length,
      });
    },
    removeFile: (path: string) => {
      files.delete(path);
    },
    getContent: (path: string) => files.get(path)?.content,
  };
}

function appFor(vault: Vault): App {
  return { vault } as unknown as App;
}

describe("daily-todo-service", () => {

  describe("getDailyTodoSources / getDailyTodoPathForDate", () => {
    it("returns the configured main and meeting source definitions", () => {
      const sources = getDailyTodoSources(DEFAULT_SETTINGS);
      expect(sources).toEqual(DEFAULT_SETTINGS.dailyTodoSources);
      expect(sources).toHaveLength(2);
      expect(sources[0]).toMatchObject({
        key: "main",
        label: "デイリー",
        format: "[デイリー]/YYYY/MM/YYMMDD_[デイリー]",
        creatableFromGantt: true,
      });
      expect(sources[1]).toMatchObject({
        key: "meeting",
        label: "デイリーミーティング",
        format: "[デイリーミーティング]/YYYY/MM/MMDD_[デイリーミーティング]",
        creatableFromGantt: false,
      });
    });

    it("returns a defensive array copy and respects an empty setting", () => {
      const a = getDailyTodoSources(DEFAULT_SETTINGS);
      a.pop();
      expect(getDailyTodoSources(DEFAULT_SETTINGS)).toHaveLength(2);
      expect(getDailyTodoSources({
        ...DEFAULT_SETTINGS,
        dailyTodoSources: [],
      })).toEqual([]);
    });

    it("builds exact default paths and falls back to the first source", () => {
      expect(getDailyTodoPathForDate("2026-07-25", "main", DEFAULT_SETTINGS)).toBe(
        "デイリー/2026/07/260725_デイリー.md"
      );
      expect(getDailyTodoPathForDate("2026-07-25", "meeting", DEFAULT_SETTINGS)).toBe(
        "デイリーミーティング/2026/07/0725_デイリーミーティング.md"
      );
      expect(getDailyTodoPathForDate("2026-07-25", "nonexistent", DEFAULT_SETTINGS)).toBe(
        "デイリー/2026/07/260725_デイリー.md"
      );
      expect(getDailyTodoPathForDate("2026-07-25", "main", {
        ...DEFAULT_SETTINGS,
        dailyTodoSources: [],
      })).toBe("");
    });

    it("supports a custom format and round-trips its date", () => {
      const settings: TaskWorkbenchSettings = {
        ...DEFAULT_SETTINGS,
        dailyTodoSources: [
          {
            key: "custom",
            label: "カスタム",
            format: "カスタム/DD-YYYY-MM_日付",
            creatableFromGantt: true,
          },
        ],
      };
      const path = getDailyTodoPathForDate("2026-07-25", "custom", settings);

      expect(path).toBe("カスタム/25-2026-07_日付.md");
      expect(extractConfiguredDate(path, settings)).toBe("2026-07-25");
    });

    it("supports bracket-escaped Latin literals and round-trips through source matching", () => {
      const settings: TaskWorkbenchSettings = {
        ...DEFAULT_SETTINGS,
        dailyTodoSources: [
          {
            key: "journal",
            label: "ジャーナル",
            format: "[Journal]/YYYY-MM-DD",
            creatableFromGantt: true,
          },
        ],
      };
      const path = getDailyTodoPathForDate("2026-07-25", "journal", settings);

      expect(path).toBe("Journal/2026-07-25.md");
      expect(getDailyTodoSourceForPath(path, settings)?.key).toBe("journal");
      expect(extractConfiguredDate(path, settings)).toBe("2026-07-25");
    });
  });


  describe("getDailyTodoSourceForPath / isDailyNoteFile", () => {
    it("matches the main folder", () => {
      const source = getDailyTodoSourceForPath(
        "デイリー/2026/07/260725_デイリー.md",
        DEFAULT_SETTINGS
      );
      expect(source?.key).toBe("main");
    });

    it("matches the meeting folder", () => {
      const source = getDailyTodoSourceForPath(
        "デイリーミーティング/2026/07/0725_デイリーミーティング.md",
        DEFAULT_SETTINGS
      );
      expect(source?.key).toBe("meeting");
    });

    it("returns null for a path outside either folder", () => {
      expect(getDailyTodoSourceForPath("notes/random.md", DEFAULT_SETTINGS)).toBeNull();
      expect(getDailyTodoSourceForPath(undefined, DEFAULT_SETTINGS)).toBeNull();
    });

    it("accepts backslash-separated paths", () => {
      const source = getDailyTodoSourceForPath(
        "デイリー\\2026\\07\\260725_デイリー.md",
        DEFAULT_SETTINGS
      );
      expect(source?.key).toBe("main");
    });

    it("first match wins when the same key is defined earlier", () => {
      // main is declared before meeting; a main-folder path must resolve to
      // main even though "デイリー" is also a substring of "デイリーミーティング".
      const source = getDailyTodoSourceForPath(
        "デイリー/2026/01/foo.md",
        DEFAULT_SETTINGS
      );
      expect(source?.key).toBe("main");
    });

    it("isDailyNoteFile mirrors getDailyTodoSourceForPath", () => {
      expect(
        isDailyNoteFile(
          makeFile("デイリー/2026/07/260725_デイリー.md", 1, 1),
          DEFAULT_SETTINGS
        )
      ).toBe(true);
      expect(
        isDailyNoteFile(makeFile("notes/random.md", 1, 1), DEFAULT_SETTINGS)
      ).toBe(false);
    });
  });

  describe("parseDailyTodos", () => {
    it("extracts checkbox items with placeholder identity fields", () => {
      const content = [
        "# Heading",
        "- [ ] todo one",
        "- [x] todo two done",
        "not a checkbox line",
      ].join("\n");

      const items = parseDailyTodos(content);
      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({
        sourceKey: "",
        sourceLabel: "",
        path: "",
        line: 1,
        originalLine: "- [ ] todo one",
        text: "todo one",
        completed: false,
        isNew: false,
      });
      expect(items[1]).toMatchObject({
        line: 2,
        text: "todo two done",
        completed: true,
      });
    });

    it("uppercase X counts as completed", () => {
      const items = parseDailyTodos("- [X] shouting done");
      expect(items[0].completed).toBe(true);
    });

    it("allows indentation and '*' bullets", () => {
      const items = parseDailyTodos("  * [ ] indented star bullet");
      expect(items).toHaveLength(1);
      expect(items[0].text).toBe("indented star bullet");
    });

    it("empty text is recorded, not skipped", () => {
      const items = parseDailyTodos("- [ ] ");
      expect(items).toHaveLength(1);
      expect(items[0].text).toBe("");
    });

    it("only the first bracket marker is recognized as state", () => {
      const items = parseDailyTodos("- [x] [x] double marker");
      expect(items).toHaveLength(1);
      expect(items[0].completed).toBe(true);
      expect(items[0].text).toBe("[x] double marker");
    });

    it("handles CRLF line endings without shifting line numbers", () => {
      const content = "line0\r\n- [ ] task\r\nline2";
      const items = parseDailyTodos(content);
      expect(items).toHaveLength(1);
      expect(items[0].line).toBe(1);
      expect(items[0].text).toBe("task");
    });

    it("returns an empty array for content with no checkboxes", () => {
      expect(parseDailyTodos("# just a heading\nsome text")).toEqual([]);
    });
  });

  describe("extractDateFromDailyPath", () => {
    it("6-digit YYMMDD main pattern", () => {
      expect(
        extractDefaultDate("デイリー/2026/07/260725_デイリー.md")
      ).toBe("2026-07-25");
    });

    it("4-digit MMDD meeting pattern with year from path segment", () => {
      expect(
        extractDefaultDate(
          "デイリーミーティング/2026/07/0725_デイリーミーティング.md"
        )
      ).toBe("2026-07-25");
    });

    it("falls back to the current year when no year segment is present", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-01T00:00:00Z"));
      try {
        expect(
          extractDefaultDate("0725_デイリーミーティング.md")
        ).toBe("2026-07-25");
      } finally {
        vi.useRealTimers();
      }
    });

    it("ISO/separated pattern", () => {
      expect(extractDefaultDate("notes/2026-07-25.md")).toBe(
        "2026-07-25"
      );
      expect(extractDefaultDate("notes/2026_07_25.md")).toBe(
        "2026-07-25"
      );
    });

    it("8-digit compact pattern", () => {
      expect(extractDefaultDate("notes/20260725.md")).toBe(
        "2026-07-25"
      );
    });

    it("returns empty string when nothing matches", () => {
      expect(extractDefaultDate("notes/random.md")).toBe("");
      expect(extractDefaultDate(undefined)).toBe("");
    });

    it("pattern priority: a main-pattern path is not mistaken for compact/ISO", () => {
      expect(
        extractDefaultDate("デイリー/2026/07/260725_デイリー.md")
      ).toBe("2026-07-25");
    });


    it("documents the unescaped Latin-literal fallback behavior", () => {
      const settings: TaskWorkbenchSettings = {
        ...DEFAULT_SETTINGS,
        dailyTodoSources: [
          {
            key: "journal",
            label: "ジャーナル",
            format: "Journal/YYYY-MM-DD",
            creatableFromGantt: false,
          },
        ],
      };
      const path = "Journal/2026-07-25.md";

      expect(
        moment(
          path.replace(/\.md$/i, ""),
          "Journal/YYYY-MM-DD",
          true
        ).isValid()
      ).toBe(false);
      expect(extractConfiguredDate(path, settings)).toBe("2026-07-25");
    });

  });

  describe("DailyTodoService.loadDailyTodoSummaries", () => {
    let service: DailyTodoService;

    beforeEach(() => {
      service = new DailyTodoService();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("scans, filters to daily-note folders, and aggregates by date", async () => {
      const { vault } = makeFakeVault({
        "デイリー/2026/07/260725_デイリー.md": [
          "## ToDoリスト",
          "- [ ] main task one",
          "- [x] main task two",
        ].join("\n"),
        "デイリーミーティング/2026/07/0725_デイリーミーティング.md": [
          "- [ ] meeting task",
        ].join("\n"),
        "notes/random.md": "- [ ] not a daily note, must be ignored",
      });

      const summaries = await service.loadDailyTodoSummaries(vault, DEFAULT_SETTINGS);

      expect(summaries).toHaveLength(1);
      const summary = summaries[0];
      expect(summary.date).toBe("2026-07-25");
      expect(summary.totalCount).toBe(3);
      expect(summary.completedCount).toBe(1);

      // main + meeting items merged into one summary,
      // each item tagged with its own source.
      const bySource = new Map(
        summary.items.map((item) => [item.text, item.sourceKey])
      );
      expect(bySource.get("main task one")).toBe("main");
      expect(bySource.get("main task two")).toBe("main");
      expect(bySource.get("meeting task")).toBe("meeting");

      const mainItem = summary.items.find((i) => i.text === "main task one")!;
      expect(mainItem.sourceLabel).toBe("デイリー");
      expect(mainItem.path).toBe("デイリー/2026/07/260725_デイリー.md");
    });

    it("scans a user-defined source format", async () => {
      const settings: TaskWorkbenchSettings = {
        ...DEFAULT_SETTINGS,
        dailyTodoSources: [
          {
            key: "custom",
            label: "カスタム",
            format: "カスタム/DD-YYYY-MM_日付",
            creatableFromGantt: true,
          },
        ],
      };
      const path = "カスタム/25-2026-07_日付.md";
      const { vault } = makeFakeVault({ [path]: "- [ ] custom task" });

      const summaries = await service.loadDailyTodoSummaries(vault, settings);

      expect(summaries[0].date).toBe("2026-07-25");
      expect(summaries[0].items[0]).toMatchObject({
        sourceKey: "custom",
        sourceLabel: "カスタム",
        path,
        text: "custom task",
      });
    });

    it("excludes dates whose files have zero checkbox items", async () => {
      const { vault } = makeFakeVault({
        "デイリー/2026/07/260725_デイリー.md": "# just a heading, no checkboxes",
      });

      const summaries = await service.loadDailyTodoSummaries(vault, DEFAULT_SETTINGS);
      expect(summaries).toEqual([]);
    });

    it("sorts summaries ascending by date", async () => {
      const { vault } = makeFakeVault({
        "デイリー/2026/07/260728_デイリー.md": "- [ ] later",
        "デイリー/2026/07/260701_デイリー.md": "- [ ] earlier",
      });

      const summaries = await service.loadDailyTodoSummaries(vault, DEFAULT_SETTINGS);
      expect(summaries.map((s) => s.date)).toEqual([
        "2026-07-01",
        "2026-07-28",
      ]);
    });

    it("does not re-read an unchanged file on a second call", async () => {
      const { vault, cachedReadSpy } = makeFakeVault({
        "デイリー/2026/07/260725_デイリー.md": "- [ ] task",
      });

      await service.loadDailyTodoSummaries(vault, DEFAULT_SETTINGS);
      expect(cachedReadSpy).toHaveBeenCalledTimes(1);

      const summaries = await service.loadDailyTodoSummaries(vault, DEFAULT_SETTINGS);
      expect(cachedReadSpy).toHaveBeenCalledTimes(1);
      expect(summaries[0].totalCount).toBe(1);
    });

    it("re-reads a file once its mtime/size changes", async () => {
      const { vault, cachedReadSpy, setFile } = makeFakeVault({
        "デイリー/2026/07/260725_デイリー.md": "- [ ] task",
      });

      await service.loadDailyTodoSummaries(vault, DEFAULT_SETTINGS);
      expect(cachedReadSpy).toHaveBeenCalledTimes(1);

      setFile(
        "デイリー/2026/07/260725_デイリー.md",
        "- [ ] task\n- [x] task two",
        999
      );

      const summaries = await service.loadDailyTodoSummaries(vault, DEFAULT_SETTINGS);
      expect(cachedReadSpy).toHaveBeenCalledTimes(2);
      expect(summaries[0].totalCount).toBe(2);
    });

    it("drops the cache entry for a file that was deleted", async () => {
      const { vault, removeFile } = makeFakeVault({
        "デイリー/2026/07/260725_デイリー.md": "- [ ] task",
      });

      const first = await service.loadDailyTodoSummaries(vault, DEFAULT_SETTINGS);
      expect(first).toHaveLength(1);

      removeFile("デイリー/2026/07/260725_デイリー.md");

      const second = await service.loadDailyTodoSummaries(vault, DEFAULT_SETTINGS);
      expect(second).toEqual([]);
    });

    it("a read failure with no prior cache skips just that file, other files still load, no throw", async () => {
      // makeFakeVault's getMarkdownFiles preserves Map insertion order, so
      // the first-inserted file (260725) is the first cachedRead call and
      // is the one mockImplementationOnce makes fail.
      const { vault, cachedReadSpy } = makeFakeVault({
        "デイリー/2026/07/260725_デイリー.md": "- [ ] good task",
        "デイリー/2026/07/260726_デイリー.md": "- [ ] also good",
      });
      cachedReadSpy.mockImplementationOnce(async () => {
        throw new Error("simulated disk read failure");
      });

      const summaries = await service.loadDailyTodoSummaries(vault, DEFAULT_SETTINGS);

      // The broken file contributed nothing; the other file's date still
      // loaded, and the failure did not propagate out as a rejection.
      expect(summaries).toHaveLength(1);
      expect(summaries[0].date).toBe("2026-07-26");
    });

    it("a read failure on a file with a prior cache entry falls back to the stale cache instead of dropping it", async () => {
      const { vault, cachedReadSpy, setFile } = makeFakeVault({
        "デイリー/2026/07/260725_デイリー.md": "- [ ] cached task",
      });

      const first = await service.loadDailyTodoSummaries(vault, DEFAULT_SETTINGS);
      expect(first[0].totalCount).toBe(1);
      expect(first[0].items[0].text).toBe("cached task");

      // Bump mtime (forces the cache-miss branch) but make the re-read fail.
      setFile("デイリー/2026/07/260725_デイリー.md", "- [ ] cached task\n- [ ] new", 999);
      cachedReadSpy.mockImplementationOnce(async () => {
        throw new Error("simulated disk read failure");
      });

      const second = await service.loadDailyTodoSummaries(vault, DEFAULT_SETTINGS);

      // Falls back to the last successfully-cached parse rather than
      // throwing out of loadDailyTodoSummaries or silently dropping the date.
      expect(second).toHaveLength(1);
      expect(second[0].totalCount).toBe(1);
      expect(second[0].items[0].text).toBe("cached task");
    });
  });

  function todoItem(overrides: Partial<DailyTodoItem> = {}): DailyTodoItem {
    return {
      sourceKey: "main",
      sourceLabel: "デイリー",
      path: "デイリー/2026/07/260725_デイリー.md",
      line: 0,
      text: "todo",
      completed: false,
      isNew: false,
      ...overrides,
    };
  }

  describe("updateDailyTodoItem", () => {
    const PATH = "デイリー/2026/07/260725_デイリー.md";

    it("rewrites the line, persists, and syncs the in-memory item", async () => {
      const { vault, modifySpy, getContent } = makeFakeVault({
        [PATH]: ["## ToDoリスト", "- [ ] original", "- [ ] other"].join("\n"),
      });
      const item = todoItem({ path: PATH, line: 1, text: "original" });

      const ok = await updateDailyTodoItem(
        item,
        { text: "edited", completed: true },
        vault
      );

      expect(ok).toBe(true);
      expect(modifySpy).toHaveBeenCalledTimes(1);
      expect(getContent(PATH)).toBe(
        ["## ToDoリスト", "- [x] edited", "- [ ] other"].join("\n")
      );
      expect(item.text).toBe("edited");
      expect(item.completed).toBe(true);
    });

    it("falls back to the item's current text/completed when the patch omits them", async () => {
      const { vault, getContent } = makeFakeVault({
        [PATH]: "- [ ] keep me",
      });
      const item = todoItem({ path: PATH, line: 0, text: "keep me" });

      await updateDailyTodoItem(item, { completed: true }, vault);

      expect(getContent(PATH)).toBe("- [x] keep me");
    });

    it("returns false and touches nothing when path is empty", async () => {
      const { vault, modifySpy } = makeFakeVault({ [PATH]: "- [ ] x" });
      const item = todoItem({ path: "", line: 0 });

      expect(await updateDailyTodoItem(item, { text: "y" }, vault)).toBe(
        false
      );
      expect(modifySpy).not.toHaveBeenCalled();
    });

    it("returns false when line is negative", async () => {
      const { vault } = makeFakeVault({ [PATH]: "- [ ] x" });
      const item = todoItem({ path: PATH, line: -1 });

      expect(await updateDailyTodoItem(item, { text: "y" }, vault)).toBe(
        false
      );
    });

    it("returns false when the file doesn't exist", async () => {
      const { vault } = makeFakeVault({});
      const item = todoItem({ path: "nope.md", line: 0 });

      expect(await updateDailyTodoItem(item, { text: "y" }, vault)).toBe(
        false
      );
    });

    it("returns false when the line index is out of range", async () => {
      const { vault } = makeFakeVault({ [PATH]: "- [ ] only line" });
      const item = todoItem({ path: PATH, line: 5 });

      expect(await updateDailyTodoItem(item, { text: "y" }, vault)).toBe(
        false
      );
    });

    it("returns false when the resulting text is empty after trim", async () => {
      const { vault, modifySpy } = makeFakeVault({ [PATH]: "- [ ] keep" });
      const item = todoItem({ path: PATH, line: 0, text: "keep" });

      expect(
        await updateDailyTodoItem(item, { text: "   " }, vault)
      ).toBe(false);
      expect(modifySpy).not.toHaveBeenCalled();
      expect(item.text).toBe("keep"); // untouched
    });
  });

  describe("deleteDailyTodoItem", () => {
    const PATH = "デイリー/2026/07/260725_デイリー.md";

    it("splices the line out and persists", async () => {
      const { vault, getContent } = makeFakeVault({
        [PATH]: ["- [ ] one", "- [ ] two", "- [ ] three"].join("\n"),
      });
      const item = todoItem({ path: PATH, line: 1 });

      expect(await deleteDailyTodoItem(item, vault)).toBe(true);
      expect(getContent(PATH)).toBe(
        ["- [ ] one", "- [ ] three"].join("\n")
      );
    });

    it("returns false for an invalid path/line", async () => {
      const { vault } = makeFakeVault({ [PATH]: "- [ ] one" });
      expect(
        await deleteDailyTodoItem(todoItem({ path: "", line: 0 }), vault)
      ).toBe(false);
      expect(
        await deleteDailyTodoItem(todoItem({ path: PATH, line: -1 }), vault)
      ).toBe(false);
    });

    it("returns false when line >= lines.length", async () => {
      const { vault } = makeFakeVault({ [PATH]: "- [ ] only" });
      expect(
        await deleteDailyTodoItem(todoItem({ path: PATH, line: 3 }), vault)
      ).toBe(false);
    });

    it("returns false when the file doesn't exist", async () => {
      const { vault } = makeFakeVault({});
      expect(
        await deleteDailyTodoItem(
          todoItem({ path: "missing.md", line: 0 }),
          vault
        )
      ).toBe(false);
    });
  });

  describe("getDailyTodoInsertIndex", () => {
    it("returns EOF when there is no '## ToDoリスト' heading", () => {
      const lines = ["# title", "some text"];
      expect(getDailyTodoInsertIndex(lines)).toBe(lines.length);
    });

    it("only a level-2 heading counts, not level-1 or level-3", () => {
      expect(getDailyTodoInsertIndex(["# ToDoリスト", "body"])).toBe(2);
      expect(getDailyTodoInsertIndex(["### ToDoリスト", "body"])).toBe(2);
    });

    it("returns the position right before the next heading", () => {
      const lines = [
        "## ToDoリスト",
        "- [ ] a",
        "- [ ] b",
        "## 次のセクション",
        "trailing",
      ];
      expect(getDailyTodoInsertIndex(lines)).toBe(3);
    });

    it("returns EOF when the ToDo section runs to the end of the file", () => {
      const lines = ["## ToDoリスト", "- [ ] a", "- [ ] b"];
      expect(getDailyTodoInsertIndex(lines)).toBe(3);
    });
  });

  describe("getMainDailyTodoFile / requireMainDailyTodoFile", () => {
    const PATH = "デイリー/2026/07/260725_デイリー.md";

    beforeEach(() => {
      NoticeMock.mockClear();
    });

    it("getMainDailyTodoFile resolves an existing main daily file", () => {
      const { vault } = makeFakeVault({ [PATH]: "content" });
      const file = getMainDailyTodoFile(
        "2026-07-25",
        appFor(vault),
        DEFAULT_SETTINGS
      );
      expect(file?.path).toBe(PATH);
    });

    it("getMainDailyTodoFile returns null when the file doesn't exist", () => {
      const { vault } = makeFakeVault({});
      expect(
        getMainDailyTodoFile("2026-07-25", appFor(vault), DEFAULT_SETTINGS)
      ).toBeNull();
    });

    it("creates a missing main daily file when the source is creatable", async () => {
      const { vault, getContent } = makeFakeVault({});
      const file = await requireMainDailyTodoFile(
        "2026-07-25",
        appFor(vault),
        DEFAULT_SETTINGS
      );

      expect(file?.path).toBe(PATH);
      expect(getContent(PATH)).toBe("");
      expect(NoticeMock).not.toHaveBeenCalled();
    });

    it("returns the existing file without notifying", async () => {
      const { vault } = makeFakeVault({ [PATH]: "content" });
      const file = await requireMainDailyTodoFile(
        "2026-07-25",
        appFor(vault),
        DEFAULT_SETTINGS
      );

      expect(file?.path).toBe(PATH);
      expect(NoticeMock).not.toHaveBeenCalled();
    });

    it("refuses a non-creatable main source and shows the notice", async () => {
      const { vault, createSpy } = makeFakeVault({});
      const settings: TaskWorkbenchSettings = {
        ...DEFAULT_SETTINGS,
        dailyTodoSources: DEFAULT_SETTINGS.dailyTodoSources.map((source) =>
          source.key === "main" ? { ...source, creatableFromGantt: false } : source
        ),
      };

      const file = await requireMainDailyTodoFile("2026-07-25", appFor(vault), settings);

      expect(file).toBeNull();
      expect(createSpy).not.toHaveBeenCalled();
      expect(NoticeMock).toHaveBeenCalledWith(
        `デイリーノートがまだありません: ${PATH}。Templater等で先に作成してから追加してください。`
      );
    });

    it("refuses gracefully when no main source is configured", async () => {
      const { vault, createSpy } = makeFakeVault({});
      const settings = { ...DEFAULT_SETTINGS, dailyTodoSources: [] };

      const file = await requireMainDailyTodoFile("2026-07-25", appFor(vault), settings);

      expect(file).toBeNull();
      expect(createSpy).not.toHaveBeenCalled();
      expect(NoticeMock).toHaveBeenCalled();
    });
  });

  describe("insertDailyTodoItems", () => {
    const PATH = "デイリー/2026/07/260725_デイリー.md";

    it("inserts converted lines at the ToDo-section insert point", async () => {
      const { vault, getContent } = makeFakeVault({
        [PATH]: ["## ToDoリスト", "- [ ] existing", "## 次"].join("\n"),
      });

      const ok = await insertDailyTodoItems(
        "2026-07-25",
        [
          todoItem({ text: "new one", completed: false }),
          todoItem({ text: "new two", completed: true }),
        ],
        appFor(vault),
        DEFAULT_SETTINGS
      );

      expect(ok).toBe(true);
      expect(getContent(PATH)).toBe(
        [
          "## ToDoリスト",
          "- [ ] existing",
          "- [ ] new one",
          "- [x] new two",
          "## 次",
        ].join("\n")
      );
    });

    it("skips items whose text is empty/whitespace-only", async () => {
      const { vault, getContent } = makeFakeVault({ [PATH]: "## ToDoリスト" });

      await insertDailyTodoItems(
        "2026-07-25",
        [todoItem({ text: "   " }), todoItem({ text: "real one" })],
        appFor(vault),
        DEFAULT_SETTINGS
      );

      expect(getContent(PATH)).toBe(
        ["## ToDoリスト", "- [ ] real one"].join("\n")
      );
    });

    it("returns false (and writes nothing) when every item is filtered out", async () => {
      const { vault, modifySpy } = makeFakeVault({ [PATH]: "## ToDoリスト" });

      const ok = await insertDailyTodoItems(
        "2026-07-25",
        [todoItem({ text: "" }), todoItem({ text: "  " })],
        appFor(vault),
        DEFAULT_SETTINGS
      );

      expect(ok).toBe(false);
      expect(modifySpy).not.toHaveBeenCalled();
    });

    it("creates the missing main file before inserting a new item", async () => {
      NoticeMock.mockClear();
      const { vault, getContent } = makeFakeVault({});

      const ok = await insertDailyTodoItems(
        "2026-07-25",
        [todoItem({ text: "x" })],
        appFor(vault),
        DEFAULT_SETTINGS
      );

      expect(ok).toBe(true);
      expect(getContent(PATH)).toBe("- [ ] x");
      expect(NoticeMock).not.toHaveBeenCalled();
    });
  });

  describe("openOrCreateMainDailyTodoForDate", () => {
    const PATH = "デイリー/2026/07/260725_デイリー.md";

    it("inserts the '新しいタスク' placeholder and calls onDone on success", async () => {
      const { vault, getContent } = makeFakeVault({ [PATH]: "## ToDoリスト" });
      const onDone = vi.fn();

      await openOrCreateMainDailyTodoForDate(
        "2026-07-25",
        appFor(vault),
        DEFAULT_SETTINGS,
        onDone
      );

      expect(getContent(PATH)).toBe(
        ["## ToDoリスト", "- [ ] 新しいタスク"].join("\n")
      );
      expect(onDone).toHaveBeenCalledTimes(1);
    });

    it("creates a missing daily file and calls onDone after insertion", async () => {
      const { vault, getContent } = makeFakeVault({});
      const onDone = vi.fn();

      await openOrCreateMainDailyTodoForDate(
        "2026-07-25",
        appFor(vault),
        DEFAULT_SETTINGS,
        onDone
      );

      expect(getContent(PATH)).toBe("- [ ] 新しいタスク");
      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });

  describe("openDailyTodoFile", () => {
    const PATH = "デイリー/2026/07/260725_デイリー.md";

    function makeFakeWorkspace(): { workspace: Workspace; openFile: Mock } {
      const openFile = vi.fn(async () => undefined);
      const workspace = {
        getLeaf: vi.fn(() => ({ openFile })),
      } as unknown as Workspace;
      return { workspace, openFile };
    }

    it("resolves item.path and opens it via workspace.getLeaf().openFile", async () => {
      const { vault } = makeFakeVault({ [PATH]: "content" });
      const { workspace, openFile } = makeFakeWorkspace();

      await openDailyTodoFile(todoItem({ path: PATH }), vault, workspace);

      expect(openFile).toHaveBeenCalledTimes(1);
      expect(openFile.mock.calls[0][0].path).toBe(PATH);
    });

    it("is a no-op when item.path is empty", async () => {
      const { vault } = makeFakeVault({});
      const { workspace, openFile } = makeFakeWorkspace();

      await openDailyTodoFile(todoItem({ path: "" }), vault, workspace);

      expect(openFile).not.toHaveBeenCalled();
    });

    it("is a no-op when the path doesn't resolve to a real file", async () => {
      const { vault } = makeFakeVault({});
      const { workspace, openFile } = makeFakeWorkspace();

      await openDailyTodoFile(todoItem({ path: "missing.md" }), vault, workspace);

      expect(openFile).not.toHaveBeenCalled();
    });
  });

  describe("openDailyTodoEditor", () => {
    it("is a no-op that resolves without error", async () => {
      const summary: DailyTodoSummary = {
        date: "2026-07-25",
        items: [],
        completedCount: 0,
        totalCount: 0,
      };
      const onDone = vi.fn();
      await expect(
        openDailyTodoEditor(summary, onDone)
      ).resolves.toBeUndefined();
      expect(onDone).not.toHaveBeenCalled();
    });
  });

  describe("updateDailyTodos", () => {
    const MAIN_PATH = "デイリー/2026/07/260725_デイリー.md";

    beforeEach(() => NoticeMock.mockClear());

    it.each([
      ["inserted line", "new line\n## ToDoリスト\n- [ ] first\n- [ ] second"],
      ["deleted line", "## ToDoリスト\n- [ ] second"],
      ["edited text", "## ToDoリスト\n- [ ] changed\n- [ ] second"],
      ["edited checkbox", "## ToDoリスト\n- [x] first\n- [ ] second"],
      ["edited formatting", "## ToDoリスト\n* [ ] first\n- [ ] second"],
    ])("stops saving after an external %s without overwriting or inserting", async (_kind, changedContent) => {
      const initial = "## ToDoリスト\n- [ ] first\n- [ ] second";
      const { vault, setFile, getContent, modifySpy } = makeFakeVault({ [MAIN_PATH]: initial });
      const items = parseDailyTodos(initial).map((item) => ({ ...item, path: MAIN_PATH }));
      const summary: DailyTodoSummary = {
        date: "2026-07-25", items, completedCount: 0, totalCount: items.length,
      };
      setFile(MAIN_PATH, changedContent);

      await updateDailyTodos(summary, [
        ...items.map((item) => ({ ...item, completed: true })),
        todoItem({ path: "", line: -1, text: "new task", isNew: true }),
      ], appFor(vault), DEFAULT_SETTINGS);

      expect(getContent(MAIN_PATH)).toBe(changedContent);
      expect(modifySpy).not.toHaveBeenCalled();
      expect(NoticeMock).toHaveBeenCalledOnce();
      expect(NoticeMock).toHaveBeenCalledWith(
        "ノートが変更されたため保存を中止しました。Daily ToDoを開き直して、もう一度操作してください。"
      );
    });

    it("checks the content supplied by process, including changes just before saving", async () => {
      const initial = "## ToDoリスト\n- [ ] task";
      const changed = "inserted\n" + initial;
      const { vault, setFile, getContent, modifySpy } = makeFakeVault({ [MAIN_PATH]: initial });
      const items = parseDailyTodos(initial).map((item) => ({ ...item, path: MAIN_PATH }));
      const process = vault.process.bind(vault);
      vi.mocked(vault.process).mockImplementationOnce(async (file, transform) => {
        setFile(MAIN_PATH, changed);
        return process(file, transform);
      });

      await updateDailyTodos({ date: "2026-07-25", items, completedCount: 0, totalCount: 1 },
        items.map((item) => ({ ...item, completed: true })), appFor(vault), DEFAULT_SETTINGS);

      expect(getContent(MAIN_PATH)).toBe(changed);
      expect(modifySpy).not.toHaveBeenCalled();
      expect(vault.read).not.toHaveBeenCalled();
      expect(NoticeMock).toHaveBeenCalledOnce();
    });

    it("accepts unchanged indented star bullets and CRLF while preserving other edits", async () => {
      const initial = "## ToDoリスト\r\n  * [X] task\r\nother";
      const { vault, setFile, getContent } = makeFakeVault({ [MAIN_PATH]: initial });
      const items = parseDailyTodos(initial).map((item) => ({ ...item, path: MAIN_PATH }));
      setFile(MAIN_PATH, initial.replace("other", "edited elsewhere"));

      await updateDailyTodos({ date: "2026-07-25", items, completedCount: 1, totalCount: 1 },
        items.map((item) => ({ ...item, completed: false })), appFor(vault), DEFAULT_SETTINGS);

      expect(getContent(MAIN_PATH)).toBe("## ToDoリスト\r\n- [ ] task\nedited elsewhere");
      expect(NoticeMock).not.toHaveBeenCalled();
    });

    it("updates matched existing lines and inserts unmatched new items", async () => {
      const { vault, getContent } = makeFakeVault({
        [MAIN_PATH]: [
          "## ToDoリスト",
          "- [ ] first",
          "- [ ] second",
        ].join("\n"),
      });

      const first = todoItem({ path: MAIN_PATH, line: 1, text: "first" });
      const second = todoItem({ path: MAIN_PATH, line: 2, text: "second" });
      const summary: DailyTodoSummary = {
        date: "2026-07-25",
        items: [first, second],
        completedCount: 0,
        totalCount: 2,
      };

      const nextItems: DailyTodoItem[] = [
        { ...first, text: "first edited", completed: true },
        { ...second }, // unchanged
        {
          sourceKey: "main",
          sourceLabel: "デイリー",
          path: "",
          line: -1,
          text: "brand new",
          completed: false,
          isNew: true,
        },
      ];

      await updateDailyTodos(summary, nextItems, appFor(vault), DEFAULT_SETTINGS);

      expect(getContent(MAIN_PATH)).toBe(
        [
          "## ToDoリスト",
          "- [x] first edited",
          "- [ ] second",
          "- [ ] brand new",
        ].join("\n")
      );
    });

    it("leaves a matched line untouched when the next item's text is empty", async () => {
      const { vault, getContent } = makeFakeVault({
        [MAIN_PATH]: "- [ ] keep me",
      });
      const original = todoItem({ path: MAIN_PATH, line: 0, text: "keep me" });
      const summary: DailyTodoSummary = {
        date: "2026-07-25",
        items: [original],
        completedCount: 0,
        totalCount: 1,
      };

      await updateDailyTodos(
        summary,
        [{ ...original, text: "   " }],
        appFor(vault),
        DEFAULT_SETTINGS
      );

      expect(getContent(MAIN_PATH)).toBe("- [ ] keep me");
    });

    it("leaves an original item untouched when it has no corresponding nextItems entry", async () => {
      const { vault, getContent } = makeFakeVault({
        [MAIN_PATH]: ["- [ ] a", "- [ ] b"].join("\n"),
      });
      const a = todoItem({ path: MAIN_PATH, line: 0, text: "a" });
      const b = todoItem({ path: MAIN_PATH, line: 1, text: "b" });
      const summary: DailyTodoSummary = {
        date: "2026-07-25",
        items: [a, b],
        completedCount: 0,
        totalCount: 2,
      };

      // b was dropped entirely (e.g. user deleted the row) — only a survives.
      await updateDailyTodos(
        summary,
        [{ ...a, completed: true }],
        appFor(vault),
        DEFAULT_SETTINGS
      );

      expect(getContent(MAIN_PATH)).toBe(
        ["- [x] a", "- [ ] b"].join("\n")
      );
    });

    it("processes multiple edits in the same file safely regardless of declaration order", async () => {
      const { vault, getContent } = makeFakeVault({
        [MAIN_PATH]: ["- [ ] one", "- [ ] two", "- [ ] three"].join("\n"),
      });
      const one = todoItem({ path: MAIN_PATH, line: 0, text: "one" });
      const two = todoItem({ path: MAIN_PATH, line: 1, text: "two" });
      const three = todoItem({ path: MAIN_PATH, line: 2, text: "three" });
      const summary: DailyTodoSummary = {
        date: "2026-07-25",
        items: [one, two, three],
        completedCount: 0,
        totalCount: 3,
      };

      await updateDailyTodos(
        summary,
        [
          { ...one, completed: true },
          { ...two, completed: true },
          { ...three, completed: true },
        ],
        appFor(vault),
        DEFAULT_SETTINGS
      );

      expect(getContent(MAIN_PATH)).toBe(
        ["- [x] one", "- [x] two", "- [x] three"].join("\n")
      );
    });

    it("does not write a file at all when nothing in it changed", async () => {
      const { vault, modifySpy } = makeFakeVault({
        [MAIN_PATH]: "- [ ] untouched",
      });
      const original = todoItem({
        path: MAIN_PATH,
        line: 0,
        text: "untouched",
      });
      const summary: DailyTodoSummary = {
        date: "2026-07-25",
        items: [original],
        completedCount: 0,
        totalCount: 1,
      };

      // nextItems has no entry at all matching path+line -> nothing to update.
      await updateDailyTodos(summary, [], appFor(vault), DEFAULT_SETTINGS);

      expect(modifySpy).not.toHaveBeenCalled();
    });

    it("an isNew item is always inserted, never mistaken for an existing-line match", async () => {
      const { vault, getContent } = makeFakeVault({
        [MAIN_PATH]: ["## ToDoリスト", "- [ ] original"].join("\n"),
      });
      const original = todoItem({
        path: MAIN_PATH,
        line: 1,
        text: "original",
      });
      const summary: DailyTodoSummary = {
        date: "2026-07-25",
        items: [original],
        completedCount: 0,
        totalCount: 1,
      };

      // Same path+line as `original`, but isNew:true — must be treated as a
      // brand-new row (inserted), not an in-place edit of line 1.
      const impostor: DailyTodoItem = {
        ...original,
        text: "impostor new row",
        isNew: true,
      };

      await updateDailyTodos(
        summary,
        [impostor],
        appFor(vault),
        DEFAULT_SETTINGS
      );

      expect(getContent(MAIN_PATH)).toBe(
        [
          "## ToDoリスト",
          "- [ ] original",
          "- [ ] impostor new row",
        ].join("\n")
      );
    });
  });
});
