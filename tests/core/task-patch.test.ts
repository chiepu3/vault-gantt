import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  normalizeTaskPatch,
  normalizeWorkloadMap,
  normalizeMarkers,
  applyPatchToParent,
} from "../../src/core/task-patch";
import { TaskRow, TaskWorkbenchSettings } from "../../src/core/types";
import { DEFAULT_SETTINGS } from "../../src/core/constants";

describe("task-patch.ts", () => {
  describe("normalizeTaskPatch", () => {
    it("normalizeTaskPatch throws 'patch must be an object' for non-object", () => {
      expect(() => normalizeTaskPatch("not an object", "parent")).toThrow(
        "patch must be an object"
      );
    });

    it("normalizeTaskPatch throws 'patch must be an object' for array", () => {
      expect(() => normalizeTaskPatch([], "parent")).toThrow(
        "patch must be an object"
      );
    });

    it("normalizeTaskPatch throws 'patch must be an object' for null", () => {
      expect(() => normalizeTaskPatch(null, "parent")).toThrow(
        "patch must be an object"
      );
    });

    it("normalizeTaskPatch rejects ganttEnabled for subtask", () => {
      expect(() =>
        normalizeTaskPatch({ ganttEnabled: true }, "subtask")
      ).toThrow("field is not writable for subtask: ganttEnabled");
    });

    it("normalizeTaskPatch rejects ganttOrder for subtask", () => {
      expect(() =>
        normalizeTaskPatch({ ganttOrder: 123 }, "subtask")
      ).toThrow("field is not writable for subtask: ganttOrder");
    });

    it("normalizeTaskPatch accepts ganttEnabled for parent", () => {
      const result = normalizeTaskPatch({ ganttEnabled: true }, "parent");
      expect(result.ganttEnabled).toBe(true);
    });

    it("normalizeTaskPatch accepts plannedStartDate for subtask", () => {
      const result = normalizeTaskPatch(
        { plannedStartDate: "2024-01-01" },
        "subtask"
      );
      expect(result.plannedStartDate).toBe("2024-01-01");
    });

    it("normalizeTaskPatch rejects plannedStartDate for parent", () => {
      expect(() =>
        normalizeTaskPatch({ plannedStartDate: "2024-01-01" }, "parent")
      ).toThrow("field is not writable for parent: plannedStartDate");
    });

    it("normalizeTaskPatch throws for invalid calendar date", () => {
      expect(() =>
        normalizeTaskPatch({ dueDate: "2024-02-30" }, "parent")
      ).toThrow("invalid date for dueDate: 2024-02-30");
    });

    it("normalizeTaskPatch allows empty date string", () => {
      const result = normalizeTaskPatch({ dueDate: "" }, "parent");
      expect(result.dueDate).toBe("");
    });

    it("normalizeTaskPatch throws for empty displayName", () => {
      expect(() =>
        normalizeTaskPatch({ displayName: "" }, "parent")
      ).toThrow("displayName must not be empty");
    });

    it("normalizeTaskPatch throws for whitespace-only displayName", () => {
      expect(() =>
        normalizeTaskPatch({ displayName: "   " }, "parent")
      ).toThrow("displayName must not be empty");
    });

    it("normalizeTaskPatch throws for empty title", () => {
      expect(() => normalizeTaskPatch({ title: "" }, "parent")).toThrow(
        "title must not be empty"
      );
    });

    it("normalizeTaskPatch throws for invalid status", () => {
      expect(() =>
        normalizeTaskPatch({ statusLabel: "invalid_status" }, "parent")
      ).toThrow("invalid status: invalid_status");
    });

    it("normalizeTaskPatch throws for non-finite ganttOrder", () => {
      expect(() =>
        normalizeTaskPatch({ ganttOrder: NaN }, "parent")
      ).toThrow("ganttOrder must be a finite number");
    });

    it("normalizeTaskPatch throws for Infinity ganttOrder", () => {
      expect(() =>
        normalizeTaskPatch({ ganttOrder: Infinity }, "parent")
      ).toThrow("ganttOrder must be a finite number");
    });

    it("normalizeTaskPatch clamps priority to [0,5]", () => {
      const result = normalizeTaskPatch({ priority: 10 }, "parent");
      expect(result.priority).toBe(5);
    });

    it("normalizeTaskPatch converts priorityMode to 'auto' for anything but 'manual'", () => {
      const result1 = normalizeTaskPatch({ priorityMode: "manual" }, "parent");
      expect(result1.priorityMode).toBe("manual");

      const result2 = normalizeTaskPatch({ priorityMode: "something" }, "parent");
      expect(result2.priorityMode).toBe("auto");
    });

    it("normalizeTaskPatch coerces completed to boolean", () => {
      const result1 = normalizeTaskPatch({ completed: 1 }, "parent");
      expect(result1.completed).toBe(true);

      const result2 = normalizeTaskPatch({ completed: 0 }, "parent");
      expect(result2.completed).toBe(false);
    });

    it("normalizeTaskPatch coerces ganttEnabled to boolean", () => {
      const result = normalizeTaskPatch({ ganttEnabled: 1 }, "parent");
      expect(result.ganttEnabled).toBe(true);
    });

    it("normalizeTaskPatch ensureArrays tags", () => {
      const result = normalizeTaskPatch({ tags: "tag1,tag2" }, "parent");
      expect(Array.isArray(result.tags)).toBe(true);
    });
  });

  describe("normalizeTaskPatch - status/completed consistency", () => {
    it("Rule 1: statusLabel='done' forces completed=true even if patch has completed:false", () => {
      const result = normalizeTaskPatch(
        { statusLabel: "done", completed: false },
        "parent"
      );
      expect(result.statusLabel).toBe("done");
      expect(result.completed).toBe(true);
    });

    it("Rule 2: completed=true and no statusLabel in patch sets statusLabel='done'", () => {
      const result = normalizeTaskPatch({ completed: true }, "parent");
      expect(result.statusLabel).toBe("done");
    });

    it("Rule 3: completed=false and no statusLabel in patch sets statusLabel='active'", () => {
      const result = normalizeTaskPatch({ completed: false }, "parent");
      expect(result.statusLabel).toBe("active");
    });

    it("Rule 4: statusLabel set (not 'done') and no completed in patch sets completed=false", () => {
      const result = normalizeTaskPatch(
        { statusLabel: "in_progress" },
        "parent"
      );
      expect(result.completed).toBe(false);
    });

    it("preserves conflicting status and completion values when both are provided", () => {
      const result = normalizeTaskPatch(
        { completed: true, statusLabel: "active" },
        "parent"
      );
      expect(result.completed).toBe(true);
      expect(result.statusLabel).toBe("active");
    });

    it("statusLabel done forces completed true even when explicitly false", () => {
      const result = normalizeTaskPatch(
        { statusLabel: "done", completed: false },
        "parent"
      );
      expect(result.completed).toBe(true);
    });
  });

  describe("normalizeTaskPatch - date validation", () => {
    it("throws for invalid dueDate format", () => {
      expect(() =>
        normalizeTaskPatch({ dueDate: "2024-1-1" }, "parent")
      ).toThrow("invalid date for dueDate");
    });

    it("throws for invalid createdAt", () => {
      expect(() =>
        normalizeTaskPatch({ createdAt: "2024-02-30" }, "parent")
      ).toThrow("invalid date for createdAt");
    });

    it("rejects an invalid subtask plannedStartDate", () => {
      expect(() =>
        normalizeTaskPatch({ plannedStartDate: "2024-13-01" }, "subtask")
      ).toThrow("invalid date for plannedStartDate");
    });

    it("rejects an invalid subtask plannedEndDate", () => {
      expect(() =>
        normalizeTaskPatch({ plannedEndDate: "2024-01-32" }, "subtask")
      ).toThrow("invalid date for plannedEndDate");
    });

    it("plannedStartDate > plannedEndDate throws", () => {
      expect(() =>
        normalizeTaskPatch(
          {
            plannedStartDate: "2024-01-10",
            plannedEndDate: "2024-01-05",
          },
          "subtask"
        )
      ).toThrow("plannedStartDate must not be after plannedEndDate");
    });

    it("plannedStartDate === plannedEndDate is allowed", () => {
      const result = normalizeTaskPatch(
        {
          plannedStartDate: "2024-01-10",
          plannedEndDate: "2024-01-10",
        },
        "subtask"
      );
      expect(result.plannedStartDate).toBe("2024-01-10");
      expect(result.plannedEndDate).toBe("2024-01-10");
    });

    it("date range check skipped if one is empty", () => {
      const result = normalizeTaskPatch(
        {
          plannedStartDate: "2024-01-10",
          plannedEndDate: "",
        },
        "subtask"
      );
      expect(result.plannedStartDate).toBe("2024-01-10");
      expect(result.plannedEndDate).toBe("");
    });
  });

  describe("normalizeWorkloadMap", () => {
    it("throws 'workload must be an object' for non-object", () => {
      expect(() => normalizeWorkloadMap("not an object")).toThrow(
        "workload must be an object keyed by YYYY-MM-DD"
      );
    });

    it("throws for array", () => {
      expect(() => normalizeWorkloadMap([])).toThrow(
        "workload must be an object keyed by YYYY-MM-DD"
      );
    });

    it("throws for null", () => {
      expect(() => normalizeWorkloadMap(null)).toThrow(
        "workload must be an object keyed by YYYY-MM-DD"
      );
    });

    it("rejects invalid workload dates in patches", () => {
      expect(() =>
        normalizeWorkloadMap({ "2024-02-30": 8 })
      ).toThrow("invalid workload date: 2024-02-30");
    });

    it("date error wins over hours error", () => {

      expect(() =>
        normalizeWorkloadMap({ "2024-02-30": 25 })
      ).toThrow("invalid workload date: 2024-02-30");
    });

    it("throws 'invalid workload hours' for hours > 24", () => {
      expect(() =>
        normalizeWorkloadMap({ "2024-01-01": 25 })
      ).toThrow("invalid workload hours: 2024-01-01");
    });

    it("throws for hours exactly 24.1", () => {
      expect(() =>
        normalizeWorkloadMap({ "2024-01-01": 24.1 })
      ).toThrow("invalid workload hours: 2024-01-01");
    });

    it("hours === 24 is allowed", () => {
      const result = normalizeWorkloadMap({ "2024-01-01": 24 });
      expect(result["2024-01-01"]).toBe(24);
    });

    it("rounds to 0.5 increments", () => {
      const result = normalizeWorkloadMap({ "2024-01-01": 8.3 });
      expect(result["2024-01-01"]).toBe(8.5);
    });

    it("silently skips non-finite hours", () => {
      const result = normalizeWorkloadMap({
        "2024-01-01": NaN,
        "2024-01-02": 8,
      });
      expect(result).not.toHaveProperty("2024-01-01");
      expect(result["2024-01-02"]).toBe(8);
    });

    it("drops values <= 0", () => {
      const result = normalizeWorkloadMap({
        "2024-01-01": 0,
        "2024-01-02": -1,
        "2024-01-03": 0.5,
      });
      expect(result).not.toHaveProperty("2024-01-01");
      expect(result).not.toHaveProperty("2024-01-02");
      expect(result["2024-01-03"]).toBe(0.5);
    });

    it("persist-time workload validation rejects invalid date keys", () => {
      expect(() => normalizeWorkloadMap({ "not-a-date": 3 })).toThrow(
        "invalid workload date: not-a-date"
      );
    });

    it("rejects calendar-invalid workload dates using strict validation", () => {
      expect(() => normalizeWorkloadMap({ "2026-13-32": 3 })).toThrow(
        "invalid workload date: 2026-13-32"
      );
    });

    it("an empty dictionary is returned empty, unchanged", () => {
      expect(normalizeWorkloadMap({})).toEqual({});
    });
  });

  describe("normalizeMarkers", () => {
    it("throws 'ganttMarkers must be an array' for non-array", () => {
      expect(() => normalizeMarkers("not an array")).toThrow(
        "ganttMarkers must be an array"
      );
    });

    it("throws for object", () => {
      expect(() => normalizeMarkers({})).toThrow(
        "ganttMarkers must be an array"
      );
    });

    it("throws 'invalid marker' for array with null elements", () => {
      expect(() =>
        normalizeMarkers([{ key: "m1", title: "Marker", date: "2024-01-01" }, null])
      ).toThrow("invalid marker");
    });

    it("rejects an empty marker key before validating other fields", () => {
      expect(() =>
        normalizeMarkers([
          { key: "", title: "Marker", date: "2024-01-01" },
        ])
      ).toThrow("invalid or duplicate marker key:");
    });

    it("rejects duplicate marker keys before validating title or date", () => {
      expect(() =>
        normalizeMarkers([
          { key: "m1", title: "Marker 1", date: "2024-01-01" },
          { key: "m1", title: "", date: "" }, // Also has empty title and date
        ])
      ).toThrow("invalid or duplicate marker key: m1");
    });

    it("rejects an empty marker title after validating the key", () => {
      expect(() =>
        normalizeMarkers([
          { key: "m1", title: "", date: "2024-01-01" },
        ])
      ).toThrow("marker title is required: m1");
    });

    it("rejects an invalid marker date after validating key and title", () => {
      expect(() =>
        normalizeMarkers([
          { key: "m1", title: "Marker", date: "2024-02-30" },
        ])
      ).toThrow("invalid marker date:");
    });

    it("throws for empty date", () => {
      expect(() =>
        normalizeMarkers([
          { key: "m1", title: "Marker", date: "" },
        ])
      ).toThrow("invalid marker date:");
    });

    it("tags are ensureArray, never throws", () => {
      const result = normalizeMarkers([
        { key: "m1", title: "Marker", date: "2024-01-01", tags: "tag1,tag2" },
      ]);
      expect(Array.isArray(result[0].tags)).toBe(true);
    });

    it("tags optional field", () => {
      const result = normalizeMarkers([
        { key: "m1", title: "Marker", date: "2024-01-01" },
      ]);
      expect(result[0].tags).toBeDefined();
    });

    it("valid marker normalized successfully", () => {
      const result = normalizeMarkers([
        {
          key: "m1",
          title: "Milestone 1",
          date: "2024-01-15",
          tags: ["important"],
        },
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].key).toBe("m1");
      expect(result[0].title).toBe("Milestone 1");
      expect(result[0].date).toBe("2024-01-15");
    });
  });

  describe("applyPatchToParent", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-27T12:00:00Z"));
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    const createMockParent = (): TaskRow => ({
      kind: "parent",
      id: "test/task.md",
      file: {
        path: "test/task.md",
      } as TaskRow["file"],
      title: "Original Title",
      displayName: "Original Display",
      statusLabel: "active",
      completed: false,
      createdAt: "2026-07-20",
      updatedAt: "2026-07-20",
      dueDate: "2026-08-03",
      priority: 2,
      priorityMode: "manual",
      currentStatus: "",
      notes: "",
      tags: [],
      ganttEnabled: false,
      ganttOrder: 0,
      subtasks: new Map(),
    });

    it("updatedAt bumps even for empty patch", () => {
      const parent = createMockParent();
      const originalUpdatedAt = parent.updatedAt;
      const result = applyPatchToParent(parent, {}, "test/task.md", DEFAULT_SETTINGS);
      expect(result.parent.updatedAt).not.toBe(originalUpdatedAt);
    });

    it("setting displayName also updates title to same value", () => {
      const parent = createMockParent();
      const result = applyPatchToParent(
        parent,
        { displayName: "New Name" },
        "test/task.md",
        DEFAULT_SETTINGS
      );
      expect(result.parent.displayName).toBe("New Name");
      expect(result.parent.title).toBe("New Name");
    });

    it("setting title also updates displayName to same value", () => {
      const parent = createMockParent();
      const result = applyPatchToParent(
        parent,
        { title: "New Title" },
        "test/task.md",
        DEFAULT_SETTINGS
      );
      expect(result.parent.displayName).toBe("New Title");
      expect(result.parent.title).toBe("New Title");
    });

    it("auto-priority recalculates when patch.priority is undefined and settings.autoPriorityEnabled=true", () => {
      const settings: TaskWorkbenchSettings = {
        ...DEFAULT_SETTINGS,
        autoPriorityEnabled: true,
      };
      const parent = createMockParent();
      parent.priorityMode = "auto";
      parent.dueDate = "2026-07-27"; // Today -> priority should be 5
      parent.priority = 1; // Start with low priority

      const result = applyPatchToParent(
        parent,
        { dueDate: "2026-07-27" }, // No priority in patch
        "test/task.md",
        settings
      );

      // Auto-priority should recalculate to 5 (today is due)
      expect(result.parent.priority).toBe(5);
    });

    it("auto-priority does NOT run when patch.priority is defined", () => {
      const settings: TaskWorkbenchSettings = {
        ...DEFAULT_SETTINGS,
        autoPriorityEnabled: true,
      };
      const parent = createMockParent();
      parent.priorityMode = "auto";
      parent.dueDate = "2026-07-27"; // Today
      parent.priority = 1;

      const result = applyPatchToParent(
        parent,
        { priority: 1, dueDate: "2026-07-27" }, // Explicit priority in patch
        "test/task.md",
        settings
      );

      // Priority should NOT recalculate, should stay as patched value
      expect(result.parent.priority).toBe(1);
    });

    it("auto-priority disabled when settings.autoPriorityEnabled=false", () => {
      const settings: TaskWorkbenchSettings = {
        ...DEFAULT_SETTINGS,
        autoPriorityEnabled: false,
      };
      const parent = createMockParent();
      parent.priorityMode = "auto";
      parent.dueDate = "2026-07-27";
      parent.priority = 1;

      const result = applyPatchToParent(
        parent,
        { dueDate: "2026-07-27" }, // No priority in patch
        "test/task.md",
        settings
      );

      // Auto-priority should NOT run
      expect(result.parent.priority).toBe(1);
    });

    it("changedFields reports exactly the fields that changed", () => {
      const parent = createMockParent();
      const result = applyPatchToParent(
        parent,
        { displayName: "New Display", priority: 3 },
        "test/task.md",
        DEFAULT_SETTINGS
      );

      // Should include displayName, title (synced), priority, and updatedAt
      expect(result.changed).toContain("displayName");
      expect(result.changed).toContain("title");
      expect(result.changed).toContain("priority");
      expect(result.changed).toContain("updatedAt");
    });

    it("changedFields does not report fields that didn't change", () => {
      const parent = createMockParent();
      parent.statusLabel = "active";
      parent.notes = "";

      const result = applyPatchToParent(
        parent,
        { dueDate: "2026-08-03" }, // Same as before
        "test/task.md",
        DEFAULT_SETTINGS
      );

      expect(result.changed).not.toContain("dueDate");
    });

    // Verify empty tag elements survive the complete patch path.
    // parseTagsInput preserves them, and the Workbench tag editor uses this
    // path to persist normalized tags.
    it("applyPatchToParent preserves empty tags from an already-normalized patch", () => {
      const parent = createMockParent();
      const tagsFromParseTagsInput = ["foo", "", "bar"]; // parseTagsInput("foo,, bar")

      const result = applyPatchToParent(
        parent,
        { tags: tagsFromParseTagsInput },
        "test/task.md",
        DEFAULT_SETTINGS
      );

      expect(result.parent.tags).toEqual(["foo", "", "bar"]);
    });
  });

  describe("applyPatchToParent - subtask updates", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-27T12:00:00Z"));
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    const createMockParentWithSubtask = (): TaskRow => {
      const subtask: TaskRow = {
        kind: "subtask",
        id: "test/task.md::sub1",
        key: "sub1",
        file: {
          path: "test/task.md",
          parentPath: "test/task.md",
          heading: "Subtask 1",
        } as TaskRow["file"],
        title: "Subtask 1",
        displayName: "Subtask 1",
        statusLabel: "active",
        completed: false,
        createdAt: "2026-07-20",
        updatedAt: "2026-07-20",
        dueDate: "",
        priority: 0,
        priorityMode: "manual",
        currentStatus: "",
        notes: "",
        tags: [],
        ganttEnabled: false,
        plannedStartDate: "2026-07-20",
        plannedEndDate: "2026-07-25",
      };

      const parent: TaskRow = {
        kind: "parent",
        id: "test/task.md",
        file: {
          path: "test/task.md",
        } as TaskRow["file"],
        title: "Parent Task",
        displayName: "Parent Task",
        statusLabel: "active",
        completed: false,
        createdAt: "2026-07-20",
        updatedAt: "2026-07-20",
        dueDate: "",
        priority: 0,
        priorityMode: "manual",
        currentStatus: "",
        notes: "",
        tags: [],
        ganttEnabled: false,
        ganttOrder: 0,
        subtasks: new Map([["sub1", subtask]]),
      };

      return parent;
    };

    it("subtask re-check: plannedStartDate > plannedEndDate throws", () => {
      const parent = createMockParentWithSubtask();
      expect(() =>
        applyPatchToParent(
          parent,
          { plannedStartDate: "2026-07-30", plannedEndDate: "2026-07-25" },
          "test/task.md::sub1",
          DEFAULT_SETTINGS
        )
      ).toThrow("plannedStartDate must not be after plannedEndDate");
    });

    it("subtask re-check: start <= end is allowed", () => {
      const parent = createMockParentWithSubtask();
      const result = applyPatchToParent(
        parent,
        { plannedStartDate: "2026-07-25", plannedEndDate: "2026-07-30" },
        "test/task.md::sub1",
        DEFAULT_SETTINGS
      );
      expect(result.changed).toBeDefined();
    });
  });
});
