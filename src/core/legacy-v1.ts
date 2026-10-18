import { extractSection, parseTaskFile, splitSubtasksSection } from "./note-format";
import { FORMAT_VERSION, splitFrontmatter } from "./note-v2";
import type { TaskRow, TaskWorkbenchSettings } from "./types";

/**
 * Reading notes in the old (v1) format, only so they can be converted to v2.
 * v1: one note per parent with every subtask inside it (`subtask__<key>__*` frontmatter keys,
 * `### title` sections, Meta Bind dashboard callouts and hidden buttons).
 */

/** A v1 parent note: `type: task` without `formatVersion` (v2 notes also carry an `id`). */
export function isLegacyFrontmatter(fm: Record<string, unknown> | null | undefined): boolean {
  if (!fm || fm.type !== "task") return false;
  const version = Number(fm.formatVersion);
  return !(Number.isFinite(version) && version >= FORMAT_VERSION);
}

/** Callout header: `> [!type]`, optional fold marker, optional title. */
const CALLOUT_HEADER = /^>\s*\[![^\]\s]+\][+-]?\s*(.*)$/;
/** Titles of the callouts the plugin generated itself (`ダッシュボード`; `(サブ)タスクダッシュボード` / `(サブ)タスク情報` from older versions). */
const DASHBOARD_TITLE = /^(?:(?:サブ|親)?タスク(?:ダッシュボード|情報)|ダッシュボード|Dashboard)\s*$/i;
/** A Meta Bind field line: only a bold/plain label and `INPUT[...]` / `VIEW[...]` inline code, nothing else. */
const FIELD_LINE = /^(?:\*\*[^*]*\*\*|[^`]*?)\s*[:：]?\s*(?:`(?:INPUT|VIEW)\[[^`]*\]`\s*)+$/;

const isFieldLine = (line: string): boolean => FIELD_LINE.test(line.trim());
/** Outside a callout only the plugin's own shape (bold label or none) counts, so ordinary text with inline code stays. */
const isBareFieldLine = (line: string): boolean => isFieldLine(line) && /^(?:\*\*[^*]*\*\*\s*[:：]?\s*)?`/.test(line.trim());

/** True for a callout the plugin generated: a known header, or nothing but Meta Bind field lines. */
function isDashboardCallout(block: string[]): boolean {
  if (DASHBOARD_TITLE.test(CALLOUT_HEADER.exec(block[0])?.[1].trim() ?? "")) return true;
  const content = block.slice(1).map((line) => line.replace(/^>\s?/, "").trim()).filter(Boolean);
  return content.length > 0 && content.every(isFieldLine);
}

/** Body without the Meta Bind dashboard callouts, field lines and the hidden `meta-bind-button` blocks. */
export function cleanLegacyBody(body: string): string {
  const lines = body.split("\n"), out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^```meta-bind-button\s*$/.test(lines[i])) {
      while (i + 1 < lines.length && !/^```\s*$/.test(lines[i + 1])) i += 1;
      i += 1;
    } else if (CALLOUT_HEADER.test(lines[i])) {
      let end = i;
      while (end + 1 < lines.length && lines[end + 1].startsWith(">")) end += 1;
      if (isDashboardCallout(lines.slice(i, end + 1))) i = end;
      else out.push(...lines.slice(i, end + 1)), i = end;
    } else if (/`(?:INPUT|VIEW)\[/.test(lines[i]) && isBareFieldLine(lines[i])) {
      continue;
    } else out.push(lines[i]);
  }
  return out.join("\n");
}

interface Segment { heading: string | null; lines: string[] }

/** Splits at heading lines matching `pattern`; the first segment holds the text before any heading. */
function segments(text: string, pattern: RegExp): Segment[] {
  const result: Segment[] = [{ heading: null, lines: [] }];
  for (const line of text.split("\n")) {
    if (pattern.test(line)) result.push({ heading: line, lines: [] });
    else result[result.length - 1].lines.push(line);
  }
  return result;
}

const blockOf = (segment: Segment): string => [segment.heading, ...segment.lines].filter((line) => line !== null).join("\n").trim();
const textOf = (lines: string[]): string => lines.join("\n").trim();

/** Frontmatter keys v1 wrote itself (a `subtask__*` key is one too). Everything else is the user's. */
const V1_KEYS = new Set([
  "type", "cssclass", "statusLabel", "createdAt", "updatedAt", "dueDate", "priority", "priorityMode", "tags",
  "completed", "displayName", "ganttEnabled", "ganttOrder", "subtaskOrder",
]);
/** Keys v2 writes; a user key of the same name cannot be kept next to them. */
const V2_KEYS = new Set([
  "type", "formatVersion", "id", "title", "parent", "status", "completed", "created", "updated", "start", "end", "due",
  "priority", "priorityMode", "tags", "gantt", "dependsOn", "plan", "actual", "markers", "cssclasses",
]);

export interface LegacyParent {
  /** The v1 data (ids are v1 ids: the parent's path / `path::key`). Subtasks are in section order. */
  row: TaskRow;
  /** Text before the first heading and under dropped/unused headings: kept above `## 現状`. */
  prelude: string;
  /** Sections the plugin does not know (whole, with their headings): kept after `## メモ`. */
  sections: string;
  /** Text of each subtask section that is neither 現状 nor メモ, by the subtask's key. */
  subtaskExtras: Map<string, string>;
  /** User frontmatter lines (whole `key: value` groups), verbatim. */
  unknownFrontmatter: string;
  warnings: string[];
}

/** User frontmatter groups (a key line and its continuation lines), minus the v1 and v2 keys. */
function userFrontmatter(front: string, warnings: string[]): string {
  const lines = front.replace(/\r\n/g, "\n").split("\n");
  const inner = lines.slice(1, lines.lastIndexOf("---") > 0 ? lines.lastIndexOf("---") : lines.length);
  const groups: { key: string; lines: string[] }[] = [];
  for (const line of inner) {
    const match = /^([^\s#:-][^:]*):/.exec(line) ?? /^(-[^\s:][^:]*):/.exec(line);
    if (match) groups.push({ key: match[1].trim(), lines: [line] });
    else if (groups.length) groups[groups.length - 1].lines.push(line);
  }
  const kept: string[] = [];
  for (const group of groups) {
    if (V1_KEYS.has(group.key) || group.key.startsWith("subtask__")) continue;
    if (V2_KEYS.has(group.key)) { warnings.push(`フロントマターのキー「${group.key}」は v2 で使うため、値を置き換えました`); continue; }
    kept.push(...group.lines);
  }
  return kept.join("\n").replace(/\s+$/, "");
}

/** Parses a v1 parent note for conversion. null when it does not parse as a task note. */
export function readLegacyParent(path: string, text: string, settings: TaskWorkbenchSettings): LegacyParent | null {
  const { front, body } = splitFrontmatter(text);
  const cleaned = front + cleanLegacyBody(body);
  const row = parseTaskFile({ path }, cleaned, { ...settings, autoPriorityEnabled: false });
  if (!row || row.kind !== "parent") return null;
  const warnings: string[] = [];
  const preludes: string[] = [], sections: string[] = [];
  const used = new Set<string>();
  let subtasksBody = "";
  let titleDropped = false;
  for (const segment of segments(cleanLegacyBody(body), /^#{1,2}\s+\S/)) {
    const heading = segment.heading;
    if (heading === null) { if (textOf(segment.lines)) preludes.push(textOf(segment.lines)); continue; }
    const h1 = /^#\s+(.+?)\s*$/.exec(heading);
    if (h1) {
      if (!titleDropped && h1[1].trim() === row.displayName.trim()) { titleDropped = true; if (textOf(segment.lines)) preludes.push(textOf(segment.lines)); }
      else sections.push(blockOf(segment));
      continue;
    }
    const known = /^##\s+(Current Status|Notes|Subtasks)\s*$/.exec(heading)?.[1];
    if (known && !used.has(known)) {
      used.add(known);
      if (known === "Subtasks") {
        subtasksBody = extractSection(cleanLegacyBody(body), "Subtasks", 2);
        // Text before the first ### belongs to no subtask.
        const lead = subtasksBody.split("\n").findIndex((line) => /^###\s+/.test(line));
        const before = textOf(lead < 0 ? subtasksBody.split("\n") : subtasksBody.split("\n").slice(0, lead));
        if (before) preludes.push(before);
      }
      continue;
    }
    sections.push(blockOf(segment));
  }

  const subtaskExtras = new Map<string, string>();
  const parts = splitSubtasksSection(subtasksBody);
  const subtasks = [...row.subtasks?.values() ?? []];
  parts.forEach((part, index) => {
    const subtask = subtasks[index];
    if (!subtask?.key) return;
    const extras: string[] = [];
    const seen = new Set<string>();
    for (const segment of segments(part.body, /^####\s+\S/)) {
      if (segment.heading === null) { if (textOf(segment.lines)) extras.push(textOf(segment.lines)); continue; }
      const name = /^####\s+(Current Status|Notes)\s*$/.exec(segment.heading)?.[1];
      if (name && !seen.has(name)) seen.add(name);
      else extras.push(blockOf(segment));
    }
    if (extras.length) subtaskExtras.set(subtask.key, extras.join("\n\n"));
  });

  return {
    row,
    prelude: preludes.join("\n\n"),
    sections: sections.join("\n\n"),
    subtaskExtras,
    unknownFrontmatter: userFrontmatter(front, warnings),
    warnings,
  };
}
