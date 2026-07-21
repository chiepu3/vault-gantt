export interface VaultGanttSettings {
  taskFolder: string;
  ganttZoom: number;
}

export const DEFAULT_SETTINGS: VaultGanttSettings = {
  taskFolder: 'vault-gantt',
  ganttZoom: 28,
};
