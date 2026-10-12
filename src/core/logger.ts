
import type { App } from "obsidian";

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  scope: string;
  message: string;
  data?: string;
}

const RING_BUFFER_LIMIT = 500;
const RECORDING_BUFFER_LIMIT = 20_000;
const LOG_FOLDER = "_vault-gantt-logs";
const DEFAULT_RECORDING_NAME = "recording";

/**
 * Central logging entry point for console output, recent-log retention, and
 * opt-in diagnostic recordings.
 */
export class Logger {
  private readonly ringBuffer: LogEntry[] = [];
  private recordingBuffer: LogEntry[] = [];
  private recordingActive = false;
  private recordingName = DEFAULT_RECORDING_NAME;
  private recordingRevision = 0;

  constructor(private readonly app: App) {}

  debug(scope: string, message: string, data?: unknown): void {
    this.log("debug", scope, message, data);
  }

  info(scope: string, message: string, data?: unknown): void {
    this.log("info", scope, message, data);
  }

  warn(scope: string, message: string, data?: unknown): void {
    this.log("warn", scope, message, data);
  }

  error(scope: string, message: string, data?: unknown): void {
    this.log("error", scope, message, data);
  }

  startRecording(name?: string): void {
    this.recordingRevision++;
    this.recordingName =
      name?.trim().replace(/[^A-Za-z0-9_-]/g, "_") || DEFAULT_RECORDING_NAME;
    this.recordingBuffer = [];
    this.recordingActive = true;
  }

  /** Planning reads only. Do not call stopRecording before human approval. */
  inspectRecording(): { revision: number; recording: boolean; name: string; content: string; entryCount: number } {
    return { revision: this.recordingRevision, recording: this.recordingActive, name: this.recordingName, content: this.recordingBuffer.map((entry) => JSON.stringify(entry)).join("\n"), entryCount: this.recordingBuffer.length };
  }

  /** Clear only the exact recording whose frozen bytes have been successfully saved. */
  finishRecording(revision: number): boolean {
    if (revision !== this.recordingRevision || !this.recordingActive) return false;
    this.recordingActive = false; this.recordingBuffer = []; this.recordingRevision++;
    return true;
  }

  async stopRecording(): Promise<void> {
    if (!this.recordingActive) {
      return;
    }

    const entries = this.recordingBuffer;
    const recordingName = this.recordingName;
    this.recordingActive = false;
    this.recordingBuffer = [];
    this.recordingRevision++;

    try {
      await this.app.vault.createFolder(LOG_FOLDER);
    } catch (error) {
      const existingFolder =
        this.app.vault.getAbstractFileByPath(LOG_FOLDER);
      if (!existingFolder) {
        throw error;
      }
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = `${LOG_FOLDER}/${recordingName}_${timestamp}.log`;
    const content = entries.map((entry) => JSON.stringify(entry)).join("\n");
    await this.app.vault.create(path, content);
  }

  private log(
    level: LogLevel,
    scope: string,
    message: string,
    data?: unknown
  ): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      scope,
      message,
      ...(data === undefined ? {} : { data: this.serializeData(data) }),
    };

    const consoleMessage = `[${entry.timestamp}] [${scope}] ${message}`;

    if (data === undefined) {
      console[level](consoleMessage);
    } else {
      console[level](consoleMessage, data);
    }


    this.ringBuffer.push(entry);
    if (this.ringBuffer.length > RING_BUFFER_LIMIT) {
      this.ringBuffer.shift();
    }

    if (this.recordingActive) {
      this.recordingRevision++;
      this.recordingBuffer.push(entry);
      if (this.recordingBuffer.length > RECORDING_BUFFER_LIMIT) {
        this.recordingBuffer.shift();
      }
    }
  }

  /**
 * Single insertion point for future masking or other data transformations.
 */
  private serializeData(data: unknown): string {
    try {
      const serialized = JSON.stringify(data);
      return serialized === undefined ? String(data) : serialized;
    } catch {
      return String(data);
    }
  }
}
