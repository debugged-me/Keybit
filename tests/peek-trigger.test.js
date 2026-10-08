import test from "node:test";
import assert from "node:assert/strict";
await import("../src/peek/peek-utils.js");
const { matchesTrigger } = globalThis.__keybitPeek.utils;
const click = mods => ({ button: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...mods });

test("plain Click only fires with no modifiers held", () => {
  assert.equal(matchesTrigger("click", click({})), true);
  // Any modifier keeps its native meaning, so Cmd/Ctrl+Click still opens real tabs.
  assert.equal(matchesTrigger("click", click({ shiftKey: true })), false);
  assert.equal(matchesTrigger("click", click({ altKey: true })), false);
  assert.equal(matchesTrigger("click", click({ ctrlKey: true })), false);
  assert.equal(matchesTrigger("click", click({ metaKey: true })), false);
  assert.equal(matchesTrigger("click", click({ button: 1 })), false);
  assert.equal(matchesTrigger("click", click({ button: 2 })), false);
});

test("Shift+Click only fires on shift alone", () => {
  assert.equal(matchesTrigger("shift-click", click({ shiftKey: true })), true);
  // Ordinary clicks and every other modifier stay normal.
  assert.equal(matchesTrigger("shift-click", click({})), false);
  assert.equal(matchesTrigger("shift-click", click({ altKey: true })), false);
  assert.equal(matchesTrigger("shift-click", click({ ctrlKey: true })), false);
  assert.equal(matchesTrigger("shift-click", click({ metaKey: true })), false);
  assert.equal(matchesTrigger("shift-click", click({ metaKey: true, shiftKey: true })), false);
  // Extra modifiers mean it is not the configured trigger.
  assert.equal(matchesTrigger("shift-click", click({ shiftKey: true, ctrlKey: true })), false);
  assert.equal(matchesTrigger("shift-click", click({ shiftKey: true, altKey: true })), false);
  // Middle and right clicks are never Peek triggers.
  assert.equal(matchesTrigger("shift-click", click({ shiftKey: true, button: 1 })), false);
  assert.equal(matchesTrigger("shift-click", click({ shiftKey: true, button: 2 })), false);
});

test("Alt+Click only fires on alt alone", () => {
  assert.equal(matchesTrigger("alt-click", click({ altKey: true })), true);
  assert.equal(matchesTrigger("alt-click", click({})), false);
  assert.equal(matchesTrigger("alt-click", click({ shiftKey: true })), false);
  assert.equal(matchesTrigger("alt-click", click({ altKey: true, shiftKey: true })), false);
  assert.equal(matchesTrigger("alt-click", click({ altKey: true, metaKey: true })), false);
});

test("Ctrl+Shift+Click requires exactly ctrl and shift", () => {
  assert.equal(matchesTrigger("ctrl-shift-click", click({ ctrlKey: true, shiftKey: true })), true);
  assert.equal(matchesTrigger("ctrl-shift-click", click({ ctrlKey: true })), false);
  assert.equal(matchesTrigger("ctrl-shift-click", click({ shiftKey: true })), false);
  assert.equal(matchesTrigger("ctrl-shift-click", click({ ctrlKey: true, shiftKey: true, altKey: true })), false);
  assert.equal(matchesTrigger("ctrl-shift-click", click({ ctrlKey: true, shiftKey: true, metaKey: true })), false);
});

test("long-press is not a modifier trigger and unknown triggers never fire", () => {
  assert.equal(matchesTrigger("long-press", click({})), false);
  assert.equal(matchesTrigger("long-press", click({ shiftKey: true })), false);
  assert.equal(matchesTrigger("made-up-trigger", click({ shiftKey: true })), false);
});
