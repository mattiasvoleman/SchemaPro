import { ConflictException, NotFoundException } from '@nestjs/common';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { MasterLessonsService } from '../calendar/master-lessons.service';
import type { PrismaService } from '../database/prisma.service';
import { lockYearForGrundschemaEdit } from '../optimization/regeneration-lock';
import { readOtherSchoolHolds } from '../optimization/other-school-holds';
import { readBoardFacts } from '../swaps/board-rules';
import { rostersOfYear } from '../year-rollover/projected-rosters';
import { keptMastersWhere } from '../optimization/preserved-lessons';
import * as placementJudge from './placement-judge';
import { REQUIREMENT_PLACEMENTS_STALE } from './placement-refusal';
import { rowsKeyOf } from './placement-rows-key';
import { RequirementPlacementsService } from './requirement-placements.service';

/*
 * baseKey on the PUT and rowsKey in the answers (A2): a write is made "on top of" the rows the client read, and a list
 * somebody wrote in between is refused with nothing written. The two connections that make it matter are the adapter
 * probe's (scripts/test/probe-forlagda-poster.ts); these say what the service asks and in which order.
 */

jest.mock('../year-rollover/projected-rosters', () => ({ rostersOfYear: jest.fn() }));
jest.mock('../optimization/regeneration-lock', () => ({ lockYearForGrundschemaEdit: jest.fn() }));
jest.mock('../swaps/board-rules', () => ({ ...jest.requireActual('../swaps/board-rules'), readBoardFacts: jest.fn() }));
jest.mock('../optimization/other-school-holds', () => ({
  ...jest.requireActual('../optimization/other-school-holds'),
  readOtherSchoolHolds: jest.fn(),
}));

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const YEAR = '99999999-9999-4999-8999-999999999999';
const REQ = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const EMPTY_REQ = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const GROUP = '66666666-6666-4666-8666-666666666666';
const SUBJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TEACHER = '44444444-4444-4444-8444-444444444444';
const ROOM_1 = '11111111-1111-4111-8111-111111111111';
const BASIS = { kind: 'CURRENT' } as const;

const time = (value: string): Date => new Date(`1970-01-01T${value}:00.000Z`);

const POST = {
  id: REQ,
  schoolId: SCHOOL,
  academicYearId: YEAR,
  studentGroupId: GROUP,
  subjectId: SUBJECT,
  teacherId: TEACHER,
  coTeacherId: null,
  lessonsPerWeek: 2,
  minutesPerLesson: 60,
  lessonLengths: [] as number[],
  recurrence: 'ALL_WEEKS',
  blockId: null,
  startDate: null,
  endDate: null,
  shares: [] as { teacherId: string | null; lessons: number; minutes: number }[],
  academicYear: { isActive: true, predecessorId: null, gradeNumbering: 'NIOARIG' },
};

const stored = (over: Record<string, unknown> = {}) => ({
  id: 'p-1',
  requirementId: REQ,
  dayOfWeek: 2,
  startTime: time('10:00'),
  minutes: 60,
  roomId: ROOM_1,
  recurrence: 'ALL_WEEKS',
  teacherId: null as string | null,
  room: { name: 'Simhallen' },
  updatedAt: new Date('2026-11-13T08:00:00.000Z'),
  ...over,
});

const input = (over: Record<string, unknown> = {}) => ({
  dayOfWeek: 2,
  startTime: '10:00',
  minutes: 60,
  roomId: ROOM_1,
  recurrence: 'ALL_WEEKS' as const,
  ...over,
});

const keyOf = (rows: ReturnType<typeof stored>[]) => rowsKeyOf(rows);

/**
 * The post's rows as the table holds them in turn: `before` until the first write's statements have run, then `after`.
 * `rowsOf` is what a read of the post's own rows returns at that moment.
 */
function setup(world: { before?: ReturnType<typeof stored>[]; after?: ReturnType<typeof stored>[]; post?: typeof POST | null } = {}) {
  const tx: TxMock = createTxMock();
  const prisma = createPrismaMock(tx) as unknown as PrismaService;
  const masters = { findConflicts: jest.fn().mockResolvedValue([]) };
  const post = world.post === undefined ? POST : world.post;
  tx['teachingRequirement']!['findUnique']!.mockResolvedValue(post);
  let written = false;
  tx['teachingRequirementPlacement']!['findMany']!.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    const requirementId = where['requirementId'];
    if (requirementId === REQ) return written ? (world.after ?? world.before ?? []) : (world.before ?? []);
    if (requirementId === EMPTY_REQ) return [];
    if (typeof requirementId === 'object') return [];
    return world.before ?? [];
  });
  tx['masterLesson']!['findMany']!.mockResolvedValue([]);
  const named = async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ({ id, name: id }));
  tx['subject']!['findMany']!.mockImplementation(named);
  tx['studentGroup']!['findMany']!.mockImplementation(named);
  tx['room']!['findMany']!.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ({ id })));
  tx['teachingRequirementPlacement']!['deleteMany']!.mockImplementation(async () => {
    written = true;
    return { count: 0 };
  });
  tx['teachingRequirementPlacement']!['createMany']!.mockResolvedValue({ count: 0 });
  const service = new RequirementPlacementsService(prisma, masters as unknown as MasterLessonsService);
  return { tx, masters, service };
}

/** The reads of the post's own rows, in the order they were asked. */
const ownReads = (tx: TxMock) =>
  tx['teachingRequirementPlacement']!['findMany']!.mock.calls
    .map((call, index) => ({ where: (call[0] as { where: Record<string, unknown> }).where, order: tx['teachingRequirementPlacement']!['findMany']!.mock.invocationCallOrder[index]! }))
    .filter((read) => read.where['requirementId'] === REQ);

const postLockOrder = (tx: TxMock): number => {
  const index = tx['$queryRaw']!.mock.calls.findIndex((call) =>
    /FROM "TeachingRequirements" WHERE "id" = \?::uuid FOR NO KEY UPDATE/.test((call[0] as TemplateStringsArray).join('?')),
  );
  expect(index).toBeGreaterThanOrEqual(0);
  return tx['$queryRaw']!.mock.invocationCallOrder[index]!;
};

beforeEach(() => {
  (rostersOfYear as jest.Mock).mockReset().mockResolvedValue(BASIS);
  (lockYearForGrundschemaEdit as jest.Mock).mockReset().mockResolvedValue(undefined);
  (readBoardFacts as jest.Mock).mockReset().mockResolvedValue({ frames: [], sittings: new Map(), gradeRules: [], spans: new Map() });
  (readOtherSchoolHolds as jest.Mock).mockReset().mockResolvedValue({ holds: [] });
});

describe('rowsKey in the answers on a post', () => {
  const user = testUser();

  it('GET :id/placements gives the key of the rows it lists', async () => {
    const rows = [stored({ id: 'p-1' }), stored({ id: 'p-2', dayOfWeek: 4 })];
    const { service } = setup({ before: rows });
    const answer = await service.listOfPost(REQ, user);
    expect(answer.rowsKey).toBe(keyOf(rows));
    expect(answer.placements).toHaveLength(2);
  });

  it('gives a post with no rows the key every empty post has', async () => {
    const { service } = setup({ before: [] });
    expect((await service.listOfPost(REQ, user)).rowsKey).toBe(rowsKeyOf([]));
  });

  it('PUT answers with the key of the rows it wrote, so that the next write can name them', async () => {
    const written = [stored({ id: 'n-1' }), stored({ id: 'n-2', dayOfWeek: 4 })];
    const { service } = setup({ before: [], after: written });
    const answer = await service.replace(REQ, { placements: [input(), input({ dayOfWeek: 4 })] }, user);
    expect(answer.rowsKey).toBe(keyOf(written));
    expect(answer.rowsKey).not.toBe(rowsKeyOf([]));
    // Chained: the answer's key is the next write's base, and it holds when nobody wrote in between.
    const next = setup({ before: written, after: [stored({ id: 'm-1' })] });
    await expect(next.service.replace(REQ, { placements: [input()], baseKey: answer.rowsKey }, user)).resolves.toMatchObject({
      rowsKey: keyOf([stored({ id: 'm-1' })]),
    });
  });
});

describe('PUT with a baseKey', () => {
  const user = testUser({ schoolId: 'the-callers-school' });
  const read = [stored({ id: 'p-1' }), stored({ id: 'p-2', dayOfWeek: 4 })];

  it('writes when the key is the key of the rows the post has', async () => {
    const written = [stored({ id: 'n-1' })];
    const { tx, service } = setup({ before: read, after: written });
    const answer = await service.replace(REQ, { placements: [input()], baseKey: keyOf(read) }, user);
    expect(tx['teachingRequirementPlacement']!['deleteMany']).toHaveBeenCalledTimes(1);
    expect(tx['teachingRequirementPlacement']!['createMany']).toHaveBeenCalledTimes(1);
    expect(answer.placements.map((row) => row.id)).toEqual(['n-1']);
  });

  it('refuses a list somebody else has written since: 409 REQUIREMENT_PLACEMENTS_STALE, flat params, nothing written', async () => {
    const theirs = [stored({ id: 'x-1', dayOfWeek: 5 })];
    const { tx, service } = setup({ before: theirs });
    const refused = service.replace(REQ, { placements: [input()], baseKey: keyOf(read) }, user);
    await expect(refused).rejects.toBeInstanceOf(ConflictException);
    await expect(refused).rejects.toMatchObject({
      response: { code: REQUIREMENT_PLACEMENTS_STALE, params: { requirementId: REQ } },
    });
    expect(tx['teachingRequirementPlacement']!['deleteMany']).not.toHaveBeenCalled();
    expect(tx['teachingRequirementPlacement']!['createMany']).not.toHaveBeenCalled();
  });

  it('asks it of the rows as they stand with the post locked, and before the old rows go (a read before the lock lets two writers through)', async () => {
    const { tx, service } = setup({ before: read, after: [stored({ id: 'n-1' })] });
    await service.replace(REQ, { placements: [input()], baseKey: keyOf(read) }, user);
    const lock = postLockOrder(tx);
    const remove = tx['teachingRequirementPlacement']!['deleteMany']!.mock.invocationCallOrder[0]!;
    const reads = ownReads(tx);
    // The first read of the post's own rows is the key's; it comes after the lock and before the delete.
    expect(reads.length).toBe(2);
    expect(reads[0]!.order).toBeGreaterThan(lock);
    expect(reads[0]!.order).toBeLessThan(remove);
    // The second is the answer's, after the write.
    expect(reads[1]!.order).toBeGreaterThan(remove);
  });

  it('is asked after the year\'s lock and the judge: a rewrite of the year answers SCHEDULE_BUSY, not STALE', async () => {
    const { tx, service } = setup({ before: [stored({ id: 'x-1' })] });
    (lockYearForGrundschemaEdit as jest.Mock).mockRejectedValue(new ConflictException({ code: 'SCHEDULE_BUSY' }));
    await expect(service.replace(REQ, { placements: [input()], baseKey: keyOf(read) }, user)).rejects.toMatchObject({
      response: { code: 'SCHEDULE_BUSY' },
    });
    expect(ownReads(tx)).toHaveLength(0);
  });

  it('answers 404 for an unknown post before it asks anything of the key', async () => {
    const { service } = setup({ post: null });
    await expect(service.replace(REQ, { placements: [input()], baseKey: keyOf(read) }, user)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('treats a post with no rows as a key like any other: the constant, and a post that has rows since is stale', async () => {
    const empty = setup({ before: [], after: [stored({ id: 'n-1' })] });
    await expect(empty.service.replace(REQ, { placements: [input()], baseKey: rowsKeyOf([]) }, user)).resolves.toMatchObject({
      placements: [expect.objectContaining({ id: 'n-1' })],
    });
    // Two who both read the empty list and both write the first rows: the second finds the first's rows there.
    const second = setup({ before: [stored({ id: 'first-1' })] });
    await expect(second.service.replace(REQ, { placements: [input({ dayOfWeek: 3 })], baseKey: rowsKeyOf([]) }, user)).rejects.toMatchObject({
      response: { code: REQUIREMENT_PLACEMENTS_STALE },
    });
    expect(second.tx['teachingRequirementPlacement']!['deleteMany']).not.toHaveBeenCalled();
  });

  it('refuses a key that says the list was empty on a post whose rows were all removed since, and the reverse', async () => {
    const removedSince = setup({ before: [] });
    await expect(removedSince.service.replace(REQ, { placements: [input()], baseKey: keyOf(read) }, user)).rejects.toMatchObject({
      response: { code: REQUIREMENT_PLACEMENTS_STALE },
    });
  });
});

describe('PUT without a baseKey is what it was', () => {
  const user = testUser({ schoolId: 'the-callers-school' });

  it('replaces whatever the post holds, asks nothing of a key, and reads the post\'s own rows once (the answer)', async () => {
    const written = [stored({ id: 'n-1' })];
    const { tx, service } = setup({ before: [stored({ id: 'theirs' })], after: written });
    const answer = await service.replace(REQ, { placements: [input()] }, user);
    expect(tx['teachingRequirementPlacement']!['deleteMany']).toHaveBeenCalledWith({ where: { requirementId: REQ } });
    expect(ownReads(tx)).toHaveLength(1);
    expect(answer.placements.map((row) => row.id)).toEqual(['n-1']);
    expect(answer.verdicts).toEqual([{ index: 0, ok: true }]);
  });

  it('makes the same writes with and without a key that holds: same statements, same data, same answer but the extra read', async () => {
    const read = [stored({ id: 'p-1' })];
    const written = [stored({ id: 'n-1' })];
    const without = setup({ before: read, after: written });
    const withKey = setup({ before: read, after: written });
    const a = await without.service.replace(REQ, { placements: [input()] }, user);
    const b = await withKey.service.replace(REQ, { placements: [input()], baseKey: keyOf(read) }, user);
    expect(b).toEqual(a);
    for (const method of ['deleteMany', 'createMany'] as const) {
      expect(withKey.tx['teachingRequirementPlacement']![method]!.mock.calls).toEqual(without.tx['teachingRequirementPlacement']![method]!.mock.calls);
    }
    expect(ownReads(withKey.tx)).toHaveLength(ownReads(without.tx).length + 1);
  });
});

describe('rowsKey on the year\'s board', () => {
  const user = testUser();
  const YEAR_ROW = { isActive: true, predecessorId: null, gradeNumbering: 'NIOARIG' };

  const boardPost = (over: Record<string, unknown> = {}) => {
    const { academicYear: _academicYear, schoolId: _schoolId, academicYearId: _year, ...post } = POST;
    return { ...post, ...over };
  };

  it('gives every post the key of its own rows, and the one constant when it has none', async () => {
    const rows = [stored({ id: 'p-1' }), stored({ id: 'p-2', dayOfWeek: 4 })];
    const { tx, service } = setup({ before: rows });
    tx['academicYear']!['findUnique']!.mockResolvedValue(YEAR_ROW);
    tx['teachingRequirement']!['findMany']!.mockResolvedValue([boardPost(), boardPost({ id: EMPTY_REQ, subjectId: 'sub-ma' })]);
    tx['lunchSitting']!['findMany']!.mockResolvedValue([]);
    const answer = await service.boardOfYear(YEAR, user);
    const keys = new Map(answer.posts.map((post) => [post.id, post.rowsKey]));
    expect(keys.get(REQ)).toBe(keyOf(rows));
    expect(keys.get(EMPTY_REQ)).toBe(rowsKeyOf([]));
    // The key the board gives is the key the post's own read gives: a client can mix them.
    expect((await service.listOfPost(REQ, user)).rowsKey).toBe(keys.get(REQ));
  });
});

describe('the dialog and the week read what Generera keeps the same way (review of #315, LÅG-6)', () => {
  const user = testUser();
  const YEAR_ROW = { isActive: true, predecessorId: null, gradeNumbering: 'NIOARIG' };
  const OTHER_GROUP = 'g-7b';
  const OTHER_SUBJECT = 'sub-ma';
  const CO_TEACHER = '55555555-5555-4555-8555-555555555555';

  /** A lesson Generera keeps, with what the week selects of it and what the judge selects of it. */
  const keptLesson = (over: Record<string, unknown> = {}) => ({
    id: 'k-1',
    dayOfWeek: 2,
    startTime: time('13:00'),
    endTime: time('14:00'),
    studentGroupId: GROUP,
    subjectId: SUBJECT,
    teacherId: TEACHER,
    coTeacherId: null,
    roomId: ROOM_1,
    recurrence: 'ALL_WEEKS',
    startDate: null,
    endDate: null,
    isLocked: true,
    isGenerated: false,
    subject: { name: SUBJECT },
    studentGroup: { name: GROUP },
    extraGroups: [],
    participants: [],
    ...over,
  });

  const boardPost = (over: Record<string, unknown> = {}) => {
    const { academicYear: _academicYear, schoolId: _schoolId, academicYearId: _year, ...post } = POST;
    return { ...post, ...over };
  };

  /** The week and the dialog's read of one post, with the lessons the table holds (whatever the where says: the filter is the code's). */
  function world(kept: Array<Record<string, unknown>>, post: Record<string, unknown> = {}, rows = [stored({ id: 'p-1' })]) {
    const made = setup({ before: rows, post: { ...POST, ...post } as never });
    made.tx['academicYear']!['findUnique']!.mockResolvedValue(YEAR_ROW);
    made.tx['teachingRequirement']!['findMany']!.mockResolvedValue([boardPost(post)]);
    made.tx['lunchSitting']!['findMany']!.mockResolvedValue([]);
    made.tx['masterLesson']!['findMany']!.mockResolvedValue(kept);
    return made;
  }

  /** What judgePlacements was handed by the week and by the dialog's read of the same post. */
  async function askedByBoth(kept: Array<Record<string, unknown>>, post: Record<string, unknown> = {}) {
    const spy = jest.spyOn(placementJudge, 'judgePlacements');
    try {
      const made = world(kept, post);
      await made.service.boardOfYear(YEAR, user);
      await made.service.listOfPost(REQ, user);
      const [week, dialog] = spy.mock.calls.map(([, , asked]) => asked);
      return { ...made, week: week!, dialog: dialog! };
    } finally {
      spy.mockRestore();
    }
  }

  it('asks the table for the lessons Generera keeps of the post\'s class and subject, every arm of it, on a read and on a write', async () => {
    const made = world([]);
    await made.service.listOfPost(REQ, user);
    await made.service.replace(REQ, { placements: [input()] }, user);
    const reads = made.tx['masterLesson']!['findMany']!.mock.calls.map((call) => (call[0] as { where: Record<string, unknown> }).where);
    const ofThePost = reads.filter((where) => where['studentGroupId'] !== undefined);
    expect(ofThePost).toHaveLength(2);
    for (const where of ofThePost) {
      // A hand-built copy that kept two of the four arms, or dropped the subject, would be another week than Generera's.
      expect(where).toEqual({ ...keptMastersWhere(YEAR), studentGroupId: GROUP, subjectId: SUBJECT });
    }
  });

  it('counts a kept lesson of another class or another subject as nothing the post has, in the week and in the dialog alike', async () => {
    const lessons = [
      keptLesson({ id: 'k-own' }),
      keptLesson({ id: 'k-class', studentGroupId: OTHER_GROUP }),
      keptLesson({ id: 'k-subject', subjectId: OTHER_SUBJECT }),
    ];
    const { week, dialog } = await askedByBoth(lessons);
    expect(week.demand!.get(REQ)!.lockedMinutes).toEqual([60]);
    expect(dialog.demand!.get(REQ)!.lockedMinutes).toEqual([60]);
  });

  it('counts a kept lesson with a second class, named pupils, or a medlärare as the lock it is, as the week does', async () => {
    const lessons = [
      keptLesson({ id: 'k-extra', isLocked: false, isGenerated: true, extraGroups: [{ studentGroupId: OTHER_GROUP }] }),
      keptLesson({ id: 'k-pupils', isLocked: false, isGenerated: true, participants: [{ studentId: 'pupil-1' }] }),
    ];
    const { week, dialog } = await askedByBoth(lessons);
    // The two reads select different extras of the post; what the demand counts with is the locks and the lessons the rows place.
    const counted = (asked: placementJudge.JudgePlacementsInput) => {
      const { post: _post, ...rest } = asked.demand!.get(REQ)!;
      return rest;
    };
    expect(counted(week)).toEqual(counted(dialog));
    expect(counted(dialog)).toMatchObject({ lockedMinutes: [60, 60], placed: [60] });
  });

  it('judges the week\'s rows with the post\'s medlärare, as the dialog does (a row that left it out would clash with the wrong lessons)', async () => {
    const { week, dialog } = await askedByBoth([], { coTeacherId: CO_TEACHER });
    expect(week.rows).toHaveLength(1);
    expect(week.rows[0]!.coTeacherId).toBe(CO_TEACHER);
    expect(dialog.rows[0]!.coTeacherId).toBe(CO_TEACHER);
    expect(week.rows.map((row) => ({ ...row, id: null }))).toEqual(dialog.rows);
  });
});
