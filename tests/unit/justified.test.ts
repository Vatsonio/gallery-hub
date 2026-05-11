import { describe, it, expect } from 'vitest';
import { layoutJustifiedRows } from '@/lib/justified';

const photo = (id: string, w: number, h: number) => ({ id, width: w, height: h });

describe('layoutJustifiedRows', () => {
  it('packs photos into rows that exactly fill containerWidth', () => {
    const rows = layoutJustifiedRows({
      photos: [photo('a', 1600, 1000), photo('b', 1000, 1500), photo('c', 1200, 800), photo('d', 1500, 1000)],
      containerWidth: 1200,
      targetRowHeight: 240,
      gap: 8,
      maxLastRowScale: 1.5,
    });
    for (const r of rows.slice(0, -1)) {
      const sum = r.items.reduce((s, it) => s + it.width, 0) + (r.items.length - 1) * 8;
      expect(Math.abs(sum - 1200)).toBeLessThan(0.5);
    }
  });

  it('preserves aspect ratios', () => {
    const rows = layoutJustifiedRows({
      photos: [photo('a', 1600, 1000), photo('b', 1000, 1500), photo('c', 1200, 800)],
      containerWidth: 1200, targetRowHeight: 240, gap: 8, maxLastRowScale: 1.5,
    });
    for (const r of rows) {
      for (const it of r.items) {
        const src = [photo('a',1600,1000), photo('b',1000,1500), photo('c',1200,800)].find(p => p.id === it.id)!;
        const srcRatio = src.width / src.height;
        const itRatio = it.width / it.height;
        expect(Math.abs(srcRatio - itRatio)).toBeLessThan(0.01);
      }
    }
  });

  it('caps the last short row at maxLastRowScale * targetRowHeight', () => {
    const rows = layoutJustifiedRows({
      photos: [photo('a', 1600, 1000)],
      containerWidth: 1200, targetRowHeight: 240, gap: 8, maxLastRowScale: 1.5,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].height).toBeLessThanOrEqual(240 * 1.5 + 0.01);
  });

  it('returns empty array for empty input', () => {
    expect(layoutJustifiedRows({ photos: [], containerWidth: 1000, targetRowHeight: 240, gap: 8, maxLastRowScale: 1.5 })).toEqual([]);
  });
});
