import { Notice, requestUrl } from "obsidian";

import type { Logger } from "../core/logger";

import { TaskWorkbenchSettings } from "../core/types";
import { isValidCalendarDate, todayStr } from "../core/utils";








export type NationalHolidayFetcher = (
  currentHolidays: string[]
) => Promise<string[]>;

// default fetcher is a no-op returning an empty array
const noopNationalHolidayFetcher: NationalHolidayFetcher = async () => [];





export interface HolidaySettingsHost {

  logger: Logger;

  settings: TaskWorkbenchSettings;
  saveSettings(): Promise<void>;
}

// YYYY-MM-DD, zero-padded, used both as a normalization
// target and as the final validity gate in normalizeDate/parseCsv.
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// 30-day national-holiday refresh threshold.
const NATIONAL_HOLIDAY_REFRESH_INTERVAL_MS = 86_400_000 * 30;

// government CSV source for the national holiday list.
const NATIONAL_HOLIDAY_CSV_URL =
  "https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv";

/**
 * Normalizes a loosely formatted value to YYYY-MM-DD and rejects impossible
 * calendar dates.
 */
export function normalizeDate(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  const text = String(value).trim().replace(/\//g, "-");
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) {
    return "";
  }

  const [, year, monthRaw, dayRaw] = match;
  const month = monthRaw.padStart(2, "0");
  const day = dayRaw.padStart(2, "0");
  const candidate = `${year}-${month}-${day}`;

  if (!DATE_PATTERN.test(candidate) || !isValidCalendarDate(candidate)) {
    return "";
  }

  return candidate;
}

/**
 *
 * Normalizes an array of loose date values, or delimited text
 * (split on runs of CR/LF/comma/semicolon), into a deduped, ascending-sorted
 * list of strict YYYY-MM-DD strings.
 */
export function normalizeHolidayDates(value: unknown): string[] {
  const rawItems: unknown[] = Array.isArray(value)
    ? value
    : String(value ?? "").split(/[\r\n,;]+/);

  const normalized = rawItems
    .map((item) => normalizeDate(item))
    .filter((date) => date !== "");

  return Array.from(new Set(normalized)).sort();
}

/**
 * Returns the sorted, deduplicated union of national, manual, and special
 * holidays. Manual removal only changes `ganttManualHolidays`.
 */
export function getEffectiveHolidays(
  settings: TaskWorkbenchSettings
): string[] {
  const merged = [
    ...settings.ganttNationalHolidays,
    ...settings.ganttManualHolidays,
    ...settings.ganttSpecialHolidays,
  ];
  return Array.from(new Set(merged)).sort();
}







export function shouldRefreshNationalHolidays(
  settings: TaskWorkbenchSettings
): boolean {
  if (
    !settings.ganttNationalHolidays ||
    settings.ganttNationalHolidays.length === 0
  ) {
    return true;
  }

  const updatedAt = settings.ganttNationalHolidaysUpdatedAt;
  if (!updatedAt) {
    return true;
  }

  const updatedAtMs = Date.parse(updatedAt);
  if (Number.isNaN(updatedAtMs)) {
    return true;
  }

  return Date.now() - updatedAtMs > NATIONAL_HOLIDAY_REFRESH_INTERVAL_MS;
}

/**
 *
 * Parses the government CSV text ("日付","祝日名" rows, quotes optional,
 * BOM already-or-not present) into a normalized, deduped, sorted list of
 * YYYY-MM-DD date strings. Malformed rows (header row, blank lines, rows
 * whose first field is not a recognizable date) are silently skipped.
 *
 * Steps: strip BOM -> split into lines -> take the text before the first
 * comma on each line -> strip surrounding quotes -> normalizeDate ->
 * DATE_PATTERN sanity check -> normalizeHolidayDates for the final
 * dedupe/sort pass.
 */
export function parseCsv(text: string): string[] {
  const withoutBom = text.replace(/^\uFEFF/, "");
  const lines = withoutBom.split(/\r\n|\r|\n/);

  const candidates: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      continue;
    }
    const firstField = line.split(",", 1)[0];
    const unquoted = firstField.replace(/^"|"$/g, "");
    const normalized = normalizeDate(unquoted);
    if (normalized !== "" && DATE_PATTERN.test(normalized)) {
      candidates.push(normalized);
    }
  }

  return normalizeHolidayDates(candidates);
}










export function createRequestUrlNationalHolidayFetcher(): NationalHolidayFetcher {
  return async () => {
    const response = await requestUrl({
      url: NATIONAL_HOLIDAY_CSV_URL,
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `HolidayService: national holiday CSV fetch failed with HTTP ${response.status}`
      );
    }

    const text = response.text;
    if (!text || text.trim() === "") {
      // an empty CSV response is treated as a fetch failure.
      throw new Error(
        "HolidayService: national holiday CSV response was empty"
      );
    }

    return parseCsv(text);
  };
}

/**
 * Holiday settings migration and national holiday refresh.
 */
export class HolidayService {
  private readonly fetcher: NationalHolidayFetcher;

  constructor(
    private readonly host: HolidaySettingsHost,
    fetcher?: NationalHolidayFetcher
  ) {
    this.fetcher = fetcher ?? noopNationalHolidayFetcher;
  }

  /**
 * Repairs holiday settings and migrates the older combined `ganttHolidays`
 * format into `ganttManualHolidays`.
 */
  migrateHolidaySettings(settings: TaskWorkbenchSettings): boolean {
    let migrated = false;

    const raw = settings as unknown as Record<string, unknown>;

    // capture pre-repair state before the generic array-shape

    // migration can still see the original (un-split) ganttHolidays value.
    const manualHolidaysWasArray = Array.isArray(raw["ganttManualHolidays"]);
    const legacyHolidaysBeforeRepair = raw["ganttHolidays"];

    const arrayFields = [
      "ganttHolidays",
      "ganttManualHolidays",
      "ganttNationalHolidays",
      "ganttSpecialHolidays",
    ];

    for (const field of arrayFields) {
      if (!Array.isArray(raw[field])) {
        raw[field] = [];
        migrated = true;
      }
    }

    if (typeof raw["ganttNationalHolidaysUpdatedAt"] !== "string") {
      raw["ganttNationalHolidaysUpdatedAt"] = "";
      migrated = true;
    }

    // settings objects that predate the manual/national/
    // special three-list split only ever had the combined `ganttHolidays`
    // field populated. Migrate that older settings data into
    // `ganttManualHolidays` (once) so it is not silently dropped.
    if (!manualHolidaysWasArray) {
      const legacyDates = normalizeHolidayDates(legacyHolidaysBeforeRepair);
      if (legacyDates.length > 0) {
        raw["ganttManualHolidays"] = legacyDates;
        migrated = true;
      }
    }

    // normalize (dedupe + sort) all three holiday lists,
    // regardless of whether they needed type repair above.
    const holidayListFields = [
      "ganttNationalHolidays",
      "ganttManualHolidays",
      "ganttSpecialHolidays",
    ];
    for (const field of holidayListFields) {
      const current = raw[field] as string[];
      const normalized = normalizeHolidayDates(current);
      const changed =
        normalized.length !== current.length ||
        normalized.some((date, index) => date !== current[index]);
      if (changed) {
        raw[field] = normalized;
        migrated = true;
      }
    }

    return migrated;
  }

































  async refreshNationalHolidays(
    force: boolean,
    sync: boolean
  ): Promise<boolean> {
    const settings = this.host.settings;

    if (!force && !shouldRefreshNationalHolidays(settings)) {
      return true;
    }


    const startedAt = Date.now();

    let holidays: string[];
    try {
      holidays = await this.fetcher(settings.ganttNationalHolidays);
    } catch (err) {
      // notify the user, keep operating on existing data
      new Notice("国民祝日の取得に失敗しました。既存のデータで継続します。");
      // console.warn (not console.error) for fetch failures.

      this.host.logger.warn("HolidayService", "national holiday fetch failed", err);

      return false;
    }

    // normalize (dedupe + sort) before storing.
    const normalizedHolidays = normalizeHolidayDates(holidays);
    settings.ganttNationalHolidays = normalizedHolidays;
    settings.ganttNationalHolidaysUpdatedAt = todayStr();

    // settings are persisted after national holiday updates
    await this.host.saveSettings();

    if (sync) {
      // success notification includes the holiday count.
      new Notice(
        `国民祝日データを更新しました（${normalizedHolidays.length}件）`
      );
    }


    if (typeof this.host.logger.debug === "function") {
      this.host.logger.debug("HolidayService", "holidays refreshed", {
        durationMs: Date.now() - startedAt,
        count: normalizedHolidays.length,
      });
    }

    return true;
  }
}
