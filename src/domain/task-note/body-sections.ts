/**
 * Splits body text into sections between expected headings.
 *
 * This function is very careful to only match exact heading literals that appear
 * on their own lines. If a user's freeform prose happens to contain a line that
 * looks like "## random thought", it will NOT be mistaken for a section boundary
 * unless that exact heading is the next expected one in the sequence.
 *
 * @param body - The full markdown body text
 * @param expectedHeadings - An ordered list of exact heading strings to look for (e.g., "## Current Status")
 * @returns An object with extracted sections and any parse errors.
 *          sections[i] contains the text between expectedHeadings[i] and expectedHeadings[i+1] (or EOF).
 *          If a heading is not found, its section is empty and an error is recorded.
 */
export function splitBodySections(
  body: string,
  expectedHeadings: string[]
): { sections: string[]; errors: string[] } {
  const errors: string[] = [];
  const sections: string[] = [];

  // If no expected headings, return the entire body as one section
  if (expectedHeadings.length === 0) {
    return { sections: [body], errors };
  }

  const lines = body.split('\n');
  let currentHeadingIndex = 0;
  let currentSectionStart = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const trimmedLine = lines[lineIndex].trim();

    // Check if this line matches the next expected heading
    if (currentHeadingIndex < expectedHeadings.length) {
      if (trimmedLine === expectedHeadings[currentHeadingIndex]) {
        // Found the expected heading
        // Extract content from currentSectionStart to lineIndex (excluding the heading line itself)
        const sectionLines = lines.slice(currentSectionStart, lineIndex);
        sections.push(sectionLines.join('\n'));

        currentSectionStart = lineIndex + 1;
        currentHeadingIndex++;
      }
    }
  }

  // Capture remaining content as the last section
  if (currentHeadingIndex < expectedHeadings.length) {
    // Some expected headings were not found
    for (let i = currentHeadingIndex; i < expectedHeadings.length; i++) {
      errors.push(`Expected heading "${expectedHeadings[i]}" not found`);
      sections.push('');
    }
  } else {
    // All expected headings found, capture remaining content
    const sectionLines = lines.slice(currentSectionStart);
    sections.push(sectionLines.join('\n'));
  }

  return { sections, errors };
}

/**
 * Trims leading and trailing blank lines from text while preserving internal structure.
 * This is used for currentStatus and notes fields which should have their leading/trailing
 * whitespace trimmed but internal formatting preserved.
 */
export function trimBlankLines(text: string): string {
  const lines = text.split('\n');

  // Find first non-blank line
  let start = 0;
  while (start < lines.length && lines[start].trim() === '') {
    start++;
  }

  // Find last non-blank line
  let end = lines.length - 1;
  while (end >= start && lines[end].trim() === '') {
    end--;
  }

  if (start > end) {
    return '';
  }

  return lines.slice(start, end + 1).join('\n');
}

export interface TaskBodyContent {
  currentStatus: string;
  notes: string;
  subtaskSections: Array<{ currentStatus: string; notes: string }>;
  errors: string[];
}

/**
 * Extracts the freeform `currentStatus`/`notes` text (parent and per-subtask) from a
 * task note's body. Shared by both the new-format parser and the legacy migration,
 * since both bodies use the same fixed heading vocabulary.
 *
 * Any missing expected heading, or a `### {title}` heading that doesn't match the
 * corresponding entry in `subtaskTitles` (by position), is reported in `errors`
 * rather than silently ignored — a mismatch here means the body and the structured
 * data have desynced, which should never happen for a file only ever written by this
 * plugin's own serializer.
 *
 * IMPORTANT: We only include `## Subtasks` in the expected heading list if subtasks
 * are actually expected (subtaskTitles.length > 0). This ensures that if a user's own
 * prose happens to contain a line matching `## Subtasks`, it won't be misinterpreted
 * as a section boundary when there are no subtasks.
 */
export function parseTaskBodyContent(
  body: string,
  subtaskTitles: string[]
): TaskBodyContent {
  const errors: string[] = [];

  const expectedHeadings = ['## Current Status', '## Notes'];
  if (subtaskTitles.length > 0) {
    expectedHeadings.push('## Subtasks');
  }

  const { sections, errors: topErrors } = splitBodySections(body, expectedHeadings);
  errors.push(...topErrors);

  const currentStatus = sections.length > 1 ? trimBlankLines(sections[1]) : '';
  const notes = sections.length > 2 ? trimBlankLines(sections[2]) : '';

  const subtaskSections: Array<{ currentStatus: string; notes: string }> = [];

  if (subtaskTitles.length > 0) {
    if (sections.length <= 3) {
      errors.push('Expected "## Subtasks" section with subtask content but none was found');
    } else {
      const subtasksBody = sections[3];
      const { sections: perSubtaskBodies, errors: subtaskErrors } = splitSubtaskSections(
        subtasksBody,
        subtaskTitles
      );
      errors.push(...subtaskErrors);

      for (let i = 0; i < subtaskTitles.length; i++) {
        const subtaskBody = perSubtaskBodies[i] ?? '';
        const subtaskExpectedHeadings = ['#### Current Status', '#### Notes'];
        const { sections: subSections, errors: subErrors } = splitBodySections(
          subtaskBody,
          subtaskExpectedHeadings
        );
        errors.push(...subErrors);

        subtaskSections.push({
          currentStatus: subSections.length > 1 ? trimBlankLines(subSections[1]) : '',
          notes: subSections.length > 2 ? trimBlankLines(subSections[2]) : '',
        });
      }
    }
  }

  return { currentStatus, notes, subtaskSections, errors };
}

/**
 * Splits subtask sections by heading matching.
 * Given a body section that may contain multiple `### {title}` headings,
 * extracts each subtask's content in order.
 *
 * @param body - The body text (typically everything after "## Subtasks")
 * @param subtaskTitles - The expected subtask titles in order
 * @returns Array of subtask bodies (in the same order), and errors for any mismatches
 */
export function splitSubtaskSections(
  body: string,
  subtaskTitles: string[]
): { sections: string[]; errors: string[] } {
  const errors: string[] = [];
  const sections: string[] = [];

  if (subtaskTitles.length === 0) {
    return { sections: [], errors };
  }

  const lines = body.split('\n');
  const headingPositions: number[] = [];
  let currentHeadingIndex = 0;

  // First pass: find all heading positions in order
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const trimmedLine = lines[lineIndex].trim();

    if (currentHeadingIndex < subtaskTitles.length) {
      const expectedHeading = `### ${subtaskTitles[currentHeadingIndex]}`;
      if (trimmedLine === expectedHeading) {
        headingPositions.push(lineIndex);
        currentHeadingIndex++;
      }
    }
  }

  // Check if all expected headings were found
  if (headingPositions.length < subtaskTitles.length) {
    // Some expected subtask headings were not found
    for (let i = headingPositions.length; i < subtaskTitles.length; i++) {
      errors.push(`Expected subtask heading "### ${subtaskTitles[i]}" not found`);
    }
  }

  // Second pass: extract content between headings
  for (let i = 0; i < headingPositions.length; i++) {
    const startLineIndex = headingPositions[i] + 1; // Content starts after the heading
    const endLineIndex = i + 1 < headingPositions.length
      ? headingPositions[i + 1]
      : lines.length;
    const sectionLines = lines.slice(startLineIndex, endLineIndex);
    sections.push(sectionLines.join('\n'));
  }

  // Add empty sections for any missing headings
  while (sections.length < subtaskTitles.length) {
    sections.push('');
  }

  return { sections, errors };
}
