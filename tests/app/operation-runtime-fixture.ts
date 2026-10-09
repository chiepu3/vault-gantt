import { vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/core/constants";
import type { TaskRow } from "../../src/core/types";
import { buildFullNote } from "../../src/core/note-format";
import { OperationRegistry } from "../../src/app/operation-registry";
import { OperationService, type OperationServiceHost } from "../../src/app/operation-service";
import { HistoryManager } from "../../src/app/history-manager";
import { FakeVault } from "./fake-vault";
import { PARENT_ID, CHILD_ID } from "../contracts/fixtures";
import { Logger } from "../../src/core/logger";
import { todayStr } from "../../src/core/utils";
export async function runtimeFixture(overrides: Partial<OperationServiceHost> = {}) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.taskFolder = "tasks";
  settings.ganttEvents = [{ key: "event-1", title: "イベント", date: "2026-10-13", workloadPlan: { "2026-10-13": 2 }, workloadActual: { "2026-10-13": 1 } }];
  settings.weeklyWorkSchedules = [{ key: "weekly-1", title: "定例", dayOfWeek: 2, minutesPerWeek: 60 }];
  settings.ganttTags = [{ key: "tag-1", name: "リリース", color: "#4488cc", order: 1000 }];
  settings.dailyTodoSources = [{ key: "main", label: "日次", format: "[daily/]YYYY-MM-DD", creatableFromGantt: true }];
  const vault = new FakeVault(), historyManager = new HistoryManager();
  const base = { title: "リリース", displayName: "リリース", statusLabel: "active" as const, completed: false, createdAt: todayStr(), updatedAt: todayStr(), priority: 0, priorityMode: "auto" as const, currentStatus: "", notes: "", tags: ["リリース"], ganttEnabled: true };
  const child: TaskRow = { ...base, kind: "subtask", id: CHILD_ID, key: "review", file: { path: PARENT_ID, parentPath: PARENT_ID, heading: "レビュー" } as TaskRow["file"], title: "レビュー", displayName: "レビュー", ganttEnabled: false, plannedStartDate: "2026-10-13", plannedEndDate: "2026-10-15", workloadPlan: { "2026-10-13": 2 }, workloadActual: { "2026-10-13": 1 }, ganttMarkers: [{ key: "review-point", title: "確認", date: "2026-10-13", tags: [] }] };
  const parent: TaskRow = { ...base, kind: "parent", id: PARENT_ID, file: { path: PARENT_ID } as TaskRow["file"], ganttOrder: 1000, subtasks: new Map([["review", child]]) };
  await vault.create(PARENT_ID, buildFullNote(parent, parent.subtasks)); vault.resetCounters();
  Object.assign(vault, { process: async (file: { path: string }, transform: (content: string) => string) => {
    const next = transform(await vault.read(file)); await vault.modify(file, next); return next;
  } });
  const invalidate = vi.fn(), persistSettings = vi.fn(async (_candidate: unknown) => undefined);
  const registry = new OperationRegistry({ settings, historyManager, invalidate }, () => vault);
  const logger = new Logger({} as ConstructorParameters<typeof Logger>[0]);
  const sendExternal = vi.fn(async () => undefined), restartSync = vi.fn();
  const host: OperationServiceHost = { settings, historyManager, coordinator: registry, invalidate, persistSettings, logger, sendExternal, restartSync,
    integration: { pluginVersion: "test", fetchNationalHolidays: async () => ["2026-10-13"], detectDailyNoteSettings: () => ({ folder: "daily", format: "YYYY-MM-DD" }) } };
  Object.defineProperties(host, Object.getOwnPropertyDescriptors(overrides));
  const service = new OperationService(host, () => vault, "test-vault");
  const context = { ...service.legacyContext(), principalId: "human-test", origin: { kind: "chat" as const, conversationId: "conversation-1" } };
  return { settings, vault, historyManager, registry, service, context, parent, child, persistSettings, invalidate, logger, sendExternal, restartSync };
}
