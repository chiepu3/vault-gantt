import { ApprovalView, VIEW_TYPE_AI_APPROVAL } from "./ui/approval-view";
import { DEFAULT_MCP_SETTINGS, mcpSettingsSchema, startMcpServer, type McpServerHandle } from "./mcp/server";
import { operationInputSchemas, type ViewOperationId, type OperationInputMap } from "./contracts/operations";
import type { OperationRequestResultV1 } from "./contracts/preview";
import { TaskFinderModal } from "./ui/task-finder-modal";
import { detectConfiguredDailyNoteSettings } from "./app/daily-note-creation";
import type { PreviewUiHostPorts } from "./contracts/ports";
import { ViewStateService } from "./app/view-state-service";
import { OperationService } from "./app/operation-service";
import { SettingsPersistence } from "./app/settings-persistence";
import { canonical } from "./app/operations/runtime";
import { Notice, Plugin, TFile, moment, Platform, requestUrl } from "obsidian";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS, DEFAULT_STATUSES } from "./core/constants";

import { Logger } from "./core/logger";

import {
  DailyTodoItem,
  DailyTodoSummary,
  TaskPatch,
  TaskRow,
  TaskUpdateCommand,
  TaskWorkbenchSettings,
} from "./core/types";
import {
  dueDaysFromToday,
  getEffectivePriority,
  getStatusLabel,
  parseEmbedConfig,
  todayStr,
} from "./core/utils";
import type { EmbedConfig } from "./core/utils";
import {
  confirmDragWorkloadShift,
  DailyTodoModal,
  GanttParentPickerModal,
  openMarkerModal,
  TextInputModal,
} from "./ui/modals";
import { DailyTodoService, updateDailyTodos } from "./app/daily-todo-service";
import { getGanttParentRows } from "./app/gantt-layout";
import {
  getGanttSyncEndpoint,
  syncReadonlyGanttSnapshot,
} from "./app/gantt-sync-service";
import {
  getCollapsedWorkbenchRows,
  normalizePriorityMode,
} from "./app/workbench-display";
import {
  VaultAdapter,
  VaultFile,
  addSubtaskWithPlan,
  deleteSubtaskTaskItem,
  loadTasks,
} from "./app/task-operations";
import { AutoPriorityController, TaskCache } from "./app/auto-priority";
import {
  createRequestUrlNationalHolidayFetcher,
  HolidayService,
  NationalHolidayFetcher,
} from "./app/holiday-service";
import { TaskFileService, modalPrompt } from "./app/task-file-service";
import { HistoryManager } from "./app/history-manager";
import { OperationRegistry } from "./app/operation-registry";
import { ScheduleGhostStore } from "./app/schedule-ghost";
import { ChatSession } from "./ai/chat-session";
import { SdkChatProvider } from "./ai/sdk-provider";
import { AI_SECRET_ID, defaultAiSettings, listModels, normalizeAiSettings, toConnectionConfig, type AiConnectionSettings, type ModelListResult } from "./ai/connection-settings";
import { AgentView, VIEW_TYPE_AI_CHAT } from "./ui/agent-view";
import { NavigationService as ObsidianNavigationService } from "./app/navigation-service";
import { ToolAdapter } from "./agent-tools/tool-adapter";
import { TaskWorkbenchSettingTab } from "./ui/settings-tab";
import {
  TaskWorkbenchView,
  getDisplayRows,
} from "./ui/task-workbench-view";
import type {
  DisplayRowsOptions,
  TaskWorkbenchViewHost,
} from "./ui/task-workbench-view";
import { TaskGanttView } from "./ui/task-gantt-view";
import type { TaskGanttViewHost } from "./ui/task-gantt-view";

// re-exported so consumers (and tests) can reference the real
// settings tab class through the plugin module.
export { TaskWorkbenchSettingTab };

// glossary identifiers — view types and the embed block language
export const VIEW_TYPE_TASK_WORKBENCH = "task-workbench-view";
export const VIEW_TYPE_TASK_GANTT = "task-gantt-view";
// fenced code block language detected for embeds (```task-list)
export const EMBED_BLOCK = "task-list";

/**
 *
 *
 * Navigation port used by commands and ribbon buttons. Implemented by the
 * NavigationService class in src/app/navigation-service.ts (leaf reuse,
 * getLeaf("tab") → getLeaf(true) fallback, task finder modal, openTaskItem
 * link handling and its error propagation/fallback contracts).
 * Views open in the active window. Task loading has no timeout.
 *
 * openTaskItem is optional on the port because commands never call it
 * directly — TaskFinderModal does. The concrete NavigationService always
 * implements it.
 */
export interface NavigationService {
  activateView(): Promise<void> | void;
  activateGanttView(): Promise<void> | void;
  openTaskFinder(): Promise<void> | void;
  openTaskItem?(item: TaskRow): Promise<void> | void;
}















interface EmbedTableState {
  filterText: string;
  statusFilter: string;
  sortKey: string;
  sortDir: "asc" | "desc";
  flatDueSort: boolean;
  showCompleted: boolean;
}

/**
 * Thin bridge from Obsidian's Vault to the testable VaultAdapter interface.
 */
export class ObsidianVaultAdapter implements VaultAdapter {
  constructor(private readonly app: App) {}

  /**
 *
 * Obsidian's real Vault.create throws ENOENT if the parent folder does
 * not already exist (it does not auto-create intermediate directories).
 * Task paths are nested (tasks/YYYY/MM/...), so on first use of a new
 * year/month the write would otherwise fail. createFolder recursively
 * creates all missing intermediate folders in one call, so ensure the
 * parent exists first. Only swallow "already exists" races from
 * createFolder; any other error propagates.
 */
  async create(path: string, content: string): Promise<VaultFile> {
    await this.ensureParentFolder(path);
    const file = await this.app.vault.create(path, content);
    return toVaultFile(file);
  }

  /**
 *
 * Ensures the parent folder of `path` exists, creating it (and any
 * missing intermediate folders) via createFolder if necessary.
 */
  private async ensureParentFolder(path: string): Promise<void> {
    const lastSlash = path.lastIndexOf("/");
    if (lastSlash === -1) {
      // No parent folder component — nothing to create.
      return;
    }
    const parentPath = path.slice(0, lastSlash);
    if (this.app.vault.getAbstractFileByPath(parentPath)) {
      return;
    }
    try {
      await this.app.vault.createFolder(parentPath);
    } catch (err) {
      // Defensive against a race where the folder was created between our
      // existence check and this call. Obsidian's real error message is
      // "Folder already exists." — only swallow that case; other errors
      // (e.g. permission issues) must propagate.
      const message = err instanceof Error ? err.message : String(err);
      if (!/already exists/i.test(message)) {
        throw err;
      }
    }
  }

  async modify(file: VaultFile, content: string): Promise<void> {
    await this.app.vault.modify(this.requireTFile(file.path), content);
  }

  async process(file: VaultFile, transform: (content: string) => string): Promise<string> {
    return this.app.vault.process(this.requireTFile(file.path), transform);
  }

  async read(file: VaultFile): Promise<string> {
    return this.app.vault.read(this.requireTFile(file.path));
  }

  getFiles(): VaultFile[] {
    return this.app.vault.getMarkdownFiles().map(toVaultFile);
  }

  getFileByPath(path: string): VaultFile | null {
    const abstract = this.app.vault.getAbstractFileByPath(path);
    if (!(abstract instanceof TFile)) {
      return null;
    }
    return toVaultFile(abstract);
  }

  private requireTFile(path: string): TFile {
    const abstract = this.app.vault.getAbstractFileByPath(path);
    if (!(abstract instanceof TFile)) {
      // file vanished mid-operation → error propagates
      throw new Error(`Task file not found: ${path}`);
    }
    return abstract;
  }
}

function toVaultFile(file: TFile): VaultFile {
  return {
    path: file.path,
    stat: file.stat
      ? { mtime: file.stat.mtime, size: file.stat.size }
      : undefined,
  };
}

export default class TaskWorkbenchPlugin extends Plugin {

  logger!: Logger;


  // assigned by loadSettings at the very start of onload
  settings!: TaskWorkbenchSettings;

  // active Gantt sync timer handle (null = stopped)
  ganttSyncIntervalId: ReturnType<typeof setInterval> | null = null;

  // hash of the last snapshot successfully POSTed ("" = never
  // synced this session — a never-synced state never matches any real hash,
  // so the next sync always runs, even when `force` is false).
  lastGanttSyncHash = "";
  // ISO 8601 timestamp of the last successful sync ("" = never
  // synced this session). Neither field is persisted: a plugin
  // reload always starts as "never synced".
  lastGanttSyncAt = "";

  // the real NavigationService
  // (leaf reuse with getLeaf("tab") → getLeaf(true) fallback, task finder
  // dialog, openTaskItem link handling). Host state is read lazily, so the
  // service can be constructed before onload loads the settings.
  navigation: NavigationService = new ObsidianNavigationService(
    this,
    () => new ObsidianVaultAdapter(this.app),
    VIEW_TYPE_TASK_WORKBENCH,
    VIEW_TYPE_TASK_GANTT
  );

  readonly taskFiles = new TaskFileService();
  readonly autoPriority = new AutoPriorityController();
  readonly taskCache: TaskCache = new Map();
  readonly historyManager = new HistoryManager();
  readonly scheduleGhosts = new ScheduleGhostStore();
  private createOperations(): OperationRegistry {
    const settings = () => this.settings;
    return new OperationRegistry({
    get settings() { return settings(); },
    historyManager: this.historyManager,
    invalidate: async () => { this.scheduleGhosts.clear(); this.taskCache.clear(); await this.refreshOpenViews(); },
    }, () => this.vaultAdapter());
  }
  readonly operations = this.createOperations();
  private settingsPersistence?: SettingsPersistence;
  private settingsWriter(): SettingsPersistence {
    return this.settingsPersistence ??= new SettingsPersistence({ settings: () => this.settings,
      coordinate: (run) => this.operations.coordinate(run), write: (settings) => this.saveData({ ...settings, ai: this.aiSettings }), read: () => this.loadData() });
  }
  private createOperationService(): OperationService {
    const settings = () => this.settings, ui = () => this.uiPort, session = () => this.chatSession, logger = () => this.logger, version = () => this.manifest.version;
    return new OperationService({ get settings() { return settings(); }, historyManager: this.historyManager, coordinator: this.operations,
      persistSettings: (candidate, keys) => this.settingsWriter().persist(candidate, keys),
      publishesSettings: true,
      get ui() { return ui(); }, get chatSession() { return session(); }, get logger() { return logger(); },
      integration: { get pluginVersion() { return version(); }, fetchNationalHolidays: (current) => this.holidayFetcher(current), detectDailyNoteSettings: () => detectConfiguredDailyNoteSettings(this.app) },
      sendExternal: async (destination, body) => { const response = await requestUrl({ url: destination, method: "POST", headers: { "content-type": "application/json" }, body }); if (response.status < 200 || response.status >= 300) throw new Error("EXTERNAL_SEND_FAILED"); },
      restartSync: () => this.startGanttSyncTimer(false),
      requestApproval: async (previewId) => { await this.uiPort.requestApproval(previewId); },
      invalidate: async () => { this.scheduleGhosts.clear(); this.taskCache.clear(); await this.refreshOpenViews(); },
    }, () => this.vaultAdapter(), `vault-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  }
  readonly operationService = this.createOperationService();
  get previewPort() { return this.operationService.previewPort; }
  get humanApprovalPort() { return this.operationService.humanApprovalPort; }
  get contextReadPort() { return this.operationService.contextPort; }
  readonly uiPort = new ViewStateService(this.previewPort, async (previewId) => {
    const preview = this.previewPort.inspect(previewId);
    if (preview?.origin.kind === "mcp") await this.activateApprovalView();
    else await this.openAIChat("tab");
  }, (id, input) => this.requestGlobalView(id, input));
  private async activateOperationView(type: string, position: "tab" | "left" | "right" = "tab"): Promise<void> {
    if (position === "tab") { if (type === VIEW_TYPE_TASK_WORKBENCH) await this.navigation.activateView(); else await this.navigation.activateGanttView(); return; }
    const workspace = this.app.workspace;
    const leaf = workspace.getLeavesOfType(type)[0] ?? (position === "left" ? workspace.getLeftLeaf(true) : workspace.getRightLeaf(true));
    if (!leaf) throw new Error("UI_UNAVAILABLE");
    await leaf.setViewState({ type, active: true }); await workspace.revealLeaf(leaf);
  }
  private async requestGlobalView(id: ViewOperationId, input: unknown): Promise<OperationRequestResultV1> {
    const args = operationInputSchemas[id].parse(input);
    if (id === "V01") await this.activateOperationView(VIEW_TYPE_TASK_WORKBENCH, (args as OperationInputMap["V01"]).position);
    else if (id === "V02") await this.activateOperationView(VIEW_TYPE_TASK_GANTT, (args as OperationInputMap["V02"]).position);
    else if (id === "V03") {
      const rows = await this.operationService.rows(), finder = new TaskFinderModal(this.app, { openTaskItem: (row) => this.navigation.openTaskItem?.(row) }, rows);
      finder.open(); finder.setQuery((args as OperationInputMap["V03"]).query ?? "");
    } else if (id === "V04") await this.navigation.openTaskItem?.(await this.operationService.get((args as OperationInputMap["V04"]).taskId));
    else if (id === "V05") await this.openOrCreateDailyTodoForDate((args as OperationInputMap["V05"]).date);
    else if (id === "V06") await this.openAIChat((args as OperationInputMap["V06"]).position ?? "tab");
    else if (id === "D08") {
      const file = this.app.vault.getFileByPath((args as OperationInputMap["D08"]).path);
      if (!file) throw new Error("NOT_FOUND");
      await this.app.workspace.getLeaf(false).openFile(file);
    } else return { schemaVersion: 1, resultKind: "request", operationId: id, status: "unavailable", effects: [], error: { code: "UI_UNAVAILABLE", retryable: false, nextAction: "対象viewIdを指定してください。" } };
    return { schemaVersion: 1, resultKind: "request", operationId: id, status: "applied", effects: [{ kind: "view", before: null, after: args as import("./contracts/context").Json, affectedIds: [] }] };
  }
  get historyPort() { return this.historyManager; }
  chatSession!: ChatSession;
  /** AI connection settings live next to, not inside, `settings` so snapshots, previews, AI context and MCP never see them. */
  aiSettings: AiConnectionSettings = defaultAiSettings();
  aiModels: string[] = [];
  private viewCounter = 0;
  private mcpServer?: McpServerHandle;
  private mcpTail: Promise<void> = Promise.resolve();
  private mcpSessionToken?: string;
  private unloading = false;
  private previewUiPorts(kind: string): PreviewUiHostPorts {
    return { operationService: this.operationService, previewPort: this.previewPort, projectionDetailPort: this.previewPort,
      humanApprovalPort: this.humanApprovalPort, historyPort: this.historyPort, uiPort: this.uiPort,
      undoPort: { undoEntry: (entryId) => this.undoEntry(entryId) }, viewStatePort: this.uiPort, viewId: `${kind}-${++this.viewCounter}` };
  }
  getMcpVaultInstanceId(): string { return this.operationService.vaultInstanceId; }
  getMcpSettings() { return this.settings.mcp ?? DEFAULT_MCP_SETTINGS; }
  getMcpStatus(): string {
    if (!Platform.isDesktopApp) return "デスクトップ版で利用できます。";
    return this.mcpServer?.endpoint ?? (this.getMcpSettings().enabled ? "停止中" : "無効");
  }
  private queueMcp(action: () => Promise<void>): Promise<void> {
    const result = this.mcpTail.then(action); this.mcpTail = result.catch(() => undefined); return result;
  }
  async configureMcp(): Promise<void> {
    return this.queueMcp(async () => {
      await this.mcpServer?.stop(); this.mcpServer = undefined;
      if (this.unloading || !Platform.isDesktopApp || !this.getMcpSettings().enabled) return;
      const settings = mcpSettingsSchema.parse(this.getMcpSettings());
      const token = (settings.secretId ? this.app.secretStorage?.getSecret(settings.secretId) : null) ?? this.mcpSessionToken;
      const handle = await startMcpServer({ operations: this.operationService, previews: this.previewPort, context: this.contextReadPort, history: this.historyPort,
        vaultInstanceId: this.operationService.vaultInstanceId, principal: { id: "mcp-local", label: "ローカルMCP接続" }, isDesktop: true, token: token ?? undefined }, settings);
      if (this.unloading) { await handle.stop(); return; }
      this.mcpServer = handle;
      if (handle.sessionToken) {
        this.mcpSessionToken = handle.sessionToken;
        if (!token && this.app.secretStorage) {
          try { await this.persistMcpToken(handle.sessionToken); }
          catch (error) { await handle.stop(); this.mcpServer = undefined; throw error; }
        }
      }
    });
  }
  private async persistMcpToken(token: string): Promise<void> {
    this.mcpSessionToken = token;
    if (this.app.secretStorage) {
      const secretId = this.getMcpSettings().secretId ?? `vault-gantt-mcp-${this.operationService.vaultInstanceId}`;
      this.app.secretStorage.setSecret(secretId, token);
      this.settings.mcp = { ...this.getMcpSettings(), secretId };
      await this.saveSettings();
    }
  }
  async generateMcpToken(regenerate = false): Promise<void> {
    if (!Platform.isDesktopApp || this.unloading) throw new Error("デスクトップ版で利用できます。");
    return this.queueMcp(async () => {
      if (this.unloading) return;
      const settings = this.getMcpSettings();
      const existing = (settings.secretId ? this.app.secretStorage?.getSecret(settings.secretId) : null) ?? this.mcpSessionToken;
      if (existing && !regenerate) { new Notice("トークンは生成済みです。変更する場合は再生成してください。"); return; }
      const token = this.mcpServer?.running ? await this.mcpServer.regenerateToken() : (await import("./mcp/auth")).generateMcpToken();
      try { await this.persistMcpToken(token); }
      catch (error) { await this.mcpServer?.stop(); this.mcpServer = undefined; throw error; }
      new Notice(this.app.secretStorage ? "MCPトークンを保存しました" : "MCPトークンを生成しました。この起動中だけ有効です。");
    });
  }
  async copyMcpToken(): Promise<void> {
    const settings = this.getMcpSettings();
    const token = this.mcpServer?.sessionToken ?? (settings.secretId ? this.app.secretStorage?.getSecret(settings.secretId) : null) ?? this.mcpSessionToken;
    if (!token) throw new Error("先にトークンを生成するかMCPを有効にしてください。");
    await navigator.clipboard.writeText(token); new Notice("MCPトークンをコピーしました");
  }
  async activateApprovalView(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_AI_APPROVAL)[0];
    if (!leaf) { leaf = this.app.workspace.getLeaf("tab"); await leaf.setViewState({ type: VIEW_TYPE_AI_APPROVAL, active: true }); }
    await this.app.workspace.revealLeaf(leaf);
  }
  undoEntry(entryId: string): Promise<void> {
    return this.operations.coordinate(async () => {
      await this.historyManager.refreshEligibility();
      if (this.historyPort.inspectUndo(entryId).state !== "available" || this.historyManager.peekUndoLabel() !== entryId) throw new Error("この履歴は現在元に戻せません。履歴と対象ファイルを確認してください。");
      const result = await this.historyManager.undo(this.app.vault);
      if (result.kind !== "success") throw new Error("保存後の変更を検出したため、元に戻せませんでした。");
      this.operationService.clearSavedProjection(); this.scheduleGhosts.clear(); this.taskCache.clear(); await this.operationService.invalidatePreviews(); await this.refreshOpenViews();
    });
  }


  // aggregate (loadDailyTodoSummaries) plus the write-side functions
  // (updateDailyTodos etc., imported directly since they're bare functions,
  // not methods). One instance, mirroring holidays/taskFiles below, so its
  // per-file mtime/size cache persists across repeated modal opens.
  readonly dailyTodos = new DailyTodoService();

  // experimental Agent Tools API

  // gated on settings.agentToolsEnabled inside the adapter.
  readonly toolAdapter = new ToolAdapter(this, () =>
    new ObsidianVaultAdapter(this.app)
  );

  holidays!: HolidayService;


  // and parses the government national holiday CSV via Obsidian's
  // requestUrl. Overridden in tests with a controllable stub.
  protected holidayFetcher: NationalHolidayFetcher =
    createRequestUrlNationalHolidayFetcher();

  /**
 *
 *
 * Loads settings from disk and merges them over DEFAULT_SETTINGS, with
 * stored data winning. loadData failures (e.g. corrupt JSON) propagate
 * and fail the whole plugin load — there is no fallback; recovery is
 * manual deletion of the plugin data file + reload.
 * Properties absent from both stored data and DEFAULT_SETTINGS would
 * remain undefined.
 */
  async loadSettings(): Promise<void> {
    const { ai, ...stored } = ((await this.loadData()) ?? {}) as Record<string, unknown>;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
    this.aiSettings = normalizeAiSettings(ai);
    const mcp = mcpSettingsSchema.safeParse({ ...DEFAULT_MCP_SETTINGS, ...this.settings.mcp });
    this.settings.mcp = mcp.success ? mcp.data : { ...DEFAULT_MCP_SETTINGS };
    this.settingsPersistence = undefined; this.settingsWriter();
    if (this.aiSettings.apiKey && this.app.secretStorage) {
      // Move a key saved in data.json into secret storage as soon as it is available.
      try { this.app.secretStorage.setSecret(AI_SECRET_ID, this.aiSettings.apiKey); }
      catch { new Notice("APIキーを秘密ストレージへ移せませんでした。"); return; }
      const { apiKey: _key, ...migrated } = this.aiSettings;
      void _key;
      try { await this.writeAiSettings(migrated); delete this.aiSettings.apiKey; }
      catch { new Notice("data.json の平文のAPIキーを削除できませんでした。"); }
    }
  }

  /**
 *
 * Persists the in-memory settings object to disk.
 */
  private writeAiSettings(ai = this.aiSettings): Promise<void> {
    const candidate = structuredClone(ai);
    // AI settings stay outside TaskWorkbenchSettings. Use its persistence path
    // with no workbench patch, and verify the separate AI payload on readback.
    const writer = new SettingsPersistence({
      settings: () => this.settings,
      coordinate: (run) => this.operations.coordinate(run),
      write: (settings) => this.saveData({ ...settings, ai: candidate }),
      read: async () => {
        const actual = await this.loadData();
        if (canonical(actual?.ai) !== canonical(candidate)) throw new Error("SETTINGS_SAVE_CONFLICT");
        return actual;
      },
    });
    return this.operations.coordinate(() => writer.persist(this.settings, [], false));
  }
  /** Applies the saved connection to the chat session; the session is only touched when something changed. */
  applyAiConnection(): void {
    const next = toConnectionConfig(this.aiSettings), current = this.chatSession.config;
    if (JSON.stringify(next) !== JSON.stringify(current)) this.chatSession.configure(next);
  }
  getAiSettings(): AiConnectionSettings { const { apiKey: _key, ...rest } = this.aiSettings; void _key; return { ...rest }; }
  async updateAiSettings(patch: Partial<Omit<AiConnectionSettings, "apiKey">>): Promise<void> {
    this.aiSettings = normalizeAiSettings({ ...this.aiSettings, ...patch });
    await this.writeAiSettings();
    this.applyAiConnection();
  }
  aiKeyStorage(): "secret" | "data" { return this.aiSettings.apiKey || !this.app.secretStorage ? "data" : "secret"; }
  private readAiApiKey(): string | null {
    const stored = this.aiSettings.apiKey ?? this.app.secretStorage?.getSecret(AI_SECRET_ID);
    return stored ? stored : null;
  }
  hasAiApiKey(): boolean { return !!this.readAiApiKey(); }
  async setAiApiKey(key: string): Promise<void> {
    const value = key.trim();
    if (!value) throw new Error("EMPTY_KEY");
    if (this.app.secretStorage) { this.app.secretStorage.setSecret(AI_SECRET_ID, value); delete this.aiSettings.apiKey; }
    else this.aiSettings = { ...this.aiSettings, apiKey: value };
    await this.writeAiSettings();
    this.applyAiConnection();
  }
  async clearAiApiKey(): Promise<void> {
    // Secret storage has no delete; an empty value is treated as not registered.
    this.app.secretStorage?.setSecret(AI_SECRET_ID, "");
    delete this.aiSettings.apiKey;
    await this.writeAiSettings();
    this.applyAiConnection();
  }
  async fetchAiModels(): Promise<ModelListResult> {
    const result = await listModels({ baseUrl: this.aiSettings.baseUrl, apiKey: this.aiSettings.useApiKey ? this.readAiApiKey() : null });
    if (result.ok) this.aiModels = result.models;
    return result;
  }
  openAiSettings(): void {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    if (!setting) { new Notice("設定画面の「Vault Gantt」を開いてください。"); return; }
    setting.open(); setting.openTabById(this.manifest.id);
  }
  async saveSettings(): Promise<void> {
    await this.settingsWriter().save();
    this.operationService.clearSavedProjection();
    await this.operationService.invalidatePreviews();
  }

  async onload(): Promise<void> {

    const startedAt = Date.now();


    this.logger = new Logger(this.app);


    // settings load failures propagate — plugin load fails
    await this.loadSettings();
    this.unloading = false;
    this.historyManager.attachVault(() => this.vaultAdapter());

    this.chatSession = new ChatSession(this.app.vault, this.operationService, new SdkChatProvider(this.operations, (id) => id === AI_SECRET_ID ? this.readAiApiKey() : null, this.operationService), (result) => this.scheduleGhosts.show(result), this.operationService);
    this.applyAiConnection();
    this.registerView(VIEW_TYPE_AI_CHAT, (leaf) => new AgentView(leaf, {
      session: this.chatSession,
      previewPorts: this.previewUiPorts("chat"),
      closeDiff: () => this.scheduleGhosts.clear(),
      openSettings: () => this.openAiSettings(),
      modelOptions: () => this.aiModels,
      selectedTask: () => {
        const file = this.app.workspace.getActiveFile();
        const folder = this.settings.taskFolder.replace(/\/+$/, "");
        return file && file.path.startsWith(folder + "/") && file.extension === "md" ? file.basename : undefined;
      },
      openGantt: () => this.navigation.activateGanttView(),
      canUndo: (result) => !!result.undoLabel && this.historyManager.peekUndoLabel() === result.undoLabel,
      undoStatus: (result) => {
        if (result.undoLabel && this.historyManager.peekUndoLabel() === result.undoLabel) return "available";
        return result.undoLabel && this.historyManager.peekRedoLabel() === result.undoLabel ? "undone" : "unavailable";
      },
      undo: (result) => this.operations.coordinate(async () => {
        if (result.undoLabel && this.historyManager.peekUndoLabel() === result.undoLabel) await this.performUndo();
        else new Notice("この変更は現在の履歴の先頭ではありません");
      }),
    }));


    this.registerView(VIEW_TYPE_AI_APPROVAL, (leaf) => new ApprovalView(leaf, { ...this.previewUiPorts("approval"), openGantt: () => this.navigation.activateGanttView() }));
    this.holidays = this.createHolidayService();

    // attempt old-structure holiday migration;
    // persist only when a migration actually happened
    if (this.holidays.migrateHolidaySettings(this.settings)) {
      await this.saveSettings();
    }



    // updateAutoPriorities failures are caught and logged; view/command/
    // ribbon registration below MUST still run. Recovery from a missing task
    // folder is simply creating the folder — no plugin reload required.
    // The controller supports forced updates internally; no force-update
    // command is exposed in the command palette.
    try {
      const ran = await this.autoPriority.updateAutoPriorities(
        this.vaultAdapter(),
        this.settings,

        this.taskCache,
        false,
        this.logger

      );
      if (ran) {
        // persist settings after the auto priority run
        await this.saveSettings();
      }
    } catch (err) {

      this.logger.error(
        "TaskWorkbenchPlugin",
        "Task Workbench: auto priority update failed during onload",
        err
      );

    }

    try { await this.configureMcp(); } catch { new Notice("MCPを起動できませんでした。ポートと設定を確認してください。"); }
    // fire-and-forget background holiday refresh.
    // The caller never awaits or catches: an unexpected rejection surfaces as
    // an unhandled rejection (console) without blocking plugin startup.
    void this.holidays.refreshNationalHolidays(false, false);

    // the Task Workbench view, constructed with a
    // host object wiring the plugin's existing services.
    this.registerView(VIEW_TYPE_TASK_WORKBENCH, (leaf) =>
      new TaskWorkbenchView(leaf, this.workbenchViewHost())
    );

    // container/header/scroll/zoom), constructed with a host object wiring the
    // plugin's task loader and settings persistence.
    this.registerView(VIEW_TYPE_TASK_GANTT, (leaf) =>
      new TaskGanttView(leaf, this.ganttViewHost())
    );

    // each embedded block is
    // rendered independently through renderEmbed on every (re-)render of the
    // note; the handler keeps no shared state between embed positions.
    this.registerMarkdownCodeBlockProcessor(
      EMBED_BLOCK,
      async (source, el) => {
        // renderEmbed failures are intentionally NOT
        // caught here — Obsidian handles code block rendering errors.
        await this.renderEmbed(source, el);
      }
    );

    if (typeof this.registerEvent === "function") {
      const clear = (file: TFile, kind: "modify" | "create" | "delete" | "rename") => { this.scheduleGhosts.clear(); void this.historyManager.refreshEligibility(); void this.operationService.handleVaultChange(file.path, kind); };
      this.registerEvent(this.app.vault.on("modify", (file) => clear(file as TFile, "modify")));
      this.registerEvent(this.app.vault.on("create", (file) => clear(file as TFile, "create")));
      this.registerEvent(this.app.vault.on("delete", (file) => clear(file as TFile, "delete")));
      this.registerEvent(this.app.vault.on("rename", (file) => clear(file as TFile, "rename")));
    }
    this.registerCommands();
    for (const [position, label] of [["tab", "タブ"], ["left", "左サイドバー"], ["right", "右サイドバー"]] as const) {
      this.addCommand({ id: "open-ai-chat-" + position, name: "AI チャットを開く（" + label + "）", callback: () => this.openAIChat(position) });
    }
    this.addCommand({ id: "open-ai-approval", name: "AIの承認一覧を開く", callback: () => { void this.activateApprovalView(); } });
    this.registerRibbonIcons();


    this.addSettingTab(new TaskWorkbenchSettingTab(this.app, this));

    // timer start failures would propagate to onload
    this.startGanttSyncTimer();

    this.logger.info("TaskWorkbenchPlugin", "plugin loaded", {
      durationMs: Date.now() - startedAt,
    });

  }

  /**
 * settings changes use the existing force=true auto-priority
 * controller path, then persist its updated last-run timestamp.
 */
  async updateAutoPriorities(): Promise<void> {

    const startedAt = Date.now();

    const ran = await this.autoPriority.updateAutoPriorities(
      this.vaultAdapter(),
      this.settings,

      this.taskCache,
      true,
      this.logger

    );
    if (ran) {
      await this.saveSettings();
    }

    this.logger.info("TaskWorkbenchPlugin", "auto priority run", {
      durationMs: Date.now() - startedAt,
      ran,
    });

  }

  async openAIChat(position: "tab" | "left" | "right" = "tab"): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_AI_CHAT)[0];
    const leaf = existing ?? (position === "left" ? this.app.workspace.getLeftLeaf(false) : position === "right" ? this.app.workspace.getRightLeaf(false) : this.app.workspace.getLeaf("tab"));
    if (!leaf) return;
    if (!existing) await leaf.setViewState({ type: VIEW_TYPE_AI_CHAT, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  onunload(): void {
    this.unloading = true;
    void this.queueMcp(async () => { await this.mcpServer?.stop(); this.mcpServer = undefined; }).catch(() => { /* Shutdown still releases the listener. */ });
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_AI_APPROVAL);
    this.chatSession?.dispose();
    this.operationService.dispose();
    this.scheduleGhosts.clear();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_AI_CHAT);
    // stop the Gantt sync timer; with a null handle
    // clearInterval is not called. Global clearInterval is used instead of
    // window.clearInterval — identical in the Obsidian renderer where
    // globalThis is window; invalid-handle errors are not caught here.
    // if Obsidian never calls onunload (crash/forced
    // reload) the timer can leak or run twice — known limitation.
    if (this.ganttSyncIntervalId) {
      clearInterval(this.ganttSyncIntervalId);
      this.ganttSyncIntervalId = null;
    }

    // removing leaves of an already closed view is a no-op
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_TASK_WORKBENCH);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_TASK_GANTT);

    // Obsidian automatically removes registered commands, ribbon icons,
    // processors, and views on unload.

  }















  startGanttSyncTimer(sendImmediately = true): void {
    if (this.ganttSyncIntervalId) {
      clearInterval(this.ganttSyncIntervalId);
      this.ganttSyncIntervalId = null;
    }

    if (!this.settings.ganttSyncEnabled || !getGanttSyncEndpoint(this.settings)) {
      return;
    }

    const intervalMs = this.settings.ganttSyncIntervalMinutes * 60 * 1000;
    this.ganttSyncIntervalId = setInterval(() => {
      void this.runAutomaticGanttSync();
    }, intervalMs);

    if (sendImmediately) void this.runAutomaticGanttSync();
  }

  /**
   * Runs the initial and periodic background sync. It uses `force=false`,
   * skips when no endpoint exists or content is unchanged, and logs failures
   * with console.warn. A failure does not stop the timer; the next tick retries.
   */
  private async runAutomaticGanttSync(): Promise<void> {

    const startedAt = Date.now();

    try {

      const tasks = await loadTasks(this.vaultAdapter(), this.settings, this.taskCache, this.logger);

      const synced = await syncReadonlyGanttSnapshot(
        tasks,
        this.settings,
        this.manifest.version,
        this,

        false,
        this.logger

      );

      if (synced) {
        this.logger.debug("TaskWorkbenchPlugin", "automatic sync completed", {
          durationMs: Date.now() - startedAt,
        });
      }

    } catch (err) {

      this.logger.warn(
        "TaskWorkbenchPlugin",
        "[TaskWorkbench] gantt automatic sync failed",
        err
      );

    }
  }















  async syncReadonlyGanttNow(): Promise<void> {

    const startedAt = Date.now();

    try {

      const tasks = await loadTasks(this.vaultAdapter(), this.settings, this.taskCache, this.logger);

      const synced = await syncReadonlyGanttSnapshot(
        tasks,
        this.settings,
        this.manifest.version,
        this,

        true,
        this.logger

      );
      if (synced) {
        new Notice("Ganttをサーバーへ同期しました。");
      } else {
        new Notice("Gantt同期URLが設定されていません。");
      }

      this.logger.info("TaskWorkbenchPlugin", "manual sync completed", {
        durationMs: Date.now() - startedAt,
      });

    } catch (err) {
      new Notice(
        "Gantt同期に失敗しました。URLとサーバー状態を確認してください。"
      );

      this.logger.error(
        "TaskWorkbenchPlugin",
        "[TaskWorkbench] gantt manual sync failed",
        err
      );

    }
  }

  undoLastAction(): Promise<void> {
    return this.operations.coordinate(() => this.performUndo());
  }

  private async performUndo(): Promise<void> {
    this.operationService.clearSavedProjection();
    this.scheduleGhosts.clear();
    const result = await this.historyManager.undo(this.app.vault);
    switch (result.kind) {
      case "empty":
        new Notice("元に戻せる操作がありません");
        return;
      case "success":
        new Notice(`元に戻しました: ${result.label}`);
        await this.refreshOpenViews();
        return;
      case "conflict":
        new Notice(
          `元に戻せませんでした（外部で変更されています）: ${result.conflictingPaths.join(", ")}`
        );
        return;
      case "invalidated":
        new Notice(`元に戻す履歴を破棄しました: ${result.reason}`);
        return;
    }
  }

  redoLastAction(): Promise<void> {
    return this.operations.coordinate(() => this.performRedo());
  }

  private async performRedo(): Promise<void> {
    this.operationService.clearSavedProjection();
    this.scheduleGhosts.clear();
    const result = await this.historyManager.redo(this.app.vault);
    switch (result.kind) {
      case "empty":
        new Notice("やり直せる操作がありません");
        return;
      case "success":
        new Notice(`やり直しました: ${result.label}`);
        await this.refreshOpenViews();
        return;
      case "conflict":
        new Notice(
          `やり直せませんでした（外部で変更されています）: ${result.conflictingPaths.join(", ")}`
        );
        return;
      case "invalidated":
        new Notice(`やり直し履歴を破棄しました: ${result.reason}`);
        return;
    }
  }

  private async refreshOpenViews(): Promise<void> {
    const renders: Promise<void>[] = [];
    for (const viewType of [VIEW_TYPE_TASK_WORKBENCH, VIEW_TYPE_TASK_GANTT]) {
      for (const leaf of this.app.workspace.getLeavesOfType(viewType)) {
        const view = leaf.view as unknown as
          | { render?: () => Promise<void> }
          | null
          | undefined;
        if (typeof view?.render === "function") {
          renders.push(view.render());
        }
      }
    }
    await Promise.all(renders);
    // Read-only result badges follow the existing history refresh, too.
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_AI_CHAT)) {
      (leaf.view as AgentView | undefined)?.render?.();
    }
  }


















  async renderEmbed(source: string, el: HTMLElement): Promise<void> {
    el.setAttribute("data-embed-block", EMBED_BLOCK);
    el.setAttribute("data-embed-source", source);
    el.empty();

    const cfg: EmbedConfig = parseEmbedConfig(source);

    // intentionally uncaught — see docblock above.
    const tasks = await loadTasks(
      this.vaultAdapter(),
      this.settings,

      this.taskCache,
      this.logger

    );

    // filterText has no config key and is used only as placeholder text.
    // Every other control is initialized from the parsed EmbedConfig.
    const state: EmbedTableState = {
      filterText: "",
      statusFilter: cfg.status,
      sortKey: cfg.sort,
      sortDir: cfg.dir,
      flatDueSort: cfg.flatDueSort,
      showCompleted: cfg.showCompleted,
    };

    const wrap = document.createElement("div");
    wrap.classList.add("task-workbench-embed");

    const tableWrap = document.createElement("div");

    // every control mutates `state` and re-derives/re-
    // renders the table only — no loadTasks re-fetch (the `tasks` array
    // captured above stays fixed for this embed instance's lifetime).
    const rerenderTable = (): void => {
      this.renderEmbedTable(tableWrap, tasks, state, cfg.maxRows);
    };

    wrap.appendChild(this.buildEmbedTitleBar(state, rerenderTable));
    wrap.appendChild(tableWrap);
    el.appendChild(wrap);

    rerenderTable();
  }

  /**
 *
 * Titlebar: fixed title, filter input, status/sort/direction dropdowns,
 * flatDueSort/showCompleted checkboxes, "ビューを開く" button. Every
 * control's onChange mutates the shared `state` object in place and calls
 * `rerenderTable` — the pipeline never re-fetches tasks.
 */
  private buildEmbedTitleBar(
    state: EmbedTableState,
    rerenderTable: () => void
  ): HTMLElement {
    const bar = document.createElement("div");
    bar.classList.add("task-workbench-embed-titlebar");

    // fixed title text.
    const title = document.createElement("span");
    title.classList.add("task-workbench-embed-title");
    title.textContent = "Task Workbench 埋め込みビュー";
    bar.appendChild(title);

    // filter text input, re-renders on every keystroke.
    const filterInput = document.createElement("input");
    filterInput.type = "text";
    filterInput.placeholder = "フィルター...";
    filterInput.classList.add("task-workbench-search");
    filterInput.value = state.filterText;
    filterInput.addEventListener("input", () => {
      state.filterText = filterInput.value;
      rerenderTable();
    });
    bar.appendChild(filterInput);

    // すべてのステータス + each DEFAULT_STATUSES entry.
    bar.appendChild(
      this.buildEmbedSelect(
        [["all", "すべてのステータス"], ...Object.entries(DEFAULT_STATUSES)],
        state.statusFilter,
        (value) => {
          state.statusFilter = value;
          rerenderTable();
        }
      )
    );

    // sort key dropdown, mirrors EmbedConfig.sort's allowed
    // values (dueDate/updatedAt/createdAt/title/statusLabel).
    bar.appendChild(
      this.buildEmbedSelect(
        [
          ["dueDate", "期限順"],
          ["updatedAt", "更新日順"],
          ["createdAt", "作成日順"],
          ["title", "タスク名順"],
          ["statusLabel", "ステータス順"],
        ],
        state.sortKey,
        (value) => {
          state.sortKey = value;
          rerenderTable();
        }
      )
    );

    // sort direction dropdown.
    bar.appendChild(
      this.buildEmbedSelect(
        [
          ["asc", "昇順"],
          ["desc", "降順"],
        ],
        state.sortDir,
        (value) => {
          state.sortDir = value === "asc" ? "asc" : "desc";
          rerenderTable();
        }
      )
    );

    // 「サブタスク含めた期限順」checkbox — EmbedConfig.flatDueSort.
    bar.appendChild(
      this.buildEmbedCheckbox(
        "サブタスク含めた期限順",
        state.flatDueSort,
        (checked) => {
          state.flatDueSort = checked;
          rerenderTable();
        }
      )
    );

    // 「完了も表示」checkbox — EmbedConfig.showCompleted.
    bar.appendChild(
      this.buildEmbedCheckbox("完了も表示", state.showCompleted, (checked) => {
        state.showCompleted = checked;
        rerenderTable();
      })
    );

    // opens the plugin's MAIN view via the existing
    // NavigationService — the embed's own fixed title is
    // "Task Workbench 埋め込みビュー" and its columns (priority
    // stars, current status, tags) mirror the Workbench table, not a Gantt

    // Workbench view (activateView), not the Gantt view.
    const openViewButton = document.createElement("button");
    openViewButton.textContent = "ビューを開く";
    openViewButton.addEventListener("click", () => {
      void this.navigation.activateView();
    });
    bar.appendChild(openViewButton);

    return bar;
  }

  /** Small <select> builder shared by the titlebar's three dropdowns. */
  private buildEmbedSelect(
    options: ReadonlyArray<readonly [string, string]>,
    currentValue: string,
    onChange: (value: string) => void
  ): HTMLSelectElement {
    const select = document.createElement("select");
    for (const [value, label] of options) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    }
    select.value = currentValue;
    select.addEventListener("change", () => {
      onChange(select.value);
    });
    return select;
  }

  /** Small labeled-checkbox builder shared by the titlebar's two toggles. */
  private buildEmbedCheckbox(
    labelText: string,
    checked: boolean,
    onChange: (checked: boolean) => void
  ): HTMLLabelElement {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = checked;
    checkbox.addEventListener("change", () => {
      onChange(checkbox.checked);
    });
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(labelText));
    return label;
  }
















  private renderEmbedTable(
    container: HTMLElement,
    tasks: TaskRow[],
    state: EmbedTableState,
    maxRows: number
  ): void {
    container.empty();

    const today = moment().startOf("day");
    const displayOptions: DisplayRowsOptions = {
      filterText: state.filterText,
      statusFilter: state.statusFilter,
      showCompleted: state.showCompleted,
      sortKey: state.sortKey,
      sortDir: state.sortDir,
      flatDueSort: state.flatDueSort,
      today,
    };

    const displayRows = getDisplayRows(tasks, displayOptions);
    // flatDueSort=false groups parents/children with the same

    const rows: TaskRow[] = state.flatDueSort
      ? displayRows
      : getCollapsedWorkbenchRows(displayRows, false, new Set());

    // Apply a count-based limit explicitly: Array.slice handles negative
    // indices differently. A non-positive maxRows produces no rows.

    const sliced: TaskRow[] = [];
    for (const row of rows) {
      if (sliced.length >= maxRows) {
        break;
      }
      sliced.push(row);
    }

    // empty state (no tasks at all, or everything filtered out).
    if (sliced.length === 0) {
      const empty = document.createElement("div");
      empty.classList.add("task-workbench-embed-empty");
      empty.textContent = "表示対象のタスクがありません";
      container.appendChild(empty);
      return;
    }

    // flat-mode "親タスク / 子タスク" prefix needs each
    // subtask's owning parent's display name. getDisplayRows computes this
    // internally but doesn't expose it, so it's rebuilt here from the same
    // source data (mirrors that function's own ownerLabel logic).
    const parentDisplayNameByChildId = new Map<string, string>();
    if (state.flatDueSort) {
      for (const task of tasks) {
        if (!task.subtasks) {
          continue;
        }
        const ownerLabel = task.displayName || task.title;
        for (const subtask of task.subtasks.values()) {
          parentDisplayNameByChildId.set(subtask.id, ownerLabel);
        }
      }
    }

    const table = document.createElement("table");
    table.classList.add("task-workbench-embed-table");

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const text of [
      "タスク",
      "優先度",
      "状態",
      "現在のステータス",
      "期限",
      "タグ",
      "開く",
    ]) {
      const th = document.createElement("th");
      th.textContent = text;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const row of sliced) {
      tbody.appendChild(
        this.buildEmbedRow(
          row,
          state.flatDueSort,
          parentDisplayNameByChildId,
          today
        )
      );
    }
    table.appendChild(tbody);

    container.appendChild(table);
  }







  private buildEmbedRow(
    row: TaskRow,
    flatDueSort: boolean,
    parentDisplayNameByChildId: Map<string, string>,
    today: moment.Moment
  ): HTMLTableRowElement {
    const tr = document.createElement("tr");

    const days = dueDaysFromToday(row.dueDate, today);
    if (days !== null && days < 0) {
      tr.classList.add("twb-overdue-row");
    } else if (days !== null && days <= 3) {
      tr.classList.add("twb-due-soon-row");
    }

    tr.appendChild(
      this.buildEmbedNameCell(row, flatDueSort, parentDisplayNameByChildId)
    );
    tr.appendChild(this.buildEmbedPriorityCell(row, today));
    tr.appendChild(this.buildEmbedPlainCell(getStatusLabel(row.statusLabel)));
    tr.appendChild(this.buildEmbedPlainCell(row.currentStatus ?? ""));
    tr.appendChild(this.buildEmbedPlainCell(row.dueDate ?? ""));
    // (row.tags || []) guards null/undefined defensively.
    tr.appendChild(this.buildEmbedPlainCell((row.tags || []).join(",")));
    tr.appendChild(this.buildEmbedOpenCell(row));
    return tr;
  }

  /**
 * タスク名 column. Parent rows are bold
 * (.strong-parent); flatDueSort subtasks show "親タスク / 子タスク" —
 * unless the resolved parent name is empty, in which case that branch is
 * skipped entirely and only the child's own name is shown.
 */
  private buildEmbedNameCell(
    row: TaskRow,
    flatDueSort: boolean,
    parentDisplayNameByChildId: Map<string, string>
  ): HTMLTableCellElement {
    const td = document.createElement("td");
    // displayName/title both empty → empty string.
    const name = row.displayName || row.title || "";

    if (flatDueSort && row.kind === "subtask") {
      const parentName = parentDisplayNameByChildId.get(row.id) || "";
      td.textContent = parentName !== "" ? `${parentName} / ${name}` : name;
      return td;
    }

    if (row.kind === "parent") {
      const strong = document.createElement("span");
      strong.classList.add("strong-parent");
      strong.textContent = name;
      td.appendChild(strong);
      return td;
    }

    td.textContent = name;
    return td;
  }







  private buildEmbedPriorityCell(
    row: TaskRow,
    today: moment.Moment
  ): HTMLTableCellElement {
    const td = document.createElement("td");
    const mode = normalizePriorityMode(row.priorityMode);
    const autoPriorityEnabled = this.settings.autoPriorityEnabled !== false;
    const isAuto = autoPriorityEnabled && mode !== "manual";
    const effective = getEffectivePriority(row, autoPriorityEnabled, today);
    const span = document.createElement("span");
    span.classList.add(
      "task-workbench-priority-readonly",
      isAuto ? "priority-auto" : "priority-manual"
    );
    let stars = "";
    for (let position = 1; position <= 5; position += 1) {
      stars += position <= effective ? "★" : "☆";
    }
    span.textContent = stars;
    td.appendChild(span);
    return td;
  }

  private buildEmbedPlainCell(text: string): HTMLTableCellElement {
    const td = document.createElement("td");
    td.textContent = text;
    return td;
  }

  /**
 * reuses NavigationService.openTaskItem(item) as-is (same
 * link-jump/fallback behavior workbenchViewHost's openTaskItem wraps).
 */
  private buildEmbedOpenCell(row: TaskRow): HTMLTableCellElement {
    const td = document.createElement("td");
    const button = document.createElement("button");
    button.textContent = "開く";
    button.addEventListener("click", (evt) => {
      evt.stopPropagation();
      void this.navigation.openTaskItem?.(row);
    });
    td.appendChild(button);
    return td;
  }

  /**
 * The existing commands retain their registration order. The daily ToDo
 * command and undo/redo commands are appended so their callbacks do not
 * disturb the established order.
 *
 *
 *
 *
 * file operation errors from the async runners propagate
 * uncaptured (the callbacks fire them with `void`).
 * error handling is intentionally non-uniform across the
 * plugin (some paths propagate, others stay silent) — documented gap.
 */
  private registerCommands(): void {
    this.addCommand({
      id: "open-task-workbench",
      name: "Open task workbench",
      callback: () => {
        void this.navigation.activateView();
      },
    });

    this.addCommand({
      id: "open-task-gantt",
      name: "Open task gantt",
      callback: () => {
        void this.navigation.activateGanttView();
      },
    });

    this.addCommand({
      id: "open-task-finder",
      name: "Open task finder",
      callback: () => {
        void this.navigation.openTaskFinder();
      },
    });

    this.addCommand({
      id: "create-new-task-note",
      name: "Create new managed task note",
      callback: () => {
        void this.runCreateTaskCommand();
      },
    });

    this.addCommand({
      id: "add-subtask-to-current-note",
      name: "Add subtask to current managed task note",
      callback: () => {
        void this.runAddSubtaskCommand();
      },
    });



    // same command-only way "open-task-finder" above opens TaskFinderModal
    // (no ribbon icon; registerRibbonIcons below stays at its existing 2).
    this.addCommand({
      id: "open-daily-todo",
      name: "Open daily ToDo",
      callback: () => {
        void this.runOpenDailyTodoCommand();
      },
    });


    this.addCommand({
      id: "start-log-recording",
      name: "Start log recording",
      callback: () => {
        this.logger.startRecording();
      },
    });

    this.addCommand({
      id: "stop-log-recording",
      name: "Stop log recording",
      callback: async () => {
        await this.logger.stopRecording();
      },
    });


    this.addCommand({
      id: "undo-last-action",
      name: "元に戻す",
      callback: () => {
        void this.undoLastAction();
      },
    });

    this.addCommand({
      id: "redo-last-action",
      name: "やり直す",
      callback: () => {
        void this.redoLastAction();
      },
    });
  }

  /**
 *
 * Two ribbon buttons, clickable as soon as onload finishes. Clicks are not
 * debounced: repeated clicks run activateView/activateGanttView multiple
 * times and may create several leaves (which one ends up visible depends on
 * Obsidian — usually the last created). Clicks racing plugin startup can
 * hit Obsidian errors because the views may not be registered yet.
 */
  private registerRibbonIcons(): void {
    this.addRibbonIcon("list-todo", "Task Workbench を開く", () => {
      void this.navigation.activateView();
    });
    this.addRibbonIcon("bar-chart-3", "Task Gantt を開く", () => {
      void this.navigation.activateGanttView();
    });
  }

  /**
 * delegates to the interactive wizard.
 */
  private async createViaRegistry(name: string, parent?: TaskRow): Promise<TaskRow> {
    const plan = await this.operations.plan("create", { name, parentTaskId: parent?.id });
    const result = await this.operations.commit(plan.previewId);
    if (!result.created) throw new Error(result.message);
    return result.created;
  }

  private async runCreateTaskCommand(): Promise<void> {
    await this.taskFiles.createTaskInteractively(
      this.app,
      this.vaultAdapter(),
      this.settings,
      this.promptInput.bind(this),
      undefined,
      (name) => this.createViaRegistry(name)
    );
  }

  /**
   * Runs the subtask wizard for the active file, or shows a notice if no file
   * is open.
   */
  private async runAddSubtaskCommand(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice("現在開いているファイルがありません");
      return;
    }
    await this.taskFiles.addSubtaskToCurrentFileInteractively(
      this.app,
      this.vaultAdapter(),
      this.settings,
      activeFile.path,
      this.promptInput.bind(this),
      (name, parent) => this.createViaRegistry(name, parent)
    );
  }











  private async runOpenDailyTodoCommand(): Promise<void> {
    await this.openOrCreateDailyTodoForDate(todayStr());
  }

  /**
 * `onSaved` fires only once the modal's onSubmit has actually persisted
 * (i.e. the user clicked Save, not just opened/cancelled the modal) — the
 * returned Promise itself resolves as soon as the modal is OPEN (Modal.open
 * is synchronous/fire-and-forget; onSubmit fires later, whenever the user
 * acts). A caller that needs to react to the save completing (e.g. the
 * Gantt view re-rendering to pick up the new counts) must use `onSaved`,
 * not await this method's own return.
 */
  private async openOrCreateDailyTodoForDate(
    dateStr: string,
    onSaved?: () => void
  ): Promise<void> {

    const summaries = await this.dailyTodos.loadDailyTodoSummaries(

      this.app.vault,
      this.settings,
      this.logger

    );

    const summary = summaries.find((s) => s.date === dateStr) ?? null;

    new DailyTodoModal(
      this.app,
      `デイリーToDo（${dateStr}）`,
      summary,
      (items: DailyTodoItem[]) => {
        void this.saveDailyTodoItems(summary, dateStr, items).then(() =>
          onSaved?.()
        );
      }
    ).open();
  }

  /**
 * Persists the DailyTodoModal's edited rows. When `summary` is null because
 * today had no prior ToDo items, it creates an empty-items summary so
 * updateDailyTodos still has a `date` for inserting new rows.
 */
  private async saveDailyTodoItems(
    summary: DailyTodoSummary | null,
    dateStr: string,
    items: DailyTodoItem[]
  ): Promise<void> {
    const effectiveSummary: DailyTodoSummary = summary ?? {
      date: dateStr,
      items: [],
      completedCount: 0,
      totalCount: 0,
    };

    await updateDailyTodos(
      effectiveSummary,
      items,
      this.app,
      this.settings,
      this.historyManager
    );

  }

  /**
 * Production single-line prompt (modal based). Overridden in tests.
 */
  protected promptInput(defaultValue?: string): Promise<string | null> {
    return modalPrompt(this.app)(defaultValue);
  }

  /**
 * Holiday service factory. Overridden in tests to inject stubs.
 */
  protected createHolidayService(): HolidayService {

    return new HolidayService(
      {
        logger: this.logger,
        settings: this.settings,
        saveSettings: () => this.saveSettings(),
      },
      this.holidayFetcher
    );

  }

  private vaultAdapter(): VaultAdapter {
    return new ObsidianVaultAdapter(this.app);
  }

  /**
 * host object for TaskWorkbenchView.
 * Every member is a mechanical one-line wrapper around existing plugin
 * pieces (task-operations, NavigationService, TaskFileService) — no new
 * plugin-level business logic. The `settings` reference captured here
 * stays live because the settings tab mutates the object in place. Its
 * controls write directly to `settings` and save immediately without a
 * draft/apply step.
 *
 * The Workbench's 「+」 button uses TaskFileService.addSubtaskInteractively
 * with an explicit parent row. The command-palette flow instead uses
 * addSubtaskToCurrentFileInteractively, which resolves the parent from the
 * currently open file.
 */
  private workbenchViewHost(): TaskWorkbenchViewHost {
    return {
      ...this.previewUiPorts("workbench"),

      logger: this.logger,

      settings: this.settings,
      loadTasks: (): Promise<TaskRow[]> =>

        loadTasks(this.vaultAdapter(), this.settings, this.taskCache, this.logger),

      getDisplayRows: (tasks: TaskRow[], opts: DisplayRowsOptions) =>
        getDisplayRows(tasks, opts),
      updateTaskItem: (row: TaskRow, patch: TaskPatch) =>
        this.operations.updateFromUI([{ row, patch }]).then((results) => results[0]),
      openTaskItem: async (row: TaskRow): Promise<void> => {
        await this.navigation.openTaskItem?.(row);
      },
      createTaskInteractively: async (onCreated: () => void) => {

        // "create-new-task-note" command (runCreateTaskCommand), with the
        // view's redraw passed as the onCreated callback.
        await this.taskFiles.createTaskInteractively(
          this.app,
          this.vaultAdapter(),
          this.settings,
          this.promptInput.bind(this),
          onCreated,
          (name) => this.createViaRegistry(name)
        );
      },
      activateGanttView: async (): Promise<void> => {
        await this.navigation.activateGanttView();
      },
      undoLastAction: (): Promise<void> => this.undoLastAction(),
      redoLastAction: (): Promise<void> => this.redoLastAction(),
      // wraps TaskFileService.addSubtaskInteractively,
      // which takes the explicit parent row the 「+」 button has, unlike
      // addSubtaskToCurrentFileInteractively's "current file" lookup.
      addSubtaskInteractively: async (
        row: TaskRow,
        onCreated: () => void
      ): Promise<void> => {
        await this.taskFiles.addSubtaskInteractively(
          this.app,
          this.vaultAdapter(),
          this.settings,
          row,
          this.promptInput.bind(this),
          onCreated,
          (name, parent) => this.createViaRegistry(name, parent)
        );
      },
    };
  }







  private ganttViewHost(): TaskGanttViewHost {
    return {
      ...this.previewUiPorts("gantt"),
      ghosts: this.scheduleGhosts,

      logger: this.logger,

      settings: this.settings,
      loadTasks: (): Promise<TaskRow[]> =>

        loadTasks(this.vaultAdapter(), this.settings, this.taskCache, this.logger),


      loadDailyTodoSummaries: (): Promise<DailyTodoSummary[]> =>

        this.dailyTodos.loadDailyTodoSummaries(
          this.app.vault,
          this.settings,
          this.logger
        ),


      openOrCreateDailyTodoForDate: (
        dateStr: string,
        onSaved?: () => void
      ): Promise<void> => this.openOrCreateDailyTodoForDate(dateStr, onSaved),
      saveSettings: (): Promise<void> => this.saveSettings(),
      // single drag/edit save, same path as the Workbench's
      // own updateTaskItem wrapper above.
      updateTaskItem: (row: TaskRow, patch: TaskPatch) =>
        this.operations.updateFromUI([{ row, patch }]).then((results) => results[0]),
      // the popover's 「ノートを開く」 — identical
      // one-line wrapper to workbenchViewHost's openTaskItem above.
      openTaskItem: async (row: TaskRow): Promise<void> => {
        await this.navigation.openTaskItem?.(row);
      },
      // Bulk-Move's single batch save.
      updateTaskItemsBatch: (commands: TaskUpdateCommand[]) =>
        this.operations.updateFromUI(commands),
      // workload-actual shift warning.
      confirmWorkloadShift: (message: string): Promise<boolean> =>
        confirmDragWorkloadShift(this.app, message),
      // MarkerModal
      // add/edit — needs a real App instance, same reason confirmWorkloadShift
      // wraps its own modal here instead of the view constructing it directly.
      openMarkerModal: (
        modalTitle: string,
        initialTitle: string,
        initialDate: string
      ): Promise<{ title: string; date: string } | null> =>
        openMarkerModal(this.app, modalTitle, initialTitle, initialDate),
      // the bar menu's 「Current Statusを
      // 編集」 dialog — TextInputModal used exactly as designed (callback on
      // confirm, silent no-op on cancel), needs a real App instance for the
      // same reason openMarkerModal/confirmWorkloadShift above do.
      openTextPrompt: (
        title: string,
        label: string,
        initialValue: string,
        onSubmit: (value: string) => void
      ): void => {
        new TextInputModal(this.app, title, label, initialValue, onSubmit).open();
      },
      // 「タスクとして削除」— wraps task-operations'
      // deleteSubtaskTaskItem the same one-line way updateTaskItem above
      // wraps its own task-operations function.
      deleteSubtaskTaskItem: (row: TaskRow): Promise<void> =>
        deleteSubtaskTaskItem(
          this.vaultAdapter(),
          this.settings,
          row,
          this.historyManager
        ),
      // the empty-cell menu's 「新規サブタスクを [date]
      // に作成」 — wraps task-operations.addSubtaskWithPlan the same
      // one-line way deleteSubtaskTaskItem above wraps its own function.
      addSubtaskWithPlan: (
        parentRow: TaskRow,
        name: string,
        dateStr: string
      ): Promise<TaskRow> =>
        addSubtaskWithPlan(
          this.vaultAdapter(),
          this.settings,
          parentRow,
          name,
          dateStr,
          this.historyManager
        ),
      // Task creation initializes ganttEnabled to false and ganttOrder to
      // Date.now(), so assign the Gantt values after creation. The new order
      // follows visible Gantt parents, or starts at 1000 when none exist.
      createGanttParentInteractively: async (): Promise<void> => {
        const tasks = await loadTasks(
          this.vaultAdapter(),
          this.settings,

          this.taskCache,
          this.logger

        );
        const parents = getGanttParentRows(tasks);
        const orders = parents.map((p) =>
          typeof p.ganttOrder === "number" && isFinite(p.ganttOrder)
            ? p.ganttOrder
            : 999999 // Fallback for a missing or non-finite order.
        );
        const nextOrder =
          orders.length > 0 ? Math.max(...orders) + 1000 : 1000;

        const created = await this.taskFiles.createTaskInteractively(
          this.app,
          this.vaultAdapter(),
          this.settings,
          this.promptInput.bind(this),
          undefined,
          (name) => this.createViaRegistry(name)
        );
        if (!created) {
          return; // user cancelled the wizard
        }
        await this.operations.updateFromUI([{
          row: created,
          patch: { ganttEnabled: true, ganttOrder: nextOrder },
        }]);
      },
      // Open the existing-parent picker through the plugin's real App
      // instance, just like the text prompt and marker modal above.
      openGanttParentPicker: (
        items: TaskRow[],
        onChoose: (item: TaskRow) => void | Promise<void>
      ): void => {
        new GanttParentPickerModal(this.app, items, onChoose).open();
      },
      // the parent context menu's 「サブタスクを追加」
      // — identical wiring to workbenchViewHost's own addSubtaskInteractively
      // above (same TaskFileService method, same explicit-parent-row call
      // shape).
      addSubtaskInteractively: async (
        row: TaskRow,
        onCreated: () => void
      ): Promise<void> => {
        await this.taskFiles.addSubtaskInteractively(
          this.app,
          this.vaultAdapter(),
          this.settings,
          row,
          this.promptInput.bind(this),
          onCreated,
          (name, parent) => this.createViaRegistry(name, parent)
        );
      },
      // the toolbar's 「Workbench」 button — identical
      // one-line NavigationService wrap to workbenchViewHost's own
      // activateGanttView above, just in the opposite direction.
      activateView: async (): Promise<void> => {
        await this.navigation.activateView();
      },
      // The toolbar's 「同期」 button calls this plugin's manual sync method.
      syncReadonlyGanttNow: (): Promise<void> => this.syncReadonlyGanttNow(),
      undoLastAction: (): Promise<void> => this.undoLastAction(),
      redoLastAction: (): Promise<void> => this.redoLastAction(),
      // Supply the toolbar's version-info span. releaseNotes is an optional
      // custom manifest.json field, so read it defensively.
      manifest: {
        version: this.manifest.version,
        releaseNotes: (this.manifest as { releaseNotes?: string })
          .releaseNotes,
        description: this.manifest.description,
      },
    };
  }
}
