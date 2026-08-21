/**
 * Swedish alphabetical order, mirroring web/lib/sorting.ts.
 *
 * Neither ordering source in this app gives it for free. The Supabase query
 * orders in PostgreSQL, whose collation puts å/ä/ö before b or folds them into
 * a and o; and the on-device SQLite read-back had no ORDER BY at all, so the
 * roster came back in cache-insertion order. A teacher marking attendance on
 * the phone therefore saw a different sequence from the same class than in the
 * web app.
 *
 * Duplicated rather than shared because the mobile app is its own package with
 * its own dependency graph — a short, self-contained rule is cheaper to keep
 * in step than a build-time link between the two.
 */
const collator = new Intl.Collator('sv', { numeric: true, sensitivity: 'variant' });

export function compareSwedish(a: string, b: string): number {
  return collator.compare(a, b);
}

/** Sorts students by the name shown on screen, leaving the input untouched. */
export function sortByDisplayName<T extends { displayName: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => compareSwedish(a.displayName, b.displayName));
}
