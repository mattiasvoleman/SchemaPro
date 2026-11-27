import { BadRequestException, NotFoundException } from '@nestjs/common';
import { fakeTx, makeWorld, rowOf, YEAR, type World } from '../swaps/__fixtures__/swap-world';
import { readSwapData, type SwapData } from '../swaps/swap-snapshot';
import type { PossibleTimesDto } from './dto/possible-times.dto';
import { judgeLessons, type JudgeItem, type LessonRefusal, type LessonVerdict } from './lesson-judge';
import { PossibleTimesService } from './possible-times.service';

jest.mock('../swaps/swap-snapshot', () => ({ readSwapData: jest.fn() }));
jest.mock('./lesson-judge', () => ({ judgeLessons: jest.fn() }));

const user = { userId: 'u1', role: 'SCHOOL_ADMIN', schoolId: 's1' } as never;
const world: World = makeWorld({ seed: 11 });
const mover = world.data.lessons.find((lesson) => lesson.dayOfWeek === 1 && lesson.startMinutes === 480) ?? world.data.lessons[0]!;

type Fake = ReturnType<typeof fakeTx>;

/** A verdict as the judge gives it: the exemption fields (E1b) are not what these tests are about, and never set. */
const verdict = (ok: boolean, refusals: LessonRefusal[] = []): LessonVerdict => ({ ok, refusals, exempted: [], exemptable: false });

function txFor(over: { lesson?: Record<string, unknown> | null; wishes?: unknown[]; rooms?: unknown[] } = {}): Fake & Record<string, unknown> {
  const base = fakeTx(world);
  const row = { ...rowOf(mover), isLocked: false, isGenerated: true, fromPlacement: false, studentGroup: { name: mover.groupName }, ...(over.lesson ?? {}) };
  return {
    ...base,
    masterLesson: {
      ...base.masterLesson,
      findUnique: jest.fn(async () => (over.lesson === null ? null : { ...row, extraGroups: [], participants: [] })),
    },
    subject: {
      findUnique: jest.fn(async () => ({ name: 'Nytt ämne' })),
      findMany: jest.fn(async () => []),
    },
    studentGroup: {
      ...base.studentGroup,
      findFirst: jest.fn(async () => ({ name: 'C1' })),
    },
    room: { findMany: jest.fn(async () => over.rooms ?? ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map((id) => ({ id, name: id, capacity: 30, roomTypeId: null, minGradeLevel: null, maxGradeLevel: null, building: null }))) },
    availabilityConstraint: { findMany: jest.fn(async () => over.wishes ?? []) },
  } as never;
}

function service(tx: unknown, judge?: (items: readonly JudgeItem[]) => LessonVerdict[], data: SwapData = world.data) {
  (readSwapData as jest.Mock).mockReset();
  (readSwapData as jest.Mock).mockResolvedValue(data);
  (judgeLessons as jest.Mock).mockReset();
  (judgeLessons as jest.Mock).mockImplementation(async (_tx: unknown, _masters: unknown, _world: unknown, items: readonly JudgeItem[]) =>
    (judge ?? ((all) => all.map(() => verdict(true))))(items),
  );
  const prisma = { withRls: (_user: unknown, run: (tx: unknown) => unknown) => run(tx) };
  // The clash rule is the judge's, and the judge is replaced here: the masters are never asked.
  return new PossibleTimesService(prisma as never, {} as never);
}

const ask = (svc: PossibleTimesService, dto: Partial<PossibleTimesDto>) => svc.possibleTimes({ days: [1, 2, 3, 4, 5], from: '07:00', to: '16:00', stepMinutes: 30, ...dto } as PossibleTimesDto, user);
const brickDto = { academicYearId: YEAR, studentGroupId: 'c1', subjectId: 'sx', minutes: 60, teacherId: 't1' };

describe('possible times: what the service reads, asks and says', () => {
  it('answers a lesson with its best times first, ranked, and the rest of the week cut into runs', async () => {
    const svc = service(txFor());
    const answer = await ask(svc, { lessonId: mover.id, limit: 5 });

    expect(answer.academicYearId).toBe(YEAR);
    expect(answer.subject).toMatchObject({ lessonId: mover.id, className: mover.groupName, minutes: 60, unplaced: false, current: { dayOfWeek: 1, startMinutes: 480, endMinutes: 540 } });
    expect(answer.options).toHaveLength(5);
    expect(answer.options.map((option) => option.rank)).toEqual([1, 2, 3, 4, 5]);
    const scores = answer.options.map((option) => option.score);
    expect(scores).toEqual([...scores].sort((a, b) => a - b));
    // Every option is a start the judge said yes to, and is one of the free runs.
    for (const option of answer.options) {
      const day = answer.days.find((entry) => entry.dayOfWeek === option.dayOfWeek)!;
      expect(day.runs.some((run) => (run.kind === 'FREE' || run.kind === 'CHANGE') && run.fromMinutes <= option.startMinutes && option.startMinutes <= run.toMinutes)).toBe(true);
      expect(option.lessons).toEqual([{ lessonId: mover.id, roomId: expect.any(String), startMinutes: option.startMinutes, endMinutes: option.startMinutes + 60 }]);
    }
    // Where the lesson stands is said as where it stands, never as free.
    const own = answer.days.find((entry) => entry.dayOfWeek === 1)!.runs.find((run) => run.fromMinutes === 480)!;
    expect(own).toMatchObject({ kind: 'STANDS', fromMinutes: 480, toMinutes: 480 });
    expect(answer.stats).toMatchObject({ truncated: false, refused: 0 });
    expect(answer.stats.judged).toBe(answer.stats.free);
    // 07:00 to 16:00 every half hour, the last start an hour before: 17 starts a day.
    expect(answer.stats.starts).toBe(85);
  });

  it('names, in every run of another room, the room the lesson stands in there: not its own, one of the school\'s, and the numbered time\'s where one lies in the run (E3, Ledigt, annan sal läggs)', async () => {
    const svc = service(txFor());
    const answer = await ask(svc, { lessonId: mover.id, limit: 40, stepMinutes: 5 });
    const changes = answer.days.flatMap((day) => day.runs).filter((run) => run.kind === 'CHANGE');
    // The seeded week has starts where the lesson's own room is taken and another is free: without them the run below proves nothing.
    expect(changes.length).toBeGreaterThan(0);
    for (const run of changes) {
      expect(run.rooms).toHaveLength(1);
      const [named] = run.rooms!;
      expect(named!.lessonId).toBe(mover.id);
      expect(named!.roomId).not.toBe(mover.roomId);
      expect(['r1', 'r2', 'r3', 'r4', 'r5', 'r6']).toContain(named!.roomId);
    }
    // A numbered time in another room names the same room as the run it lies in.
    for (const option of answer.options.filter((entry) => entry.roomChanged)) {
      const run = changes.find((candidate) => candidate.dayOfWeek === option.dayOfWeek && candidate.fromMinutes <= option.startMinutes && option.startMinutes <= candidate.toMinutes)!;
      expect(run.rooms).toEqual([{ lessonId: mover.id, roomId: option.lessons[0]!.roomId }]);
    }
    // And no other kind of run carries a room.
    expect(answer.days.flatMap((day) => day.runs).filter((run) => run.kind !== 'CHANGE' && run.rooms !== undefined)).toEqual([]);
  });

  it('offers another room only where the generator would take the lesson: the seats count the extra classes too (E3, Ledigt, annan sal läggs; E4, BOARD_ROOM_NOT_ALLOWED)', async () => {
    // The lesson's own room holds thirty; every other room five. Three pupils of its own class fit a small room, six with an extra class do not.
    const rooms = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map((id) => ({ id, name: id, capacity: id === mover.roomId ? 30 : 5, roomTypeId: null, minGradeLevel: null, maxGradeLevel: null, building: null }));
    const another = world.classIds.find((id) => id !== mover.studentGroupId)!;
    const withExtra: SwapData = { ...world.data, lessons: world.data.lessons.map((lesson) => (lesson.id === mover.id ? { ...lesson, extraGroupIds: [another] } : lesson)) };
    const changesOf = async (data: SwapData) =>
      (await ask(service(txFor({ rooms }), undefined, data), { lessonId: mover.id, limit: 40, stepMinutes: 5 })).days.flatMap((day) => day.runs).filter((run) => run.kind === 'CHANGE');
    // The control: the class alone fits a small room, so the week has starts where the own room is taken and a small one is offered.
    expect((await changesOf(world.data)).length).toBeGreaterThan(0);
    // With the extra class the pupils are six, and a room of five is no room the generator takes: nothing is offered in another room.
    expect(await changesOf(withExtra)).toEqual([]);
  });

  it('names a lesson in the way once, with its class, subject, day and time', async () => {
    const svc = service(txFor());
    const answer = await ask(svc, { lessonId: mover.id });
    const named = Object.values(answer.blockers);
    expect(named.length).toBeGreaterThan(0);
    for (const blocker of named) {
      const lesson = world.data.lessons.find((candidate) => candidate.id === blocker.lessonId)!;
      expect(blocker).toEqual({ lessonId: lesson.id, className: lesson.groupName, subjectName: lesson.subjectName, dayOfWeek: lesson.dayOfWeek, startMinutes: lesson.startMinutes, endMinutes: lesson.endMinutes, isLocked: false });
    }
    const runs = answer.days.flatMap((day) => day.runs).filter((run) => run.kind === 'IN_THE_WAY');
    expect(runs.every((run) => answer.blockers[run.blockerId!] !== undefined)).toBe(true);
  });

  it('asks the judge about the lesson as the PATCH would: the unit excluded from the week and where it stands now as "låt stå"', async () => {
    const svc = service(txFor());
    await ask(svc, { lessonId: mover.id, limit: 1 });
    const items = (judgeLessons as jest.Mock).mock.calls.flatMap((call) => call[3] as JudgeItem[]);
    expect(items.length).toBeGreaterThan(10);
    for (const item of items) {
      expect(item.lesson).toEqual({ id: mover.id, studentGroupId: mover.studentGroupId, subjectId: mover.subjectId });
      expect(item.excludeIds).toEqual([mover.id]);
      expect(item.stands).toMatchObject({ dayOfWeek: 1, startMinutes: 480, endMinutes: 540 });
      expect(item.candidate.teacherId).toBe(mover.teacherId);
    }
  });

  it('never calls a time free that the judge refused, and says how many it refused', async () => {
    const svc = service(txFor(), (items) => items.map((item) => (item.candidate.dayOfWeek === 5 ? verdict(false, [{ reason: 'ROOM', params: {} }]) : verdict(true))));
    const answer = await ask(svc, { lessonId: mover.id, limit: 40 });
    expect(answer.options.every((option) => option.dayOfWeek !== 5)).toBe(true);
    const friday = answer.days.find((entry) => entry.dayOfWeek === 5)!.runs;
    expect(friday.some((run) => run.kind === 'FREE' || run.kind === 'CHANGE')).toBe(false);
    expect(answer.stats.refused).toBeGreaterThan(0);
  });

  it('leaves the times the judge had no time for unpainted, and says so', async () => {
    const svc = service(txFor());
    const real = Date.now;
    let calls = 0;
    // The first chunk is always judged; after it the clock jumps past the budget.
    jest.spyOn(Date, 'now').mockImplementation(() => real() + (calls++ > 8 ? 10_000 : 0));
    try {
      const answer = await ask(svc, { lessonId: mover.id, stepMinutes: 5, limit: 3 });
      expect(answer.stats.truncated).toBe(true);
      expect(answer.options.length).toBeGreaterThan(0);
      // Nothing unjudged is free: free runs hold only starts that were asked of the judge.
      const judgedStarts = new Set((judgeLessons as jest.Mock).mock.calls.flatMap((call) => (call[3] as JudgeItem[]).map((item) => `${item.candidate.dayOfWeek}|${item.candidate.startMinutes}`)));
      for (const run of answer.days.flatMap((day) => day.runs).filter((candidate) => candidate.kind === 'FREE' || candidate.kind === 'CHANGE')) {
        for (let start = run.fromMinutes; start <= run.toMinutes; start += 5) expect(judgedStarts.has(`${run.dayOfWeek}|${start}`)).toBe(true);
      }
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('answers a brick, which is asked of every rule because it stands nowhere', async () => {
    const svc = service(txFor());
    const answer = await ask(svc, { brick: brickDto, limit: 4 });
    expect(answer.subject).toMatchObject({ lessonId: null, className: 'C1', subjectName: 'Nytt ämne', minutes: 60, unplaced: true, current: null });
    expect(answer.options.length).toBeGreaterThan(0);
    const items = (judgeLessons as jest.Mock).mock.calls.flatMap((call) => call[3] as JudgeItem[]);
    for (const item of items) {
      expect(item.lesson).toEqual({ id: null, studentGroupId: 'c1', subjectId: 'sx' });
      expect(item.stands).toBeNull();
      expect(item.excludeIds).toEqual([]);
    }
    // The figures before are the school without the brick.
    const figure = answer.options[0]!.costs.find((cost) => cost.code === 'PUPIL_GAPS')!;
    expect(figure.before).toBeGreaterThanOrEqual(0);
  });

  it('treats a lesson on the tray as a brick of its own, with its own id', async () => {
    const svc = service(txFor({ lesson: { isParked: true } }));
    const answer = await ask(svc, { lessonId: mover.id, limit: 3 });
    expect(answer.subject).toMatchObject({ lessonId: mover.id, unplaced: true, current: null });
    const items = (judgeLessons as jest.Mock).mock.calls.flatMap((call) => call[3] as JudgeItem[]);
    expect(items.every((item) => item.lesson.id === mover.id && item.stands === null)).toBe(true);
    // It occupies nothing where it was: that start is as free as any other.
    const own = answer.days.find((entry) => entry.dayOfWeek === 1)!.runs.find((run) => run.fromMinutes <= 480 && 480 <= run.toMinutes)!;
    expect(own.kind).not.toBe('STANDS');
  });

  it('moves a parallel block as one unit: every lesson of it is named, laid on one time, and judged as the card’s move', async () => {
    const sibling = { ...mover, id: 'sibling', studentGroupId: 'c9', groupName: 'C9', subjectId: 'sb', teacherId: 'tz', roomId: 'rz' };
    const post = (studentGroupId: string, subjectId: string) => ({ studentGroupId, subjectId, blockId: 'B1', minutesBefore: 0, minutesAfter: 0, distribution: { maxLessonsPerDay: null, minDaysBetween: null } });
    const data: SwapData = {
      ...world.data,
      lessons: [mover, sibling],
      blocks: [{ id: 'B1', sameTimesAsBlockId: null }],
      posts: [post(mover.studentGroupId, mover.subjectId), post('c9', 'sb')],
    };
    const svc = service(txFor(), undefined, data);
    const answer = await ask(svc, { lessonId: mover.id, limit: 3 });

    expect(answer.subject.lessonIds.slice().sort()).toEqual([mover.id, 'sibling'].sort());
    for (const option of answer.options) {
      expect(option.lessons.map((entry) => entry.lessonId).sort()).toEqual([mover.id, 'sibling'].sort());
      // One start for both.
      expect(option.lessons.find((entry) => entry.lessonId === 'sibling')).toMatchObject({ startMinutes: option.startMinutes, endMinutes: option.startMinutes + 60 });
    }
    const items = (judgeLessons as jest.Mock).mock.calls.flatMap((call) => call[3] as JudgeItem[]);
    expect(items.length % 2).toBe(0);
    for (const item of items) {
      expect(item.excludeIds?.slice().sort()).toEqual([mover.id, 'sibling'].sort());
      // The other member is laid beside it, on its day.
      expect(item.alongside).toHaveLength(1);
    }
  });

  it('lets a block through only when the judge lets every one of its lessons through', async () => {
    const sibling = { ...mover, id: 'sibling', studentGroupId: 'c9', groupName: 'C9', subjectId: 'sb', teacherId: 'tz', roomId: 'rz' };
    const post = (studentGroupId: string, subjectId: string) => ({ studentGroupId, subjectId, blockId: 'B1', minutesBefore: 0, minutesAfter: 0, distribution: { maxLessonsPerDay: null, minDaysBetween: null } });
    const data: SwapData = { ...world.data, lessons: [mover, sibling], blocks: [{ id: 'B1', sameTimesAsBlockId: null }], posts: [post(mover.studentGroupId, mover.subjectId), post('c9', 'sb')] };
    // The judge has no objection to the first lesson of the block, and refuses the second wherever it is laid on a Wednesday.
    const svc = service(txFor(), (items) => items.map((item) => verdict(!(item.lesson.id === 'sibling' && item.candidate.dayOfWeek === 3))), data);
    const answer = await ask(svc, { lessonId: mover.id, limit: 40, days: [3] });
    expect(answer.options).toEqual([]);
    expect(answer.stats.refused).toBeGreaterThan(0);
    const other = await ask(svc, { lessonId: mover.id, limit: 40, days: [4] });
    expect(other.options.length).toBeGreaterThan(0);
  });

  it('says a förläggning’s lesson is moved on the timplan and offers no time', async () => {
    const svc = service(txFor({ lesson: { fromPlacement: true } }));
    const answer = await ask(svc, { lessonId: mover.id });
    expect(answer).toMatchObject({ immovable: 'PLACED', options: [], days: [] });
    expect(judgeLessons).not.toHaveBeenCalled();
    expect(readSwapData).toHaveBeenCalledTimes(0);
  });

  it('asks for one subject, found', async () => {
    const svc = service(txFor());
    await expect(ask(svc, {})).rejects.toBeInstanceOf(BadRequestException);
    await expect(ask(svc, { lessonId: mover.id, brick: brickDto })).rejects.toBeInstanceOf(BadRequestException);
    await expect(ask(service(txFor({ lesson: null })), { lessonId: mover.id })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('counts a wish of the school in the order and shows it on the option', async () => {
    const wish = { resourceType: 'TEACHER', userId: mover.teacherId, roomId: null, studentGroupId: null, dayOfWeek: 5, startTime: new Date(Date.UTC(1970, 0, 1, 8, 0)), endTime: new Date(Date.UTC(1970, 0, 1, 17, 0)), type: 'PREFERRED_FREE' };
    const plain = await ask(service(txFor()), { lessonId: mover.id, limit: 40, days: [5] });
    const wished = await ask(service(txFor({ wishes: [wish] })), { lessonId: mover.id, limit: 40, days: [5] });
    expect(plain.options.every((option) => option.wishes.avoided === 0)).toBe(true);
    // The wish is for the hours from 08:00: a start at 07:00 ends before them and breaks nothing.
    const at = (answer: typeof plain, start: number) => answer.options.find((option) => option.startMinutes === start)!;
    expect(at(wished, 420).wishes.avoided).toBe(0);
    expect(at(wished, 480).wishes.avoided).toBe(1);
    expect(at(wished, 480).score - at(plain, 480).score).toBeCloseTo(12, 9);
    expect(at(wished, 420).score).toBeCloseTo(at(plain, 420).score, 9);
  });
});
