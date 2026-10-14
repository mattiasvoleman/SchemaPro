"use client";

import * as React from "react";

/**
 * The box a table scrolls sideways in, and a tab stop while it does.
 *
 * A table wider than the screen (a phone, or a wide matrix) scrolls inside
 * this box, and only a mouse or a finger could scroll it: nothing in a table
 * of text takes focus, so the keyboard had no way in (WCAG 2.1.1, axe
 * scrollable-region-focusable). Focused, the arrow keys scroll it. A table
 * that fits gets no extra tab stop.
 */
export function TableScroll({ children }: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = React.useState(false);

  React.useEffect(() => {
    const box = ref.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const measure = () => setScrolls(box.scrollWidth > box.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    // The table inside grows with its rows, which the box's own size misses.
    if (box.firstElementChild) observer.observe(box.firstElementChild);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      tabIndex={scrolls ? 0 : undefined}
      className="relative w-full overflow-auto rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </div>
  );
}
