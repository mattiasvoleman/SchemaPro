/**
 * The page's class strings, written out. components/ui/button.tsx and input.tsx are client modules on radix, class-variance-authority and
 * tailwind-merge, which a public page that carries only its own tool does not need to ship; these are their looks, in the app's own tokens.
 */

export const BUTTON =
  "inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background disabled:pointer-events-none disabled:opacity-50";

export const BUTTON_OUTLINE =
  "inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-md border border-input bg-background px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background disabled:pointer-events-none disabled:opacity-50";

export const BUTTON_SMALL =
  "inline-flex h-8 items-center justify-center rounded-md border border-input bg-background px-3 text-xs font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export const FIELD =
  "flex h-9 w-full rounded-md border border-input-strong bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

export const SELECT =
  "h-9 w-full rounded-md border border-input-strong bg-background px-2 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export const TEXTAREA =
  "min-h-24 w-full rounded-md border border-input-strong bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export const LABEL = "text-sm font-medium leading-none";

export const CARD = "rounded-lg border bg-card p-4 text-card-foreground shadow-sm sm:p-6";

export const LINK = "font-medium text-primary underline underline-offset-4 hover:text-foreground";

export const TABLE = "w-full border-collapse text-left text-sm";
export const TH = "border-b px-2 py-2 align-bottom text-xs font-semibold text-muted-foreground";
export const TD = "border-b px-2 py-2 align-top";
