import { App, Modal } from 'obsidian';
import type { CoreTaskAPI, TaskRecord } from '../../application/core-task-api';

/** Fuzzy task search modal — type to filter, Enter/click to open note. */
export class TaskFinderModal extends Modal {
  private records: TaskRecord[] = [];
  private listEl!: HTMLElement;
  private inputEl!: HTMLInputElement;
  private selectedIdx = 0;

  constructor(
    app: App,
    private api: CoreTaskAPI,
    private onSelect?: (record: TaskRecord) => void,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.addClass('vg-task-finder');

    contentEl.createEl('h2', { text: 'タスクを検索', cls: 'vg-task-finder-title' });

    this.inputEl = contentEl.createEl('input', {
      type: 'text',
      placeholder: 'タスク名を入力...',
      cls: 'vg-task-finder-input',
    });

    this.listEl = contentEl.createDiv({ cls: 'vg-task-finder-list' });

    try {
      this.records = await this.api.listTasks();
    } catch {
      this.listEl.createDiv({ cls: 'vg-task-finder-empty', text: 'タスクの読み込みに失敗しました' });
      return;
    }
    this.render('');

    this.inputEl.addEventListener('input', () => {
      this.selectedIdx = 0;
      this.render(this.inputEl.value);
    });

    this.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
      const items = this.listEl.querySelectorAll('.vg-task-finder-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.selectedIdx = Math.min(this.selectedIdx + 1, items.length - 1);
        this.updateSelection(items);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.selectedIdx = Math.max(this.selectedIdx - 1, 0);
        this.updateSelection(items);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const selected = items[this.selectedIdx] as HTMLElement | undefined;
        if (selected) selected.click();
      } else if (e.key === 'Escape') {
        this.close();
      }
    });

    window.setTimeout(() => this.inputEl.focus(), 30);
  }

  private render(query: string): void {
    this.listEl.empty();
    const q = query.toLowerCase();
    const filtered = q
      ? this.records.filter((r) => r.note.displayName.toLowerCase().includes(q))
      : this.records.slice(0, 50);

    if (filtered.length === 0) {
      this.listEl.createDiv({ cls: 'vg-task-finder-empty', text: '該当するタスクがありません' });
      return;
    }

    filtered.forEach((record, i) => {
      const item = this.listEl.createDiv({ cls: 'vg-task-finder-item' });
      if (i === this.selectedIdx) item.addClass('is-selected');

      const name = item.createSpan({ cls: 'vg-task-finder-name', text: record.note.displayName });
      if (q) {
        // Bold the matching segment
        const idx = record.note.displayName.toLowerCase().indexOf(q);
        if (idx !== -1) {
          name.empty();
          name.appendText(record.note.displayName.slice(0, idx));
          name.createEl('strong', { text: record.note.displayName.slice(idx, idx + q.length) });
          name.appendText(record.note.displayName.slice(idx + q.length));
        }
      }

      if (record.note.statusLabel) {
        item.createSpan({ cls: 'vg-task-finder-status', text: record.note.statusLabel });
      }

      item.addEventListener('click', () => {
        this.close();
        if (this.onSelect) {
          this.onSelect(record);
        } else {
          void this.app.workspace.openLinkText(record.path, '');
        }
      });

      item.addEventListener('mouseenter', () => {
        this.selectedIdx = i;
        this.updateSelection(this.listEl.querySelectorAll('.vg-task-finder-item'));
      });
    });
  }

  private updateSelection(items: NodeListOf<Element>): void {
    items.forEach((el, i) => {
      el.toggleClass('is-selected', i === this.selectedIdx);
    });
    const sel = items[this.selectedIdx] as HTMLElement | undefined;
    sel?.scrollIntoView({ block: 'nearest' });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
