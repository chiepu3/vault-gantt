import { requestUrl } from 'obsidian';
import { setDynamicHolidays } from './holiday-service';

const CACHE_KEY = 'vault-gantt-holidays';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface HolidayCache {
  fetchedAt: number; // Date.now()
  dates: string[];   // YYYY-MM-DD strings
}

/**
 * Parse Cabinet Office CSV (BOM-UTF-8, YYYY/M/D format) into YYYY-MM-DD strings.
 * Lines that don't match the date format are silently skipped.
 */
export function parseCsv(text: string): string[] {
  // Strip BOM if present
  const stripped = text.startsWith('﻿') ? text.slice(1) : text;
  const dates: string[] = [];

  for (const line of stripped.split(/\r?\n/)) {
    const parts = line.split(',');
    if (parts.length < 1) continue;

    const raw = parts[0].trim(); // e.g. "2024/1/1"
    const m = raw.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if (!m) continue;

    const yyyy = m[1];
    const mm = String(parseInt(m[2], 10)).padStart(2, '0');
    const dd = String(parseInt(m[3], 10)).padStart(2, '0');
    dates.push(`${yyyy}-${mm}-${dd}`);
  }

  return dates;
}

/**
 * Fetch or load cached holiday data and apply to holiday-service.
 * Fetches at most once per 30 days; skips silently on network error.
 * The loadCache and saveCache callbacks should read/write from plugin.loadData() / plugin.saveData().
 */
export async function initHolidays(
  loadCache: () => Promise<HolidayCache | null>,
  saveCache: (cache: HolidayCache) => Promise<void>,
  enabled: boolean,
): Promise<void> {
  if (!enabled) return;

  // Try loading from cache first
  let cache = await loadCache();
  const now = Date.now();

  if (!cache || now - cache.fetchedAt > MAX_AGE_MS) {
    try {
      const resp = await requestUrl({
        url: 'https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv',
        headers: { 'User-Agent': 'VaultGantt/1.0' },
      });
      const dates = parseCsv(resp.text);
      if (dates.length > 10) { // sanity check
        cache = { fetchedAt: now, dates };
        await saveCache(cache);
      }
    } catch {
      // Network failure: use stale cache or static fallback
    }
  }

  if (cache && cache.dates.length > 0) {
    setDynamicHolidays(new Set(cache.dates));
  }
}
