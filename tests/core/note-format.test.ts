import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  parseSimpleValue,
  parseFrontmatter,
  parseWorkloadMap,
  extractSection,
  splitSubtasksSection,
  parseTaskFile,
  yamlEscape,
  buildFrontmatter,
  buildBody,
  buildFullNote,
} from "../../src/core/note-format";
import { TaskRow, TaskWorkbenchSettings } from "../../src/core/types";
import { DEFAULT_SETTINGS } from "../../src/core/constants";

function makeParent(extra: Partial<TaskRow> = {}): TaskRow {
  return {
    kind: "parent",
    id: "tasks/2026/07/P.md",
    file: { path: "tasks/2026/07/P.md" },
    title: "Parent",
    displayName: "Parent",
    statusLabel: "active",
    completed: false,
    createdAt: "2026-07-01",
    updatedAt: "2026-07-02",
    dueDate: "2026-08-01",
    priority: 1,
    priorityMode: "manual",
    currentStatus: "",
    notes: "",
    tags: ["a"],
    ganttEnabled: true,
    ganttOrder: 5,
    ...extra,
  } as TaskRow;
}

function makeSubtask(key: string, extra: Partial<TaskRow> = {}): TaskRow {
  return {
    kind: "subtask",
    id: `tasks/2026/07/P.md::${key}`,
    key,
    file: { parentPath: "tasks/2026/07/P.md", heading: extra.displayName ?? "Sub" },
    title: "Sub",
    displayName: "Sub",
    statusLabel: "active",
    completed: false,
    createdAt: "2026-07-01",
    updatedAt: "2026-07-02",
    priority: 0,
    priorityMode: "auto",
    currentStatus: "",
    notes: "",
    tags: [],
    ganttEnabled: false,
    ...extra,
  } as TaskRow;
}

describe("note-format.ts", () => {
  describe("parseSimpleValue", () => {
    it("parseSimpleValue empty string returns empty string", () => {
      expect(parseSimpleValue("")).toBe("");
    });

    it("parseSimpleValue 'true' returns boolean true", () => {
      expect(parseSimpleValue("true")).toBe(true);
    });

    it("parseSimpleValue 'false' returns boolean false", () => {
      expect(parseSimpleValue("false")).toBe(false);
    });

    it("parseSimpleValue 'True' with capital T returns raw string", () => {
      expect(parseSimpleValue("True")).toBe("True");
    });

    it("parseSimpleValue 'False' with capital F returns raw string", () => {
      expect(parseSimpleValue("False")).toBe("False");
    });

    it("parseSimpleValue '[a,b,c]' returns array", () => {
      expect(parseSimpleValue("[a,b,c]")).toEqual(["a", "b", "c"]);
    });

    it("parseSimpleValue '[]' returns empty array", () => {
      expect(parseSimpleValue("[]")).toEqual([]);
    });

    it("parseSimpleValue '[a,b' unclosed bracket returns raw string", () => {
      expect(parseSimpleValue("[a,b")).toBe("[a,b");
    });

    it("parseSimpleValue 'a,b]' unclosed bracket returns raw string", () => {
      expect(parseSimpleValue("a,b]")).toBe("a,b]");
    });

    it("parseSimpleValue quoted string with escaped quote", () => {
      expect(parseSimpleValue('"hello\\"world"')).toBe('hello"world');
    });

    it("parseSimpleValue quoted empty string", () => {
      expect(parseSimpleValue('""')).toBe("");
    });

    it("parseSimpleValue raw string with numbers", () => {
      expect(parseSimpleValue("42")).toBe("42");
    });

    it("parseSimpleValue raw string with special chars", () => {
      expect(parseSimpleValue("hello-world_123")).toBe("hello-world_123");
    });
  });

  describe("parseFrontmatter", () => {
    it("parseFrontmatter ignores lines without colons", () => {
      const content = `---
key1: value1
line without colon
key2: value2
---`;
      const result = parseFrontmatter(content);
      expect(result).toHaveProperty("key1", "value1");
      expect(result).toHaveProperty("key2", "value2");
      expect(Object.keys(result).length).toBe(2);
    });

    it("parseFrontmatter splits on FIRST colon only", () => {
      const content = `---
key: value:with:colons
---`;
      const result = parseFrontmatter(content);
      expect(result).toHaveProperty("key", "value:with:colons");
    });

    it("parseFrontmatter with missing frontmatter markers", () => {
      const content = `key1: value1
key2: value2`;
      const result = parseFrontmatter(content);
      expect(Object.keys(result).length).toBe(0);
    });

    it("parseFrontmatter with proper frontmatter markers", () => {
      const content = `---
type: task
title: Example
---
Body content`;
      const result = parseFrontmatter(content);
      expect(result).toHaveProperty("type", "task");
      expect(result).toHaveProperty("title", "Example");
    });
  });

  describe("parseWorkloadMap", () => {
    it("parseWorkloadMap matches regex pattern", () => {
      const result = parseWorkloadMap("2024-01-01=8.0, 2024-01-02=4.5");
      expect(result["2024-01-01"]).toBe(8);
      expect(result["2024-01-02"]).toBe(4.5);
    });

    it("parseWorkloadMap ignores non-matching tokens", () => {
      const result = parseWorkloadMap("2024-01-01=8, invalid-token, 2024-01-02=4");
      expect(result["2024-01-01"]).toBe(8);
      expect(result["2024-01-02"]).toBe(4);
      expect(Object.keys(result).length).toBe(2);
    });

    it("parseWorkloadMap rounds to 0.5 increments", () => {
      const result = parseWorkloadMap("2024-01-01=8.3, 2024-01-02=4.7");
      expect(result["2024-01-01"]).toBe(8.5);
      expect(result["2024-01-02"]).toBe(4.5);
    });

    it("parseWorkloadMap drops entries <= 0", () => {
      const result = parseWorkloadMap("2024-01-01=0, 2024-01-02=-1, 2024-01-03=0.5");
      expect(result).not.toHaveProperty("2024-01-01");
      expect(result).not.toHaveProperty("2024-01-02");
      expect(result["2024-01-03"]).toBe(0.5);
    });

    it("parseWorkloadMap drops non-finite hours", () => {
      const result = parseWorkloadMap("2024-01-01=NaN, 2024-01-02=Infinity, 2024-01-03=8");
      expect(result).not.toHaveProperty("2024-01-01");
      expect(result).not.toHaveProperty("2024-01-02");
      expect(result["2024-01-03"]).toBe(8);
    });

    it("parseWorkloadMap ignores invalid date keys", () => {
      const result = parseWorkloadMap("2024-13-01=8, 2024-01-32=4, 2024-01-01=8");
      // Invalid dates are silently ignored during parse (lenient)
      expect(result["2024-01-01"]).toBe(8);
    });

    it("parseWorkloadMap handles semicolon separators", () => {
      const result = parseWorkloadMap("2024-01-01=8; 2024-01-02=4");
      expect(result["2024-01-01"]).toBe(8);
      expect(result["2024-01-02"]).toBe(4);
    });

    it("parseWorkloadMap handles mixed comma and semicolon", () => {
      const result = parseWorkloadMap("2024-01-01=8, 2024-01-02=4; 2024-01-03=2");
      expect(result["2024-01-01"]).toBe(8);
      expect(result["2024-01-02"]).toBe(4);
      expect(result["2024-01-03"]).toBe(2);
    });

    it("parseWorkloadMap returns empty object for empty string", () => {
      expect(parseWorkloadMap("")).toEqual({});
    });
  });

  describe("extractSection", () => {
    it("extractSection returns empty string if heading not found", () => {
      const content = `# Main
Some content`;
      const result = extractSection(content, "Missing Heading", 2);
      expect(result).toBe("");
    });

    it("extractSection returns content from heading to next equal/higher level heading", () => {
      const content = `# Main
Content 1
## Section A
Content A
## Section B
Content B`;
      const result = extractSection(content, "Section A", 2);
      expect(result).toBe("Content A");
    });

    it("extractSection returns trimmed content", () => {
      const content = `## Section

Content with spaces
  `;
      const result = extractSection(content, "Section", 2);
      expect(result).toBe("Content with spaces");
    });

    it("extractSection stops at next same-or-higher level heading", () => {
      const content = `## Section A
Content A
### Subsection
Sub content
## Section B
Content B`;
      const result = extractSection(content, "Section A", 2);
      expect(result).toContain("Content A");
      expect(result).toContain("Sub content");
      expect(result).not.toContain("Content B");
    });

    it("deeper heading does NOT terminate the section", () => {
      const content = `## Section
Outer content
### Subsection
Inner content
End of section`;
      const result = extractSection(content, "Section", 2);
      expect(result).toContain("Outer content");
      expect(result).toContain("### Subsection");
      expect(result).toContain("Inner content");
      expect(result).toContain("End of section");
    });

    it("extractSection handles heading with regex metacharacters", () => {
      const content = `## Section [Test] (1)
Content`;
      const result = extractSection(content, "Section [Test] (1)", 2);
      expect(result).toBe("Content");
    });

    it("extractSection handles regex chars in heading literally", () => {
      const content = `## Section.*+?
Content
## Another`;
      const result = extractSection(content, "Section.*+?", 2);
      expect(result).toBe("Content");
    });
  });

  describe("splitSubtasksSection", () => {
    it("splitSubtasksSection splits by ### headings", () => {
      const body = `### Task 1
Content 1
### Task 2
Content 2`;
      const result = splitSubtasksSection(body);
      expect(result).toHaveLength(2);
      expect(result[0].title).toBe("Task 1");
      expect(result[0].body).toBe("Content 1");
      expect(result[1].title).toBe("Task 2");
      expect(result[1].body).toBe("Content 2");
    });

    it("splitSubtasksSection heading-only part yields empty body", () => {
      const body = `### Task 1
### Task 2`;
      const result = splitSubtasksSection(body);
      expect(result).toHaveLength(2);
      expect(result[0].title).toBe("Task 1");
      expect(result[0].body).toBe("");
      expect(result[1].title).toBe("Task 2");
      expect(result[1].body).toBe("");
    });

    it("splitSubtasksSection empty string returns empty array", () => {
      expect(splitSubtasksSection("")).toEqual([]);
    });

    it("splitSubtasksSection multiline body content", () => {
      const body = `### Task 1
Line 1
Line 2
Line 3
### Task 2
Content 2`;
      const result = splitSubtasksSection(body);
      expect(result[0].body).toBe("Line 1\nLine 2\nLine 3");
    });
  });

  describe("parseTaskFile", () => {
    const settings: TaskWorkbenchSettings = DEFAULT_SETTINGS;


    it("round-trips parent YAML tags and subtask/marker CSV tags", () => {
      const parentTags = ["親タグ", "重要タグ"];
      const subtaskTags = ["子タグ", "レビュー"];
      const markerTags = ["マーカー", "期限"];
      const subtask = makeSubtask("s1", {
        tags: subtaskTags,
        ganttMarkers: [
          { key: "m1", title: "締切", date: "2026-07-10", tags: markerTags },
        ],
      });
      const subtasks = new Map([["s1", subtask]]);
      // buildBody reads subtasks from task.subtasks (not the subtaskMap
      // param — that param is only consumed by buildFrontmatter), so both
      // must be populated for buildFullNote to emit a full round-trippable note.
      const parent = makeParent({ tags: parentTags, subtasks });
      const note = buildFullNote(parent, subtasks, settings);

      const parsed = parseTaskFile(
        { path: "tasks/2026/07/P.md" },
        note,
        settings
      );

      expect(parsed?.tags).toEqual(parentTags);
      const parsedSubtask = parsed?.subtasks?.get("s1");
      expect(parsedSubtask?.tags).toEqual(subtaskTags);
      expect(parsedSubtask?.ganttMarkers?.[0]?.tags).toEqual(markerTags);
    });

    it("preserves empty tag slots for parent, subtask, and marker CSV and bracket arrays", () => {
      const parentTags = ["親タグ", "", "重要タグ"];
      const subtaskTags = ["子タグ", "", "レビュー"];
      const markerTags = ["マーカー", "", "期限"];
      const subtask = makeSubtask("s1", {
        tags: subtaskTags,
        ganttMarkers: [
          { key: "m1", title: "締切", date: "2026-07-10", tags: markerTags },
        ],
      });
      const subtasks = new Map([["s1", subtask]]);
      const parent = makeParent({ tags: parentTags, subtasks });
      const note = buildFullNote(parent, subtasks, settings);

      const assertTags = (content: string): void => {
        const parsed = parseTaskFile(
          { path: "tasks/2026/07/P.md" },
          content,
          settings
        );
        expect(parsed?.tags).toEqual(parentTags);
        const parsedSubtask = parsed?.subtasks?.get("s1");
        expect(parsedSubtask?.tags).toEqual(subtaskTags);
        expect(parsedSubtask?.ganttMarkers?.[0]?.tags).toEqual(markerTags);
      };

      // Parent tags use YAML arrays; child and marker tags still use CSV.
      assertTags(note);

      // Legacy parent CSV remains readable, including empty slots.
      assertTags(note.replace('tags: ["親タグ","","重要タグ"]', "tags: 親タグ,,重要タグ"));

      // Older bracket-wrapped CSV with empty slots also remains readable.
      assertTags(
        note
          .replace('tags: ["親タグ","","重要タグ"]', "tags: [親タグ,,重要タグ]")
          .replace(
            "subtask__s1__tags: 子タグ,,レビュー",
            "subtask__s1__tags: [子タグ,,レビュー]"
          )
          .replace(
            "subtask__s1__ganttMarker__m1__tags: マーカー,,期限",
            "subtask__s1__ganttMarker__m1__tags: [マーカー,,期限]"
          )
      );
    });


    it.each([
      ["block list", "tags:\n  - work\n  - urgent"],
      ["unindented block list", "tags:\n- work\n- urgent"],
      ["flow list", "tags: [work, urgent]"],
      ["quoted flow list", 'tags: ["work", \'urgent\'] # comment'],
      ["multiline flow list", 'tags: [\n  "work",\n  "urgent"\n]'],
      ["legacy CSV", "tags: work,urgent"],
      ["quoted legacy CSV", 'tags: "work,urgent"'],
    ])("reads %s parent tags and preserves them after saving", (_name, tagField) => {
      const content = `---\ntype: task\n${tagField}\npriority: 2\npriorityMode: manual\n---\n# Parent`;
      const parsed = parseTaskFile({ path: "test/file.md" }, content, settings)!;
      expect(parsed.tags).toEqual(["work", "urgent"]);
      expect(parsed.priority).toBe(2);
      const saved = buildFullNote(parsed, undefined, settings);
      expect(saved).toContain('tags: ["work","urgent"]');
      expect(parseTaskFile({ path: "test/file.md" }, saved, settings)?.tags)
        .toEqual(["work", "urgent"]);
    });

    it("keeps leading hash characters in legacy CSV tags", () => {
      const content = "---\ntype: task\ntags: #work,#urgent\n---";
      const parsed = parseTaskFile({ path: "test/file.md" }, content, settings)!;
      expect(parsed.tags).toEqual(["#work", "#urgent"]);
      const saved = buildFullNote(parsed, undefined, settings);
      expect(parseTaskFile({ path: "test/file.md" }, saved, settings)?.tags)
        .toEqual(["#work", "#urgent"]);
    });

    it("preserves quoted YAML tag values with punctuation and escapes", () => {
      const tags = ["work,urgent", "colon: value", "#hash", 'a"b', "a\\b", "a\nb", "", "日本語"];
      const note = buildFullNote(makeParent({ tags }), undefined, settings);
      const parsed = parseTaskFile({ path: "test/file.md" }, note, settings);
      expect(parsed?.tags).toEqual(tags);
      // Colons inside list items must not become frontmatter fields.
      const block = `---\ntype: task\ntags:\n  - 'colon: value'\n  - 'it''s work'\n---`;
      expect(parseFrontmatter(block)).toEqual({ type: "task", tags: ["colon: value", "it's work"] });
    });

    it.each(["tags:", "tags: []", "tags: null", 'tags: ""'])(
      "reads empty parent tags (%s) and writes an empty YAML array",
      (tagField) => {
        const parsed = parseTaskFile({ path: "test/file.md" }, `---\ntype: task\n${tagField}\n---`, settings)!;
        expect(parsed.tags).toEqual([]);
        expect(buildFrontmatter(parsed)).toContain("tags: []");
      }
    );

    it("parseTaskFile returns null when type !== 'task'", () => {
      const content = `---
type: note
---
Content`;
      const result = parseTaskFile(
        { path: "test/file.md" },
        content,
        settings
      );
      expect(result).toBeNull();
    });

    it("parseTaskFile displayName from frontmatter first", () => {
      const content = `---
type: task
displayName: "From Frontmatter"
---
# Heading Name
Content`;
      const result = parseTaskFile(
        { path: "test/file.md" },
        content,
        settings
      );
      expect(result?.displayName).toBe("From Frontmatter");
    });

    it("parseTaskFile displayName from first heading if no frontmatter", () => {
      const content = `---
type: task
---
# Heading Name
Content`;
      const result = parseTaskFile(
        { path: "test/file.md" },
        content,
        settings
      );
      expect(result?.displayName).toBe("Heading Name");
    });

    it("parseTaskFile displayName from basename if no frontmatter or heading", () => {
      const content = `---
type: task
---
Content`;
      const result = parseTaskFile(
        { path: "folder/myfile.md" },
        content,
        settings
      );
      expect(result?.displayName).toBe("myfile.md");
    });

    it("parseTaskFile drops markers with missing date during parse", () => {
      const content = `---
type: task
displayName: "Test"
subtaskOrder: [task-1]
subtask__task-1__ganttMarkerOrder: [m1, m2]
subtask__task-1__ganttMarker__m1__title: "Marker 1"
subtask__task-1__ganttMarker__m1__date: 2024-01-01
subtask__task-1__ganttMarker__m2__title: "Marker 2"
---
## Subtasks
### Task 1`;
      const result = parseTaskFile(
        { path: "test/file.md" },
        content,
        settings
      );
      const subtask = result?.subtasks?.get("task-1");
      // m2 should be dropped because it has no date field (defaults to empty string)
      expect(subtask?.ganttMarkers?.length || 0).toBe(1);
      expect(subtask?.ganttMarkers?.[0].key).toBe("m1");
    });

    it("parseTaskFile reuses subtaskOrder keys when present and unused", () => {
      const content = `---
type: task
displayName: "Test"
subtaskOrder: [key1, key2]
---
## Subtasks
### First Task
### Second Task`;
      const result = parseTaskFile(
        { path: "test/file.md" },
        content,
        settings
      );
      expect(result?.subtasks?.has("key1")).toBe(true);
      expect(result?.subtasks?.has("key2")).toBe(true);
    });

    it("parseTaskFile ignores extra subtaskOrder entries", () => {
      const content = `---
type: task
displayName: "Test"
subtaskOrder: [key1, key2, key3, key4]
---
## Subtasks
### First Task
### Second Task`;
      const result = parseTaskFile(
        { path: "test/file.md" },
        content,
        settings
      );
      expect(result?.subtasks?.size).toBe(2);
    });

    it("parseTaskFile defaults createdAt to todayStr if missing", () => {
      beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-07-27"));
      });

      afterEach(() => {
        vi.restoreAllMocks();
      });

      const content = `---
type: task
displayName: "Test"
---
Content`;
      const result = parseTaskFile(
        { path: "test/file.md" },
        content,
        settings
      );
      expect(result?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("parseTaskFile loads inconsistent statusLabel/completed without error", () => {
      const content = `---
type: task
displayName: "Test"
statusLabel: done
completed: false
---
Content`;
      const result = parseTaskFile(
        { path: "test/file.md" },
        content,
        settings
      );
      expect(result?.statusLabel).toBe("done");
      expect(result?.completed).toBe(false);
    });

    it("parseTaskFile loads file with inconsistent status/completed during load", () => {
      const content = `---
type: task
displayName: "Test"
statusLabel: active
completed: true
---
Content`;
      // Load should NOT throw - inconsistency is only checked during patch update
      const result = parseTaskFile(
        { path: "test/file.md" },
        content,
        settings
      );
      expect(result).not.toBeNull();
      expect(result?.statusLabel).toBe("active");
      expect(result?.completed).toBe(true);
    });

    it("parseTaskFile completed field is a boolean, not a string", () => {
      const content = `---
type: task
displayName: "Test"
completed: true
---
Content`;
      const result = parseTaskFile({ path: "test/file.md" }, content, settings);
      expect(typeof result?.completed).toBe("boolean");
      expect(result?.completed).toBe(true);
    });

    it("parseTaskFile generates a new key when subtaskOrder[i] is missing", () => {
      const content = `---
type: task
displayName: "Test"
subtaskOrder: [key1]
---
## Subtasks
### First Task
### Second Task`;
      const result = parseTaskFile({ path: "test/file.md" }, content, settings);
      expect(result?.subtasks?.has("key1")).toBe(true);
      // Second Task has no subtaskOrder[1] entry, so a key is generated from its title
      expect(result?.subtasks?.has("second-task")).toBe(true);
    });

    it("parseTaskFile generates a new key when subtaskOrder[i] is already used", () => {
      const content = `---
type: task
displayName: "Test"
subtaskOrder: [dup, dup]
---
## Subtasks
### First Task
### Second Task`;
      const result = parseTaskFile({ path: "test/file.md" }, content, settings);
      expect(result?.subtasks?.has("dup")).toBe(true);
      // Second occurrence of "dup" is already used, so it falls back to a generated key
      expect(result?.subtasks?.has("second-task")).toBe(true);
      expect(result?.subtasks?.size).toBe(2);
    });

    it("parseTaskFile: reordering headings without updating subtaskOrder mis-correlates keys to titles", () => {
      // subtaskOrder says [alpha, beta], correlated positionally to headings in document order
      const original = `---
type: task
displayName: "Test"
subtaskOrder: [alpha, beta]
---
## Subtasks
### Alpha Task
### Beta Task`;
      const reordered = `---
type: task
displayName: "Test"
subtaskOrder: [alpha, beta]
---
## Subtasks
### Beta Task
### Alpha Task`;

      const before = parseTaskFile({ path: "test/file.md" }, original, settings);
      const after = parseTaskFile({ path: "test/file.md" }, reordered, settings);

      // Before reorder: key "alpha" correlates with "Alpha Task"
      expect(before?.subtasks?.get("alpha")?.title).toBe("Alpha Task");
      // After reordering headings without updating subtaskOrder, key "alpha" now
      // incorrectly correlates with "Beta Task" (position-based correlation is broken)
      expect(after?.subtasks?.get("alpha")?.title).toBe("Beta Task");
    });
  });

  describe("buildFrontmatter", () => {
    it("buildFrontmatter includes all required parent fields", () => {
      const fm = buildFrontmatter(makeParent());
      for (const field of [
        "type: task",
        "cssclass: task",
        "statusLabel:",
        "createdAt:",
        "updatedAt:",
        "dueDate:",
        "priority:",
        "priorityMode:",
        "tags:",
        "completed:",
        'displayName: "Parent"',
        "ganttEnabled:",
        "ganttOrder:",
        "subtaskOrder:",
      ]) {
        expect(fm).toContain(field);
      }
    });

    it("buildFrontmatter prefixes subtask fields with subtask__{key}__{field}", () => {
      // plannedStartDate, plannedEndDate, dueDate, and statusLabel are stored
      // in the note body rather than as frontmatter keys. The workload fields
      // are serialized as literal frontmatter keys, as the next test confirms.
      const subs = new Map([["s1", makeSubtask("s1")]]);
      const fm = buildFrontmatter(makeParent(), subs);
      for (const field of [
        "title",
        "statusLabel",
        "createdAt",
        "updatedAt",
        "dueDate",
        "plannedStartDate",
        "plannedEndDate",
        "workloadPlan",
        "workloadActual",
        "priority",
        "priorityMode",
        "tags",
        "completed",
        "ganttMarkerOrder",
      ]) {
        expect(fm).toContain(`subtask__s1__${field}:`);
      }
    });

    it("buildFrontmatter quotes subtask title/workload fields and uses parent YAML and subtask CSV tags", () => {
      const subs = new Map([
        [
          "s1",
          makeSubtask("s1", {
            displayName: "Sub One",
            tags: ["x", "y"],
            workloadPlan: { "2026-07-05": 3 },
          }),
        ],
      ]);
      const fm = buildFrontmatter(makeParent(), subs);
      expect(fm).toContain('subtask__s1__title: "Sub One"');
      expect(fm).toContain('subtask__s1__workloadPlan: "2026-07-05=3"');
      expect(fm).toContain('tags: ["a"]');
      expect(fm).toContain("subtask__s1__tags: x,y");
    });

    it("buildFrontmatter prefixes marker fields with subtask__{key}__ganttMarker__{markerKey}__{field}", () => {

      // Markers use {key, title, date} objects in memory, but frontmatter
      // stores each field under a separate scalar key rather than as a YAML
      // array. The following assertions verify the serialized form.
      const subs = new Map([
        [
          "s1",
          makeSubtask("s1", {
            ganttMarkers: [{ key: "m1", title: "Marker", date: "2026-07-10", tags: ["t"] }],
          }),
        ],
      ]);
      const fm = buildFrontmatter(makeParent(), subs);
      expect(fm).toContain('subtask__s1__ganttMarker__m1__title: "Marker"');
      expect(fm).toContain("subtask__s1__ganttMarker__m1__date: 2026-07-10");
      expect(fm).toContain("subtask__s1__ganttMarker__m1__tags: t");
    });
  });

  describe("buildBody", () => {
    it("buildBody includes heading, dashboard blocks, Current Status, Notes", () => {
      const task = makeParent({
        displayName: "My Task",
        currentStatus: "status text",
        notes: "note text",
      });
      const body = buildBody(task);
      expect(body).toContain("# My Task");
      expect(body).toMatch(/INPUT\[/);
      expect(body).toContain("## Current Status");
      expect(body).toContain("status text");
      expect(body).toContain("## Notes");
      expect(body).toContain("note text");
    });

    it("buildBody renders Subtasks section with per-subtask dashboard/status/notes", () => {
      const sub = makeSubtask("s1", {
        displayName: "Sub One",
        currentStatus: "sub status",
        notes: "sub notes",
      });
      const subs = new Map([["s1", sub]]);
      const task = makeParent({ subtasks: subs });
      const body = buildBody(task, subs);
      expect(body).toContain("## Subtasks");
      expect(body).toContain("### Sub One");
      expect(body).toMatch(/subtask__s1__statusLabel/);
      expect(body).toContain("#### Current Status");
      expect(body).toContain("sub status");
      expect(body).toContain("#### Notes");
      expect(body).toContain("sub notes");
    });
  });

  describe("yamlEscape", () => {
    it("yamlEscape escapes double quotes to backslash-quote", () => {
      expect(yamlEscape('hello"world')).toBe('hello\\"world');
    });

    it("yamlEscape does not escape single quotes", () => {
      expect(yamlEscape("hello'world")).toBe("hello'world");
    });

    it("yamlEscape does not escape backslashes", () => {
      expect(yamlEscape("hello\\world")).toBe("hello\\world");
    });

    it("yamlEscape does not escape newlines", () => {
      expect(yamlEscape("hello\nworld")).toBe("hello\nworld");
    });

    it("yamlEscape multiple quotes", () => {
      expect(yamlEscape('"a"b"c"')).toBe('\\"a\\"b\\"c\\"');
    });

    it("yamlEscape empty string", () => {
      expect(yamlEscape("")).toBe("");
    });
  });
});
