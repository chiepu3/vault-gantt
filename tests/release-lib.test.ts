import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs helper without type declarations
import { bumpVersion, collectChanges, decideBump, parseTitle, prependChangelog, renderNotes } from "../tools/release/release-lib.mjs";

const merge = (n: number, title: string) => ({ subject: `Merge pull request #${n} from x/y`, body: `\n${title}\n\nbody` });

describe("release-lib", () => {
  it("parses conventional prefixes and falls back to other", () => {
    expect(parseTitle("feat(gantt): バー")).toMatchObject({ type: "feat", scope: "gantt", subject: "バー" });
    expect(parseTitle("fix!: x")).toMatchObject({ type: "fix", breaking: true });
    expect(parseTitle("ポップオーバーを直す")).toMatchObject({ type: "other" });
    expect(parseTitle("Browser previews: of every branch")).toMatchObject({ type: "other" });
  });

  it("takes titles from merge commit bodies and squash subjects, ignoring release commits", () => {
    const changes = collectChanges([
      merge(5, "feat(ui): a"),
      { subject: "fix: b (#6)", body: "" },
      { subject: "chore(release): v1.0.0", body: "" },
    ]);
    expect(changes.map((c: { pr: number }) => c.pr)).toEqual([5, 6]);
  });

  it("decides the bump", () => {
    const bump = (...titles: string[]) => decideBump(collectChanges(titles.map((t, i) => merge(i, t))));
    expect(bump("fix: a", "feat: b")).toBe("minor");
    expect(bump("fix: a", "docs: b")).toBe("patch");
    expect(bump("日本語タイトル")).toBe("patch");
    expect(bump("refactor!: a")).toBe("minor");
    expect(bump("docs: a", "ci: b", "chore: c", "test: d")).toBeNull();
  });

  it("bumps versions", () => {
    expect(bumpVersion("0.3.0", "patch")).toBe("0.3.1");
    expect(bumpVersion("0.3.4", "minor")).toBe("0.4.0");
  });

  it("renders notes and prepends to the changelog", () => {
    const notes = renderNotes(collectChanges([merge(7, "feat(a): x"), merge(8, "docs: skip"), merge(9, "直した")]), "https://h/r");
    expect(notes).toContain("### 新機能\n\n- **a**: x ([#7](https://h/r/pull/7))");
    expect(notes).toContain("### その他の変更\n\n- 直した");
    expect(notes).not.toContain("skip");
    const first = prependChangelog("", "0.4.0", "2026-10-17", notes);
    const second = prependChangelog(first, "0.4.1", "2026-10-18", "### 修正\n\n- y\n");
    expect(second.indexOf("## v0.4.1")).toBeLessThan(second.indexOf("## v0.4.0"));
    expect(second.match(/^# 変更履歴/gm)).toHaveLength(1);
  });
});
