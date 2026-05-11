import { describe, it, expect } from 'vitest';
import { resolveViewerId, VIEWER_COOKIE } from '@/lib/viewer';

function makeCookieStore(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const writes: Array<{ name: string; value: string; opts: Record<string, unknown> }> = [];
  return {
    get: (name: string) => (store.has(name) ? { name, value: store.get(name)! } : undefined),
    set: (name: string, value: string, opts: Record<string, unknown>) => {
      store.set(name, value);
      writes.push({ name, value, opts });
    },
    writes,
  };
}

describe('resolveViewerId', () => {
  it('issues a new UUID and sets cookie when none present', () => {
    const jar = makeCookieStore();
    const id = resolveViewerId(jar, 'abc123', { isAdminPreview: false });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(jar.writes).toHaveLength(1);
    expect(jar.writes[0].name).toBe(VIEWER_COOKIE);
    expect(jar.writes[0].opts.httpOnly).toBe(true);
    expect(jar.writes[0].opts.sameSite).toBe('lax');
    expect(jar.writes[0].opts.path).toBe('/a/abc123');
    expect(jar.writes[0].opts.maxAge).toBe(60 * 60 * 24 * 365);
  });

  it('reuses existing cookie', () => {
    const jar = makeCookieStore({ gh_viewer: '11111111-1111-1111-1111-111111111111' });
    const id = resolveViewerId(jar, 'abc123', { isAdminPreview: false });
    expect(id).toBe('11111111-1111-1111-1111-111111111111');
    expect(jar.writes).toHaveLength(0);
  });

  it('returns a fixed admin-preview id and never writes for admin preview', () => {
    const jar = makeCookieStore();
    const id = resolveViewerId(jar, 'abc123', { isAdminPreview: true });
    expect(id).toBe('admin-preview');
    expect(jar.writes).toHaveLength(0);
  });
});
