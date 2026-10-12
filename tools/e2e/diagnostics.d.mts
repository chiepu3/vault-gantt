import type { ChildProcess } from "node:child_process";

export interface ProcessState {
  exited: boolean;
  code: number | null;
  signal: string | null;
  alive: boolean;
}
export interface DiagnosticEntry {
  name: string;
  pid: number | undefined;
  state: ProcessState;
  logFile?: string;
}
export function readLogTail(file: string, maxBytes?: number): string;
export function isProcessAlive(pid: number | undefined): boolean;
export function trackExit(proc: ChildProcess): { pid: number | undefined; state: () => ProcessState };
export function formatProcessState(name: string, pid: number | undefined, state: ProcessState): string;
export function formatStartupDiagnostics(entries: DiagnosticEntry[], options?: { tailBytes?: number }): string;
