import { App, Modal } from 'obsidian';

/** Single-field date input modal. */
export class DateInputModal extends Modal {
  constructor(
    app: App,
    private readonly label: string,
    private readonly defaultDate: string,
    private readonly onSubmit: (date: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: this.label });

    const inp = contentEl.createEl('input', { type: 'date' });
    inp.value = this.defaultDate;
    inp.style.cssText = 'width:100%;margin-bottom:0.75rem;';

    const btn = contentEl.createEl('button', { text: '移動' });
    btn.addClass('mod-cta');

    const submit = () => {
      if (!inp.value) return;
      this.close();
      this.onSubmit(inp.value);
    };

    btn.addEventListener('click', submit);
    inp.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
      if (e.key === 'Escape') this.close();
    });

    window.setTimeout(() => inp.focus(), 30);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
