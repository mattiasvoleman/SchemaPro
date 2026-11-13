import { makeWorld } from './__fixtures__/swap-world';
import { SwapContext } from './swap-context';
import type { SwapData } from './swap-snapshot';
import type { SwapLesson, SwapMove, SwapSlot } from './swap-types';

const base = makeWorld({ seed: 7 });

const lesson = (id: string, classId: string, day: number, start: number, over: Partial<SwapLesson> = {}): SwapLesson => ({
  id,
  subjectId: 's1',
  subjectName: 'Matematik',
  studentGroupId: classId,
  groupName: classId.toUpperCase(),
  teacherId: `t-${id}`,
  coTeacherId: null,
  roomId: `r-${id}`,
  dayOfWeek: day,
  startMinutes: start,
  endMinutes: start + 60,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  isLocked: false,
  isGenerated: true,
  extraGroupIds: [],
  studentIds: [],
  ...over,
});

function context(lessons: SwapLesson[], over: Partial<SwapData> = {}): SwapContext {
  return new SwapContext({ ...base.data, lessons, posts: [], ...over });
}

const slot = (day: number, start: number, length = 60): SwapSlot => ({ dayOfWeek: day, startMinutes: start, endMinutes: start + length });
const unitOf = (ctx: SwapContext, id: string) => ctx.unitOf.get(id)!;

describe('mayStand: the prune is a plain overlap, and a subset of the clash rule', () => {
  it('is free when nothing stands there, and the same teacher, room or class at the time refuses', () => {
    const mover = lesson('mover', 'c1', 1, 480, { teacherId: 'T', roomId: 'R' });
    const sameTeacher = lesson('x1', 'c2', 2, 540, { teacherId: 'T' });
    const sameRoom = lesson('x2', 'c3', 3, 540, { roomId: 'R' });
    const sameClass = lesson('x3', 'c1', 4, 540);
    const ctx = context([mover, sameTeacher, sameRoom, sameClass]);
    const noneVacating = new Set<string>(['mover']);
    expect(ctx.mayStand(unitOf(ctx, 'mover'), slot(2, 540), noneVacating)).toBe(false);
    expect(ctx.mayStand(unitOf(ctx, 'mover'), slot(3, 540), noneVacating)).toBe(false);
    expect(ctx.mayStand(unitOf(ctx, 'mover'), slot(4, 540), noneVacating)).toBe(false);
    expect(ctx.mayStand(unitOf(ctx, 'mover'), slot(5, 540), noneVacating)).toBe(true);
    // Half an hour of overlap is an overlap; touching is not.
    expect(ctx.mayStand(unitOf(ctx, 'mover'), slot(2, 510), noneVacating)).toBe(false);
    expect(ctx.mayStand(unitOf(ctx, 'mover'), slot(2, 600), noneVacating)).toBe(true);
  });

  it('lets a unit take the slot of a lesson that is leaving, and no other', () => {
    const mover = lesson('mover', 'c1', 1, 480, { teacherId: 'T' });
    const leaving = lesson('leaving', 'c2', 2, 540, { teacherId: 'T' });
    const ctx = context([mover, leaving]);
    expect(ctx.mayStand(unitOf(ctx, 'mover'), slot(2, 540), new Set(['mover']))).toBe(false);
    expect(ctx.mayStand(unitOf(ctx, 'mover'), slot(2, 540), new Set(['mover', 'leaving']))).toBe(true);
  });

  it('lets alternating weeks share a slot, the teacher, the room and the class', () => {
    const odd = lesson('odd', 'c1', 1, 480, { recurrence: 'ODD_WEEKS', teacherId: 'T', roomId: 'R' });
    const even = lesson('even', 'c1', 2, 540, { recurrence: 'EVEN_WEEKS', teacherId: 'T', roomId: 'R' });
    const ctx = context([odd, even]);
    expect(ctx.mayStand(unitOf(ctx, 'odd'), slot(2, 540), new Set(['odd']))).toBe(true);
  });

  it('holds the class for the minutes its pupils change before and shower after', () => {
    const idrott = lesson('idrott', 'c1', 1, 480, { subjectId: 'idh' });
    const next = lesson('next', 'c1', 2, 540, { subjectId: 'ma' });
    const posts = [{ studentGroupId: 'c1', subjectId: 'idh', blockId: null, minutesBefore: 10, minutesAfter: 20, distribution: { maxLessonsPerDay: null, minDaysBetween: null } }];
    const ctx = context([idrott, next], { posts });
    // Idrott to Tuesday 08:30 would end at 09:30, +20 minutes of dusch into next's 09:00.
    expect(ctx.mayStand(unitOf(ctx, 'idrott'), slot(2, 480), new Set(['idrott']))).toBe(false);
    // The neighbour’s own buffer counts too: b is an idrott on Tuesday 09:00, whose
    // 20 minutes of dusch run to 10:20 and whose 10 of ombyte start at 08:50.
    const swapped = context([lesson('a', 'c1', 1, 480, { subjectId: 'ma' }), lesson('b', 'c1', 2, 540, { subjectId: 'idh' })], { posts });
    const a = unitOf(swapped, 'a');
    expect(swapped.mayStand(a, slot(2, 620), new Set(['a']))).toBe(true);
    expect(swapped.mayStand(a, slot(2, 600), new Set(['a']))).toBe(false);
    expect(swapped.mayStand(a, slot(2, 470), new Set(['a']))).toBe(true);
    expect(swapped.mayStand(a, slot(2, 475), new Set(['a']))).toBe(false);
  });

  it('keeps out of a weekly closure on the teacher, the room or the class, and nothing else', () => {
    const mover = lesson('mover', 'c1', 1, 480, { teacherId: 'T', roomId: 'R' });
    const row = (over: Partial<SwapData['constraints'][number]>) => ({
      resourceType: 'TEACHER',
      userId: null,
      roomId: null,
      studentGroupId: null,
      minGradeLevel: null,
      maxGradeLevel: null,
      dayOfWeek: 2,
      startMinutes: 600,
      endMinutes: 660,
      ...over,
    });
    for (const closed of [row({ userId: 'T' }), row({ resourceType: 'ROOM', roomId: 'R' }), row({ resourceType: 'STUDENT_GROUP', studentGroupId: 'c1' })]) {
      const ctx = context([mover], { constraints: [closed] });
      expect(ctx.mayStand(unitOf(ctx, 'mover'), slot(2, 600), new Set(['mover']))).toBe(false);
      expect(ctx.mayStand(unitOf(ctx, 'mover'), slot(3, 600), new Set(['mover']))).toBe(true);
    }
    const other = context([mover], { constraints: [row({ userId: 'someone-else' })] });
    expect(other.mayStand(unitOf(other, 'mover'), slot(2, 600), new Set(['mover']))).toBe(true);
  });
});

describe('mayStand: groups that share a pupil clash, unless a replacing group is in play', () => {
  const sharedPupil = (groupsByStudent: Array<[string, string[]]>) => ({
    rosters: { ...base.data.rosters, groupsByStudent: new Map(groupsByStudent.map(([pupil, groups]) => [pupil, new Set(groups)])) },
  });
  const groups = (extra: Partial<SwapData['groups'][number]> = {}) => [
    ...base.data.groups,
    { id: 'tg', name: 'Spanska', kind: 'TEACHING_GROUP' as const, halfOfId: null, replacesSubjectId: null, gradeLevel: 7, ...extra },
  ];
  const mover = lesson('mover', 'c1', 1, 480);
  const block = lesson('block', 'tg', 2, 540);

  it('refuses a slot where a teaching group with a pupil of the class stands', () => {
    const ctx = context([mover, block], { ...sharedPupil([['p1', ['c1', 'tg']]]), groups: groups() });
    expect(ctx.mayStand(unitOf(ctx, 'mover'), slot(2, 540), new Set(['mover']))).toBe(false);
    // The teaching group moving to the class's slot is refused the same way.
    expect(ctx.mayStand(unitOf(ctx, 'block'), slot(1, 480), new Set(['block']))).toBe(false);
  });

  it('lets them share a slot when no pupil is in both', () => {
    const ctx = context([mover, block], { ...sharedPupil([['p1', ['c1']], ['p2', ['tg']]]), groups: groups() });
    expect(ctx.mayStand(unitOf(ctx, 'mover'), slot(2, 540), new Set(['mover']))).toBe(true);
  });

  it('keeps to the groups themselves at a school with a replacing group: the rule lets a replaced pupil be elsewhere', () => {
    const ctx = context([mover, block], {
      ...sharedPupil([['p1', ['c1', 'tg']]]),
      groups: groups({ replacesSubjectId: 'sv' }),
    });
    expect(ctx.mayStand(unitOf(ctx, 'mover'), slot(2, 540), new Set(['mover']))).toBe(true);
  });
});

describe('boardRefusal: the grid’s other hard kinds', () => {
  const mover = lesson('mover', 'c1', 1, 480, { teacherId: 'T', roomId: 'R' });
  const landing = (ctx: SwapContext, to: SwapSlot) => ctx.boardRefusal({ lesson: mover, to });

  it('refuses a lesson outside the stage’s ramtid and inside it passes', () => {
    const ctx = context([mover], { frames: [{ min: 7, max: 9, day: null, start: 480, end: 900 }] });
    expect(landing(ctx, slot(2, 480))).toBeNull();
    expect(landing(ctx, slot(2, 870))).toBe('FRAME');
    expect(landing(ctx, slot(2, 420))).toBe('FRAME');
    // A frame for other years binds nothing here, and a closed day refuses.
    expect(landing(context([mover], { frames: [{ min: 1, max: 3, day: null, start: 0, end: 60 }] }), slot(2, 870))).toBeNull();
    expect(landing(context([mover], { frames: [{ min: 7, max: 9, day: 2, start: 900, end: 600 }] }), slot(2, 480))).toBe('FRAME');
  });

  it('refuses a lesson on the class’s own meal', () => {
    const ctx = context([mover], { sittings: [{ studentGroupId: 'c1', dayOfWeek: 2, startMinutes: 660, endMinutes: 690 }] });
    expect(landing(ctx, slot(2, 630))).toBe('LUNCH');
    expect(landing(ctx, slot(3, 630))).toBeNull();
    expect(landing(ctx, slot(2, 690))).toBeNull();
  });

  it('holds a lesson to the meal of its own weeks when the class eats at another time in another part of the läsår', () => {
    // Tuesday: 11:00–11:30 in the autumn (to Sunday 2026-12-20), 11:30–12:00 from Monday 2027-01-11.
    const meals = [
      { studentGroupId: 'c1', dayOfWeek: 2, startMinutes: 660, endMinutes: 690, startDate: null, endDate: '2026-12-20' },
      { studentGroupId: 'c1', dayOfWeek: 2, startMinutes: 690, endMinutes: 720, startDate: '2027-01-11', endDate: null },
    ];
    const autumnLesson = lesson('autumn', 'c1', 1, 480, { startDate: '2026-08-17', endDate: '2026-12-18' });
    const springLesson = lesson('spring', 'c1', 1, 480, { startDate: '2027-01-11', endDate: '2027-06-11' });
    const ctx = context([autumnLesson, springLesson], { sittings: meals });
    const on = (stands: SwapLesson, to: SwapSlot) => ctx.boardRefusal({ lesson: stands, to });
    // 11:00–11:30 is the autumn's meal and not the spring's, and the other way round for 11:30–12:00.
    expect(on(autumnLesson, slot(2, 660, 30))).toBe('LUNCH');
    expect(on(autumnLesson, slot(2, 690, 30))).toBeNull();
    expect(on(springLesson, slot(2, 660, 30))).toBeNull();
    expect(on(springLesson, slot(2, 690, 30))).toBe('LUNCH');
    // A lesson of every week stands on neither.
    expect(landing(ctx, slot(2, 660, 30))).toBe('LUNCH');
    expect(landing(ctx, slot(2, 690, 30))).toBe('LUNCH');
  });

  it('refuses a lesson in a weekly rule on whole årskurser, for the years the class holds', () => {
    const rule = (min: number | null, max: number | null) => ({
      resourceType: 'GRADE_LEVEL',
      userId: null,
      roomId: null,
      studentGroupId: null,
      minGradeLevel: min,
      maxGradeLevel: max,
      dayOfWeek: 2,
      startMinutes: 780,
      endMinutes: 840,
    });
    expect(landing(context([mover], { constraints: [rule(7, 9)] }), slot(2, 780))).toBe('GRADE_RULE');
    expect(landing(context([mover], { constraints: [rule(null, 6)] }), slot(2, 780))).toBeNull();
    expect(landing(context([mover], { constraints: [rule(8, null)] }), slot(2, 780))).toBeNull();
    expect(landing(context([mover], { constraints: [rule(null, null)] }), slot(2, 780))).toBe('GRADE_RULE');
  });

  it('refuses a lesson on another school’s hold of its teacher or room', () => {
    const hold = (kind: 'TEACHER_BUSY' | 'ROOM_LENT' | 'ROOM_BORROWED', resourceKind: 'TEACHER' | 'ROOM', resourceId: string) => ({
      holdId: `h-${kind}`,
      kind,
      resourceKind,
      resourceId,
      dayOfWeek: 2,
      startTime: '10:00:00',
      endTime: '11:00:00',
      schools: ['Norra skolan'],
    });
    for (const held of [hold('TEACHER_BUSY', 'TEACHER', 'T'), hold('ROOM_LENT', 'ROOM', 'R'), hold('ROOM_BORROWED', 'ROOM', 'R')]) {
      const ctx = context([mover], { holds: [held] });
      expect(landing(ctx, slot(2, 600))).toBe('OTHER_SCHOOL');
      expect(landing(ctx, slot(2, 660))).toBeNull();
      expect(landing(ctx, slot(3, 600))).toBeNull();
    }
    expect(landing(context([mover], { holds: [hold('TEACHER_BUSY', 'TEACHER', 'someone-else')] }), slot(2, 600))).toBeNull();
  });

  it('gives the first rule any of the moves breaks, and mayStand takes it into account', () => {
    const ctx = context([mover], { frames: [{ min: 7, max: 9, day: null, start: 480, end: 540 }] });
    const moves: SwapMove[] = [{ lessonId: 'mover', from: slot(1, 480), to: slot(2, 540) }];
    expect(ctx.boardVerdict(moves)).toBe('FRAME');
    expect(ctx.boardVerdict([{ lessonId: 'mover', from: slot(1, 480), to: slot(2, 480) }])).toBeNull();
    expect(ctx.boardVerdict([{ lessonId: 'ghost', from: slot(1, 480), to: slot(2, 540) }])).toBeNull();
    expect(ctx.mayStand(unitOf(ctx, 'mover'), slot(2, 540), new Set(['mover']))).toBe(false);
  });

  it('names the other schools’ holds on the day a lesson lands, and moves none of them', () => {
    const holds = [
      { holdId: 'h1', kind: 'TEACHER_BUSY' as const, resourceKind: 'TEACHER' as const, resourceId: 'T', dayOfWeek: 2, startTime: '08:00:00', endTime: '09:30:00', schools: ['Norra skolan'] },
      { holdId: 'h2', kind: 'ROOM_LENT' as const, resourceKind: 'ROOM' as const, resourceId: 'R', dayOfWeek: 2, startTime: '13:00:00', endTime: '14:00:00', schools: ['Södra skolan'] },
      { holdId: 'h3', kind: 'ROOM_BORROWED' as const, resourceKind: 'ROOM' as const, resourceId: 'R', dayOfWeek: 3, startTime: '08:00:00', endTime: '09:00:00', schools: ['Östra skolan'] },
    ];
    const ctx = context([mover], { holds });
    const touches = ctx.externalTouches([{ lessonId: 'mover', from: slot(1, 480), to: slot(2, 600) }, { lessonId: 'ghost', from: slot(1, 480), to: slot(2, 600) }]);
    expect(touches).toEqual([
      { kind: 'SHARED_TEACHER', lessonId: 'mover', resourceId: 'T', schools: ['Norra skolan'], dayOfWeek: 2, startMinutes: 480, endMinutes: 570 },
      { kind: 'ROOM_LENT', lessonId: 'mover', resourceId: 'R', schools: ['Södra skolan'], dayOfWeek: 2, startMinutes: 780, endMinutes: 840 },
    ]);
  });
});

describe('landingsOf', () => {
  it('lays each member at the slot’s start with its own length', () => {
    const long = lesson('long', 'c1', 1, 480, { endMinutes: 570 });
    const short = lesson('short', 'c2', 1, 480);
    const ctx = context([long, short]);
    // Members of a unit share a slot, so share a length; the method does not assume it.
    const unit = { id: 'long', members: [long, short], links: [], slot: slot(1, 480), locked: false };
    expect(ctx.landingsOf(unit, slot(3, 600)).map((l) => [l.lesson.id, l.to.dayOfWeek, l.to.startMinutes, l.to.endMinutes])).toEqual([
      ['long', 3, 600, 690],
      ['short', 3, 600, 660],
    ]);
  });
});
