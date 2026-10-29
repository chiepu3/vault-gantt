import { describe, expect, it } from "vitest";
import { stringifyYaml } from "obsidian";
import { generateMemoId, isMemoId, isTaskId } from "../../src/core/ids";
import {
  MEMO_MAX_WIDTH, MEMO_MIN_WIDTH, buildMemoNote, isMemoPath, memoBody, memoFileStem, memoHeadline, memoRoot, normalizeMemoLayout, parseMemoMeta, replaceMemoBody,
} from "../../src/core/memo";
import { noteKindOf } from "../../src/core/note-v2";
import { parseYaml } from "obsidian";
import { splitFrontmatter } from "../../src/core/note-v2";

const fmOf = (content: string) => parseYaml(splitFrontmatter(content).front.replace(/^---\n/, "").replace(/\n---\n?$/, "")) as Record<string, unknown>;

describe("memo ids", () => {
  it("are m- plus six base36 characters, unique among used ids, and never task ids", () => {
    const used = new Set(["m-aaaaaa"]);
    const id = generateMemoId(used, () => 0);
    expect(id).toBe("m-000000");
    expect(used.has(id)).toBe(true);
    expect(generateMemoId(used, (() => { let n = 0; return () => (n++ < 6 ? 0 : 0.5); })())).toBe("m-iiiiii");
    expect(isMemoId("m-7k3q9x")).toBe(true);
    expect(isMemoId("s-7k3q9x")).toBe(false);
    expect(isMemoId("m-ABCDEF")).toBe(false);
    expect(isTaskId("m-7k3q9x")).toBe(false);
  });
});

describe("memo notes", () => {
  const meta = { id: "m-7k3q9x", taskId: "s-p2m8vd", at: 3, date: "2026-10-23", created: "2026-10-22", updated: "2026-10-22" };

  it("writes the documented frontmatter and the text as the body", () => {
    const content = buildMemoNote(meta, "API仕様を確認\r\n→ 木曜", stringifyYaml);
    expect(content).toBe("---\ntype: gantt-memo\nid: m-7k3q9x\ntask: s-p2m8vd\nat: 3\ndate: 2026-10-23\ncreated: 2026-10-22\nupdated: 2026-10-22\n---\nAPI仕様を確認\n→ 木曜\n");
    expect(memoBody(content)).toBe("API仕様を確認\n→ 木曜");
  });

  it("omits task and at for a free memo", () => {
    const content = buildMemoNote({ id: "m-aaaaaa", date: "2026-11-10", created: "2026-10-22", updated: "2026-10-22" }, "休業日", stringifyYaml);
    expect(Object.keys(fmOf(content))).toEqual(["type", "id", "date", "created", "updated"]);
  });

  it("round-trips through parseMemoMeta and is never a task note", () => {
    const content = buildMemoNote(meta, "本文", stringifyYaml);
    const fm = fmOf(content);
    expect(noteKindOf(fm)).toBeNull();
    expect(parseMemoMeta("tasks/_memos/a.md", fm)).toEqual({ ...meta, path: "tasks/_memos/a.md" });
  });

  it("rejects notes without the memo type or a valid id, and ignores bad at/date values", () => {
    expect(parseMemoMeta("a.md", { type: "task", id: "m-aaaaaa" })).toBeNull();
    expect(parseMemoMeta("a.md", { type: "gantt-memo", id: "s-aaaaaa" })).toBeNull();
    expect(parseMemoMeta("a.md", null)).toBeNull();
    const parsed = parseMemoMeta("a.md", { type: "gantt-memo", id: "m-aaaaaa", at: -2, date: "soon", created: "2026-10-01" })!;
    expect(parsed.at).toBeUndefined();
    expect(parsed.date).toBeUndefined();
    expect(parsed.updated).toBe("2026-10-01");
  });

  it("replaces only the body and the updated stamp", () => {
    const content = "---\ntype: gantt-memo\nid: m-aaaaaa\ncustom: keep\ncreated: 2026-10-01\nupdated: 2026-10-01\n---\n古い本文\n";
    expect(replaceMemoBody(content, "新しい本文\n2行目", "2026-10-29")).toBe("---\ntype: gantt-memo\nid: m-aaaaaa\ncustom: keep\ncreated: 2026-10-01\nupdated: 2026-10-29\n---\n新しい本文\n2行目\n");
  });

  it("names the file after the date and the first line, sanitized and shortened", () => {
    expect(memoFileStem("API仕様: 確認/要\n2行目", "2026-10-29")).toBe("2026-10-29 API仕様： 確認／要");
    const long = memoFileStem("あ".repeat(80), "2026-10-29");
    expect(Array.from(long).length).toBe(11 + 40);
    expect(memoFileStem("  \n", "2026-10-29")).toBe("2026-10-29 無題");
    expect(memoHeadline("あ".repeat(30))).toBe(`${"あ".repeat(24)}…`);
  });

  it("lives in <taskFolder>/_memos/", () => {
    expect(memoRoot({ taskFolder: "tasks/" })).toBe("tasks/_memos");
    expect(isMemoPath("tasks/_memos/x.md", { taskFolder: "tasks" })).toBe(true);
    expect(isMemoPath("tasks/x.md", { taskFolder: "tasks" })).toBe(false);
  });
});

describe("normalizeMemoLayout", () => {
  it("keeps valid entries, clamps the width and drops garbage", () => {
    expect(normalizeMemoLayout({
      "m-a": { open: false, dx: 10.4, dy: -3, w: 9999 },
      "m-b": { dx: "x", w: 1 },
      "m-c": "nope",
    })).toEqual({
      "m-a": { open: false, dx: 10, dy: -3, w: MEMO_MAX_WIDTH },
      "m-b": { open: true, dx: 0, dy: 0, w: MEMO_MIN_WIDTH },
    });
    expect(normalizeMemoLayout(undefined)).toEqual({});
    expect(normalizeMemoLayout([])).toEqual({});
  });
});
