/**
 * Demoskolan: when a school may be deleted and made again, and when it never may (P1 Pilotkit, part 3).
 *
 * PURE. The reset (prisma/demo-reset.ts) reads the facts about the school it is about to delete, inside the transaction that
 * deletes it and with the school's row locked, and hands them here. Nothing here reads a row, and nothing says a word a person
 * reads but `refusalText`, which names counts and never a person.
 *
 * WHAT MAKES A SCHOOL THE DEMO SCHOOL is its people, and not its name. `School.slug` is unique, so a real school that was given the
 * slug `demo-skola` would have been found by `db:seed --reset` and deleted with all its data: what the script looked at was a
 * name, and a name is what a person types. A person's address is not: `example.com` is reserved (RFC 2606) and has no mailbox, so
 * a school whose every person, active or not, whatever the role, has an address at `demo-skola.example.com` cannot be anyone's
 * real school, and a school with a single person at any other address is not the demo school, whatever it is called. The school
 * is refused too when another school or a huvudman is tied to it, because a delete cascades through those rows and would reach
 * the other end (a room lent to a real school, a teacher shared with one, a school a kommun owns).
 *
 * An empty school is refused: a school with nobody in it proves nothing, and the seed always makes people.
 */

export interface DemoSpec {
  slug: string;
  name: string;
  /** The domain of every address of the school's people. Reserved for documentation, so no mailbox is behind it. */
  domain: string;
}

/** The demo school the seed makes (prisma/seed.ts, prisma/demo-school.ts). */
export const DEMO: DemoSpec = { slug: 'demo-skola', name: 'Demo Skola', domain: 'demo-skola.example.com' };

export interface SchoolFacts {
  slug: string;
  name: string;
  /** The address of every person row of the school: active or not, any role. */
  emails: readonly string[];
  /** Rows that tie the school to a huvudman (ownership, a request, an event in its history). */
  huvudmanTies: number;
  /** Rows that tie it to another school: a travel time, a room on loan, a teacher shared with it. */
  otherSchoolTies: number;
}

export type Refusal =
  | { code: 'NOT_THE_DEMO_SCHOOL' }
  | { code: 'NO_PEOPLE' }
  | { code: 'PEOPLE_OUTSIDE_THE_DEMO'; count: number }
  | { code: 'TIED_TO_A_HUVUDMAN'; count: number }
  | { code: 'TIED_TO_ANOTHER_SCHOOL'; count: number };

/**
 * Whether an address is at exactly the demo's domain: something before the `@`, and the domain after it and nothing else, so that
 * `x@evil.demo-skola.example.com`, `x@demo-skola.example.com.evil.org` and `x@xdemo-skola.example.com` are not. The case is not
 * the address's: a mail address is read without it.
 */
export function isDemoAddress(email: string, domain: string = DEMO.domain): boolean {
  // Whatever stands after the first `@` must be the domain and nothing else: a second `@` is a part of it and makes it another.
  const at = email.indexOf('@');
  if (at < 1) return false;
  return email.slice(at + 1).toLowerCase() === domain.toLowerCase();
}

/** Null when the school may be reset; otherwise the first reason it may not, in the order a person would ask them. */
export function judgeDemoSchool(facts: SchoolFacts, spec: DemoSpec = DEMO): Refusal | null {
  if (facts.slug !== spec.slug || facts.name !== spec.name) return { code: 'NOT_THE_DEMO_SCHOOL' };
  if (facts.emails.length === 0) return { code: 'NO_PEOPLE' };
  const outside = facts.emails.filter((email) => !isDemoAddress(email, spec.domain)).length;
  if (outside > 0) return { code: 'PEOPLE_OUTSIDE_THE_DEMO', count: outside };
  if (facts.huvudmanTies > 0) return { code: 'TIED_TO_A_HUVUDMAN', count: facts.huvudmanTies };
  if (facts.otherSchoolTies > 0) return { code: 'TIED_TO_ANOTHER_SCHOOL', count: facts.otherSchoolTies };
  return null;
}

/** What the script says when it refuses: a count where there are people, never an address and never a name. */
export function refusalText(refusal: Refusal, spec: DemoSpec = DEMO): string {
  switch (refusal.code) {
    case 'NOT_THE_DEMO_SCHOOL':
      return `Skolan heter eller har en adress som inte är demoskolans (${spec.slug}, "${spec.name}"). Ingenting är raderat.`;
    case 'NO_PEOPLE':
      return 'Skolan har inga personer, och en skola utan personer är inget bevis för att det är demoskolan. Ingenting är raderat.';
    case 'PEOPLE_OUTSIDE_THE_DEMO':
      return `${refusal.count} ${refusal.count === 1 ? 'person' : 'personer'} i skolan har en adress som inte slutar på @${spec.domain}. Då är det ingen demoskola, och ingenting är raderat.`;
    case 'TIED_TO_A_HUVUDMAN':
      return `Skolan har ${refusal.count} ${refusal.count === 1 ? 'koppling' : 'kopplingar'} till en huvudman. Då är det ingen demoskola, och ingenting är raderat.`;
    case 'TIED_TO_ANOTHER_SCHOOL':
      return `Skolan har ${refusal.count} ${refusal.count === 1 ? 'koppling' : 'kopplingar'} till en annan skola (restid, utlånad sal eller delad lärare). En radering skulle nå den skolan, och ingenting är raderat.`;
  }
}
