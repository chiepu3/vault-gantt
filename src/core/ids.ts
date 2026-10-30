export type TaskIdKind = "parent" | "subtask";

const ID_PATTERN = /^[ts]-[0-9a-z]{6}$/;

export function isTaskId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function randomBase36(length: number, random: () => number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += Math.floor(random() * 36).toString(36);
  return out;
}

function defaultRandom(): () => number {
  const crypto = (globalThis as { crypto?: { getRandomValues?: (array: Uint32Array) => Uint32Array } }).crypto;
  if (crypto?.getRandomValues) {
    return () => crypto.getRandomValues!(new Uint32Array(1))[0] / 0x100000000;
  }
  return Math.random;
}

/** t-/s- plus 6 base36 characters, not present in `used` (which receives the new id). */
export function generateTaskId(kind: TaskIdKind, used: Set<string>, random: () => number = defaultRandom()): string {
  const prefix = kind === "parent" ? "t" : "s";
  for (;;) {
    const id = `${prefix}-${randomBase36(6, random)}`;
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
}

const MEMO_ID_PATTERN = /^m-[0-9a-z]{6}$/;

export function isMemoId(value: unknown): value is string {
  return typeof value === "string" && MEMO_ID_PATTERN.test(value);
}

/** m- plus 6 base36 characters, not present in `used` (which receives the new id). Memos share the id namespace of task notes. */
export function generateMemoId(used: Set<string>, random: () => number = defaultRandom()): string {
  for (;;) {
    const id = `m-${randomBase36(6, random)}`;
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
}
