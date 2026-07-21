# Vault Gantt

An [Obsidian](https://obsidian.md) plugin for task management and Gantt chart scheduling, using Markdown notes as the single source of truth.

> **Personal use / 個人用途**: This plugin is developed primarily for personal use. It is published as open source for anyone who finds it useful, but active community support is not planned.

## Features

### Workbench (table view)
- Hierarchical task/subtask table with inline editing
- Fields: name, status, current status, due date, tags, planned dates, priority
- Full-text search across all task fields
- Status filter dropdown
- Overdue row highlighting
- Gantt visibility toggle per task

### Gantt chart view
- CSS Grid layout with sticky left column — no scroll-jump issues
- Drag bars to move/resize subtask schedules
- Right-click bar: complete, remove from Gantt, delete, open note
- Right-click empty area: add subtask at clicked date
- Floating month label, weekend/today highlights
- Zoom in/out (persisted between sessions)

### Data model
- Each task is a Markdown note with YAML frontmatter (`type: task`)
- Subtasks, planned dates, tags, current status all stored in the note
- Revision-based conflict detection
- Undo/redo support
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

1. Set your task folder in **Settings → Vault Gantt → Task folder** (default: `tasks/`)
2. Create a task note via the command palette: **Vault Gantt: 新規タスクを作成**
3. Open the Workbench via **Vault Gantt: Workbenchを開く**
4. Open the Gantt chart via **Vault Gantt: Ganttビューを開く**

### Task note format

```yaml
---
type: task
displayName: My Task
status: in-progress
dueDate: 2026-08-01
tags: [project-a]
ganttEnabled: true
subtasks:
  - key: st_1234
    title: Design phase
    plannedStartDate: 2026-07-21
    plannedEndDate: 2026-07-25
---

Current status notes go here.
```

## Development

```bash
git clone https://github.com/chiepu3/vault-gantt
cd vault-gantt
npm install
npm run dev        # watch mode
npm run verify     # typecheck + lint + test
npm run build      # production build
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

## License

MIT — see [LICENSE](LICENSE)
