export interface DoubleTapOpts {
  windowMs: number;
  onDouble: () => void;
  onSingle?: () => void;
}

export interface DoubleTapDetector {
  tap(now?: number): void;
  reset(): void;
}

export function createDoubleTapDetector(opts: DoubleTapOpts): DoubleTapDetector {
  let lastTapAt = 0;
  return {
    tap(now: number = Date.now()) {
      if (now - lastTapAt <= opts.windowMs && lastTapAt !== 0) {
        opts.onDouble();
        lastTapAt = 0;
        return;
      }
      lastTapAt = now;
      if (opts.onSingle) {
        const captured = now;
        setTimeout(() => {
          if (lastTapAt === captured) {
            opts.onSingle?.();
            lastTapAt = 0;
          }
        }, opts.windowMs);
      }
    },
    reset() { lastTapAt = 0; },
  };
}
