/**
 * The island never takes the keyboard. It floats over the app being typed
 * into, and a key meant for that app (Space or Return from ⌘Space, ⌥Space
 * or a held key) must never "click" an island button: a focused 👎 would
 * open feedback, a focused chip would redo. So:
 *
 * - its buttons are never focusable (`islandButtonProps`), and a click
 *   doesn't focus them either;
 * - every key event that reaches the island's webview is dropped
 *   (`swallowKeys`), and anything that gets focus anyway loses it.
 *
 * The panel itself can't become the key window (overlay.rs); this is the
 * same rule kept again in the webview.
 */

const KEY_EVENTS = ["keydown", "keyup", "keypress"] as const;

/** Spread onto every button in the island. */
export const islandButtonProps = {
  type: "button" as const,
  tabIndex: -1,
  // A mouse press focuses a button before its click; prevent that.
  onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault(),
};

/** Drops every key event at `target` before anything else sees it. */
export const swallowKeys = (target: EventTarget): (() => void) => {
  const drop = (e: Event) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  for (const type of KEY_EVENTS) target.addEventListener(type, drop, true);
  return () => {
    for (const type of KEY_EVENTS) target.removeEventListener(type, drop, true);
  };
};

/** Gives up focus as soon as anything in `doc` takes it. */
export const refuseFocus = (doc: {
  addEventListener: (type: string, fn: (e: Event) => void, c: boolean) => void;
}) => {
  doc.addEventListener(
    "focusin",
    (e) => {
      const el = e.target as { blur?: () => void } | null;
      el?.blur?.();
    },
    true,
  );
};
