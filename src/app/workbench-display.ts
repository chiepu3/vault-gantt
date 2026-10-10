import type { Moment } from "moment";
import type { TaskRow } from "../core/types";
import { compareBy, dueBucket, getStatusLabel } from "../core/utils";




























/**
 *
 * Collapse metadata attached to parent rows by getCollapsedWorkbenchRows.
 * The View renders the fold toggle aria-labels and the "他N件"
 * summary span from these numbers.
 * Invariant: hiddenCount = total - visibleCount always holds, and `total`
 * counts only children that survived upstream filtering.
 */
export interface WorkbenchCollapseInfo {
  expanded: boolean;
  total: number;
  visibleCount: number;
  hiddenCount: number;
}













export type WorkbenchDisplayRow = TaskRow & {
  __twbCollapseInfo?: WorkbenchCollapseInfo;
  __twbCollapsedPreview?: boolean;
};

/** Options for getDisplayRows — mirrors the View's header control state. */
export interface DisplayRowsOptions {
  filterText: string;
  statusFilter: string;
  showCompleted: boolean;
  sortKey: string;
  sortDir: "asc" | "desc";
  flatDueSort: boolean;
  /** Optional render-pass date anchor shared by all due-date comparisons. */
  today?: Moment;
}



















































export function getDisplayRows(
  tasks: TaskRow[],
  opts: DisplayRowsOptions
): TaskRow[] {
  // the input is the plugin's task list — parent rows holding
  // their subtasks Maps (loadTasks shape).

  // parent's displayName (falls back to title, mirroring the View's own
  // parentDisplayName in task-workbench-view.ts) — flat due-sort mode
  // adds this as a 7th searched field for child rows.
  const flat: TaskRow[] = [];
  const parentDisplayNameByChildId = new Map<string, string>();
  for (const task of tasks) {
    flat.push(task);
    if (task.subtasks) {
      const ownerLabel = task.displayName || task.title;
      for (const subtask of task.subtasks.values()) {
        flat.push(subtask);
        parentDisplayNameByChildId.set(subtask.id, ownerLabel);
      }
    }
  }

  const needle = opts.filterText.toLowerCase();

  const filtered = flat.filter((row) => {
    // completed rows are hidden unless showCompleted is on.
    if (!opts.showCompleted && row.completed === true) {
      return false;
    }

    // "all" passes everything; otherwise the filter value must exactly
    // match a StatusLabel key from the dropdown.
    if (opts.statusFilter !== "all" && row.statusLabel !== opts.statusFilter) {
      return false;
    }


    // The full filter string must occur in a single field: there is no
    // per-word tokenization or cross-field concatenation. Search-field
    // matching is centralized in matchesSearchFields.
    if (needle !== "") {
      const parentDisplayName = opts.flatDueSort
        ? parentDisplayNameByChildId.get(row.id)
        : undefined;
      if (!matchesSearchFields(row, needle, parentDisplayName)) {
        return false;
      }
    }

    return true;
  });


  // In grouped mode, restore a parent that failed the filter when at least
  // one child survives. The parent remains available as a grouping anchor
  // instead of sending the child through the orphan-row fallback. This only
  // widens which rows can be recognized as parents; the grouping logic itself
  // remains unchanged.
  if (!opts.flatDueSort) {
    const survivingIds = new Set(filtered.map((row) => row.id));
    for (const task of tasks) {
      if (
        task.kind !== "parent" ||
        !task.subtasks ||
        survivingIds.has(task.id)
      ) {
        continue;
      }
      let hasSurvivingChild = false;
      for (const child of task.subtasks.values()) {
        if (survivingIds.has(child.id)) {
          hasSurvivingChild = true;
          break;
        }
      }
      if (hasSurvivingChild) {
        filtered.push(task);
        survivingIds.add(task.id);
      }
    }
  }


  // Sorting uses compareBy from src/core/utils.ts. This function only
  // selects the sort key for flat due-date mode, so parents and subtasks
  // interleave by due date when that option is enabled. Grouping and nesting
  // remain downstream: getCollapsedWorkbenchRows returns early in flat mode,
  // and the View renders flat-mode decorations instead of nested rows.
  const effectiveSortKey = opts.flatDueSort ? "dueDate" : opts.sortKey;

  // compareBy reverses the updatedAt/createdAt comparison, so its "asc"
  // direction yields newest-first. Invert only these keys here to preserve
  // the Workbench convention that "desc" means newest-first; other keys keep
  // compareBy's normal direction.

  const invertForRecencyKey =
    effectiveSortKey === "updatedAt" || effectiveSortKey === "createdAt";
  const effectiveSortDir = invertForRecencyKey
    ? opts.sortDir === "desc"
      ? "asc"
      : "desc"
    : opts.sortDir;

  // Date classification belongs to this sort pass, not to each comparison.
  // Keep it local so edits and a new day's render cannot reuse old buckets.
  let dueBuckets: Map<string | undefined, number> | undefined;
  if (!effectiveSortKey || effectiveSortKey === "default" || effectiveSortKey === "dueDate") {
    dueBuckets = new Map();
    for (const row of filtered) {
      if (!dueBuckets.has(row.dueDate)) {
        dueBuckets.set(row.dueDate, dueBucket(row.dueDate, opts.today));
      }
    }
  }

  filtered.sort((a, b) =>
    compareBy(effectiveSortKey, effectiveSortDir, a, b, opts.today, dueBuckets)
  );

  return filtered;
}












function matchesSearchFields(
  row: TaskRow,
  needle: string,
  parentDisplayName?: string
): boolean {
  const fields: Array<string | undefined> = [
    row.displayName,
    row.title,
    // getStatusLabel(statusLabel) — the display label, not
    // the raw status code — is what's searched here.
    getStatusLabel(row.statusLabel),
    row.currentStatus,
    row.notes,
    (row.tags ?? []).join(" "),
    row.file?.path,
  ];
  if (parentDisplayName !== undefined) {
    fields.push(parentDisplayName);
  }
  return fields.some((field) => (field ?? "").toLowerCase().includes(needle));
}













export function getCollapsedWorkbenchRows(
  displayRows: TaskRow[],
  flatDueSort: boolean,
  collapsedParentIds: Set<string>
): WorkbenchDisplayRow[] {
  // flat due-sort mode skips the
  // collapse processing entirely; rows pass through unchanged (no
  // decorations, no preview computation).
  if (flatDueSort) {
    return displayRows;
  }

  const presentIds = new Set(displayRows.map((row) => row.id));

  // detect parents from the display rows, then map each of
  // their surviving subtasks back to its owner.
  const parentByChildId = new Map<string, TaskRow>();
  for (const row of displayRows) {
    if (row.kind !== "parent" || !row.subtasks) {
      continue;
    }
    for (const child of row.subtasks.values()) {
      if (presentIds.has(child.id)) {
        parentByChildId.set(child.id, row);
      }
      // Children filtered out upstream are deliberately not registered —
      // grouping operates on the post-filter row set only.
    }
  }

  // parentId → surviving children in displayRows order, so children keep
  // the user-selected sort order underneath their parent.
  const childrenByParentId = new Map<string, TaskRow[]>();
  for (const row of displayRows) {
    const parent = parentByChildId.get(row.id);
    if (!parent) {
      continue;
    }
    const siblings = childrenByParentId.get(parent.id);
    if (siblings) {
      siblings.push(row);
    } else {
      childrenByParentId.set(parent.id, [row]);
    }
  }

  const result: WorkbenchDisplayRow[] = [];

  for (const row of displayRows) {
    // Owned subtasks are emitted directly below their parent, not
    // at their physical sort position.
    if (parentByChildId.has(row.id)) {
      continue;
    }

    if (row.kind === "parent") {
      const children = childrenByParentId.get(row.id) ?? [];
      // Set membership means collapsed; absence means expanded.
      const expanded = !collapsedParentIds.has(row.id);

      let visibleChildren: TaskRow[];
      if (expanded) {
        // expanded parents show all surviving children.
        visibleChildren = children;
      } else {
        // collapsed parents show the single preview
        // child picked from the surviving set.
        // with no eligible preview, no child row is emitted at
        // all — the parent stands alone (the View then shows only the
        // "他N件" summary).
        const preview = pickWorkbenchPreviewSubtask(children);
        visibleChildren = preview === null ? [] : [preview];
      }

      const total = children.length;
      const visibleCount = visibleChildren.length;
      // attach collapse info to every present parent row.
      // `total` counts surviving children only, keeping the identity
      // hiddenCount = total - visibleCount exact; these numbers drive the
      // View's "他N件" span and toggle aria-labels.
      result.push({
        ...row,
        __twbCollapseInfo: {
          expanded,
          total,
          visibleCount,
          hiddenCount: total - visibleCount,
        },
      });

      for (const child of visibleChildren) {
        // the collapsed preview row is flagged
        // true, ordinary expanded children false. The View maps the flag to
        // the twb-collapsed-preview-row class.
        result.push({
          ...child,
          __twbCollapsedPreview: !expanded,
        });
      }
      continue;
    }


    // displayRows falls back to being emitted as-is at its sorted position.
    // Since getDisplayRows now restores any parent that has at least one

    // fallback path is reached ONLY for the genuinely abnormal case where
    // the parent doesn't exist at all — e.g. the parent file was deleted so
    // the child was never registered under any parent's subtasks Map — not
    // the ordinary "parent filtered out by search/status/completed" case
    // anymore (that case is now grouped normally, upstream).
    result.push(row);
  }

  return result;
}

/**
 *
 * Chooses the representative child shown for a collapsed parent: the
 * incomplete child with the nearest due date, breaking ties by oldest
 * creation date, then by display name.
 */
export function pickWorkbenchPreviewSubtask(
  children: TaskRow[]
): TaskRow | null {
  const compare = (a: TaskRow, b: TaskRow): number => {
    // effective date = dueDate || plannedEndDate, ascending.
    // Empty string and undefined both mean "no date" — the codebase-wide
    // convention (dueDaysFromToday in src/core/utils.ts treats "" and
    // undefined identically, and note-format.ts serializes an absent
    // dueDate as the literal "") — so an empty-string dueDate falls
    // through to plannedEndDate, and rows without either date sort last.
    // YYYY-MM-DD strings compare chronologically under string comparison.
    const dateA = a.dueDate || a.plannedEndDate || "";
    const dateB = b.dueDate || b.plannedEndDate || "";
    if (dateA !== dateB) {
      if (dateA === "") {
        return 1;
      }
      if (dateB === "") {
        return -1;
      }
      return dateA.localeCompare(dateB);
    }

    // older createdAt first.
    if (a.createdAt !== b.createdAt) {
      return a.createdAt.localeCompare(b.createdAt);
    }

    // locale-aware displayName ascending.
    return a.displayName.localeCompare(b.displayName);
  };

  // Only the minimum is needed. Strictly smaller keeps the first child on
  // exact ties, matching the previous stable sort without allocating/sorting.
  let preview: TaskRow | null = null;
  for (const child of children) {
    if (child.completed === false && (preview === null || compare(child, preview) < 0)) {
      preview = child;
    }
  }
  return preview;
}

/**
 *
 * Normalizes a stored priorityMode value: only the exact string "manual" is
 * accepted; anything else ("", undefined, misspellings, wrong types)
 * defaults to "auto".
 */
export function normalizePriorityMode(value: unknown): "auto" | "manual" {
  return value === "manual" ? "manual" : "auto";
}
















export function parseTagsInput(input: string): string[] {
  return input.split(",").map((element) => element.trim());
}
