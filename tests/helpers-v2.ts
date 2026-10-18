import { stringifyYaml } from "obsidian";

/** Builders for v2 task notes used across tests. */
export function parentNoteText(fields: Record<string, unknown> = {}, body = "## 現状\n\n## メモ\n"): string {
  const fm = { type: "task", formatVersion: 2, id: "t-aaaaaa", title: "親", status: "active", completed: false, created: "2026-10-01", updated: "2026-10-01", tags: [], gantt: true, cssclasses: ["task"], ...fields };
  return `---\n${stringifyYaml(fm)}---\n${body}`;
}

export function subtaskNoteText(fields: Record<string, unknown> = {}, body = "## 現状\n\n## メモ\n"): string {
  const fm = { type: "subtask", formatVersion: 2, id: "s-aaaaaa", title: "子", parent: "[[親]]", status: "active", completed: false, created: "2026-10-02", updated: "2026-10-02", tags: [], cssclasses: ["task"], ...fields };
  return `---\n${stringifyYaml(fm)}---\n${body}`;
}
