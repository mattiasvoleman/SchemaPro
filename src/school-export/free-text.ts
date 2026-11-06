/**
 * What the export looks for in free text (an attendance or absence note, a leave's reason, a decision's note, a
 * notice, any text cell of a dumped table) to keep a protected person out of it.
 *
 * It finds, in any case: the person's id (with or without hyphens), the full name in either order, and the e-mail
 * address, with any run of spaces, hard spaces, commas or hyphens between the words counted as one space ("Anna
 * Ek", "EK,  Anna", "anna-ek"). It does NOT find a first name alone, a nickname, a spelling that differs (a name
 * without its diacritics), a description ("Annas mamma" is found only because it holds "Anna Ek"; "mamma" alone is
 * not), or a name in a language of the person's own. README.txt, the manual and the integration document say so.
 */

/** A run the search treats as one space: whitespace, hard spaces, commas, hyphens. */
export const SPACING = /[\s ,-]+/g;
/** The same as a Postgres regular expression, for regexp_replace (passed as a parameter, so no escaping is lost). */
export const SPACING_SQL = '[\\s,\\u00a0-]+';

export const normalize = (value: string): string => value.toLowerCase().replace(SPACING, ' ').trim();

export interface ProtectedPerson {
  first: string;
  last: string;
  email: string;
}

/** The names (first-last and last-first) and the address of each person, normalized; names of one word are left out. */
export function termsOf(people: ReadonlyArray<ProtectedPerson>): string[] {
  const terms = new Set<string>();
  for (const person of people) {
    const first = normalize(person.first);
    const last = normalize(person.last);
    if (first !== '' && last !== '') {
      terms.add(`${first} ${last}`);
      terms.add(`${last} ${first}`);
    }
    const email = normalize(person.email);
    if (email !== '') terms.add(email);
  }
  return [...terms];
}

/** An id as it is written (lower case, hyphens) and without hyphens. */
export function idForms(ids: ReadonlyArray<string>): string[] {
  return [...new Set(ids.flatMap((id) => [id.toLowerCase(), id.toLowerCase().replace(/-/g, '')]))];
}
