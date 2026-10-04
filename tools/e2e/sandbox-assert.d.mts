export function findSandboxDisableFlags(argv: string[]): string[];
export function parseCmdline(raw: string): string[];
export function listDescendants(rootPid: number): number[];
export function assertSandboxEnabled(
  rootPid: number,
  cdp: { evaluate(expression: string): Promise<unknown> }
): Promise<void>;
