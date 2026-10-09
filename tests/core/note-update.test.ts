import { describe, expect, it } from "vitest";
import { mergeTaskNote } from "../../src/core/note-update";

const before = '---\ntype: task\ndueDate: \n---\n\n# タスク\n\n## Current Status\n\n## Notes\nメモ\n';
const after = before.replace('dueDate: ', 'dueDate: 2026-10-20');

describe("mergeTaskNote", () => {
  it("preserves custom YAML blocks, comments, preamble and sections verbatim", () => {
    const extras = '# 顧客情報\nproject: 顧客A\nlinks:\n  - https://example.com\nsettings:\n  color: blue\n';
    const section = '## 参考資料\n\n```md\n### 見出しの例\n```\n';
    const original = before.replace('type: task\n', `type: task\n${extras}`)
      .replace('## Current Status', `${section}\n## Current Status`)
      .replace('# タスク\n', '# タスク\n\n導入文\n');
    const result = mergeTaskNote(original, before, after);
    expect(result).toContain(extras);
    expect(result).toContain(section);
    expect(result).toContain('導入文');
    expect(result).toContain('dueDate: 2026-10-20');
    expect(mergeTaskNote(result, after, before)).toContain(extras);
  });

  it("replaces managed keys with whitespace before the colon", () => {
    const result = mergeTaskNote(before.replace("dueDate:", "dueDate :"), before, after);
    expect(result).toContain("dueDate: 2026-10-20");
    expect(result).not.toContain("dueDate :");
  });

  it("keeps custom preamble when the title changes", () => {
    const original = before.replace('# タスク\n', '# タスク\n独自の説明\n');
    const result = mergeTaskNote(original, before, before.replace('# タスク', '# 新しい名前'));
    expect(result).toContain('# 新しい名前\n独自の説明\n');
  });

  it("updates Notes while preserving an adjacent custom section", () => {
    const custom = '\n## 参考資料\n資料\n';
    const result = mergeTaskNote(before + custom, before, before.replace('メモ', '更新後'));
    expect(result).toContain('## Notes\n更新後\n');
    expect(result).toContain(custom.trim());
  });

  it("refuses to drop custom content inside a changed managed section", () => {
    const subtasks = '\n## Subtasks\n\n### 作業\n\n#### Notes\nメモ\n';
    const original = before + subtasks + '\n#### 参考資料\n資料\n';
    expect(() => mergeTaskNote(original, before + subtasks, before + subtasks.replace('作業', '変更')))
      .toThrow('保持できない記述があります: ## Subtasks');
    expect(mergeTaskNote(original, before + subtasks, after + subtasks)).toContain('#### 参考資料\n資料');
  });

  it("refuses duplicate managed headings and multiline managed values", () => {
    expect(() => mergeTaskNote(before + '\n## Notes\n別のメモ', before, after))
      .toThrow('同じ見出しが複数あります: ## Notes');
    expect(() => mergeTaskNote(before.replace('dueDate: ', 'dueDate: |\n  手書き'), before, after))
      .toThrow('frontmatterに保持できない記述があります');
  });

  it("removes deleted managed keys but preserves custom subtask keys", () => {
    const oldNote = before.replace('type: task', 'type: task\nsubtask__a__title: 作業');
    const original = oldNote.replace('type: task', 'type: task\nsubtask__a__project: 顧客A');
    const result = mergeTaskNote(original, oldNote, before);
    expect(result).not.toContain('subtask__a__title:');
    expect(result).toContain('subtask__a__project: 顧客A');
  });

  it("handles CRLF notes without duplicating sections", () => {
    const original = (before + '\n## 参考資料\n資料\n').replace(/\n/g, '\r\n');
    const result = mergeTaskNote(original, before, before.replace('メモ', '更新後'));
    expect(result).toContain('## Notes\n更新後');
    expect(result).toContain('## 参考資料\r\n資料\r\n');
    expect(result.match(/## Notes/g)).toHaveLength(1);
  });
});
