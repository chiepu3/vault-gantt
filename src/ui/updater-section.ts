import { Notice, Setting, requestUrl } from "obsidian";
import type { App, Plugin } from "obsidian";
import { formatBuildLabel, getBuildInfo } from "../build-info";
import { SelfUpdater, targetLabel, type UpdateTarget } from "../app/self-update";

interface PluginHost { plugins: { disablePlugin(id: string): Promise<void>; enablePlugin(id: string): Promise<void> } }

/** Reloads this plugin so the freshly written main.js is used. The current instance is torn down by disablePlugin. */
export async function reloadPlugin(app: App, id: string): Promise<void> {
  const host = (app as unknown as PluginHost).plugins;
  await host.disablePlugin(id);
  await host.enablePlugin(id);
}

/** Updater wired to Obsidian's HTTP and the plugin folder. */
export function createSelfUpdater(app: App, plugin: Plugin): SelfUpdater {
  const adapter = app.vault.adapter;
  return new SelfUpdater({
    http: async (url) => {
      const res = await requestUrl({ url, throw: false });
      return { status: res.status, arrayBuffer: res.arrayBuffer };
    },
    adapter: {
      exists: (p) => adapter.exists(p),
      mkdir: (p) => adapter.mkdir(p),
      readBinary: (p) => adapter.readBinary(p),
      writeBinary: (p, d) => adapter.writeBinary(p, d),
    },
    pluginDir: plugin.manifest.dir ?? `${app.vault.configDir}/plugins/${plugin.manifest.id}`,
  });
}

/** "アップデート" settings block: pick a built branch, install it, reload, or roll back. Self-contained so it can sit in any settings tab. */
export function renderUpdaterSection(containerEl: HTMLElement, app: App, plugin: Plugin): void {
  const updater = createSelfUpdater(app, plugin);
  const build = getBuildInfo(plugin.manifest.version);
  let targets: UpdateTarget[] = [];
  let selected = "";
  let busy = false;

  new Setting(containerEl).setName("アップデート").setHeading();
  const dropdownSetting = new Setting(containerEl)
    .setName("インストールするブランチ")
    .setDesc(`現在: ${formatBuildLabel(build)}。「ブランチ一覧を取得」で、ビルド済みのブランチを選べます（git / node は不要）。`);
  const actions = new Setting(containerEl).setName("更新と元に戻す");

  const run = async (label: string, task: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = true;
    try { await task(); } catch (error) { new Notice(`${label}に失敗しました: ${error instanceof Error ? error.message : String(error)}`, 8000); } finally { busy = false; }
  };

  dropdownSetting.addDropdown((dd) => {
    dd.addOption("", "（未取得）");
    dd.onChange((value) => { selected = value; });
    dropdownSetting.addButton((btn) => btn.setButtonText("ブランチ一覧を取得").onClick(() => void run("一覧の取得", async () => {
      targets = await updater.listTargets();
      if (targets.length === 0) throw new Error("インストールできるブランチがありません。");
      dd.selectEl.replaceChildren();
      for (const t of targets) dd.addOption(t.slug, `${targetLabel(t)}${t.sha.startsWith(build.commit) ? "（現在）" : ""}`);
      selected = targets[0].slug;
      dd.setValue(selected);
      new Notice(`${targets.length} 件のブランチを取得しました。`);
    })));
  });

  actions.addButton((btn) => btn.setButtonText("インストールして再読み込み").setCta().onClick(() => void run("インストール", async () => {
    const target = targets.find((t) => t.slug === selected);
    if (!target) throw new Error("先に「ブランチ一覧を取得」してブランチを選んでください。");
    new Notice(`${target.branch} をダウンロードしています...`);
    const { version, sha } = await updater.install(target);
    new Notice(`${target.branch}（v${version} / ${sha.slice(0, 7)}）をインストールしました。再読み込みします。`);
    await reloadPlugin(app, plugin.manifest.id);
  })));
  actions.addButton((btn) => btn.setButtonText("前の状態に戻す").onClick(() => void run("元に戻す", async () => {
    if (!(await updater.hasBackup())) throw new Error("バックアップがありません。");
    await updater.restoreBackup();
    new Notice("前の状態に戻しました。再読み込みします。");
    await reloadPlugin(app, plugin.manifest.id);
  })));
}
