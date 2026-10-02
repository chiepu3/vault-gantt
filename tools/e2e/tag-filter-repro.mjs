import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateFixtures } from "./gen-fixtures.mjs";
import { enablePlugin, startObsidian } from "./obsidian-runtime.mjs";

const repoRoot = process.cwd();
const artifactDir = path.join(repoRoot, "tools", "e2e", "artifacts");
const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vault-gantt-tag-filter-"));
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

await generateFixtures({ vaultDir, count: 2 });
for (const entry of fs.readdirSync(path.join(vaultDir, "tasks", "2026", "08"))) {
  const file = path.join(vaultDir, "tasks", "2026", "08", entry);
  const content = fs.readFileSync(file, "utf8")
    .replace("tags: \n", "tags: alpha,beta\n")
    .replace("subtask__subtask-1__tags: \n", "subtask__subtask-1__tags: gamma\n");
  fs.writeFileSync(file, content);
}

const runtime = await startObsidian({
  vaultDir,
  obsidianBin: process.env.E2E_OBSIDIAN_BINARY ?? path.join(os.homedir(), "tools", "obsidian-headless", "squashfs-root", "obsidian"),
});
try {
  await runtime.cdp.waitForExpression("!!app.plugins.manifests['vault-gantt']", {
    timeoutMs: 60000,
    label: "vault-gantt manifest",
  });
  await enablePlugin(runtime.cdp, "vault-gantt");
  await runtime.cdp.evaluate("app.commands.executeCommandById('vault-gantt:open-task-gantt'), true");
  await runtime.cdp.waitForExpression("!!document.querySelector('.task-gantt-tag-filter')", {
    timeoutMs: 60000,
    label: "tag filter button",
  });

  const inspect = async () => runtime.cdp.evaluate(`(() => {
    const button = document.querySelector('.task-gantt-tag-filter');
    const menu = document.querySelector('.task-gantt-tag-filter-menu');
    const pick = (el) => el ? (() => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return {tag: el.tagName, classes: el.className, text: el.textContent, rect: {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}, position:s.position, overflow:s.overflow, zIndex:s.zIndex, display:s.display, visibility:s.visibility, parent: el.parentElement?.className ?? null};
    })() : null;
    const ancestors = [];
    let cursor = button;
    while (cursor && ancestors.length < 8) {
      ancestors.push(pick(cursor));
      cursor = cursor.parentElement;
    }
    const item = menu?.querySelector('.task-gantt-tag-filter-item');
    const itemRect = item?.getBoundingClientRect();
    const hit = itemRect ? document.elementFromPoint(itemRect.left + 5, itemRect.top + 5)?.className ?? null : null;
    return {button: pick(button), menu: pick(menu), ancestors, item: pick(item), hit};
  })()`);

  console.log("BEFORE_CLICK", JSON.stringify(await inspect(), null, 2));
  await runtime.cdp.screenshot(path.join(artifactDir, "tag-filter-before.png"));
  await runtime.cdp.evaluate("document.querySelector('.task-gantt-tag-filter').click(); true");
  await runtime.cdp.waitForExpression("!!document.querySelector('.task-gantt-tag-filter-menu')", {
    timeoutMs: 5000,
    label: "tag filter menu after click",
  });
  console.log("AFTER_CLICK", JSON.stringify(await inspect(), null, 2));
  await runtime.cdp.screenshot(path.join(artifactDir, "tag-filter-after-before-fix.png"));
  await runtime.cdp.evaluate("document.querySelector('.task-gantt-tag-filter-item').click(); true");
  await new Promise((resolve) => setTimeout(resolve, 500));
  console.log("AFTER_ITEM_CLICK", JSON.stringify(await inspect(), null, 2));
  console.log("CAPTURED_ERRORS", JSON.stringify(runtime.cdp.capturedErrors()));
} finally {
  runtime.kill();
}
