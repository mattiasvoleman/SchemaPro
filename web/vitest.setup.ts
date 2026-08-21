// Registers the jest-dom matchers on Vitest's expect (toBeInTheDocument,
// toHaveAttribute, …). Importing the /vitest entry also augments the Assertion
// type project-wide, since this file is inside the tsconfig include set.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Unmount between tests — Vitest does not do this automatically the way
// Jest's testing-library integration does, and leaked DOM makes *ByRole
// queries match the previous test's tree.
afterEach(() => {
  cleanup();
});

// jsdom implements neither the Pointer Capture API nor scrollIntoView, and
// Radix's Select calls both while opening. Without them the listbox never
// mounts and every option query fails with a message about the option rather
// than about the missing DOM method — so the gap is patched once, here,
// instead of being rediscovered in each spec that opens a dropdown.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => undefined;
}
