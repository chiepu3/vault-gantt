import { isMemoId } from "./ids";
import { readDate, splitFrontmatter, type Frontmatter } from "./note-v2";
import { sanitizeFileStem } from "./file-names";
import type { MemoLayout } from "./types";

export type { MemoLayout };

/**
 * Floating memos: one note per memo in `<taskFolder>/_memos/`. The note only says what the memo is attached to;
 * where the bubble sits and whether it is open is view state and lives in the plugin settings (`ganttMemoLayout`).
 */
export const MEMO_FOLDER = "_memos";
export const MEMO_TYPE = "gantt-memo";
/** The file-name part taken from the memo's first line. */
export const MEMO_FILE_TITLE_LENGTH = 40;
export const MEMO_TEXT_LIMIT = 20000;

export const MEMO_MIN_WIDTH = 140;
export const MEMO_MAX_WIDTH = 480;
export const MEMO_DEFAULT_WIDTH = 220;
/** Where a bubble sits relative to its anchor when nothing placed it yet: up and to the right. */
export const MEMO_DEFAULT_OFFSET = { dx: 28, dy: -70 } as const;

/** What a memo note says about itself. The text is read separately (lazily). */
export interface MemoMeta {
  id: string;
  path: string;
  /** Subtask (s-) or parent (t-) id; undefined = the 「その他」 row. */
  taskId?: string;
  /** Subtask anchors: days from the subtask's plannedStartDate. */
  at?: number;
  /** Parent and free anchors: the date. Subtask memos keep the date they were last placed on as a hint for when the task is gone. */
  date?: string;
  created: string;
  updated: string;
}

export const isMemoNote = (fm: Frontmatter | null | undefined): boolean => fm?.type === MEMO_TYPE;

/** `at` as stored: a whole number of days, never negative. */
export function readDayOffset(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : undefined;
}

/** Reads a memo note's frontmatter. null = not a memo note, or one without a usable id. */
export function parseMemoMeta(path: string, fm: Frontmatter | null | undefined): MemoMeta | null {
  if (!fm || !isMemoNote(fm) || !isMemoId(fm.id)) return null;
  const taskId = typeof fm.task === "string" && fm.task.trim() ? fm.task.trim() : undefined;
  const date = readDate(fm.date);
  const at = readDayOffset(fm.at);
  const created = readDate(fm.created), updated = readDate(fm.updated);
  return {
    id: fm.id, path,
    ...(taskId ? { taskId } : {}),
    ...(at !== undefined ? { at } : {}),
    ...(/^\d{4}-\d{2}-\d{2}$/.test(date) ? { date } : {}),
    created, updated: updated || created,
  };
}

/** Frontmatter keys of a memo, in the documented order. `undefined` values are left out. */
export function memoFrontmatter(meta: Omit<MemoMeta, "path">): Frontmatter {
  const fm: Frontmatter = { type: MEMO_TYPE, id: meta.id };
  if (meta.taskId) fm.task = meta.taskId;
  if (meta.at !== undefined) fm.at = meta.at;
  if (meta.date) fm.date = meta.date;
  fm.created = meta.created;
  fm.updated = meta.updated;
  return fm;
}

/** Whole text of a new memo note. `stringifyYaml` is Obsidian's (or the test/shim equivalent). */
export function buildMemoNote(meta: Omit<MemoMeta, "path">, text: string, stringifyYaml: (value: unknown) => string): string {
  return `---\n${stringifyYaml(memoFrontmatter(meta)).replace(/\n*$/, "\n")}---\n${normalizeMemoText(text)}\n`;
}

/** Line breaks as \n, no leading/trailing blank space. */
export const normalizeMemoText = (text: string): string => text.replace(/\r\n?/g, "\n").trim();

/** The memo text of a whole note: everything after the frontmatter. */
export function memoBody(content: string): string {
  return normalizeMemoText(splitFrontmatter(content).body);
}

/** Replaces the body and stamps `updated`, keeping every other byte of the frontmatter. */
export function replaceMemoBody(content: string, text: string, updated: string): string {
  const { front } = splitFrontmatter(content);
  const stamped = /^updated:.*$/m.test(front) ? front.replace(/^updated:.*$/m, `updated: ${updated}`) : front;
  return `${stamped}${normalizeMemoText(text)}\n`;
}

/**
 * Rewrites the anchor keys (`task`, `at`, `date`) and stamps `updated`, keeping every other line and the body.
 * The same edit `processFrontMatter` makes, as a pure text transform (a plan needs the exact bytes up front).
 */
export function replaceMemoAnchor(content: string, fields: Pick<MemoMeta, "taskId" | "at" | "date">, updated: string, stringifyYaml: (value: unknown) => string): string {
  const { front, body } = splitFrontmatter(content);
  const anchor: Frontmatter = {};
  if (fields.taskId) anchor.task = fields.taskId;
  if (fields.at !== undefined) anchor.at = fields.at;
  if (fields.date) anchor.date = fields.date;
  const added = Object.keys(anchor).length ? stringifyYaml(anchor).replace(/\n*$/, "").split("\n") : [];
  const kept = front.split("\n").filter((line) => !/^(task|at|date):/.test(line)).map((line) => /^updated:/.test(line) ? `updated: ${updated}` : line);
  const at = kept.findIndex((line) => /^id:/.test(line));
  kept.splice(at >= 0 ? at + 1 : 1, 0, ...added);
  return `${kept.join("\n")}${body}`;
}

/** File stem of a new memo: `YYYY-MM-DD <first line>`. */
export function memoFileStem(text: string, dateStr: string): string {
  const firstLine = normalizeMemoText(text).split("\n")[0] ?? "";
  const prefix = `${dateStr} `;
  return `${prefix}${sanitizeFileStem(firstLine, Math.min(MEMO_FILE_TITLE_LENGTH, 100 - prefix.length))}`;
}

/** First line of the memo, for lists and labels. */
export function memoHeadline(text: string, max = 24): string {
  const line = normalizeMemoText(text).split("\n")[0] ?? "";
  const chars = Array.from(line);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : line;
}

export const memoRoot = (settings: { taskFolder: string }): string => `${settings.taskFolder.replace(/\/$/, "")}/${MEMO_FOLDER}`;
export const isMemoPath = (path: string, settings: { taskFolder: string }): boolean => path.startsWith(`${memoRoot(settings)}/`) && path.endsWith(".md");

/** A missing layout entry means open and auto-placed (dx/dy are filled in by the view). */
export function memoIsOpen(layout: Record<string, MemoLayout | undefined> | undefined, id: string): boolean {
  return layout?.[id]?.open !== false;
}

/** Clamps what is read from data.json, which may have been edited by hand. */
export function normalizeMemoLayout(value: unknown): Record<string, MemoLayout> {
  const out: Record<string, MemoLayout> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const num = (v: unknown, fallback: number) => typeof v === "number" && Number.isFinite(v) ? v : fallback;
    out[id] = {
      open: entry.open !== false,
      dx: Math.round(num(entry.dx, 0)), dy: Math.round(num(entry.dy, 0)),
      w: Math.min(MEMO_MAX_WIDTH, Math.max(MEMO_MIN_WIDTH, Math.round(num(entry.w, MEMO_DEFAULT_WIDTH)))),
    };
  }
  return out;
}

/** Opens or closes the memos in `ids` (every memo in `all` when ids is ["*"]); one that was never placed gets the default offsets. */
export function setMemosOpen(layout: Record<string, MemoLayout>, all: readonly string[], ids: readonly string[], open: boolean): Record<string, MemoLayout> {
  const next = { ...layout };
  for (const id of ids.includes("*") ? all : ids) {
    const stored = next[id];
    next[id] = stored ? { ...stored, open } : { open, dx: MEMO_DEFAULT_OFFSET.dx, dy: MEMO_DEFAULT_OFFSET.dy, w: MEMO_DEFAULT_WIDTH };
  }
  return next;
}
