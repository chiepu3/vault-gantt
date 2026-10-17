/* global __VG_VERSION__, __VG_COMMIT__, __VG_BUILT_AT__ */

export interface BuildInfo {
  version: string;
  commit: string;
  builtAt: string;
}

/** Build-time constants injected by esbuild `define`; absent under tsc/vitest. */
export function getBuildInfo(fallbackVersion = "unknown"): BuildInfo {
  return {
    version: typeof __VG_VERSION__ === "undefined" ? fallbackVersion : __VG_VERSION__,
    commit: typeof __VG_COMMIT__ === "undefined" ? "unknown" : __VG_COMMIT__,
    builtAt: typeof __VG_BUILT_AT__ === "undefined" ? "unknown" : __VG_BUILT_AT__,
  };
}

/** Short label such as `v0.3.0 (92e8f50)`; the commit is omitted when unknown. */
export function formatBuildLabel(info: Pick<BuildInfo, "version" | "commit">): string {
  const commit = info.commit && info.commit !== "unknown" ? ` (${info.commit})` : "";
  return `v${info.version}${commit}`;
}
