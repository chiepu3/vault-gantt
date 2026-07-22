export interface GanttEvent {
  key: string;       // e.g. "ev_1234_abc"
  title: string;
  date: string;      // YYYY-MM-DD
  color?: string;    // e.g. "var(--color-red)" — optional tint
}

export interface VaultGanttSettings {
  taskFolder: string;
  ganttZoom: number;
  currentStatusRows: number;
  hideCompletedByDefault: boolean;
  enableHolidays: boolean;
  manualHolidays: string[];
  ganttEvents: GanttEvent[];
}

export const DEFAULT_SETTINGS: VaultGanttSettings = {
  taskFolder: 'vault-gantt',
  ganttZoom: 28,
  currentStatusRows: 3,
  hideCompletedByDefault: false,
  enableHolidays: true,
  manualHolidays: [],
  ganttEvents: [],
};
