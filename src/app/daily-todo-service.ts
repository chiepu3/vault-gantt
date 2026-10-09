import { Notice, TFile, moment } from "obsidian";
import type { App, Vault, Workspace } from "obsidian";

import type { Logger } from "../core/logger";

import type { HistoryManager } from "./history-manager";
import {
  createDailyTodoFile,
  ensureParentFolderExists,
} from "./daily-note-creation";
export { ensureParentFolderExists };
import type {
  DailyTodoItem,
  DailyTodoSourceConfig,
  DailyTodoSummary,
  TaskWorkbenchSettings,
} from "../core/types";



// Daily ToDo items retain their original source fields and are merged by date.
/** returns configured sources without re-injecting defaults. */
export function getDailyTodoSources(
  settings: TaskWorkbenchSettings
): DailyTodoSourceConfig[] {
  return Array.isArray(settings.dailyTodoSources)
    ? [...settings.dailyTodoSources]
    : [];
}

/**
 *
 * Appends a new source to the persisted settings array. The optional initial
 * values are used by both the blank-row UI action and the Daily Notes import;
 * unspecified fields intentionally remain editable blank defaults.
 */
export function addDailyTodoSource(
  settings: TaskWorkbenchSettings,
  initial: Partial<Omit<DailyTodoSourceConfig, "key">> = {}
): DailyTodoSourceConfig {
  if (!Array.isArray(settings.dailyTodoSources)) {
    settings.dailyTodoSources = [];
  }

  const existingKeys = new Set(
    settings.dailyTodoSources.map((source) => source.key)
  );
  let key = `source-${Date.now()}`;
  while (existingKeys.has(key)) {
    key = `source-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  }

  const source: DailyTodoSourceConfig = {
    key,
    label: "",
    format: "",
    creatableFromGantt: false,
    ...initial,
  };
  settings.dailyTodoSources.push(source);
  return source;
}

/** resolves a configured source's full path for a date. */
export function getDailyTodoPathForDate(
  dateStr: string,
  sourceKey: string,
  settings: TaskWorkbenchSettings
): string {
  const sources = getDailyTodoSources(settings);
  if (sources.length === 0) {
    return "";
  }
  const source =
    sources.find((candidate) => candidate.key === sourceKey) ?? sources[0];
  return `${moment(dateStr, "YYYY-MM-DD").format(source.format)}.md`;
}

/**
 * Derives the literal folder prefix before the first Moment format token.
 * Moment bracket-wrapped literals are unwrapped for path matching.
 * Prefix order determines ownership when sources overlap; slash styles are normalized.
 */
function getStaticFolderPrefix(source: DailyTodoSourceConfig): string {
  const format = source.format;
  let prefix = "";
  let index = 0;

  while (index < format.length) {
    const character = format[index];
    if (character === "[") {
      const closingIndex = format.indexOf("]", index + 1);
      if (closingIndex === -1) {
        break;
      }
      prefix += format.slice(index + 1, closingIndex);
      index = closingIndex + 1;
      continue;
    }
    if (/[YMDHhmsSAaZzwWeExXQqDdGgkK]/.test(character)) {
      break;
    }
    prefix += character;
    index += 1;
  }

  return prefix;
}

/** first configured source whose literal prefix owns a path. */
export function getDailyTodoSourceForPath(
  path: string | undefined,
  settings: TaskWorkbenchSettings
): DailyTodoSourceConfig | null {
  if (!path) {
    return null;
  }
  const normalizedPath = path.replace(/\\/g, "/");
  for (const source of getDailyTodoSources(settings)) {
    const prefix = getStaticFolderPrefix(source);
    const normalizedPrefix = prefix.replace(/\/$/, "");
    if (
      normalizedPath === normalizedPrefix ||
      normalizedPath.startsWith(prefix)
    ) {
      return source;
    }
  }
  return null;
}

/** true when the file belongs to a configured source. */
export function isDailyNoteFile(
  file: TFile,
  settings: TaskWorkbenchSettings
): boolean {
  return getDailyTodoSourceForPath(file?.path, settings) !== null;
}


// checkbox line detector, indentation-tolerant, "-" or "*"
// bullet markers, single-char state inside the brackets.
const CHECKBOX_PATTERN = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/;






















export function parseDailyTodos(content: string): DailyTodoItem[] {
  // line-by-line, CR stripped (handles CRLF line endings).
  const lines = content.split("\n").map((line) => line.replace(/\r$/, ""));

  const items: DailyTodoItem[] = [];
  lines.forEach((line, index) => {
    const match = line.match(CHECKBOX_PATTERN);
    if (!match) {
      return;
    }
    const [, marker, text] = match;
    items.push({
      sourceKey: "",
      sourceLabel: "",
      path: "",
      line: index,
      // empty text is recorded as "" (not skipped).
      text,
      // only the first "[x]"/"[ ]" is recognized as the
      // checkbox state — a second bracket pair later on the same line
      // (e.g. "- [x] [x] foo") is simply part of `text` because the regex
      // only consumes the first bracket group before capturing the rest.
      completed: marker === "x" || marker === "X",
      isNew: false,
    });
  });
  return items;
}

// 6-digit YYMMDD immediately before "_デイリー" (main daily
// notes). The negative lookahead excludes "..._デイリーミーティング" paths,
// though in practice they never have a 6-digit run there anyway (their
// filename prefix is 4 digits, MMDD) — kept as a defensive belt-and-braces
// check rather than relying solely on digit-count to disambiguate.
const MAIN_DATE_PATTERN = /(\d{6})_デイリー(?!ミーティング)/;
// 4-digit MMDD immediately before "_デイリーミーティング".
const MEETING_DATE_PATTERN = /(\d{4})_デイリーミーティング/;
// a "20XX" path segment, used to recover the meeting note's
// year (not present in its MMDD-only filename). Matches whether the segment
// sits between two "/"s or at the very start/end of the path.
const YEAR_SEGMENT_PATTERN = /(?:^|\/)(20\d{2})(?:\/|$)/;
// ISO-ish date with "-" or "_" separators, either mixed.
const ISO_DATE_PATTERN = /(\d{4})[-_](\d{2})[-_](\d{2})/;
// 8 contiguous digits (YYYYMMDD).
const COMPACT_DATE_PATTERN = /(\d{4})(\d{2})(\d{2})/;

/**
 *
 * Recovers a YYYY-MM-DD date from a configured source path first, then tries
 * the unchanged fallback regex patterns as a safety net; "" if none match.
 */
export function extractDateFromDailyPath(
  path: string | undefined,
  settings: TaskWorkbenchSettings
): string {
  if (!path) {
    return "";
  }
  const normalized = path.replace(/\\/g, "/");
  const source = getDailyTodoSourceForPath(normalized, settings);
  if (source) {
    const pathWithoutMdExtension = normalized.replace(/\.md$/i, "");

    // Moment strict mode requires literal text in a custom format to be wrapped
    // in `[...]` (its standard escaping convention). Unescaped Latin literal
    // text can make strict parsing fail; the fallback regex safety net below may
    // recover a date, depending on the path pattern.

    const parsed = moment(pathWithoutMdExtension, source.format, true);
    if (parsed.isValid()) {
      return parsed.format("YYYY-MM-DD");
    }
  }

  const mainMatch = normalized.match(MAIN_DATE_PATTERN);
  if (mainMatch) {
    const digits = mainMatch[1];
    const year = 2000 + Number(digits.slice(0, 2));
    const month = digits.slice(2, 4);
    const day = digits.slice(4, 6);
    return `${year}-${month}-${day}`;
  }

  const meetingMatch = normalized.match(MEETING_DATE_PATTERN);
  if (meetingMatch) {
    const digits = meetingMatch[1];
    const month = digits.slice(0, 2);
    const day = digits.slice(2, 4);
    const yearMatch = normalized.match(YEAR_SEGMENT_PATTERN);
    const year = yearMatch ? yearMatch[1] : String(new Date().getFullYear());
    return `${year}-${month}-${day}`;
  }

  const isoMatch = normalized.match(ISO_DATE_PATTERN);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  const compactMatch = normalized.match(COMPACT_DATE_PATTERN);
  if (compactMatch) {
    return `${compactMatch[1]}-${compactMatch[2]}-${compactMatch[3]}`;
  }

  return "";
}

/**
 * Per-file cache entry: the fully-resolved items (sourceKey/sourceLabel/path
 * already filled in) from the last parse, keyed by the file's mtime/size and
 * source configuration at that time.
 */
interface DailyTodoFileCacheEntry {
  mtime: number;
  size: number;
  sourceKey: string;
  sourceLabel: string;
  sourceFormat: string;
  items: DailyTodoItem[];
}

/**
 *
 * Holds the per-file mtime/size cache as instance state. A bare function
 * could not persist this across calls, so this class follows the existing
 * instance-based `HolidayService` design and exposes exactly one public
 * method. Keeping the cache here rather than in a module-global `Map` also
 * prevents plugin instances (for example, separate tests) from sharing it.
 */
export class DailyTodoService {
  private readonly fileCache = new Map<string, DailyTodoFileCacheEntry>();

  /**
 * Scans every daily-note file in the vault, parses its ToDo checkboxes,
 * groups them by date (merging main + meeting sources for the same date
 * into a single summary), and returns the summaries sorted ascending by
 * date with empty-total dates excluded.
 *
 * a file is re-parsed only when its mtime or size differs
 * from the cached entry; cache entries for files no longer present in the
 * vault are dropped up front so the cache can't grow unboundedly.
 */
  async loadDailyTodoSummaries(
    vault: Vault,
    settings: TaskWorkbenchSettings,
    logger?: Logger
  ): Promise<DailyTodoSummary[]> {

    const startedAt = Date.now();

    // enumerate all markdown files, filter to daily-note ones.
    const files = vault
      .getMarkdownFiles()
      .filter((file) => isDailyNoteFile(file, settings));

    // drop cache entries for files that no longer exist.
    const currentPaths = new Set(files.map((file) => file.path));
    for (const cachedPath of this.fileCache.keys()) {
      if (!currentPaths.has(cachedPath)) {
        this.fileCache.delete(cachedPath);
      }
    }

    const byDate = new Map<string, DailyTodoItem[]>();

    for (const file of files) {
      // isDailyNoteFile already guarantees a source resolves for this
      // path, so this is never null in practice; the guard is defensive.
      const source = getDailyTodoSourceForPath(file.path, settings);
      if (!source) {
        continue;
      }

      const date = extractDateFromDailyPath(file.path, settings);
      if (!date) {
        continue;
      }

      const mtime = file.stat?.mtime ?? 0;
      const size = file.stat?.size ?? 0;
      const cached = this.fileCache.get(file.path);

      // `null` means this file contributes nothing to this pass.
      let items: DailyTodoItem[] | null;
      if (
        cached &&
        cached.mtime === mtime &&
        cached.size === size &&
        cached.sourceKey === source.key &&
        cached.sourceLabel === source.label &&
        cached.sourceFormat === source.format
      ) {
        // Shallow-copy each item so caller mutations, including edits before
        // persistence, cannot corrupt the cached entry.
        items = cached.items.map((item) => ({ ...item }));
      } else {
        try {
          // cachedRead — cheaper than a full disk read for a
          // bulk scan across every daily note in the vault.
          const content = await vault.cachedRead(file);
          // Fill in the source key, source label, and file path.

          items = parseDailyTodos(content).map((item) => ({
            ...item,
            sourceKey: source.key,
            sourceLabel: source.label,
            path: file.path,
          }));
          this.fileCache.set(file.path, {
            mtime,
            size,
            sourceKey: source.key,
            sourceLabel: source.label,
            sourceFormat: source.format,
            items,
          });
        } catch (error) {
          // a read failure falls back to the last
          // successfully-cached parse for this file (even if now stale
          // relative to mtime/size) instead of aborting the entire
          // vault-wide scan over one bad file; with no prior cache at all,
          // this file contributes nothing this pass (skipped, not thrown).

          if (logger) {
            logger.warn(
              "DailyTodoService",
              `failed to read ${file.path}`,
              error
            );
          } else {
            console.warn(
              `DailyTodoService: failed to read ${file.path}`,
              error
            );
          }

          const cacheMatchesSource =
            cached?.sourceKey === source.key &&
            cached.sourceLabel === source.label &&
            cached.sourceFormat === source.format;
          items = cacheMatchesSource && cached
            ? cached.items.map((item) => ({ ...item }))
            : null;
        }
      }

      if (items === null) {
        continue;
      }

      // merge multiple files (main + meeting) for the same date.
      const existing = byDate.get(date);
      if (existing) {
        existing.push(...items);
      } else {
        byDate.set(date, [...items]);
      }
    }

    // Keep the existing completedCount and totalCount summary fields.


    const summaries = Array.from(byDate.entries())
      .map(([date, items]): DailyTodoSummary => ({
        date,
        items,
        completedCount: items.filter((item) => item.completed).length,
        totalCount: items.length,
      }))
      .filter((summary) => summary.totalCount > 0)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    logger?.debug("DailyTodoService", "summaries loaded", {
      durationMs: Date.now() - startedAt,
      summaryCount: summaries.length,
    });

    return summaries;
  }
}



/**
 * Write helpers update checkbox lines and ToDo sections. Unlike reads,
 * write failures propagate to callers.
 */


/**
 * Shared line-formatting rule for every write path below: identical to the
 * shape `parseDailyTodos`'s CHECKBOX_PATTERN reads back (a single space
 * after the closing bracket, "x"/" " marker — never "X").
 */
function formatDailyTodoLine(completed: boolean, text: string): string {
  return `- [${completed ? "x" : " "}] ${text}`;
}

/**
 *
 * Rewrites one checkbox line in place. `patch.text`/`patch.completed` are
 * optional — an omitted field falls back to `item`'s current value (a
 * completed-only toggle doesn't need to resend text, and vice versa).
 * Returns false (and touches nothing) when: `item.path` is empty,
 * `item.line` is negative, the file can't be resolved to a real TFile, the
 * line index is out of range for the file's current content, or the
 * resulting text is empty after trimming — an
 * empty result must go through deleteDailyTodoItem instead, this function
 * never turns a text-clear into a line deletion.
 * On success, `vault.modify` persists the change and `item` itself is
 * mutated so a caller holding onto the same object sees the update
 * without re-loading.
 */
export async function updateDailyTodoItem(
  item: DailyTodoItem,
  patch: { text?: string; completed?: boolean },
  vault: Vault,
  historyManager?: HistoryManager
): Promise<boolean> {
  if (!item.path || item.line < 0) {
    return false;
  }
  const file = vault.getAbstractFileByPath(item.path);
  if (!(file instanceof TFile)) {
    return false;
  }

  const content = await vault.read(file);
  const lines = content.split("\n");
  if (item.line >= lines.length) {
    return false;
  }

  const nextText = patch.text ?? item.text;
  if (nextText.trim() === "") {
    return false;
  }
  const nextCompleted = patch.completed ?? item.completed;

  lines[item.line] = formatDailyTodoLine(nextCompleted, nextText);
  await vault.modify(file, lines.join("\n"));
  historyManager?.clear();

  // sync the caller's in-memory item on success.
  item.text = nextText;
  item.completed = nextCompleted;
  return true;
}








export async function deleteDailyTodoItem(
  item: DailyTodoItem,
  vault: Vault,
  historyManager?: HistoryManager
): Promise<boolean> {
  if (!item.path || item.line < 0) {
    return false;
  }
  const file = vault.getAbstractFileByPath(item.path);
  if (!(file instanceof TFile)) {
    return false;
  }

  const content = await vault.read(file);
  const lines = content.split("\n");
  if (item.line >= lines.length) {
    return false;
  }

  lines.splice(item.line, 1);
  await vault.modify(file, lines.join("\n"));
  historyManager?.clear();
  return true;
}

// level-2 "## ToDoリスト" heading only — "#"/"###" etc. don't count.
const TODO_HEADING_PATTERN = /^##\s+ToDoリスト\s*$/;
// any heading (level 1-6) that would close the ToDo section.
const ANY_HEADING_PATTERN = /^#{1,6}\s+/;

/**
 *
 * Finds where newly-inserted ToDo lines should land: right before the next
 * heading after "## ToDoリスト" (or EOF if that section runs to the end of
 * the file), or EOF outright when no such heading exists at all.
 */
export function getDailyTodoInsertIndex(lines: string[]): number {
  const headingIndex = lines.findIndex((line) =>
    TODO_HEADING_PATTERN.test(line)
  );
  if (headingIndex === -1) {
    return lines.length;
  }

  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    if (ANY_HEADING_PATTERN.test(lines[i])) {
      return i;
    }
  }
  return lines.length;
}

/**
 *
 * Appends `items` into the given date's selected daily note, inside its
 * "## ToDoリスト" section (or at EOF if that section/heading is absent).
 * Items whose text is empty/whitespace-only are dropped; if that
 * leaves nothing to insert, this returns false without touching the file.
 * A missing creatable target file is created by requireMainDailyTodoFile.
 */

export async function insertDailyTodoItems(
  dateStr: string,
  items: DailyTodoItem[],
  app: App,
  settings: TaskWorkbenchSettings,
  historyManager?: HistoryManager
): Promise<boolean> {
  const vault = app.vault;
  const file = await requireMainDailyTodoFile(dateStr, app, settings);
  if (!file) {
    return false;
  }

  const newLines = items
    .filter((item) => item.text.trim() !== "")
    .map((item) => formatDailyTodoLine(item.completed, item.text));
  if (newLines.length === 0) {
    return false;
  }

  const content = await vault.read(file);
  const lines = content === "" ? [] : content.split("\n");
  const insertIndex = getDailyTodoInsertIndex(lines);
  lines.splice(insertIndex, 0, ...newLines);
  await vault.modify(file, lines.join("\n"));
  historyManager?.clear();
  return true;
}



/**
 * Resolves the selected target's file for `dateStr`, or null if absent.
 * The historical function name is retained for existing callers.
 */
export function getMainDailyTodoFile(
  dateStr: string,
  app: App,
  settings: TaskWorkbenchSettings
): TFile | null {
  const source = getDailyTodoSources(settings).find(
    (candidate) => candidate.key === (settings.dailyTodoTargetSourceKey ?? "main")
  );
  if (!source) {
    return null;
  }
  const path = getDailyTodoPathForDate(dateStr, source.key, settings);
  const file = app.vault.getAbstractFileByPath(path);
  return file instanceof TFile ? file : null;
}

/**
 *
 * Resolves or auto-creates the selected target. Existing notes can be
 * appended to regardless of creation permission. Missing targets require
 * an explicit selection; missing files require creation permission.
 */
export async function requireMainDailyTodoFile(
  dateStr: string,
  app: App,
  settings: TaskWorkbenchSettings
): Promise<TFile | null> {
  const source = getDailyTodoSources(settings).find(
    (candidate) => candidate.key === (settings.dailyTodoTargetSourceKey ?? "main")
  );
  if (!source) {
    new Notice("設定で「新規ToDoの追加先」を選んでください。");
    return null;
  }
  const path = getDailyTodoPathForDate(dateStr, source.key, settings);
  const file = getMainDailyTodoFile(dateStr, app, settings);
  if (file) {
    return file;
  }
  if (!source.creatableFromGantt) {
    new Notice(
      `デイリーノートがまだありません: ${path}。Templater等で先に作成してから追加してください。`
    );
    return null;
  }
  return createDailyTodoFile(app, path, source.templatePath);
}

/**
 *
 * "新しいタスク" quick-add: inserts one placeholder item into the given
 * date's selected daily note and, only on success, invokes onDone (e.g. to
 * refresh a caller's view). A missing target or non-creatable missing file causes
 * insertDailyTodoItems to return false after its Notice, so this simply
 * stops without calling onDone in that case.
 */
export async function openOrCreateMainDailyTodoForDate(
  dateStr: string,
  app: App,
  settings: TaskWorkbenchSettings,
  onDone?: () => void
): Promise<void> {
  const placeholder: DailyTodoItem = {
    sourceKey: "main",
    sourceLabel: "デイリー",
    path: "",
    line: -1,
    text: "新しいタスク",
    completed: false,
    isNew: true,
  };
  const inserted = await insertDailyTodoItems(dateStr, [placeholder], app, settings);
  if (inserted) {
    onDone?.();
  }
}













export async function openDailyTodoFile(
  item: DailyTodoItem,
  vault: Vault,
  workspace: Workspace
): Promise<void> {
  if (!item.path) {
    return;
  }
  const file = vault.getAbstractFileByPath(item.path);
  if (!(file instanceof TFile)) {
    return;
  }
  await workspace.getLeaf().openFile(file);
}












export async function openDailyTodoEditor(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _summary: DailyTodoSummary,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _onDone?: () => void
): Promise<void> {
  // no-op by design
}































export async function updateDailyTodos(
  summary: DailyTodoSummary,
  nextItems: DailyTodoItem[],
  app: App,
  settings: TaskWorkbenchSettings,
  historyManager?: HistoryManager
): Promise<void> {
  const vault = app.vault;
  // entries with no corresponding existing line.
  const newItems = nextItems.filter(
    (item) => !item.path || item.line < 0 || item.isNew === true
  );

  // match candidates keyed by path+line, excluding isNew rows
  // so they are only ever handled by the insert pass above.
  const matchByKey = new Map<string, DailyTodoItem>();
  for (const item of nextItems) {
    if (item.path && item.line >= 0 && item.isNew !== true) {
      matchByKey.set(`${item.path}::${item.line}`, item);
    }
  }

  // Group input items by file path.
  const byPath = new Map<string, DailyTodoItem[]>();
  for (const original of summary.items) {
    if (!original.path) {
      continue;
    }
    const existing = byPath.get(original.path);
    if (existing) {
      existing.push(original);
    } else {
      byPath.set(original.path, [original]);
    }
  }

  for (const [path, originals] of byPath) {
    const file = vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      continue;
    }

    const content = await vault.read(file);
    const lines = content.split("\n");

    // descending line-number order.
    const sorted = [...originals].sort((a, b) => b.line - a.line);

    let changed = false;
    for (const original of sorted) {
      if (original.line >= lines.length) {
        continue;
      }
      const match = matchByKey.get(`${original.path}::${original.line}`);
      if (!match) {
        continue;
      }
      // skip (leave the line untouched) when the matched
      // next-item's text is empty.
      if (!match.text || match.text.trim() === "") {
        continue;
      }
      lines[original.line] = formatDailyTodoLine(match.completed, match.text);
      changed = true;
    }

    if (changed) {
      await vault.modify(file, lines.join("\n"));
      historyManager?.clear();
    }
  }

  // insert the unmatched new items.
  if (newItems.length > 0) {
    await insertDailyTodoItems(
      summary.date,
      newItems,
      app,
      settings,
      historyManager
    );
  }
}
