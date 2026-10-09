import { parseYaml } from "obsidian";
import {
  TaskRow,
  TaskWorkbenchSettings,
  GanttMarker,
  WorkloadMap,
  StatusLabel,
} from "./types";
import {
  todayStr,
  normalizePriority,
  normalizeStatusValue,
  applyAutoPriorityFields,
  getSubtaskKey,
} from "./utils";
import { DEFAULT_STATUSES } from "./constants";


// PARSING: Frontmatter and Value Extraction


/**
 *
 * Parse a simple value from frontmatter.
 * Precedence: empty → ""; "true"/"false" → boolean; "[...]" → array;
 * quoted "..." → unescaped string; else raw string.
 */
export function parseSimpleValue(raw: string): unknown {
  if (raw === "") {
    return "";
  }

  // Check for strict boolean values
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }

  // Check for array: must have matching brackets
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (inner === "") {
      return [];
    }
    // Split by comma and trim
    return inner.split(",").map((s) => s.trim());
  }

  // Check for quoted string: "..." with escape handling
  if (raw.startsWith('"') && raw.endsWith('"')) {
    const inner = raw.slice(1, -1);
    // Unescape: \" → "
    return inner.replace(/\\"/g, '"');
  }

  // Return raw string
  return raw;
}


/**
 * Parse legacy CSV tags and YAML tag arrays.
 * Preserve empty slots for compatibility with existing notes.
 * Subtask and marker tags still use the legacy representation.
 */
function parseFrontmatterTags(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((value) => String(value).trim());
  }

  const rawText = raw === undefined || raw === null ? "" : String(raw);
  if (rawText === "") {
    return [];
  }

  const parsed = parseSimpleValue(rawText);
  const values = Array.isArray(parsed) ? parsed : String(parsed).split(",");
  return values.map((value) => String(value).trim());
}


/**
 *
 * Parse YAML-like frontmatter: flat key=value pairs, separated by ---.
 * Parent tags are parsed as YAML; other lines without colons are ignored.
 * Split on FIRST colon only.
 */
export function parseFrontmatter(
  content: string
): Record<string, unknown> {
  const lines = content.split("\n");
  const result: Record<string, unknown> = {};

  let inFrontmatter = false;
  let fmEndIndex = -1;

  // Find frontmatter boundaries
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") {
      if (!inFrontmatter) {
        inFrontmatter = true;
      } else {
        fmEndIndex = i;
        break;
      }
    }
  }

  if (!inFrontmatter || fmEndIndex === -1) {
    return result;
  }

  // Parse lines between --- markers
  for (let i = 1; i < fmEndIndex; i++) {
    const line = lines[i];

    // Ignore lines without colons
    if (!line.includes(":")) {
      continue;
    }

    // Split on FIRST colon only
    const colonIndex = line.indexOf(":");
    const key = line.substring(0, colonIndex).trim();
    const valueRaw = line.substring(colonIndex + 1).trim();

    if (key === "tags") {
      // Parse only parent tags so legacy subtask/marker fields and other
      // frontmatter values retain their existing behavior.
      const tagLines = [`tags: ${valueRaw}`];
      while (i + 1 < fmEndIndex && /^(\s|$|#|-([ \t]|$)|\])/.test(lines[i + 1])) {
        tagLines.push(lines[++i]);
      }
      try {
        const parsed: unknown = parseYaml(tagLines.join("\n"));
        const tags = (parsed as { tags?: unknown })?.tags;
        if (Array.isArray(tags)) {
          result[key] = parseFrontmatterTags(tags);
        } else if (tags == null && valueRaw.startsWith("#")) {
          // Legacy CSV may include leading # characters without YAML quotes.
          result[key] = parseFrontmatterTags(valueRaw);
        } else {
          result[key] = tags == null || tags === ""
            ? []
            : String(tags).split(",").map((tag) => tag.trim());
        }
      } catch {
        // Older bracket-wrapped CSV can contain empty slots invalid in YAML.
        result[key] = parseFrontmatterTags(valueRaw);
      }
      continue;
    }

    // Store other values without parsing.
    result[key] = valueRaw;
  }

  return result;
}










export function parseWorkloadMap(raw: string): WorkloadMap {
  const result: WorkloadMap = {};

  if (!raw || raw === "") {
    return result;
  }

  // Split on comma or semicolon
  const tokens = raw.split(/[,;]/);

  for (const token of tokens) {
    const trimmed = token.trim();
    if (!trimmed) {
      continue;
    }

    // Match regex pattern
    const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})\s*=\s*([0-9]+(?:\.[0-9]+)?)$/);
    if (!match) {
      continue; // Non-matching tokens ignored
    }

    const date = match[1];
    const hoursStr = match[2];

    // Parse hours
    let hours = parseFloat(hoursStr);

    // Check if hours is finite
    if (!isFinite(hours)) {
      continue;
    }

    // Round to 0.5 increments
    hours = Math.round(hours * 2) / 2;

    // Drop if <= 0
    if (hours <= 0) {
      continue;
    }

    // Note: date validity is not checked during parse (lenient)
    result[date] = hours;
  }

  return result;
}

/**
 *
 * Extract section content from markdown.
 * Returns content from heading to next same-or-higher level heading or EOF, trimmed.
 * Returns "" if heading not found.
 */
export function extractSection(
  content: string,
  headingText: string,
  level: number
): string {
  // Escape special regex characters
  const escaped = headingText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Build regex: # at the right level followed by escaped text
  const hashPrefix = "#".repeat(level);
  const regex = new RegExp(
    `^${hashPrefix}\\s+${escaped}\\s*$`,
    "m"
  );

  const startMatch = content.match(regex);
  // index === 0 は「本文先頭の見出し」であって未検出ではない。falsy 判定にしないこと
  if (!startMatch || startMatch.index === undefined) {
    return "";
  }

  // Find the content after this heading
  const afterHeading = content.substring(
    startMatch.index + startMatch[0].length
  );

  // Find next heading at same or higher level (fewer or equal #)
  const nextHeadingRegex = new RegExp(
    `^#{1,${level}}\\s+`,
    "m"
  );

  const nextMatch = afterHeading.match(nextHeadingRegex);
  if (!nextMatch || nextMatch.index === undefined) {
    // No next heading, take rest of content
    return afterHeading.trim();
  }

  // Take content up to next heading
  return afterHeading.substring(0, nextMatch.index).trim();
}

/**
 *
 * Split a section into parts by ### headings.
 * Each part becomes {title: first line, body: rest}.
 * Heading-only parts get body="".
 */
export interface SubtaskSectionPart {
  title: string;
  body: string;
}

export function splitSubtasksSection(body: string): SubtaskSectionPart[] {
  const parts: SubtaskSectionPart[] = [];

  if (!body || body === "") {
    return parts;
  }

  // Split by /^###\s+/m
  const lines = body.split("\n");
  let currentPart: string[] = [];

  for (const line of lines) {
    if (line.match(/^###\s+/)) {
      // Start of new subtitle
      if (currentPart.length > 0) {
        // Save previous part
        const title = currentPart[0].replace(/^###\s+/, "").trim();
        const bodyLines = currentPart.slice(1);
        parts.push({
          title,
          body: bodyLines.join("\n").trim(),
        });
        currentPart = [];
      }
      currentPart.push(line);
    } else if (currentPart.length > 0) {
      // Continuation of current part
      currentPart.push(line);
    }
  }

  // Save last part
  if (currentPart.length > 0) {
    const title = currentPart[0].replace(/^###\s+/, "").trim();
    const bodyLines = currentPart.slice(1);
    parts.push({
      title,
      body: bodyLines.join("\n").trim(),
    });
  }

  return parts;
}


// PARSING: Main Task File Parser


/**
 *
 * Parse a task file into a TaskRow (or null if type !== "task").
 * Lenient: invalid dates, missing fields, etc. do not throw.
 * Parent tasks parse from the file as a whole.
 * Subtasks are extracted from the "Subtasks" section.
 *
 * file: narrower interface for unit-testability (not requiring full TFile)
 */
export function parseTaskFile(
  file: {
    path: string;
    parentPath?: string;
    heading?: string;
  },
  content: string,
  settings: TaskWorkbenchSettings
): TaskRow | null {
  // Parse frontmatter
  const fm = parseFrontmatter(content);

  // Check type field
  const typeRaw = fm["type"];
  const type = parseSimpleValue(String(typeRaw || ""));
  if (type !== "task") {
    return null;
  }

  // Determine kind (parent or subtask based on file structure)
  const kind: "parent" | "subtask" = file.parentPath ? "subtask" : "parent";
  const id = kind === "parent"
    ? file.path
    : `${file.parentPath}::${file.heading || ""}`;

  // Extract displayName: fm.displayName → first # heading → file.basename
  let displayName: string;
  const displayNameRaw = String(fm["displayName"] || "").trim();
  if (displayNameRaw) {
    const parsed = parseSimpleValue(displayNameRaw);
    displayName = String(parsed).trim();
  } else {
    const firstHeading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
    if (firstHeading) {
      displayName = firstHeading;
    } else {
      displayName = file.path.split("/").pop() || "Untitled";
    }
  }

  const title = displayName; // Derived from displayName

  // Extract basic fields
  const statusLabel = normalizeStatusValue(fm["statusLabel"] || "active") as StatusLabel;
  const createdAt = String(fm["createdAt"] || todayStr()).trim();
  const updatedAt = String(fm["updatedAt"] || todayStr()).trim();
  const dueDate = String(fm["dueDate"] || "").trim() || undefined;
  const priorityRaw = fm["priority"];
  const priority = normalizePriority(priorityRaw as string | number | undefined);
  const priorityMode = String(fm["priorityMode"] || "auto").trim() === "manual"
    ? "manual"
    : "auto";
  const completed = parseSimpleValue(String(fm["completed"] || "false")) === true;
  const currentStatus = extractSection(content, "Current Status", 2);
  const notes = extractSection(content, "Notes", 2);

  // Extract tags
  const tags = parseFrontmatterTags(fm["tags"]);

  // Parent-only fields
  const ganttEnabled = parseSimpleValue(String(fm["ganttEnabled"] || "false")) === true;
  const ganttOrderRaw = fm["ganttOrder"];
  let ganttOrder: number | undefined;
  if (kind === "parent") {
    const orderNum = parseFloat(String(ganttOrderRaw || ""));
    ganttOrder = isFinite(orderNum) ? orderNum : 999999;
  }

  // Build parent task row
  const task: TaskRow = {
    kind,
    id,
    key: kind === "subtask" ? file.heading : undefined,
    file: {
      path: file.path,
      parentPath: file.parentPath,
      heading: file.heading,
    } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    title,
    displayName,
    statusLabel,
    completed,
    createdAt,
    updatedAt,
    dueDate,
    priority,
    priorityMode,
    currentStatus,
    notes,
    tags,
    ganttEnabled,
    ganttOrder,
  };

  // Apply auto-priority if enabled
  if (settings.autoPriorityEnabled && task.priorityMode === "auto") {
    applyAutoPriorityFields(task, settings.autoPriorityEnabled);
  }

  // Parse subtasks for parent tasks
  if (kind === "parent") {
    task.subtasks = new Map();

    const subtasksSection = extractSection(content, "Subtasks", 2);
    if (subtasksSection) {
      const subtaskParts = splitSubtasksSection(subtasksSection);
      const subtaskOrder = parseSimpleValue(String(fm["subtaskOrder"] || "")) as unknown;
      const orderArray = Array.isArray(subtaskOrder) ? subtaskOrder : [];
      const usedKeys = new Set<string>();

      for (let i = 0; i < subtaskParts.length; i++) {
        const part = subtaskParts[i];
        let subtaskKey: string;

        // Use subtaskOrder[i] if present and not already used
        if (i < orderArray.length && orderArray[i]) {
          const candidateKey = String(orderArray[i]).trim();
          if (candidateKey && !usedKeys.has(candidateKey)) {
            subtaskKey = candidateKey;
          } else {
            subtaskKey = getSubtaskKey(part.title, usedKeys);
          }
        } else {
          subtaskKey = getSubtaskKey(part.title, usedKeys);
        }

        usedKeys.add(subtaskKey);

        // Build subtask row
        const subtaskId = `${file.path}::${subtaskKey}`;
        const subtaskStatusLabel = normalizeStatusValue(
          fm[`subtask__${subtaskKey}__statusLabel`] || "active"
        ) as StatusLabel;
        const subtaskCreatedAt = String(
          fm[`subtask__${subtaskKey}__createdAt`] || todayStr()
        ).trim();
        const subtaskUpdatedAt = String(
          fm[`subtask__${subtaskKey}__updatedAt`] || todayStr()
        ).trim();
        const subtaskDueDate = String(
          fm[`subtask__${subtaskKey}__dueDate`] || ""
        ).trim() || undefined;
        const subtaskPriorityRaw = fm[`subtask__${subtaskKey}__priority`];
        const subtaskPriority = normalizePriority(subtaskPriorityRaw as string | number | undefined);
        const subtaskPriorityMode =
          String(fm[`subtask__${subtaskKey}__priorityMode`] || "auto").trim() ===
          "manual"
            ? "manual"
            : "auto";
        const subtaskCompleted =
          parseSimpleValue(String(fm[`subtask__${subtaskKey}__completed`] || "false")) ===
          true;
        const subtaskCurrentStatus = extractSection(part.body, "Current Status", 4);
        const subtaskNotes = extractSection(part.body, "Notes", 4);

        // Subtask tags

        const subtaskTags = parseFrontmatterTags(
          fm[`subtask__${subtaskKey}__tags`]
        );

        // Gantt-specific fields for subtasks
        const plannedStartDate = String(
          fm[`subtask__${subtaskKey}__plannedStartDate`] || ""
        ).trim() || undefined;
        const plannedEndDate = String(
          fm[`subtask__${subtaskKey}__plannedEndDate`] || ""
        ).trim() || undefined;

        // Workload maps
        const workloadPlanRaw = fm[`subtask__${subtaskKey}__workloadPlan`];
        const workloadPlanParsed = parseSimpleValue(String(workloadPlanRaw || ""));
        const workloadPlan = parseWorkloadMap(
          String(workloadPlanParsed || "")
        );
        const workloadActualRaw = fm[`subtask__${subtaskKey}__workloadActual`];
        const workloadActualParsed = parseSimpleValue(String(workloadActualRaw || ""));
        const workloadActual = parseWorkloadMap(
          String(workloadActualParsed || "")
        );

        // Gantt markers
        const markerOrderRaw = fm[`subtask__${subtaskKey}__ganttMarkerOrder`];
        const markerOrder = (parseSimpleValue(String(markerOrderRaw || "")) as unknown[]) || [];
        const ganttMarkers: GanttMarker[] = [];
        const usedMarkerKeys = new Set<string>();

        for (const markerKey of markerOrder) {
          const markerKeyStr = String(markerKey).trim();
          if (!markerKeyStr || usedMarkerKeys.has(markerKeyStr)) {
            continue;
          }

          const markerTitle = String(
            parseSimpleValue(
              String(fm[
                `subtask__${subtaskKey}__ganttMarker__${markerKeyStr}__title`
              ] || "")
            )
          ).trim();
          const markerDate = String(
            fm[`subtask__${subtaskKey}__ganttMarker__${markerKeyStr}__date`] ||
            ""
          ).trim();

          // Drop markers with missing/empty date during parse
          if (!markerDate) {
            continue;
          }


          const markerTags = parseFrontmatterTags(
            fm[
              `subtask__${subtaskKey}__ganttMarker__${markerKeyStr}__tags`
            ]
          );

          ganttMarkers.push({
            key: markerKeyStr,
            title: markerTitle,
            date: markerDate,
            tags: markerTags.length > 0 ? markerTags : undefined,
          });

          usedMarkerKeys.add(markerKeyStr);
        }

        const subtask: TaskRow = {
          kind: "subtask",
          id: subtaskId,
          key: subtaskKey,
          file: {
            path: file.path,
            parentPath: file.path,
            heading: part.title,
          } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
          title: part.title,
          displayName: part.title,
          statusLabel: subtaskStatusLabel,
          completed: subtaskCompleted,
          createdAt: subtaskCreatedAt,
          updatedAt: subtaskUpdatedAt,
          dueDate: subtaskDueDate,
          priority: subtaskPriority,
          priorityMode: subtaskPriorityMode,
          currentStatus: subtaskCurrentStatus,
          notes: subtaskNotes,
          tags: subtaskTags,
          ganttEnabled: false, // Subtasks don't have ganttEnabled
          plannedStartDate,
          plannedEndDate,
          workloadPlan: Object.keys(workloadPlan).length > 0 ? workloadPlan : undefined,
          workloadActual: Object.keys(workloadActual).length > 0 ? workloadActual : undefined,
          ganttMarkers: ganttMarkers.length > 0 ? ganttMarkers : undefined,
        };

        // Apply auto-priority to subtask if enabled
        if (settings.autoPriorityEnabled && subtask.priorityMode === "auto") {
          applyAutoPriorityFields(subtask, settings.autoPriorityEnabled);
        }

        task.subtasks!.set(subtaskKey, subtask);
      }
    }
  }

  return task;
}


// SERIALIZATION: Frontmatter and Value Formatting


/**
 *
 * Escape quotes for YAML: " → \"
 */
export function yamlEscape(value: unknown): string {
  const str = String(value || "");
  return str.replace(/"/g, '\\"');
}

/**
 *
 * Build frontmatter for a task, including parent fields and prefixed subtask/marker fields.
 * subtaskMap: Map<subtaskKey, TaskRow>
 */
export function buildFrontmatter(
  task: TaskRow,
  subtaskMap?: Map<string, TaskRow>
): string {
  const lines: string[] = [];

  lines.push("---");

  // Parent fields
  lines.push('type: task');
  lines.push('cssclass: task');
  lines.push(`statusLabel: ${task.statusLabel}`);
  lines.push(`createdAt: ${task.createdAt}`);
  lines.push(`updatedAt: ${task.updatedAt}`);
  lines.push(`dueDate: ${task.dueDate || ""}`);
  lines.push(`priority: ${task.priority}`);
  lines.push(`priorityMode: ${task.priorityMode}`);
  lines.push(`tags: ${JSON.stringify(task.tags || [])}`);
  lines.push(`completed: ${task.completed ? "true" : "false"}`);
  lines.push(`displayName: "${yamlEscape(task.displayName)}"`);
  lines.push(`ganttEnabled: ${task.ganttEnabled ? "true" : "false"}`);
  lines.push(`ganttOrder: ${task.ganttOrder || 0}`);

  // Subtask order
  const subtaskKeys = subtaskMap ? Array.from(subtaskMap.keys()) : [];
  lines.push(`subtaskOrder: [${subtaskKeys.join(", ")}]`);

  // Subtask and marker fields
  if (subtaskMap) {
    for (const [subtaskKey, subtask] of subtaskMap) {
      lines.push(`subtask__${subtaskKey}__title: "${yamlEscape(subtask.displayName)}"`);
      lines.push(`subtask__${subtaskKey}__statusLabel: ${subtask.statusLabel}`);
      lines.push(`subtask__${subtaskKey}__createdAt: ${subtask.createdAt}`);
      lines.push(`subtask__${subtaskKey}__updatedAt: ${subtask.updatedAt}`);
      lines.push(`subtask__${subtaskKey}__dueDate: ${subtask.dueDate || ""}`);
      lines.push(
        `subtask__${subtaskKey}__plannedStartDate: ${
          subtask.plannedStartDate || ""
        }`
      );
      lines.push(
        `subtask__${subtaskKey}__plannedEndDate: ${subtask.plannedEndDate || ""}`
      );

      // Workload maps (quoted strings)
      const workloadPlanSerialized = serializeWorkloadMap(subtask.workloadPlan || {});
      lines.push(
        `subtask__${subtaskKey}__workloadPlan: "${yamlEscape(workloadPlanSerialized)}"`
      );
      const workloadActualSerialized = serializeWorkloadMap(subtask.workloadActual || {});
      lines.push(
        `subtask__${subtaskKey}__workloadActual: "${yamlEscape(workloadActualSerialized)}"`
      );

      lines.push(`subtask__${subtaskKey}__priority: ${subtask.priority}`);
      lines.push(`subtask__${subtaskKey}__priorityMode: ${subtask.priorityMode}`);
      lines.push(
        `subtask__${subtaskKey}__tags: ${
          subtask.tags && subtask.tags.length > 0
            ? subtask.tags.join(",")
            : ""
        }`
      );
      lines.push(`subtask__${subtaskKey}__completed: ${subtask.completed ? "true" : "false"}`);

      // Gantt markers
      const markerKeys = subtask.ganttMarkers
        ? subtask.ganttMarkers.map((m) => m.key)
        : [];
      lines.push(
        `subtask__${subtaskKey}__ganttMarkerOrder: [${markerKeys.join(", ")}]`
      );

      if (subtask.ganttMarkers) {
        for (const marker of subtask.ganttMarkers) {
          lines.push(
            `subtask__${subtaskKey}__ganttMarker__${marker.key}__title: "${yamlEscape(marker.title)}"`
          );
          lines.push(
            `subtask__${subtaskKey}__ganttMarker__${marker.key}__date: ${marker.date}`
          );
          lines.push(
            `subtask__${subtaskKey}__ganttMarker__${marker.key}__tags: ${
              marker.tags && marker.tags.length > 0
                ? marker.tags.join(",")
                : ""
            }`
          );
        }
      }
    }
  }

  lines.push("---");

  return lines.join("\n");
}

/**
 * Build inline select options for status labels from DEFAULT_STATUSES.
 * Returns: "inlineSelect(option(active, 未着手), option(in_progress, 進行中),...)"
 */
function buildStatusSelectOptions(): string {
  const options = Object.entries(DEFAULT_STATUSES)
    .map(([key, label]) => `option(${key}, ${label})`)
    .join(", ");
  return `inlineSelect(${options})`;
}

/**
 *
 * Build body content for a task file.
 * Includes: heading, dashboard blocks, status/notes sections, subtasks.
 *
 * NOTE: 実際の Obsidian で meta-bind の記法が正しく動作するか確認する。
 */
export function buildBody(
  task: TaskRow,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _subtaskMap?: Map<string, TaskRow>
): string {
  const lines: string[] = [];

  // Heading
  lines.push(`# ${task.displayName}`);
  lines.push("");

  // Dashboard callout block (parent) - using inline meta-bind syntax
  lines.push("> [!note] ダッシュボード");
  lines.push("> ");
  lines.push(`> **表示名**: \`INPUT[text:displayName]\``);
  lines.push("> ");
  lines.push(`> **ステータス**: \`INPUT[${buildStatusSelectOptions()}:statusLabel]\``);
  lines.push("> ");
  lines.push(`> **期限**: \`INPUT[datePicker:dueDate]\``);
  lines.push("> ");
  lines.push(`> **優先度**: \`INPUT[number:priority]\``);
  lines.push("> ");
  lines.push(`> **優先度モード**: \`INPUT[inlineSelect(option(auto, 自動), option(manual, 手動)):priorityMode]\``);
  lines.push("> ");
  lines.push(`> **完了**: \`INPUT[toggle:completed]\``);
  lines.push("> ");
  lines.push(`> **タグ**: \`INPUT[list:tags]\``);
  lines.push("> ");
  lines.push(`> **作成日**: \`VIEW[{createdAt}]\``);
  lines.push("> ");
  lines.push(`> **更新日**: \`VIEW[{updatedAt}]\``);
  lines.push("");

  lines.push(...buildHiddenButtonBlocks());

  lines.push("## Current Status");
  if (task.currentStatus) {
    lines.push(task.currentStatus);
  }
  lines.push("");

  lines.push("## Notes");
  if (task.notes) {
    lines.push(task.notes);
  }
  lines.push("");

  // Subtasks section
  if (task.subtasks && task.subtasks.size > 0) {
    lines.push("## Subtasks");
    lines.push("");

    for (const subtask of task.subtasks.values()) {
      lines.push(`### ${subtask.displayName || subtask.title}`);
      lines.push("");

      // Subtask dashboard callout - using inline meta-bind syntax
      const key = subtask.key || "";
      lines.push("> [!note] ダッシュボード");
      lines.push("> ");
      lines.push(`> **ステータス**: \`INPUT[${buildStatusSelectOptions()}:subtask__${key}__statusLabel]\``);
      lines.push("> ");
      lines.push(`> **期限**: \`INPUT[datePicker:subtask__${key}__dueDate]\``);
      lines.push("> ");
      lines.push(`> **計画開始日**: \`INPUT[datePicker:subtask__${key}__plannedStartDate]\``);
      lines.push("> ");
      lines.push(`> **計画終了日**: \`INPUT[datePicker:subtask__${key}__plannedEndDate]\``);
      lines.push("> ");
      lines.push(`> **優先度**: \`INPUT[number:subtask__${key}__priority]\``);
      lines.push("> ");
      lines.push(`> **優先度モード**: \`INPUT[inlineSelect(option(auto, 自動), option(manual, 手動)):subtask__${key}__priorityMode]\``);
      lines.push("> ");
      lines.push(`> **完了**: \`INPUT[toggle:subtask__${key}__completed]\``);
      lines.push("> ");
      lines.push(`> **タグ**: \`INPUT[list:subtask__${key}__tags]\``);
      lines.push("> ");
      lines.push(`> **作成日**: \`VIEW[{subtask__${key}__createdAt}]\``);
      lines.push("> ");
      lines.push(`> **更新日**: \`VIEW[{subtask__${key}__updatedAt}]\``);
      lines.push("");

      lines.push("#### Current Status");
      if (subtask.currentStatus) {
        lines.push(subtask.currentStatus);
      }
      lines.push("");

      lines.push("#### Notes");
      if (subtask.notes) {
        lines.push(subtask.notes);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

/**
 * 非表示 BUTTON ブロック（open-board / add-subtask / open-finder）。
 * 見出しの前（ダッシュボード直後）に置く。末尾に置くと最後のサブタスクの
 * `#### Notes` セクションに食い込み、extractSection がボタン定義を本文として拾ってしまう。
 * NOTE: 実際の Obsidian で meta-bind-button の記法が正しく動作するか確認する。
 */
function buildHiddenButtonBlocks(): string[] {
  const commands = ["open-board", "add-subtask", "open-finder"];
  const lines: string[] = [];

  for (const command of commands) {
    lines.push("```meta-bind-button");
    lines.push(`id: ${command}`);
    lines.push(`label: ${command}`);
    lines.push("hidden: true");
    lines.push("actions:");
    lines.push("  - type: command");
    lines.push(`    command: ${command}`);
    lines.push("```");
    lines.push("");
  }

  return lines;
}

/**
 *
 * Build complete note: frontmatter + blank line + body
 */
export function buildFullNote(
  task: TaskRow,
  subtaskMap?: Map<string, TaskRow>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _settings?: TaskWorkbenchSettings
): string {
  const frontmatter = buildFrontmatter(task, subtaskMap);
  const body = buildBody(task, subtaskMap);

  return `${frontmatter}\n\n${body}`;
}






export function serializeWorkloadMap(map: WorkloadMap): string {
  if (!map || Object.keys(map).length === 0) {
    return "";
  }

  const entries: string[] = [];
  for (const [date, hours] of Object.entries(map)) {
    entries.push(`${date}=${hours}`);
  }

  return entries.join(", ");
}
