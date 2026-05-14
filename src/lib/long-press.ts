/**
 * Tiny long-press detector for touch + mouse. Returns the handler set
 * to spread onto an element. Fires `onLongPress` after `delayMs` if
 * the pointer stays put (moves no more than `tolerancePx`).
 *
 * Used by the admin photo grid to enter "selection mode" on mobile
 * without conflicting with the @dnd-kit drag activation distance
 * (which fires at 6px of movement). We keep tolerance tight so a
 * sloppy press doesn't accidentally select when the user meant to
 * drag.
 */
export interface LongPressOptions {
  delayMs?: number;
  tolerancePx?: number;
}

export interface LongPressHandlers {
  onPointerDown: (e: { clientX: number; clientY: number }) => void;
  onPointerMove: (e: { clientX: number; clientY: number }) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
}

interface PressState {
  x: number;
  y: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createLongPress(
  onLongPress: () => void,
  opts: LongPressOptions = {},
): LongPressHandlers {
  const delayMs = opts.delayMs ?? 500;
  const tolerancePx = opts.tolerancePx ?? 8;
  const state: PressState = { x: 0, y: 0, timer: null };

  function clear(): void {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  return {
    onPointerDown(e) {
      state.x = e.clientX;
      state.y = e.clientY;
      clear();
      state.timer = setTimeout(() => {
        state.timer = null;
        onLongPress();
      }, delayMs);
    },
    onPointerMove(e) {
      if (!state.timer) return;
      const dx = Math.abs(e.clientX - state.x);
      const dy = Math.abs(e.clientY - state.y);
      if (dx > tolerancePx || dy > tolerancePx) clear();
    },
    onPointerUp() { clear(); },
    onPointerCancel() { clear(); },
  };
}
