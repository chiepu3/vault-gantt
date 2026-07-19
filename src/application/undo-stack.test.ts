import { describe, it, expect } from 'vitest';
import { UndoStack, type UndoEntry } from './undo-stack';

describe('undo-stack', () => {
  describe('UndoStack', () => {
    it('should start with size 0', () => {
      const stack = new UndoStack();
      expect(stack.size).toBe(0);
    });

    it('should increment size on push', () => {
      const stack = new UndoStack();
      const entry: UndoEntry = { deletedPaths: [] };
      stack.push(entry);
      expect(stack.size).toBe(1);
    });

    it('should return undefined on pop from empty stack', () => {
      const stack = new UndoStack();
      const result = stack.pop();
      expect(result).toBeUndefined();
    });

    it('should return most recently pushed entry on pop (LIFO)', () => {
      const stack = new UndoStack();
      const entry1: UndoEntry = { deletedPaths: ['path1'] };
      const entry2: UndoEntry = { deletedPaths: ['path2'] };
      stack.push(entry1);
      stack.push(entry2);
      const popped = stack.pop();
      expect(popped).toBe(entry2);
      expect(stack.size).toBe(1);
    });

    it('should implement LIFO ordering', () => {
      const stack = new UndoStack();
      const entries: UndoEntry[] = Array.from({ length: 5 }, (_, i) => ({
        deletedPaths: [`path${i}`],
      }));
      entries.forEach((e) => stack.push(e));

      // Pop in reverse order
      for (let i = entries.length - 1; i >= 0; i--) {
        const popped = stack.pop();
        expect(popped).toEqual(entries[i]);
      }
      expect(stack.size).toBe(0);
    });

    it('should drop oldest entry when exceeding maxSize', () => {
      const stack = new UndoStack(3);
      const entries: UndoEntry[] = Array.from({ length: 5 }, (_, i) => ({
        deletedPaths: [`path${i}`],
        recreatedFiles: [{ path: `path${i}`, frontmatter: { index: i }, body: '' }],
      }));

      entries.forEach((e) => stack.push(e));

      // Stack should contain entries 2, 3, 4 (0, 1 were evicted)
      expect(stack.size).toBe(3);

      // Pop and verify we get entries in reverse order from the kept ones
      const popped4 = stack.pop();
      expect(popped4?.recreatedFiles?.[0]?.frontmatter?.index).toBe(4);

      const popped3 = stack.pop();
      expect(popped3?.recreatedFiles?.[0]?.frontmatter?.index).toBe(3);

      const popped2 = stack.pop();
      expect(popped2?.recreatedFiles?.[0]?.frontmatter?.index).toBe(2);

      expect(stack.size).toBe(0);
    });

    it('should clear all entries', () => {
      const stack = new UndoStack();
      stack.push({ deletedPaths: ['path1'] });
      stack.push({ deletedPaths: ['path2'] });
      expect(stack.size).toBe(2);

      stack.clear();
      expect(stack.size).toBe(0);
      expect(stack.pop()).toBeUndefined();
    });

    it('should handle push after clear', () => {
      const stack = new UndoStack();
      stack.push({ deletedPaths: ['path1'] });
      stack.clear();

      const newEntry: UndoEntry = { deletedPaths: ['path2'] };
      stack.push(newEntry);
      expect(stack.size).toBe(1);
      expect(stack.pop()).toBe(newEntry);
    });

    it('should respect custom maxSize in constructor', () => {
      const stack = new UndoStack(2);
      stack.push({ deletedPaths: ['path1'] });
      stack.push({ deletedPaths: ['path2'] });
      stack.push({ deletedPaths: ['path3'] });

      expect(stack.size).toBe(2);
      // Only path2 and path3 remain
      const popped3 = stack.pop();
      expect(popped3?.deletedPaths).toEqual(['path3']);
      const popped2 = stack.pop();
      expect(popped2?.deletedPaths).toEqual(['path2']);
      expect(stack.size).toBe(0);
    });
  });
});
