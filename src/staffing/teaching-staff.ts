import type { Prisma } from '@prisma/client';

/**
 * "Personal som undervisar": a TEACHER, and a SCHOOL_ADMIN who teaches
 * (Users.teaches, set by rektor or a full administrator; migration
 * 20270212090000). One answer, in the two forms the gateway asks it in, so
 * that the places that ask "who teaches in this school" cannot disagree about
 * what a teaching administrator is.
 *
 * The rule for using it, which is a decision and not a style: a place that
 * answers "who teaches in the school" (the day's teachers, who is free, an
 * exam's invigilators, an activity's teacher, the lärare file, the import's
 * teacher by e-mail, the label in SS12000) takes this. A place that answers
 * "who may step in, be asked, be in the pool or be a class teacher" does not,
 * and stays TEACHER only (Administratör som lärare, beslut 4: a substitute,
 * the cover request, the pool, a klasslärare), and src/staffing/
 * teaching-staff.spec.ts and the cover specs pin that it does. A person's role
 * on a post (TEACHER | CO_TEACHER, teacher-load.ts) is a third thing and not
 * this.
 *
 * Active or not is the caller's to say: a place that lists inactive people to
 * show them (Skolans dag) leaves it out, one that proposes adds
 * `isActive: true`. The mark stays on a person who is deactivated
 * (app.current_user_teaches() is false for them, as it should be), so it
 * cannot stand for "is active" here.
 */

/** The Prisma `where` that says a user teaches. Self-contained: it holds its own `OR`. */
export function teacherWhere(): Prisma.UserWhereInput {
  return { OR: [{ role: 'TEACHER' }, { role: 'SCHOOL_ADMIN', teaches: true }] };
}

/**
 * `teacherWhere` narrowed by a `where` of the caller's own, with an AND: the
 * only safe way to add to a fragment that holds an `OR`, since a spread of
 * two such objects keeps the last `OR` and drops the first (a silent widening).
 */
export function teacherWhereAnd(...and: Prisma.UserWhereInput[]): Prisma.UserWhereInput {
  return { AND: [teacherWhere(), ...and] };
}

/** What `teachesLike` reads of a person: the role, and the mark where the row has it. */
export interface TeachingPerson {
  role: string;
  teaches?: boolean | null;
}

/**
 * The same answer for a person already read, as a predicate: for the places
 * that filter a list they hold. A row read without `teaches` selected is not a
 * teaching administrator, so the select must name it; this is the form that
 * fails quietly if it does not, which is why every caller's select is held by
 * a spec.
 */
export function teachesLike(person: TeachingPerson): boolean {
  return person.role === 'TEACHER' || (person.role === 'SCHOOL_ADMIN' && person.teaches === true);
}
