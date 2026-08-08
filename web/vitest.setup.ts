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
