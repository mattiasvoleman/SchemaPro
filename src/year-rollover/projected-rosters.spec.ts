import { ConflictException, ForbiddenException } from '@nestjs/common';
import { givenRolloverWorld, type RolloverWorld, type Row } from '../../test/utils/rollover-world';
import {
  ROLLOVER_NOT_ACTIVATED,
  countHomePupils,
  overlayHomeRows,
  readHomeClassesOf,
  readHomePupils,
  rostersOfYear,
  type ProjectedRosters,
  type RosterBasis,
} from './projected-rosters';

const admin = { role: 'SCHOOL_ADMIN' };
const teacher = { role: 'TEACHER' };

const day = (value: string) => new Date(`${value}T00:00:00.000Z`);
const year = (id: string, name: string, start: string, extra: Row = {}): Row => ({
  id,
  schoolId: 'school',
  name,
  startDate: day(`${start}-08-16`),
  endDate: day(`${Number(start) + 1}-06-10`),
  isActive: false,
  predecessorId: null,
  graduatingGradeLevel: 9,
  ...extra,
});
const group = (id: string, academicYearId: string, gradeLevel: number | null, predecessorId: string | null = null, kind = 'CLASS'): Row => ({
  id,
  name: id.toUpperCase(),
  academicYearId,
  kind,
  gradeLevel,
  predecessorId,
});
const pupil = (id: string, studentGroupId: string | null, isActive = true): Row => ({
  id,
  role: 'STUDENT',
  isActive,
  studentGroupId,
});

/**
 * A (active) → B (rolled, not activated), and S, a year of its own.
 * a7 → b8, a8 → b9, a9 graduates, a6's successor is a teaching group, aX was
 * skipped. bMa (Ma8) was carried from aMa with p1. p7 enrolled straight into
 * b8, p9 is in S, p10 in no class, p11 is inactive in a7, the teacher has no
 * class.
 */
function rows(): Record<string, Row[]> {
  return {
    academicYear: [
      year('A', '2026/27', '2026', { isActive: true }),
      year('B', '2027/28', '2027', { predecessorId: 'A' }),
      year('S', 'Sommarskola', '2027', { graduatingGradeLevel: null }),
    ],
    studentGroup: [
      group('a7', 'A', 7),
      group('a8', 'A', 8),
      group('a9', 'A', 9),
      group('a6', 'A', 6),
      group('aX', 'A', 7),
      group('aMa', 'A', 7, null, 'TEACHING_GROUP'),
      group('b8', 'B', 8, 'a7'),
      group('b9', 'B', 9, 'a8'),
      group('b7', 'B', 7, 'a6', 'TEACHING_GROUP'),
      group('bMa', 'B', 8, 'aMa', 'TEACHING_GROUP'),
      group('s1', 'S', null),
    ],
    user: [
      pupil('p1', 'a7'),
      pupil('p2', 'a7'),
      pupil('p3', 'a8'),
      pupil('p4', 'a9'),
      pupil('p5', 'a6'),
      pupil('p6', 'aX'),
      pupil('p7', 'b8'),
      pupil('p9', 's1'),
      pupil('p10', null),
      pupil('p11', 'a7', false),
      { id: 't1', role: 'TEACHER', isActive: true, studentGroupId: null },
    ],
    studentGroupMember: [
      { studentGroupId: 'aMa', studentId: 'p1' },
      { studentGroupId: 'bMa', studentId: 'p1' },
      // p4 graduates, but was put in next year's Ma8: a STALE membership.
      { studentGroupId: 'bMa', studentId: 'p4' },
    ],
  };
}

const writes = (world: RolloverWorld) =>
  world.calls.filter((call) => !/^(find|count|aggregate|groupBy)/.test(call.method));

const projected = (basis: RosterBasis): ProjectedRosters => {
  expect(basis.kind).toBe('PROJECTED');
  return basis as ProjectedRosters;
};

describe('rostersOfYear', () => {
  it('R1: the active year is CURRENT, with no statement when its flags are known and one primary-key read when not', async () => {
    const world = givenRolloverWorld(rows(), { strict: true });
    expect(await rostersOfYear(world.tx, admin, 'A', { isActive: true, predecessorId: null })).toEqual({ kind: 'CURRENT' });
    expect(world.calls).toEqual([]);
    expect(await rostersOfYear(world.tx, admin, 'A')).toEqual({ kind: 'CURRENT' });
    expect(world.calls.map((call) => `${call.model}.${call.method}`)).toEqual(['academicYear.findUnique']);
  });

  it('R2: a year outside every chain is CURRENT, with no statement when its flags are known', async () => {
    const world = givenRolloverWorld(rows(), { strict: true });
    expect(await rostersOfYear(world.tx, admin, 'S', { isActive: false, predecessorId: null })).toEqual({ kind: 'CURRENT' });
    expect(world.calls).toEqual([]);
  });

  it('a relation count over SETTLED_CURRENT settles R1 and R2 with no statement; a zero count asks the year', async () => {
    // What the master-lesson PATCH hands over: its school read counts the
    // lesson's year when it is active or outside every chain.
    for (const [yearId, inSettled] of [['A', true], ['S', true], ['B', false]] as const) {
      const world = givenRolloverWorld(rows(), { strict: true });
      const counted = world.rows['academicYear']!.filter(
        (candidate) => candidate['id'] === yearId && (candidate['isActive'] === true || candidate['predecessorId'] === null),
      ).length;
      expect(counted > 0).toBe(inSettled);
      const basis = await rostersOfYear(world.tx, admin, yearId, { settledCurrent: counted > 0 });
      if (inSettled) {
        expect(basis).toEqual({ kind: 'CURRENT' });
        expect(world.calls).toEqual([]);
      } else {
        // B: the flags are read, then the chain, as without `known`.
        expect(projected(basis).counts.moved).toBeGreaterThan(0);
        expect(world.calls[0]).toMatchObject({ model: 'academicYear', method: 'findUnique' });
      }
    }
    // The role is checked before the count is trusted.
    const world = givenRolloverWorld(rows(), { strict: true });
    await expect(rostersOfYear(world.tx, { role: 'STUDENT' }, 'A', { settledCurrent: true })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('R3: a year RLS hides is CURRENT, and the reader answers its own 404', async () => {
    const world = givenRolloverWorld(rows(), { strict: true });
    expect(await rostersOfYear(world.tx, admin, 'hidden')).toEqual({ kind: 'CURRENT' });
    // Flags handed over for a year the source read does not see.
    const later = givenRolloverWorld(rows(), { strict: true });
    expect(await rostersOfYear(later.tx, admin, 'hidden', { isActive: false, predecessorId: 'A' })).toEqual({ kind: 'CURRENT' });
  });

  it('R5: the active year’s successor reads the activation’s own moves, from the four school-wide reads, and writes nothing', async () => {
    const world = givenRolloverWorld(rows(), { strict: true });
    const basis = projected(await rostersOfYear(world.tx, admin, 'B', { isActive: false, predecessorId: 'A' }));
    expect(Object.fromEntries(basis.homeOf)).toEqual({ p1: 'b8', p2: 'b8', p3: 'b9', p4: null, p5: null, p6: null });
    expect(basis.counts).toEqual({ moved: 3, graduates: 1, unplaced: 2 });
    expect(basis.membershipsOutOfDate).toEqual({ missing: 0, stale: 1 });
    expect(world.calls.map((call) => `${call.model}.${call.method}`)).toEqual([
      'academicYear.findMany',
      'studentGroup.findMany',
      'user.findMany',
      'studentGroupMember.findMany',
    ]);
    expect(writes(world)).toEqual([]);
    // Not by the day: the same before and long after A ends.
    const again = givenRolloverWorld(rows(), { strict: true });
    expect(projected(await rostersOfYear(again.tx, teacher, 'B')).homeOf).toEqual(basis.homeOf);
  });

  it('R5 stays PROJECTED when a year inserted after it holds a newcomer (superseded, which only blocks the activation)', async () => {
    const world = givenRolloverWorld(rows(), { strict: true });
    world.rows['academicYear']!.push(year('C', '2028/29', '2028', { predecessorId: 'B' }));
    world.rows['studentGroup']!.push(group('c7', 'C', 7));
    world.rows['user']!.push(pupil('newcomer', 'c7'));
    const basis = projected(await rostersOfYear(world.tx, admin, 'B'));
    expect(basis.homeOf.get('p1')).toBe('b8');
    expect(basis.homeOf.has('newcomer')).toBe(false);
  });

  it('R5 with nothing left to move is CURRENT', async () => {
    const world = givenRolloverWorld(rows(), { strict: true });
    for (const user of world.rows['user']!) {
      if (user['isActive'] && ['a7', 'a8', 'a9', 'a6', 'aX'].includes(user['studentGroupId'] as string)) {
        user['studentGroupId'] = null;
      }
    }
    expect(await rostersOfYear(world.tx, admin, 'B')).toEqual({ kind: 'CURRENT' });
  });

  it('R6: a year two steps ahead, or any chain year of a school with no active year, is refused naming its predecessor', async () => {
    const world = givenRolloverWorld(rows(), { strict: true });
    world.rows['academicYear']!.push(year('C', '2028/29', '2028', { predecessorId: 'B' }));
    world.rows['studentGroup']!.push(group('c9', 'C', 9, 'b8'));
    const refusal = await rostersOfYear(world.tx, admin, 'C').catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ConflictException);
    expect((refusal as ConflictException).getResponse()).toEqual({
      message: 'Klasslistorna för 2028/29 kan inte räknas fram ännu: föregående läsår 2027/28 är inte aktiverat. Aktivera 2027/28 först.',
      code: ROLLOVER_NOT_ACTIVATED,
      params: { year: '2028/29', predecessor: '2027/28' },
    });

    const none = givenRolloverWorld(rows(), { strict: true });
    none.rows['academicYear']![0]!['isActive'] = false;
    await expect(rostersOfYear(none.tx, admin, 'B')).rejects.toMatchObject({
      response: { code: ROLLOVER_NOT_ACTIVATED, params: { year: '2027/28', predecessor: '2026/27' } },
    });
  });

  it('R4: a past year — A after B’s activation — is CURRENT, although one of its pupils is still to be moved', async () => {
    const world = givenRolloverWorld(rows(), { strict: true });
    for (const row of world.rows['academicYear']!) row['isActive'] = row['id'] === 'B';
    // A straggler of A's own predecessor would make A "have writes".
    world.rows['academicYear']!.push(year('Z', '2025/26', '2025'));
    world.rows['academicYear']![0]!['predecessorId'] = 'Z';
    world.rows['studentGroup']!.push(group('z6', 'Z', 6), { ...group('a7x', 'A', 7, 'z6') });
    world.rows['user']!.push(pupil('straggler', 'z6'));
    expect(await rostersOfYear(world.tx, admin, 'A')).toEqual({ kind: 'CURRENT' });
  });

  it('throws for a pupil or a guardian, whatever the year, before reading anything', async () => {
    const world = givenRolloverWorld(rows(), { strict: true });
    for (const role of ['STUDENT', 'GUARDIAN', 'SYSTEM_ADMIN']) {
      await expect(rostersOfYear(world.tx, { role }, 'A', { isActive: true, predecessorId: null })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(rostersOfYear(world.tx, { role }, 'B')).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(world.calls).toEqual([]);
  });
});

describe('the read helpers', () => {
  const basisOf = async (world: RolloverWorld) => rostersOfYear(world.tx, admin, 'B');

  it('CURRENT runs the reader’s own query and returns its rows as read', async () => {
    const world = givenRolloverWorld(rows(), { strict: true });
    const current: RosterBasis = { kind: 'CURRENT' };
    expect(await readHomePupils(world.tx, current, { role: 'STUDENT', isActive: true }, ['a7'])).toEqual([
      { id: 'p1', studentGroupId: 'a7' },
      { id: 'p2', studentGroupId: 'a7' },
    ]);
    expect(await countHomePupils(world.tx, current, { role: 'STUDENT', isActive: true }, 'a7')).toBe(2);
    expect(world.calls.map((call) => [call.method, call.args])).toEqual([
      ['findMany', { where: { role: 'STUDENT', isActive: true, studentGroupId: { in: ['a7'] } }, select: { id: true, studentGroupId: true } }],
      ['count', { where: { role: 'STUDENT', isActive: true, studentGroupId: 'a7' } }],
    ]);
  });

  it('PROJECTED drops the moved pupils by id and adds them where they are going, under the reader’s own filters', async () => {
    const world = givenRolloverWorld(rows(), { strict: true });
    const basis = await basisOf(world);
    world.calls.length = 0;
    expect(await readHomePupils(world.tx, basis, { role: 'STUDENT', isActive: true }, ['b8', 'b9', 'a7'])).toEqual([
      { id: 'p1', studentGroupId: 'b8' },
      { id: 'p2', studentGroupId: 'b8' },
      { id: 'p3', studentGroupId: 'b9' },
      { id: 'p7', studentGroupId: 'b8' },
    ]);
    // No filter (master-lessons' rosterOf): the inactive p11 stays in a7.
    expect(await readHomePupils(world.tx, basis, {}, ['a7'])).toEqual([{ id: 'p11', studentGroupId: 'a7' }]);
    expect(await countHomePupils(world.tx, basis, { role: 'STUDENT', isActive: true }, 'b8')).toBe(3);
    // An id filter applies to an added pupil too (the reverse participant count).
    expect(await countHomePupils(world.tx, basis, { id: { in: ['p2', 'p9'] } }, ['b8'])).toBe(1);
    expect(await readHomeClassesOf(world.tx, basis, ['p4', 'p1', 'p9', 'p11'])).toEqual([
      { id: 'p1', studentGroupId: 'b8' },
      { id: 'p11', studentGroupId: 'a7' },
      { id: 'p4', studentGroupId: null },
      { id: 'p9', studentGroupId: 's1' },
    ]);
    expect(writes(world)).toEqual([]);
  });

  it('counts each pupil once when the activation commits between the basis read and the roster read', async () => {
    const world = givenRolloverWorld(rows(), { strict: true });
    const basis = await basisOf(world);
    // The activation's writes, as executeActivation makes them.
    for (const user of world.rows['user']!) {
      const target = (basis as ProjectedRosters).homeOf.get(user['id'] as string);
      if (target !== undefined) user['studentGroupId'] = target;
    }
    expect(await readHomePupils(world.tx, basis, { role: 'STUDENT', isActive: true }, ['b8'])).toEqual([
      { id: 'p1', studentGroupId: 'b8' },
      { id: 'p2', studentGroupId: 'b8' },
      { id: 'p7', studentGroupId: 'b8' },
    ]);
    expect(await countHomePupils(world.tx, basis, { role: 'STUDENT', isActive: true }, 'b8')).toBe(3);
  });

  it('overlayHomeRows leaves CURRENT rows and their order alone', () => {
    const rows = [
      { id: 'z', studentGroupId: 'g' },
      { id: 'a', studentGroupId: 'g' },
    ];
    expect(overlayHomeRows({ kind: 'CURRENT' }, rows, ['g'])).toEqual(rows);
  });
});
