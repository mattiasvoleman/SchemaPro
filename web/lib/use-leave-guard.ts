import { useEffect } from "react";

/*
 * Asks before the reader leaves a page that holds something nobody else has: the one state Förlägg i veckan keeps only in the
 * browser, the first half of a pair (lib/placement-pair.ts).
 *
 * Closing the tab, reloading and typing another address are the browser's own question (`beforeunload`: it shows its own
 * words, which a page cannot set). A link inside the app is not a page unload, so it is asked here, with `message`.
 * The browser's Back button is not asked at all: a page cannot stop it without rewriting the history, and what is lost is a
 * half that was laid a moment ago and was never saved. That is the decision, and it is written in the handbook.
 */
export function useLeaveGuard(active: boolean, message: string): void {
  useEffect(() => {
    if (!active) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older engines show the prompt only when the event has a return value.
      event.returnValue = "";
    };
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target instanceof Element ? event.target : null)?.closest("a[href]");
      if (!(link instanceof HTMLAnchorElement) || link.target === "_blank" || link.hasAttribute("download")) return;
      const to = new URL(link.href, window.location.href);
      // Another origin is a real unload, and the browser asks; the same address is not leaving.
      if (to.origin !== window.location.origin || (to.pathname === window.location.pathname && to.search === window.location.search)) return;
      if (!window.confirm(message)) {
        event.preventDefault();
        // The capture phase of the document comes before React's own listener: the link's navigation never starts.
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", click, true);
    };
  }, [active, message]);
}
