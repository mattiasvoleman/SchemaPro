import type { Prisma } from '@prisma/client';
import { teacherWhere, teacherWhereAnd, teachesLike } from './teaching-staff';

/*
 * "Who teaches in the school": a TEACHER, and a SCHOOL_ADMIN with Users.teaches. The two
 * forms (the where, the predicate) must agree on every row, so the where is evaluated here
 * by a small reader of exactly the Prisma operators it uses, against rows of every kind.
 */
interface Row {
  id: string;
  role: string;
  teaches: boolean;
  isActive: boolean;
}

const ROWS: Row[] = [
  { id: 'teacher', role: 'TEACHER', teaches: false, isActive: true },
  { id: 'teacher-inactive', role: 'TEACHER', teaches: false, isActive: false },
  { id: 'teaching-admin', role: 'SCHOOL_ADMIN', teaches: true, isActive: true },
  { id: 'teaching-admin-inactive', role: 'SCHOOL_ADMIN', teaches: true, isActive: false },
  { id: 'admin', role: 'SCHOOL_ADMIN', teaches: false, isActive: true },
  { id: 'student', role: 'STUDENT', teaches: false, isActive: true },
  { id: 'guardian', role: 'GUARDIAN', teaches: false, isActive: true },
  // Not a row a database holds (CHECK Users_teaches_is_a_teaching_administrators), but the where must not trust it.
  { id: 'student-marked-anyway', role: 'STUDENT', teaches: true, isActive: true },
];

/** Reads the operators teacherWhere uses (AND, OR, a column's value), and refuses any it does not know. */
function matches(where: Prisma.UserWhereInput, row: Row): boolean {
  return Object.entries(where).every(([key, wanted]) => {
    if (key === 'OR') return (wanted as Prisma.UserWhereInput[]).some((one) => matches(one, row));
    if (key === 'AND') return (wanted as Prisma.UserWhereInput[]).every((one) => matches(one, row));
    if (key === 'role' || key === 'teaches' || key === 'isActive') return row[key] === wanted;
    throw new Error(`the reader does not know ${key}`);
  });
}

const found = (where: Prisma.UserWhereInput) => ROWS.filter((row) => matches(where, row)).map((row) => row.id);

describe('teacherWhere and teachesLike', () => {
  it('names a teacher and an administrator who teaches, and no one else', () => {
    expect(found(teacherWhere())).toEqual(['teacher', 'teacher-inactive', 'teaching-admin', 'teaching-admin-inactive']);
  });

  it('leaves active or not to the caller, and the mark does not stand for it', () => {
    expect(found({ ...teacherWhere(), isActive: true })).toEqual(['teacher', 'teaching-admin']);
  });

  it('does not take the mark on any role but an administrator’s', () => {
    expect(found(teacherWhere())).not.toContain('student-marked-anyway');
    expect(teachesLike({ role: 'STUDENT', teaches: true })).toBe(false);
    expect(teachesLike({ role: 'GUARDIAN', teaches: true })).toBe(false);
  });

  it('agrees with itself: the predicate says what the where says, on every row', () => {
    for (const row of ROWS) expect([row.id, teachesLike(row)]).toEqual([row.id, matches(teacherWhere(), row)]);
  });

  it('reads a row that was read without the mark as not teaching: the select must name it', () => {
    expect(teachesLike({ role: 'SCHOOL_ADMIN' })).toBe(false);
    expect(teachesLike({ role: 'SCHOOL_ADMIN', teaches: null })).toBe(false);
    expect(teachesLike({ role: 'TEACHER' })).toBe(true);
  });

  it('adds to a where with an AND, because a spread keeps one OR and drops the other', () => {
    const own: Prisma.UserWhereInput = { OR: [{ isActive: true }, { role: 'STUDENT' }] };
    // The silent widening teacherWhereAnd exists to refuse:
    expect(found({ ...teacherWhere(), ...own })).toContain('student');
    expect(found(teacherWhereAnd(own))).toEqual(['teacher', 'teaching-admin']);
    expect(found(teacherWhereAnd({ isActive: true }))).toEqual(['teacher', 'teaching-admin']);
  });
});
