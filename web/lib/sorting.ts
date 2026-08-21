/**
 * Swedish alphabetical order.
 *
 * The database's own ORDER BY cannot be relied on for this: its collation is
 * whatever the host was initialised with, and neither of the usual answers is
 * Swedish. Under C the accented letters sort before B; under en_US they fold
 * into A and O. Both put Övrigt in the middle of the list and Ämnesval before
 * Bild, which is the first thing a Swedish school notices about a subject
 * list.
 *
 * Sorting in the browser with an explicit locale gives the same order on every
 * deployment, whatever the database underneath happens to be.
 */
const collator = new Intl.Collator("sv", {
  // Matematik 2 before Matematik 10, not after it.
  numeric: true,
  // Case differences order but do not dominate: "bild" sits with "Bild",
  // not in a separate lowercase block after Ö.
  sensitivity: "variant",
  caseFirst: "false",
});

export function compareSwedish(a: string, b: string): number {
  return collator.compare(a, b);
}

/** Sorts by a name field, leaving the input array untouched. */
export function sortByName<T>(items: T[], nameOf: (item: T) => string): T[] {
  return [...items].sort((a, b) => compareSwedish(nameOf(a), nameOf(b)));
}
