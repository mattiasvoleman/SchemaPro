import { blankLesson, type ExchangeLesson } from './exchange-model';
import {
  changesOf,
  deriveRequirements,
  fitRefusals,
  frameWindowOf,
  indexContext,
  lunchFits,
  matchExisting,
  planFingerprint,
  rastsOf,
  resolveLesson,
  type ExistingLesson,
  type FinalLesson,
  type PlanContext,
  type PlanRow,
  type ResolvedLesson,
} from './exchange-plan';

const G7A = { id: 'g-7a', name: '7A', kind: 'CLASS' as const, gradeLevel: 7, halfOfId: null };
const G7B = { id: 'g-7b', name: '7B', kind: 'CLASS' as const, gradeLevel: 7, halfOfId: null };
const G71 = { id: 'g-71', name: '7A-1', kind: 'TEACHING_GROUP' as const, gradeLevel: 7, halfOfId: 'g-7a' };

function context(over: Partial<PlanContext> = {}): PlanContext {
  return {
    year: { id: 'y1', name: '2026/2027', start: '2026-08-17', end: '2027-06-11', numbering: 'NIOARIG' },
    groups: [G7A, G7B, G71],
    subjects: [
      { id: 's-ma', name: 'Matematik', code: 'MA' },
      { id: 's-sv', name: 'Svenska', code: 'SV' },
      { id: 's-id1', name: 'Idrott', code: 'ID1' },
      { id: 's-id2', name: 'Idrott', code: 'ID2' },
    ],
    rooms: [
      { id: 'r-101', name: 'A101', code: null },
      { id: 'r-gym', name: 'Gymnastiksalen', code: null },
    ],
    teachers: [
      { id: 't-abe', firstName: 'Anna', lastName: 'Berg', email: 'anna@skolan.example', signature: 'ABE', isActive: true },
      { id: 't-blu', firstName: 'Bo', lastName: 'Lund', email: 'bo@skolan.example', signature: 'BLU', isActive: true },
      { id: 't-old', firstName: 'Olof', lastName: 'Gammal', email: 'olof@skolan.example', signature: 'OGA', isActive: false },
      { id: 't-nosig', firstName: 'Nina', lastName: 'Utan', email: 'nina@skolan.example', signature: null, isActive: true },
    ],
    existing: [],
    frames: [],
    rasts: [],
    lunch: null,
    servings: [],
    sittings: [],
    requirements: [],
    blocks: [],
    spans: new Map([
      ['g-7a', { min: 7, max: 7 }],
      ['g-7b', { min: 7, max: 7 }],
      ['g-71', { min: 7, max: 7 }],
    ]),
    ...over,
  };
}

function lesson(over: Partial<ExchangeLesson> = {}): ExchangeLesson {
  return blankLesson({ ref: 'rad 2', group: '7A', subject: 'Matematik', day: 1, start: '08:10', end: '09:10', teachers: [{ short: 'ABE', name: null, email: null, id: null }], room: 'A101', ...over });
}

function resolved(over: Partial<ExchangeLesson> = {}, ctx: PlanContext = context()): ResolvedLesson {
  const r = resolveLesson(lesson(over), indexContext(ctx), ctx);
  if (!('resolved' in r)) throw new Error(`refused: ${JSON.stringify(r.refusals)}`);
  return r.resolved;
}

function refusalsOf(over: Partial<ExchangeLesson>, ctx: PlanContext = context()): string[] {
  const r = resolveLesson(lesson(over), indexContext(ctx), ctx);
  return 'refusals' in r ? r.refusals.map((x) => x.code) : [];
}

describe('resolveLesson', () => {
  it('resolves names to the school’s things, case and spacing aside', () => {
    const r = resolved({ group: ' 7a ', subject: 'matematik', room: 'a101' });
    expect([r.group.id, r.subject.id, r.roomId, r.teacherIds]).toEqual(['g-7a', 's-ma', 'r-101', ['t-abe']]);
    expect([r.startMin, r.endMin, r.weeks, r.from, r.to]).toEqual([490, 550, 'ALL', null, null]);
  });

  it('finds a teacher on signature or on e-mail, and names the one it cannot find', () => {
    expect(resolved({ teachers: [{ short: null, name: null, email: 'BO@skolan.example', id: null }] }).teacherIds).toEqual(['t-blu']);
    expect(resolved({ teachers: [{ short: 'XYZ', name: null, email: 'bo@skolan.example', id: null }] }).teacherIds).toEqual(['t-blu']);
    expect(refusalsOf({ teachers: [{ short: 'XYZ', name: null, email: null, id: null }] })).toEqual(['UNKNOWN_TEACHER']);
    // A signature and an e-mail that name two people is a contradiction, not a spelling.
    expect(refusalsOf({ teachers: [{ short: 'ABE', name: null, email: 'bo@skolan.example', id: null }] })).toEqual(['TEACHER_KEYS_DISAGREE']);
    expect(refusalsOf({ teachers: [{ short: 'OGA', name: null, email: null, id: null }] })).toEqual(['TEACHER_INACTIVE']);
    expect(
      refusalsOf({ teachers: [{ short: 'ABE', name: null, email: null, id: null }, { short: 'abe', name: null, email: null, id: null }] }),
    ).toEqual(['SAME_TEACHER_TWICE']);
  });

  it('refuses a name that is not exactly one thing, and says which', () => {
    expect(refusalsOf({ group: '9Z' })).toEqual(['UNKNOWN_GROUP']);
    expect(refusalsOf({ extraGroups: ['9Z'] })).toEqual(['UNKNOWN_GROUP']);
    expect(refusalsOf({ subject: 'Slöjd' })).toEqual(['UNKNOWN_SUBJECT']);
    expect(refusalsOf({ subject: 'Idrott' })).toEqual(['AMBIGUOUS_SUBJECT']);
    expect(resolved({ subject: 'Idrott', subjectCode: 'id2' }).subject.id).toBe('s-id2');
    expect(refusalsOf({ room: 'Aulan' })).toEqual(['UNKNOWN_ROOM']);
    expect(refusalsOf({ subject: 'Svenska', subjectCode: 'MA' })).toEqual(['ID_NAME_MISMATCH']);
  });

  it('lets an id win only when the name agrees with it', () => {
    expect(resolved({ group: '7A', ids: { group: 'g-7a' } }).group.id).toBe('g-7a');
    expect(refusalsOf({ group: '7B', ids: { group: 'g-7a' } })).toEqual(['ID_NAME_MISMATCH']);
    expect(resolved({ group: '', ids: { group: 'g-7a' } }).group.id).toBe('g-7a');
    expect(refusalsOf({ room: 'A101', ids: { room: 'r-gym' } })).toEqual(['ID_NAME_MISMATCH']);
    expect(refusalsOf({ subject: 'Svenska', ids: { subject: 's-ma' } })).toEqual(['ID_NAME_MISMATCH']);
    expect(resolved({ room: '', ids: { room: 'r-gym' } }).roomId).toBe('r-gym');
  });

  it('drops the lesson’s own group from its extra groups and keeps a visiting class', () => {
    const r = resolved({ extraGroups: ['7A', '7B', '7b'] });
    expect(r.extraGroups.map((g) => g.id)).toEqual(['g-7b']);
  });

  it('refuses a time, a day and a period that cannot be a lesson', () => {
    expect(refusalsOf({ start: '09:10', end: '08:10' })).toEqual(['BAD_TIME']);
    expect(refusalsOf({ start: 'x', end: '08:10' })).toEqual(['BAD_TIME']);
    expect(refusalsOf({ start: '08:12', end: '09:10' })).toEqual(['OFF_GRID']);
    expect(refusalsOf({ day: 6 })).toEqual(['DAY_OUTSIDE_SCHOOL_WEEK']);
    expect(refusalsOf({ from: '2026-12-18', to: '2026-08-17' })).toEqual(['PERIOD_REVERSED']);
    expect(refusalsOf({ from: '2025-01-01' })).toEqual(['PERIOD_OUTSIDE_YEAR']);
    expect(refusalsOf({ to: '2028-01-01' })).toEqual(['PERIOD_OUTSIDE_YEAR']);
    expect(resolved({ from: '2026-08-17', to: '2026-12-18', block: ' Språkval ' })).toMatchObject({ from: '2026-08-17', to: '2026-12-18', block: 'Språkval' });
  });

  it('reports every reason at once, not the first', () => {
    expect(refusalsOf({ group: '9Z', subject: 'Slöjd', room: 'Aulan', day: 7 })).toEqual([
      'UNKNOWN_GROUP',
      'UNKNOWN_SUBJECT',
      'UNKNOWN_ROOM',
      'DAY_OUTSIDE_SCHOOL_WEEK',
    ]);
  });

  it('accepts a lesson with no room and no teacher', () => {
    const r = resolved({ room: null, teachers: [] });
    expect([r.roomId, r.teacherIds]).toEqual([null, []]);
  });

  it('describes a teacher by whatever the file gave, even when nothing', () => {
    expect(refusalsOf({ teachers: [{ short: null, name: 'Nils', email: null, id: null }] })).toEqual(['UNKNOWN_TEACHER']);
    expect(refusalsOf({ teachers: [{ short: null, name: null, email: null, id: 'nope' }] })).toEqual(['UNKNOWN_TEACHER']);
  });

  it('calls two people with one signature ambiguous', () => {
    const ctx = context({
      teachers: [
        { id: 'a', firstName: 'A', lastName: 'A', email: 'a@x.example', signature: 'DUP', isActive: true },
        { id: 'b', firstName: 'B', lastName: 'B', email: 'b@x.example', signature: 'DUP', isActive: true },
      ],
    });
    expect(refusalsOf({ teachers: [{ short: 'DUP', name: null, email: null, id: null }] }, ctx)).toEqual(['AMBIGUOUS_TEACHER']);
    const twoRooms = context({ rooms: [{ id: 'r1', name: 'Sal', code: null }, { id: 'r2', name: 'sal', code: null }] });
    expect(refusalsOf({ room: 'Sal' }, twoRooms)).toEqual(['AMBIGUOUS_ROOM']);
  });
});

describe('frames, raster and lunch sittings', () => {
  const frame = (over: Partial<PlanContext['frames'][number]> = {}) => ({ minGradeLevel: 7, maxGradeLevel: 9, dayOfWeek: null, startMin: 8 * 60, endMin: 15 * 60, ...over });

  it('intersects every frame the span touches, a weekday frame and an every-day frame both applying', () => {
    const frames = [frame(), frame({ dayOfWeek: 5, endMin: 13 * 60 })];
    expect(frameWindowOf(frames, { min: 7, max: 7 }, 1)).toEqual({ startMin: 480, endMin: 900 });
    expect(frameWindowOf(frames, { min: 7, max: 7 }, 5)).toEqual({ startMin: 480, endMin: 780 });
    expect(frameWindowOf(frames, { min: 1, max: 3 }, 1)).toEqual({ startMin: 0, endMin: 1440 });
    expect(frameWindowOf(frames, undefined, 1)).toEqual({ startMin: 0, endMin: 1440 });
    expect(frameWindowOf([frame(), frame({ startMin: 16 * 60, endMin: 17 * 60 })], { min: 7, max: 7 }, 1)).toBeNull();
  });

  it('refuses a lesson outside the frame, naming the group and the window', () => {
    const ctx = context({ frames: [frame()] });
    const out = fitRefusals(resolved({ start: '14:30', end: '15:30' }, ctx), ctx);
    expect(out.refusals.map((r) => [r.code, r.params['group'], r.params['frameStart'], r.params['frameEnd']])).toEqual([['OUTSIDE_FRAME', '7A', '08:00', '15:00']]);
    expect(fitRefusals(resolved({}, ctx), ctx).refusals).toEqual([]);
  });

  it('says a closed day is closed', () => {
    const ctx = context({ frames: [frame(), frame({ startMin: 16 * 60, endMin: 17 * 60 })] });
    const out = fitRefusals(resolved({}, ctx), ctx);
    expect(out.refusals[0]).toMatchObject({ code: 'OUTSIDE_FRAME', params: { closed: 'yes' } });
  });

  it('holds every group on a shared lesson to its own frame', () => {
    const ctx = context({ frames: [frame({ minGradeLevel: 7, maxGradeLevel: 7, endMin: 12 * 60 })], spans: new Map([['g-7a', { min: 7, max: 7 }], ['g-7b', { min: 8, max: 8 }]]) });
    const out = fitRefusals(resolved({ start: '11:30', end: '12:30', extraGroups: ['7B'] }, ctx), ctx);
    expect(out.refusals.map((r) => r.params['group'])).toEqual(['7A']);
  });

  it('refuses a lesson over a rast, and lets a weekday rast shadow only the every-day rasts it overlaps', () => {
    const rast = (over: Partial<PlanContext['rasts'][number]> = {}) => ({ name: 'Rast', minGradeLevel: 7, maxGradeLevel: 9, dayOfWeek: null, startMin: 9 * 60 + 40, endMin: 10 * 60, ...over });
    const rasts = [rast(), rast({ name: 'Fredagsrast', dayOfWeek: 5, startMin: 9 * 60 + 30, endMin: 9 * 60 + 50 }), rast({ name: 'Lunchrast', startMin: 12 * 60, endMin: 12 * 60 + 30 })];
    expect(rastsOf(rasts, { min: 7, max: 7 }, 1).map((r) => r.name)).toEqual(['Rast', 'Lunchrast']);
    expect(rastsOf(rasts, { min: 7, max: 7 }, 5).map((r) => r.name)).toEqual(['Fredagsrast', 'Lunchrast']);
    const ctx = context({ rasts });
    const out = fitRefusals(resolved({ start: '09:00', end: '10:00' }, ctx), ctx);
    expect(out.refusals.map((r) => [r.code, r.params['rast']])).toEqual([['IN_RAST', 'Rast']]);
  });

  it('refuses a lesson over the generator’s own lunch for the group', () => {
    const ctx = context({ sittings: [{ groupId: 'g-7a', day: 1, startMin: 11 * 60, endMin: 11 * 60 + 30 }] });
    expect(fitRefusals(resolved({ start: '10:40', end: '11:40' }, ctx), ctx).refusals.map((r) => r.code)).toEqual(['ON_LUNCH_SITTING']);
    expect(fitRefusals(resolved({ start: '10:00', end: '11:00' }, ctx), ctx).refusals).toEqual([]);
  });

  it('warns, and does not refuse, for a lesson outside the engine’s day or a group of unknown year', () => {
    const ctx = context({ frames: [frame()], spans: new Map() });
    const out = fitRefusals(resolved({ start: '07:30', end: '08:30' }, ctx), ctx);
    expect(out.refusals).toEqual([]);
    expect(out.warnings.map((w) => w.code).sort()).toEqual(['NO_GRADE_FOR_RULES', 'OUTSIDE_SOLVER_DAY']);
  });
});

describe('lunchFits', () => {
  const lunch = { enabled: true, startMin: 11 * 60, endMin: 13 * 60, minutes: 30 };
  const ctx = context({ lunch });
  const at = (start: number, end: number, weeks: 'ALL' | 'ODD' | 'EVEN' = 'ALL', groupIds = ['g-7a']) => ({ groupIds, day: 1, startMin: start, endMin: end, weeks });

  it('lets a class that is taught across the window keep a free stretch of the length', () => {
    expect(lunchFits(ctx, G7A, 1, [at(10 * 60, 11 * 60 + 30), at(12 * 60, 13 * 60)]).fits).toBe(true);
  });

  it('refuses when the lessons leave less than the lunch and names the window', () => {
    const out = lunchFits(ctx, G7A, 1, [at(10 * 60, 11 * 60 + 45), at(12 * 60 + 5, 13 * 60)]);
    expect(out).toEqual({ fits: false, window: { startMin: 660, endMin: 780 } });
  });

  it('asks nothing of a class not taught in the window, of a teaching group, or of a school without lunch', () => {
    expect(lunchFits(ctx, G7A, 1, [at(8 * 60, 10 * 60)]).fits).toBe(true);
    expect(lunchFits(ctx, G71, 1, [at(11 * 60, 13 * 60, 'ALL', ['g-71'])]).fits).toBe(true);
    expect(lunchFits(context(), G7A, 1, [at(11 * 60, 13 * 60)]).fits).toBe(true);
    expect(lunchFits(context({ lunch: { ...lunch, enabled: false } }), G7A, 1, [at(11 * 60, 13 * 60)]).fits).toBe(true);
    expect(lunchFits(context({ lunch, spans: new Map() }), G7A, 1, [at(11 * 60, 13 * 60)]).fits).toBe(true);
  });

  it('judges the odd and the even weeks apart', () => {
    // Two lessons that fill the window, but in different weeks: each week keeps its lunch.
    expect(lunchFits(ctx, G7A, 1, [at(11 * 60, 12 * 60, 'ODD'), at(12 * 60, 13 * 60, 'EVEN')]).fits).toBe(true);
    expect(lunchFits(ctx, G7A, 1, [at(11 * 60, 12 * 60, 'ODD'), at(12 * 60, 13 * 60, 'ODD')]).fits).toBe(false);
  });

  it('reads the stage’s servings in place of the school’s window, and a weekday serving replaces the every-day ones', () => {
    const servings = [
      { minGradeLevel: 7, maxGradeLevel: 9, dayOfWeek: null, startMin: 11 * 60, endMin: 11 * 60 + 40 },
      { minGradeLevel: 7, maxGradeLevel: 9, dayOfWeek: 1, startMin: 12 * 60, endMin: 12 * 60 + 40 },
    ];
    const c = context({ lunch, servings });
    // Monday: only 12:00–12:40 counts, so a lesson across 11:00–11:40 is nobody’s lunch problem.
    expect(lunchFits(c, G7A, 1, [at(11 * 60, 11 * 60 + 40)]).fits).toBe(true);
    expect(lunchFits(c, G7A, 1, [at(12 * 60, 12 * 60 + 40)]).fits).toBe(false);
    // Tuesday: the every-day serving.
    expect(lunchFits(c, G7A, 2, [{ ...at(11 * 60, 11 * 60 + 40), day: 2 }]).fits).toBe(false);
  });

  it('with two servings in a day, a free stretch in either is a lunch', () => {
    const servings = [
      { minGradeLevel: 7, maxGradeLevel: 9, dayOfWeek: null, startMin: 11 * 60, endMin: 11 * 60 + 40 },
      { minGradeLevel: 7, maxGradeLevel: 9, dayOfWeek: null, startMin: 12 * 60, endMin: 12 * 60 + 40 },
    ];
    const c = context({ lunch, servings });
    expect(lunchFits(c, G7A, 1, [at(11 * 60, 11 * 60 + 40)]).fits).toBe(true);
    expect(lunchFits(c, G7A, 1, [at(11 * 60, 12 * 60 + 40)]).fits).toBe(false);
  });
});

describe('matchExisting and changesOf', () => {
  const existing = (over: Partial<ExistingLesson> = {}): ExistingLesson => ({
    id: 'm1',
    groupId: 'g-7a',
    subjectId: 's-ma',
    teacherId: 't-abe',
    coTeacherId: null,
    roomId: 'r-101',
    day: 1,
    startMin: 490,
    endMin: 550,
    weeks: 'ALL',
    from: null,
    to: null,
    extraGroupIds: [],
    isLocked: false,
    isGenerated: true,
    ...over,
  });

  it('pairs a row with the school’s lesson by id first and by key after, each lesson once', () => {
    const a = resolved({ ids: { lesson: 'm2' } });
    const b = resolved({});
    const c = resolved({});
    const found = matchExisting([a, b, c, null], [existing(), existing({ id: 'm2', day: 2 })]);
    expect(found.map((e) => e?.id ?? null)).toEqual(['m2', 'm1', null, null]);
  });

  it('prefers the exact twin when two lessons share a key', () => {
    const row = resolved({ room: 'Gymnastiksalen' });
    const found = matchExisting([row], [existing({ id: 'plain' }), existing({ id: 'twin', roomId: 'r-gym' })]);
    expect(found[0]?.id).toBe('twin');
  });

  it('says in words what differs, and nothing when nothing does', () => {
    const row = resolved({});
    expect(changesOf(existing(), row)).toEqual([]);
    expect(
      changesOf(
        existing({ groupId: 'g-7b', subjectId: 's-sv', day: 2, teacherId: 't-blu', roomId: null, weeks: 'ODD', from: '2026-09-01', extraGroupIds: ['g-71'] }),
        row,
      ),
    ).toEqual(['grupp', 'ämne', 'tid', 'lärare', 'sal', 'veckomönster', 'period', 'ytterligare klasser']);
    expect(changesOf(existing({ endMin: 540 }), row)).toEqual(['tid']);
    expect(changesOf(existing({ coTeacherId: 't-blu' }), row)).toEqual(['lärare']);
  });
});

describe('deriveRequirements', () => {
  const fin = (over: Partial<FinalLesson> = {}): FinalLesson => ({ groupId: 'g-7a', subjectId: 's-ma', teacherId: 't-abe', coTeacherId: null, startMin: 490, endMin: 550, weeks: 'ALL', from: null, to: null, block: null, ...over });
  const touched = new Set(['g-7a|s-ma', 'g-7a|s-sv', 'g-7b|s-ma']);

  it('derives a post from the lessons: how many, how long, who', () => {
    const { plans, warnings } = deriveRequirements([fin(), fin({ startMin: 600, endMin: 660 }), fin({ startMin: 700, endMin: 740 })], context(), touched);
    expect(warnings).toEqual([]);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ action: 'CREATE', groupName: '7A', subjectName: 'Matematik', lessonsPerWeek: 3, minutesPerLesson: 60, lessonLengths: [60, 60, 40], teacherId: 't-abe', recurrence: 'ALL' });
  });

  it('leaves lengths empty when every lesson is as long as the next, and carries weeks and period', () => {
    const { plans } = deriveRequirements([fin({ weeks: 'ODD', from: '2026-08-17', to: '2026-12-18', coTeacherId: 't-blu', block: 'Språkval' })], context(), touched);
    expect(plans[0]).toMatchObject({ lessonLengths: [], recurrence: 'ODD', from: '2026-08-17', to: '2026-12-18', coTeacherId: 't-blu', block: 'Språkval' });
  });

  it('derives nothing, and says why, when the lessons state more than one window', () => {
    const { plans, warnings } = deriveRequirements([fin({ weeks: 'ODD' }), fin({ weeks: 'EVEN', startMin: 600, endMin: 660 })], context(), touched);
    expect(plans[0]!.action).toBe('SKIP');
    expect(warnings.map((w) => w.code)).toEqual(['REQ_WINDOWS_DIFFER']);
  });

  it('derives nothing for a post with more lengths than a post holds', () => {
    const lessons = [60, 55, 50, 45].map((m, i) => fin({ startMin: 480 + i * 100, endMin: 480 + i * 100 + m }));
    const { plans, warnings } = deriveRequirements(lessons, context(), touched);
    expect(plans[0]!.action).toBe('SKIP');
    expect(warnings.map((w) => w.code)).toEqual(['REQ_TOO_MANY_LENGTHS']);
  });

  it('derives nothing for a lesson no post can hold, shorter than 15 or longer than 240 minutes', () => {
    for (const minutes of [10, 245]) {
      const { plans, warnings } = deriveRequirements([fin({ endMin: 490 + minutes })], context(), touched);
      expect(plans[0]!.action).toBe('SKIP');
      expect(warnings.map((w) => w.code)).toEqual(['REQ_LENGTH_OUT_OF_RANGE']);
    }
    expect(deriveRequirements([fin({ endMin: 490 + 240 }), fin({ startMin: 600, endMin: 615 })], context(), touched).plans[0]!.action).toBe('CREATE');
  });

  it('gives the post the commonest teacher and names the others', () => {
    const { plans, warnings } = deriveRequirements([fin({ teacherId: 't-blu' }), fin({ teacherId: 't-abe', startMin: 600, endMin: 660 }), fin({ teacherId: 't-abe', startMin: 700, endMin: 760 })], context(), touched);
    expect(plans[0]!.teacherId).toBe('t-abe');
    expect(warnings.map((w) => [w.code, w.params['teachers']])).toEqual([['REQ_TEACHERS_DIFFER', 'BLU, ABE']]);
  });

  it('drops a co-teacher that is not on every lesson, and a co-teacher who is also the lead', () => {
    const mixed = deriveRequirements([fin({ coTeacherId: 't-blu' }), fin({ startMin: 600, endMin: 660 })], context(), touched);
    expect(mixed.plans[0]!.coTeacherId).toBeNull();
    expect(mixed.warnings.map((w) => w.code)).toEqual(['REQ_CO_TEACHERS_DIFFER']);
    const same = deriveRequirements([fin({ coTeacherId: 't-abe' })], context(), touched);
    expect(same.plans[0]!.coTeacherId).toBeNull();
  });

  it('never changes a post the school has, and says when the lessons disagree with it', () => {
    const post = { id: 'q1', groupId: 'g-7a', subjectId: 's-ma', teacherId: 't-blu', coTeacherId: null, lessonsPerWeek: 3, minutesPerLesson: 60, lessonLengths: [], recurrence: 'ALL' as const, from: null, to: null, blockId: null };
    const ctx = context({ requirements: [post] });
    const same = deriveRequirements([fin(), fin({ startMin: 600, endMin: 660 }), fin({ startMin: 700, endMin: 760 })], ctx, touched);
    expect(same.plans[0]).toMatchObject({ action: 'KEEP', existingId: 'q1', teacherId: 't-blu' });
    expect(same.warnings).toEqual([]);
    const fewer = deriveRequirements([fin()], ctx, touched);
    expect(fewer.plans[0]!.action).toBe('KEEP');
    expect(fewer.warnings.map((w) => w.code)).toEqual(['REQ_DIFFERS_FROM_POST']);
    // A post whose lessons are split ({60,40}) reads as that, not as lessonsPerWeek × minutes.
    const split = context({ requirements: [{ ...post, lessonsPerWeek: 2, minutesPerLesson: 60, lessonLengths: [60, 40] }] });
    expect(deriveRequirements([fin(), fin({ startMin: 600, endMin: 640 })], split, touched).warnings).toEqual([]);
    const windows = deriveRequirements([fin({ weeks: 'ODD' }), fin({ weeks: 'EVEN', startMin: 600, endMin: 660 })], ctx, touched);
    expect(windows.plans[0]).toMatchObject({ action: 'KEEP', existingId: 'q1' });
  });

  it('asks only about the pairs the import touched', () => {
    const { plans } = deriveRequirements([fin(), fin({ groupId: 'g-7b' }), fin({ subjectId: 's-id1' })], context(), new Set(['g-7b|s-ma']));
    expect(plans.map((p) => `${p.groupName}|${p.subjectName}`)).toEqual(['7B|Matematik']);
  });
});

describe('planFingerprint', () => {
  const row = (over: Partial<PlanRow> = {}): PlanRow => ({ ref: 'rad 2', label: 'x', action: 'CREATE', refusals: [], changes: [], existingId: null, resolved: resolved({}), ...over });

  it('is the same for the same plan and different when anything the school would be shown differs', () => {
    const base = planFingerprint([row()], []);
    expect(planFingerprint([row()], [])).toBe(base);
    expect(base).toMatch(/^[0-9a-f]{32}$/);
    expect(planFingerprint([row({ action: 'UNCHANGED' })], [])).not.toBe(base);
    expect(planFingerprint([row({ ref: 'rad 3' })], [])).not.toBe(base);
    expect(planFingerprint([row({ resolved: resolved({ room: 'Gymnastiksalen' }) })], [])).not.toBe(base);
    expect(planFingerprint([row({ resolved: null, action: 'REFUSED', refusals: [{ code: 'UNKNOWN_GROUP', params: {}, detail: '' }] })], [])).not.toBe(base);
    const post = deriveRequirements([{ groupId: 'g-7a', subjectId: 's-ma', teacherId: null, coTeacherId: null, startMin: 490, endMin: 550, weeks: 'ALL', from: null, to: null, block: null }], context(), new Set(['g-7a|s-ma'])).plans;
    expect(planFingerprint([row()], post)).not.toBe(base);
  });
});
