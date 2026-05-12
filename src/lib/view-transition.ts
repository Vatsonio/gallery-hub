/**
 * Wrap a navigation callback in `document.startViewTransition` when the
 * browser supports it. On Safari and Firefox (and anywhere the API is
 * missing) we just call the navigation synchronously — no animation,
 * no JS error.
 *
 * Use `setViewTransitionName(el, name)` to tag the morphing element
 * before triggering the transition. Tag the corresponding element in
 * the destination view with the same name; the browser will compute a
 * morph between them.
 *
 * Tagging a tile *only* at click time avoids the "duplicate
 * view-transition-name" warning that would fire if every tile carried
 * the same name on initial render.
 */

export function startViewTransition(cb: () => void): void {
  if (typeof document === "undefined") {
    cb();
    return;
  }
  if (typeof document.startViewTransition !== "function") {
    cb();
    return;
  }
  document.startViewTransition(cb);
}

/**
 * Apply a temporary view-transition-name to an element. Returns a
 * cleanup function that clears the name; callers should run it after
 * the transition finishes (or on unmount) so the name is free for the
 * next navigation.
 */
export function setViewTransitionName(
  el: HTMLElement | null,
  name: string,
): () => void {
  if (!el) return () => {};
  el.style.viewTransitionName = name;
  return () => {
    el.style.viewTransitionName = "";
  };
}
