import type { GanttMarker, StatusLabel, TaskRow, TaskWorkbenchSettings, WorkloadMap } from "./types";
import {
  calculateAutoPriority,
  makeUniqueMarkerKey,
  normalizePriority,
  normalizeStatusValue,
  todayStr,
} from "./utils";

/**
 * Note format v2: one note per task. Metadata lives in the note's frontmatter (read through
 * Obsidian's metadataCache, written through processFrontMatter); the body only holds the
 * "## 現状" / "## メモ" sections.
 */
export const FORMAT_VERSION = 2;
export const SECTION_STATUS = "現状";
export const SECTION_NOTES = "メモ";

export type Frontmatter = Record<string, unknown>;
export type NoteKind = "parent" | "subtask";

/** Frontmatter keys the plugin owns and rewrites through diffs. Everything else is the user's. */
export const MANAGED_KEYS = [
  "title", "status", "completed", "created", "updated", "start", "end", "due",
  "priority", "priorityMode", "tags", "gantt", "dependsOn", "plan", "actual", "markers",
] as const;

// ---------------------------------------------------------------- value readers

const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/;

/** YYYY-MM-DD from a string or a Date (YAML timestamps); "" when it is neither. */
export function readDate(value: unknown): string {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    return DATE_PREFIX.exec(trimmed)?.[1] ?? trimmed;
  }
  return "";
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function readBoolean(value: unknown): boolean {
  return value === true || value === "true";
}

/** YAML arrays (or a legacy comma separated string). Empty slots are kept, like the older format did. */
export function readStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => item === null || item === undefined ? "" : String(item).trim());
  if (typeof value === "string" && value.trim()) return value.split(",").map((item) => item.trim());
  return [];
}

/** dependsOn links. An unquoted [[x]] arrives as nested arrays; fold it back into "[[x]]". */
export function readLinkList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : value === undefined || value === null || value === "" ? [] : [value];
  const out: string[] = [];
  for (const item of items) {
    if (Array.isArray(item)) {
      const inner = item.flat(Infinity).map((part) => String(part)).join("");
      if (inner) out.push(`[[${inner}]]`);
    } else if (typeof item === "string" && item.trim()) out.push(item.trim());
  }
  return out;
}

function readWorkload(value: unknown): WorkloadMap | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: WorkloadMap = {};
  for (const [rawKey, raw] of Object.entries(value as Record<string, unknown>)) {
    const date = readDate(rawKey);
    const hours = typeof raw === "number" ? raw : parseFloat(String(raw));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(hours)) continue;
    const rounded = Math.round(hours * 2) / 2;
    if (rounded > 0) out[date] = rounded;
  }
  return Object.keys(out).length ? out : undefined;
}

function readMarkers(value: unknown): GanttMarker[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const used = new Set<string>();
  const markers: GanttMarker[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const date = readDate(record.date);
    if (!date) continue;
    const title = readString(record.title);
    const key = makeUniqueMarkerKey(title, used);
    used.add(key);
    const tags = readStringList(record.tags);
    markers.push({ key, title, date, tags: tags.length ? tags : undefined });
  }
  return markers.length ? markers : undefined;
}

// ---------------------------------------------------------------- row <-> frontmatter

export function noteKindOf(fm: Frontmatter | null | undefined): NoteKind | null {
  const type = fm?.type;
  return type === "task" ? "parent" : type === "subtask" ? "subtask" : null;
}

export function formatVersionOf(fm: Frontmatter | null | undefined): number {
  const value = Number(fm?.formatVersion);
  return Number.isFinite(value) ? value : 1;
}

export interface NoteBodies { currentStatus: string; notes: string }

export interface ParsedNote {
  kind: NoteKind;
  row: TaskRow;
  /** Raw `parent` value of a subtask, e.g. "[[2026-10-01 社内ツール更新]]". */
  parentLink?: string;
}

/** Builds a row from one note's frontmatter. Returns null when the note is not a v2 task note or has no id. */
export function parseNote(
  file: { path: string; basename?: string },
  fm: Frontmatter | null | undefined,
  bodies: NoteBodies,
  settings: Pick<TaskWorkbenchSettings, "autoPriorityEnabled">
): ParsedNote | null {
  const kind = noteKindOf(fm);
  if (!kind || !fm) return null;
  const id = readString(fm.id);
  if (!id) return null;
  const basename = file.basename ?? (file.path.split("/").pop() ?? file.path).replace(/\.md$/i, "");
  const title = readString(fm.title) || basename;
  const statusLabel = (normalizeStatusValue(fm.status) || (readBoolean(fm.completed) ? "done" : "active")) as StatusLabel;
  const priorityMode = readString(fm.priorityMode) === "manual" ? "manual" : "auto";
  const dueDate = readDate(fm.due) || undefined;
  let priority = normalizePriority(fm.priority as number | string | undefined);
  if (priorityMode === "auto" && settings.autoPriorityEnabled) priority = calculateAutoPriority(dueDate);
  const row: TaskRow = {
    kind,
    id,
    file: { path: file.path } as TaskRow["file"],
    title,
    displayName: title,
    statusLabel,
    completed: statusLabel === "done",
    createdAt: readDate(fm.created) || todayStr(),
    updatedAt: readDate(fm.updated) || todayStr(),
    dueDate,
    priority,
    priorityMode,
    currentStatus: bodies.currentStatus,
    notes: bodies.notes,
    tags: readStringList(fm.tags),
    ganttEnabled: kind === "parent" && readBoolean(fm.gantt),
  };
  if (kind === "subtask") {
    row.key = id;
    row.plannedStartDate = readDate(fm.start) || undefined;
    row.plannedEndDate = readDate(fm.end) || undefined;
    row.workloadPlan = readWorkload(fm.plan);
    row.workloadActual = readWorkload(fm.actual);
    row.ganttMarkers = readMarkers(fm.markers);
    const dependsOn = readLinkList(fm.dependsOn);
    if (dependsOn.length) row.dependsOn = dependsOn;
  } else {
    row.subtasks = new Map();
  }
  return { kind, row, parentLink: kind === "subtask" ? readString(fm.parent) || undefined : undefined };
}

const sortedWorkload = (map: WorkloadMap | undefined): WorkloadMap | undefined => {
  const keys = Object.keys(map ?? {}).filter((key) => (map![key] ?? 0) > 0).sort();
  return keys.length ? Object.fromEntries(keys.map((key) => [key, map![key]])) : undefined;
};

/**
 * The frontmatter view of a row: only the managed keys, `undefined` where the key must be absent.
 * Diffing two of these gives the exact keys to change in the note.
 */
export function managedFrontmatter(row: TaskRow): Frontmatter {
  const manual = row.priorityMode === "manual";
  const subtask = row.kind === "subtask";
  return {
    title: row.displayName || row.title,
    status: row.statusLabel,
    completed: row.statusLabel === "done",
    created: row.createdAt,
    updated: row.updatedAt,
    start: subtask ? row.plannedStartDate || undefined : undefined,
    end: subtask ? row.plannedEndDate || undefined : undefined,
    due: row.dueDate || undefined,
    priority: manual ? row.priority : undefined,
    priorityMode: manual ? "manual" : undefined,
    tags: [...(row.tags ?? [])],
    gantt: subtask ? undefined : !!row.ganttEnabled,
    dependsOn: subtask && row.dependsOn?.length ? [...row.dependsOn] : undefined,
    plan: subtask ? sortedWorkload(row.workloadPlan) : undefined,
    actual: subtask ? sortedWorkload(row.workloadActual) : undefined,
    markers: subtask && row.ganttMarkers?.length
      ? row.ganttMarkers.map((marker) => ({ title: marker.title, date: marker.date, ...(marker.tags?.length ? { tags: [...marker.tags] } : {}) }))
      : undefined,
  };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Keys whose value differs. A key that must disappear maps to `undefined`. */
export function diffFrontmatter(before: Frontmatter, after: Frontmatter): Frontmatter {
  const changes: Frontmatter = {};
  for (const key of MANAGED_KEYS) {
    if (!same(before[key], after[key])) changes[key] = after[key];
  }
  return changes;
}

/** Applies `changes` to a frontmatter object in place (used inside processFrontMatter). */
export function applyFrontmatterChanges(fm: Frontmatter, changes: Frontmatter): void {
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete fm[key];
    else fm[key] = value;
  }
}

/** Full frontmatter of a new note, in the documented key order. */
export function newNoteFrontmatter(row: TaskRow, options: { parentLink?: string } = {}): Frontmatter {
  const managed = managedFrontmatter(row);
  const subtask = row.kind === "subtask";
  const ordered: Frontmatter = {
    type: subtask ? "subtask" : "task",
    formatVersion: FORMAT_VERSION,
    id: row.id,
    title: managed.title,
  };
  if (subtask && options.parentLink) ordered.parent = options.parentLink;
  for (const key of ["status", "completed", "created", "updated", "start", "end", "due", "priority", "priorityMode", "tags", "gantt", "dependsOn", "plan", "actual", "markers"]) {
    if (managed[key] !== undefined) ordered[key] = managed[key];
  }
  ordered.cssclasses = ["task"];
  return ordered;
}

// ---------------------------------------------------------------- body

const FRONTMATTER_BLOCK = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** Splits off the leading `---` block by position only; the YAML itself is Obsidian's to parse. */
export function splitFrontmatter(content: string): { front: string; body: string } {
  const match = FRONTMATTER_BLOCK.exec(content);
  return match ? { front: match[0], body: content.slice(match[0].length) } : { front: "", body: content };
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Text under a level-2 heading up to the next heading of level 1-2, trimmed. */
export function extractSection(body: string, heading: string): string {
  const start = new RegExp(`^##[ \\t]+${escapeRegex(heading)}[ \\t]*$`, "m").exec(body);
  if (!start) return "";
  const rest = body.slice(start.index + start[0].length);
  const next = /^#{1,2}[ \t]+/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

export function readSections(content: string): NoteBodies {
  const { body } = splitFrontmatter(content);
  return { currentStatus: extractSection(body, SECTION_STATUS), notes: extractSection(body, SECTION_NOTES) };
}

/** Replaces only the named sections of a whole note, keeping the frontmatter and every other part byte for byte. */
export function replaceSections(content: string, sections: { currentStatus?: string; notes?: string }): string {
  const { front, body } = splitFrontmatter(content);
  let next = body;
  const one = (heading: string, text: string) => {
    const clean = text.replace(/\r\n/g, "\n").replace(/^\n+|\s+$/g, "");
    const start = new RegExp(`^##[ \\t]+${escapeRegex(heading)}[ \\t]*$`, "m").exec(next);
    if (!start) {
      next = `${next}${next && !next.endsWith("\n") ? "\n" : ""}${next ? "\n" : ""}## ${heading}\n${clean ? `${clean}\n` : ""}`;
      return;
    }
    const headEnd = start.index + start[0].length;
    const tail = next.slice(headEnd).replace(/^\r?\n/, "");
    const following = /^#{1,2}[ \t]+/m.exec(tail);
    const text2 = clean ? `${clean}\n` : "";
    next = `${next.slice(0, headEnd)}\n${following ? `${text2}\n${tail.slice(following.index)}` : text2}`;
  };
  if (sections.currentStatus !== undefined) one(SECTION_STATUS, sections.currentStatus);
  if (sections.notes !== undefined) one(SECTION_NOTES, sections.notes);
  return front + next;
}

export function newNoteBody(row: Pick<TaskRow, "currentStatus" | "notes">): string {
  const part = (heading: string, text: string) => `## ${heading}\n${text ? `${text.trim()}\n` : ""}\n`;
  return part(SECTION_STATUS, row.currentStatus ?? "") + `## ${SECTION_NOTES}\n${row.notes ? `${row.notes.trim()}\n` : ""}`;
}

/** Whole text of a new note. `stringifyYaml` is Obsidian's (or the test/shim equivalent). */
export function buildNewNote(row: TaskRow, stringifyYaml: (value: unknown) => string, options: { parentLink?: string } = {}): string {
  return `---\n${stringifyYaml(newNoteFrontmatter(row, options)).replace(/\n*$/, "\n")}---\n${newNoteBody(row)}`;
}
