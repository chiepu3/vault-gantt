import { ItemView } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import type { PreviewUiHostPorts } from "../contracts/ports";
import type { OperationPreviewV1 } from "../contracts/preview";
import { captureFocusKey, cardState, PreviewCardController, renderOperationPreviewCard, restoreFocusKey, type PreviewCardExtras } from "./operation-preview-card";
import { h } from "./preview-renderers";

export const VIEW_TYPE_AI_APPROVAL = "vault-gantt-ai-approval";
export interface ApprovalViewHost extends PreviewUiHostPorts, PreviewCardExtras {}

/** Human approval list for requests that arrived from outside the chat (MCP). Uses the same card as the chat. */
export class ApprovalView extends ItemView {
  private unsubscribe: (() => void)[] = [];
  private controller?: PreviewCardController;
  private listEl!: HTMLElement;
  private summaryEl!: HTMLElement;
  private timer?: ReturnType<typeof setTimeout>;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  constructor(leaf: WorkspaceLeaf, private readonly host: ApprovalViewHost) { super(leaf); }
  getViewType(): string { return VIEW_TYPE_AI_APPROVAL; }
  getDisplayText(): string { return "承認一覧"; }
  getIcon(): string { return "shield-check"; }
  async onOpen(): Promise<void> {
    const root = (this.containerEl.children[1] ?? this.containerEl) as HTMLElement;
    root.empty(); root.classList.add("vg-pv-approval");
    const header = h(root, "header", "vg-pv-approval-head");
    h(header, "strong", "", "承認一覧");
    this.summaryEl = h(header, "span", "vg-pv-muted"); this.summaryEl.setAttribute("role", "status"); this.summaryEl.setAttribute("aria-live", "polite");
    h(root, "p", "vg-pv-note", "外部のAI（MCP）からの変更案です。ここで承認するまでVaultは変更されません。");
    this.listEl = h(root, "div", "vg-pv-approval-list");
    this.controller = new PreviewCardController(this.host, this.host, () => this.schedule());
    this.unsubscribe = [this.host.previewPort.subscribe(() => this.schedule()), this.host.historyPort.subscribe(() => this.schedule())];
    this.render();
  }
  async onClose(): Promise<void> {
    for (const stop of this.unsubscribe) stop();
    this.unsubscribe = [];
    if (this.timer) clearTimeout(this.timer); if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.timer = undefined; this.expiryTimer = undefined; this.controller = undefined;
    // Pending MCP plans stay in the store; only the Gantt focus owned by this list is released.
    const focused = this.host.previewPort.focusedPreviewId();
    if (focused && this.requests().some((preview) => preview.previewId === focused)) this.host.previewPort.focus(null);
  }
  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.render(); }, 40);
  }
  private requests(): OperationPreviewV1[] {
    return this.host.previewPort.list().filter((preview) => preview.origin.kind === "mcp").slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }
  render(): void {
    const controller = this.controller; if (!controller || !this.listEl) return;
    const focusKey = captureFocusKey();
    const now = Date.now();
    const previews = this.requests();
    controller.pager.prune(new Set(previews.map((preview) => preview.previewId)));
    const state = (preview: OperationPreviewV1) => cardState(preview, this.host.previewPort.inspectOutcome(preview.previewId), undefined, now);
    const waiting = previews.filter((preview) => ["pending", "applying"].includes(state(preview)));
    const rest = previews.filter((preview) => !waiting.includes(preview));
    this.summaryEl.textContent = `承認待ち ${waiting.length}件 · 処理済み ${rest.length}件`;
    this.listEl.empty();
    if (!previews.length) {
      const empty = h(this.listEl, "div", "vg-pv-empty");
      h(empty, "strong", "", "承認待ちの要求はありません");
      h(empty, "p", "", "MCP経由のAIが変更案を出すと、ここに表示されます。");
    }
    const section = (title: string, items: OperationPreviewV1[]): void => {
      if (!items.length) return;
      const group = h(this.listEl, "section", "vg-pv-approval-group"); group.setAttribute("aria-label", title);
      h(group, "h3", "vg-pv-group-title", `${title}（${items.length}）`);
      for (const preview of items) renderOperationPreviewCard(group, preview, controller.optionsFor(preview));
    };
    section("承認待ち", waiting);
    section("処理済み・期限切れ", rest);
    restoreFocusKey(this.listEl, focusKey);
    // A pending card turns into 期限切れ without any port event, so re-render at the next expiry.
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    const next = waiting.map((preview) => Date.parse(preview.expiresAt) - now).filter((ms) => ms > 0).sort((a, b) => a - b)[0];
    this.expiryTimer = next === undefined ? undefined : setTimeout(() => { this.expiryTimer = undefined; this.render(); }, Math.min(next + 50, 2147483647));
  }
}
