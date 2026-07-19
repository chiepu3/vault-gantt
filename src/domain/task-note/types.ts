export interface Marker {
  key: string;
  title: string;
  date: string; // YYYY-MM-DD
  tags: string[];
}

export interface Subtask {
  key: string;
  title: string;
  statusLabel: string;
  createdAt: string; // YYYY-MM-DD
  updatedAt: string;
  dueDate: string | null;
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  workloadPlan: Record<string, number>; // date -> hours, 0.5h increments
  workloadActual: Record<string, number>;
  priority: number; // 0-5
  priorityMode: 'auto' | 'manual';
  tags: string[];
  completed: boolean;
  markers: Marker[];
  currentStatus: string; // freeform body text, verbatim round-trip
  notes: string; // freeform body text, verbatim round-trip
}

export interface TaskNote {
  displayName: string;
  statusLabel: string;
  createdAt: string;
  updatedAt: string;
  dueDate: string | null;
  priority: number;
  priorityMode: 'auto' | 'manual';
  tags: string[];
  completed: boolean;
  ganttEnabled: boolean;
  ganttOrder: number;
  subtaskOrder: string[];
  subtasks: Subtask[];
  currentStatus: string; // freeform body text, verbatim round-trip
  notes: string; // freeform body text, verbatim round-trip
}
