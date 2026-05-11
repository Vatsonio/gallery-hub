import { describe, it, expect, vi } from 'vitest';
import { createDoubleTapDetector } from '@/lib/double-tap';

describe('createDoubleTapDetector', () => {
  it('fires onDouble when two taps occur within window', () => {
    const onDouble = vi.fn();
    const onSingle = vi.fn();
    const d = createDoubleTapDetector({ windowMs: 300, onDouble, onSingle });
    d.tap(1000);
    d.tap(1200);
    expect(onDouble).toHaveBeenCalledTimes(1);
    expect(onSingle).not.toHaveBeenCalled();
  });

  it('does not fire onDouble when taps are outside window', () => {
    const onDouble = vi.fn();
    const onSingle = vi.fn();
    const d = createDoubleTapDetector({ windowMs: 300, onDouble, onSingle });
    d.tap(1000);
    d.tap(1400);
    expect(onDouble).not.toHaveBeenCalled();
  });

  it('three quick taps fire one double then start a new sequence', () => {
    const onDouble = vi.fn();
    const d = createDoubleTapDetector({ windowMs: 300, onDouble, onSingle: () => {} });
    d.tap(1000);
    d.tap(1100);
    d.tap(1200);
    expect(onDouble).toHaveBeenCalledTimes(1);
  });
});
