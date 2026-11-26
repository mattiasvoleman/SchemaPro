import { HttpException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import {
  assertStartable,
  nothingToStartFrom,
  readStartSource,
  START_NO_PREVIOUS_YEAR,
  START_NOTHING_TO_START_FROM,
  START_VERSION_NOT_FOUND,
  versionLessonsOf,
} from './start-sources';

/*
 * Where a schedule to start from is read (M9): this year's draft, a saved version of this year, and last year's under the
 * successor of each class, with the dates of a post that ran in part of the year moved as the rollover moved the post's.
 */

const refusalOf = async (run: () => Promise<unknown>): Promise<HttpException> => {
  const thrown = await run().then(
    () => null,
    (error: unknown) => error,
  );
  expect(thrown).toBeInstanceOf(HttpException);
  return thrown as HttpException;
};

const bodyOf = (error: HttpException) => error.getResponse() as { code: string; params: Record<string, string | number> };

const lessonRow = (over: Record<string, unknown> = {}) => ({
  studentGroupId: 'g-7a',
  subjectId: 's-math',
  dayOfWeek: 1,
  startTime: new Date('1970-01-01T08:00:00Z'),
  endTime: new Date('1970-01-01T08:50:00Z'),
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  _count: { extraGroups: 0, participants: 0 },
  ...over,
});

describe('versionLessonsOf', () => {
  const stored = (over: Record<string, unknown> = {}) => ({
    studentGroupId: 'g-1',
    subjectId: 's-1',
    dayOfWeek: 2,
    startTime: '09:00',
    endTime: '09:50',
    isLocked: false,
    isGenerated: true,
    ...over,
  });

  it('reads the machine’s lessons, with the weeks they ran', () => {
    expect(versionLessonsOf([stored({ recurrence: 'ODD_WEEKS', startDate: '2026-08-17', endDate: null })])).toEqual([
      {
        studentGroupId: 'g-1',
        subjectId: 's-1',
        dayOfWeek: 2,
        startTime: '09:00',
        endTime: '09:50',
        recurrence: 'ODD_WEEKS',
        startDate: '2026-08-17',
        endDate: null,
      },
    ]);
  });

  it.each([
    ['a locked lesson, which is a fact and is in the week as one', { isLocked: true }],
    ['a lesson placed by hand', { isGenerated: false }],
    ['a parked lesson, which occupies nothing', { isParked: true }],
    ['a lesson written from a förläggning, which is written again from it', { fromPlacement: true }],
    ['a lesson of several classes, which belongs to no one post and which Generera keeps as it stands', { extraGroupIds: ['g-2'] }],
    ['a lesson of named pupils, for the same reason', { studentIds: ['u-1'] }],
  ])('leaves out %s', (_what, over) => {
    expect(versionLessonsOf([stored(over)])).toEqual([]);
  });

  it('keeps a lesson whose lists of classes and pupils are there and empty, as a snapshot writes them for every ordinary lesson', () => {
    expect(versionLessonsOf([stored({ extraGroupIds: [], studentIds: [] })])).toHaveLength(1);
  });

  it('reads a snapshot from before isGenerated as the machine’s, the side to be wrong on for a start', () => {
    const old = stored();
    delete (old as Record<string, unknown>)['isGenerated'];
    expect(versionLessonsOf([old])).toHaveLength(1);
  });

  it.each([
    ['no group', { studentGroupId: undefined }],
    ['no subject', { subjectId: 7 }],
    ['a weekday that is not a number', { dayOfWeek: 'Mon' }],
    ['a start that is not a clock', { startTime: '9' }],
    ['an end that is not a clock', { endTime: null }],
  ])('leaves out a row with %s, and does not guess', (_what, over) => {
    expect(versionLessonsOf([stored(over)])).toEqual([]);
  });

  it('is empty for a column that is not a list', () => {
    expect(versionLessonsOf(null)).toEqual([]);
    expect(versionLessonsOf({ 0: stored() })).toEqual([]);
    expect(versionLessonsOf([null, 'x', 4])).toEqual([]);
  });
});

describe('assertStartable', () => {
  it('lets CURRENT through with nothing read', async () => {
    const tx = { scheduleVersion: { findFirst: jest.fn() }, academicYear: { findUnique: jest.fn() } };

    await expect(assertStartable(tx as unknown as PrismaClient, 'y', { source: 'CURRENT' })).resolves.toBeUndefined();
    expect(tx.scheduleVersion.findFirst).not.toHaveBeenCalled();
    expect(tx.academicYear.findUnique).not.toHaveBeenCalled();
  });

  it('refuses a version that is not one of this year’s with 404 START_VERSION_NOT_FOUND, asking for it BY the year', async () => {
    const tx = { scheduleVersion: { findFirst: jest.fn().mockResolvedValue(null) } };

    const error = await refusalOf(() => assertStartable(tx as unknown as PrismaClient, 'y-1', { source: 'VERSION', versionId: 'v-1' }));

    expect(error.getStatus()).toBe(404);
    expect(bodyOf(error).code).toBe(START_VERSION_NOT_FOUND);
    expect(tx.scheduleVersion.findFirst).toHaveBeenCalledWith({ where: { id: 'v-1', academicYearId: 'y-1' }, select: { id: true } });
  });

  it('refuses VERSION with no version named, without asking the database', async () => {
    const tx = { scheduleVersion: { findFirst: jest.fn() } };

    const error = await refusalOf(() => assertStartable(tx as unknown as PrismaClient, 'y', { source: 'VERSION' }));

    expect(bodyOf(error).code).toBe(START_VERSION_NOT_FOUND);
    expect(tx.scheduleVersion.findFirst).not.toHaveBeenCalled();
  });

  it('accepts a version of the year', async () => {
    const tx = { scheduleVersion: { findFirst: jest.fn().mockResolvedValue({ id: 'v-1' }) } };

    await expect(assertStartable(tx as unknown as PrismaClient, 'y', { source: 'VERSION', versionId: 'v-1' })).resolves.toBeUndefined();
  });

  it('refuses PREVIOUS_YEAR for a year that was not rolled over from another, 409 START_NO_PREVIOUS_YEAR', async () => {
    const tx = { academicYear: { findUnique: jest.fn().mockResolvedValue({ predecessorId: null }) } };

    const error = await refusalOf(() => assertStartable(tx as unknown as PrismaClient, 'y', { source: 'PREVIOUS_YEAR' }));

    expect(error.getStatus()).toBe(409);
    expect(bodyOf(error).code).toBe(START_NO_PREVIOUS_YEAR);
  });
});

describe('readStartSource', () => {
  const draft = (over: Record<string, unknown> = {}) => ({
    subjectId: 's-math',
    studentGroupId: 'g-8a',
    teacherId: 't',
    coTeacherId: null,
    roomId: null,
    dayOfWeek: 3,
    startTime: '10:00',
    endTime: '10:50',
    recurrence: 'ALL_WEEKS' as const,
    startDate: null,
    endDate: null,
    isParked: false,
    ...over,
  });

  it('CURRENT is the draft the fetch read, minus the parked, and reads nothing', async () => {
    const tx = {};

    const read = await readStartSource(tx as unknown as PrismaClient, 'y', { source: 'CURRENT' }, [draft(), draft({ isParked: true, dayOfWeek: 4 })]);

    expect(read.lessons.map((lesson) => lesson.dayOfWeek)).toEqual([3]);
    expect(read.lessons[0]).toMatchObject({ studentGroupId: 'g-8a', startTime: '10:00', endTime: '10:50', recurrence: 'ALL_WEEKS' });
    expect(read.versionName).toBeNull();
  });

  it('VERSION reads the version of THIS year, names it, and gives its machine lessons', async () => {
    const findFirst = jest.fn().mockResolvedValue({
      name: 'Före Generera 12 mars',
      lessons: [
        { studentGroupId: 'g', subjectId: 's', dayOfWeek: 1, startTime: '08:00', endTime: '08:50', isLocked: false, isGenerated: true },
        { studentGroupId: 'g', subjectId: 's', dayOfWeek: 2, startTime: '08:00', endTime: '08:50', isLocked: true, isGenerated: true },
      ],
    });
    const tx = { scheduleVersion: { findFirst } };

    const read = await readStartSource(tx as unknown as PrismaClient, 'y-1', { source: 'VERSION', versionId: 'v-9' }, []);

    expect(findFirst).toHaveBeenCalledWith({ where: { id: 'v-9', academicYearId: 'y-1' }, select: { name: true, lessons: true } });
    expect(read.versionName).toBe('Före Generera 12 mars');
    expect(read.lessons.map((lesson) => lesson.dayOfWeek)).toEqual([1]);
  });

  it('VERSION names the version by characters: a name cut inside an emoji is not left with half of it', async () => {
    const findFirst = jest.fn().mockResolvedValue({ name: `${'a'.repeat(119)}😀${'b'.repeat(20)}`, lessons: [] });
    const tx = { scheduleVersion: { findFirst } };

    const read = await readStartSource(tx as unknown as PrismaClient, 'y-1', { source: 'VERSION', versionId: 'v-9' }, []);

    expect(Array.from(read.versionName!)).toHaveLength(120);
    expect(JSON.stringify({ n: read.versionName })).not.toMatch(/\\ud[89ab][0-9a-f]{2}"/i);
  });

  describe('PREVIOUS_YEAR', () => {
    // 2026/27 into 2027/28: the starts are 364 days apart, a whole number of weeks.
    const years = {
      this: { startDate: new Date('2027-08-16'), endDate: new Date('2028-06-09'), predecessorId: 'y-prev' },
      prev: { startDate: new Date('2026-08-17'), endDate: new Date('2027-06-10') },
    };

    const world = (lessons: unknown[], groups: { id: string; predecessorId: string }[]) => ({
      academicYear: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }): Promise<unknown> => (where.id === 'y-prev' ? years.prev : years.this)),
      },
      studentGroup: { findMany: jest.fn().mockResolvedValue(groups) },
      masterLesson: { findMany: jest.fn().mockResolvedValue(lessons) },
    });

    it('gives a class’s lessons under its successor, and the school’s hours as they were', async () => {
      const tx = world([lessonRow({ studentGroupId: 'g-7a' })], [{ id: 'g-8a', predecessorId: 'g-7a' }]);

      const read = await readStartSource(tx as unknown as PrismaClient, 'y-this', { source: 'PREVIOUS_YEAR' }, []);

      expect(read.lessons).toEqual([
        {
          studentGroupId: 'g-8a',
          subjectId: 's-math',
          dayOfWeek: 1,
          startTime: '08:00',
          endTime: '08:50',
          recurrence: 'ALL_WEEKS',
          startDate: null,
          endDate: null,
        },
      ]);
      expect(read.already).toEqual({ offered: 0, dropped: {} });
    });

    it('asks for last year’s lessons only: the year this one was rolled over from, not parked', async () => {
      const tx = world([], []);

      await readStartSource(tx as unknown as PrismaClient, 'y-this', { source: 'PREVIOUS_YEAR' }, []);

      expect(tx.masterLesson.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { academicYearId: 'y-prev', isParked: false } }),
      );
      expect(tx.studentGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { academicYearId: 'y-this', predecessorId: { not: null } } }),
      );
    });

    it('counts, and does not give, a class that has no successor (it left, or the new class continues nothing)', async () => {
      const tx = world([lessonRow({ studentGroupId: 'g-9a' }), lessonRow({ studentGroupId: 'g-7a' })], [{ id: 'g-8a', predecessorId: 'g-7a' }]);

      const read = await readStartSource(tx as unknown as PrismaClient, 'y-this', { source: 'PREVIOUS_YEAR' }, []);

      expect(read.lessons).toHaveLength(1);
      expect(read.already).toEqual({ offered: 1, dropped: { NO_SUCCESSOR: 1 } });
    });

    it('does not give a lesson of several classes or of named pupils, which belongs to no post', async () => {
      const tx = world(
        [lessonRow({ _count: { extraGroups: 1, participants: 0 } }), lessonRow({ _count: { extraGroups: 0, participants: 3 } })],
        [{ id: 'g-8a', predecessorId: 'g-7a' }],
      );

      const read = await readStartSource(tx as unknown as PrismaClient, 'y-this', { source: 'PREVIOUS_YEAR' }, []);

      expect(read.lessons).toEqual([]);
      expect(read.already).toEqual({ offered: 2, dropped: { NOT_STARTABLE: 2 } });
    });

    it('moves the dates of a lesson that ran in part of the year as the rollover moved its post: 364 days, a whole number of weeks', async () => {
      const tx = world(
        [lessonRow({ startDate: new Date('2026-08-17'), endDate: new Date('2026-12-18'), recurrence: 'ODD_WEEKS' })],
        [{ id: 'g-8a', predecessorId: 'g-7a' }],
      );

      const read = await readStartSource(tx as unknown as PrismaClient, 'y-this', { source: 'PREVIOUS_YEAR' }, []);

      // The year's own first day is anchored to the new year's first day; the shifted end is a Friday of the new autumn.
      expect(read.lessons[0]).toMatchObject({ recurrence: 'ODD_WEEKS', startDate: '2027-08-16', endDate: '2027-12-17' });
    });

    it('does not give a lesson whose period no longer fits the new year: OTHER_WEEKS', async () => {
      const tx = world(
        [lessonRow({ startDate: new Date('2027-06-01'), endDate: new Date('2027-06-10') })],
        [{ id: 'g-8a', predecessorId: 'g-7a' }],
      );
      // The new year ends before the shifted period begins.
      tx.academicYear.findUnique.mockImplementation(async ({ where }: { where: { id: string } }): Promise<unknown> =>
        where.id === 'y-prev' ? years.prev : { ...years.this, endDate: new Date('2027-12-20') },
      );

      const read = await readStartSource(tx as unknown as PrismaClient, 'y-this', { source: 'PREVIOUS_YEAR' }, []);

      expect(read.lessons).toEqual([]);
      expect(read.already.dropped).toEqual({ OTHER_WEEKS: 1 });
    });

    it('refuses a year with no year before it', async () => {
      const tx = world([], []);
      tx.academicYear.findUnique.mockResolvedValue({ ...years.this, predecessorId: null });

      const error = await refusalOf(() => readStartSource(tx as unknown as PrismaClient, 'y-this', { source: 'PREVIOUS_YEAR' }, []));

      expect(bodyOf(error).code).toBe(START_NO_PREVIOUS_YEAR);
    });
  });
});

describe('nothingToStartFrom', () => {
  it('is a 409 with flat params that say why: how many lessons the schedule held and how many each reason left out', () => {
    const error = nothingToStartFrom('PREVIOUS_YEAR', { offered: 40, dropped: { NO_SUCCESSOR: 30, NO_POST: 10 } });

    expect(error.getStatus()).toBe(409);
    expect(bodyOf(error)).toMatchObject({
      code: START_NOTHING_TO_START_FROM,
      params: { source: 'PREVIOUS_YEAR', offered: 40, noSuccessor: 30, noPost: 10 },
    });
    // The exception filter forwards flat params only: numbers and short strings.
    for (const value of Object.values(bodyOf(error).params)) expect(['number', 'string']).toContain(typeof value);
  });

  it('says nothing for a reason that left out none', () => {
    const { params } = bodyOf(nothingToStartFrom('CURRENT', { offered: 0, dropped: { AMBIGUOUS: 0 } }));

    expect(params).toEqual({ source: 'CURRENT', offered: 0 });
  });
});
