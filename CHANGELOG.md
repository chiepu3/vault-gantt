# Changelog

All notable changes to Vault Gantt will be documented in this file.

## [0.1.0] - 2026-07-21

### Initial release

**Core Task API**
- Markdown-native task notes with YAML frontmatter as single source of truth
- Subtask management with drag-to-schedule in Gantt
- Auto-priority calculation based on due date proximity
- Revision-based conflict detection for concurrent edits
- Full undo/redo support

**Workbench view**
- Table view with hierarchical parent/subtask display
- Inline editing: task name, status, due date, current status, tags
- Subtask inline editing: title, status, planned start/end dates
- Full-text search across all fields (name, status, notes, tags, path)
- Status filter dropdown
- Completed/overdue row styling
- Gantt enable toggle per task

**Gantt chart view**
- Single-scroll CSS Grid layout with sticky left column
- Drag-to-move and drag-to-resize subtask bars
- Right-click context menu: open note, complete, remove from Gantt, delete
- Empty cell right-click: add subtask at clicked date
- Floating month indicator
- Zoom in/out with persistence across sessions
- Weekend/today highlight columns
- Auto-range extension on scroll

**Infrastructure**
- Legacy task note migration command
- Daily auto-priority refresh
