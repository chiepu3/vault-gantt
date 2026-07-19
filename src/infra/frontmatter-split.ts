/**
 * Splits raw Obsidian markdown file content into its frontmatter block (the
 * literal `---\n...\n---\n` text, verbatim, unparsed) and everything after it.
 * If there's no frontmatter block (file doesn't start with a `---` line), the
 * whole content is returned as `body` and `frontmatterBlock` is an empty string.
 * This is a boundary-finding operation, not YAML parsing — FR-1.2 only bans
 * interpreting frontmatter content ourselves, not locating its delimiters.
 */
export function splitFrontmatterBlock(raw: string): { frontmatterBlock: string; body: string } {
  // Files synced across Windows machines can carry CRLF line endings; a "---\r"
  // first line must still be recognized as a frontmatter delimiter, otherwise
  // the entire file is misclassified as body and the note fails to parse.
  const normalized = raw.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  if (lines[0] !== '---') {
    return { frontmatterBlock: '', body: normalized };
  }

  // Find the next line that is exactly "---", starting after the opening delimiter.
  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      closingIndex = i;
      break;
    }
  }

  if (closingIndex === -1) {
    // No closing delimiter found: treat the whole thing as body (malformed/no frontmatter).
    return { frontmatterBlock: '', body: normalized };
  }

  // frontmatterBlock is everything up to and including the closing "---" line,
  // plus its trailing newline (if present in the original content).
  const frontmatterLines = lines.slice(0, closingIndex + 1);
  const frontmatterBlock = frontmatterLines.join('\n') + '\n';

  // body is everything after the closing delimiter's line.
  const bodyLines = lines.slice(closingIndex + 1);
  const body = bodyLines.join('\n');

  return { frontmatterBlock, body };
}
