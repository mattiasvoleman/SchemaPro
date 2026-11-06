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

/**
 * Many terms at once, looked up word by word instead of one after the other: the names (both orders) and addresses of
 * a school's other pupils and guardians can be thousands, and a cell is checked against all of them. A term is found
 * when its words stand in the text as consecutive words (normalized: case, spacing and hyphens as everywhere above),
 * and also when the last word has a trailing s ("Anna Eks mamma").
 */
export class TermIndex {
  private readonly terms: Set<string>;
  private readonly longest: number;

  constructor(terms: ReadonlyArray<string>) {
    this.terms = new Set(terms.filter((term) => term !== ''));
    this.longest = Math.min(8, Math.max(1, ...[...this.terms].map((term) => term.split(' ').length)));
  }

  get size(): number {
    return this.terms.size;
  }

  found(text: string): boolean {
    if (this.terms.size === 0) return false;
    const words = normalize(text).split(' ');
    for (let at = 0; at < words.length; at += 1) {
      for (let length = 1; length <= this.longest && at + length <= words.length; length += 1) {
        const gram = words.slice(at, at + length).join(' ');
        if (this.terms.has(gram)) return true;
        const last = words[at + length - 1]!;
        if (length > 1 && last.length > 2 && last.endsWith('s') && this.terms.has(`${words.slice(at, at + length - 1).join(' ')} ${last.slice(0, -1)}`)) return true;
      }
    }
    return false;
  }
}
