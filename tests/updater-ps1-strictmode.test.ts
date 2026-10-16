import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Under Set-StrictMode, PowerShell reads non-ASCII characters directly after
// `$name` as part of the variable name, which throws and masks the real error.
describe('tools/updater PowerShell scripts', () => {
  it('brace variables that are directly followed by non-ASCII text', () => {
    const dir = join(__dirname, '..', 'tools', 'updater');
    const hits: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ps1'))) {
      readFileSync(join(dir, file), 'utf8').split('\n').forEach((line, i) => {
        if (/\$[A-Za-z_]\w*[\u0080-\uFFFF]/.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
