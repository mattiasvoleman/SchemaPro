/**
 * Free-text filtering for the admin lists.
 *
 * Every term has to match somewhere, in any order and in any field, so
 * "alma 7a" finds Alma in 7A while "7a alma" finds the same person. A single
 * concatenated haystack per row is what makes that work: matching term by
 * term against individual fields would fail the moment a query spans two of
 * them.
 *
 * Matching is case-insensitive but NOT diacritic-insensitive. In Swedish å, ä
 * and ö are letters in their own right, not decorated a's and o's — someone
 * searching for "Ostberg" is not looking for Östberg, and folding them
 * together would put strangers in each other's search results.
 */
export function matchesQuery(fields: (string | null | undefined)[], query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;

  const haystack = fields
    .filter((field): field is string => typeof field === "string" && field.length > 0)
    .join(" ")
    .toLowerCase();

  return terms.every((term) => haystack.includes(term));
}

/** Keeps the items whose searchable fields match every term in `query`. */
export function filterByQuery<T>(
  items: T[],
  query: string,
  fieldsOf: (item: T) => (string | null | undefined)[],
): T[] {
  if (query.trim() === "") return items;
  return items.filter((item) => matchesQuery(fieldsOf(item), query));
}
