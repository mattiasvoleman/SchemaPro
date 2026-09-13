import type { PrismaClient } from '@prisma/client';
import { gradeSpanOf, loadRosters, roomNeedsOf, type Rosters } from './room-eligibility';

/*
 * Who counts for a room: the one derivation both the generator and the room
 * optimisation read. Exercised here against a small school that answers its
 * queries the way the database would — a where clause filters, a select
 * decides which fields come back — so a filter dropped from a query lets in
 * exactly the pupils it used to keep out, and a field no longer selected is a
 * field that is no longer there.
 */

const CLASS_7A = 'c0000000-0000-4000-8000-0000000007aa';
const CLASS_8A = 'c0000000-0000-4000-8000-0000000008aa';
const CLASS_9A = 'c0000000-0000-4000-8000-0000000009aa';
const MA = 'c0000000-0000-4000-8000-00000000000a';
const SV = 'c0000000-0000-4000-8000-00000000000b';
const EMPTY = 'c0000000-0000-4000-8000-0000000000ee';

const pupil = (n: number) => `e0000000-0000-4000-8000-00000000000${n}`;
const TEACHER = 'b0000000-0000-4000-8000-000000000001';

type Person = {
  id: string;
  role: 'STUDENT' | 'TEACHER';
  isActive: boolean;
  studentGroupId: string | null;
};
type Membership = { studentId: string; studentGroupId: string };
type Row = Record<string, unknown>;
type Selection = Record<string, unknown> | undefined;

const isRelation = (value: unknown): boolean =>
  Array.isArray(value) ||
  (value !== null && typeof value === 'object' && !(value instanceof Date));

/**
 * A select as Prisma reads it: only the truthy fields, a relation through its
 * own select, scalars only when there is none — and a select that asks for
 * nothing refused, as the engine refuses it (EmptySelection).
 */
const assertSelects = (select: Selection): void => {
  if (select === undefined) return;
  const asked = Object.entries(select).filter(([, how]) => how);
  if (asked.length === 0) throw new Error('EmptySelection: a select must ask for a field');
  for (const [, how] of asked) {
    if (typeof how === 'object') assertSelects((how as { select?: Selection }).select);
  }
};
const selected = (row: Row, select: Selection): Row => {
  if (select === undefined) {
    return Object.fromEntries(Object.entries(row).filter(([, value]) => !isRelation(value)));
  }
  const out: Row = {};
  for (const [field, how] of Object.entries(select)) {
    if (!how || !(field in row)) continue;
    const value = row[field];
    const nested = typeof how === 'object' ? (how as { select?: Selection }).select : undefined;
    const pick = (item: unknown) => (item === null ? null : selected(item as Row, nested));
    out[field] = !isRelation(value) ? value : Array.isArray(value) ? value.map(pick) : pick(value);
  }
  return out;
};

/** `{ in: [...] }`, or no condition at all when the filter object is empty. */
const within = (value: unknown, filter: unknown): boolean => {
  if (filter === undefined) return true;
  const { in: list, ...rest } = filter as { in?: unknown[] };
  if (Object.keys(rest).length > 0) throw new Error(`unexpected filter ${JSON.stringify(rest)}`);
  return list === undefined || list.includes(value);
};

/** The school's users and teaching-group memberships, queried as Prisma would. */
const schoolOf = (people: Person[], memberships: Membership[]) => {
  const isStudent = (person: Person | undefined, where: Row | undefined) =>
    person !== undefined &&
    (where?.['role'] === undefined || person.role === where['role']) &&
    (where?.['isActive'] === undefined || person.isActive === where['isActive']);

  const user = {
    findMany: jest.fn(async (args: { where?: Row; select?: Selection } = {}) => {
      assertSelects(args.select);
      const where = args.where ?? {};
      for (const key of Object.keys(where)) {
        if (!['role', 'isActive', 'studentGroupId', 'id'].includes(key)) {
          throw new Error(`unexpected user filter ${key}`);
        }
      }
      return people
        .filter(
          (person) =>
            isStudent(person, where) &&
            within(person.studentGroupId, where['studentGroupId']) &&
            within(person.id, where['id']),
        )
        .map((person) => selected(person, args.select));
    }),
  };
  const studentGroupMember = {
    findMany: jest.fn(async (args: { where?: Row; select?: Selection } = {}) => {
      assertSelects(args.select);
      const where = args.where ?? {};
      for (const key of Object.keys(where)) {
        if (!['studentGroupId', 'student'].includes(key)) {
          throw new Error(`unexpected membership filter ${key}`);
        }
      }
      return memberships
        .filter(
          (row) =>
            within(row.studentGroupId, where['studentGroupId']) &&
            isStudent(
              people.find((person) => person.id === row.studentId),
              where['student'] as Row | undefined,
            ),
        )
        .map((row) => selected(row, args.select));
    }),
  };
  return { tx: { user, studentGroupMember } as unknown as PrismaClient, user, studentGroupMember };
};

const student = (n: number, studentGroupId: string | null, isActive = true): Person => ({
  id: pupil(n),
  role: 'STUDENT',
  isActive,
  studentGroupId,
});

const GROUPS = [
  { id: CLASS_7A, gradeLevel: 7 },
  { id: CLASS_8A, gradeLevel: 8 },
  { id: CLASS_9A, gradeLevel: 9 },
  { id: MA, gradeLevel: null },
  { id: SV, gradeLevel: null },
  { id: EMPTY, gradeLevel: null },
];

/*
 * 7A: pupils 1 and 2, and pupil 3 who has left (inactive). A teacher is filed
 * under 7A too. 8A: pupil 4. 9A: pupil 5.
 * Ma: pupil 5, pupil 2 again, and pupil 3 who has left. Sv: pupil 4.
 */
const PEOPLE: Person[] = [
  student(1, CLASS_7A),
  student(2, CLASS_7A),
  student(3, CLASS_7A, false),
  { id: TEACHER, role: 'TEACHER', isActive: true, studentGroupId: CLASS_7A },
  student(4, CLASS_8A),
  student(5, CLASS_9A),
];
const MEMBERSHIPS: Membership[] = [
  { studentId: pupil(5), studentGroupId: MA },
  { studentId: pupil(2), studentGroupId: MA },
  { studentId: pupil(3), studentGroupId: MA },
  { studentId: TEACHER, studentGroupId: MA },
  { studentId: pupil(4), studentGroupId: SV },
];

const rostersFor = (groupIds: string[], named: string[] = []): Promise<Rosters> =>
  loadRosters(schoolOf(PEOPLE, MEMBERSHIPS).tx, groupIds, GROUPS, named);

describe('loadRosters', () => {
  it('seats the active pupils of the groups asked about, from both membership kinds', async () => {
    const rosters = await rostersFor([CLASS_7A, MA]);

    // Not the pupil who has left, not the teacher filed under a class, and
    // nobody from 8A or Sv, which nobody asked about.
    expect(rosters.membersByGroup).toEqual(
      new Map([
        [CLASS_7A, new Set([pupil(1), pupil(2)])],
        [MA, new Set([pupil(5), pupil(2)])],
      ]),
    );
    expect(rosters.groupsByStudent).toEqual(
      new Map([
        [pupil(1), new Set([CLASS_7A])],
        [pupil(2), new Set([CLASS_7A, MA])],
        [pupil(5), new Set([MA])],
      ]),
    );
    expect(rosters.homeMembers).toEqual([
      { id: pupil(1), studentGroupId: CLASS_7A },
      { id: pupil(2), studentGroupId: CLASS_7A },
    ]);
  });

  it('reads the home class of every pupil it reached, and of nobody else', async () => {
    const rosters = await rostersFor([MA]);

    // Pupil 5 sits in Ma but belongs to 9A, and it is 9A's year that counts.
    expect(rosters.homeClassOf).toEqual(
      new Map([
        [pupil(5), CLASS_9A],
        [pupil(2), CLASS_7A],
      ]),
    );
  });

  it('reads the home class of a pupil a lesson names one by one', async () => {
    // Pupil 4 is in neither group; named on the lesson, they still have a year.
    const rosters = await rostersFor([CLASS_7A], [pupil(4)]);

    expect(rosters.homeClassOf.get(pupil(4))).toBe(CLASS_8A);
  });

  it('carries each group’s own year, as the groups were read', async () => {
    const rosters = await rostersFor([CLASS_7A]);

    expect(rosters.gradeOfGroup.get(CLASS_8A)).toBe(8);
    expect(rosters.gradeOfGroup.get(MA)).toBeNull();
  });
});

describe('gradeSpanOf', () => {
  it('takes a teaching group’s years from its pupils’ home classes', async () => {
    const rosters = await rostersFor([MA]);

    expect(gradeSpanOf(rosters, [MA])).toEqual({ min: 7, max: 9 });
  });

  it('lets the pupils’ years win over a year the group carries itself', async () => {
    // Ma labelled year 9 by hand, with only 7A's pupil 2 in it: a room for
    // years 7 is right for it, and a room for year 9 alone is not.
    const rosters = await loadRosters(
      schoolOf(PEOPLE, [{ studentId: pupil(2), studentGroupId: MA }]).tx,
      [MA],
      GROUPS.map((group) => (group.id === MA ? { ...group, gradeLevel: 9 } : group)),
    );

    expect(gradeSpanOf(rosters, [MA])).toEqual({ min: 7, max: 7 });
  });

  it('falls back to the groups’ own years when no pupil carries one', async () => {
    const rosters = await rostersFor([CLASS_8A, EMPTY]);

    expect(gradeSpanOf(rosters, [EMPTY])).toBeNull();
    expect(
      gradeSpanOf(
        await loadRosters(schoolOf([], []).tx, [CLASS_8A], GROUPS),
        [CLASS_8A],
      ),
    ).toEqual({ min: 8, max: 8 });
  });

  it('counts a named pupil’s year alongside the groups’', async () => {
    const rosters = await rostersFor([CLASS_7A], [pupil(4)]);

    expect(gradeSpanOf(rosters, [CLASS_7A], [pupil(4)])).toEqual({ min: 7, max: 8 });
  });
});

describe('roomNeedsOf', () => {
  it('counts a pupil in two of the groups once', async () => {
    const rosters = await rostersFor([CLASS_7A, MA]);

    expect(
      roomNeedsOf(rosters, { groupIds: [CLASS_7A, MA] }, { requiredRoomTypeId: 'lab' }),
    ).toEqual({
      studentGroupSize: 3,
      minGradeLevel: 7,
      maxGradeLevel: 9,
      requiredRoomTypeId: 'lab',
    });
  });

  it('adds no chair for an empty group beside a full one', async () => {
    const rosters = await rostersFor([CLASS_7A, EMPTY]);

    expect(
      roomNeedsOf(rosters, { groupIds: [CLASS_7A, EMPTY] }, { requiredRoomTypeId: null })
        .studentGroupSize,
    ).toBe(2);
  });

  it('still asks for one chair, and no years, for a group nobody is in', async () => {
    const rosters = await rostersFor([EMPTY]);

    expect(roomNeedsOf(rosters, { groupIds: [EMPTY] }, { requiredRoomTypeId: null })).toEqual({
      studentGroupSize: 1,
      minGradeLevel: null,
      maxGradeLevel: null,
      requiredRoomTypeId: null,
    });
  });

  it('seats a named pupil beside the group', async () => {
    const rosters = await rostersFor([CLASS_7A], [pupil(4)]);

    expect(
      roomNeedsOf(
        rosters,
        { groupIds: [CLASS_7A], studentIds: [pupil(4)] },
        { requiredRoomTypeId: null },
      ),
    ).toMatchObject({ studentGroupSize: 3, minGradeLevel: 7, maxGradeLevel: 8 });
  });
});
