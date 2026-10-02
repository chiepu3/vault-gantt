
import { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock, MockInstance } from "vitest";
import { Logger } from "../../src/core/logger";

interface StoredLogEntry {
  timestamp: string;
  level: string;
  scope: string;
  message: string;
  data?: string;
}

interface LoggerInternals {
  ringBuffer: StoredLogEntry[];
  recordingBuffer: StoredLogEntry[];
}

interface VaultMock {
  createFolder: Mock;
  create: Mock;
  getAbstractFileByPath: Mock;
}

describe("Logger", () => {
  let app: App;
  let vault: VaultMock;
  let consoleSpies: MockInstance[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T12:34:56.789Z"));

    vault = {
      createFolder: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue(undefined),
      getAbstractFileByPath: vi.fn().mockReturnValue(null),
    };
    app = new App();
    app.vault = vault as unknown as App["vault"];

    consoleSpies = (["debug", "info", "warn", "error"] as const).map(
      (level) => vi.spyOn(console, level).mockImplementation(() => undefined)
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function internals(logger: Logger): LoggerInternals {
    return logger as unknown as LoggerInternals;
  }

  it("keeps only the latest 500 entries in its always-on ring buffer", () => {
    const logger = new Logger(app);

    for (let index = 0; index <= 500; index += 1) {
      logger.info("ring", `entry-${index}`);
    }

    expect(internals(logger).ringBuffer).toHaveLength(500);
    expect(internals(logger).ringBuffer[0].message).toBe("entry-1");
    expect(internals(logger).ringBuffer[499].message).toBe("entry-500");
  });

  it("accumulates recording entries only after start and before stop", async () => {
    const logger = new Logger(app);
    logger.debug("recording", "before");

    logger.startRecording("window");
    logger.info("recording", "during", { count: 1 });

    expect(internals(logger).recordingBuffer).toHaveLength(1);
    await logger.stopRecording();
    logger.warn("recording", "after");

    const content = vault.create.mock.calls[0][1] as string;
    expect(content).toContain('"message":"during"');
    expect(content).toContain('"data":"{\\"count\\":1}"');
    expect(content).not.toContain('"message":"before"');
    expect(content).not.toContain('"message":"after"');
    expect(internals(logger).recordingBuffer).toHaveLength(0);
  });

  it("caps the active recording buffer at 20000 entries", () => {
    const logger = new Logger(app);
    logger.startRecording("bounded");

    for (let index = 0; index <= 20_000; index += 1) {
      logger.debug("recording", `entry-${index}`);
    }

    expect(internals(logger).recordingBuffer).toHaveLength(20_000);
    expect(internals(logger).recordingBuffer[0].message).toBe("entry-1");
    expect(internals(logger).recordingBuffer[19_999].message).toBe(
      "entry-20000"
    );
  });

  it("writes the recording to the expected vault folder and named file", async () => {
    const logger = new Logger(app);
    logger.startRecording("diagnostic");
    logger.error("sync", "failed", new Error("offline"));

    await logger.stopRecording();

    expect(vault.createFolder).toHaveBeenCalledWith("_vault-gantt-logs");
    expect(vault.create).toHaveBeenCalledWith(
      "_vault-gantt-logs/diagnostic_2026-08-13T12-34-56-789Z.log",
      expect.stringContaining('"level":"error"')
    );
    expect(vault.create.mock.calls[0][1]).toContain('"data":"{}"');
  });

  it("uses the default recording name when none is supplied", async () => {
    const logger = new Logger(app);
    logger.startRecording();

    await logger.stopRecording();

    expect(vault.create.mock.calls[0][0]).toMatch(
      /^_vault-gantt-logs\/recording_.+\.log$/
    );
  });

  it("sanitizes recording names into a single safe path segment", async () => {
    const logger = new Logger(app);
    logger.startRecording("../../evil/name");

    await logger.stopRecording();

    expect(vault.create.mock.calls[0][0]).toBe(
      "_vault-gantt-logs/______evil_name_2026-08-13T12-34-56-789Z.log"
    );
  });

  it("does nothing when recording was never started", async () => {
    const logger = new Logger(app);

    await expect(logger.stopRecording()).resolves.toBeUndefined();

    expect(vault.createFolder).not.toHaveBeenCalled();
    expect(vault.create).not.toHaveBeenCalled();
  });

  it("mirrors every level to the corresponding console method", () => {
    const logger = new Logger(app);
    const debugData = { value: 1 };

    logger.debug("console", "debug", debugData);
    logger.info("console", "info");
    logger.warn("console", "warn");
    logger.error("console", "error");

    for (const spy of consoleSpies) {
      expect(spy).toHaveBeenCalledTimes(1);
    }
    expect(consoleSpies[0]).toHaveBeenCalledWith(
      expect.stringContaining("[console] debug"),
      debugData
    );
  });

  it("mirrors the original Error while retaining serialized buffer data", () => {
    const logger = new Logger(app);
    const error = new Error("offline");

    logger.error("sync", "failed", error);

    expect(consoleSpies[3]).toHaveBeenCalledWith(
      expect.stringContaining("[sync] failed"),
      error
    );
    expect(consoleSpies[3].mock.calls[0][1]).toBe(error);
    expect(internals(logger).ringBuffer[0].data).toBe("{}");
  });

  it("continues writing when createFolder reports that the folder exists", async () => {
    vault.createFolder.mockRejectedValue(new Error("mkdir failed"));
    vault.getAbstractFileByPath.mockReturnValue({
      path: "_vault-gantt-logs",
    });
    const logger = new Logger(app);
    logger.startRecording("existing-folder");
    logger.info("recording", "entry");

    await expect(logger.stopRecording()).resolves.toBeUndefined();

    expect(vault.create).toHaveBeenCalledTimes(1);
  });

  it("propagates an unrelated createFolder error", async () => {
    vault.createFolder.mockRejectedValue(new Error("Permission denied"));
    const logger = new Logger(app);
    logger.startRecording("failed-folder");

    await expect(logger.stopRecording()).rejects.toThrow("Permission denied");

    expect(vault.getAbstractFileByPath).toHaveBeenCalledWith(
      "_vault-gantt-logs"
    );
    expect(vault.create).not.toHaveBeenCalled();
  });
});
