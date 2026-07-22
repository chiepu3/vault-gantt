import { App, Modal } from 'obsidian';

export interface MarkerInput {
  date: string;
  label: string;
}

/** Two-field modal for adding a Gantt marker: date + optional label. */
export class MarkerModal extends Modal {
  private readonly defaultDate: string;
  private readonly onSubmit: (input: MarkerInput) => void;

  constructor(app: App, defaultDate: string, onSubmit: (input: MarkerInput) => void) {
    super(app);
    this.defaultDate = defaultDate;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'マーカーを追加' });

    const dateLabel = contentEl.createEl('label', { text: '日付' });
    dateLabel.style.cssText = 'display:block;margin-bottom:0.25rem;font-weight:500;';
    const dateInput = contentEl.createEl('input', { type: 'date' });
    dateInput.value = this.defaultDate;
    dateInput.style.cssText = 'width:100%;margin-bottom:0.75rem;';

    const labelLabel = contentEl.createEl('label', { text: 'ラベル（任意）' });
    labelLabel.style.cssText = 'display:block;margin-bottom:0.25rem;font-weight:500;';
    const labelInput = contentEl.createEl('input', { type: 'text', placeholder: 'マイルストーン名...' });
    labelInput.style.cssText = 'width:100%;margin-bottom:0.75rem;';

    const btn = contentEl.createEl('button', { text: '追加' });
    btn.addClass('mod-cta');

    const submit = () => {
      const date = dateInput.value;
      if (!date) {
        dateInput.style.outline = '2px solid var(--color-red)';
        dateInput.focus();
        return;
      }
      this.close();
      this.onSubmit({ date, label: labelInput.value.trim() });
    };

    btn.addEventListener('click', submit);
    [dateInput, labelInput].forEach((el) => {
      el.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
        if (e.key === 'Escape') this.close();
      });
    });

    window.setTimeout(() => dateInput.focus(), 30);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
