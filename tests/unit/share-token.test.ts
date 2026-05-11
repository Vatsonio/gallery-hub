import { describe, it, expect } from 'vitest';
import { generateShareToken, signUnlockValue, verifyUnlockValue } from '@/lib/share';

describe('share tokens', () => {
  it('generates 12-char url-safe tokens', () => {
    process.env.SESSION_PASSWORD = 'test-secret-test-secret-test-secret-1';
    for (let i = 0; i < 20; i++) {
      const t = generateShareToken();
      expect(t).toHaveLength(12);
      expect(t).toMatch(/^[A-Za-z0-9_-]{12}$/);
    }
  });

  it('signs and verifies unlock cookie', () => {
    process.env.SESSION_PASSWORD = 'test-secret-test-secret-test-secret-1';
    const v = signUnlockValue('abc', Date.now());
    expect(verifyUnlockValue('abc', v)).toBe(true);
    expect(verifyUnlockValue('xyz', v)).toBe(false);
  });

  it('rejects expired unlock cookies', () => {
    process.env.SESSION_PASSWORD = 'test-secret-test-secret-test-secret-1';
    const old = Date.now() - 25 * 60 * 60 * 1000;
    const v = signUnlockValue('abc', old);
    expect(verifyUnlockValue('abc', v)).toBe(false);
  });
});
