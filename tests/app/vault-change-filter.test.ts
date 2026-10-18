import { describe, it, expect, vi } from "vitest";
import { runtimeFixture } from "./operation-runtime-fixture";
import { CHILD_ID, PARENT_ID } from "../contracts/fixtures";

describe("vault modify filtering", () => {
  it("skips the context snapshot for modify events of unrelated notes", async () => {
    const f = await runtimeFixture();
    const preview = await f.service.propose("T07", { taskId: CHILD_ID, name: "saved" }, f.context);
    const snapshot = vi.spyOn(f.service.contextPort, "snapshot");
    await f.vault.create("outside.md", "x");
    await f.service.handleVaultChange("outside.md", "modify");
    expect(snapshot).not.toHaveBeenCalled();
    expect(f.service.previewPort.inspect(preview.previewId)?.status).not.toBe("stale");
    f.service.dispose();
  });
  it("still invalidates previews for task notes and for non-modify events", async () => {
    const f = await runtimeFixture();
    const preview = await f.service.propose("T07", { taskId: CHILD_ID, name: "saved" }, f.context);
    const snapshot = vi.spyOn(f.service.contextPort, "snapshot");
    await f.service.handleVaultChange("outside.md", "create");
    expect(snapshot).toHaveBeenCalled();
    await f.vault.modify(f.vault.getFileByPath(PARENT_ID)!, f.vault.getFileContent(PARENT_ID)! + "\nexternal\n");
    await f.service.handleVaultChange(PARENT_ID, "modify");
    expect(f.service.previewPort.inspect(preview.previewId)?.status).toBe("stale");
    f.service.dispose();
  });
});
