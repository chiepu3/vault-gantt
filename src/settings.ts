export interface VaultGanttSettings {
  taskFolder: string;
  ganttZoom: number;
  currentStatusRows: number;
  hideCompletedByDefault: boolean;
  enableHolidays: boolean;
  manualHolidays: string[];
}

export const DEFAULT_SETTINGS: VaultGanttSettings = {
  taskFolder: 'vault-gantt',
  ganttZoom: 28,
  currentStatusRows: 3,
  hideCompletedByDefault: false,
  enableHolidays: true,
  manualHolidays: [],
};
