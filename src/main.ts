import { Plugin } from 'obsidian';
import { mount, unmount, type Component } from 'svelte';
import { PLUGIN_ID } from './domain/version';
import PluginBadge from './ui/shared/PluginBadge.svelte';

export default class VaultGanttPlugin extends Plugin {
  private statusBarBadge: ReturnType<typeof mount> | undefined;

  onload(): void {
    console.log(`Loading plugin: ${PLUGIN_ID}`);
    const statusBarEl = this.addStatusBarItem();
    this.statusBarBadge = mount(PluginBadge as Component, { target: statusBarEl });
  }

  onunload(): void {
    console.log(`Unloading plugin: ${PLUGIN_ID}`);
    if (this.statusBarBadge) {
      unmount(this.statusBarBadge);
    }
  }
}
