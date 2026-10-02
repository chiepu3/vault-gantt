import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateFixtures } from "./gen-fixtures.mjs";
import { CdpSession, enablePlugin, startObsidian } from "./obsidian-runtime.mjs";

const repoRoot = process.cwd();
const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vault-gantt-settings-tag-"));
const vaultDir = path.join(runRoot, "vault");
fs.mkdirSync(vaultDir, { recursive: true });
const pluginDir = path.join(vaultDir, ".obsidian", "plugins", "vault-gantt");
fs.mkdirSync(pluginDir, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) {
  fs.copyFileSync(path.join(repoRoot, file), path.join(pluginDir, file));
}
fs.writeFileSync(
  path.join(vaultDir, ".obsidian", "community-plugins.json"),
  JSON.stringify(["vault-gantt"])
);

await generateFixtures({ vaultDir, count: 1 });

const runtime = await startObsidian({
  vaultDir,
  obsidianBin: process.env.E2E_OBSIDIAN_BINARY ?? path.join(os.homedir(), "tools", "obsidian-headless", "squashfs-root", "obsidian"),
});

async function connectToSettingsPopout(cdpPort) {
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  const targets = await res.json();
  const target = targets.find(
    (t) => t.type === "page" && /^Settings/.test(t.title ?? "")
  );
  if (!target) {
    throw new Error(`no Settings popout target found among: ${JSON.stringify(targets.map((t) => t.title))}`);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const session = new CdpSession(ws, target.url);
  await session.startErrorCapture();
  return session;
}

try {
  await runtime.cdp.waitForExpression("!!app.plugins.manifests['vault-gantt']", {
    timeoutMs: 60000,
    label: "vault-gantt manifest",
  });
  await enablePlugin(runtime.cdp, "vault-gantt");

  // Seed two tags with distinct names/colors via the plugin's settings object
  // directly (faster + avoids relying on the "+タグを追加" button flow).
  await runtime.cdp.evaluate(`(async () => {
    const plugin = app.plugins.plugins['vault-gantt'];
    plugin.settings.ganttTags = [
      { key: 'tag-a', name: 'TagA', color: '#ff0000' },
      { key: 'tag-b', name: 'TagB', color: '#00ff00' },
    ];
    await plugin.saveSettings();
    true;
  })()`);

  const tabIds = await runtime.cdp.evaluate(
    "Object.keys(app.setting.pluginTabs ? Object.fromEntries(app.setting.pluginTabs.map(t=>[t.id,1])) : {})"
  );
  console.log("PLUGIN_TAB_IDS", JSON.stringify(tabIds));

  await runtime.cdp.evaluate("app.setting.open(); true");
  await new Promise((r) => setTimeout(r, 500));
  await runtime.cdp.evaluate("app.setting.openTabById('vault-gantt'); true");
  await new Promise((r) => setTimeout(r, 1000));
  const listRes = await fetch(`http://127.0.0.1:${runtime.cdpPort}/json/list`);
  console.log("TARGETS_AFTER_OPEN", JSON.stringify((await listRes.json()).map((t) => ({ type: t.type, title: t.title }))));

  // Settings opens as an Electron popout window -> separate CDP page target.
  const settingsCdp = await (async () => {
    let session = null;
    for (let attempt = 0; attempt < 20 && !session; attempt++) {
      try {
        session = await connectToSettingsPopout(runtime.cdpPort);
      } catch (err) {
        if (attempt === 19) console.log("CONNECT_FAIL", String(err));
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (!session) throw new Error("could not connect to Settings popout CDP target");
    return session;
  })();

  console.log("SETTINGS_BODY_LEN", await settingsCdp.evaluate("document.body.innerHTML.length"));
  console.log("SETTINGS_TITLE", await settingsCdp.evaluate("document.title"));
  console.log("SETTINGS_BODY_SNIPPET", (await settingsCdp.evaluate("document.body.textContent")).slice(0, 300));

  await settingsCdp.waitForExpression(
    "document.querySelectorAll('.task-workbench-gantt-tag-color-swatch').length >= 2",
    { timeoutMs: 15000, label: "two tag rows rendered" }
  );

  const inspectRows = async () => settingsCdp.evaluate(`(() => {
    const swatches = [...document.querySelectorAll('.task-workbench-gantt-tag-color-swatch')];
    return swatches.map((swatch) => {
      const settingItem = swatch.closest('.setting-item');
      const nameDisplay = settingItem?.querySelector('.setting-item-name')?.textContent ?? null;
      const inputs = [...(settingItem?.querySelectorAll('input') ?? [])].map((i) => ({
        type: i.type, value: i.value, className: i.className
      }));
      return { nameDisplay, inputs, swatchBg: swatch.style.backgroundColor };
    });
  })()`);

  console.log("BEFORE_EDIT", JSON.stringify(await inspectRows(), null, 2));

  // Reproduce the user's exact reported sequence: first edit the NAME input
  // (leaving it "dirty" relative to the name-display, which never re-renders
  // live), THEN edit the hex input, and see whether name-display picks up
  // the name-input's now-different value.
  await settingsCdp.evaluate(`(() => {
    const swatches = [...document.querySelectorAll('.task-workbench-gantt-tag-color-swatch')];
    const rowA = swatches[0].closest('.setting-item');
    const nameInput = [...rowA.querySelectorAll('input[type="text"]')][0];
    nameInput.focus();
    nameInput.value = 'TagA-RENAMED';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    true;
  })()`);
  await new Promise((r) => setTimeout(r, 200));
  console.log("AFTER_NAME_EDIT_ONLY", JSON.stringify(await inspectRows(), null, 2));

  // Find tag A's hex text input (type=text, not the color-picker's type=color)
  // and type a new hex value one character at a time with real waits between
  // keystrokes, so each keystroke's async onChange (including its
  // saveSettings await) genuinely has time to interleave with the next.
  const chars = "#0000ff".split("");
  await settingsCdp.evaluate(`(() => {
    const swatches = [...document.querySelectorAll('.task-workbench-gantt-tag-color-swatch')];
    const rowA = swatches[0].closest('.setting-item');
    const hexInput = [...rowA.querySelectorAll('input[type="text"]')][1];
    hexInput.focus();
    hexInput.value = '';
    hexInput.dispatchEvent(new Event('input', { bubbles: true }));
    window.__vgHexInput = hexInput;
    true;
  })()`);
  for (const ch of chars) {
    await settingsCdp.evaluate(`(() => {
      const hexInput = window.__vgHexInput;
      hexInput.value += ${JSON.stringify(ch)};
      hexInput.dispatchEvent(new Event('input', { bubbles: true }));
      true;
    })()`);
    await new Promise((r) => setTimeout(r, 80));
  }
  await new Promise((r) => setTimeout(r, 300));

  console.log("AFTER_HEX_EDIT", JSON.stringify(await inspectRows(), null, 2));
  console.log("CAPTURED_ERRORS_MAIN", JSON.stringify(runtime.cdp.capturedErrors()));
  console.log("CAPTURED_ERRORS_SETTINGS", JSON.stringify(settingsCdp.capturedErrors()));
} finally {
  runtime.kill();
}
