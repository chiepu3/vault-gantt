/**
 * Minimal stub module for Obsidian API.
 * Used only for unit testing; production uses the real obsidian package.
 */
/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any */

export { default as moment } from "moment";

export class Plugin {
  async onload(): Promise<void> {}
  async onunload(): Promise<void> {}
}

export class PluginSettingTab {
  constructor(public app: App, public plugin: Plugin) {}
  display(): void {}
}

export class Setting {
  constructor(_containerEl: HTMLElement) {}
  setName(_name: string): this {
    return this;
  }
  setDesc(_desc: string): this {
    return this;
  }
  addText(_callback: (text: any) => void): this {
    return this;
  }
  addToggle(_callback: (toggle: any) => void): this {
    return this;
  }
  addButton(_callback: (button: any) => void): this {
    return this;
  }
}

export class Modal {
  constructor(_app: App) {}
  open(): void {}
  close(): void {}
}

export class ItemView {
  containerEl: HTMLElement = document.createElement("div");
  getViewType(): string {
    return "";
  }
  getDisplayText(): string {
    return "";
  }
  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
}

export class Notice {
  constructor(_message?: string) {}
}

export class TFile {
  name: string = "";
  path: string = "";
  extension: string = "";
  basename: string = "";
}

export class TFolder {
  name: string = "";
  path: string = "";
}

export class App {
  vault: any = {};
  workspace: any = {};
}









export function setIcon(parent: HTMLElement, iconId: string): void {
  const svg = document.createElement("svg"); svg.setAttribute("data-icon", iconId);
  parent.replaceChildren(svg);
}

export class MenuItem {
  dom: any;
  submenu: Menu | undefined = undefined;
  private disabled = false;

  constructor(dom: any) {
    this.dom = dom;
    this.dom.classList.add("menu-item");
  }
  setTitle(title: string | any): this {
    if (typeof title === "string") {
      this.dom.textContent = title;
    } else if (title?.nodeType === 11 && Array.isArray(title.children)) {
      this.dom.replaceChildren(...title.children);
    } else {
      this.dom.textContent = String(title);
    }
    return this;
  }
  setIcon(_icon: string | null): this {
    return this;
  }
  setChecked(checked: boolean | null): this {
    this.dom.classList.toggle("is-checked", checked === true);
    if (checked === null) {
      delete this.dom.attributes["aria-checked"];
    } else {
      this.dom.setAttribute("aria-checked", String(checked));
    }
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    this.dom.classList.toggle("is-disabled", disabled);
    return this;
  }
  setWarning(isWarning: boolean): this {
    this.dom.classList.toggle("is-warning", isWarning);
    return this;
  }
  setIsLabel(_isLabel: boolean): this {
    return this;
  }
  setSubmenu(): Menu {
    if (!this.submenu) {
      this.submenu = new Menu();
      this.dom.classList.add("has-submenu");
    }
    return this.submenu;
  }
  onClick(callback: (evt: any) => any): this {
    this.dom.addEventListener("click", (evt: any) => {
      if (this.disabled) {
        return;
      }
      callback(evt);
    });
    return this;
  }
  setSection(_section: string): this {
    return this;
  }
}








export class Menu {
  static autoHideOnItemClick = false;
  dom: any;
  parentElement: any = undefined;
  parentMenu: Menu | undefined = undefined;
  currentSubmenu: Menu | undefined = undefined;
  private hideCallbacks: Array<() => void> = [];
  private outsideMouseDownHandler: ((evt: any) => void) | undefined = undefined;

  constructor() {
    this.dom = (globalThis as any).document.createElement("div");
    this.dom.classList.add("menu");
  }
  setNoIcon(): this {
    return this;
  }
  setUseNativeMenu(_useNativeMenu: boolean): this {
    return this;
  }
  addItem(callback: (item: MenuItem) => any): this {
    const itemDom = (globalThis as any).document.createElement("div");
    this.dom.appendChild(itemDom);
    const item = new MenuItem(itemDom);
    callback(item);

    const openSubmenu = (): void => {
      if (item.submenu) {
        this.openSubmenu(item.submenu);
      }
    };
    itemDom.addEventListener("mouseenter", openSubmenu);
    itemDom.addEventListener("pointerover", openSubmenu);
    itemDom.addEventListener("click", () => {
      if (item.submenu) {
        this.openSubmenu(item.submenu);
      } else if (Menu.autoHideOnItemClick) {
        this.hide();
      }
    });
    return this;
  }
  addSeparator(): this {
    const sep = (globalThis as any).document.createElement("div");
    sep.classList.add("menu-separator");
    this.dom.appendChild(sep);
    return this;
  }
  setParentElement(el: any): this {
    this.parentElement = el;
    return this;
  }
  showAtMouseEvent(_evt: any): this {
    return this.showAtPosition({ x: 0, y: 0 });
  }
  showAtPosition(_pos: { x: number; y: number }): this {
    if (!this.dom.parentNode) {
      (globalThis as any).document.body.appendChild(this.dom);
    }
    const win = (globalThis as any).window;
    if (!this.outsideMouseDownHandler && win?.addEventListener) {
      this.outsideMouseDownHandler = (evt: any): void => {
        if (!this.isInside(evt.target)) {
          this.hide();
        }
      };
      win.addEventListener("mousedown", this.outsideMouseDownHandler);
    }
    return this;
  }
  hide(): this {
    const child = this.currentSubmenu;
    this.currentSubmenu = undefined;
    if (child) {
      child.parentMenu = undefined;
      child.hide();
    }
    const parent = this.parentMenu;
    this.parentMenu = undefined;
    if (parent?.currentSubmenu === this) {
      parent.currentSubmenu = undefined;
    }
    const win = (globalThis as any).window;
    if (this.outsideMouseDownHandler && win?.removeEventListener) {
      win.removeEventListener("mousedown", this.outsideMouseDownHandler);
      this.outsideMouseDownHandler = undefined;
    }
    this.dom.remove();
    const callbacks = this.hideCallbacks;
    this.hideCallbacks = [];
    for (const cb of callbacks) {
      cb();
    }
    return this;
  }
  close(): void {
    this.hide();
  }
  onHide(callback: () => any): void {
    this.hideCallbacks.push(callback);
  }
  static forEvent(_evt: any): Menu {
    return new Menu();
  }

  private openSubmenu(submenu: Menu): void {
    if (this.currentSubmenu === submenu) {
      return;
    }
    const previous = this.currentSubmenu;
    this.currentSubmenu = submenu;
    previous?.hide();
    submenu.parentMenu = this;
    submenu.showAtPosition({ x: 0, y: 0 });
  }

  private isInside(target: any): boolean {
    const contains = (root: any, candidate: any): boolean => {
      if (!candidate) {
        return false;
      }
      if (root === candidate) {
        return true;
      }
      return (root.children ?? []).some((child: any) =>
        contains(child, candidate)
      );
    };

    if (contains(this.dom, target)) {
      return true;
    }
    for (let parent = this.parentMenu; parent; parent = parent.parentMenu) {
      if (contains(parent.dom, target)) {
        return true;
      }
    }
    for (
      let child = this.currentSubmenu;
      child;
      child = child.currentSubmenu
    ) {
      if (contains(child.dom, target)) {
        return true;
      }
    }
    return false;
  }
}

export class Component {
  onload(): void {}
  onunload(): void {}
}

export class MarkdownRenderChild {
  containerEl: HTMLElement = document.createElement("div");
  onload(): void {}
  onunload(): void {}
}

export function normalizePath(p: string): string {
  return p;
}

/**
 * minimal stub of Obsidian's requestUrl network API.
 * Production code (createRequestUrlNationalHolidayFetcher) always calls
 * this through the real "obsidian" import alias, so tests that exercise it
 * must override this via `vi.mock("obsidian",...)` the same way other
 * tests already override `Notice` — see tests/app/holiday-service.test.ts.
 * Left unmocked, it rejects loudly rather than silently returning empty
 * data, so a missing mock fails fast instead of masquerading as "no
 * holidays fetched".
 */
export interface RequestUrlParam {
  url: string;
  method?: string;
  contentType?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  throw?: boolean;
}

export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: any;
  text: string;
}

export async function requestUrl(
  _request: RequestUrlParam | string
): Promise<RequestUrlResponse> {
  throw new Error(
    "tests/stubs/obsidian.ts: requestUrl() was not mocked for this test"
  );
}

export const Platform = { isDesktopApp: true, isMobileApp: false };
