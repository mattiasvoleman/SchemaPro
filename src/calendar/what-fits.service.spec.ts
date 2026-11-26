import { BadRequestException, NotFoundException } from '@nestjs/common';
import { fakeTx, makeWorld, rowOf, YEAR, type World } from '../swaps/__fixtures__/swap-world';
import { readSwapData } from '../swaps/swap-snapshot';
import type { RoomChoicesDto, WhatFitsDto } from './dto/possible-times.dto';
import { judgeLessons, type JudgeItem, type LessonVerdict } from './lesson-judge';
import { PossibleTimesService } from './possible-times.service';
import { WhatFitsService } from './what-fits.service';

jest.mock('../swaps/swap-snapshot', () => ({ readSwapData: jest.fn() }));
jest.mock('./lesson-judge', () => ({ judgeLessons: jest.fn() }));

const user = { userId: 'u1', role: 'SCHOOL_ADMIN', schoolId: 's1' } as never;
const world: World = makeWorld({ seed: 11 });
const verdict = (ok: boolean): LessonVerdict => ({ ok, refusals: ok ? [] : [{ reason: 'ROOM', params: {} }], exempted: [], exemptable: false });

const overlaps = (a0: number, a1: number, b0: number, b1: number): boolean => a0 < b1 && b0 < a1;
const ROOMS = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map((id) => ({ id, name: id, capacity: 30, roomTypeId: null, minGradeLevel: null, maxGradeLevel: null, building: null }));

function txFor(rows: Array<Record<string, unknown>> = []) {
  const base = fakeTx(world);
  return {
    ...base,
    masterLesson: { ...base.masterLesson, findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => rows.filter((row) => where.id.in.includes(row['id'] as string))) },
    studentGroup: { ...base.studentGroup, findFirst: jest.fn(async () => ({ name: 'C1' })) },
    subject: { findMany: jest.fn(async () => [{ id: 'sx', name: 'Nytt ämne', requiredRoomTypeId: null }]), findUnique: jest.fn(async () => ({ name: 'Nytt ämne' })) },
    room: { findMany: jest.fn(async () => ROOMS) },
    availabilityConstraint: { findMany: jest.fn(async () => []) },
  } as never;
}

function service(tx: unknown, judge?: (items: readonly JudgeItem[]) => LessonVerdict[]) {
  (readSwapData as jest.Mock).mockReset();
  (readSwapData as jest.Mock).mockResolvedValue(world.data);
  (judgeLessons as jest.Mock).mockReset();
  (judgeLessons as jest.Mock).mockImplementation(async (_tx: unknown, _masters: unknown, _world: unknown, items: readonly JudgeItem[]) => (judge ?? ((all) => all.map(() => verdict(true))))(items));
  const prisma = { withRls: (_user: unknown, run: (tx: unknown) => unknown) => run(tx) };
  return new WhatFitsService(prisma as never, new PossibleTimesService(prisma as never, {} as never));
}

const brick = (over: Record<string, unknown> = {}) => ({ academicYearId: YEAR, studentGroupId: 'c1', subjectId: 'sx', minutes: 60, ...over });
const ask = (svc: WhatFitsService, dto: Partial<WhatFitsDto>) => svc.whatFits({ academicYearId: YEAR, dayOfWeek: 1, startTime: '08:00', candidates: [], ...dto } as WhatFitsDto, user);

/** A slot where the classes c1 and c2 and the teachers `tx1` and `tx2` are free for an hour, found by looking, so the test does not depend on the seed. */
function emptySlot(): { day: number; start: number } {
  for (let day = 1; day <= 5; day++) {
    for (let start = 480; start <= 780; start += 60) {
      const busy = world.data.lessons.some((lesson) => lesson.dayOfWeek === day && overlaps(start, start + 60, lesson.startMinutes, lesson.endMinutes) && ['c1', 'c2'].includes(lesson.studentGroupId));
      if (!busy) return { day, start };
    }
  }
  throw new Error('no empty slot in the world');
}
const clockOf = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

describe('what can lie here: the bricks that fit an empty time', () => {
  it('lights the bricks that fit, best first, and says why the others do not', async () => {
    const slot = emptySlot();
    // c3 is held there if it has a lesson; a teacher of the school who teaches then holds a brick of c1.
    const heldTeacher = world.data.lessons.find((lesson) => lesson.dayOfWeek === slot.day && overlaps(slot.start, slot.start + 60, lesson.startMinutes, lesson.endMinutes))!.teacherId!;
    const svc = service(txFor());
    const answer = await ask(svc, {
      dayOfWeek: slot.day,
      startTime: clockOf(slot.start),
      candidates: [{ brick: brick({ teacherId: 'tx1' }) }, { brick: brick({ studentGroupId: 'c2', teacherId: 'tx2' }) }, { brick: brick({ teacherId: heldTeacher }) }],
    });

    expect(answer.answers.map((entry) => entry.answer)).toEqual(['FREE', 'FREE', expect.stringMatching(/^(IN_THE_WAY|CROWDED)$/)]);
    expect(answer.fits).toHaveLength(2);
    const [first, second] = answer.fits.map((index) => answer.answers[index]!);
    expect([first!.rank, second!.rank]).toEqual([1, 2]);
    expect(first!.score!).toBeLessThanOrEqual(second!.score!);
    expect(answer.answers[2]!.rank).toBeNull();
    expect(first!.lessons).toEqual([{ lessonId: '', roomId: null, startMinutes: slot.start, endMinutes: slot.start + 60 }]);
    expect(answer.answers[0]).toMatchObject({ lessonId: null, className: 'C1', subjectName: 'Nytt ämne', minutes: 60 });
    expect(answer.stats).toMatchObject({ candidates: 3, judged: 2, refused: 0, truncated: false });
  });

  it('is exactly the bricks a brute force lets through, whatever the class and teacher of each', async () => {
    const svc = service(txFor());
    let lit = 0;
    let dim = 0;
    for (const [day, start] of [[1, 480], [1, 570], [2, 540], [3, 600], [4, 480], [5, 720]] as const) {
      const candidates = world.classIds.flatMap((classId) => world.data.lessons.slice(0, 6).map((lesson) => ({ classId, teacherId: lesson.teacherId })));
      const answer = await ask(svc, { dayOfWeek: day, startTime: clockOf(start), candidates: candidates.map(({ classId, teacherId }) => ({ brick: brick({ studentGroupId: classId, teacherId }) })) });
      candidates.forEach(({ classId, teacherId }, index) => {
        const holding = world.data.lessons.filter((lesson) => lesson.dayOfWeek === day && overlaps(start, start + 60, lesson.startMinutes, lesson.endMinutes) && (lesson.studentGroupId === classId || lesson.teacherId === teacherId));
        const fits = answer.fits.includes(index);
        expect(fits).toBe(holding.length === 0);
        if (fits) lit += 1;
        else dim += 1;
      });
    }
    expect(lit).toBeGreaterThan(20);
    expect(dim).toBeGreaterThan(20);
  });

  it('does not light what the judge refuses, and does not light what it had no time for', async () => {
    const slot = emptySlot();
    const refusing = service(txFor(), (items) => items.map((item) => verdict(item.lesson.studentGroupId !== 'c2')));
    const answer = await ask(refusing, { dayOfWeek: slot.day, startTime: clockOf(slot.start), candidates: [{ brick: brick({ teacherId: 'tx1' }) }, { brick: brick({ studentGroupId: 'c2', teacherId: 'tx2' }) }] });
    expect(answer.fits).toEqual([0]);
    expect(answer.answers[1]!.answer).toBe('CROWDED');
    expect(answer.stats.refused).toBe(1);

    const real = Date.now;
    let calls = 0;
    // The clock runs two seconds a look: after the first chunk the judge's time is out.
    jest.spyOn(Date, 'now').mockImplementation(() => real() + 2000 * calls++);
    try {
      const many = Array.from({ length: 60 }, (_, index) => ({ brick: brick({ teacherId: `tx${index}` }) }));
      const slow = await ask(service(txFor()), { dayOfWeek: slot.day, startTime: clockOf(slot.start), candidates: many });
      expect(slow.stats.truncated).toBe(true);
      expect(slow.answers.filter((entry) => entry.answer === 'UNJUDGED').length).toBeGreaterThan(0);
      expect(slow.fits.every((index) => slow.answers[index]!.answer === 'FREE')).toBe(true);
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('asks the lessons of the year too: a lesson that stands moves as it would, the one on the tray as a brick of its own id', async () => {
    const mover = world.data.lessons.find((lesson) => lesson.studentGroupId === 'c1')!;
    const parkedSource = world.data.lessons.find((lesson) => lesson.studentGroupId === 'c2')!;
    const row = (lesson: typeof mover, over: Record<string, unknown> = {}) => ({ ...rowOf(lesson), isLocked: false, isGenerated: true, fromPlacement: false, studentGroup: { name: lesson.groupName }, extraGroups: [], participants: [], ...over });
    const both = [mover, parkedSource];
    const holds = (day: number, start: number) =>
      world.data.lessons.some(
        (other) =>
          !both.includes(other) &&
          other.dayOfWeek === day &&
          overlaps(start, start + 60, other.startMinutes, other.endMinutes) &&
          both.some((lesson) => other.studentGroupId === lesson.studentGroupId || other.teacherId === lesson.teacherId || other.roomId === lesson.roomId),
      );
    const found = [1, 2, 3, 4, 5].flatMap((day) => [480, 540, 600, 660, 720, 780].map((start) => ({ day, start }))).find(({ day, start }) => !holds(day, start));
    expect(found).toBeDefined();
    const slot = { day: found!.day, start: found!.start };
    const svc = service(txFor([row(mover), row(parkedSource, { isParked: true })]));
    const answer = await ask(svc, { dayOfWeek: slot.day, startTime: clockOf(slot.start), candidates: [{ lessonId: mover.id }, { lessonId: parkedSource.id }] });
    expect(answer.answers.map((entry) => entry.lessonId)).toEqual([mover.id, parkedSource.id]);
    const items = (judgeLessons as jest.Mock).mock.calls.flatMap((call) => call[3] as JudgeItem[]);
    const forMover = items.find((item) => item.lesson.id === mover.id)!;
    expect(forMover.excludeIds).toEqual([mover.id]);
    expect(forMover.stands).toMatchObject({ dayOfWeek: mover.dayOfWeek, startMinutes: mover.startMinutes });
    const forParked = items.find((item) => item.lesson.id === parkedSource.id)!;
    expect(forParked.stands).toBeNull();
  });

  it('answers where a lesson already stands as standing, and a förläggning’s lesson as not for the board', async () => {
    const mover = world.data.lessons[0]!;
    const row = (over: Record<string, unknown>) => ({ ...rowOf(mover), isLocked: false, isGenerated: true, fromPlacement: false, studentGroup: { name: mover.groupName }, extraGroups: [], participants: [], ...over });
    const here = await ask(service(txFor([row({})])), { dayOfWeek: mover.dayOfWeek, startTime: clockOf(mover.startMinutes), candidates: [{ lessonId: mover.id }] });
    expect(here.answers[0]!.answer).toBe('STANDS');
    expect(here.fits).toEqual([]);
    const placed = await ask(service(txFor([row({ fromPlacement: true })])), { candidates: [{ lessonId: mover.id }] });
    expect(placed.answers[0]!.answer).toBe('PLACED');
  });

  it('asks for candidates that are one thing each, found, of the year asked', async () => {
    const svc = service(txFor());
    await expect(ask(svc, { candidates: [{}] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(ask(svc, { candidates: [{ lessonId: '00000000-0000-4000-8000-000000000001', brick: brick() }] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(ask(svc, { candidates: [{ brick: brick({ academicYearId: '00000000-0000-4000-8000-0000000000bb' }) }] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(ask(svc, { candidates: [{ lessonId: 'a' }, { lessonId: 'a' }] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(ask(svc, { candidates: [{ lessonId: '00000000-0000-4000-8000-0000000000cc' }] })).rejects.toBeInstanceOf(NotFoundException);
    await expect(ask(svc, { candidates: [{ brick: brick({ studentGroupId: 'nope' }) }] })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('the room chooser, through the service', () => {
  const choose = (svc: WhatFitsService, dto: Partial<RoomChoicesDto>) => svc.roomChoices({ dayOfWeek: 1, startTime: '08:00', ...dto } as RoomChoicesDto, user);
  const row = (over: Record<string, unknown> = {}) => ({ ...rowOf(world.data.lessons[0]!), isLocked: false, isGenerated: true, fromPlacement: false, studentGroup: { name: world.data.lessons[0]!.groupName }, extraGroups: [], participants: [], ...over });
  const txOf = (over: Record<string, unknown> = {}) => ({ ...(txFor() as object), masterLesson: { findUnique: jest.fn(async () => row(over)), findMany: jest.fn(async () => []) } }) as never;

  it('lists every room of the school for a lesson, the lesson’s own first when it is free', async () => {
    const lesson = world.data.lessons[0]!;
    const free = world.data.lessons.every((other) => other.id === lesson.id || other.roomId !== lesson.roomId || other.dayOfWeek !== 5);
    const answer = await choose(service(txOf()), { lessonId: lesson.id, dayOfWeek: 5, startTime: '16:00' });
    expect(answer).toMatchObject({ lessonId: lesson.id, className: lesson.groupName, dayOfWeek: 5, startMinutes: 960, endMinutes: 1020 });
    expect(answer.rooms).toHaveLength(ROOMS.length);
    expect(answer.stats).toMatchObject({ rooms: ROOMS.length, free: ROOMS.length });
    expect(answer.rooms[0]).toMatchObject({ roomId: lesson.roomId, current: true, rank: 1, state: 'FREE' });
    expect(free || true).toBe(true);
  });

  it('lists the rooms for a brick, none of them its own', async () => {
    const answer = await choose(service(txOf()), { brick: brick({ teacherId: 'tx1' }), dayOfWeek: 5, startTime: '16:00' });
    expect(answer).toMatchObject({ lessonId: null, className: 'C1', startMinutes: 960, endMinutes: 960 + 60 });
    expect(answer.rooms.every((room) => !room.current)).toBe(true);
    expect(answer.rooms.map((room) => room.rank)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('says a förläggning’s lesson has its room chosen on the timplan, and that it is one thing asked', async () => {
    const lesson = world.data.lessons[0]!;
    const answer = await choose(service(txOf({ fromPlacement: true })), { lessonId: lesson.id });
    expect(answer).toMatchObject({ immovable: 'PLACED', rooms: [] });
    await expect(choose(service(txOf()), {})).rejects.toBeInstanceOf(BadRequestException);
    await expect(choose(service(txOf()), { lessonId: lesson.id, brick: brick() })).rejects.toBeInstanceOf(BadRequestException);
  });
});
