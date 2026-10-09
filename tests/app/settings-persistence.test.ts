import { describe, it, expect, vi } from "vitest";
import { SettingsPersistence } from "../../src/app/settings-persistence";
import { DEFAULT_SETTINGS } from "../../src/core/constants";

function fixture() {
  const settings = structuredClone(DEFAULT_SETTINGS);
  let disk = structuredClone(settings), tail = Promise.resolve();
  const coordinate = <T>(run: () => Promise<T>): Promise<T> => { const result = tail.then(run); tail = result.then(() => undefined, () => undefined); return result; };
  const write = vi.fn(async (candidate: typeof settings) => { disk = structuredClone(candidate); });
  const read = vi.fn(async () => structuredClone(disk));
  const writer = new SettingsPersistence({ settings: () => settings, coordinate, write, read });
  return { settings, writer, write, read, coordinate, disk: () => disk };
}
describe("shared settings persistence", () => {
  it.each([false, true])("preserves UI changes made while an AI save awaits disk (same key: %s)", async (sameKey) => {
    const f = fixture();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const writing = new Promise<void>((resolve) => { started = resolve; });
    const originalWrite = f.write.getMockImplementation()!;
    f.write.mockImplementationOnce(async (candidate) => { started(); await waiting; await originalWrite(candidate); });
    const candidate = { ...f.settings, ganttZoom: 50 };
    const ai = f.coordinate(() => f.writer.persist(candidate, ["ganttZoom"]));
    await writing;
    if (sameKey) f.settings.ganttZoom = 60; else f.settings.taskFolder = "UI-folder";
    const ui = f.writer.save(); release(); await Promise.all([ai, ui]);
    expect(f.disk().ganttZoom).toBe(sameKey ? 60 : 50);
    expect(f.disk().taskFolder).toBe(sameKey ? DEFAULT_SETTINGS.taskFolder : "UI-folder");
    expect(f.settings).toEqual(f.disk()); expect(f.read).toHaveBeenCalledTimes(2);
  });
  it("applies queued UI patches to the latest settings instead of restoring an older whole copy", async () => {
    const f = fixture();
    f.settings.taskFolder = "one"; const first = f.writer.save();
    f.settings.ganttZoom = 70; const second = f.writer.save();
    await Promise.all([first, second]); expect(f.disk()).toMatchObject({ taskFolder: "one", ganttZoom: 70 });
  });
  it("rejects a persisted changed value that does not match the candidate", async () => {
    const f = fixture(); f.read.mockResolvedValueOnce(structuredClone(DEFAULT_SETTINGS));
    await expect(f.coordinate(() => f.writer.persist({ ...f.settings, ganttZoom: 70 }, ["ganttZoom"]))).rejects.toThrow("SETTINGS_SAVE_CONFLICT");
    expect(f.settings.ganttZoom).toBe(DEFAULT_SETTINGS.ganttZoom);
  });
  it("keeps the queue usable after a rejected save", async () => {
    const f = fixture(); f.write.mockRejectedValueOnce(new Error("disk"));
    f.settings.taskFolder = "failed"; await expect(f.writer.save()).rejects.toThrow("disk");
    f.settings.taskFolder = "retry"; await f.writer.save(); expect(f.disk().taskFolder).toBe("retry");
  });
});
