import { useEffect, useState } from "react";

/**
 * `value`, once it has stood still for `delayMs`. The first value is
 * returned at once; only later changes wait. Values are compared by their
 * JSON, so a new object with the same fields is no change.
 *
 * For a read that is expensive on the server and keyed on what the user is
 * typing: Publicera's dry run takes the school's publication lock in DRAFT,
 * and a date field commits every parseable value as it is typed.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  const key = JSON.stringify(value);
  useEffect(() => {
    if (key === JSON.stringify(settled)) return;
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
    // `value` is read through `key`: the effect is about the content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, delayMs]);
  return key === JSON.stringify(settled) ? value : settled;
}
