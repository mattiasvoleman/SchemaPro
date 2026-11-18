import { useEffect, useState } from "react";

/**
 * A module fetched after the page is up, or null until it is: for what the page needs only once somebody does something (a week
 * picked, a half of a pair laid) and which the route has no bytes for in its first load. `load` is read once, when the module is first
 * wanted. `onError` is told when it does not come (a chunk that fails to load): without it the rejection is nobody's, as it was.
 * `enabled` (true unless said) is whether anyone wants it: a page whose reader never uses the module fetches nothing for them
 * (review of #341, LÅG-5: the drag tools, 6,9 KB gzipped, were fetched for a reader who drags nothing). The fetch starts when it
 * turns true and is not undone when it turns false.
 */
export function useLazyModule<T>(load: () => Promise<T>, onError?: (error: unknown) => void, enabled = true): T | null {
  const [module, setModule] = useState<T | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void load().then(
      (loaded) => {
        if (live) setModule(loaded);
      },
      onError === undefined
        ? undefined
        : (error: unknown) => {
            if (live) onError(error);
          },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  return module;
}
