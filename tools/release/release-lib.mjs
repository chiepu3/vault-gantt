// Pure helpers for the automatic release workflow (.github/workflows/release.yml).
// Kept free of git/network access so they can be unit-tested.

// Conventional Commit types and how they affect the version. While the project
// is 0.x, breaking changes bump MINOR as well (see CONTRIBUTING.md).
const MINOR_TYPES = new Set(["feat"]);
const PATCH_TYPES = new Set(["fix", "perf", "refactor", "revert"]);
const SILENT_TYPES = new Set(["docs", "ci", "chore", "test", "build", "style"]);

const TYPE_TITLES = {
  feat: "新機能",
  fix: "修正",
  perf: "高速化",
  refactor: "内部改善",
  revert: "取り消し",
  other: "その他の変更",
};
const SECTION_ORDER = ["feat", "fix", "perf", "refactor", "revert", "other"];

const PREFIX = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;

/** "feat(ui): foo" -> { type: "feat", scope: "ui", breaking: false, subject: "foo" }. A title without a prefix is type "other". */
export function parseTitle(title) {
  const text = title.trim();
  const m = PREFIX.exec(text);
  if (!m) return { type: "other", scope: "", breaking: false, subject: text };
  const type = m[1].toLowerCase();
  if (!MINOR_TYPES.has(type) && !PATCH_TYPES.has(type) && !SILENT_TYPES.has(type)) {
    return { type: "other", scope: "", breaking: false, subject: text };
  }
  return { type, scope: m[2] ?? "", breaking: Boolean(m[3]), subject: m[4].trim() };
}

/**
 * Turn `git log --first-parent` entries into change entries. Merge commits carry the PR
 * title in their body; squash commits carry it in the subject as "title (#N)".
 * Release commits are ignored.
 */
export function collectChanges(commits) {
  const changes = [];
  for (const { subject, body } of commits) {
    if (/^chore\(release\):/.test(subject)) continue;
    let title = subject;
    let pr = null;
    const merge = /^Merge pull request #(\d+)/.exec(subject);
    if (merge) {
      pr = Number(merge[1]);
      title = body.split("\n").map((l) => l.trim()).find((l) => l) ?? subject;
    } else {
      const squash = /^(.*)\s\(#(\d+)\)$/.exec(subject);
      if (squash) {
        title = squash[1];
        pr = Number(squash[2]);
      }
    }
    if (/^Merge (branch|remote-tracking)/.test(title)) continue;
    changes.push({ ...parseTitle(title), pr, title });
  }
  return changes;
}

/** "major" is never chosen automatically: it is a deliberate manual `npm version major`. */
export function decideBump(changes) {
  let bump = null;
  for (const c of changes) {
    if (MINOR_TYPES.has(c.type) || (c.breaking && !SILENT_TYPES.has(c.type))) return "minor";
    if (!SILENT_TYPES.has(c.type)) bump = "patch";
  }
  return bump;
}

export function bumpVersion(version, bump) {
  const [major, minor, patch] = version.split(".").map(Number);
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`unsupported bump: ${bump}`);
}

/** Markdown for one release: grouped sections, PR numbers linked when `repoUrl` is given. */
export function renderNotes(changes, repoUrl) {
  const lines = [];
  for (const type of SECTION_ORDER) {
    const items = changes.filter((c) => !SILENT_TYPES.has(c.type) && (SECTION_ORDER.includes(c.type) ? c.type : "other") === type);
    if (items.length === 0) continue;
    lines.push(`### ${TYPE_TITLES[type]}`, "");
    for (const c of items) {
      const ref = c.pr ? ` ([#${c.pr}](${repoUrl}/pull/${c.pr}))` : "";
      const scope = c.scope ? `**${c.scope}**: ` : "";
      lines.push(`- ${scope}${c.subject}${ref}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** Insert a release section right after the CHANGELOG.md header. */
export function prependChangelog(existing, version, date, notes) {
  const header = "# 変更履歴\n\nバージョンは自動で更新されます（[CONTRIBUTING.md](CONTRIBUTING.md) 参照）。\n";
  const body = existing.startsWith("# 変更履歴") ? existing.slice(existing.indexOf("\n## ")).replace(/^\n+/, "") : "";
  const section = `## v${version} (${date})\n\n${notes}`;
  return `${header}\n${section}${body ? "\n" + body : ""}`;
}
