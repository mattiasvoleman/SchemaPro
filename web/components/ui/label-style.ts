/**
 * The label's look, in a module the server can read.
 *
 * <Label> is a client component (radix), so a server component importing a
 * constant from label.tsx would receive a client reference, not the string.
 * Pages that should not ship radix and tailwind-merge for a label — the
 * unauthenticated ones — put this class on a plain <label> instead.
 */
export const labelClassName =
  "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70";
