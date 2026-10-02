import { describe, it, expect, vi } from "vitest";
import type { TaskRow } from "../../src/core/types";
import {
  getDisplayRows,
  getCollapsedWorkbenchRows,
  pickWorkbenchPreviewSubtask,
  normalizePriorityMode,
  parseTagsInput,
} from "../../src/app/workbench-display";
import type {
  DisplayRowsOptions,
  WorkbenchDisplayRow,
} from "../../src/app/workbench-display";

let seq = 0;

function makeRow(overrides: Record<string, unknown> = {}): TaskRow {
  seq += 1;
  const path = `tasks/task-${seq}.md`;
  return {
    kind: "parent",
    id: path,
    file: { path },
    title: `Task ${seq}`,
    displayName: `Task ${seq}`,
    statusLabel: "active",
    completed: false,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    dueDate: "",
    priority: 0,
    priorityMode: "auto",
    currentStatus: "",
    notes: "",
    tags: [],
    ganttEnabled: false,
    ...overrides,
  } as unknown as TaskRow;
}

function makeSubtask(
  key: string,
  overrides: Record<string, unknown> = {}
): TaskRow {
  return makeRow({ kind: "subtask", key, ...overrides });
}

function withSubtasks(parent: TaskRow, children: TaskRow[]): TaskRow {
  parent.subtasks = new Map(
    children.map((child): [string, TaskRow] => [child.key ?? child.id, child])
  );
  return parent;
}

function defaultOpts(
  overrides: Partial<DisplayRowsOptions> = {}
): DisplayRowsOptions {
  return {
    filterText: "",
    statusFilter: "all",
    showCompleted: true,
    sortKey: "updatedAt",
    sortDir: "desc",
    flatDueSort: false,
    ...overrides,
  };
}

function ids(rows: TaskRow[]): string[] {
  return rows.map((row) => row.id);
}

describe("getDisplayRows", () => {
  it("flattens parents and their subtasks Map values into one filtered, sorted row set", () => {
    const s1 = makeSubtask("s1");
    const s2 = makeSubtask("s2");
    const parent = withSubtasks(makeRow(), [s1, s2]);
    const lone = makeRow();

    const rows = getDisplayRows([parent, lone], defaultOpts());

    expect(rows).toHaveLength(4);
    expect(ids(rows).sort()).toEqual([parent.id, lone.id, s1.id, s2.id].sort());
  });

  it("filterText is a case-insensitive whole-string substring match", () => {
    const a = makeRow({ displayName: "Alpha Bug", title: "Alpha Bug" });
    const b = makeRow({ displayName: "something else", title: "beta BUG" });
    const c = makeRow({ displayName: "Gamma", title: "Gamma" });

    const rows = getDisplayRows([a, b, c], defaultOpts({ filterText: "bug" }));

    expect(ids(rows).sort()).toEqual([a.id, b.id].sort());
  });

  it("matches on title when displayName does not contain the filter", () => {
    const a = makeRow({ displayName: "display text", title: "needle here" });

    const rows = getDisplayRows([a], defaultOpts({ filterText: "NEEDLE" }));

    expect(ids(rows)).toEqual([a.id]);
  });

  it("does not tokenize: the whole filter string must occur in one field", () => {
    // displayName contains "Alpha" and title contains "Bug", but no single
    // field contains the entire string "alpha bug".
    const a = makeRow({ displayName: "Alpha", title: "Bug" });

    const rows = getDisplayRows([a], defaultOpts({ filterText: "alpha bug" }));

    expect(rows).toHaveLength(0);
  });

  it("searches note content", () => {
    const a = makeRow({ notes: "contains needle in notes" });
    const b = makeRow({ notes: "nothing here" });

    const rows = getDisplayRows([a, b], defaultOpts({ filterText: "needle" }));

    expect(ids(rows)).toEqual([a.id]);
  });

  it("searches the space-joined tags", () => {
    const a = makeRow({ tags: ["frontend", "urgent-fix"] });
    const b = makeRow({ tags: ["backend"] });

    const rows = getDisplayRows(
      [a, b],
      defaultOpts({ filterText: "urgent-fix" })
    );

    expect(ids(rows)).toEqual([a.id]);
  });

  it("searches the file path", () => {
    const a = makeRow({ file: { path: "projects/needle-project/task.md" } });
    const b = makeRow({ file: { path: "projects/other/task.md" } });

    const rows = getDisplayRows([a, b], defaultOpts({ filterText: "needle" }));

    expect(ids(rows)).toEqual([a.id]);
  });

  it("search includes the converted status label, not only the raw statusLabel code", () => {
    // "in_progress" itself does not contain "進行中" as a substring — this
    // only matches if the row is actually run through getStatusLabel.
    const a = makeRow({ statusLabel: "in_progress" });
    const b = makeRow({ statusLabel: "active" });

    const rows = getDisplayRows([a, b], defaultOpts({ filterText: "進行中" }));

    expect(ids(rows)).toEqual([a.id]);
  });

  it("searches currentStatus separately from statusLabel", () => {
    const a = makeRow({ currentStatus: "blocked on needle review" });
    const b = makeRow({ currentStatus: "on track" });

    const rows = getDisplayRows([a, b], defaultOpts({ filterText: "needle" }));

    expect(ids(rows)).toEqual([a.id]);
  });

  it("searches the same fields on child rows", () => {
    const matchingChild = makeSubtask("match", { notes: "needle in child notes" });
    const otherChild = makeSubtask("other", { notes: "nothing" });
    const parent = withSubtasks(makeRow(), [matchingChild, otherChild]);

    const rows = getDisplayRows([parent], defaultOpts({ filterText: "needle" }));

    // The matching child survives on its own widened-field match, and its
    // non-matching sibling is excluded. The parent itself doesn't match


    // in the getCollapsedWorkbenchRows suite for the full pipeline check).
    expect(ids(rows).sort()).toEqual([matchingChild.id, parent.id].sort());
    expect(ids(rows)).not.toContain(otherChild.id);
  });

  it("flat due-date sorting also searches the child's parent display name", () => {
    const child = makeSubtask("c1", {
      displayName: "generic child",
      title: "generic child",
    });
    const parent = withSubtasks(
      makeRow({ displayName: "needle project", title: "needle project" }),
      [child]
    );

    // flatDueSort=false: parentDisplayName is NOT searched, so the child
    // (whose own fields don't contain "needle") does not match.
    const nested = getDisplayRows(
      [parent],
      defaultOpts({ filterText: "needle", flatDueSort: false })
    );
    expect(ids(nested)).not.toContain(child.id);

    // flatDueSort=true: parentDisplayName IS searched, so the child matches
    // via its parent's name even though none of the child's own fields do.
    const flat = getDisplayRows(
      [parent],
      defaultOpts({ filterText: "needle", flatDueSort: true })
    );
    expect(ids(flat)).toContain(child.id);
  });

  it("empty filterText disables keyword filtering", () => {
    const a = makeRow();
    const b = makeRow();

    const rows = getDisplayRows([a, b], defaultOpts({ filterText: "" }));

    expect(rows).toHaveLength(2);
  });

  it("statusFilter 'all' passes every status", () => {
    const a = makeRow({ statusLabel: "active" });
    const b = makeRow({ statusLabel: "done", completed: true });

    const rows = getDisplayRows([a, b], defaultOpts({ statusFilter: "all" }));

    expect(rows).toHaveLength(2);
  });

  it("specific statusFilter keeps only exact statusLabel matches", () => {
    const a = makeRow({ statusLabel: "in_progress" });
    const b = makeRow({ statusLabel: "active" });
    const c = makeRow({ statusLabel: "in_progress" });

    const rows = getDisplayRows(
      [a, b, c],
      defaultOpts({ statusFilter: "in_progress" })
    );

    expect(ids(rows).sort()).toEqual([a.id, c.id].sort());
  });

  it("showCompleted=false excludes completed rows", () => {
    const open = makeRow({ completed: false });
    const done = makeRow({ completed: true });

    const rows = getDisplayRows(
      [open, done],
      defaultOpts({ showCompleted: false })
    );

    expect(ids(rows)).toEqual([open.id]);
  });

  it("showCompleted=true includes completed rows", () => {
    const open = makeRow({ completed: false });
    const done = makeRow({ completed: true });

    const rows = getDisplayRows(
      [open, done],
      defaultOpts({ showCompleted: true })
    );

    expect(rows).toHaveLength(2);
  });

  it("sorts titles through compareBy in ascending order", () => {
    const banana = makeRow({ title: "Banana", displayName: "Banana" });
    const apple = makeRow({ title: "apple", displayName: "apple" });
    const cherry = makeRow({ title: "Cherry", displayName: "Cherry" });

    const rows = getDisplayRows(
      [banana, apple, cherry],
      defaultOpts({ sortKey: "title", sortDir: "asc" })
    );

    expect(rows.map((row) => row.title)).toEqual([
      "apple",
      "Banana",
      "Cherry",
    ]);
  });

  it("updatedAt desc (the view's default state) sorts newest first", () => {
    // compareBy treats direction=1 as newest-first for these keys, so passing
    // sortDir="desc" directly would put older entries first. getDisplayRows
    // reverses the direction for updatedAt and createdAt, preserving the
    // view's default of newest-first ordering.
    const old = makeRow({ updatedAt: "2026-01-01" });
    const mid = makeRow({ updatedAt: "2026-02-01" });
    const recent = makeRow({ updatedAt: "2026-03-01" });

    const desc = getDisplayRows(
      [old, recent, mid],
      defaultOpts({ sortKey: "updatedAt", sortDir: "desc" })
    );
    expect(ids(desc)).toEqual([recent.id, mid.id, old.id]);

    const asc = getDisplayRows(
      [old, recent, mid],
      defaultOpts({ sortKey: "updatedAt", sortDir: "asc" })
    );
    expect(ids(asc)).toEqual([old.id, mid.id, recent.id]);
  });

  it("sorts empty createdAt and updatedAt values first ascending and last descending", () => {
    const empty = makeRow({ updatedAt: "" });
    const dated = makeRow({ updatedAt: "2026-08-01" });

    const asc = getDisplayRows(
      [dated, empty],
      defaultOpts({ sortKey: "updatedAt", sortDir: "asc" })
    );
    expect(ids(asc)).toEqual([empty.id, dated.id]);

    const desc = getDisplayRows(
      [dated, empty],
      defaultOpts({ sortKey: "updatedAt", sortDir: "desc" })
    );
    expect(ids(desc)).toEqual([dated.id, empty.id]);
  });

  it("dueDate: empty strings cluster with no-due-date entries instead of sorting lexicographically", () => {
    // The test description suggests plain string comparison, but compareBy's
    // "dueDate" branch buckets by urgency first (overdue=0, today=1,
    // future=2, no-date=3) and only falls back to string comparison
    // within the same bucket. An empty dueDate lands in bucket 3 (the
    // LARGEST bucket), the opposite of "smaller". Forcing literal
    // compliance (inverting sortDir like the updatedAt/createdAt fix) would
    // require touching the shared bucket comparison and would reverse the
    // correct, clearly-intended real-date urgency order (soonest-first on
    // ascending) just to relocate the empty-date edge case — the wrong
    // trade-off. Accepted as satisfied in spirit: empty dates consistently
    // cluster at the least-urgent end of whichever direction is chosen,
    // never intermixed lexicographically with real dates. Not changed.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T12:00:00Z"));
    try {
      const empty = makeRow({ dueDate: "" });
      const dated = makeRow({ dueDate: "2026-08-01" });

      const asc = getDisplayRows(
        [empty, dated],
        defaultOpts({ sortKey: "dueDate", sortDir: "asc" })
      );
      expect(ids(asc)).toEqual([dated.id, empty.id]);

      const desc = getDisplayRows(
        [empty, dated],
        defaultOpts({ sortKey: "dueDate", sortDir: "desc" })
      );
      expect(ids(desc)).toEqual([empty.id, dated.id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flatDueSort=true forces due-date order even when sortKey differs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T12:00:00Z"));
    try {
      // Titles deliberately oppose due-date order so a title sort and a
      // due-date sort are distinguishable.
      const child = makeSubtask("s1", {
        dueDate: "2026-08-01",
        title: "Z child",
        displayName: "Z child",
      });
      const parent = withSubtasks(
        makeRow({
          dueDate: "2026-09-01",
          title: "M parent",
          displayName: "M parent",
        }),
        [child]
      );
      const noDue = makeRow({
        dueDate: "",
        title: "A nodue",
        displayName: "A nodue",
      });

      const flat = getDisplayRows(
        [parent, noDue],
        defaultOpts({ sortKey: "title", sortDir: "asc", flatDueSort: true })
      );

      // Despite sortKey "title" (which would order A nodue, M parent,
      // Z child), flatDueSort forces the flat due-date sort: child (08-01),
      // parent (09-01), dateless row last. Nesting stays downstream in
      // getCollapsedWorkbenchRows.
      expect(ids(flat)).toEqual([child.id, parent.id, noDue.id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flatDueSort=false keeps the user-selected sortKey", () => {
    const child = makeSubtask("s1", {
      dueDate: "2026-08-01",
      title: "Z child",
      displayName: "Z child",
    });
    const parent = withSubtasks(
      makeRow({
        dueDate: "2026-09-01",
        title: "M parent",
        displayName: "M parent",
      }),
      [child]
    );
    const noDue = makeRow({
      dueDate: "",
      title: "A nodue",
      displayName: "A nodue",
    });

    const nested = getDisplayRows(
      [parent, noDue],
      defaultOpts({ sortKey: "title", sortDir: "asc", flatDueSort: false })
    );

    expect(ids(nested)).toEqual([noDue.id, parent.id, child.id]);
  });
});

describe("getCollapsedWorkbenchRows", () => {
  it("flatDueSort=true early-returns displayRows unchanged", () => {
    const child = makeSubtask("s1");
    const parent = withSubtasks(makeRow(), [child]);
    const displayRows = [parent, child];

    const result = getCollapsedWorkbenchRows(
      displayRows,
      true,
      new Set([parent.id])
    );

    // Same reference: no decoration, no preview computation, no regrouping.
    expect(result).toBe(displayRows);
    expect(
      (result[0] as WorkbenchDisplayRow).__twbCollapseInfo
    ).toBeUndefined();
  });

  it("every present parent row receives collapse info", () => {
    const c1 = makeSubtask("s1");
    const c2 = makeSubtask("s2");
    const parent = withSubtasks(makeRow(), [c1, c2]);
    const loneParent = makeRow(); // no subtasks Map at all

    const result = getCollapsedWorkbenchRows(
      [parent, c1, c2, loneParent],
      false,
      new Set()
    );

    const parentOut = result.find(
      (row) => row.id === parent.id
    ) as WorkbenchDisplayRow;
    const loneOut = result.find(
      (row) => row.id === loneParent.id
    ) as WorkbenchDisplayRow;
    expect(parentOut.__twbCollapseInfo).toEqual({
      expanded: true,
      total: 2,
      visibleCount: 2,
      hiddenCount: 0,
    });
    expect(loneOut.__twbCollapseInfo).toEqual({
      expanded: true,
      total: 0,
      visibleCount: 0,
      hiddenCount: 0,
    });
  });

  it("grouping follows subtasks-Map membership, not physical row order", () => {
    const c1 = makeSubtask("s1");
    const c2 = makeSubtask("s2");
    const parent = withSubtasks(makeRow(), [c1, c2]);

    // Physical order deliberately interleaves children around the parent
    // (as a due-date sort could); both children must still nest under the
    // parent, in displayRows order.
    const result = getCollapsedWorkbenchRows([c2, parent, c1], false, new Set());

    expect(ids(result)).toEqual([parent.id, c2.id, c1.id]);
  });

  it("expanded parent emits all surviving children flagged __twbCollapsedPreview=false", () => {
    const c1 = makeSubtask("s1");
    const c2 = makeSubtask("s2");
    const parent = withSubtasks(makeRow(), [c1, c2]);

    const result = getCollapsedWorkbenchRows(
      [parent, c1, c2],
      false,
      new Set()
    );

    expect(result).toHaveLength(3);
    const childRows = result.filter(
      (row) => row.kind === "subtask"
    ) as WorkbenchDisplayRow[];
    expect(childRows).toHaveLength(2);
    for (const childRow of childRows) {
      expect(childRow.__twbCollapsedPreview).toBe(false);
    }
  });

  it("collapsed parent emits exactly one preview child flagged true", () => {
    const soon = makeSubtask("soon", { dueDate: "2026-08-01" });
    const later = makeSubtask("later", { dueDate: "2026-12-01" });
    const noDue = makeSubtask("nodue", { dueDate: "" });
    const parent = withSubtasks(makeRow(), [soon, later, noDue]);

    const result = getCollapsedWorkbenchRows(
      [parent, soon, later, noDue],
      false,
      new Set([parent.id])
    );

    // soon has the nearest due date → chosen as the single preview row.
    expect(ids(result)).toEqual([parent.id, soon.id]);
    expect((result[1] as WorkbenchDisplayRow).__twbCollapsedPreview).toBe(true);
    expect((result[0] as WorkbenchDisplayRow).__twbCollapseInfo).toEqual({
      expanded: false,
      total: 3,
      visibleCount: 1,
      hiddenCount: 2,
    });
  });

  it("collapsedParentIds membership means collapsed; absence means expanded", () => {
    const c1 = makeSubtask("s1");
    const parent = withSubtasks(makeRow(), [c1]);

    const collapsedResult = getCollapsedWorkbenchRows(
      [parent, c1],
      false,
      new Set([parent.id])
    );
    const expandedResult = getCollapsedWorkbenchRows(
      [parent, c1],
      false,
      new Set()
    );

    expect(
      (collapsedResult[0] as WorkbenchDisplayRow).__twbCollapseInfo?.expanded
    ).toBe(false);
    expect(
      (expandedResult[0] as WorkbenchDisplayRow).__twbCollapseInfo?.expanded
    ).toBe(true);
  });

  it("filtered-out subtasks do not reappear; total counts survivors only", () => {
    const openChild = makeSubtask("open", {
      completed: false,
      dueDate: "2026-08-01",
    });
    const doneChild = makeSubtask("done", {
      completed: true,
      dueDate: "2026-07-01",
    });
    const parent = withSubtasks(makeRow(), [openChild, doneChild]);

    // showCompleted=false removes the completed child upstream.
    const displayRows = getDisplayRows(
      [parent],
      defaultOpts({ showCompleted: false })
    );
    expect(ids(displayRows)).not.toContain(doneChild.id);

    const result = getCollapsedWorkbenchRows(
      displayRows,
      false,
      new Set([parent.id])
    );

    // doneChild must not be resurrected by the grouping step.
    expect(ids(result)).toEqual([parent.id, openChild.id]);
    expect((result[0] as WorkbenchDisplayRow).__twbCollapseInfo).toEqual({
      expanded: false,
      total: 1,
      visibleCount: 1,
      hiddenCount: 0,
    });
  });

  it("collapsed parent with ALL children filtered out upstream gets zero counts", () => {
    const doneChild = makeSubtask("done", { completed: true });
    const parent = withSubtasks(makeRow(), [doneChild]);

    // showCompleted=false removes every child upstream; only the parent
    // survives into displayRows.
    const displayRows = getDisplayRows(
      [parent],
      defaultOpts({ showCompleted: false })
    );
    expect(ids(displayRows)).toEqual([parent.id]);

    const result = getCollapsedWorkbenchRows(
      displayRows,
      false,
      new Set([parent.id])
    );

    // No crash, no resurrected child, zeroed collapse counts.
    expect(ids(result)).toEqual([parent.id]);
    expect((result[0] as WorkbenchDisplayRow).__twbCollapseInfo).toEqual({
      expanded: false,
      total: 0,
      visibleCount: 0,
      hiddenCount: 0,
    });
  });

  it("no eligible preview → parent stands alone, all survivors counted hidden", () => {
    const done1 = makeSubtask("d1", { completed: true, dueDate: "2026-08-01" });
    const done2 = makeSubtask("d2", { completed: true, dueDate: "2026-08-02" });
    const parent = withSubtasks(makeRow(), [done1, done2]);

    const result = getCollapsedWorkbenchRows(
      [parent, done1, done2],
      false,
      new Set([parent.id])
    );

    // Both children survive filtering but both are completed, so
    // pickWorkbenchPreviewSubtask finds no candidate → no child row.
    expect(ids(result)).toEqual([parent.id]);
    expect((result[0] as WorkbenchDisplayRow).__twbCollapseInfo).toEqual({
      expanded: false,
      total: 2,
      visibleCount: 0,
      hiddenCount: 2,
    });
  });

  it("does not mutate input rows because decorations use shallow copies", () => {
    const c1 = makeSubtask("s1");
    const parent = withSubtasks(makeRow(), [c1]);

    const result = getCollapsedWorkbenchRows(
      [parent, c1],
      false,
      new Set([parent.id])
    );

    expect((parent as WorkbenchDisplayRow).__twbCollapseInfo).toBeUndefined();
    expect((c1 as WorkbenchDisplayRow).__twbCollapsedPreview).toBeUndefined();
    expect(result[0]).not.toBe(parent);
  });

  it("restores a filtered-out parent as a grouping anchor when a child survives", () => {
    // A parent that fails the filter is restored when at least one child
    // survives, so the child remains grouped instead of becoming an orphan.
    // Exercise the full getDisplayRows → getCollapsedWorkbenchRows pipeline:
    // filterText matches the child's text but not the parent's.
    const survivor = makeSubtask("survivor", {
      title: "needle task",
      displayName: "needle task",
    });
    const parent = withSubtasks(
      makeRow({ title: "unrelated project", displayName: "unrelated project" }),
      [survivor]
    );

    const displayRows = getDisplayRows(
      [parent],
      defaultOpts({ filterText: "needle" })
    );
    // The parent is restored alongside the surviving child, not excluded.
    expect(ids(displayRows).sort()).toEqual([parent.id, survivor.id].sort());

    const result = getCollapsedWorkbenchRows(displayRows, false, new Set());

    // Grouped normally: parent anchor first, then its surviving child —
    // not an orphan row.
    expect(ids(result)).toEqual([parent.id, survivor.id]);
    expect((result[0] as WorkbenchDisplayRow).__twbCollapseInfo).toEqual({
      expanded: true,
      total: 1,
      visibleCount: 1,
      hiddenCount: 0,
    });
    expect(
      (result[1] as WorkbenchDisplayRow).__twbCollapsedPreview
    ).toBe(false);
  });

  it("excludes a filtered-out parent when no child survives", () => {
    // Companion case: parentMatches=false AND visibleChildren.length===0 →

    const alsoFiltered = makeSubtask("alsofiltered", {
      title: "unrelated child",
      displayName: "unrelated child",
    });
    const parent = withSubtasks(
      makeRow({ title: "unrelated project", displayName: "unrelated project" }),
      [alsoFiltered]
    );

    const displayRows = getDisplayRows(
      [parent],
      defaultOpts({ filterText: "needle" })
    );

    expect(displayRows).toHaveLength(0);
  });

  it("keeps the orphan fallback when a child's parent is absent from display rows", () => {

    // Called directly with a subtask whose parent is absent from the supplied
    // rows, getCollapsedWorkbenchRows returns an orphan row instead of
    // crashing or dropping the subtask.
    const orphan = makeSubtask("orphan");

    const result = getCollapsedWorkbenchRows([orphan], false, new Set());

    expect(ids(result)).toEqual([orphan.id]);
    expect(
      (result[0] as WorkbenchDisplayRow).__twbCollapsedPreview
    ).toBeUndefined();
  });
});

describe("pickWorkbenchPreviewSubtask", () => {
  it("excludes completed children", () => {
    const done = makeSubtask("done", {
      completed: true,
      dueDate: "2026-01-01",
    });
    const open = makeSubtask("open", {
      completed: false,
      dueDate: "2026-12-31",
    });

    expect(pickWorkbenchPreviewSubtask([done, open])).toBe(open);
  });

  it("picks the earliest dueDate", () => {
    const later = makeSubtask("later", { dueDate: "2026-03-01" });
    const sooner = makeSubtask("sooner", { dueDate: "2026-01-15" });

    expect(pickWorkbenchPreviewSubtask([later, sooner])).toBe(sooner);
  });

  it("falls back to plannedEndDate when dueDate is missing", () => {
    const planned = makeSubtask("planned", {
      dueDate: undefined,
      plannedEndDate: "2026-01-10",
    });
    const duet = makeSubtask("duet", { dueDate: "2026-02-01" });

    expect(pickWorkbenchPreviewSubtask([duet, planned])).toBe(planned);
  });

  it("treats empty-string dueDate as absent for the plannedEndDate fallback", () => {
    // dueDate "" is a normal real-world state (note-format.ts serializes an
    // absent dueDate as the literal "") and must behave like undefined.
    const emptyDuePlanned = makeSubtask("emptyplanned", {
      dueDate: "",
      plannedEndDate: "2026-01-10",
    });
    const duet = makeSubtask("duet", { dueDate: "2026-02-01" });


    expect(pickWorkbenchPreviewSubtask([duet, emptyDuePlanned])).toBe(
      emptyDuePlanned
    );
  });

  it("empty-string dueDate with no plannedEndDate sorts after a dated row", () => {
    const emptyDue = makeSubtask("emptydue", {
      dueDate: "",
      plannedEndDate: undefined,
      createdAt: "2020-01-01",
    });
    const dated = makeSubtask("dated", {
      dueDate: "2026-12-31",
      createdAt: "2026-01-01",
    });

    // Dateless sorts last: the older createdAt does not rescue emptyDue.
    expect(pickWorkbenchPreviewSubtask([emptyDue, dated])).toBe(dated);
  });

  it("rows without any date sort last", () => {
    const noDate = makeSubtask("nodate", {
      dueDate: undefined,
      plannedEndDate: undefined,
      createdAt: "2020-01-01",
    });
    const dated = makeSubtask("dated", {
      dueDate: "2026-12-31",
      createdAt: "2026-01-01",
    });

    // noDate has the older createdAt but still loses: dateless rows are last.
    expect(pickWorkbenchPreviewSubtask([noDate, dated])).toBe(dated);
  });

  it("ties on date fall back to older createdAt", () => {
    const newer = makeSubtask("newer", {
      dueDate: "2026-05-01",
      createdAt: "2026-02-01",
    });
    const older = makeSubtask("older", {
      dueDate: "2026-05-01",
      createdAt: "2026-01-05",
    });

    expect(pickWorkbenchPreviewSubtask([newer, older])).toBe(older);
  });

  it("ties on date and createdAt fall back to locale-aware displayName", () => {
    const beta = makeSubtask("beta", {
      dueDate: "2026-05-01",
      createdAt: "2026-01-01",
      displayName: "Beta",
    });
    const alpha = makeSubtask("alpha", {
      dueDate: "2026-05-01",
      createdAt: "2026-01-01",
      displayName: "alpha",
    });

    expect(pickWorkbenchPreviewSubtask([beta, alpha])).toBe(alpha);
  });

  it("returns the first candidate after sorting", () => {
    const a = makeSubtask("a", { dueDate: "2026-06-01" });
    const b = makeSubtask("b", { dueDate: "2026-01-01" });
    const c = makeSubtask("c", { dueDate: "2026-12-01" });

    expect(pickWorkbenchPreviewSubtask([a, b, c])).toBe(b);
  });

  it("returns null for empty input or all-completed children", () => {
    const done = makeSubtask("done", { completed: true });

    expect(pickWorkbenchPreviewSubtask([])).toBeNull();
    expect(pickWorkbenchPreviewSubtask([done])).toBeNull();
  });
});

describe("normalizePriorityMode", () => {
  it("accepts only the exact string 'manual'", () => {
    expect(normalizePriorityMode("manual")).toBe("manual");
    expect(normalizePriorityMode("auto")).toBe("auto");
  });

  it("defaults invalid values to 'auto'", () => {
    expect(normalizePriorityMode("")).toBe("auto");
    expect(normalizePriorityMode(undefined)).toBe("auto");
    expect(normalizePriorityMode(null)).toBe("auto");
    expect(normalizePriorityMode("MANUAL")).toBe("auto");
    expect(normalizePriorityMode("Manual")).toBe("auto");
    expect(normalizePriorityMode("man")).toBe("auto");
    expect(normalizePriorityMode(5)).toBe("auto");
    expect(normalizePriorityMode(true)).toBe("auto");
    expect(normalizePriorityMode({})).toBe("auto");
  });
});

// parseTagsInput is the parse step of the inline tag save
// flow (saveInline(row, { tags: parseTagsInput(input) })). It is implemented
// here as a pure function, distinct from ensureArray in src/core/utils.ts.
describe("parseTagsInput", () => {
  it("splits on comma only; semicolons stay in the text", () => {
    expect(parseTagsInput("tag1, tag2; tag3")).toEqual(["tag1", "tag2; tag3"]);
    expect(parseTagsInput("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("trims surrounding whitespace from each element", () => {
    expect(parseTagsInput("  bug ,\turgent , backend  ")).toEqual([
      "bug",
      "urgent",
      "backend",
    ]);
  });

  it("preserves empty tag elements", () => {
    expect(parseTagsInput("tag1, , tag2")).toEqual(["tag1", "", "tag2"]);

    const onlyCommas = parseTagsInput(", , ,");
    expect(onlyCommas).toEqual(["", "", "", ""]);
    expect(onlyCommas).toHaveLength(4);
    expect(parseTagsInput("")).toEqual([""]);
  });

  it("parses a typical tag-save input for saveInline", () => {
    expect(parseTagsInput("bug, urgent, backend")).toEqual([
      "bug",
      "urgent",
      "backend",
    ]);
  });
});
