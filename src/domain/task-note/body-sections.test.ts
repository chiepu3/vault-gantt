import { describe, it, expect } from 'vitest';
import {
  splitBodySections,
  trimBlankLines,
  splitSubtaskSections,
  parseTaskBodyContent,
} from './body-sections';

describe('body-sections', () => {
  describe('splitBodySections', () => {
    it('should split body by expected headings', () => {
      const body = `Some intro
## Current Status
This is the status
## Notes
This is notes`;

      const { sections, errors } = splitBodySections(body, [
        '## Current Status',
        '## Notes',
      ]);

      expect(errors).toHaveLength(0);
      expect(sections).toHaveLength(3);
      expect(sections[1]).toContain('This is the status');
      expect(sections[2]).toContain('This is notes');
    });

    it('should not treat arbitrary headings as section breaks', () => {
      const body = `## Current Status
This is status text with ## random thought in the middle
## Notes
This is notes`;

      const { sections, errors } = splitBodySections(body, [
        '## Current Status',
        '## Notes',
      ]);

      expect(errors).toHaveLength(0);
      expect(sections).toHaveLength(3);
      // The "## random thought" should be part of the status content
      expect(sections[1]).toContain('## random thought');
    });

    it('should report error for missing expected headings', () => {
      const body = `## Current Status
Status text`;

      const { sections, errors } = splitBodySections(body, [
        '## Current Status',
        '## Notes',
      ]);

      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('## Notes');
      expect(sections).toHaveLength(2);
    });

    it('should handle empty body', () => {
      const { sections, errors } = splitBodySections('', ['## Current Status']);

      expect(errors).toHaveLength(1);
      expect(sections).toHaveLength(1);
      expect(sections[0]).toBe('');
    });

    it('should handle no expected headings', () => {
      const body = 'Just some text';
      const { sections, errors } = splitBodySections(body, []);

      expect(errors).toHaveLength(0);
      expect(sections).toHaveLength(1);
      expect(sections[0]).toBe(body);
    });
  });

  describe('trimBlankLines', () => {
    it('should trim leading and trailing blank lines', () => {
      const text = `

Line 1
Line 2

`;

      const result = trimBlankLines(text);
      expect(result).toBe('Line 1\nLine 2');
    });

    it('should preserve internal blank lines', () => {
      const text = `Line 1

Line 2`;

      const result = trimBlankLines(text);
      expect(result).toBe('Line 1\n\nLine 2');
    });

    it('should handle all blank lines', () => {
      const result = trimBlankLines('   \n\n   ');
      expect(result).toBe('');
    });

    it('should handle single line', () => {
      const result = trimBlankLines('Single line');
      expect(result).toBe('Single line');
    });
  });

  describe('splitSubtaskSections', () => {
    it('should split subtask sections by title headings', () => {
      const body = `### Subtask 1
Content 1
### Subtask 2
Content 2`;

      const { sections, errors } = splitSubtaskSections(body, [
        'Subtask 1',
        'Subtask 2',
      ]);

      expect(errors).toHaveLength(0);
      expect(sections).toHaveLength(2);
      expect(sections[0].trim()).toContain('Content 1');
      expect(sections[1].trim()).toContain('Content 2');
    });

    it('should report error for missing subtask headings', () => {
      const body = `### Subtask 1
Content`;

      const { errors } = splitSubtaskSections(body, [
        'Subtask 1',
        'Missing Subtask',
      ]);

      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('Missing Subtask');
    });

    it('should handle empty subtask list', () => {
      const { sections, errors } = splitSubtaskSections('', []);

      expect(errors).toHaveLength(0);
      expect(sections).toHaveLength(0);
    });
  });

  describe('parseTaskBodyContent', () => {
    it('extracts parent and subtask currentStatus/notes with no errors', () => {
      const body = `# Title
## Current Status
Parent status
## Notes
Parent notes
## Subtasks

### Sub 1

#### Current Status
Sub status
#### Notes
Sub notes`;

      const result = parseTaskBodyContent(body, ['Sub 1']);

      expect(result.errors).toHaveLength(0);
      expect(result.currentStatus).toBe('Parent status');
      expect(result.notes).toBe('Parent notes');
      expect(result.subtaskSections).toHaveLength(1);
      expect(result.subtaskSections[0].currentStatus).toBe('Sub status');
      expect(result.subtaskSections[0].notes).toBe('Sub notes');
    });

    it('reports an error when a subtask title in the body does not match the expected title (desync)', () => {
      const body = `## Current Status
Parent status
## Notes
Parent notes
## Subtasks

### Wrong Title

#### Current Status
Sub status
#### Notes
Sub notes`;

      // We expect a subtask titled "Sub 1", but the body has "### Wrong Title"
      const result = parseTaskBodyContent(body, ['Sub 1']);

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.includes('Sub 1'))).toBe(true);
    });

    it('reports an error when the body has no ## Subtasks section but subtasks are expected', () => {
      const body = `## Current Status
Parent status
## Notes
Parent notes`;

      const result = parseTaskBodyContent(body, ['Sub 1']);

      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('does not require a ## Subtasks section when there are no subtasks', () => {
      const body = `## Current Status
Parent status
## Notes
Parent notes`;

      const result = parseTaskBodyContent(body, []);

      expect(result.errors).toHaveLength(0);
      expect(result.subtaskSections).toHaveLength(0);
    });

    it('preserves notes content after a literal "## Subtasks" line when there are no subtasks', () => {
      const body = `## Current Status
Status text
## Notes
Some notes here.
## Subtasks
This looks like a subtasks heading but there are no subtasks, so this text must survive.`;

      const result = parseTaskBodyContent(body, []);

      expect(result.errors).toHaveLength(0);
      expect(result.notes).toContain('## Subtasks');
      expect(result.notes).toContain(
        'This looks like a subtasks heading but there are no subtasks, so this text must survive.'
      );
    });

    it('does not misparse a heading-like substring embedded in a longer line as a section boundary', () => {
      const body = `## Current Status
Parent status
## Notes
Parent notes
## Subtasks

### Sub 1

#### Current Status
Reference to #### Notes mentioned in passing, not an actual heading.
#### Notes
Sub notes`;

      const result = parseTaskBodyContent(body, ['Sub 1']);

      expect(result.errors).toHaveLength(0);
      expect(result.subtaskSections).toHaveLength(1);
      expect(result.subtaskSections[0].currentStatus).toContain(
        'Reference to #### Notes mentioned in passing, not an actual heading.'
      );
      expect(result.subtaskSections[0].notes).toBe('Sub notes');
    });

    it('does not bleed content between two subtasks that share the same title', () => {
      const body = `## Current Status
Parent status
## Notes
Parent notes
## Subtasks

### Same Title

#### Current Status
First subtask status
#### Notes
First subtask notes

### Same Title

#### Current Status
Second subtask status
#### Notes
Second subtask notes`;

      const result = parseTaskBodyContent(body, ['Same Title', 'Same Title']);

      expect(result.errors).toHaveLength(0);
      expect(result.subtaskSections).toHaveLength(2);
      expect(result.subtaskSections[0].currentStatus).toBe('First subtask status');
      expect(result.subtaskSections[0].notes).toBe('First subtask notes');
      expect(result.subtaskSections[1].currentStatus).toBe('Second subtask status');
      expect(result.subtaskSections[1].notes).toBe('Second subtask notes');
    });
  });
});
