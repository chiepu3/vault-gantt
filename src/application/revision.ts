/**
 * Revision management: compute revisions and detect conflicts.
 * Pure functions — no side effects.
 */

/**
 * Compute a revision string from file metadata.
 * Format: `${mtimeMs}:${size}` for deterministic collision detection.
 */
export function computeRevision(mtimeMs: number, size: number): string {
  return `${mtimeMs}:${size}`;
}

/**
 * Detect if an expected revision conflicts with the current revision.
 * Returns true if they differ.
 */
export function isRevisionConflict(expected: string, current: string): boolean {
  return expected !== current;
}
