import { useEffect, useState } from "react";

/**
 * A module fetched after the page is up, or null until it is: for what the page needs only once somebody does something (a week
 * picked, a half of a pair laid) and which the route has no bytes for in its first load. `load` is read once, on the first render.
 */
export function useLazyModule<T>(load: () => Promise<T>): T | null {
  const [module, setModule] = useState<T | null>(null);
  useEffect(() => {
    let live = true;
    void load().then((loaded) => {
      if (live) setModule(loaded);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return module;
}
