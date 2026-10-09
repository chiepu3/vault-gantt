import * as McpModule from "../src/mcp/server";
import { AI_SECRET_ID } from "../src/ai/connection-settings";
import { VIEW_TYPE_AI_APPROVAL } from "../src/ui/approval-view";
import { VIEW_TYPE_AI_CHAT } from "../src/ui/agent-view";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Mock } from "vitest";
import { Modal, Notice, PluginSettingTab, requestUrl, TFile, Platform } from "obsidian";
import TaskWorkbenchPlugin, {
  VIEW_TYPE_TASK_WORKBENCH,
  VIEW_TYPE_TASK_GANTT,
  EMBED_BLOCK,
  ObsidianVaultAdapter,
  TaskWorkbenchSettingTab,
} from "../src/main";
import { HolidayService } from "../src/app/holiday-service";
import { addSubtask, createTask } from "../src/app/task-operations";
import { buildFullNote } from "../src/core/note-format";
import { DEFAULT_SETTINGS } from "../src/core/constants";
import { Logger } from "../src/core/logger";
import { TaskWorkbenchView } from "../src/ui/task-workbench-view";
import { TaskGanttView } from "../src/ui/task-gantt-view";
import type { TaskRow } from "../src/core/types";
import {
  byClass,
  byTag,
  createFakeDocument,
  deepText,
  dispatch,
  makeFakeEl,
} from "./stubs/fake-dom";
import type { FakeEl } from "./stubs/fake-dom";

vi.mock("obsidian", async (importOriginal) => {
  const actual = await importOriginal<typeof import("obsidian")>();
  return { ...actual, Notice: vi.fn(), requestUrl: vi.fn() };
});

const NoticeMock = Notice as unknown as Mock;
const requestUrlMock = requestUrl as unknown as Mock;

interface RegisteredCommand {
  id: string;
  name: string;
  callback: () => unknown;
}

interface RegisteredRibbon {
  icon: string;
  title: string;
  callback: () => unknown;
}

interface Harness {
  plugin: TaskWorkbenchPlugin;
  commands: RegisteredCommand[];
  ribbons: RegisteredRibbon[];
  views: Map<string, (leaf: unknown) => unknown>;
  processors: Map<string, (source: string, el: any) => Promise<void>>;
  settingTabs: PluginSettingTab[];
  savedData: any[];
  fakeApp: any;
  workspace: any;
  vaultApi: any;
  files: Map<string, { content: string; mtime: number; size: number }>;
  openFile: Mock;
  getLeaf: Mock;
}

/** Flush pending microtasks so fire-and-forget plugin work can settle. */
async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

function createHarness(storedData: unknown = undefined): Harness {
  const commands: RegisteredCommand[] = [];
  const ribbons: RegisteredRibbon[] = [];
  const views = new Map<string, (leaf: unknown) => unknown>();
  const processors = new Map<string, (source: string, el: any) => Promise<void>>();
  const settingTabs: PluginSettingTab[] = [];
  const savedData: any[] = [];
  const files = new Map<string, { content: string; mtime: number; size: number }>();
  // folder hierarchy model so ObsidianVaultAdapter.create's
  // parent-folder check/createFolder call has somewhere real to land.
  const folders = new Set<string>();

  const makeTFile = (path: string, mtime: number, size: number): TFile => {
    const f = new TFile();
    f.path = path;
    (f as any).stat = { mtime, size, ctime: mtime };
    return f;
  };

  const workspace = {
    detachLeavesOfType: vi.fn(),
    getActiveFile: vi.fn(() => null),
    getLeaf: vi.fn(),
    getLeavesOfType: vi.fn(() => []),
    openLinkText: vi.fn(async () => true),
  };

  const vaultApi = {
    create: vi.fn(async (path: string, content: string) => {
      const mtime = Date.now();
      files.set(path, { content, mtime, size: content.length });
      return makeTFile(path, mtime, content.length);
    }),
    modify: vi.fn(async (file: TFile, content: string) => {
      const entry = files.get(file.path);
      if (!entry) {
        throw new Error(`File not found: ${file.path}`);
      }
      const mtime = Date.now();
      entry.content = content;
      entry.mtime = mtime;
      entry.size = content.length;
      (file as any).stat = { mtime, size: content.length, ctime: mtime };
    }),
    read: vi.fn(async (file: TFile) => {
      const entry = files.get(file.path);
      if (!entry) {
        throw new Error(`File not found: ${file.path}`);
      }
      return entry.content;
    }),
    // DailyTodoService.loadDailyTodoSummaries reads via
    // cachedRead, not read — this fake vault previously had no such
    // method, which would TypeError the moment any test's daily-note

    cachedRead: vi.fn(async (file: TFile) => {
      const entry = files.get(file.path);
      if (!entry) {
        throw new Error(`File not found: ${file.path}`);
      }
      return entry.content;
    }),
    getMarkdownFiles: vi.fn(() =>
      Array.from(files.entries()).map(([path, e]) =>
        makeTFile(path, e.mtime, e.size)
      )
    ),
    getAbstractFileByPath: vi.fn((path: string) => {
      if (folders.has(path)) {
        return {} as any; // TFolder stand-in; adapter only checks truthiness
      }
      const entry = files.get(path);
      if (!entry) {
        return null;
      }
      return makeTFile(path, entry.mtime, entry.size);
    }),
    // mirrors real Vault.createFolder recursively creating
    // all missing intermediate folders.
    createFolder: vi.fn(async (path: string) => {
      let cur = "";
      for (const part of path.split("/")) {
        cur = cur ? `${cur}/${part}` : part;
        folders.add(cur);
      }
      return {} as any;
    }),
  };

  const openFile = vi.fn().mockResolvedValue(undefined);
  const getLeaf = vi.fn(() => ({ openFile }));
  workspace.getLeaf.mockImplementation(getLeaf);

  const fakeApp = { workspace, vault: vaultApi };

  const plugin = new TaskWorkbenchPlugin(fakeApp as any, {} as any);
  (plugin as any).app = fakeApp;
  plugin.logger = new Logger(fakeApp as any);
  // the test stub's Plugin base class (tests/stubs/obsidian.ts)
  // never sets `manifest` from the constructor (unlike real Obsidian) — set
  // it explicitly so `this.manifest.version` (used by the Gantt sync
  // snapshot builder's `pluginVersion` field) doesn't throw.
  (plugin as any).manifest = { version: "0.0.0-test" };
  (plugin as any).addCommand = vi.fn((cmd: RegisteredCommand) => {
    commands.push(cmd);
    return cmd;
  });
  (plugin as any).registerView = vi.fn(
    (type: string, factory: (leaf: unknown) => unknown) => {
      views.set(type, factory);
    }
  );
  (plugin as any).addRibbonIcon = vi.fn(
    (icon: string, title: string, callback: () => unknown) => {
      ribbons.push({ icon, title, callback });
      return {};
    }
  );
  (plugin as any).addSettingTab = vi.fn((tab: PluginSettingTab) => {
    settingTabs.push(tab);
  });
  (plugin as any).registerMarkdownCodeBlockProcessor = vi.fn(
    (lang: string, handler: (source: string, el: any) => Promise<void>) => {
      processors.set(lang, handler);
    }
  );
  let persistedData = storedData;
  (plugin as any).loadData = vi.fn(async () => persistedData);
  (plugin as any).saveData = vi.fn(async (data: any) => {
    savedData.push(data);
    persistedData = structuredClone(data);
  });

  return {
    plugin,
    commands,
    ribbons,
    views,
    processors,
    settingTabs,
    savedData,
    fakeApp,
    workspace,
    vaultApi,
    files,
    openFile,
    getLeaf,
  };
}

/** Provides a controllable HolidayService stub for tests. */
function stubHolidays(
  plugin: TaskWorkbenchPlugin,
  options: {
    migrated?: boolean;
    refresh?: () => Promise<void>;
  }
): { migrate: Mock; refresh: Mock } {
  const migrate = vi.fn(() => options.migrated ?? false);
  const refresh = vi.fn(
    options.refresh ?? (async () => undefined)
  );
  const stub = {
    migrateHolidaySettings: migrate,
    refreshNationalHolidays: refresh,
  } as unknown as HolidayService;
  (plugin as any).createHolidayService = () => stub;
  return { migrate, refresh };
}

describe("TaskWorkbenchPlugin", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T10:00:00Z"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    NoticeMock.mockClear();
    requestUrlMock.mockReset();
    // renderEmbed builds real DOM nodes. Vitest runs in the Node environment
    // without jsdom, so the fake-DOM harness stands in for `document`.
    vi.stubGlobal("document", createFakeDocument());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe("P3 hosts and MCP lifecycle", () => {
    it("passes shared ports to each view and registers actual view state for the approval list", async () => {
      const h = createHarness({ autoPriorityEnabled: false });
      await h.plugin.onload();
      for (const type of [VIEW_TYPE_TASK_WORKBENCH, VIEW_TYPE_TASK_GANTT, VIEW_TYPE_AI_CHAT, VIEW_TYPE_AI_APPROVAL]) {
        const view = h.views.get(type)!({});
        const ports = type === VIEW_TYPE_AI_CHAT ? (view as any).host.previewPorts : (view as any).host;
        expect(ports.operationService).toBe(h.plugin.operationService);
        expect(ports.previewPort).toBe(h.plugin.previewPort); expect(ports.projectionDetailPort).toBe(h.plugin.previewPort);
        expect(ports.humanApprovalPort).toBe(h.plugin.humanApprovalPort); expect(ports.historyPort).toBe(h.plugin.historyPort);
        expect(ports.uiPort).toBe(h.plugin.uiPort); expect(ports.undoPort.undoEntry).toBeTypeOf("function");
        if (type === VIEW_TYPE_AI_APPROVAL) {
          await (view as any).onOpen(); expect(h.plugin.uiPort.inspectView(ports.viewId)?.kind).toBe("approval");
          await (view as any).onClose(); expect(h.plugin.uiPort.inspectView(ports.viewId)).toBeUndefined();
        }
      }
      h.plugin.onunload();
    });
    it("starts MCP only when enabled, persists secret references, rotates tokens and stops on unload", async () => {
      const stop = vi.fn(async () => undefined), regenerateToken = vi.fn(async () => "b".repeat(43));
      const handle = { running: true, endpoint: "http://127.0.0.1:8788/mcp", sessionToken: "a".repeat(43), stop, regenerateToken };
      const start = vi.spyOn(McpModule, "startMcpServer").mockResolvedValue(handle);
      const secrets = new Map<string, string>();
      const h = createHarness({ autoPriorityEnabled: false, mcp: { ...McpModule.DEFAULT_MCP_SETTINGS, enabled: true } });
      (h.plugin.app as any).secretStorage = { getSecret: (id: string) => secrets.get(id) ?? null, setSecret: (id: string, token: string) => secrets.set(id, token) };
      await h.plugin.onload(); expect(start).toHaveBeenCalledTimes(1);
      expect(start.mock.calls[0][0]).toMatchObject({ operations: h.plugin.operationService, previews: h.plugin.previewPort, context: h.plugin.contextReadPort, history: h.plugin.historyPort, isDesktop: true });
      expect(secrets.get(h.plugin.settings.mcp!.secretId!)).toBe("a".repeat(43));
      expect(JSON.stringify(h.savedData)).not.toContain("a".repeat(43));
      await h.plugin.generateMcpToken(true); expect(regenerateToken).toHaveBeenCalledTimes(1);
      expect(secrets.get(h.plugin.settings.mcp!.secretId!)).toBe("b".repeat(43));
      h.plugin.onunload(); await (h.plugin as any).mcpTail; expect(stop).toHaveBeenCalledTimes(1);
    });
    it("keeps MCP disabled on mobile and closes a late-starting server after unload", async () => {
      const start = vi.spyOn(McpModule, "startMcpServer");
      const platform = Platform as { isDesktopApp: boolean }; platform.isDesktopApp = false;
      const mobile = createHarness({ autoPriorityEnabled: false, mcp: { ...McpModule.DEFAULT_MCP_SETTINGS, enabled: true } });
      try { await mobile.plugin.onload(); expect(start).not.toHaveBeenCalled(); mobile.plugin.onunload(); }
      finally { platform.isDesktopApp = true; }
      let resolve!: (handle: McpModule.McpServerHandle) => void;
      start.mockImplementation(() => new Promise((done) => { resolve = done; }));
      const h = createHarness({ autoPriorityEnabled: false }); await h.plugin.onload();
      h.plugin.settings.mcp = { ...McpModule.DEFAULT_MCP_SETTINGS, enabled: true };
      const starting = h.plugin.configureMcp();
      while (!resolve) await Promise.resolve();
      h.plugin.onunload(); const stop = vi.fn(async () => undefined);
      resolve({ running: true, endpoint: "http://127.0.0.1:8788/mcp", sessionToken: null, stop, regenerateToken: async () => "unused" });
      await starting; await (h.plugin as any).mcpTail; expect(stop).toHaveBeenCalledTimes(1);
    });
  });

  describe("onload: settings", () => {
    it("loads once and merges stored data over defaults", async () => {
      const h = createHarness({
        taskFolder: "custom-tasks",
        autoPriorityEnabled: false,
      });

      await h.plugin.onload();

      expect(h.plugin.loadData).toHaveBeenCalledTimes(1);
      expect(h.plugin.settings.taskFolder).toBe("custom-tasks");
      expect(h.plugin.settings.autoPriorityEnabled).toBe(false);
      // untouched fields keep defaults
      expect(h.plugin.settings.ganttZoom).toBe(28);
      expect(h.plugin.settings.ganttSyncIntervalMinutes).toBe(5);
      expect(Array.isArray(h.plugin.settings.ganttNationalHolidays)).toBe(true);
    });

    it("corrupt stored data fails the whole plugin load with no registrations", async () => {
      const h = createHarness();
      (h.plugin.loadData as Mock).mockRejectedValue(
        new SyntaxError("Unexpected token in JSON")
      );

      await expect(h.plugin.onload()).rejects.toThrow(SyntaxError);

      expect(h.commands).toHaveLength(0);
      expect(h.views.size).toBe(0);
      expect(h.ribbons).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("saveSettings persists the in-memory settings object via saveData", async () => {
      const h = createHarness();
      await h.plugin.onload();
      h.savedData.length = 0;

      h.plugin.settings.taskFolder = "changed";
      await h.plugin.saveSettings();

      expect(h.savedData).toHaveLength(1);
      expect(h.savedData[0]).toEqual({ ...h.plugin.settings, ai: h.plugin.aiSettings });
      expect(h.savedData[0].taskFolder).toBe("changed");
    });
    it("keeps the AI connection outside settings and the API key out of data.json when secret storage exists", async () => {
      const secrets = new Map<string, string>();
      const h = createHarness({ autoPriorityEnabled: false, ai: { preset: "local", baseUrl: "http://localhost:1234/v1", model: "m", useApiKey: false } });
      (h.plugin.app as any).secretStorage = { getSecret: (id: string) => secrets.get(id) ?? null, setSecret: (id: string, v: string) => secrets.set(id, v) };
      await h.plugin.onload();
      expect("ai" in h.plugin.settings).toBe(false);
      expect(h.plugin.chatSession.config).toMatchObject({ provider: "openai-compatible", endpoint: "http://localhost:1234/v1", model: "m", auth: "none" });
      await h.plugin.updateAiSettings({ useApiKey: true });
      await h.plugin.setAiApiKey("sk-synthetic-secret");
      expect(h.plugin.hasAiApiKey()).toBe(true);
      expect(secrets.get(AI_SECRET_ID)).toBe("sk-synthetic-secret");
      expect(JSON.stringify(h.savedData)).not.toContain("sk-synthetic-secret");
      expect(JSON.stringify(h.plugin.getAiSettings())).not.toContain("sk-synthetic-secret");
      expect(JSON.stringify(h.plugin.chatSession.config)).not.toContain("sk-synthetic-secret");
      expect(h.plugin.chatSession.connected).toBe(true);
      await h.plugin.clearAiApiKey();
      expect(h.plugin.hasAiApiKey()).toBe(false); expect(h.plugin.chatSession.connected).toBe(false);
      h.plugin.onunload();
    });
    it("stores the API key in data.json only without secret storage, and moves it into secret storage later", async () => {
      const h = createHarness({ autoPriorityEnabled: false });
      await h.plugin.onload();
      expect(h.plugin.aiKeyStorage()).toBe("data");
      await h.plugin.setAiApiKey("sk-synthetic-secret");
      expect(h.savedData.at(-1).ai.apiKey).toBe("sk-synthetic-secret");
      expect(h.plugin.getAiSettings()).not.toHaveProperty("apiKey");
      h.plugin.onunload();
      const secrets = new Map<string, string>();
      const next = createHarness(structuredClone(h.savedData.at(-1)));
      (next.plugin.app as any).secretStorage = { getSecret: (id: string) => secrets.get(id) ?? null, setSecret: (id: string, v: string) => secrets.set(id, v) };
      await next.plugin.onload();
      expect(secrets.get(AI_SECRET_ID)).toBe("sk-synthetic-secret");
      expect(JSON.stringify(next.savedData.at(-1))).not.toContain("sk-synthetic-secret");
      next.plugin.onunload();
    });
    it("UI persistence shares the approval queue and keeps unrelated settings edited during the AI save", async () => {
      const h = createHarness({ autoPriorityEnabled: false }); await h.plugin.onload();
      const service = h.plugin.operationService;
      const preview = await service.propose("S01", { taskFolder: "AI-folder" }, service.legacyContext());
      let started!: () => void, release!: () => void;
      const writing = new Promise<void>((resolve) => { started = resolve; });
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      const save = h.plugin.saveData as Mock, original = save.getMockImplementation()!;
      save.mockImplementationOnce(async (data: unknown) => { started(); await blocked; await original(data); });
      const ai = service.humanApprovalPort.approve(preview.previewId); await writing;
      h.plugin.settings.ganttZoom = 60; const ui = h.plugin.saveSettings();
      expect(h.plugin.saveData).toHaveBeenCalledTimes(1);
      release(); expect((await ai).status).toBe("success"); await ui;
      expect(await h.plugin.loadData()).toMatchObject({ taskFolder: "AI-folder", ganttZoom: 60 });
      expect(h.plugin.settings).toMatchObject({ taskFolder: "AI-folder", ganttZoom: 60 });
    });
    it.each(["modify", "create", "delete", "rename"])("Vault %s clears the new saved projection without deleting the receipt", async (event) => {
      const h = createHarness({ autoPriorityEnabled: false });
      (h.plugin as any).registerEvent = vi.fn(); h.vaultApi.on = vi.fn(); await h.plugin.onload();
      const preview = await h.plugin.operationService.propose("S02", { filenameUsesDatePrefix: false }, h.plugin.operationService.legacyContext());
      await h.plugin.humanApprovalPort.approve(preview.previewId); h.plugin.previewPort.focus(preview.previewId);
      const callback = h.vaultApi.on.mock.calls.find(([name]: [string]) => name === event)[1];
      callback({ path: "external.md" }); await flush();
      expect(h.plugin.previewPort.focusedPreviewId()).toBeNull(); expect(h.plugin.previewPort.inspectOutcome(preview.previewId)).toBeDefined();
    });
    it("does not republish the AI setting over UI changes that returned to the original value", async () => {
      const h = createHarness({ autoPriorityEnabled: false, currentStatusRows: 28 }); await h.plugin.onload();
      const service = h.plugin.operationService;
      const preview = await service.propose("S04", { currentStatusRows: 50 }, service.legacyContext());
      let release!: () => void, started!: () => void;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      const writing = new Promise<void>((resolve) => { started = resolve; });
      const save = h.plugin.saveData as Mock, original = save.getMockImplementation()!;
      save.mockImplementationOnce(async (data: unknown) => { started(); await blocked; await original(data); });
      const ai = service.humanApprovalPort.approve(preview.previewId); await writing;
      h.plugin.settings.currentStatusRows = 60; const first = h.plugin.saveSettings();
      h.plugin.settings.currentStatusRows = 28; const last = h.plugin.saveSettings();
      release(); expect((await ai).status).toBe("success"); expect(h.plugin.settings.currentStatusRows).toBe(28);
      await Promise.all([first, last]);
      expect(h.plugin.settings.currentStatusRows).toBe(28); expect(await h.plugin.loadData()).toMatchObject({ currentStatusRows: 28 });
    });
  });

  describe("onload: holiday migration", () => {
    it("runs migration and saves settings only when migration happened", async () => {
      const h = createHarness({ autoPriorityEnabled: false });
      const { migrate } = stubHolidays(h.plugin, { migrated: true });

      await h.plugin.onload();

      expect(migrate).toHaveBeenCalledTimes(1);
      expect(migrate.mock.calls[0][0]).toBe(h.plugin.settings);
      expect(h.savedData.length).toBe(1); // the migration save
    });

    it("no migration → settings are not saved by the migration step", async () => {
      const h = createHarness({ autoPriorityEnabled: false });
      const { migrate } = stubHolidays(h.plugin, { migrated: false });

      await h.plugin.onload();
      await flush();

      expect(migrate).toHaveBeenCalledTimes(1);
      expect(h.savedData.length).toBe(0);
    });
  });

  describe("onload handles automatic-priority failures", () => {
    it("auto priority failure is caught and logged; views/commands/ribbon still register", async () => {
      const h = createHarness();
      const loggerErrorSpy = vi.spyOn(Logger.prototype, "error");
      // simulate the task folder lookup blowing up inside loadTasks
      h.vaultApi.getMarkdownFiles.mockImplementation(() => {
        throw new Error("task folder missing");
      });

      await expect(h.plugin.onload()).resolves.toBeUndefined();

      expect(loggerErrorSpy).toHaveBeenCalledWith(
        "TaskWorkbenchPlugin",
        "Task Workbench: auto priority update failed during onload",
        expect.any(Error)
      );

      expect(h.commands).toHaveLength(14);

      expect(h.views.size).toBe(4);
      expect(h.ribbons).toHaveLength(2);
      expect(h.settingTabs).toHaveLength(1);
    });

    it("settings are persisted after a successful auto priority run", async () => {
      const h = createHarness({});

      await h.plugin.onload();
      await flush();

      expect(h.savedData.length).toBeGreaterThanOrEqual(1);
      expect(
        h.savedData.some((d) => d.lastAutoPriorityUpdate === "2026-07-29")
      ).toBe(true);
    });
  });

  describe("onload: national holiday refresh", () => {
    it("fires refreshNationalHolidays(false, false) without blocking startup", async () => {
      const h = createHarness({});
      const { refresh } = stubHolidays(h.plugin, {});

      await h.plugin.onload();

      expect(refresh).toHaveBeenCalledWith(false, false);
    });

    it("a rejected refresh escapes uncaptured but never blocks onload or registrations", async () => {
      const h = createHarness({});
      const rejection = Promise.reject(new Error("holiday refresh failed"));
      // Pre-handle to keep the test runner's unhandled-error report clean;
      // onload itself attaches no rejection handler, as this test verifies.
      rejection.catch(() => undefined);
      const { refresh } = stubHolidays(h.plugin, {
        refresh: () => rejection,
      });

      await expect(h.plugin.onload()).resolves.toBeUndefined();

      expect(refresh).toHaveBeenCalledTimes(1);

      expect(h.commands).toHaveLength(14);

      expect(h.views.size).toBe(4);
      expect(h.ribbons).toHaveLength(2);
    });
  });

  describe("onload: registrations", () => {
    it("registers both view types with working factories", async () => {
      const h = createHarness({});
      await h.plugin.onload();

      expect(h.views.has(VIEW_TYPE_TASK_WORKBENCH)).toBe(true);
      expect(h.views.has(VIEW_TYPE_TASK_GANTT)).toBe(true);
      expect(typeof h.views.get(VIEW_TYPE_TASK_WORKBENCH)).toBe("function");
      expect(typeof h.views.get(VIEW_TYPE_TASK_GANTT)).toBe("function");
    });

    it("registers the task-list code block processor and renders through renderEmbed", async () => {
      const h = createHarness({});
      stubHolidays(h.plugin, {});
      await h.plugin.onload();

      expect(EMBED_BLOCK).toBe("task-list");
      const handler = h.processors.get("task-list");
      expect(typeof handler).toBe("function");

      const el = makeFakeEl("div");
      await handler!("sort=dueDate", el);

      expect(el.getAttribute("data-embed-source")).toBe("sort=dueDate");
      // fixed titlebar text.
      expect(deepText(el)).toContain("Task Workbench 埋め込みビュー");
      // no tasks in the fake vault → empty-state message.
      expect(deepText(el)).toContain("表示対象のタスクがありません");
    });

    it("renderEmbed failures propagate uncaptured out of the processor", async () => {
      const h = createHarness({});
      await h.plugin.onload();
      vi.spyOn(h.plugin as any, "renderEmbed").mockRejectedValue(
        new Error("embed boom")
      );

      const handler = h.processors.get("task-list")!;
      const el = { textContent: "", setAttribute: vi.fn() };

      await expect(handler("x", el)).rejects.toThrow("embed boom");
    });

    it("each embed position renders independently on every re-render", async () => {
      const h = createHarness({});
      stubHolidays(h.plugin, {});
      await h.plugin.onload();
      const renderSpy = vi.spyOn(h.plugin as any, "renderEmbed");

      const handler = h.processors.get("task-list")!;
      const el1 = makeFakeEl("div");
      const el2 = makeFakeEl("div");

      await handler("a", el1);
      await handler("b", el2);
      // editing the block re-invokes the processor for the same element
      await handler("c", el1);

      expect(renderSpy).toHaveBeenCalledTimes(3);
      expect(deepText(el1)).toContain("Task Workbench 埋め込みビュー");
      expect(deepText(el2)).toContain("Task Workbench 埋め込みビュー");
      expect(el1.getAttribute("data-embed-source")).toBe("c");
    });


    it("registers the existing and undo/redo commands", async () => {



      // Verify the full command list, including the appended undo/redo commands.
      const h = createHarness({});
      await h.plugin.onload();

      expect(h.commands.map((c) => c.id)).toEqual([
        "open-task-workbench",
        "open-task-gantt",
        "open-task-finder",
        "create-new-task-note",
        "add-subtask-to-current-note",
        "open-daily-todo",

        "start-log-recording",
        "stop-log-recording",

        "undo-last-action",
        "redo-last-action",
        "open-ai-chat-tab",
        "open-ai-chat-left",
        "open-ai-chat-right",
        "open-ai-approval",
      ]);
      expect(h.commands.map((c) => c.name)).toEqual([
        "Open task workbench",
        "Open task gantt",
        "Open task finder",
        "Create new managed task note",
        "Add subtask to current managed task note",
        "Open daily ToDo",

        "Start log recording",
        "Stop log recording",

        "元に戻す",
        "やり直す",
        "AI チャットを開く（タブ）",
        "AI チャットを開く（左サイドバー）",
        "AI チャットを開く（右サイドバー）",
        "AIの承認一覧を開く",
      ]);
    });


    it("routes the log recording commands to the shared Logger", async () => {
      const h = createHarness({});
      await h.plugin.onload();
      const startRecording = vi.spyOn(h.plugin.logger, "startRecording");
      const stopRecording = vi
        .spyOn(h.plugin.logger, "stopRecording")
        .mockResolvedValue(undefined);

      h.commands[6].callback();
      await h.commands[7].callback();

      expect(startRecording).toHaveBeenCalledTimes(1);
      expect(stopRecording).toHaveBeenCalledTimes(1);
    });


    it("undo/redo commands delegate to the plugin actions", async () => {
      const h = createHarness({});
      await h.plugin.onload();
      const undo = vi.spyOn(h.plugin, "undoLastAction").mockResolvedValue(undefined);
      const redo = vi.spyOn(h.plugin, "redoLastAction").mockResolvedValue(undefined);

      h.commands[8].callback();
      h.commands[9].callback();
      await flush();

      expect(undo).toHaveBeenCalledTimes(1);
      expect(redo).toHaveBeenCalledTimes(1);
    });

    it("undo/redo actions report history outcomes and refresh both open views after success", async () => {
      const h = createHarness({});
      await h.plugin.onload();
      const preview = await h.plugin.operationService.propose("S02", { filenameUsesDatePrefix: false }, h.plugin.operationService.legacyContext());
      await h.plugin.humanApprovalPort.approve(preview.previewId); h.plugin.previewPort.focus(preview.previewId);
      const workbenchView = Object.create(
        TaskWorkbenchView.prototype
      ) as TaskWorkbenchView;
      const ganttView = Object.create(TaskGanttView.prototype) as TaskGanttView;
      const workbenchRender = vi.fn(async () => undefined);
      const ganttRender = vi.fn(async () => undefined);
      workbenchView.render = workbenchRender;
      ganttView.render = ganttRender;
      h.workspace.getLeavesOfType.mockImplementation((viewType: string) => {
        if (viewType === VIEW_TYPE_TASK_WORKBENCH) {
          return [{ view: workbenchView }];
        }
        if (viewType === VIEW_TYPE_TASK_GANTT) {
          return [{ view: ganttView }];
        }
        return [];
      });

      const undo = vi
        .spyOn(h.plugin.historyManager, "undo")
        .mockResolvedValue({ kind: "success", label: "タスク更新" });
      const redo = vi
        .spyOn(h.plugin.historyManager, "redo")
        .mockResolvedValue({ kind: "success", label: "タスク更新" });

      await h.plugin.undoLastAction();
      expect(undo).toHaveBeenCalledWith(h.fakeApp.vault);
      expect(h.plugin.previewPort.focusedPreviewId()).toBeNull();
      expect(workbenchRender).toHaveBeenCalledTimes(1);
      expect(ganttRender).toHaveBeenCalledTimes(1);
      expect(NoticeMock).toHaveBeenLastCalledWith("元に戻しました: タスク更新");

      h.plugin.previewPort.focus(preview.previewId); await h.plugin.redoLastAction();
      expect(h.plugin.previewPort.focusedPreviewId()).toBeNull();
      expect(redo).toHaveBeenCalledWith(h.fakeApp.vault);
      expect(workbenchRender).toHaveBeenCalledTimes(2);
      expect(ganttRender).toHaveBeenCalledTimes(2);
      expect(NoticeMock).toHaveBeenLastCalledWith("やり直しました: タスク更新");

      undo.mockResolvedValue({ kind: "empty" });
      await h.plugin.undoLastAction();
      expect(NoticeMock).toHaveBeenLastCalledWith("元に戻せる操作がありません");

      undo.mockResolvedValue({
        kind: "conflict",
        label: "タスク更新",
        conflictingPaths: ["tasks/example.md"],
      });
      await h.plugin.undoLastAction();
      expect(NoticeMock).toHaveBeenLastCalledWith(
        "元に戻せませんでした（外部で変更されています）: tasks/example.md"
      );

      redo.mockResolvedValue({ kind: "invalidated", label: "タスク更新", reason: "補償失敗" });
      await h.plugin.redoLastAction();
      expect(NoticeMock).toHaveBeenLastCalledWith(
        "やり直し履歴を破棄しました: 補償失敗"
      );
    });

    it("saveDailyTodoItems normalizes a null summary and inserts a row for today's date", async () => {
      // Exercise saveDailyTodoItems when today's daily note has no ToDo items.
      // Fake system time keeps the daily-note path deterministic.
      const h = createHarness({});
      await h.plugin.onload();

      const path = "デイリー/2026/07/260729_デイリー.md";
      h.files.set(path, {
        content: "# 2026-07-29\n\n## ToDoリスト\n",
        mtime: 1,
        size: 20,
      });

      await (h.plugin as any).saveDailyTodoItems(null, "2026-07-29", [
        {
          sourceKey: "",
          sourceLabel: "",
          path: "",
          line: -1,
          text: "新しいタスク",
          completed: false,
          isNew: true,
        },
      ]);

      expect(h.vaultApi.modify).toHaveBeenCalledTimes(1);
      expect(h.files.get(path)?.content).toContain("- [ ] 新しいタスク");
    });

    it("workbench command routes to navigation.activateView", async () => {
      const h = createHarness({});
      const activateView = vi.fn();
      h.plugin.navigation = {
        activateView,
        activateGanttView: vi.fn(),
        openTaskFinder: vi.fn(),
      };
      await h.plugin.onload();

      h.commands[0].callback();

      expect(activateView).toHaveBeenCalledTimes(1);
    });

    it("gantt command routes to navigation.activateGanttView", async () => {
      const h = createHarness({});
      const activateGanttView = vi.fn();
      h.plugin.navigation = {
        activateView: vi.fn(),
        activateGanttView,
        openTaskFinder: vi.fn(),
      };
      await h.plugin.onload();

      h.commands[1].callback();

      expect(activateGanttView).toHaveBeenCalledTimes(1);
    });

    it("finder command routes to navigation.openTaskFinder", async () => {
      const h = createHarness({});
      const openTaskFinder = vi.fn();
      h.plugin.navigation = {
        activateView: vi.fn(),
        activateGanttView: vi.fn(),
        openTaskFinder,
      };
      await h.plugin.onload();

      h.commands[2].callback();

      expect(openTaskFinder).toHaveBeenCalledTimes(1);
    });

    it("opens a requested DailyTodo date and delegates with today", async () => {
      // The command is responsible for wiring the action. With no daily note
      // seeded for today, this also exercises the null-summary path, where the
      // DailyTodoModal renders zero rows, without erroring.
      const h = createHarness({});
      const openSpy = vi
        .spyOn(Modal.prototype, "open")
        .mockImplementation(() => undefined);
      await h.plugin.onload();

      await (h.plugin as any).openOrCreateDailyTodoForDate("2026-07-28");
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect((openSpy.mock.instances[0] as any).title).toBe(
        "デイリーToDo（2026-07-28）"
      );

      h.commands[5].callback();
      await flush();

      expect(h.vaultApi.getMarkdownFiles).toHaveBeenCalled();
      expect(openSpy).toHaveBeenCalledTimes(2);
      expect((openSpy.mock.instances[1] as any).title).toBe(
        "デイリーToDo（2026-07-29）"
      );

      openSpy.mockRestore();
    });

    it("create command delegates to TaskFileService.createTaskInteractively", async () => {
      const h = createHarness({});
      await h.plugin.onload();
      const createSpy = vi
        .spyOn(h.plugin.taskFiles, "createTaskInteractively")
        .mockResolvedValue(null);

      h.commands[3].callback();
      await flush();

      expect(createSpy).toHaveBeenCalledTimes(1);
      const [app, adapter, settings, prompt] = createSpy.mock.calls[0];
      expect(app).toBe(h.fakeApp);
      expect(adapter).toBeInstanceOf(ObsidianVaultAdapter);
      expect(settings).toBe(h.plugin.settings);
      expect(typeof prompt).toBe("function");
    });

    it("subtask command delegates with the active file path", async () => {
      const h = createHarness({});
      await h.plugin.onload();
      h.workspace.getActiveFile.mockReturnValue({
        path: "tasks/2026-07/current.md",
      });
      const subtaskSpy = vi
        .spyOn(h.plugin.taskFiles, "addSubtaskToCurrentFileInteractively")
        .mockResolvedValue(null);

      h.commands[4].callback();
      await flush();

      expect(subtaskSpy).toHaveBeenCalledTimes(1);
      expect(subtaskSpy.mock.calls[0][3]).toBe("tasks/2026-07/current.md");
    });

    it("subtask command without an active file notifies and does not start the wizard", async () => {
      const h = createHarness({});
      await h.plugin.onload();
      h.workspace.getActiveFile.mockReturnValue(null);
      const subtaskSpy = vi.spyOn(
        h.plugin.taskFiles,
        "addSubtaskToCurrentFileInteractively"
      );

      h.commands[4].callback();
      await flush();

      expect(NoticeMock).toHaveBeenCalledWith(
        expect.stringContaining("開いているファイル")
      );
      expect(subtaskSpy).not.toHaveBeenCalled();
    });

    it("registers two ribbon buttons with Japanese labels and routing callbacks", async () => {
      const h = createHarness({});
      const activateView = vi.fn();
      const activateGanttView = vi.fn();
      h.plugin.navigation = {
        activateView,
        activateGanttView,
        openTaskFinder: vi.fn(),
      };
      await h.plugin.onload();

      expect(h.ribbons).toHaveLength(2);
      expect(h.ribbons[0].icon).toBe("list-todo");
      expect(h.ribbons[0].title).toBe("Task Workbench を開く");
      expect(h.ribbons[1].icon).toBe("bar-chart-3");
      expect(h.ribbons[1].title).toBe("Task Gantt を開く");

      h.ribbons[0].callback();
      h.ribbons[1].callback();
      expect(activateView).toHaveBeenCalledTimes(1);
      expect(activateGanttView).toHaveBeenCalledTimes(1);
    });

    it("repeated ribbon clicks run the navigation calls repeatedly (no guard)", async () => {
      const h = createHarness({});
      const activateView = vi.fn();
      h.plugin.navigation = {
        activateView,
        activateGanttView: vi.fn(),
        openTaskFinder: vi.fn(),
      };
      await h.plugin.onload();

      h.ribbons[0].callback();
      h.ribbons[0].callback();

      expect(activateView).toHaveBeenCalledTimes(2);
    });

    it("registers a PluginSettingTab instance", async () => {
      const h = createHarness({});
      await h.plugin.onload();

      expect(h.settingTabs).toHaveLength(1);
      expect(h.settingTabs[0]).toBeInstanceOf(PluginSettingTab);
      expect(h.settingTabs[0]).toBeInstanceOf(TaskWorkbenchSettingTab);
    });
  });

  describe("Gantt sync timer and unload", () => {
    it("with default settings (ganttSyncEnabled=false, ganttSyncUrl='') onload arms NO timer", async () => {
      const h = createHarness({});
      await h.plugin.onload();

      expect(vi.getTimerCount()).toBe(0);
      expect(h.plugin.ganttSyncIntervalId).toBeNull();
    });

    it("ganttSyncEnabled=true but ganttSyncUrl='' still arms NO timer", async () => {
      const h = createHarness({
        ...DEFAULT_SETTINGS,
        ganttSyncEnabled: true,
        ganttSyncUrl: "",
      });
      await h.plugin.onload();

      expect(vi.getTimerCount()).toBe(0);
      expect(h.plugin.ganttSyncIntervalId).toBeNull();
    });

    it("onload arms exactly one timer and runs an immediate sync when enabled+URL are set; onunload clears it", async () => {
      requestUrlMock.mockResolvedValue({ status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: {}, text: "" });
      const h = createHarness({
        ...DEFAULT_SETTINGS,
        ganttSyncEnabled: true,
        ganttSyncUrl: "http://localhost:8787",
      });
      await h.plugin.onload();
      await flush();

      expect(vi.getTimerCount()).toBe(1);
      expect(h.plugin.ganttSyncIntervalId).not.toBeNull();
      // the immediate sync ran and succeeded. (requestUrlMock is
      // shared with onload's unrelated national-holiday fetch, so filter by
      // the gantt sync endpoint rather than asserting a raw call count.)
      const ganttCalls = requestUrlMock.mock.calls.filter(
        ([opts]) => opts.url === "http://localhost:8787/api/snapshot"
      );
      expect(ganttCalls).toHaveLength(1);
      expect(h.plugin.lastGanttSyncHash).not.toBe("");

      h.plugin.onunload();

      expect(vi.getTimerCount()).toBe(0);
      expect(h.plugin.ganttSyncIntervalId).toBeNull();
    });

    it("with no active timer, onunload does not call clearInterval", async () => {
      const h = createHarness({});
      expect(h.plugin.ganttSyncIntervalId).toBeNull();
      const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

      h.plugin.onunload();

      expect(clearIntervalSpy).not.toHaveBeenCalled();
    });

    it("onunload detaches both view types (no-op when already closed)", async () => {
      const h = createHarness({});
      await h.plugin.onload();

      h.plugin.onunload();

      expect(h.workspace.detachLeavesOfType).toHaveBeenCalledWith(
        VIEW_TYPE_TASK_WORKBENCH
      );
      expect(h.workspace.detachLeavesOfType).toHaveBeenCalledWith(
        VIEW_TYPE_TASK_GANTT
      );
    });

    it("G1 restarting the timer clears the active interval before scheduling another", async () => {
      requestUrlMock.mockResolvedValue({ status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: {}, text: "" });
      const h = createHarness({});
      h.plugin.settings = {
        ...DEFAULT_SETTINGS,
        ganttSyncEnabled: true,
        ganttSyncUrl: "http://localhost:8787",
      };

      h.plugin.startGanttSyncTimer();
      const firstId = h.plugin.ganttSyncIntervalId;
      h.plugin.startGanttSyncTimer();

      expect(vi.getTimerCount()).toBe(1); // fixed: no leaked second timer
      expect(h.plugin.ganttSyncIntervalId).not.toBe(firstId);
    });

    it("the armed timer fires a non-forced sync every ganttSyncIntervalMinutes", async () => {
      requestUrlMock.mockResolvedValue({ status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: {}, text: "" });
      const h = createHarness({});
      h.plugin.settings = {
        ...DEFAULT_SETTINGS,
        ganttSyncEnabled: true,
        ganttSyncUrl: "http://localhost:8787",
        ganttSyncIntervalMinutes: 5,
      };

      h.plugin.startGanttSyncTimer();
      await flush(); // Run the immediate sync.
      requestUrlMock.mockClear();

      // With nothing changed, a periodic tick would legitimately skip the
      // POST because the hash is unchanged. That behavior is tested separately.
      // Change the snapshot content
      // (dayWidth=ganttZoom) so this tick's hash differs and a POST is
      // actually observable, proving the interval really fired.
      h.plugin.settings.ganttZoom = 40;

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await flush();

      expect(requestUrlMock).toHaveBeenCalledTimes(1);
    });

    it("a failed immediate/periodic sync only console.warns and does not throw into onload/the timer", async () => {
      requestUrlMock.mockRejectedValue(new Error("network down"));
      const h = createHarness({});
      const warnSpy = vi.spyOn(h.plugin.logger, "warn");
      h.plugin.settings = {
        ...DEFAULT_SETTINGS,
        ganttSyncEnabled: true,
        ganttSyncUrl: "http://localhost:8787",
      };

      expect(() => h.plugin.startGanttSyncTimer()).not.toThrow();
      await flush();

      expect(warnSpy).toHaveBeenCalledWith(
        "TaskWorkbenchPlugin",
        "[TaskWorkbench] gantt automatic sync failed",
        expect.any(Error)
      );
      expect(NoticeMock).not.toHaveBeenCalled(); // automatic sync never shows a Notice
    });
  });

  describe("syncReadonlyGanttNow", () => {
    it("a successful manual sync shows the success Notice", async () => {
      requestUrlMock.mockResolvedValue({ status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: {}, text: "" });
      const h = createHarness({});
      h.plugin.settings = {
        ...DEFAULT_SETTINGS,
        ganttSyncUrl: "http://localhost:8787",
      };

      await h.plugin.syncReadonlyGanttNow();

      expect(NoticeMock).toHaveBeenCalledWith("Ganttをサーバーへ同期しました。");
      expect(h.plugin.lastGanttSyncHash).not.toBe("");
    });

    it("manual sync with no URL configured shows the 'URL not set' Notice, not the generic failure Notice", async () => {
      const h = createHarness({});
      h.plugin.settings = { ...DEFAULT_SETTINGS, ganttSyncUrl: "" };

      await h.plugin.syncReadonlyGanttNow();

      expect(NoticeMock).toHaveBeenCalledWith(
        "Gantt同期URLが設定されていません。"
      );
      expect(requestUrlMock).not.toHaveBeenCalled();
    });

    it("a server error on manual sync shows the failure Notice and logs the exact console.error tag", async () => {
      requestUrlMock.mockResolvedValue({ status: 500, headers: {}, arrayBuffer: new ArrayBuffer(0), json: {}, text: "" });
      const h = createHarness({});
      const loggerErrorSpy = vi.spyOn(h.plugin.logger, "error");
      h.plugin.settings = {
        ...DEFAULT_SETTINGS,
        ganttSyncUrl: "http://localhost:8787",
      };

      await h.plugin.syncReadonlyGanttNow();

      expect(NoticeMock).toHaveBeenCalledWith(
        "Gantt同期に失敗しました。URLとサーバー状態を確認してください。"
      );
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        "TaskWorkbenchPlugin",
        "[TaskWorkbench] gantt manual sync failed",
        expect.any(Error)
      );
    });

    it("manual sync has no re-entrancy guard: two concurrent calls both POST", async () => {
      requestUrlMock.mockResolvedValue({ status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: {}, text: "" });
      const h = createHarness({});
      h.plugin.settings = {
        ...DEFAULT_SETTINGS,
        ganttSyncUrl: "http://localhost:8787",
      };

      await Promise.all([
        h.plugin.syncReadonlyGanttNow(),
        h.plugin.syncReadonlyGanttNow(),
      ]);

      expect(requestUrlMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("ObsidianVaultAdapter", () => {
    it("round-trips files and raises propagated errors for vanished paths", async () => {
      const h = createHarness({});
      const adapter = new ObsidianVaultAdapter(h.fakeApp);

      const created = await adapter.create("a/b.md", "hello");
      expect(await adapter.read(created)).toBe("hello");
      expect(adapter.getFileByPath("a/b.md")?.path).toBe("a/b.md");
      expect(adapter.getFileByPath("missing.md")).toBeNull();
      expect(adapter.getFiles()).toHaveLength(1);

      await expect(
        adapter.modify({ path: "missing.md" }, "x")
      ).rejects.toThrow("Task file not found");
      await expect(adapter.read({ path: "missing.md" })).rejects.toThrow(
        "Task file not found"
      );
    });
  });

  describe("ObsidianVaultAdapter.create() parent folder auto-creation", () => {
    /**
 * The `vaultApi` fake used by the harness above (and FakeVault in
 * tests/app/fake-vault.ts) is a flat Map<path, content> that never
 * models folder existence, so it cannot reproduce the real Vault's
 * "parent folder must already exist" constraint that this test covers.
 * This local fake tracks folder paths in a Set to model that hierarchy:
 * vault.create throws ENOENT when the parent folder is missing, and
 * vault.createFolder recursively creates all missing intermediate
 * folders, matching real Obsidian's verified behavior.
 */
    function createFolderAwareFakeApp(existingFolders: string[] = []) {
      const folders = new Set<string>(existingFolders);
      const files = new Map<
        string,
        { content: string; mtime: number; size: number }
      >();

      const makeTFile = (path: string, mtime: number, size: number): TFile => {
        const f = new TFile();
        f.path = path;
        (f as any).stat = { mtime, size, ctime: mtime };
        return f;
      };

      const createFolder = vi.fn(async (path: string) => {
        if (folders.has(path)) {
          throw new Error("Folder already exists.");
        }
        // Real createFolder recursively creates all missing intermediates.
        let cur = "";
        for (const part of path.split("/")) {
          cur = cur ? `${cur}/${part}` : part;
          folders.add(cur);
        }
        return {} as any;
      });

      const create = vi.fn(async (path: string, content: string) => {
        const lastSlash = path.lastIndexOf("/");
        const parent = lastSlash === -1 ? null : path.slice(0, lastSlash);
        if (parent && !folders.has(parent)) {
          throw new Error(
            `ENOENT: parent folder does not exist, '${parent}'`
          );
        }
        const mtime = Date.now();
        files.set(path, { content, mtime, size: content.length });
        return makeTFile(path, mtime, content.length);
      });

      const getAbstractFileByPath = vi.fn((path: string) => {
        if (folders.has(path)) {
          return {} as any; // TFolder stand-in; adapter only checks truthiness
        }
        const entry = files.get(path);
        if (!entry) return null;
        return makeTFile(path, entry.mtime, entry.size);
      });

      const vaultApi = { create, createFolder, getAbstractFileByPath };
      const fakeApp = { vault: vaultApi };
      return { fakeApp, vaultApi, folders, files };
    }

    it("creates missing nested parent folders before writing when they don't exist", async () => {
      const { fakeApp, vaultApi, folders, files } = createFolderAwareFakeApp([
        "tasks",
      ]);
      const adapter = new ObsidianVaultAdapter(fakeApp as any);

      const result = await adapter.create(
        "tasks/2026/08/2026-08-02 taskname.md",
        "hello world"
      );

      expect(vaultApi.createFolder).toHaveBeenCalledWith("tasks/2026/08");
      expect(folders.has("tasks/2026")).toBe(true);
      expect(folders.has("tasks/2026/08")).toBe(true);
      expect(files.get("tasks/2026/08/2026-08-02 taskname.md")?.content).toBe(
        "hello world"
      );
      expect(result.path).toBe("tasks/2026/08/2026-08-02 taskname.md");
    });

    it("does not call createFolder when the parent folder already exists", async () => {
      const { fakeApp, vaultApi } = createFolderAwareFakeApp([
        "tasks",
        "tasks/2026",
        "tasks/2026/08",
      ]);
      const adapter = new ObsidianVaultAdapter(fakeApp as any);

      await adapter.create("tasks/2026/08/2026-08-02 taskname.md", "hello");

      expect(vaultApi.createFolder).not.toHaveBeenCalled();
    });

    it("passes the correct content through to vault.create", async () => {
      const { fakeApp, vaultApi } = createFolderAwareFakeApp(["tasks"]);
      const adapter = new ObsidianVaultAdapter(fakeApp as any);

      await adapter.create("tasks/2026/08/note.md", "---\ntype: task\n---\n");

      expect(vaultApi.create).toHaveBeenCalledWith(
        "tasks/2026/08/note.md",
        "---\ntype: task\n---\n"
      );
    });

    it("propagates non-'already exists' errors from createFolder", async () => {
      const { fakeApp, vaultApi } = createFolderAwareFakeApp(["tasks"]);
      vaultApi.createFolder.mockRejectedValueOnce(
        new Error("Permission denied")
      );
      const adapter = new ObsidianVaultAdapter(fakeApp as any);

      await expect(
        adapter.create("tasks/2026/08/note.md", "x")
      ).rejects.toThrow("Permission denied");
    });

    it("swallows an 'already exists' race from createFolder and still writes the file", async () => {
      const { fakeApp, vaultApi, files, folders } = createFolderAwareFakeApp([
        "tasks",
      ]);
      // Simulate another process winning the race: the folder is actually
      // created concurrently, and our own createFolder call errors with
      // "already exists" because of it.
      vaultApi.createFolder.mockImplementationOnce(async (path: string) => {
        let cur = "";
        for (const part of path.split("/")) {
          cur = cur ? `${cur}/${part}` : part;
          folders.add(cur);
        }
        throw new Error("Folder already exists.");
      });
      const adapter = new ObsidianVaultAdapter(fakeApp as any);

      await adapter.create("tasks/2026/08/note.md", "x");

      expect(files.get("tasks/2026/08/note.md")?.content).toBe("x");
    });

    it("skips folder creation entirely for a top-level path with no parent", async () => {
      const { fakeApp, vaultApi } = createFolderAwareFakeApp([]);
      const adapter = new ObsidianVaultAdapter(fakeApp as any);

      await adapter.create("root-note.md", "x");

      expect(vaultApi.createFolder).not.toHaveBeenCalled();
    });
  });

  describe("happy path scenarios", () => {
    it("scenario A: startup → auto priority once → ribbon click shows the workbench via navigation", async () => {
      const h = createHarness({});
      const activateView = vi.fn();
      h.plugin.navigation = {
        activateView,
        activateGanttView: vi.fn(),
        openTaskFinder: vi.fn(),
      };

      await h.plugin.onload();
      await flush();

      // startup registrations all happened

      expect(h.commands).toHaveLength(14);

      expect(h.views.size).toBe(4);
      expect(h.ribbons).toHaveLength(2);
      // auto priority ran once on startup
      expect(
        h.savedData.some((d) => d.lastAutoPriorityUpdate === "2026-07-29")
      ).toBe(true);

      // user clicks "Task Workbench を開く"
      h.ribbons[0].callback();
      expect(activateView).toHaveBeenCalledTimes(1);
    });

    it("scenario B: create command → wizard input → file saved → opened automatically", async () => {
      const h = createHarness({});
      await h.plugin.onload();
      (h.plugin as any).promptInput = vi
        .fn()
        .mockResolvedValueOnce("   ") // re-prompted
        .mockResolvedValueOnce("Scenario Task");

      h.commands[3].callback();
      await flush();

      const path = "tasks/2026/07/2026-07-29 Scenario Task.md";
      expect(h.files.has(path)).toBe(true);
      expect(h.files.get(path)!.content).toContain("type: task");
      expect(NoticeMock).toHaveBeenCalledWith(
        expect.stringContaining("Scenario Task")
      );
      expect(h.getLeaf).toHaveBeenCalledWith(true);
      expect(h.openFile).toHaveBeenCalledTimes(1);
      expect((h.openFile.mock.calls[0][0] as TFile).path).toBe(path);
    });

    it("scenario C: finder command opens the task finder dialog entry point", async () => {
      const h = createHarness({});
      const openTaskFinder = vi.fn();
      h.plugin.navigation = {
        activateView: vi.fn(),
        activateGanttView: vi.fn(),
        openTaskFinder,
      };
      await h.plugin.onload();

      // user runs "Open task finder"
      h.commands[2].callback();

      // the dialog listing/selection itself is built with NavigationService

      expect(openTaskFinder).toHaveBeenCalledTimes(1);
    });

    it("scenario D: date rollover → restart → auto priority re-runs and records the new date", async () => {
      vi.setSystemTime(new Date("2026-07-28T10:00:00Z"));
      const h = createHarness({ lastAutoPriorityUpdate: "2026-07-28" });
      // an existing managed task from the previous day
      await createTask(
        new ObsidianVaultAdapter(h.fakeApp),
        { ...DEFAULT_SETTINGS },
        "Day One Task"
      );

      // the next day Obsidian restarts
      vi.setSystemTime(new Date("2026-07-29T10:00:00Z"));
      await h.plugin.onload();
      await flush();

      // date differs → the run happened and was persisted
      expect(
        h.savedData.some((d) => d.lastAutoPriorityUpdate === "2026-07-29")
      ).toBe(true);

      // The update changes this metadata, so unchanged files are left untouched.
    });
  });

  describe("renderEmbed (embed table)", () => {
    /**
 * Creates a real parent task file in the harness's fake vault (through
 * the same createTask/vault pipeline production code uses) and
 * returns its TaskRow, applying and persisting any overrides so the
 * next loadTasks call inside renderEmbed picks them up for real.
 */
    async function seedParentTask(
      h: Harness,
      name: string,
      overrides: Partial<TaskRow> = {}
    ): Promise<TaskRow> {
      const adapter = new ObsidianVaultAdapter(h.fakeApp);
      const row = await createTask(adapter, h.plugin.settings, name);
      Object.assign(row, overrides);
      const file = adapter.getFileByPath(row.file.path)!;
      await adapter.modify(
        file,
        buildFullNote(row, row.subtasks ?? new Map())
      );
      return row;
    }

    /** Adds a real subtask to `parent`'s file, applying + persisting overrides. */
    async function seedSubtask(
      h: Harness,
      parent: TaskRow,
      name: string,
      overrides: Partial<TaskRow> = {}
    ): Promise<TaskRow> {
      const adapter = new ObsidianVaultAdapter(h.fakeApp);
      const subtask = await addSubtask(adapter, h.plugin.settings, parent, name);
      Object.assign(subtask, overrides);
      parent.subtasks!.set(subtask.key!, subtask);
      const file = adapter.getFileByPath(parent.file.path)!;
      await adapter.modify(
        file,
        buildFullNote(parent, parent.subtasks!)
      );
      return subtask;
    }

    function optionsOf(select: FakeEl): FakeEl[] {
      return byTag(select, "option");
    }

    /** Registers onload and drives the ```task-list processor once. */
    async function renderTaskListEmbed(
      h: Harness,
      source = ""
    ): Promise<FakeEl> {
      const handler = h.processors.get("task-list")!;
      const el = makeFakeEl("div");
      await handler(source, el);
      return el;
    }

    it("renders タスク/優先度/状態/現在のステータス/期限/タグ/開く with the documented fallbacks", async () => {
      const h = createHarness({});
      stubHolidays(h.plugin, {});
      await h.plugin.onload();
      await seedParentTask(h, "Parent Task", {
        statusLabel: "in_progress",
        currentStatus: "調査中",
        tags: ["urgent", "backend"],
        priority: 3,
        priorityMode: "manual",
      });

      const el = await renderTaskListEmbed(h);

      expect(byClass(el, "task-workbench-embed")).toHaveLength(1);
      expect(byClass(el, "task-workbench-embed-titlebar")).toHaveLength(1);
      expect(byClass(el, "task-workbench-embed-table")).toHaveLength(1);

      const tbody = byTag(el, "tbody")[0];
      expect(tbody.children).toHaveLength(1);
      const row = tbody.children[0];
      const cells = row.children;

      // col1 タスク: parent name, bold via.strong-parent.
      expect(byClass(cells[0], "strong-parent")[0].textContent).toBe(
        "Parent Task"
      );

      expect(byTag(cells[1], "button")).toHaveLength(0);
      const prioritySpan = cells[1].children[0];
      expect(prioritySpan.textContent).toBe("★★★☆☆");
      expect(prioritySpan.classList.contains("task-workbench-priority-readonly")).toBe(true);
      expect(prioritySpan.classList.contains("priority-manual")).toBe(true);
      // col3 状態: localized statusLabel.
      expect(cells[2].textContent).toBe("進行中");
      // col4 現在のステータス.
      expect(cells[3].textContent).toBe("調査中");
      // col5 期限: unset dueDate → empty text, no overdue/due-soon row class

      expect(cells[4].textContent).toBe("");
      expect(row.classList.contains("twb-overdue-row")).toBe(false);
      expect(row.classList.contains("twb-due-soon-row")).toBe(false);
      // col6 タグ: tags are joined with commas and no added spaces.
      expect(cells[5].textContent).toBe("urgent,backend");
      // col7 開く: button.
      expect(byTag(cells[6], "button")[0].textContent).toBe("開く");
    });

    it("auto-mode priority renders five empty stars when there is no due date", async () => {
      const h = createHarness({});
      stubHolidays(h.plugin, {});
      await h.plugin.onload();
      // createTask defaults: priorityMode="auto", priority=0, no dueDate.
      await seedParentTask(h, "Auto Priority Task");

      const el = await renderTaskListEmbed(h);
      const tbody = byTag(el, "tbody")[0];
      const prioritySpan = tbody.children[0].children[1].children[0];

      expect(prioritySpan.textContent).toBe("☆☆☆☆☆");
      expect(prioritySpan.classList.contains("task-workbench-priority-readonly")).toBe(true);
      expect(prioritySpan.classList.contains("priority-auto")).toBe(true);
    });

    it("applies overdue and due-soon classes based on the current date", async () => {
      const h = createHarness({});
      stubHolidays(h.plugin, {});
      await h.plugin.onload();
      await seedParentTask(h, "Overdue Task", { dueDate: "2026-07-01" });
      await seedParentTask(h, "Due Soon Task", { dueDate: "2026-07-30" });
      await seedParentTask(h, "Later Task", { dueDate: "2026-08-30" });

      const el = await renderTaskListEmbed(h);
      const tbody = byTag(el, "tbody")[0];
      const rowByName = (name: string): FakeEl =>
        tbody.children.find((tr) => deepText(tr).includes(name))!;

      expect(
        rowByName("Overdue Task").classList.contains("twb-overdue-row")
      ).toBe(true);
      expect(
        rowByName("Due Soon Task").classList.contains("twb-due-soon-row")
      ).toBe(true);
      expect(
        rowByName("Later Task").classList.contains("twb-overdue-row")
      ).toBe(false);
      expect(
        rowByName("Later Task").classList.contains("twb-due-soon-row")
      ).toBe(false);
    });

    it("overdue/due-soon boundary values (system date 2026-07-29): days=-1 overdue, days=0/3 due-soon, days=4 neither", async () => {
      const h = createHarness({});
      stubHolidays(h.plugin, {});
      await h.plugin.onload();

      await seedParentTask(h, "Days Minus1", { dueDate: "2026-07-28" }); // days=-1: first overdue
      await seedParentTask(h, "Days Zero", { dueDate: "2026-07-29" }); // days=0: due today, due-soon
      await seedParentTask(h, "Days Three", { dueDate: "2026-08-01" }); // days=3: last due-soon
      await seedParentTask(h, "Days Four", { dueDate: "2026-08-02" }); // days=4: first non-due-soon

      const el = await renderTaskListEmbed(h);
      const tbody = byTag(el, "tbody")[0];
      const rowByName = (name: string): FakeEl =>
        tbody.children.find((tr) => deepText(tr).includes(name))!;

      const minus1 = rowByName("Days Minus1");
      expect(minus1.classList.contains("twb-overdue-row")).toBe(true);
      expect(minus1.classList.contains("twb-due-soon-row")).toBe(false);

      const zero = rowByName("Days Zero");
      expect(zero.classList.contains("twb-overdue-row")).toBe(false);
      expect(zero.classList.contains("twb-due-soon-row")).toBe(true);

      const three = rowByName("Days Three");
      expect(three.classList.contains("twb-overdue-row")).toBe(false);
      expect(three.classList.contains("twb-due-soon-row")).toBe(true);

      const four = rowByName("Days Four");
      expect(four.classList.contains("twb-overdue-row")).toBe(false);
      expect(four.classList.contains("twb-due-soon-row")).toBe(false);
    });

    it("grouped mode (flatDueSort=false, default) shows parent bold and child plain — no slash prefix", async () => {
      const h = createHarness({});
      stubHolidays(h.plugin, {});
      await h.plugin.onload();
      const parent = await seedParentTask(h, "Group Parent");
      await seedSubtask(h, parent, "Group Child");

      const el = await renderTaskListEmbed(h);
      const tbody = byTag(el, "tbody")[0];

      expect(tbody.children).toHaveLength(2);
      expect(byClass(tbody.children[0], "strong-parent")[0].textContent).toBe(
        "Group Parent"
      );
      expect(tbody.children[1].children[0].textContent).toBe("Group Child");
      expect(deepText(el)).not.toContain("Group Parent / Group Child");
    });

    it("flatDueSort checkbox seeds from config and toggling re-renders 「親 / 子」 prefix live", async () => {
      const h = createHarness({});
      stubHolidays(h.plugin, {});
      await h.plugin.onload();
      const parent = await seedParentTask(h, "Flat Parent");
      await seedSubtask(h, parent, "Flat Child", { dueDate: "2026-08-01" });

      const el = await renderTaskListEmbed(h, "flatDueSort=true");

      const checkboxes = byTag(el, "input").filter((i) => i.type === "checkbox");
      const flatCheckbox = checkboxes[0];
      expect(flatCheckbox.checked).toBe(true);
      expect(deepText(el)).toContain("Flat Parent / Flat Child");

      // toggling off re-renders the table only, no reload of tasks.
      flatCheckbox.checked = false;
      dispatch(flatCheckbox, "change");

      expect(deepText(el)).not.toContain("Flat Parent / Flat Child");
      expect(deepText(el)).toContain("Flat Child");
    });

    it("showCompleted checkbox seeds from config and hides/shows completed tasks", async () => {
      const h = createHarness({});
      stubHolidays(h.plugin, {});
      await h.plugin.onload();
      await seedParentTask(h, "Done Task", { completed: true });

      const hiddenEl = await renderTaskListEmbed(h, "showCompleted=false");
      expect(deepText(hiddenEl)).toContain("表示対象のタスクがありません");

      const shownEl = await renderTaskListEmbed(h, "showCompleted=true");
      const checkboxes = byTag(shownEl, "input").filter(
        (i) => i.type === "checkbox"
      );
      expect(checkboxes[1].checked).toBe(true);
      expect(deepText(shownEl)).toContain("Done Task");
    });

    it("status dropdown lists すべてのステータス + DEFAULT_STATUSES, seeded from EmbedConfig.status", async () => {
      const h = createHarness({});
      stubHolidays(h.plugin, {});
      await h.plugin.onload();
      await seedParentTask(h, "Waiting Task", { statusLabel: "waiting" });

      const el = await renderTaskListEmbed(h, "status=waiting");
      const titlebar = byClass(el, "task-workbench-embed-titlebar")[0];
      const statusSelect = byTag(titlebar, "select")[0];

      expect(optionsOf(statusSelect).map((o) => o.value)).toEqual([
        "all",
        "active",
        "in_progress",
        "waiting",
        "hold",
        "done",
      ]);
      expect(optionsOf(statusSelect).map((o) => o.textContent)).toEqual([
        "すべてのステータス",
        "未着手",
        "進行中",
        "待ち",
        "保留",
        "完了",
      ]);
      expect(statusSelect.value).toBe("waiting");
    });

    it("sort-key and sort-direction dropdowns list the options, seeded from EmbedConfig", async () => {
      const h = createHarness({});
      stubHolidays(h.plugin, {});
      await h.plugin.onload();

      const el = await renderTaskListEmbed(h, "sort=title\ndir=desc");
      const titlebar = byClass(el, "task-workbench-embed-titlebar")[0];
      const selects = byTag(titlebar, "select");
      const sortSelect = selects[1];
      const dirSelect = selects[2];

      expect(optionsOf(sortSelect).map((o) => o.value)).toEqual([
        "dueDate",
        "updatedAt",
        "createdAt",
        "title",
        "statusLabel",
      ]);
      expect(optionsOf(sortSelect).map((o) => o.textContent)).toEqual([
        "期限順",
        "更新日順",
        "作成日順",
        "タスク名順",
        "ステータス順",
      ]);
      expect(sortSelect.value).toBe("title");

      expect(optionsOf(dirSelect).map((o) => o.value)).toEqual([
        "asc",
        "desc",
      ]);
      expect(dirSelect.value).toBe("desc");
    });

    it("filter input re-renders the table immediately without a loadTasks re-fetch", async () => {
      const h = createHarness({});
      stubHolidays(h.plugin, {});
      await h.plugin.onload();
      await seedParentTask(h, "Alpha Task");
      await seedParentTask(h, "Beta Task");

      const el = await renderTaskListEmbed(h);
      const fetchCallsBefore = h.vaultApi.getMarkdownFiles.mock.calls.length;

      const filterInput = byClass(el, "task-workbench-search")[0];
      expect(filterInput.placeholder).toBe("フィルター...");
      filterInput.value = "Alpha";
      dispatch(filterInput, "input");

      // no re-fetch — the same loaded task list is re-filtered.
      expect(h.vaultApi.getMarkdownFiles.mock.calls.length).toBe(
        fetchCallsBefore
      );
      expect(deepText(el)).toContain("Alpha Task");
      expect(deepText(el)).not.toContain("Beta Task");
    });

    it("「ビューを開く」 opens the Workbench view, not the Gantt view", async () => {
      const h = createHarness({});
      stubHolidays(h.plugin, {});
      const activateView = vi.fn();
      const activateGanttView = vi.fn();
      h.plugin.navigation = {
        activateView,
        activateGanttView,
        openTaskFinder: vi.fn(),
      };
      await h.plugin.onload();

      const el = await renderTaskListEmbed(h);
      const titlebar = byClass(el, "task-workbench-embed-titlebar")[0];
      const openViewButton = byTag(titlebar, "button").find(
        (b) => b.textContent === "ビューを開く"
      )!;
      dispatch(openViewButton, "click");

      expect(activateView).toHaveBeenCalledTimes(1);
      expect(activateGanttView).not.toHaveBeenCalled();
    });

    it("row 「開く」 button routes to navigation.openTaskItem with that row", async () => {
      const h = createHarness({});
      stubHolidays(h.plugin, {});
      const openTaskItem = vi.fn();
      h.plugin.navigation = {
        activateView: vi.fn(),
        activateGanttView: vi.fn(),
        openTaskFinder: vi.fn(),
        openTaskItem,
      };
      await h.plugin.onload();
      await seedParentTask(h, "Openable Task");

      const el = await renderTaskListEmbed(h);
      const tbody = byTag(el, "tbody")[0];
      const openButton = byTag(tbody.children[0], "button")[0];
      dispatch(openButton, "click");

      expect(openTaskItem).toHaveBeenCalledTimes(1);
      expect(openTaskItem.mock.calls[0][0].title).toBe("Openable Task");
    });

    it("negative maxRows yields zero rows (count>=maxRows breaks immediately) with the empty-state message", async () => {
      const h = createHarness({});
      stubHolidays(h.plugin, {});
      await h.plugin.onload();
      await seedParentTask(h, "Only Task");

      const el = await renderTaskListEmbed(h, "maxRows=-1");

      expect(byTag(el, "table")).toHaveLength(0);
      expect(deepText(el)).toContain("表示対象のタスクがありません");
    });

    it("maxRows=0 (the true zero boundary, distinct from negative) also yields zero rows", async () => {
      const h = createHarness({});
      stubHolidays(h.plugin, {});
      await h.plugin.onload();
      await seedParentTask(h, "Only Task");

      const el = await renderTaskListEmbed(h, "maxRows=0");

      expect(byTag(el, "table")).toHaveLength(0);
      expect(deepText(el)).toContain("表示対象のタスクがありません");
    });

    it("positive maxRows slices to that many rows after filter/sort", async () => {
      const h = createHarness({});
      stubHolidays(h.plugin, {});
      await h.plugin.onload();
      await seedParentTask(h, "Task A", { dueDate: "2026-08-01" });
      await seedParentTask(h, "Task B", { dueDate: "2026-08-02" });
      await seedParentTask(h, "Task C", { dueDate: "2026-08-03" });

      const el = await renderTaskListEmbed(h, "maxRows=2\nsort=dueDate\ndir=asc");
      const tbody = byTag(el, "tbody")[0];

      expect(tbody.children).toHaveLength(2);
      expect(deepText(tbody.children[0])).toContain("Task A");
      expect(deepText(tbody.children[1])).toContain("Task B");
    });

    it("zero tasks in the vault shows 「表示対象のタスクがありません」", async () => {
      const h = createHarness({});
      stubHolidays(h.plugin, {});
      await h.plugin.onload();

      const el = await renderTaskListEmbed(h);

      expect(byTag(el, "table")).toHaveLength(0);
      expect(deepText(el)).toContain("表示対象のタスクがありません");
    });

    it("an invalid sort value does not throw — falls back to compareBy's own handling", async () => {
      const h = createHarness({});
      stubHolidays(h.plugin, {});
      await h.plugin.onload();
      await seedParentTask(h, "Task X");

      await expect(
        renderTaskListEmbed(h, "sort=bogusSortKey")
      ).resolves.toBeTruthy();
    });

    it("loadTasks() failures propagate uncaught through renderEmbed", async () => {
      const h = createHarness({});
      stubHolidays(h.plugin, {});
      await h.plugin.onload();
      h.vaultApi.getMarkdownFiles.mockImplementation(() => {
        throw new Error("vault listing blew up");
      });

      const handler = h.processors.get("task-list")!;
      const el = makeFakeEl("div");

      await expect(handler("", el)).rejects.toThrow("vault listing blew up");
    });
  });
});
