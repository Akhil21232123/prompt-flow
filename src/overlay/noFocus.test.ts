import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { islandButtonProps, refuseFocus, swallowKeys } from "./noFocus";

// Buttons can't be tabbed to, and a click doesn't focus them.
assert.equal(islandButtonProps.tabIndex, -1);
assert.equal(islandButtonProps.type, "button");
let prevented = false;
islandButtonProps.onMouseDown({ preventDefault: () => (prevented = true) });
assert.ok(prevented, "a mouse press must not focus an island button");

// Every key event is dropped before any other listener sees it.
const target = new EventTarget();
const undo = swallowKeys(target);
let reached = false;
target.addEventListener("keydown", () => (reached = true));
for (const type of ["keydown", "keyup", "keypress"]) {
  const e = new Event(type, { cancelable: true });
  target.dispatchEvent(e);
  assert.ok(e.defaultPrevented, `${type} must be swallowed`);
}
assert.equal(reached, false, "no island listener may see a key");
undo();
target.dispatchEvent(new Event("keydown", { cancelable: true }));
assert.equal(reached, true);

// Anything that takes focus anyway loses it.
const focusTarget = new EventTarget();
refuseFocus(focusTarget);
let blurred = false;
const ev = new Event("focusin");
Object.defineProperty(ev, "target", {
  value: { blur: () => (blurred = true) },
});
focusTarget.dispatchEvent(ev);
assert.ok(blurred, "focus must be given up");

// The island draws every button through the one that can't take focus.
const island = readFileSync(new URL("./Island.tsx", import.meta.url), "utf8");
const raw = island.match(/<button\b/g) ?? [];
assert.equal(raw.length, 1, "only IslandButton may render a <button>");
assert.match(island, /<button\b[^>]*\{\.\.\.islandButtonProps\}/);

console.log("island focus: all assertions passed");
