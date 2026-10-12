import { parseYaml } from "obsidian";

export class NotePreservationError extends Error {}

/** Merge generated task fields into the original note without dropping user content. */
export function mergeTaskNote(original: string, before: string, after: string): string {
  const split = (note: string) => {
    const match = note.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) {
      throw new NotePreservationError("保存できません。ノート先頭のfrontmatterを確認してください。");
    }
    return { frontmatter: match[1], body: note.slice(match[0].length) };
  };
  const source = split(original);
  const previous = split(before);
  const next = split(after);
  const managedKeys = new Set(
    [previous.frontmatter, next.frontmatter].flatMap((fm) =>
      fm.split("\n").map((line) => line.slice(0, line.indexOf(":")))
    )
  );
  const extra: string[] = [];
  const lines = source.frontmatter.split(/\r?\n/);
  const keyOf = (line: string) => line.match(/^([^\s#-][^:]*):/)?.[1].trim();
  for (let index = 0; index < lines.length; index++) {
    const key = keyOf(lines[index]);
    if (!key || !managedKeys.has(key)) {
      extra.push(lines[index]);
      continue;
    }
    const block = [lines[index]];
    while (index + 1 < lines.length && !keyOf(lines[index + 1])) {
      block.push(lines[++index]);
    }
    const comments = block.slice(1).filter((line) => /^\s*(?:#.*)?$/.test(line));
    if (block.slice(1).some((line) => !/^\s*(?:#.*)?$/.test(line))) {
      // Replace a multiline value only when its YAML meaning matches the
      // generated before-value. Unsupported values must not silently disappear.
      let safe = false;
      try {
        const parsed = parseYaml(block.join("\n")) as Record<string, unknown>;
        const oldLine = previous.frontmatter.split("\n").find((line) => keyOf(line) === key);
        const oldValue = oldLine ? (parseYaml(oldLine) as Record<string, unknown>)[key] : undefined;
        const value = parsed[key];
        if (key === "tags" && Array.isArray(value) && Array.isArray(oldValue)) {
          safe = value.every((tag) => tag === null || ["string", "number", "boolean"].includes(typeof tag)) &&
            JSON.stringify(value.map((tag) => String(tag).trim())) === JSON.stringify(oldValue);
        } else {
          safe = (typeof value === "string" || typeof value === "number" || typeof value === "boolean") &&
            value === oldValue;
        }
      } catch {
        // Malformed or unsupported YAML remains a preservation error.
      }
      if (!safe) {
        throw new NotePreservationError(`保存できません。frontmatterに保持できない記述があります: ${key}`);
      }
    }
    extra.push(...comments);
  }

  // Keep the original preamble and unknown level-1/2 sections in place. Only
  // replace managed sections whose generated representation actually changed.
  const normalize = (value: string) => value.replace(/\r\n/g, "\n").trim();
  const sections = (body: string) => body.split(/(?=^#{1,2}\s+)/m);
  const name = (section: string) => section.match(/^(#{1,2})\s+(.+)\r?$/m)?.[0].trim();
  const managedHeadings = ["## Current Status", "## Notes", "## Subtasks"];
  const previousSections = sections(previous.body);
  const nextSections = sections(next.body);
  const originalSections = sections(source.body);
  for (const heading of managedHeadings) {
    const oldSection = previousSections.find((part) => name(part) === heading) || "";
    const newSection = nextSections.find((part) => name(part) === heading) || "";
    const matches = originalSections
      .map((part, index) => name(part) === heading ? index : -1)
      .filter((index) => index >= 0);
    if (matches.length > 1) {
      throw new NotePreservationError(`保存できません。同じ見出しが複数あります: ${heading}`);
    }
    if (normalize(oldSection) === normalize(newSection)) {
      continue;
    }
    if (matches.length === 0) {
      if (newSection) originalSections.push(`\n${newSection}`);
      continue;
    }
    const index = matches[0];
    if (normalize(originalSections[index]) !== normalize(oldSection)) {
      throw new NotePreservationError(`保存できません。保持できない記述があります: ${heading}`);
    }
    originalSections[index] = newSection;
  }

  const oldTitle = previousSections.find((part) => /^#\s+/.test(part));
  const newTitle = nextSections.find((part) => /^#\s+/.test(part));
  if (oldTitle && newTitle && name(oldTitle) !== name(newTitle)) {
    const index = originalSections.findIndex((part) => /^#\s+/.test(part));
    if (index >= 0) {
      originalSections[index] = originalSections[index].replace(/^#\s+[^\r\n]+/, name(newTitle)!);
    }
  }
  const extras = extra.length ? `\n${extra.join("\n")}` : "";
  return `---\n${next.frontmatter}${extras}\n---\n${originalSections.join("")}`;
}
