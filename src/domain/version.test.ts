import { describe, it, expect } from 'vitest';
import { PLUGIN_ID, PLUGIN_NAME } from './version';

describe('version', () => {
  it('should have correct PLUGIN_ID', () => {
    expect(PLUGIN_ID).toBe('vault-gantt');
  });

  it('should have correct PLUGIN_NAME', () => {
    expect(PLUGIN_NAME).toBe('Vault Gantt');
  });
});
