import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoadQualification } from '../staffing/teacher-load';
import type { AiEngineScheduleRequest, AnonymousRequirement } from './interfaces/ai-engine-payload.interface';
import type { AiEngineWeekCheckResponse } from './interfaces/week-check.interface';
import {
  candidatesOf,
  countOf,
  derivedId,
  judgedDay,
  lessonMinutesOf,
  percentOf,
  periodOf,
  periodOfTightWeek,
  qualifiedHolders,
  rankingFigure,
  releasePosts,
  shareWithSecond,
  spanOf,
  type RealisedAnswer,
} from './week-check-choice';
import type { PeriodStretch } from './year-periods';

/**
 * Kontrollera veckan med lärarval, the pure half: what is asked of the engine
 * (the floor, a second teacher) and how its answer is read (a count, its period).
 * The engine itself is asked about the same payloads by
 * optimization-engine/tests/test_week_check_choice.py, through the fixture this
 * file writes (the last describe).
 */

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const T3 = '33333333-3333-4333-8333-333333333333';

let counter = 0;
const post = (overrides: Partial<AnonymousRequirement> = {}): AnonymousRequirement => {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    subjectId: 'subject-anon',
    studentGroupId: 'group-anon',
    teacherId: T1,
    lessonsPerWeek: 2,
    minutesPerLesson: 40,
    minutesBefore: 0,
    minutesAfter: 0,
    studentGroupSize: 20,
    requiredRoomType: null,
    coTeacherId: null,
    minGradeLevel: 9,
    maxGradeLevel: 9,
    ...overrides,
  };
};

const payloadOf = (requirements: AnonymousRequirement[]): AiEngineScheduleRequest =>
  ({
    requestId: 'request',
    academicYearId: 'year',
    requirements,
    rooms: [],
    constraints: [],
    teacherWorkRules: [],
    groupConflicts: [],
  }) as unknown as AiEngineScheduleRequest;

beforeEach(() => {
  counter = 0;
});

describe('derivedId', () => {
  it('is the same every time, differs by seed and label, and is a UUID of version 4 (the engine validates them as such)', () => {
    const id = derivedId('post-1', 'own-teacher');
    expect(derivedId('post-1', 'own-teacher')).toBe(id);
    expect(derivedId('post-2', 'own-teacher')).not.toBe(id);
    expect(derivedId('post-1', 'second')).not.toBe(id);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('lessonMinutesOf and spanOf', () => {
  it('counts a uniform post as lessons x minutes and a split post as the sum of its lengths', () => {
    expect(lessonMinutesOf(post({ lessonsPerWeek: 3, minutesPerLesson: 50 }))).toBe(150);
    expect(lessonMinutesOf(post({ lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] }))).toBe(120);
  });

  it('reads the years of a group, or null when they are unknown', () => {
    expect(spanOf(post({ minGradeLevel: 7, maxGradeLevel: 9 }))).toEqual({ min: 7, max: 9 });
    expect(spanOf(post({ minGradeLevel: null, maxGradeLevel: null }))).toBeNull();
    expect(spanOf(post({ minGradeLevel: 7, maxGradeLevel: null }))).toBeNull();
  });
});

describe('qualifiedHolders and judgedDay', () => {
  const held = (overrides: Partial<LoadQualification>): LoadQualification => ({
    userId: 'u1',
    subjectId: 's1',
    minGradeLevel: 7,
    maxGradeLevel: 9,
    kind: 'BEHORIG',
    validFrom: null,
    validTo: null,
    ...overrides,
  });

  it('counts teachers, not rows: two rows of one teacher are one', () => {
    const rows = [held({}), held({ kind: 'TILLATEN' }), held({ userId: 'u2' })];
    expect(qualifiedHolders(rows, 's1', { min: 9, max: 9 }, '2026-11-19')).toBe(2);
  });

  it('wants the whole span of the group inside the behörighet, and the subject to be the same', () => {
    const rows = [held({ minGradeLevel: 7, maxGradeLevel: 8 }), held({ userId: 'u2', subjectId: 's2' })];
    expect(qualifiedHolders(rows, 's1', { min: 9, max: 9 }, '2026-11-19')).toBe(0);
    expect(qualifiedHolders(rows, 's1', { min: 7, max: 8 }, '2026-11-19')).toBe(1);
    expect(qualifiedHolders(rows, 's1', { min: 7, max: 9 }, '2026-11-19')).toBe(0);
  });

  it('lets any behörighet in the subject cover a group whose years are unknown', () => {
    expect(qualifiedHolders([held({ minGradeLevel: 1, maxGradeLevel: 3 })], 's1', null, '2026-11-19')).toBe(1);
  });

  it('judges validity on the day, not "sometime in the läsår": an ended one does not count, one that starts later does not yet', () => {
    const ended = held({ userId: 'u2', validTo: '2026-10-31' });
    const starts = held({ userId: 'u3', validFrom: '2027-01-01' });
    expect(qualifiedHolders([ended, starts, held({})], 's1', { min: 9, max: 9 }, '2026-11-19')).toBe(1);
    expect(qualifiedHolders([ended, starts, held({})], 's1', { min: 9, max: 9 }, '2027-01-01')).toBe(2);
  });

  it('judges a year not begun on its first day and a year past on its last', () => {
    expect(judgedDay('2026-06-01', '2026-08-17', '2027-06-11')).toBe('2026-08-17');
    expect(judgedDay('2026-11-19', '2026-08-17', '2027-06-11')).toBe('2026-11-19');
    expect(judgedDay('2027-08-01', '2026-08-17', '2027-06-11')).toBe('2027-06-11');
  });
});

describe('the floor: releasePosts', () => {
  it('gives a teacher of their own to every post that has two or more qualified, and leaves the rest as they were', () => {
    const free = post({ teacherId: T1, subjectId: 'a' });
    const alone = post({ teacherId: T2, subjectId: 'b' });
    const payload = payloadOf([free, alone]);

    const out = releasePosts(payload, (requirement) => (requirement.subjectId === 'a' ? 2 : 1));

    expect(out.released).toEqual([free.id]);
    const [changed, same] = out.payload.requirements;
    expect(changed!.teacherId).not.toBe(T1);
    expect(changed!.teacherId).toBe(derivedId(free.id, 'own-teacher'));
    expect(same).toBe(alone);
    // Nothing else of the payload is touched, and the payload it was made from is not.
    expect({ ...out.payload, requirements: [] }).toEqual({ ...payload, requirements: [] });
    expect(payload.requirements[0]!.teacherId).toBe(T1);
  });

  it('gives each post a teacher of its own, so two posts of one teacher no longer share one', () => {
    const a = post({ teacherId: T1 });
    const b = post({ teacherId: T1 });
    const out = releasePosts(payloadOf([a, b]), () => 2);
    const [x, y] = out.payload.requirements;
    expect(new Set([x!.teacherId, y!.teacherId]).size).toBe(2);
    expect([x!.teacherId, y!.teacherId]).not.toContain(T1);
  });

  it('moves only the lead: the co-teacher stays, and so does every lesson another teacher takes', () => {
    const shared = post({ teacherId: T1, coTeacherId: T3, lessonTeacherIds: [T1, T2, T1, null] });
    const out = releasePosts(payloadOf([shared]), () => 2);
    const own = derivedId(shared.id, 'own-teacher');
    const [changed] = out.payload.requirements;
    expect(changed!.coTeacherId).toBe(T3);
    expect(changed!.lessonTeacherIds).toEqual([own, T2, own, null]);
    expect(changed!.teacherId).toBe(own);
  });

  it('leaves a post with no teacher alone (Generera refuses such a week before the engine is asked)', () => {
    const out = releasePosts(payloadOf([post({ teacherId: null })]), () => 5);
    expect(out.released).toEqual([]);
  });

  it('releases nothing when nobody has a choice', () => {
    const out = releasePosts(payloadOf([post(), post()]), () => 1);
    expect(out.released).toEqual([]);
    expect(out.payload.requirements).toEqual(payloadOf([post(), post()]).requirements.map((r, i) => ({ ...r, id: out.payload.requirements[i]!.id })));
  });
});

describe('candidatesOf: where a second teacher would be asked about', () => {
  const subjects = (...pairs: [AnonymousRequirement, string][]) => new Map(pairs.map(([r, s]) => [r.id, s]));

  it('takes, per subject of a tight year, the teacher who carries most, and ranks the subjects by that', () => {
    const h1 = post({ teacherId: T1, lessonsPerWeek: 4, minutesPerLesson: 40 });
    const h2 = post({ teacherId: T1, lessonsPerWeek: 4, minutesPerLesson: 40 });
    const h3 = post({ teacherId: T2, lessonsPerWeek: 4, minutesPerLesson: 40 });
    const h4 = post({ teacherId: T2, lessonsPerWeek: 4, minutesPerLesson: 40 });
    const h5 = post({ teacherId: T2, lessonsPerWeek: 4, minutesPerLesson: 40 });
    const m1 = post({ teacherId: T3, lessonsPerWeek: 5, minutesPerLesson: 40 });
    const m2 = post({ teacherId: T3, lessonsPerWeek: 5, minutesPerLesson: 40 });
    const map = subjects([h1, 'hkk'], [h2, 'hkk'], [h3, 'hkk'], [h4, 'hkk'], [h5, 'hkk'], [m1, 'musik'], [m2, 'musik']);

    const found = candidatesOf([h1, h2, h3, h4, h5, m1, m2], [9], map);

    // Hemkunskap's T2 carries 480 (three posts), Musik's T3 400 (two): T1's 320 is not the heaviest of its subject.
    expect(found.map((c) => [c.subjectId, c.teacherId, c.minutes])).toEqual([
      ['hkk', T2, 480],
      ['musik', T3, 400],
    ]);
  });

  it('shares the posts in the order of their minutes, each to the one with least so far, so both carry about the same and the split is the same every time', () => {
    const big = post({ lessonsPerWeek: 5, minutesPerLesson: 60 });
    const mid1 = post({ lessonsPerWeek: 3, minutesPerLesson: 60 });
    const mid2 = post({ lessonsPerWeek: 3, minutesPerLesson: 60 });
    const small = post({ lessonsPerWeek: 1, minutesPerLesson: 60 });
    const map = subjects([big, 's'], [mid1, 's'], [mid2, 's'], [small, 's']);

    const [candidate] = candidatesOf([small, mid2, big, mid1], [9], map);

    expect(candidate!.postIds).toEqual([big.id, mid1.id, mid2.id, small.id]);
    // big 300 stays; mid1 180 -> second (0 < 300); mid2 180 -> second (180 < 300); small 60 -> teacher (300 vs 360).
    expect(candidate!.moved).toEqual([mid1.id, mid2.id]);
    expect(candidatesOf([small, mid2, big, mid1], [9], map)).toEqual([candidate]);
  });

  it('never moves all of them, and never asks about one post: a post cannot be shared between posts', () => {
    const only = post();
    expect(candidatesOf([only], [9], subjects([only, 's']))).toEqual([]);
    const a = post();
    const b = post();
    const [two] = candidatesOf([a, b], [9], subjects([a, 's'], [b, 's']));
    expect(two!.moved).toHaveLength(1);
  });

  it('asks about the posts of the year only: a post of another year, or of unknown years, is not one of its teacher\'s', () => {
    const a = post({ minGradeLevel: 9, maxGradeLevel: 9 });
    const b = post({ minGradeLevel: 8, maxGradeLevel: 8 });
    const c = post({ minGradeLevel: null, maxGradeLevel: null });
    expect(candidatesOf([a, b, c], [9], subjects([a, 's'], [b, 's'], [c, 's']))).toEqual([]);
    const wide = post({ minGradeLevel: 7, maxGradeLevel: 9 });
    expect(candidatesOf([a, wide], [9], subjects([a, 's'], [wide, 's']))).toHaveLength(1);
  });

  it('leaves out a post whose subject is not known and one nobody leads', () => {
    const a = post();
    const b = post({ teacherId: null });
    expect(candidatesOf([a, b], [9], subjects([a, 's'], [b, 's']))).toEqual([]);
    expect(candidatesOf([a, post()], [9], subjects([a, 's']))).toEqual([]);
  });

  it('asks at most ten, heaviest first, and the same ten every time', () => {
    const requirements: AnonymousRequirement[] = [];
    const map = new Map<string, string>();
    for (let subject = 0; subject < 14; subject += 1) {
      for (let i = 0; i < 2; i += 1) {
        const requirement = post({ teacherId: `t-${subject}`, lessonsPerWeek: subject + 1, minutesPerLesson: 10 });
        requirements.push(requirement);
        map.set(requirement.id, `subject-${String(subject).padStart(2, '0')}`);
      }
    }
    const found = candidatesOf(requirements, [9], map);
    expect(found).toHaveLength(10);
    expect(found[0]!.subjectId).toBe('subject-13');
    expect(found[9]!.subjectId).toBe('subject-04');
    expect(candidatesOf(requirements, [9], map, 3)).toHaveLength(3);
  });

  it('asks about each tight year on its own', () => {
    const a = post({ minGradeLevel: 8, maxGradeLevel: 8 });
    const b = post({ minGradeLevel: 8, maxGradeLevel: 8 });
    const c = post({ minGradeLevel: 9, maxGradeLevel: 9 });
    const d = post({ minGradeLevel: 9, maxGradeLevel: 9 });
    const found = candidatesOf([a, b, c, d], [8, 9], subjects([a, 's'], [b, 's'], [c, 's'], [d, 's']));
    expect(found.map((x) => x.year).sort()).toEqual([8, 9]);
  });
});

describe('shareWithSecond', () => {
  it('gives the moved posts a virtual second teacher, the same one on each, and nobody else anything', () => {
    const a = post({ teacherId: T1 });
    const b = post({ teacherId: T1 });
    const c = post({ teacherId: T1 });
    const payload = payloadOf([a, b, c]);
    const candidate = { year: 9, subjectId: 's', teacherId: T1, postIds: [a.id, b.id, c.id], moved: [b.id, c.id], minutes: 240 };

    const out = shareWithSecond(payload, candidate);

    const [x, y, z] = out.requirements;
    expect(x).toBe(a);
    expect(y!.teacherId).toBe(z!.teacherId);
    expect(y!.teacherId).not.toBe(T1);
    expect(shareWithSecond(payload, candidate).requirements[1]!.teacherId).toBe(y!.teacherId);
    expect(payload.requirements[1]!.teacherId).toBe(T1);
  });
});

describe('periodOfTightWeek: which period the engine counted the tightest week in', () => {
  const stretches: PeriodStretch[][] = [
    [{ from: '2026-08-17', to: '2026-12-18' }],
    [{ from: '2027-01-11', to: '2027-06-11' }],
    [{ from: '2027-06-14', to: '2027-06-18' }],
  ];
  const everyWeek = post({ id: 'class' });
  const autumn = post({ id: 'autumn', periods: [true, false, false] });
  const spring = post({ id: 'spring', periods: [false, true, false] });
  const both = post({ id: 'both', periods: [true, true, false] });

  it('names the period whose posts of the year are exactly the ones the engine named', () => {
    expect(periodOfTightWeek([everyWeek, autumn, spring], 9, ['class', 'spring'], stretches)).toEqual({
      from: '2027-01-11',
      to: '2027-06-11',
      more: false,
    });
  });

  it('names the first stretch of days and says the period has more when the same posts run in other weeks too', () => {
    const named = periodOfTightWeek([everyWeek, both], 9, ['class', 'both'], stretches);
    expect(named).toEqual({ from: '2026-08-17', to: '2026-12-18', more: true });
    const named2 = periodOfTightWeek([everyWeek, spring], 9, ['class', 'spring'], [
      stretches[0]!,
      [{ from: '2027-01-11', to: '2027-03-12' }, { from: '2027-04-12', to: '2027-06-11' }],
      stretches[2]!,
    ]);
    expect(named2!.more).toBe(true);
  });

  it('says nothing when every period holds the same posts of the year: it is as tight in all of them', () => {
    expect(periodOfTightWeek([everyWeek, post({ id: 'other', minGradeLevel: 7, maxGradeLevel: 7, periods: [true, false, false] })], 9, ['class'], stretches)).toBeNull();
  });

  it('says nothing when no period holds exactly those posts, or the läsår is not cut into periods', () => {
    expect(periodOfTightWeek([everyWeek, autumn, spring], 9, ['class', 'autumn', 'spring'], stretches)).toBeNull();
    expect(periodOfTightWeek([everyWeek, autumn, spring], 9, ['class', 'spring'], null)).toBeNull();
    expect(periodOfTightWeek([everyWeek], 9, ['class'], [[{ from: '2026-08-17', to: '2027-06-11' }]])).toBeNull();
    expect(periodOfTightWeek([everyWeek, spring], 9, [], stretches)).toBeNull();
  });

  it('reads a post of odd weeks only as running in the odd cell of its period, and an even one in the even cell', () => {
    const odd = post({ id: 'odd', periods: [false, true, false], recurrence: 'ODD_WEEKS' });
    const even = post({ id: 'even', periods: [false, true, false], recurrence: 'EVEN_WEEKS' });
    expect(periodOfTightWeek([everyWeek, odd, even, autumn], 9, ['class', 'odd'], stretches)).toEqual({
      from: '2027-01-11',
      to: '2027-06-11',
      more: false,
    });
    expect(periodOfTightWeek([everyWeek, odd, even, autumn], 9, ['class', 'even'], stretches)).not.toBeNull();
  });

  it('counts the posts of the year only: a post of another year does not keep a period from matching', () => {
    const elsewhere = post({ id: 'elsewhere', minGradeLevel: 7, maxGradeLevel: 7, periods: [true, false, false] });
    expect(periodOfTightWeek([everyWeek, spring, elsewhere], 9, ['class', 'spring'], stretches)).not.toBeNull();
  });
});

describe('periodOf and percentOf', () => {
  it('reads the period a refusal names in its params, and nothing when it names none', () => {
    expect(periodOf({ periodFrom: '2027-01-11', periodTo: '2027-06-11', periodStretches: 2 })).toEqual({
      from: '2027-01-11',
      to: '2027-06-11',
      more: true,
    });
    expect(periodOf({ period: 1 })).toBeNull();
    expect(periodOf(null)).toBeNull();
  });

  it('rounds a percent DOWN, as the engine does: a lower bound is never rounded up', () => {
    expect(percentOf(2100, 2200)).toBe(95);
    expect(percentOf(2199, 2200)).toBe(99);
    expect(percentOf(2275, 2275)).toBe(100);
    expect(percentOf(10, 0)).toBe(0);
  });
});

describe('countOf: one year of one answer', () => {
  const stretches: PeriodStretch[][] = [
    [{ from: '2026-08-17', to: '2026-12-18' }],
    [{ from: '2027-01-11', to: '2027-06-11' }],
  ];
  const requirements = [post({ id: 'class' }), post({ id: 'spring', periods: [false, true] }), post({ id: 'autumn', periods: [true, false] })];
  const noAnswer: RealisedAnswer = { details: [], summary: null };
  const row = { year: 9, demandMinutes: 2100, capacityMinutes: 2200, percent: 95, over: false };
  const answer = (overrides: Partial<AiEngineWeekCheckResponse> = {}): AiEngineWeekCheckResponse => ({
    requestId: 'r',
    verdict: 'TIGHT',
    years: [row],
    skipped: ['LUNCH_STAGE'],
    elapsedMs: 10,
    ...overrides,
  });

  it('reads a year\'s row as its tightest period\'s week, with the period the engine\'s posts name', () => {
    const tight: RealisedAnswer = {
      details: [{ code: 'TIGHT_WEEK_LOAD', params: { grades: '9' }, requirementIds: ['class', 'spring'] }],
      summary: null,
    };
    expect(countOf(answer(), 9, tight, requirements, stretches)).toEqual({
      kind: 'LOAD',
      demandMinutes: 2100,
      capacityMinutes: 2200,
      percent: 95,
      over: false,
      atLeast: false,
      period: { from: '2027-01-11', to: '2027-06-11', more: false },
    });
  });

  it('says "at least" whenever the week load\'s seconds ran out: a deadline-stopped bound is never the value', () => {
    const count = countOf(answer({ skipped: ['LUNCH_STAGE', 'WEEK_LOAD_DEADLINE'] }), 9, noAnswer, requirements, stretches);
    expect(count).toMatchObject({ kind: 'LOAD', atLeast: true, percent: 95 });
  });

  it('names the period of a year proved over from the refusal, which says it itself', () => {
    const over = { ...row, demandMinutes: 2300, percent: 104, over: true };
    const refused: RealisedAnswer = {
      details: [],
      summary: { code: 'DEMAND_YEAR_WEEK_SHORT', params: { periodFrom: '2026-08-17', periodTo: '2026-12-18', periodStretches: 1 } },
    };
    expect(countOf(answer({ verdict: 'IMPOSSIBLE', years: [over] }), 9, refused, requirements, stretches)).toMatchObject({
      kind: 'LOAD',
      over: true,
      percent: 104,
      period: { from: '2026-08-17', to: '2026-12-18', more: false },
    });
  });

  it('a year with no row is UNDER the tight threshold when the count finished, and UNKNOWN when the seconds ran out', () => {
    expect(countOf(answer({ verdict: 'OK', years: [] }), 9, noAnswer, requirements, stretches)).toEqual({ kind: 'UNDER', below: 85 });
    expect(countOf(answer({ verdict: 'OK', years: [], skipped: ['LUNCH_STAGE', 'WEEK_LOAD_DEADLINE'] }), 9, noAnswer, requirements, stretches)).toEqual({ kind: 'UNKNOWN' });
  });

  it('a week another count refuses has no year figure and says by which sentence', () => {
    const refused: RealisedAnswer = { details: [], summary: { code: 'DEMAND_CLIQUE_HOURS_SHORT', params: { grades: '9' } } };
    expect(countOf(answer({ verdict: 'IMPOSSIBLE', years: [] }), 9, refused, requirements, stretches)).toEqual({
      kind: 'REFUSED',
      code: 'DEMAND_CLIQUE_HOURS_SHORT',
      params: { grades: '9' },
    });
  });

  it('reads the row of the year asked for, and not another\'s', () => {
    const other = { ...row, year: 8 };
    expect(countOf(answer({ years: [other] }), 9, noAnswer, requirements, stretches)).toEqual({ kind: 'UNDER', below: 85 });
  });
});

describe('rankingFigure', () => {
  it('ranks by the unrounded week, so two weeks in one whole percent are still told apart', () => {
    const load = (demandMinutes: number) => ({
      kind: 'LOAD' as const, demandMinutes, capacityMinutes: 2200, percent: percentOf(demandMinutes, 2200), over: false, atLeast: false, period: null,
    });
    expect(load(2100).percent).toBe(load(2101).percent);
    expect(rankingFigure(load(2100))!).toBeLessThan(rankingFigure(load(2101))!);
  });

  it('is nothing for a count the seconds cut, an unknown one and a refused one: they are listed, never ranked', () => {
    expect(rankingFigure({ kind: 'LOAD', demandMinutes: 2000, capacityMinutes: 2200, percent: 90, over: false, atLeast: true, period: null })).toBeNull();
    expect(rankingFigure({ kind: 'UNKNOWN' })).toBeNull();
    expect(rankingFigure({ kind: 'REFUSED', code: 'X', params: {} })).toBeNull();
  });

  it('puts a year under the tight threshold before every year over it', () => {
    const under = rankingFigure({ kind: 'UNDER', below: 85 })!;
    expect(under).toBeLessThan(85);
    expect(under).toBeLessThan(rankingFigure({ kind: 'LOAD', demandMinutes: 1870, capacityMinutes: 2200, percent: 85, over: false, atLeast: false, period: null })!);
  });
});

/*
 * THE FIXTURE THE ENGINE IS ASKED ABOUT. A two-period week (year 9, five home
 * classes, five Hemkunskap groups, the spring's three led by one teacher) and
 * the payloads this file's code makes of it. optimization-engine/tests/
 * test_week_check_choice.py reads the same file and asks the engine's
 * /check-week about each, so a payload the engine would refuse (a derived id it
 * does not accept, a field it does not know) fails there, and a period this
 * file names is held to the posts the engine really names for the week.
 *
 * WEEK_CHECK_CHOICE_WRITE=1 npx jest src/optimization/week-check-choice.spec.ts
 * writes it; without, a file that is not what the code makes fails.
 */
describe('the fixture the engine is asked about', () => {
  const path = join(__dirname, '__fixtures__', 'week-check-choice-cases.json');
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as {
    about: string;
    base: AiEngineScheduleRequest;
    qualified: Record<string, number>;
    stretches: PeriodStretch[][];
    tightWeek: { year: number; heldIds: string[]; period?: unknown };
    floor?: unknown;
    whatIf?: unknown;
    released?: string[];
  };

  const made = () => {
    const subjectOf = new Map(fixture.base.requirements.map((requirement) => [requirement.id, requirement.subjectId]));
    const floor = releasePosts(fixture.base, (requirement) => fixture.qualified[requirement.subjectId] ?? 1);
    const whatIf = candidatesOf(fixture.base.requirements, [fixture.tightWeek.year], subjectOf).map((candidate) => ({
      subjectId: candidate.subjectId,
      year: candidate.year,
      moved: candidate.moved,
      payload: shareWithSecond(fixture.base, candidate),
    }));
    const period = periodOfTightWeek(fixture.base.requirements, fixture.tightWeek.year, fixture.tightWeek.heldIds, fixture.stretches);
    return {
      ...fixture,
      floor: floor.payload,
      released: floor.released,
      whatIf,
      tightWeek: { ...fixture.tightWeek, period },
    };
  };

  it('is what the code makes of its base', () => {
    const wanted = made();
    if (process.env.WEEK_CHECK_CHOICE_WRITE === '1') {
      writeFileSync(path, `${JSON.stringify(wanted, null, 1)}\n`);
    }
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(JSON.parse(JSON.stringify(wanted)));
  });

  it('releases the five Hemkunskap groups, names the spring as the tightest period, and asks about one second teacher', () => {
    const wanted = made();
    expect(wanted.released).toHaveLength(5);
    expect(wanted.tightWeek.period).toEqual({ from: '2027-01-11', to: '2027-06-11', more: false });
    expect(wanted.whatIf).toHaveLength(1);
    expect(wanted.whatIf[0]!.moved).toHaveLength(1);
  });
});
