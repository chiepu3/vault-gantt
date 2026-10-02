/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Mock } from "vitest";
import { Notice, requestUrl } from "obsidian";
import {
  HolidayService,
  createRequestUrlNationalHolidayFetcher,
  getEffectiveHolidays,
  normalizeDate,
  normalizeHolidayDates,
  parseCsv,
  shouldRefreshNationalHolidays,
} from "../../src/app/holiday-service";
import type {
  HolidaySettingsHost,
  NationalHolidayFetcher,
} from "../../src/app/holiday-service";

import type { Logger } from "../../src/core/logger";

import { TaskWorkbenchSettings } from "../../src/core/types";
import { DEFAULT_SETTINGS } from "../../src/core/constants";

vi.mock("obsidian", async (importOriginal) => {
  const actual = await importOriginal<typeof import("obsidian")>();
  return { ...actual, Notice: vi.fn(), requestUrl: vi.fn() };
});

const NoticeMock = Notice as unknown as Mock;
const requestUrlMock = requestUrl as unknown as Mock;

describe("HolidayService", () => {
  let settings: TaskWorkbenchSettings;
  let saveSettings: Mock;
  let host: HolidaySettingsHost;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T10:00:00Z"));
    settings = { ...DEFAULT_SETTINGS };
    saveSettings = vi.fn().mockResolvedValue(undefined);
    host = {
      logger: { warn: vi.fn(), error: vi.fn() } as unknown as Logger,
      settings,
      saveSettings,
    };
    NoticeMock.mockClear();
    requestUrlMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function makeService(fetcher?: NationalHolidayFetcher): HolidayService {

    return new HolidayService(host, fetcher);

  }

  describe("migrateHolidaySettings", () => {
    it("repairs non-array holiday fields, migrates older holiday setting into ganttManualHolidays and reports migration", () => {
      const broken = settings as unknown as Record<string, unknown>;
      broken["ganttHolidays"] = "2026-01-01";
      broken["ganttManualHolidays"] = undefined;
      delete broken["ganttNationalHolidays"];
      broken["ganttNationalHolidaysUpdatedAt"] = 12345;

      const migrated = makeService().migrateHolidaySettings(settings);

      expect(migrated).toBe(true);
      expect(settings.ganttHolidays).toEqual([]);

      // combined ganttHolidays content is migrated into it.
      expect(settings.ganttManualHolidays).toEqual(["2026-01-01"]);
      expect(settings.ganttNationalHolidays).toEqual([]);
      expect(settings.ganttSpecialHolidays).toEqual([]);
      expect(settings.ganttNationalHolidaysUpdatedAt).toBe("");
    });

    it("returns false when no migration is needed", () => {
      // DEFAULT_SETTINGS is a clean, current structure
      const migrated = makeService().migrateHolidaySettings(settings);

      expect(migrated).toBe(false);

      expect(settings.ganttNationalHolidays).toEqual([]);
      expect(settings.ganttManualHolidays).toEqual([]);
    });

    it("keeps valid arrays intact while repairing others", () => {
      settings.ganttManualHolidays = ["2026-12-31"];
      (settings as unknown as Record<string, unknown>)["ganttHolidays"] = null;

      const migrated = makeService().migrateHolidaySettings(settings);

      expect(migrated).toBe(true);
      expect(settings.ganttHolidays).toEqual([]);
      expect(settings.ganttManualHolidays).toEqual(["2026-12-31"]);
    });

    it("does not migrate older holiday setting when ganttManualHolidays is already a valid array", () => {
      settings.ganttManualHolidays = [];
      (settings as unknown as Record<string, unknown>)["ganttHolidays"] = [
        "2026-03-03",
      ];

      const migrated = makeService().migrateHolidaySettings(settings);

      // ganttHolidays itself was already a valid (if unused) array, and
      // ganttManualHolidays was already a valid array too, so no migration
      // or repair is triggered for either field.
      expect(migrated).toBe(false);
      expect(settings.ganttManualHolidays).toEqual([]);
      expect(settings.ganttHolidays).toEqual(["2026-03-03"]);
    });

    it("normalizes (dedupes + sorts) all three holiday lists even when already arrays", () => {
      settings.ganttNationalHolidays = ["2026-05-05", "2026-01-01", "2026-01-01"];
      settings.ganttManualHolidays = ["2026-12-31", "2026-06-15"];
      settings.ganttSpecialHolidays = ["2026-02-11", "2026-02-11"];

      const migrated = makeService().migrateHolidaySettings(settings);

      expect(migrated).toBe(true);
      expect(settings.ganttNationalHolidays).toEqual([
        "2026-01-01",
        "2026-05-05",
      ]);
      expect(settings.ganttManualHolidays).toEqual([
        "2026-06-15",
        "2026-12-31",
      ]);
      expect(settings.ganttSpecialHolidays).toEqual(["2026-02-11"]);
    });

    it("does not report migration when lists are already deduped and sorted", () => {
      settings.ganttNationalHolidays = ["2026-01-01", "2026-05-05"];
      settings.ganttManualHolidays = [];
      settings.ganttSpecialHolidays = [];

      const migrated = makeService().migrateHolidaySettings(settings);

      expect(migrated).toBe(false);
    });
  });

  describe("refreshNationalHolidays", () => {
    it("fetches, updates settings and persists them", async () => {
      const fetcher = vi.fn().mockResolvedValue(["2026-01-01", "2026-05-05"]);

      const result = await makeService(fetcher).refreshNationalHolidays(
        false,
        false
      );

      expect(result).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(settings.ganttNationalHolidays).toEqual([
        "2026-01-01",
        "2026-05-05",
      ]);
      expect(settings.ganttNationalHolidaysUpdatedAt).toBe("2026-07-29");
      expect(saveSettings).toHaveBeenCalledTimes(1);
    });

    it("normalizes (dedupes + sorts) the fetched holidays before storing", async () => {
      const fetcher = vi
        .fn()
        .mockResolvedValue(["2026/5/5", "2026-01-01", "2026-01-01", "bogus"]);

      await makeService(fetcher).refreshNationalHolidays(false, false);

      expect(settings.ganttNationalHolidays).toEqual([
        "2026-01-01",
        "2026-05-05",
      ]);
    });

    it("skips the fetch when the list is non-empty and updated within 30 days, unforced", async () => {
      settings.ganttNationalHolidays = ["2026-01-01"];
      settings.ganttNationalHolidaysUpdatedAt = "2026-07-29";
      const fetcher = vi.fn();

      const result = await makeService(fetcher).refreshNationalHolidays(
        false,
        false
      );

      expect(result).toBe(true);
      expect(fetcher).not.toHaveBeenCalled();
      expect(saveSettings).not.toHaveBeenCalled();
    });

    it("refreshes when the last update is more than 30 days old", async () => {
      settings.ganttNationalHolidays = ["2026-01-01"];

      settings.ganttNationalHolidaysUpdatedAt = "2026-06-28";
      const fetcher = vi.fn().mockResolvedValue(["2026-01-01"]);

      await makeService(fetcher).refreshNationalHolidays(false, false);

      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("force flag bypasses the 30-day refresh gate", async () => {
      settings.ganttNationalHolidays = ["2026-01-01"];
      settings.ganttNationalHolidaysUpdatedAt = "2026-07-29";
      const fetcher = vi.fn().mockResolvedValue([]);

      await makeService(fetcher).refreshNationalHolidays(true, false);

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(saveSettings).toHaveBeenCalledTimes(1);
    });

    it("fetch failure notifies the user, warns (not errors) and continues with existing data, returning false", async () => {
      settings.ganttNationalHolidays = ["2026-01-01"];
      const fetcher = vi.fn().mockRejectedValue(new Error("network down"));

      // must resolve, not throw
      const result = await makeService(fetcher).refreshNationalHolidays(
        false,
        false
      );

      expect(result).toBe(false);
      expect(NoticeMock).toHaveBeenCalledWith(
        expect.stringContaining("失敗")
      );
      expect(host.logger.warn).toHaveBeenCalledWith(
        "HolidayService",
        "national holiday fetch failed",
        expect.objectContaining({ message: "network down" })
      );
      expect(host.logger.error).not.toHaveBeenCalled();
      // existing data kept, nothing persisted
      expect(settings.ganttNationalHolidays).toEqual(["2026-01-01"]);
      expect(saveSettings).not.toHaveBeenCalled();
    });

    it("sync mode's success notification includes the holiday count", async () => {
      const fetcher = vi
        .fn()
        .mockResolvedValue(["2026-01-01", "2026-05-05", "2026-05-05"]);

      await makeService(fetcher).refreshNationalHolidays(false, true);

      expect(NoticeMock).toHaveBeenCalledWith(
        expect.stringContaining("2件")
      );

      NoticeMock.mockClear();
      settings.ganttNationalHolidays = [];
      settings.ganttNationalHolidaysUpdatedAt = "";
      await makeService(fetcher).refreshNationalHolidays(false, false);
      expect(NoticeMock).not.toHaveBeenCalled();
    });

    it("default fetcher is a no-op returning an empty array", async () => {
      const result = await makeService().refreshNationalHolidays(
        false,
        false
      );

      expect(result).toBe(true);
      expect(settings.ganttNationalHolidays).toEqual([]);
      expect(settings.ganttNationalHolidaysUpdatedAt).toBe("2026-07-29");
      expect(saveSettings).toHaveBeenCalledTimes(1);
    });
  });
});

describe("shouldRefreshNationalHolidays", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function settingsWith(
    overrides: Partial<
      Pick<
        TaskWorkbenchSettings,
        "ganttNationalHolidays" | "ganttNationalHolidaysUpdatedAt"
      >
    >
  ): TaskWorkbenchSettings {
    return { ...DEFAULT_SETTINGS, ...overrides };
  }

  it("returns true when the national holiday list is empty", () => {
    expect(
      shouldRefreshNationalHolidays(
        settingsWith({
          ganttNationalHolidays: [],
          ganttNationalHolidaysUpdatedAt: "2026-07-29",
        })
      )
    ).toBe(true);
  });

  it("returns true when the timestamp is missing/empty", () => {
    expect(
      shouldRefreshNationalHolidays(
        settingsWith({
          ganttNationalHolidays: ["2026-01-01"],
          ganttNationalHolidaysUpdatedAt: "",
        })
      )
    ).toBe(true);
  });

  it("returns true when the timestamp is an invalid ISO string", () => {
    expect(
      shouldRefreshNationalHolidays(
        settingsWith({
          ganttNationalHolidays: ["2026-01-01"],
          ganttNationalHolidaysUpdatedAt: "not-a-date",
        })
      )
    ).toBe(true);
  });

  it("returns false when non-empty and updated within 30 days", () => {
    expect(
      shouldRefreshNationalHolidays(
        settingsWith({
          ganttNationalHolidays: ["2026-01-01"],
          ganttNationalHolidaysUpdatedAt: "2026-07-01",
        })
      )
    ).toBe(false);
  });

  it("returns true when updated more than 30 days ago", () => {
    expect(
      shouldRefreshNationalHolidays(
        settingsWith({
          ganttNationalHolidays: ["2026-01-01"],
          ganttNationalHolidaysUpdatedAt: "2026-06-01",
        })
      )
    ).toBe(true);
  });

  it("boundary: a date-only timestamp exactly 30 calendar days before now (but with a nonzero time-of-day gap) still counts as stale", () => {


    // that is 30 days AND 10 hours before now, i.e. strictly more than the
    // 30-day threshold in milliseconds, so this must still refresh.
    expect(
      shouldRefreshNationalHolidays(
        settingsWith({
          ganttNationalHolidays: ["2026-01-01"],
          ganttNationalHolidaysUpdatedAt: "2026-06-29",
        })
      )
    ).toBe(true);
  });
});

describe("normalizeDate", () => {
  it("normalizes slash separators and pads single-digit month/day", () => {
    expect(normalizeDate("2026/7/25")).toBe("2026-07-25");
    expect(normalizeDate("2026-7-25")).toBe("2026-07-25");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeDate("  2026-07-25  ")).toBe("2026-07-25");
  });

  it("rejects calendar-invalid dates", () => {
    expect(normalizeDate("2026-13-01")).toBe("");
    expect(normalizeDate("2026-02-30")).toBe("");
  });

  it("accepts a valid leap-year date", () => {
    expect(normalizeDate("2025-02-29")).toBe("");
    expect(normalizeDate("2024-02-29")).toBe("2024-02-29");
  });

  it("returns empty string for unparseable input", () => {
    expect(normalizeDate("not a date")).toBe("");
    expect(normalizeDate("")).toBe("");
    expect(normalizeDate(undefined)).toBe("");
    expect(normalizeDate(null)).toBe("");
  });
});

describe("normalizeHolidayDates", () => {
  it("accepts an array, normalizes, dedupes and sorts", () => {
    expect(
      normalizeHolidayDates(["2026-05-05", "2026/1/1", "2026-01-01", "bogus"])
    ).toEqual(["2026-01-01", "2026-05-05"]);
  });

  it("splits delimited text on CR/LF/comma/semicolon", () => {
    expect(
      normalizeHolidayDates("2026-01-01,2026-05-05;2026-12-31\n2026-01-01")
    ).toEqual(["2026-01-01", "2026-05-05", "2026-12-31"]);
  });

  it("excludes empty results", () => {
    expect(normalizeHolidayDates("")).toEqual([]);
    expect(normalizeHolidayDates([])).toEqual([]);
  });
});

describe("getEffectiveHolidays", () => {
  it("unions all three lists, deduping and sorting", () => {
    const settings: TaskWorkbenchSettings = {
      ...DEFAULT_SETTINGS,
      ganttNationalHolidays: ["2026-01-01", "2026-05-05"],
      ganttManualHolidays: ["2026-05-05", "2026-03-03"],
      ganttSpecialHolidays: ["2026-12-31"],
    };

    expect(getEffectiveHolidays(settings)).toEqual([
      "2026-01-01",
      "2026-03-03",
      "2026-05-05",
      "2026-12-31",
    ]);
  });

  it("returns an empty array when all three lists are empty", () => {
    expect(getEffectiveHolidays({ ...DEFAULT_SETTINGS })).toEqual([]);
  });
});

describe("parseCsv", () => {
  it("extracts, normalizes, dedupes and sorts dates from CSV rows, quoted or not", () => {
    const csv =
      '"2026/1/1","元日"\n2026-2-11,建国記念の日\n"2026-2-11","建国記念の日"\n';
    expect(parseCsv(csv)).toEqual(["2026-01-01", "2026-02-11"]);
  });

  it("strips a leading BOM before parsing", () => {
    const csv = '﻿"2026-01-01","元日"\n';
    expect(parseCsv(csv)).toEqual(["2026-01-01"]);
  });

  it("silently ignores malformed/header rows", () => {
    const csv =
      '"国民の祝日・休日月日","国民の祝日・休日名称"\n"2026-01-01","元日"\n,\n';
    expect(parseCsv(csv)).toEqual(["2026-01-01"]);
  });

  it("returns an empty array for CSV with no valid date rows", () => {
    expect(parseCsv("")).toEqual([]);
  });
});

describe("createRequestUrlNationalHolidayFetcher", () => {
  beforeEach(() => {
    requestUrlMock.mockReset();
  });

  it("fetches the government CSV URL with throw:false and parses success responses", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      json: null,
      text: '"2026-01-01","元日"\n"2026-05-05","こどもの日"\n',
    });

    const fetcher = createRequestUrlNationalHolidayFetcher();
    const holidays = await fetcher([]);

    expect(requestUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv",
        throw: false,
      })
    );
    expect(holidays).toEqual(["2026-01-01", "2026-05-05"]);
  });

  it("throws on a non-2xx HTTP status", async () => {
    requestUrlMock.mockResolvedValue({
      status: 500,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      json: null,
      text: "",
    });

    const fetcher = createRequestUrlNationalHolidayFetcher();
    await expect(fetcher([])).rejects.toThrow();
  });

  it("throws when the CSV response body is empty", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      json: null,
      text: "   ",
    });

    const fetcher = createRequestUrlNationalHolidayFetcher();
    await expect(fetcher([])).rejects.toThrow();
  });
});
