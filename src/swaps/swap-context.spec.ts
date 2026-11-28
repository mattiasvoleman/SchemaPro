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
    // A lesson that starts in the autumn and ends in the spring meets both meals, by its start and by its end:
    // a window read with its two ends swapped, or with one end for both, would clear it of one.
    const across = lesson('across', 'c1', 1, 480, { startDate: '2026-12-18', endDate: '2027-01-31' });
    const acrossCtx = context([across], { sittings: meals });
    expect(acrossCtx.boardRefusal({ lesson: across, to: slot(2, 660, 30) })).toBe('LUNCH');
    expect(acrossCtx.boardRefusal({ lesson: across, to: slot(2, 690, 30) })).toBe('LUNCH');
    // A lesson of the weeks between the two meets neither, and one that only starts in the spring meets only the spring's.
    const between = lesson('between', 'c1', 1, 480, { startDate: '2026-12-21', endDate: '2027-01-08' });
    const springOnly = lesson('springOnly', 'c1', 1, 480, { startDate: '2027-01-11', endDate: null });
    const rest = context([between, springOnly], { sittings: meals });
    expect(rest.boardRefusal({ lesson: between, to: slot(2, 660, 30) })).toBeNull();
    expect(rest.boardRefusal({ lesson: between, to: slot(2, 690, 30) })).toBeNull();
    expect(rest.boardRefusal({ lesson: springOnly, to: slot(2, 660, 30) })).toBeNull();
    expect(rest.boardRefusal({ lesson: springOnly, to: slot(2, 690, 30) })).toBe('LUNCH');
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

describe('a move that gives a lesson another room (E5a, Annan ledig sal): the board and the other schools read the room it lands in', () => {
  const mover = lesson('mover', 'c1', 1, 480, { teacherId: 'T', roomId: 'R' });
  const lent = (resourceId: string) => ({ holdId: `h-${resourceId}`, kind: 'ROOM_LENT' as const, resourceKind: 'ROOM' as const, resourceId, dayOfWeek: 2, startTime: '10:00:00', endTime: '11:00:00', schools: ['Södra skolan'] });
  const into = (room: string): SwapMove[] => [{ lessonId: 'mover', from: slot(1, 480), to: slot(2, 600), room: { from: 'R', to: room } }];

  it('says the lesson as the move leaves it: in the room the move gives it, and as it stands when the move gives none', () => {
    const ctx = context([mover]);
    expect(ctx.standingAt({ lessonId: 'mover', room: { from: 'R', to: 'R2' } })).toMatchObject({ id: 'mover', roomId: 'R2' });
    expect(ctx.standingAt({ lessonId: 'mover' })).toBe(ctx.lessonById.get('mover'));
    expect(ctx.standingAt({ lessonId: 'ghost', room: { from: 'R', to: 'R2' } })).toBeUndefined();
    // The lesson of the snapshot is not changed by asking.
    expect(ctx.lessonById.get('mover')!.roomId).toBe('R');
  });

  it('refuses a landing in a room another school holds then, and lets the room the lesson left go: the board reads the NEW room', () => {
    const ctx = context([mover], { holds: [lent('R')] });
    // The old room is held at the new time and the lesson no longer asks for it; the new one is held, and it does.
    expect(ctx.boardVerdict([{ lessonId: 'mover', from: slot(1, 480), to: slot(2, 600) }])).toBe('OTHER_SCHOOL');
    expect(ctx.boardVerdict(into('R2'))).toBeNull();
    const held = context([mover], { holds: [lent('R2')] });
    expect(held.boardVerdict(into('R2'))).toBe('OTHER_SCHOOL');
    expect(held.boardVerdict([{ lessonId: 'mover', from: slot(1, 480), to: slot(2, 600) }])).toBeNull();
  });

  it('names the other schools’ holds on the room the lesson lands in, and not on the one it left', () => {
    const ctx = context([mover], { holds: [lent('R'), { ...lent('R2'), schools: ['Östra skolan'], startTime: '13:00:00', endTime: '14:00:00' }] });
    const keeps = ctx.externalTouches([{ lessonId: 'mover', from: slot(1, 480), to: slot(2, 600) }]);
    expect(keeps).toEqual([expect.objectContaining({ kind: 'ROOM_LENT', resourceId: 'R', schools: ['Södra skolan'] })]);
    const changes = ctx.externalTouches(into('R2'));
    expect(changes).toEqual([expect.objectContaining({ kind: 'ROOM_LENT', resourceId: 'R2', schools: ['Östra skolan'], startMinutes: 780, endMinutes: 840 })]);
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

describe('inTheWay: the prune, asked what it holds', () => {
  it('is empty exactly where mayStand says yes, for every lesson at every half hour of a busy school', () => {
    let asked = 0;
    for (const seed of [3, 11]) {
      const world = makeWorld({ seed });
      const ctx = new SwapContext(world.data);
      for (const unit of new Set(ctx.unitOf.values())) {
        const vacating = new Set(unit.members.map((member) => member.id));
        for (let day = 1; day <= 5; day++) {
          for (let start = 450; start <= 780; start += 30) {
            const to = slot(day, start);
            const way = ctx.landingsOf(unit, to).map((landing) => ctx.inTheWay(landing, vacating));
            const free = way.every((entry) => entry.lessons.length === 0 && entry.closures.length === 0);
            // The world has no frame, meal or hold, so mayStand is the plain overlap and nothing else.
            expect(ctx.mayStand(unit, to, vacating)).toBe(free);
            asked += 1;
          }
        }
      }
    }
    expect(asked).toBeGreaterThan(500);
  });

  it('names each lesson in the way once, however many things it holds', () => {
    const mover = lesson('mover', 'c1', 1, 480, { teacherId: 'T', roomId: 'R' });
    const all = lesson('all', 'c1', 2, 540, { teacherId: 'T', roomId: 'R' });
    const other = lesson('other', 'c2', 2, 570, { roomId: 'R' });
    const ctx = context([mover, all, other]);
    const landing = ctx.landingsOf(unitOf(ctx, 'mover'), slot(2, 540))[0]!;
    const way = ctx.inTheWay(landing, new Set(['mover']));
    expect(way.lessons.map((entry) => entry.id).sort()).toEqual(['all', 'other']);
    expect(way.closures).toEqual([]);
    expect(ctx.inTheWay(landing, new Set(['mover']), true).lessons).toHaveLength(1);
  });

  it('says which resource a weekly row closes', () => {
    const mover = lesson('mover', 'c1', 1, 480, { teacherId: 'T', roomId: 'R' });
    const row = (over: Partial<SwapData['constraints'][number]>) => ({
      resourceType: 'TEACHER',
      userId: null,
      roomId: null,
      studentGroupId: null,
      minGradeLevel: null,
      maxGradeLevel: null,
      dayOfWeek: 3,
      startMinutes: 540,
      endMinutes: 600,
      ...over,
    });
    const ctx = context([mover], {
      constraints: [row({ userId: 'T' }), row({ resourceType: 'ROOM', roomId: 'R' }), row({ resourceType: 'STUDENT_GROUP', studentGroupId: 'c1' })],
    });
    const landing = ctx.landingsOf(unitOf(ctx, 'mover'), slot(3, 540))[0]!;
    expect(ctx.inTheWay(landing, new Set(['mover'])).closures).toEqual(['TEACHER', 'ROOM', 'GROUP']);
    expect(ctx.inTheWay(landing, new Set(['mover']), true).closures).toEqual(['TEACHER']);
  });
});

describe('unplaced lessons: planned, standing nowhere', () => {
  const brick = lesson('brick', 'c1', 1, 0, { teacherId: 'T', roomId: 'R' });

  it('are a unit of their own, known by id, and in no one’s way', () => {
    const standing = lesson('standing', 'c1', 2, 540, { teacherId: 'T', roomId: 'R' });
    const ctx = new SwapContext({ ...base.data, lessons: [standing], posts: [] }, { unplaced: [brick] });
    expect(ctx.unitOf.get('brick')).toMatchObject({ id: 'brick', members: [brick], links: [], locked: false });
    expect(ctx.lessonById.get('brick')).toBe(brick);
    // The placeholder day and clock are nothing anyone reads: the standing lesson is held by nothing at 00:00 Monday.
    const way = ctx.inTheWay(ctx.landingsOf(unitOf(ctx, 'standing'), slot(1, 0))[0]!, new Set(['standing']));
    expect(way.lessons).toEqual([]);
    // The brick itself is held by the standing lesson where it would overlap it: same teacher, room and class.
    expect(ctx.mayStand(unitOf(ctx, 'brick'), slot(2, 540), new Set(['brick']))).toBe(false);
    expect(ctx.mayStand(unitOf(ctx, 'brick'), slot(2, 600), new Set(['brick']))).toBe(true);
  });

  it('leave the school as it was when there are none', () => {
    const lessons = [lesson('a', 'c1', 1, 480), lesson('b', 'c1', 1, 600)];
    const plain = new SwapContext({ ...base.data, lessons, posts: [] });
    const same = new SwapContext({ ...base.data, lessons, posts: [] }, { unplaced: [] });
    expect([...same.unitOf.keys()]).toEqual([...plain.unitOf.keys()]);
    const moves = [{ lessonId: 'b', from: slot(1, 600), to: slot(1, 540) }];
    expect(same.soft.evaluate(moves)).toEqual(plain.soft.evaluate(moves));
  });
});

describe('inTheWay: weeks no one sits (jullov)', () => {
  // An autumn lesson to the 1st of January and a spring lesson from the 28th of December meet in one week only, and that week is lov:
  // findConflicts (meetOnlyInClosedWeeks) says they are no double booking, so the prune must not hold the one in the other's way.
  const closed = { from: '2026-08-15', to: '2027-06-11', mondays: new Set(['2026-12-28']) };
  const autumn = lesson('autumn', 'c1', 2, 540, { teacherId: 'T', roomId: 'R', endDate: '2027-01-01' });
  const spring = lesson('spring', 'c2', 3, 540, { teacherId: 'T', roomId: 'R', startDate: '2026-12-28' });
  const asked = (ctx: SwapContext) => ctx.inTheWay(ctx.landingsOf(unitOf(ctx, 'spring'), slot(2, 540))[0]!, new Set(['spring']));

  it('holds a lesson that meets the mover in a week with school, as it always did', () => {
    expect(asked(context([autumn, spring])).lessons.map((entry) => entry.id)).toEqual(['autumn']);
  });

  it('does not hold one that meets the mover only in a closed week', () => {
    const ctx = new SwapContext({ ...base.data, lessons: [autumn, spring], posts: [] }, { closedWeeks: closed });
    expect(asked(ctx).lessons).toEqual([]);
    expect(ctx.mayStand(unitOf(ctx, 'spring'), slot(2, 540), new Set(['spring']))).toBe(true);
  });

  it('still holds one that meets the mover in a week that is not closed', () => {
    const open = lesson('open', 'c1', 2, 540, { teacherId: 'T', endDate: '2027-01-08' });
    const ctx = new SwapContext({ ...base.data, lessons: [open, spring], posts: [] }, { closedWeeks: closed });
    expect(asked(ctx).lessons.map((entry) => entry.id)).toEqual(['open']);
  });
});

describe('inTheWay: a room several lessons may share', () => {
  const mover = lesson('mover', 'c1', 1, 480, { teacherId: 'T', roomId: 'HALL' });
  const inHall = lesson('inHall', 'c2', 2, 540, { roomId: 'HALL' });
  const asked = (ctx: SwapContext) => ctx.inTheWay(ctx.landingsOf(unitOf(ctx, 'mover'), slot(2, 540))[0]!, new Set(['mover']));

  it('holds a lesson in the room, as it always did, when the school shares no room', () => {
    expect(asked(context([mover, inHall])).lessons.map((entry) => entry.id)).toEqual(['inHall']);
  });

  it('leaves the count of pupils to the judge in a room the school lets several lessons share', () => {
    const ctx = new SwapContext({ ...base.data, lessons: [mover, inHall], posts: [] }, { sharedRooms: new Set(['HALL']) });
    expect(asked(ctx).lessons).toEqual([]);
  });

  it('still holds the teacher and the class in a shared room', () => {
    const sameTeacher = lesson('sameTeacher', 'c3', 2, 540, { teacherId: 'T', roomId: 'HALL' });
    const sameClass = lesson('sameClass', 'c1', 2, 540, { roomId: 'HALL' });
    const ctx = new SwapContext({ ...base.data, lessons: [mover, sameTeacher, sameClass], posts: [] }, { sharedRooms: new Set(['HALL']) });
    expect(asked(ctx).lessons.map((entry) => entry.id).sort()).toEqual(['sameClass', 'sameTeacher']);
  });
});

/*
 * E5a: landingsClash is inTheWay asked of a pair. Gör plats lets two units move at once, and the index only knows where lessons stood,
 * so the pair has its own function; this holds the two to one answer, for every lesson against every other at every half hour, in
 * the schools where the rules differ: the pupils' minutes before and after, a pupil in two groups, alternating weeks, a week no one
 * sits, and a room the school lets several lessons share.
 */
describe('landingsClash: the pair, and the index, say the same', () => {
  const sameAnswers = (ctx: SwapContext): number => {
    let pairs = 0;
    let clashing = 0;
    const differ: string[] = [];
    const lessons = [...ctx.lessonById.values()];
    for (const mover of lessons) {
      for (let day = 1; day <= 5; day++) {
        for (let start = 450; start <= 780; start += 30) {
          const landing = { lesson: mover, to: { dayOfWeek: day, startMinutes: start, endMinutes: start + (mover.endMinutes - mover.startMinutes) } };
          const holding = new Set(ctx.inTheWay(landing, new Set([mover.id])).lessons.map((entry) => entry.id));
          for (const other of lessons) {
            if (other.id === mover.id) continue;
            const answer = ctx.landingsClash(landing, { lesson: other, to: { dayOfWeek: other.dayOfWeek, startMinutes: other.startMinutes, endMinutes: other.endMinutes } });
            if (answer !== holding.has(other.id)) differ.push(`${mover.id} at ${day}|${start} against ${other.id}`);
            pairs += 1;
            if (answer) clashing += 1;
          }
        }
      }
    }
    expect(differ).toEqual([]);
    // Not a vacuous pass: the schools below hold lessons that clash and lessons that do not.
    expect(clashing).toBeGreaterThan(10);
    expect(clashing).toBeLessThan(pairs);
    return pairs;
  };

  it('in the busy school, as it stands', () => {
    for (const seed of [3, 11]) expect(sameAnswers(new SwapContext(makeWorld({ seed }).data))).toBeGreaterThan(500);
  });

  it('with the pupils’ minutes before and after, alternating weeks and a pupil who is in two groups', () => {
    const lessons = [
      lesson('idrott', 'c1', 1, 480, { subjectId: 'idh', teacherId: 'T1', roomId: 'R1' }),
      lesson('ma', 'c1', 1, 600, { subjectId: 'ma', teacherId: 'T2', roomId: 'R2' }),
      lesson('odd', 'c2', 2, 540, { recurrence: 'ODD_WEEKS', teacherId: 'T1', roomId: 'R1' }),
      lesson('even', 'c3', 2, 540, { recurrence: 'EVEN_WEEKS', teacherId: 'T1', roomId: 'R1' }),
      lesson('tg', 'tg', 3, 540, { teacherId: 'T3', roomId: 'R3' }),
      lesson('c1b', 'c1', 3, 600, { teacherId: 'T4', roomId: 'R4', coTeacherId: 'T3' }),
      lesson('c2b', 'c2', 4, 480, { teacherId: 'T3', roomId: 'R3', extraGroupIds: ['c1'] }),
    ];
    const posts = [{ studentGroupId: 'c1', subjectId: 'idh', blockId: null, minutesBefore: 10, minutesAfter: 20, distribution: { maxLessonsPerDay: null, minDaysBetween: null } }];
    const rosters = { ...base.data.rosters, groupsByStudent: new Map([['p1', new Set(['c1', 'tg'])]]) };
    const groups = [...base.data.groups, { id: 'tg', name: 'Spanska', kind: 'TEACHING_GROUP' as const, halfOfId: null, replacesSubjectId: null, gradeLevel: 7 }];
    expect(sameAnswers(context(lessons, { posts, rosters, groups }))).toBeGreaterThan(100);
  });

  it('with a week no one sits and a room several lessons may share', () => {
    const closed = { from: '2026-08-15', to: '2027-06-11', mondays: new Set(['2026-12-28']) };
    const lessons = [
      lesson('autumn', 'c1', 2, 540, { teacherId: 'T', roomId: 'HALL', endDate: '2027-01-01' }),
      lesson('spring', 'c2', 2, 540, { teacherId: 'T', roomId: 'HALL', startDate: '2026-12-28' }),
      lesson('open', 'c3', 2, 540, { teacherId: 'T', roomId: 'HALL', endDate: '2027-01-08' }),
      lesson('hall1', 'c4', 3, 540, { roomId: 'HALL' }),
      lesson('hall2', 'c5', 3, 540, { roomId: 'HALL' }),
      lesson('same', 'c1', 3, 540, { teacherId: 'T9', roomId: 'HALL' }),
    ];
    expect(sameAnswers(new SwapContext({ ...base.data, lessons, posts: [] }, { closedWeeks: closed, sharedRooms: new Set(['HALL']) }))).toBeGreaterThan(100);
  });
});
