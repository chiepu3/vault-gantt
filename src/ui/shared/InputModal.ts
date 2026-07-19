import { App, Modal } from 'obsidian';

/** Single-field text input modal, replacing prompt() which is unsupported in Electron. */
export class InputModal extends Modal {
  private readonly label: string;
  private readonly placeholder: string;
  private readonly onSubmit: (value: string) => void;

  constructor(app: App, label: string, placeholder: string, onSubmit: (value: string) => void) {
    super(app);
    this.label = label;
    this.placeholder = placeholder;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: this.label });

    const input = contentEl.createEl('input', {
      type: 'text',
      placeholder: this.placeholder,
    });
    input.style.cssText = 'width:100%;margin-bottom:0.75rem;';

    const btn = contentEl.createEl('button', { text: '作成' });
    btn.addClass('mod-cta');

    const submit = () => {
      const value = input.value.trim();
      if (!value) return;
      this.close();
      this.onSubmit(value);
    };

    btn.addEventListener('click', submit);
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      if (e.key === 'Escape') this.close();
    });

    // autofocus via setTimeout because Obsidian steals focus on open
    window.setTimeout(() => input.focus(), 30);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
