import { describe, it, expect, vi } from 'vitest';

// Import parseCsv in isolation by mocking the 'obsidian' dependency
vi.mock('obsidian', () => ({
  requestUrl: vi.fn(),
}));

import { parseCsv } from './holiday-fetcher';

describe('holiday-fetcher', () => {
  describe('parseCsv', () => {
    it('should strip BOM and parse valid CSV lines', () => {
      const csv = '﻿2024/1/1,元日\n2024/1/8,成人の日\n';
      const dates = parseCsv(csv);
      expect(dates).toEqual(['2024-01-01', '2024-01-08']);
    });

    it('should convert single-digit month and day to padded format', () => {
      const csv = '2024/1/1,元日\n2024/2/11,建国記念の日\n';
      const dates = parseCsv(csv);
      expect(dates).toEqual(['2024-01-01', '2024-02-11']);
    });

    it('should skip lines that do not match YYYY/M/D format', () => {
      const csv = '2024/1/1,元日\nInvalid Line\n2024/2/11,建国記念の日\n';
      const dates = parseCsv(csv);
      expect(dates).toEqual(['2024-01-01', '2024-02-11']);
    });

    it('should handle CSV without BOM', () => {
      const csv = '2024/1/1,元日\n2024/1/8,成人の日\n';
      const dates = parseCsv(csv);
      expect(dates).toEqual(['2024-01-01', '2024-01-08']);
    });

    it('should return empty array for empty input', () => {
      const csv = '';
      const dates = parseCsv(csv);
      expect(dates).toEqual([]);
    });

    it('should handle CRLF line endings', () => {
      const csv = '﻿2024/1/1,元日\r\n2024/1/8,成人の日\r\n';
      const dates = parseCsv(csv);
      expect(dates).toEqual(['2024-01-01', '2024-01-08']);
    });
  });
});
