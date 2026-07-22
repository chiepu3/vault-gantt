# Vault Gantt

An [Obsidian](https://obsidian.md) plugin for task management and Gantt chart scheduling, using Markdown notes as the single source of truth.

> **Personal use / 個人用途**: This plugin is developed primarily for personal use. It is published as open source for anyone who finds it useful, but active community support is not planned.

## Features

### Workbench (table view)
- Hierarchical task/subtask table with inline editing (double-click any cell)
- Fields: name, status, current status, due date, tags, planned dates, priority (0–5)
- Auto-priority: when `priorityMode: auto`, priority is computed live from due date
- Full-text search across all task fields (name, current status, tags)
- Status and tag filter dropdowns
- Overdue row highlighting
- Gantt visibility toggle per task
- Flat view toggle (shows subtasks as top-level rows)

### Gantt chart view
- CSS Grid layout with sticky left column — no scroll-jump on horizontal scroll
- Drag bars to move/resize subtask schedules (business-day snapping)
- Zoom in/out (persisted between sessions) with px/day display
- Right-click bar: complete, remove from Gantt, add marker, batch move, tag add/remove, delete, open note
- Right-click empty area: add subtask, set/clear parent due date
- Double-click bar: open details popover (status, dates, workload hours, current status)
- Double-click parent title: rename
- Marker ▲ drag: move milestone markers within planned date range
- Due-date ★ drag: move parent due date with business-day snap

### Popover (click a Gantt bar)
- Status, planned start/end, due date, completed toggle
- Current status textarea with auto-save (debounce 800ms, or Ctrl+Enter)
- Workload hours (計画/実績) per workday — 0.5h step, up to 30 calendar days

### Calendar features
- Weekend and public holiday highlighting (2024–2028 static; auto-updated from Cabinet Office CSV, 30-day cache)
- Click date header cell to toggle custom manual holidays (weekends and national holidays are protected)
- Event row: user-defined ◆ events shown below date header; right-click to add/edit/delete

### Workload summary row
- Daily planned-hours total shown as colored chips below events: green (<6h), orange (6–8h), red (≥8h)
- Only visible when at least one task has workload data

### Embed in notes
- Embed a read-only Gantt view in any note using a fenced code block:

````markdown
```vault-gantt-embed
range: 60
zoom: 20
task: vault-gantt/MyTask.md
```
````

  Config keys are all optional (defaults: `range=90`, `zoom=plugin setting`).

### Data model
- Each task is a Markdown note with YAML frontmatter (`type: task`)
- Subtasks, planned dates, tags, workload, markers all stored inline in the note
- Revision-based conflict detection
- Undo (Ctrl+Z) support — last 20 operations, session-scoped
- Legacy task note migration command

## Installation

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/chiepu3/vault-gantt/releases/latest)
2. Create folder `.obsidian/plugins/vault-gantt/` in your vault
3. Copy the three files into that folder
4. Enable the plugin in **Settings → Community plugins**

### BRAT (Beta Reviewers Auto-update Tool)

Add `chiepu3/vault-gantt` via [BRAT](https://github.com/TfTHacker/obsidian42-brat).

## Usage

1. Set your task folder in **Settings → Vault Gantt → Task folder** (default: `vault-gantt/`)
2. Create a task via the command palette: **Vault Gantt: 新しいタスクを作成**
3. Open the Workbench via **Vault Gantt: タスク一覧を開く**
4. Open the Gantt chart via **Vault Gantt: Ganttビューを開く**

### Task note format

```yaml
---
type: task
displayName: Design Phase
status: in-progress
dueDate: 2026-08-01
priority: 3
priorityMode: manual
tags: [project-a]
ganttEnabled: true
ganttOrder: 1
subtasks:
  - key: st_1234_abc
    title: Wireframes
    plannedStartDate: 2026-07-21
    plannedEndDate: 2026-07-25
    statusLabel: active
    tags: [ux]
    workloadPlan:
      2026-07-21: 4
      2026-07-22: 4
    workloadActual:
      2026-07-21: 3.5
    markers:
      - key: mk_5678_def
        title: Review
        date: 2026-07-24
---

Current status notes go here (free text, persisted across edits).
```

### Keyboard shortcuts

See [docs/KEYMAP.md](docs/KEYMAP.md) for all keyboard shortcuts.

| Action | Shortcut |
|--------|----------|
| Undo last action | Ctrl+Z (command palette) |
| Save current status | Ctrl+Enter (in popover textarea) |
| Close popover | Escape |

## Development

```bash
git clone https://github.com/chiepu3/vault-gantt
cd vault-gantt
npm install
npm run dev        # watch mode (builds to vault plugin folder)
npm run verify     # typecheck + lint + test
npm run build      # production build
npm test           # run tests only
```

### Releasing

```bash
node scripts/bump-version.mjs 0.2.0
git add package.json manifest.json versions.json CHANGELOG.md
git commit -m "chore: bump version to 0.2.0"
git tag v0.2.0
git push && git push --tags
```

GitHub Actions will build and create the release automatically.

## Architecture

```
src/
  domain/          Pure business logic (no Obsidian dependency)
    task-note/     Parse / serialize / migrate task notes
    business-days  Business day calculations
    priority       Auto-priority scoring
    status         Status label defaults
  application/     Core Task API (JSON in/out, Obsidian-free)
    core-task-api  CRUD + undo + change notification
  infra/           Obsidian adapter
    obsidian-vault-adapter
  ui/
    workbench/     Svelte 5 table view
    gantt/         Vanilla TS Gantt (renderer, drag, popover, embed)
    shared/        Modals, badges
  main.ts          Plugin entry point (dependency injection)
```

Tests: 274 passing (vitest). TypeScript strict mode. ESLint flat config.

## License

MIT — see [LICENSE](LICENSE)
