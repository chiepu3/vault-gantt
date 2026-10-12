import { moment, TFile } from "obsidian";
import { DEFAULT_STATUSES } from "./constants";
import { TaskRow, StatusLabel } from "./types";



export function todayStr(): string {
  // uses moment to get today's date in YYYY-MM-DD format
  return moment().format("YYYY-MM-DD");
}


export function dueDaysFromToday(
  dueDate?: string,
  todayStart?: moment.Moment
): number | null {
  if (!dueDate || dueDate === "") {
    return null;
  }

  // Use strict moment parsing
  const parsed = moment(dueDate, "YYYY-MM-DD", true);
  if (!parsed.isValid()) {
    return null;
  }

  // A render pass may provide one normalized moment to avoid rebuilding
  // today's value for every row. The default keeps standalone callers
  // unchanged; the shared value is intentionally scoped to the caller's
  // render pass and may cross a real midnight boundary.
  const today = todayStart ?? moment().startOf("day");
  const due = parsed.startOf("day");
  return due.diff(today, "days");
}


export function isDueWithinDays(
  dueDate?: string,
  days?: number,
  todayStart?: moment.Moment
): boolean {
  if (days === undefined || days === null) {
    return false;
  }

  const daysFromToday = dueDaysFromToday(dueDate, todayStart);
  if (daysFromToday === null) {
    return false;
  }

  // Returns true if [0, days] inclusive
  return daysFromToday >= 0 && daysFromToday <= days;
}


export function dueBucket(
  dueDate?: string,
  todayStart?: moment.Moment
): number {
  const days = dueDaysFromToday(dueDate, todayStart);

  if (days === null) {
    // No due date
    return 3;
  }

  if (days < 0) {
    // Overdue
    return 0;
  }

  if (days === 0) {
    // Due today
    return 1;
  }

  // Future due date
  return 2;
}


export function isValidDateFormat(value?: string): boolean {
  if (!value || value === "") {
    return true; // Empty is allowed
  }

  // Check if matches YYYY-MM-DD pattern
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  return regex.test(value);
}


export function isValidCalendarDate(value?: string): boolean {
  if (!value || value === "") {
    return true; // Empty is allowed
  }

  // First check format
  if (!isValidDateFormat(value)) {
    return false;
  }

  // Now check actual calendar validity
  const parsed = moment(value, "YYYY-MM-DD", true);
  return parsed.isValid();
}


export function normalizePriority(value?: number | string): number {
  if (value === null || value === undefined) {
    return 0;
  }

  let num: number;
  if (typeof value === "string") {
    num = parseFloat(value);
  } else {
    num = value;
  }

  // Handle non-finite values
  if (!isFinite(num)) {
    return 0;
  }

  // Floor and constrain to [0, 5]
  const floored = Math.floor(num);
  return Math.max(0, Math.min(5, floored));
}


export function calculateAutoPriority(
  dueDate?: string,
  todayStart?: moment.Moment
): number {
  const days = dueDaysFromToday(dueDate, todayStart);

  if (days === null) {
    // Unparseable dueDate
    return 0;
  }

  if (days < 0) {
    // Overdue
    return 5;
  }

  if (days === 0) {
    // Due today
    return 5;
  }

  if (days <= 3) {
    // 1-3 days
    return 4;
  }

  if (days <= 7) {
    // 4-7 days
    return 3;
  }

  if (days <= 14) {
    // 8-14 days
    return 2;
  }

  // > 14 days
  return 1;
}


export function getEffectivePriority(
  row: TaskRow,
  autoPriorityEnabled: boolean,
  todayStart?: moment.Moment
): number {
  if (!autoPriorityEnabled || row.priorityMode === "manual") {
    return normalizePriority(row.priority);
  }

  // Auto mode
  return calculateAutoPriority(row.dueDate, todayStart);
}


export function applyAutoPriorityFields(
  row: TaskRow,
  autoPriorityEnabled: boolean,
  todayStart?: moment.Moment
): void {
  if (autoPriorityEnabled && row.priorityMode === "auto") {
    row.priority = calculateAutoPriority(row.dueDate, todayStart);
  }
}


export function normalizeStatusValue(value?: unknown): string {
  const trimmed = String(value || "").trim();
  return trimmed;
}


export function getStatusLabel(value?: unknown): string {
  const key = String(value || "").trim() as StatusLabel;
  if (key in DEFAULT_STATUSES) {
    return DEFAULT_STATUSES[key];
  }

  return String(value || "");
}


export function sanitizeFileName(name: string): string {
  // Remove only these characters: \ /: * ? " < > | # ^ [ ]
  const charsToRemove = /[\\/:*?"<>|#^[\]]/g;
  return name.replace(charsToRemove, "");
}


export function slugify(name: string): string {
  // Sanitize → lowercase → spaces to hyphen → remove non-alphanumeric (hyphens survive) → truncate 40 chars
  let slug = sanitizeFileName(name);
  slug = slug.toLowerCase();

  // Replace spaces with hyphen
  slug = slug.replace(/\s+/g, "-");

  // Remove non-alphanumeric except hyphens
  slug = slug.replace(/[^a-z0-9-]/g, "");

  // Truncate to 40 characters BEFORE suffix (for collision handling)
  if (slug.length > 40) {
    slug = slug.substring(0, 40);
  }

  return slug;
}


export function getSubtaskKey(
  title: string,
  existingKeys: Set<string> = new Set()
): string {
  let slug = slugify(title);

  // If slug is empty, fallback to timestamp
  if (!slug) {
    slug = `subtask-${Date.now()}`;
  }

  // Check for collision and add suffix if needed (applies to both normal and fallback)
  let key = slug;
  let suffix = 1;

  while (existingKeys.has(key)) {
    key = `${slug}-${suffix}`;
    suffix++;
  }

  return key;
}















export function makeUniqueMarkerKey(
  title: string,
  existingKeys: Set<string> | string[] = new Set()
): string {
  const existing =
    existingKeys instanceof Set ? existingKeys : new Set(existingKeys);

  let slug = sanitizeFileName(title);
  slug = slug.toLowerCase();

  // Collapse whitespace runs to a single hyphen.
  slug = slug.replace(/\s+/g, "-");

  // Strip everything except ASCII alnum/hyphen/underscore and common CJK
  // ranges: Hiragana, Katakana, CJK Unified Ideographs, fullwidth forms.
  slug = slug.replace(/[^a-z0-9\-_぀-ゟ゠-ヿ一-鿿！-｠]/g, "");

  // Truncate to 40 characters BEFORE the collision-suffix check.
  if (slug.length > 40) {
    slug = slug.substring(0, 40);
  }

  // Empty fallback is "marker", not a timestamp (— this is the one
  // intentional difference from getSubtaskKey's "subtask-{timestamp}").
  if (!slug) {
    slug = "marker";
  }

  let key = slug;
  let suffix = 1;
  while (existing.has(key)) {
    key = `${slug}-${suffix}`;
    suffix++;
  }

  return key;
}


export function ensureArray(value?: unknown): string[] {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    if (value === "") {
      return [];
    }
    return [value];
  }

  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item === null) {
        return "null";
      }
      if (item === undefined) {
        return "undefined";
      }
      if (item === "") {
        return null; // Will be filtered out below
      }
      return String(item);
    }).filter((item) => item !== null) as string[];
  }

  return [String(value)];
}


export function compareBy(
  sortKey: string | undefined,
  sortDir: "asc" | "desc" | undefined,
  a: TaskRow,
  b: TaskRow,
  todayStart?: moment.Moment,
  dueBuckets?: ReadonlyMap<string | undefined, number>
): number {
  const direction = sortDir === "desc" ? -1 : 1;

  if (!sortKey || sortKey === "default") {
    // Default sort: dueBucket primary, dueDate secondary, displayName tertiary
    const bucketA = dueBuckets?.get(a.dueDate) ?? dueBucket(a.dueDate, todayStart);
    const bucketB = dueBuckets?.get(b.dueDate) ?? dueBucket(b.dueDate, todayStart);

    if (bucketA !== bucketB) {
      return (bucketA - bucketB) * direction;
    }

    // Same bucket, compare dueDate
    const dueDateA = a.dueDate || "";
    const dueDateB = b.dueDate || "";

    if (dueDateA !== dueDateB) {
      return dueDateA.localeCompare(dueDateB) * direction;
    }

    // Same dueDate, compare displayName
    return a.displayName.localeCompare(b.displayName) * direction;
  }

  if (sortKey === "title") {
    return a.title.localeCompare(b.title) * direction;
  }

  if (sortKey === "updatedAt") {
    // Newest first for dates
    return (b.updatedAt.localeCompare(a.updatedAt)) * direction;
  }

  if (sortKey === "createdAt") {
    // Newest first for dates
    return (b.createdAt.localeCompare(a.createdAt)) * direction;
  }

  if (sortKey === "statusLabel") {
    // Sort by Japanese label
    const labelA = getStatusLabel(a.statusLabel);
    const labelB = getStatusLabel(b.statusLabel);
    return labelA.localeCompare(labelB) * direction;
  }

  if (sortKey === "dueDate") {
    const bucketA = dueBuckets?.get(a.dueDate) ?? dueBucket(a.dueDate, todayStart);
    const bucketB = dueBuckets?.get(b.dueDate) ?? dueBucket(b.dueDate, todayStart);

    if (bucketA !== bucketB) {
      return (bucketA - bucketB) * direction;
    }

    const dueDateA = a.dueDate || "";
    const dueDateB = b.dueDate || "";
    return dueDateA.localeCompare(dueDateB) * direction;
  }

  return 0;
}


export function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): string[] {
  const changed: string[] = [];

  for (const key in after) {
    const beforeValue = JSON.stringify(before[key]);
    const afterValue = JSON.stringify(after[key]);

    if (beforeValue !== afterValue) {
      changed.push(key);
    }
  }

  return changed;
}


export function buildFileRevision(file?: TFile): string {
  if (!file || !file.stat) {
    return "0:0";
  }

  const { mtime, size } = file.stat;
  return `${mtime}:${size}`;
}


export interface EmbedConfig {
  showCompleted: boolean;
  status: string;
  sort: string;
  dir: "asc" | "desc";
  flatDueSort: boolean;
  maxRows: number;
}


export function parseEmbedConfig(src: string): EmbedConfig {

  const config: EmbedConfig = {
    showCompleted: false,
    status: "all",
    sort: "dueDate",
    dir: "asc",
    flatDueSort: false,
    maxRows: 50,
  };


  const lines = String(src ?? "").split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes("=")) {
      continue;
    }

    const [key, ...valueParts] = trimmed.split("=");
    const keyTrimmed = key.trim();
    const valueTrimmed = valueParts.join("=").trim();

    if (keyTrimmed === "showCompleted") {
      config.showCompleted = valueTrimmed === "true";
    } else if (keyTrimmed === "status") {
      config.status = valueTrimmed;
    } else if (keyTrimmed === "sort") {
      config.sort = valueTrimmed;
    } else if (keyTrimmed === "dir") {
      if (valueTrimmed === "asc" || valueTrimmed === "desc") {
        config.dir = valueTrimmed;
      }
    } else if (keyTrimmed === "flatDueSort") {
      config.flatDueSort = valueTrimmed === "true";
    } else if (keyTrimmed === "maxRows") {
      const num = parseInt(valueTrimmed, 10);
      if (!isNaN(num)) {
        config.maxRows = num;
      }
    }
  }

  return config;
}
