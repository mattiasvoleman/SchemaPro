"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

/**
 * Which tab values have a panel on the page right now.
 *
 * Radix points every trigger's aria-controls at its panel's id, and eight
 * pages use the tabs as a view switcher with no TabsContent at all. A tab
 * naming an element that does not exist is an ARIA error (axe:
 * aria-valid-attr-value, critical) and sends a screen reader's "go to
 * controlled element" nowhere. So a TabsContent registers its value here, and
 * a trigger keeps aria-controls only when its panel is rendered.
 */
const PanelsContext = React.createContext<{
  panels: ReadonlySet<string>;
  register: (value: string) => () => void;
} | null>(null);

const Tabs = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root>
>((props, ref) => {
  const [panels, setPanels] = React.useState<ReadonlySet<string>>(() => new Set());
  const register = React.useCallback((value: string) => {
    setPanels((current) => new Set(current).add(value));
    return () =>
      setPanels((current) => {
        const next = new Set(current);
        next.delete(value);
        return next;
      });
  }, []);
  const context = React.useMemo(() => ({ panels, register }), [panels, register]);
  return (
    <PanelsContext.Provider value={context}>
      <TabsPrimitive.Root ref={ref} {...props} />
    </PanelsContext.Provider>
  );
});
Tabs.displayName = TabsPrimitive.Root.displayName;

const TabsList = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground",
      className,
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => {
  const panels = React.useContext(PanelsContext)?.panels;
  // Radix spreads these props after its own, so an undefined here removes
  // the attribute (see PanelsContext).
  const noPanel = panels !== undefined && !panels.has(props.value) ? { "aria-controls": undefined } : {};
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow",
        className,
      )}
      {...props}
      {...noPanel}
    />
  );
});
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => {
  const register = React.useContext(PanelsContext)?.register;
  const { value } = props;
  // Radix renders every tab's panel element (empty and hidden while
  // inactive), so a mounted TabsContent is a panel that exists.
  React.useEffect(() => register?.(value), [register, value]);
  return (
    <TabsPrimitive.Content
      ref={ref}
      className={cn(
        "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      {...props}
    />
  );
});
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
