import { stringifyYaml } from "obsidian";
import { generateTaskId } from "../core/ids";
import { isLegacyFrontmatter, readLegacyParent, type LegacyParent } from "../core/legacy-v1";
import { newNoteBody, newNoteFrontmatter } from "../core/note-v2";
import type { TaskRow, TaskWorkbenchSettings } from "../core/types";
import { isUnderRoot, readNote, taskRoot } from "./note-store";
import { collectTaskIds, getAvailableSubtaskPath, newNoteText, type VaultAdapter, type VaultFile } from "./task-operations";

/** Conversion of v1 notes (subtasks inside the parent) to v2 notes (one note per task). */
export const BACKUP_FOLDER = ".vault-gantt-backup";

export interface PlanItem {
  /** The v1 parent note (it is rewritten in place). */
  path: string;
  title: string;
  /** Subtask notes that will be created. */
  subtasks: { title: string; path: string }[];
  warnings: string[];
}

export interface MigrationPlan {
  backupRoot: string;
  items: PlanItem[];
  /** v1 notes that cannot be converted (they stay as they are). */
  skipped: { path: string; reason: string }[];
}

export interface MigrationReport {
  backupRoot: string;
  converted: { path: string; parentId: string; subtaskIds: string[] }[];
  /** Notes that were rolled back (or not touched) and why. */
  failed: { path: string; reason: string }[];
  warnings: string[];
}

export interface MigrationDeps {
  /** Saves the two settings the conversion changes. */
  persist(candidate: TaskWorkbenchSettings, keys: ("subtaskOrder" | "ganttParentOrder")[]): Promise<void>;
  now?: () => Date;
  onProgress?: (done: number, total: number, path: string) => void;
}

const pad = (n: number): string => String(n).padStart(2, "0");
export function backupStamp(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** v1 parent notes under the task folder (by metadataCache frontmatter). */
export async function findLegacyNotes(vault: VaultAdapter, settings: Pick<TaskWorkbenchSettings, "taskFolder">): Promise<VaultFile[]> {
  const root = taskRoot(settings);
  const files = vault.getFiles().filter((file) => isUnderRoot(file.path, root));
  const unindexed = files.filter((file) => vault.getFrontmatter(file) === undefined);
  if (unindexed.length) await vault.whenIndexed(unindexed);
  return files.filter((file) => isLegacyFrontmatter(vault.getFrontmatter(file)));
}

/** What the conversion would create and change. Nothing is written. */
export async function planMigration(vault: VaultAdapter, settings: TaskWorkbenchSettings, now: Date = new Date()): Promise<MigrationPlan> {
  const plan: MigrationPlan = { backupRoot: `${BACKUP_FOLDER}/${backupStamp(now)}`, items: [], skipped: [] };
  const reserved = new Set<string>();
  for (const file of await findLegacyNotes(vault, settings)) {
    let legacy: LegacyParent | null;
    try { legacy = readLegacyParent(file.path, await vault.read(file), settings); }
    catch (error) { plan.skipped.push({ path: file.path, reason: error instanceof Error ? error.message : String(error) }); continue; }
    if (!legacy) { plan.skipped.push({ path: file.path, reason: "タスクのノートとして読み取れません" }); continue; }
    const subtasks = [...legacy.row.subtasks?.values() ?? []].map((sub) => {
      const path = getAvailableSubtaskPath(vault, file.path, sub.displayName || sub.title, reserved);
      reserved.add(path);
      return { title: sub.displayName || sub.title, path };
    });
    plan.items.push({ path: file.path, title: legacy.row.displayName, subtasks, warnings: legacy.warnings });
  }
  return plan;
}

interface Prepared {
  parent: TaskRow;
  subs: TaskRow[];
  parentText: string;
  subTexts: string[];
  original: string;
  legacy: LegacyParent;
}

/** Builds the v2 rows and note texts for one v1 parent. Nothing is written. */
function prepare(vault: VaultAdapter, settings: TaskWorkbenchSettings, path: string, original: string, used: Set<string>): Prepared {
  const legacy = readLegacyParent(path, original, settings);
  if (!legacy) throw new Error("タスクのノートとして読み取れません");
  const parent: TaskRow = { ...legacy.row, id: generateTaskId("parent", used), ganttOrder: undefined, subtasks: new Map() };
  const reserved = new Set<string>();
  const subs: TaskRow[] = [];
  for (const old of legacy.row.subtasks?.values() ?? []) {
    const subPath = getAvailableSubtaskPath(vault, path, old.displayName || old.title, reserved);
    reserved.add(subPath);
    const id = generateTaskId("subtask", used);
    const extras = old.key ? legacy.subtaskExtras.get(old.key) : undefined;
    const row: TaskRow = {
      ...old, id, key: id, parentId: parent.id,
      file: { path: subPath, parentPath: path } as TaskRow["file"],
      notes: extras ? [old.notes, extras].filter(Boolean).join("\n\n") : old.notes,
    };
    subs.push(row);
    parent.subtasks!.set(id, row);
  }
  const front = stringifyYaml(newNoteFrontmatter(parent)).replace(/\n*$/, "\n") + (legacy.unknownFrontmatter ? `${legacy.unknownFrontmatter}\n` : "");
  const parentText = `---\n${front}---\n${legacy.prelude ? `${legacy.prelude}\n\n` : ""}${newNoteBody(parent)}${legacy.sections ? `\n${legacy.sections}\n` : ""}`;
  return { parent, subs, parentText, subTexts: subs.map((sub) => newNoteText(vault, sub, parent)), original, legacy };
}

/** The fields the conversion must carry over unchanged. Priority only counts when it was set by hand. */
function comparable(row: TaskRow): unknown {
  const manual = row.priorityMode === "manual";
  const sorted = (map: Record<string, number> | undefined) => Object.entries(map ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return {
    title: row.displayName || row.title, status: row.statusLabel, completed: row.completed,
    created: row.createdAt, updated: row.updatedAt, due: row.dueDate || "", tags: row.tags ?? [],
    priority: manual ? row.priority : null, priorityMode: manual ? "manual" : "auto",
    currentStatus: row.currentStatus ?? "", notes: row.notes ?? "",
    gantt: row.kind === "parent" ? !!row.ganttEnabled : null,
    start: row.plannedStartDate || "", end: row.plannedEndDate || "",
    plan: sorted(row.workloadPlan), actual: sorted(row.workloadActual),
    markers: (row.ganttMarkers ?? []).map((marker) => [marker.title, marker.date, marker.tags ?? []]),
  };
}

async function readBack(vault: VaultAdapter, settings: TaskWorkbenchSettings, path: string) {
  const file = vault.getFileByPath(path);
  if (!file) return undefined;
  let note = await readNote(vault, file, settings);
  if (note === undefined) { await vault.whenIndexed([file]); note = await readNote(vault, file, settings); }
  return note ?? undefined;
}

/** Reads the written notes again and compares them with the v1 data. Returns the differences. */
async function verify(vault: VaultAdapter, settings: TaskWorkbenchSettings, path: string, prepared: Prepared): Promise<string[]> {
  const problems: string[] = [];
  const check = (label: string, expected: TaskRow, actual: TaskRow | undefined) => {
    if (!actual) { problems.push(`${label}: 読み込めません`); return; }
    const a = comparable(expected) as Record<string, unknown>, b = comparable(actual) as Record<string, unknown>;
    for (const key of Object.keys(a)) if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) problems.push(`${label}: ${key}`);
    if (actual.id !== expected.id) problems.push(`${label}: id`);
  };
  const parent = await readBack(vault, settings, path);
  check(path, prepared.parent, parent?.row);
  for (const sub of prepared.subs) {
    const note = await readBack(vault, settings, sub.file.path);
    check(sub.file.path, sub, note?.row);
    const resolved = note?.parentLink ? vault.resolveLink(note.parentLink, sub.file.path) : null;
    if (!resolved || resolved.path !== path) problems.push(`${sub.file.path}: parent リンク`);
    if (note?.row.kind !== "subtask") problems.push(`${sub.file.path}: type`);
  }
  return problems;
}

/** Puts one parent back: created subtask notes go to the trash and the parent note gets its backed-up text. */
async function rollback(vault: VaultAdapter, path: string, created: string[], backupRoot: string, original: string): Promise<void> {
  for (const subPath of created.reverse()) {
    const file = vault.getFileByPath(subPath);
    if (file) { try { await vault.trash(file); } catch { /* the backup holds the originals */ } }
  }
  const file = vault.getFileByPath(path);
  if (!file) return;
  let text = original;
  try { text = (await vault.adapterRead?.(`${backupRoot}/${path}`)) ?? original; } catch { /* the copy in memory is the same text */ }
  await vault.modify(file, text);
  await vault.afterWrite(file, true);
}

/**
 * Converts the planned notes. The task folder is copied to the backup folder first; each parent is then
 * converted on its own, re-read and compared with the v1 data, and restored from the backup when anything differs.
 */
export async function runMigration(vault: VaultAdapter, settings: TaskWorkbenchSettings, plan: MigrationPlan, deps: MigrationDeps): Promise<MigrationReport> {
  const report: MigrationReport = { backupRoot: plan.backupRoot, converted: [], failed: [], warnings: [] };
  if (!plan.items.length) return report;
  if (!vault.copyFolder) throw new Error("バックアップを作成できないため、変換を中止しました");
  const root = taskRoot(settings);
  await vault.copyFolder(root, `${plan.backupRoot}/${root}`);

  const used = collectTaskIds(vault, settings);
  let done = 0;
  for (const item of plan.items) {
    deps.onProgress?.(done, plan.items.length, item.path);
    done += 1;
    const created: string[] = [];
    let original = "";
    try {
      const file = vault.getFileByPath(item.path);
      if (!file) throw new Error("ノートが見つかりません");
      original = await vault.read(file);
      const prepared = prepare(vault, settings, item.path, original, new Set(used));
      for (const sub of prepared.subs) if (vault.getFileByPath(sub.file.path)) throw new Error(`作成先が既に存在します: ${sub.file.path}`);

      // Subtask notes first: if anything fails before the parent is rewritten, the v1 note is untouched.
      for (const [index, sub] of prepared.subs.entries()) {
        const made = await vault.create(sub.file.path, prepared.subTexts[index]);
        created.push(sub.file.path);
        await vault.afterWrite(made, true);
      }
      await vault.modify(file, prepared.parentText);
      await vault.afterWrite(file, true);

      const problems = await verify(vault, settings, item.path, prepared);
      if (problems.length) throw new Error(`変換結果が元の内容と一致しません (${problems.join(", ")})`);

      const candidate = structuredClone(settings);
      candidate.subtaskOrder = { ...candidate.subtaskOrder, [prepared.parent.id]: prepared.subs.map((sub) => sub.id) };
      if (candidate.ganttParentOrder) candidate.ganttParentOrder = candidate.ganttParentOrder.map((entry) => entry === item.path ? prepared.parent.id : entry);
      await deps.persist(candidate, ["subtaskOrder", "ganttParentOrder"]);
      settings.subtaskOrder = candidate.subtaskOrder;
      settings.ganttParentOrder = candidate.ganttParentOrder;

      used.add(prepared.parent.id);
      for (const sub of prepared.subs) used.add(sub.id);
      report.converted.push({ path: item.path, parentId: prepared.parent.id, subtaskIds: prepared.subs.map((sub) => sub.id) });
      report.warnings.push(...prepared.legacy.warnings.map((warning) => `${item.path}: ${warning}`));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      try { await rollback(vault, item.path, created, plan.backupRoot, original); }
      catch (restoreError) { report.failed.push({ path: item.path, reason: `${reason} / 元に戻せませんでした: ${restoreError instanceof Error ? restoreError.message : String(restoreError)} (バックアップ: ${plan.backupRoot})` }); continue; }
      report.failed.push({ path: item.path, reason });
    }
  }

  // Converted parents that are not in the stored order yet (it never existed, or it was completed while the v1 notes
  // were still hidden, so it is empty or lacks them) are appended in the v1 notes' own ganttOrder.
  const placed = new Set(settings.ganttParentOrder ?? []);
  const unplaced = report.converted.filter((entry) => !placed.has(entry.parentId));
  if (unplaced.length) {
    const legacyOrder = new Map<string, number>();
    await Promise.all(unplaced.map(async (entry) => {
      const text = await vault.adapterRead?.(`${plan.backupRoot}/${entry.path}`).catch(() => undefined);
      const order = text === undefined ? NaN : parseFloat(/^ganttOrder:\s*(.+)$/m.exec(text)?.[1] ?? "");
      legacyOrder.set(entry.parentId, Number.isFinite(order) ? order : 999999);
    }));
    const candidate = structuredClone(settings);
    candidate.ganttParentOrder = [
      ...(settings.ganttParentOrder ?? []),
      ...unplaced.map((entry) => entry.parentId).sort((a, b) => (legacyOrder.get(a) ?? 999999) - (legacyOrder.get(b) ?? 999999)),
    ];
    await deps.persist(candidate, ["subtaskOrder", "ganttParentOrder"]);
    settings.ganttParentOrder = candidate.ganttParentOrder;
  }
  return report;
}
