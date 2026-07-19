import { describe, it, expect } from 'vitest';
import { splitFrontmatterBlock } from './frontmatter-split';

describe('splitFrontmatterBlock', () => {
  it('splits a normal file with frontmatter and body', () => {
    const raw = '---\ntype: task\ndisplayName: Foo\n---\n# Heading\n\nSome body text.\n';
    const result = splitFrontmatterBlock(raw);
    expect(result.frontmatterBlock).toBe('---\ntype: task\ndisplayName: Foo\n---\n');
    expect(result.body).toBe('# Heading\n\nSome body text.\n');
  });

  it('returns whole content as body when there is no frontmatter block', () => {
    const raw = '# Just a heading\n\nNo frontmatter here.\n';
    const result = splitFrontmatterBlock(raw);
    expect(result.frontmatterBlock).toBe('');
    expect(result.body).toBe(raw);
  });

  it('returns empty body and frontmatterBlock for an empty file', () => {
    const result = splitFrontmatterBlock('');
    expect(result.frontmatterBlock).toBe('');
    expect(result.body).toBe('');
  });

  it('handles a file that is only a frontmatter block with no body after it', () => {
    const raw = '---\ntype: task\n---\n';
    const result = splitFrontmatterBlock(raw);
    expect(result.frontmatterBlock).toBe('---\ntype: task\n---\n');
    expect(result.body).toBe('');
  });

  it('handles a file that is only a frontmatter block with no trailing newline', () => {
    const raw = '---\ntype: task\n---';
    const result = splitFrontmatterBlock(raw);
    expect(result.frontmatterBlock).toBe('---\ntype: task\n---\n');
    expect(result.body).toBe('');
  });

  it('does not re-match a literal "---" line appearing in the body after the closing delimiter', () => {
    const raw = '---\ntype: task\n---\nIntro text\n\n---\n\nMore text after a divider.\n';
    const result = splitFrontmatterBlock(raw);
    expect(result.frontmatterBlock).toBe('---\ntype: task\n---\n');
    expect(result.body).toBe('Intro text\n\n---\n\nMore text after a divider.\n');
  });

  it('treats content with no closing delimiter as having no frontmatter block', () => {
    const raw = '---\ntype: task\ndisplayName: Unclosed\n';
    const result = splitFrontmatterBlock(raw);
    expect(result.frontmatterBlock).toBe('');
    expect(result.body).toBe(raw);
  });

  it('does not treat a file starting with a non-bare "---" line (e.g. "---foo") as frontmatter', () => {
    const raw = '---foo\nbar: baz\n---\n';
    const result = splitFrontmatterBlock(raw);
    expect(result.frontmatterBlock).toBe('');
    expect(result.body).toBe(raw);
  });

  it('handles a single-line file that is just "---"', () => {
    const raw = '---';
    const result = splitFrontmatterBlock(raw);
    expect(result.frontmatterBlock).toBe('');
    expect(result.body).toBe(raw);
  });

  it('preserves multi-line body content exactly, including internal blank lines', () => {
    const raw = '---\ntype: task\n---\nLine 1\n\nLine 3\n\n\nLine 6\n';
    const result = splitFrontmatterBlock(raw);
    expect(result.body).toBe('Line 1\n\nLine 3\n\n\nLine 6\n');
  });

  it('recognizes frontmatter delimiters in a CRLF file (Windows/OneDrive sync)', () => {
    const raw = '---\r\ntype: task\r\ndisplayName: Test\r\n---\r\n# Test\r\nBody line\r\n';
    const result = splitFrontmatterBlock(raw);
    expect(result.frontmatterBlock).toBe('---\ntype: task\ndisplayName: Test\n---\n');
    expect(result.body).toBe('# Test\nBody line\n');
  });

  it('normalizes CRLF even when there is no frontmatter block', () => {
    const raw = 'Just text\r\nSecond line\r\n';
    const result = splitFrontmatterBlock(raw);
    expect(result.frontmatterBlock).toBe('');
    expect(result.body).toBe('Just text\nSecond line\n');
  });
});
