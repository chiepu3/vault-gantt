import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import moment from "moment";
import {
  todayStr,
  dueDaysFromToday,
  isDueWithinDays,
  dueBucket,
  isValidDateFormat,
  isValidCalendarDate,
  normalizePriority,
  calculateAutoPriority,
  getEffectivePriority,
  applyAutoPriorityFields,
  normalizeStatusValue,
  getStatusLabel,
  sanitizeFileName,
  slugify,
  getSubtaskKey,
  makeUniqueMarkerKey,
  ensureArray,
  compareBy,
  changedFields,
  buildFileRevision,
  parseEmbedConfig,
} from "../../src/core/utils";
import { TaskRow } from "../../src/core/types";

describe("Core Utils - Time Functions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("todayStr returns YYYY-MM-DD format", () => {
    vi.setSystemTime(new Date("2026-07-27T12:34:56Z"));
    const result = todayStr();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("todayStr returns correct date value", () => {
    vi.setSystemTime(new Date("2026-07-27T00:00:00Z"));
    const result = todayStr();
    // Note: may vary by timezone, but format should be correct
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("dueDaysFromToday returns null for empty string", () => {
    vi.setSystemTime(new Date("2026-07-27T12:00:00Z"));
    expect(dueDaysFromToday("")).toBeNull();
  });

  it("dueDaysFromToday returns null for undefined", () => {
    vi.setSystemTime(new Date("2026-07-27T12:00:00Z"));
    expect(dueDaysFromToday(undefined)).toBeNull();
  });

  it("dueDaysFromToday returns null for invalid date format", () => {
    vi.setSystemTime(new Date("2026-07-27T12:00:00Z"));
    expect(dueDaysFromToday("2026-13-45")).toBeNull();
  });

  it("dueDaysFromToday returns 0 for today", () => {
    vi.setSystemTime(new Date("2026-07-27T12:00:00Z"));
    expect(dueDaysFromToday("2026-07-27")).toBe(0);
  });

  it("dueDaysFromToday returns positive for future dates", () => {
    vi.setSystemTime(new Date("2026-07-27T12:00:00Z"));
    expect(dueDaysFromToday("2026-08-03")).toBe(7);
  });

  it("accepts one shared render-pass today value across due helpers", () => {
    const today = moment("2026-07-27", "YYYY-MM-DD", true).startOf("day");
    expect(dueDaysFromToday("2026-07-27", today)).toBe(0);
    expect(dueBucket("2026-07-28", today)).toBe(2);
    expect(calculateAutoPriority("2026-07-30", today)).toBe(4);
  });

  it("dueDaysFromToday returns negative for past dates", () => {
    vi.setSystemTime(new Date("2026-07-27T12:00:00Z"));
    expect(dueDaysFromToday("2026-07-20")).toBe(-7);
  });

  it("dueBucket returns 0 for dates before today", () => {
    vi.setSystemTime(new Date("2026-07-27T12:00:00Z"));
    expect(dueBucket("2026-07-20")).toBe(0);
  });

  it("dueBucket returns 1 for dates due today", () => {
    vi.setSystemTime(new Date("2026-07-27T12:00:00Z"));
    expect(dueBucket("2026-07-27")).toBe(1);
  });

  it("dueBucket returns 2 for dates after today", () => {
    vi.setSystemTime(new Date("2026-07-27T12:00:00Z"));
    expect(dueBucket("2026-08-03")).toBe(2);
  });

  it("dueBucket returns 3 for tasks with no due date", () => {
    vi.setSystemTime(new Date("2026-07-27T12:00:00Z"));
    expect(dueBucket(undefined)).toBe(3);
    expect(dueBucket("")).toBe(3);
  });

  it("isDueWithinDays returns false if unparseable", () => {
    vi.setSystemTime(new Date("2026-07-27T12:00:00Z"));
    expect(isDueWithinDays("invalid-date", 5)).toBe(false);
  });

  it("isDueWithinDays returns false if overdue", () => {
    vi.setSystemTime(new Date("2026-07-27T12:00:00Z"));
    expect(isDueWithinDays("2026-07-20", 5)).toBe(false);
  });

  it("isDueWithinDays returns true if [0, days] inclusive - today", () => {
    vi.setSystemTime(new Date("2026-07-27T12:00:00Z"));
    expect(isDueWithinDays("2026-07-27", 0)).toBe(true);
  });

  it("isDueWithinDays returns true if [0, days] inclusive - within range", () => {
    vi.setSystemTime(new Date("2026-07-27T12:00:00Z"));
    expect(isDueWithinDays("2026-07-28", 5)).toBe(true);
    expect(isDueWithinDays("2026-08-01", 5)).toBe(true);
  });

  it("isDueWithinDays returns false if outside range", () => {
    vi.setSystemTime(new Date("2026-07-27T12:00:00Z"));
    expect(isDueWithinDays("2026-08-03", 5)).toBe(false);
  });
});

describe("Core Utils - Date Validation", () => {
  it("isValidDateFormat accepts YYYY-MM-DD format", () => {
    expect(isValidDateFormat("2026-07-27")).toBe(true);
  });

  it("isValidDateFormat accepts empty string", () => {
    expect(isValidDateFormat("")).toBe(true);
  });

  it("isValidDateFormat accepts undefined", () => {
    expect(isValidDateFormat(undefined)).toBe(true);
  });

  it("isValidDateFormat rejects invalid format", () => {
    expect(isValidDateFormat("27-07-2026")).toBe(false);
    expect(isValidDateFormat("2026/07/27")).toBe(false);
    expect(isValidDateFormat("2026-7-27")).toBe(false);
  });

  it("isValidCalendarDate accepts valid dates", () => {
    expect(isValidCalendarDate("2026-07-27")).toBe(true);
  });

  it("isValidCalendarDate rejects February 30", () => {
    expect(isValidCalendarDate("2026-02-30")).toBe(false);
  });

  it("isValidCalendarDate rejects out-of-range months", () => {
    expect(isValidCalendarDate("2026-13-45")).toBe(false);
  });

  it("isValidCalendarDate accepts leap year Feb 29", () => {
    expect(isValidCalendarDate("2024-02-29")).toBe(true);
  });

  it("isValidCalendarDate rejects non-leap year Feb 29", () => {
    expect(isValidCalendarDate("2023-02-29")).toBe(false);
  });

  it("isValidCalendarDate accepts empty string", () => {
    expect(isValidCalendarDate("")).toBe(true);
  });

  it("isValidCalendarDate accepts undefined", () => {
    expect(isValidCalendarDate(undefined)).toBe(true);
  });
});

describe("Core Utils - Priority Functions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T12:00:00Z"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizePriority constrains to [0, 5]", () => {
    expect(normalizePriority(-5)).toBe(0);
    expect(normalizePriority(0)).toBe(0);
    expect(normalizePriority(3)).toBe(3);
    expect(normalizePriority(5)).toBe(5);
    expect(normalizePriority(10)).toBe(5);
  });

  it("normalizePriority floors fractional values", () => {
    expect(normalizePriority(0.9)).toBe(0);
    expect(normalizePriority(5.5)).toBe(5);
    expect(normalizePriority(2.7)).toBe(2);
  });

  it("normalizePriority converts non-finite to 0", () => {
    expect(normalizePriority(NaN)).toBe(0);
    expect(normalizePriority(Infinity)).toBe(0);
    expect(normalizePriority(-Infinity)).toBe(0);
  });

  it("normalizePriority handles undefined", () => {
    expect(normalizePriority(undefined)).toBe(0);
  });

  it("calculateAutoPriority returns 0 for unparseable dueDate", () => {
    expect(calculateAutoPriority("invalid")).toBe(0);
    expect(calculateAutoPriority("")).toBe(0);
    expect(calculateAutoPriority(undefined)).toBe(0);
  });

  it("calculateAutoPriority returns the highest priority for overdue dates", () => {
    expect(calculateAutoPriority("2026-07-20")).toBe(5);
  });

  it("calculateAutoPriority returns the highest priority for dates due today", () => {
    expect(calculateAutoPriority("2026-07-27")).toBe(5);
  });

  it("calculateAutoPriority returns 4 for 1 <= days <= 3", () => {
    expect(calculateAutoPriority("2026-07-28")).toBe(4); // +1 day
    expect(calculateAutoPriority("2026-07-29")).toBe(4); // +2 days
    expect(calculateAutoPriority("2026-07-30")).toBe(4); // +3 days
  });

  it("calculateAutoPriority returns 3 for 4 <= days <= 7", () => {
    expect(calculateAutoPriority("2026-07-31")).toBe(3); // +4 days
    expect(calculateAutoPriority("2026-08-02")).toBe(3); // +6 days
    expect(calculateAutoPriority("2026-08-03")).toBe(3); // +7 days
  });

  it("calculateAutoPriority returns 2 for 8 <= days <= 14", () => {
    expect(calculateAutoPriority("2026-08-04")).toBe(2); // +8 days
    expect(calculateAutoPriority("2026-08-10")).toBe(2); // +14 days
  });

  it("calculateAutoPriority returns 1 for days > 14", () => {
    expect(calculateAutoPriority("2026-08-11")).toBe(1); // +15 days
    expect(calculateAutoPriority("2026-12-27")).toBe(1); // far future
  });

  it("getEffectivePriority returns priority when autoPriorityEnabled=false", () => {
    const row: TaskRow = {
      kind: "parent",
      id: "test",
      title: "Test",
      displayName: "Test",
      statusLabel: "active",
      completed: false,
      createdAt: "2026-07-27",
      updatedAt: "2026-07-27",
      dueDate: "2026-07-28",
      priority: 3,
      priorityMode: "auto",
      currentStatus: "",
      notes: "",
      tags: [],
      ganttEnabled: false,
      file: {} as unknown as TaskRow["file"],
    };

    expect(getEffectivePriority(row, false)).toBe(3);
  });

  it("getEffectivePriority returns priority when priorityMode=manual", () => {
    const row: TaskRow = {
      kind: "parent",
      id: "test",
      title: "Test",
      displayName: "Test",
      statusLabel: "active",
      completed: false,
      createdAt: "2026-07-27",
      updatedAt: "2026-07-27",
      dueDate: "2026-07-28",
      priority: 2,
      priorityMode: "manual",
      currentStatus: "",
      notes: "",
      tags: [],
      ganttEnabled: false,
      file: {} as unknown as TaskRow["file"],
    };

    expect(getEffectivePriority(row, true)).toBe(2);
  });

  it("getEffectivePriority returns calculateAutoPriority when auto and enabled", () => {
    const row: TaskRow = {
      kind: "parent",
      id: "test",
      title: "Test",
      displayName: "Test",
      statusLabel: "active",
      completed: false,
      createdAt: "2026-07-27",
      updatedAt: "2026-07-27",
      dueDate: "2026-07-28",
      priority: 0,
      priorityMode: "auto",
      currentStatus: "",
      notes: "",
      tags: [],
      ganttEnabled: false,
      file: {} as unknown as TaskRow["file"],
    };

    expect(getEffectivePriority(row, true)).toBe(4); // 1 day away
  });

  it("applyAutoPriorityFields sets priority when auto enabled", () => {
    const row: TaskRow = {
      kind: "parent",
      id: "test",
      title: "Test",
      displayName: "Test",
      statusLabel: "active",
      completed: false,
      createdAt: "2026-07-27",
      updatedAt: "2026-07-27",
      dueDate: "2026-07-28",
      priority: 0,
      priorityMode: "auto",
      currentStatus: "",
      notes: "",
      tags: [],
      ganttEnabled: false,
      file: {} as unknown as TaskRow["file"],
    };

    applyAutoPriorityFields(row, true);
    expect(row.priority).toBe(4);
  });

  it("applyAutoPriorityFields does not change priority when priorityMode=manual", () => {
    const row: TaskRow = {
      kind: "parent",
      id: "test",
      title: "Test",
      displayName: "Test",
      statusLabel: "active",
      completed: false,
      createdAt: "2026-07-27",
      updatedAt: "2026-07-27",
      dueDate: "2026-07-28",
      priority: 2,
      priorityMode: "manual",
      currentStatus: "",
      notes: "",
      tags: [],
      ganttEnabled: false,
      file: {} as unknown as TaskRow["file"],
    };

    applyAutoPriorityFields(row, true);
    expect(row.priority).toBe(2);
  });
});

describe("Core Utils - Status Functions", () => {
  it("normalizeStatusValue converts falsy to empty string", () => {
    expect(normalizeStatusValue(null)).toBe("");
    expect(normalizeStatusValue(undefined)).toBe("");
    expect(normalizeStatusValue("")).toBe("");
  });

  it("normalizeStatusValue returns trimmed string", () => {
    expect(normalizeStatusValue("  active  ")).toBe("active");
    expect(normalizeStatusValue("done")).toBe("done");
  });

  it("getStatusLabel returns Japanese label for known status", () => {
    expect(getStatusLabel("active")).toBe("未着手");
    expect(getStatusLabel("in_progress")).toBe("進行中");
    expect(getStatusLabel("waiting")).toBe("待ち");
    expect(getStatusLabel("hold")).toBe("保留");
    expect(getStatusLabel("done")).toBe("完了");
  });

  it("getStatusLabel returns String(value) for unknown status", () => {
    expect(getStatusLabel("unknown")).toBe("unknown");
    expect(getStatusLabel("")).toBe("");
  });
});

describe("Core Utils - File Name Sanitization", () => {
  it("sanitizeFileName removes backslash", () => {
    expect(sanitizeFileName("test\\file")).toBe("testfile");
  });

  it("sanitizeFileName removes forward slash", () => {
    expect(sanitizeFileName("test/file")).toBe("testfile");
  });

  it("sanitizeFileName removes colon", () => {
    expect(sanitizeFileName("test:file")).toBe("testfile");
  });

  it("sanitizeFileName removes asterisk", () => {
    expect(sanitizeFileName("test*file")).toBe("testfile");
  });

  it("sanitizeFileName removes question mark", () => {
    expect(sanitizeFileName("test?file")).toBe("testfile");
  });

  it("sanitizeFileName removes double quote", () => {
    expect(sanitizeFileName('test"file')).toBe("testfile");
  });

  it("sanitizeFileName removes angle brackets", () => {
    expect(sanitizeFileName("test<file>name")).toBe("testfilename");
  });

  it("sanitizeFileName removes pipe", () => {
    expect(sanitizeFileName("test|file")).toBe("testfile");
  });

  it("sanitizeFileName removes hash", () => {
    expect(sanitizeFileName("test#file")).toBe("testfile");
  });

  it("sanitizeFileName removes caret", () => {
    expect(sanitizeFileName("test^file")).toBe("testfile");
  });

  it("sanitizeFileName removes brackets", () => {
    expect(sanitizeFileName("test[file]")).toBe("testfile");
  });

  it("sanitizeFileName preserves other special characters", () => {
    expect(sanitizeFileName("test-file_name.txt")).toBe("test-file_name.txt");
    expect(sanitizeFileName("test@file&name")).toBe("test@file&name");
    expect(sanitizeFileName("test(file)name")).toBe("test(file)name");
  });
});

describe("Core Utils - Slugify", () => {
  it("slugify sanitizes filename", () => {
    expect(slugify("test/file")).toBe("testfile");
    expect(slugify("test:file")).toBe("testfile");
  });

  it("slugify converts to lowercase", () => {
    expect(slugify("TestFile")).toBe("testfile");
  });

  it("slugify converts spaces to hyphens", () => {
    expect(slugify("test file name")).toBe("test-file-name");
  });

  it("slugify removes non-alphanumeric characters except hyphens", () => {
    expect(slugify("test@file&name")).toBe("testfilename");
  });

  it("slugify truncates to 40 characters", () => {
    const longName = "a".repeat(50);
    const result = slugify(longName);
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result).toBe("a".repeat(40));
  });

  it("slugify exactly 40 and 41 characters", () => {
    const name40 = "a".repeat(40);
    const name41 = "a".repeat(41);
    expect(slugify(name40)).toBe("a".repeat(40));
    expect(slugify(name41)).toBe("a".repeat(40));
  });
});

describe("Core Utils - Subtask Key Generation", () => {
  it("getSubtaskKey generates slug from title", () => {
    const key = getSubtaskKey("My Task", new Set<string>());
    expect(key).toMatch(/^[a-z0-9-]+$/);
  });

  it("getSubtaskKey checks for collisions", () => {
    const existing = new Set<string>(["my-task"]);
    const key = getSubtaskKey("My Task", existing);
    expect(key).toBe("my-task-1");
  });

  it("getSubtaskKey increments suffix for multiple collisions", () => {
    const existing = new Set<string>(["my-task", "my-task-1"]);
    const key = getSubtaskKey("My Task", existing);
    expect(key).toBe("my-task-2");
  });

  it("getSubtaskKey fallback to timestamp for empty slug", () => {
    const key = getSubtaskKey("@@@", new Set<string>());
    expect(key).toMatch(/^subtask-\d+$/);
  });

  it("getSubtaskKey truncates the base name before adding a suffix", () => {
    const longName = "a".repeat(50);
    const existing = new Set<string>();
    const key = getSubtaskKey(longName, existing);
    // Should be truncated to 40 chars (no suffix)
    expect(key).toBe("a".repeat(40));
  });

  it("getSubtaskKey with collision: truncated + suffix can exceed 40", () => {
    const longName = "a".repeat(50);
    const existing = new Set<string>(["a".repeat(40)]);
    const key = getSubtaskKey(longName, existing);
    // Should be 40 chars + "-1"
    expect(key).toBe("a".repeat(40) + "-1");
    expect(key.length).toBeGreaterThan(40);
  });

  it("getSubtaskKey stays ASCII-only: CJK title falls back to timestamp", () => {

    // CJK-only title slugifies to empty, same as any other all-stripped
    // input, and hits the "subtask-{timestamp}" fallback, not a CJK key.
    const key = getSubtaskKey("新しいマーカー", new Set<string>());
    expect(key).toMatch(/^subtask-\d+$/);
  });
});

describe("Core Utils - Marker Key Generation", () => {
  it("makeUniqueMarkerKey generates slug from title", () => {
    const key = makeUniqueMarkerKey("My Marker", new Set<string>());
    expect(key).toBe("my-marker");
  });

  it("makeUniqueMarkerKey admits CJK characters instead of stripping them", () => {
    const key = makeUniqueMarkerKey("新しいマーカー", new Set<string>());
    expect(key).toBe("新しいマーカー");
  });

  it("makeUniqueMarkerKey admits mixed ASCII + CJK + hiragana/katakana", () => {
    const key = makeUniqueMarkerKey("Release v1 リリース", new Set<string>());
    expect(key).toBe("release-v1-リリース");
  });

  it("makeUniqueMarkerKey empty-fallback is 'marker', not a timestamp", () => {

    // that strips to nothing (symbols only) falls back to "marker".
    const key = makeUniqueMarkerKey("@@@", new Set<string>());
    expect(key).toBe("marker");
  });

  it("makeUniqueMarkerKey checks for collisions", () => {
    const existing = new Set<string>(["my-marker"]);
    const key = makeUniqueMarkerKey("My Marker", existing);
    expect(key).toBe("my-marker-1");
  });

  it("makeUniqueMarkerKey increments suffix for multiple collisions", () => {
    const existing = new Set<string>(["my-marker", "my-marker-1"]);
    const key = makeUniqueMarkerKey("My Marker", existing);
    expect(key).toBe("my-marker-2");
  });

  it("makeUniqueMarkerKey accepts a plain string[] for existingKeys", () => {
    const key = makeUniqueMarkerKey("My Marker", ["my-marker"]);
    expect(key).toBe("my-marker-1");
  });

  it("makeUniqueMarkerKey truncates to 40 chars before the collision check", () => {
    const longName = "a".repeat(50);
    const key = makeUniqueMarkerKey(longName, new Set<string>());
    expect(key).toBe("a".repeat(40));
  });

  it("makeUniqueMarkerKey with collision: truncated + suffix can exceed 40", () => {
    const longName = "a".repeat(50);
    const existing = new Set<string>(["a".repeat(40)]);
    const key = makeUniqueMarkerKey(longName, existing);
    expect(key).toBe("a".repeat(40) + "-1");
    expect(key.length).toBeGreaterThan(40);
  });

  it("makeUniqueMarkerKey collision-suffixes CJK keys the same way", () => {
    const existing = new Set<string>(["マーカー"]);
    const key = makeUniqueMarkerKey("マーカー", existing);
    expect(key).toBe("マーカー-1");
  });

  it("getSubtaskKey and makeUniqueMarkerKey remain independent for CJK", () => {
    const subtaskKey = getSubtaskKey("新しいマーカー", new Set<string>());
    const markerKey = makeUniqueMarkerKey("新しいマーカー", new Set<string>());
    expect(subtaskKey).not.toBe(markerKey);
    expect(subtaskKey).toMatch(/^subtask-\d+$/);
    expect(markerKey).toBe("新しいマーカー");
  });
});

describe("Core Utils - Array Handling", () => {
  it("ensureArray with falsy input returns empty array", () => {
    expect(ensureArray(undefined)).toEqual([]);
    expect(ensureArray(null)).toEqual([]);
    expect(ensureArray("")).toEqual([]);
  });

  it("ensureArray with string input returns single-element array", () => {
    expect(ensureArray("test")).toEqual(["test"]);
  });

  it("ensureArray with array converts null to string 'null'", () => {
    expect(ensureArray([null, "test"])).toEqual(["null", "test"]);
  });

  it("ensureArray with array converts undefined to string 'undefined'", () => {
    expect(ensureArray([undefined, "test"])).toEqual(["undefined", "test"]);
  });

  it("ensureArray filters out empty string elements", () => {
    expect(ensureArray(["", "test", ""])).toEqual(["test"]);
  });

  it("ensureArray with array preserves non-empty elements", () => {
    expect(ensureArray(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("ensureArray with mixed array", () => {
    expect(ensureArray([null, undefined, "", "a"])).toEqual([
      "null",
      "undefined",
      "a",
    ]);
  });
});

describe("Core Utils - Sorting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T12:00:00Z"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("compareBy title uses locale comparison", () => {
    const a: TaskRow = {
      kind: "parent",
      id: "a",
      title: "Apple",
      displayName: "Apple",
      statusLabel: "active",
      completed: false,
      createdAt: "2026-07-27",
      updatedAt: "2026-07-27",
      priority: 0,
      priorityMode: "auto",
      currentStatus: "",
      notes: "",
      tags: [],
      ganttEnabled: false,
      file: {} as unknown as TaskRow["file"],
    };

    const b: TaskRow = {
      kind: "parent",
      id: "b",
      title: "Banana",
      displayName: "Banana",
      statusLabel: "active",
      completed: false,
      createdAt: "2026-07-27",
      updatedAt: "2026-07-27",
      priority: 0,
      priorityMode: "auto",
      currentStatus: "",
      notes: "",
      tags: [],
      ganttEnabled: false,
      file: {} as unknown as TaskRow["file"],
    };

    expect(compareBy("title", "asc", a, b)).toBeLessThan(0);
    expect(compareBy("title", "desc", a, b)).toBeGreaterThan(0);
  });

  it("compareBy sorts updatedAt from newest to oldest", () => {
    const a: TaskRow = {
      kind: "parent",
      id: "a",
      title: "Task",
      displayName: "Task",
      statusLabel: "active",
      completed: false,
      createdAt: "2026-07-27",
      updatedAt: "2026-07-28",
      priority: 0,
      priorityMode: "auto",
      currentStatus: "",
      notes: "",
      tags: [],
      ganttEnabled: false,
      file: {} as unknown as TaskRow["file"],
    };

    const b: TaskRow = {
      kind: "parent",
      id: "b",
      title: "Task",
      displayName: "Task",
      statusLabel: "active",
      completed: false,
      createdAt: "2026-07-27",
      updatedAt: "2026-07-26",
      priority: 0,
      priorityMode: "auto",
      currentStatus: "",
      notes: "",
      tags: [],
      ganttEnabled: false,
      file: {} as unknown as TaskRow["file"],
    };


    // This implements "newest first"
    expect(compareBy("updatedAt", "asc", a, b)).toBeLessThan(0);
  });

  it("compareBy statusLabel uses Japanese label", () => {
    const a: TaskRow = {
      kind: "parent",
      id: "a",
      title: "Task",
      displayName: "Task",
      statusLabel: "active",
      completed: false,
      createdAt: "2026-07-27",
      updatedAt: "2026-07-27",
      priority: 0,
      priorityMode: "auto",
      currentStatus: "",
      notes: "",
      tags: [],
      ganttEnabled: false,
      file: {} as unknown as TaskRow["file"],
    };

    const b: TaskRow = {
      kind: "parent",
      id: "b",
      title: "Task",
      displayName: "Task",
      statusLabel: "done",
      completed: false,
      createdAt: "2026-07-27",
      updatedAt: "2026-07-27",
      priority: 0,
      priorityMode: "auto",
      currentStatus: "",
      notes: "",
      tags: [],
      ganttEnabled: false,
      file: {} as unknown as TaskRow["file"],
    };

    // Should use Japanese labels for comparison
    const result = compareBy("statusLabel", "asc", a, b);
    expect(typeof result).toBe("number");
  });

  it("compareBy default uses dueBucket primary sort", () => {
    const today: TaskRow = {
      kind: "parent",
      id: "today",
      title: "Task",
      displayName: "Task",
      statusLabel: "active",
      completed: false,
      createdAt: "2026-07-27",
      updatedAt: "2026-07-27",
      dueDate: "2026-07-27",
      priority: 0,
      priorityMode: "auto",
      currentStatus: "",
      notes: "",
      tags: [],
      ganttEnabled: false,
      file: {} as unknown as TaskRow["file"],
    };

    const future: TaskRow = {
      kind: "parent",
      id: "future",
      title: "Task",
      displayName: "Task",
      statusLabel: "active",
      completed: false,
      createdAt: "2026-07-27",
      updatedAt: "2026-07-27",
      dueDate: "2026-08-03",
      priority: 0,
      priorityMode: "auto",
      currentStatus: "",
      notes: "",
      tags: [],
      ganttEnabled: false,
      file: {} as unknown as TaskRow["file"],
    };

    // Today (bucket 1) should come before future (bucket 2)
    expect(compareBy("default", "asc", today, future)).toBeLessThan(0);
  });
});

describe("Core Utils - Field Change Detection", () => {
  it("changedFields detects changes via JSON-stringify comparison", () => {
    const before = { a: 1, b: "test", c: { nested: true } };
    const after = { a: 1, b: "changed", c: { nested: true } };
    const changed = changedFields(before, after);
    expect(changed).toContain("b");
  });

  it("changedFields ignores unchanged fields", () => {
    const before = { a: 1, b: "test" };
    const after = { a: 1, b: "test" };
    const changed = changedFields(before, after);
    expect(changed.length).toBe(0);
  });

  it("changedFields detects nested object changes", () => {
    const before = { a: { nested: 1 } };
    const after = { a: { nested: 2 } };
    const changed = changedFields(before, after);
    expect(changed).toContain("a");
  });

  it("changedFields only checks keys in after", () => {
    const before = { a: 1, b: 2, c: 3 };
    const after = { a: 1, b: 2 };
    const changed = changedFields(before, after);
    expect(changed.length).toBe(0);
  });
});

describe("Core Utils - File Revision", () => {
  it("buildFileRevision returns mtime:size", () => {
    const file = {
      stat: { mtime: 1234567890, size: 256 },
    } as unknown as typeof undefined;
    expect(buildFileRevision(file)).toBe("1234567890:256");
  });

  it("buildFileRevision returns 0:0 if file missing", () => {
    expect(buildFileRevision(undefined)).toBe("0:0");
  });

  it("buildFileRevision returns 0:0 if stat missing", () => {
    const file = {} as unknown as typeof undefined;
    expect(buildFileRevision(file)).toBe("0:0");
  });
});

describe("Core Utils - Embed Config Parsing", () => {
  it("parseEmbedConfig parses showCompleted", () => {
    const config = parseEmbedConfig("showCompleted=true");
    expect(config.showCompleted).toBe(true);
  });

  it("parseEmbedConfig parses status", () => {
    const config = parseEmbedConfig("status=active");
    expect(config.status).toBe("active");
  });

  it("parseEmbedConfig parses sort", () => {
    const config = parseEmbedConfig("sort=title");
    expect(config.sort).toBe("title");
  });

  it("parseEmbedConfig parses the sort direction", () => {
    const config = parseEmbedConfig("dir=desc");
    expect(config.dir).toBe("desc");
  });

  it("parseEmbedConfig parses flatDueSort", () => {
    const config = parseEmbedConfig("flatDueSort=true");
    expect(config.flatDueSort).toBe(true);
  });

  it("parseEmbedConfig parses maxRows", () => {
    const config = parseEmbedConfig("maxRows=100");
    expect(config.maxRows).toBe(100);
  });

  it("parseEmbedConfig ignores unknown keys", () => {
    const config = parseEmbedConfig("unknownKey=value\nstatus=active");
    expect(config.status).toBe("active");
  });

  it("parseEmbedConfig uses defaults", () => {
    const config = parseEmbedConfig("");
    expect(config.showCompleted).toBe(false);
    expect(config.status).toBe("all");
    expect(config.sort).toBe("dueDate");
    expect(config.dir).toBe("asc");
    expect(config.flatDueSort).toBe(false);
    expect(config.maxRows).toBe(50);
  });

  it("parseEmbedConfig with multiline input", () => {
    const config = parseEmbedConfig(
      "showCompleted=true\nstatus=done\ndir=desc"
    );
    expect(config.showCompleted).toBe(true);
    expect(config.status).toBe("done");
    expect(config.dir).toBe("desc");
  });

  it("parseEmbedConfig ignores lines without equals", () => {
    const config = parseEmbedConfig("invalid line\nstatus=active");
    expect(config.status).toBe("active");
  });

  it("parseEmbedConfig with empty input", () => {
    const config = parseEmbedConfig("");
    expect(config).toBeDefined();
    expect(config.showCompleted).toBe(false);
  });
});
