import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The input-styled native select. Radix Select is the default control, but it
 * brings popper and floating-ui with it (about 15KB gzipped on a route that
 * has no other Radix popover). Pages that live under a tight bundle budget —
 * integrations, the cover dialogs, the guardian's phone-first page — use this
 * instead, and on a phone the native picker is the better control anyway.
 */
export const NATIVE_SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

export const NativeSelect = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, ...props }, ref) => (
  <select ref={ref} className={cn(NATIVE_SELECT_CLASS, className)} {...props} />
));
NativeSelect.displayName = "NativeSelect";
