import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASIS_PARTS, type BasisParts } from './candidate-basis';
import type { AiEngineScheduleRequest, AnonymousRequirement } from './interfaces/ai-engine-payload.interface';
import type { ChoiceCount } from './interfaces/week-check-choice.interface';
import {
  MAX_YEARS_SHOWN,
  compareCounts,
  isWorse,
  overlayLeads,
  weekBasisOf,
  withWeekBasis,
  yearsToShow,
  type LeadChange,
  type PayloadIds,
} from './staffing-week';
import { derivedId, rankingFigure } from './week-check-choice';

/**
 * Föreslå bemanning, the week before and after: the pure half. What is laid over the payload (and that nothing is
 * changed when nothing is proposed), when a year after is set beside a year before (and, above all, when it is NOT: a
 * proposal that makes the week tighter is never shown as better, and neither is one nobody can tell), and the digest an
 * apply carries.
 */

// The payload's own ids ("anonymous"), and the real ones a proposal speaks in.
const A = { eva: 'aaaaaaaa-0000-4000-8000-00000000000a', ola: 'bbbbbbbb-0000-4000-8000-00000000000b', nils: 'cccccccc-0000-4000-8000-00000000000c' };
const REAL = { eva: 'e1e1e1e1-0000-4000-8000-0000000000e1', ola: 'e2e2e2e2-0000-4000-8000-0000000000e2', nils: 'e3e3e3e3-0000-4000-8000-0000000000e3', newbie: 'e4e4e4e4-0000-4000-8000-0000000000e4', newbie2: 'e5e5e5e5-0000-4000-8000-0000000000e5' };
const REQ = (n: number): string => `r0r0r0r0-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ANON_REQ = (n: number): string => `a0a0a0a0-0000-4000-8000-${String(n).padStart(12, '0')}`;

const post = (n: number, overrides: Partial<AnonymousRequirement> = {}): AnonymousRequirement => ({
  id: ANON_REQ(n),
  subjectId: 'subject',
  studentGroupId: 'group',
  teacherId: A.eva,
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
});

const payloadOf = (requirements: AnonymousRequirement[]): AiEngineScheduleRequest =>
  ({
    requestId: '12345678-0000-4000-8000-123456789012',
    academicYearId: 'year',
    requirements,
    rooms: [],
    constraints: [],
    teacherWorkRules: [],
    groupConflicts: [],
  }) as unknown as AiEngineScheduleRequest;

const ids = (extra: Partial<Record<'teachers' | 'posts', [string, string][]>> = {}): PayloadIds => ({
  requirementOf: new Map([1, 2, 3, 4].map((n) => [REQ(n), ANON_REQ(n)] as [string, string]).concat(extra.posts ?? [])),
  teacherOf: new Map<string, string>([
    [REAL.eva, A.eva],
    [REAL.ola, A.ola],
    [REAL.nils, A.nils],
    ...(extra.teachers ?? []),
  ]),
});

const change = (n: number, from: string | null, to: string): LeadChange => ({ requirementId: REQ(n), fromTeacherId: from, toTeacherId: to });

/** Freezes a value all the way down: a function that mutates its input throws instead of passing silently. */
const frozen = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as object)) frozen(inner);
  }
  return value;
};

describe('overlayLeads', () => {
  it('returns the payload ITSELF when nothing is proposed, so what is sent is byte for byte what it was', () => {
    const payload = frozen(payloadOf([post(1), post(2, { teacherId: A.ola })]));
    const before = JSON.stringify(payload);

    const out = overlayLeads(payload, [], ids());

    expect(out.payload).toBe(payload);
    expect(JSON.stringify(out.payload)).toBe(before);
    expect(out.overlay).toEqual({ given: 0, laidOver: 0, notLaidOver: 0, fromNobody: 0, newToTheWeek: 0 });
  });

  it('returns the payload itself too when no change is laid over a post of the week (a post the engine is not sent)', () => {
    const payload = frozen(payloadOf([post(1)]));

    const out = overlayLeads(payload, [change(3, REAL.eva, REAL.ola)], ids());

    expect(out.payload).toBe(payload);
    expect(out.overlay).toEqual({ given: 1, laidOver: 0, notLaidOver: 1, fromNobody: 0, newToTheWeek: 0 });
  });

  it('lays a proposed lead over its post and changes nothing else: every other entry is the very object it was', () => {
    const payload = frozen(payloadOf([post(1), post(2, { teacherId: A.ola }), post(3, { teacherId: A.nils })]));

    const out = overlayLeads(payload, [change(1, REAL.eva, REAL.ola)], ids());

    expect(out.overlay).toEqual({ given: 1, laidOver: 1, notLaidOver: 0, fromNobody: 0, newToTheWeek: 0 });
    expect(out.payload.requirements[0]).toEqual({ ...post(1), teacherId: A.ola });
    expect(out.payload.requirements[1]).toBe(payload.requirements[1]);
    expect(out.payload.requirements[2]).toBe(payload.requirements[2]);
    expect({ ...out.payload, requirements: [] }).toEqual({ ...payload, requirements: [] });
    // The payload it was given is not touched (it is frozen: a write would have thrown).
    expect(payload.requirements[0]!.teacherId).toBe(A.eva);
  });

  it('lays a lead over a post nobody teaches, and counts it: its week before is counted with no teacher on it', () => {
    const payload = frozen(payloadOf([post(1, { teacherId: null }), post(2)]));

    const out = overlayLeads(payload, [change(1, null, REAL.eva)], ids());

    expect(out.payload.requirements[0]!.teacherId).toBe(A.eva);
    expect(out.overlay).toMatchObject({ laidOver: 1, fromNobody: 1 });
  });

  it('moves only the LEAD of a shared post: the lessons another teacher takes, and the co-teacher, stay', () => {
    const shared = post(1, { teacherId: A.eva, coTeacherId: A.nils, lessonTeacherIds: [A.eva, A.ola, A.eva] });
    const payload = frozen(payloadOf([shared]));

    const out = overlayLeads(payload, [change(1, REAL.eva, REAL.ola)], ids());

    // Ola already takes one lesson: the trigger's rule (d) refuses the proposal itself, so it is left out, never half-laid.
    expect(out.payload).toBe(payload);
    expect(out.overlay).toMatchObject({ laidOver: 0, notLaidOver: 1 });

    const other = overlayLeads(payload, [change(1, REAL.eva, REAL.newbie)], ids());
    const minted = other.payload.requirements[0]!.teacherId!;
    expect(other.payload.requirements[0]).toEqual({
      ...shared,
      teacherId: minted,
      lessonTeacherIds: [minted, A.ola, minted],
    });
    expect(other.payload.requirements[0]!.coTeacherId).toBe(A.nils);
  });

  it('leaves a change out when the payload does not carry its from-lead on the post: a shared post whose lead lessons are all locked is one teacher\'s with no list', () => {
    // The post's real lead is Eva, but the payload carries Ola (a share's teacher): replacing Ola would take a lesson from the wrong person.
    const payload = frozen(payloadOf([post(1, { teacherId: A.ola })]));

    const out = overlayLeads(payload, [change(1, REAL.eva, REAL.nils)], ids());

    expect(out.payload).toBe(payload);
    expect(out.overlay).toMatchObject({ laidOver: 0, notLaidOver: 1 });
  });

  it('leaves a change out when its from-lead is a teacher the payload does not name, and when the post is nobody\'s but the change says somebody\'s', () => {
    const payload = frozen(payloadOf([post(1, { teacherId: null }), post(2)]));

    const unnamed = overlayLeads(payload, [change(2, REAL.newbie, REAL.ola)], ids());
    const mistaken = overlayLeads(payload, [change(2, null, REAL.ola)], ids());

    expect(unnamed.overlay.laidOver).toBe(0);
    expect(mistaken.overlay.laidOver).toBe(0);
  });

  it('gives a teacher the payload does not name one id minted for the call, the same on all their posts, and counts the teacher once', () => {
    const payload = frozen(payloadOf([post(1, { teacherId: null }), post(2, { teacherId: null }), post(3, { teacherId: null })]));

    const out = overlayLeads(payload, [change(1, null, REAL.newbie), change(2, null, REAL.newbie), change(3, null, REAL.newbie2)], ids());

    const [first, second, third] = out.payload.requirements.map((requirement) => requirement.teacherId!);
    expect(first).toBe(second);
    expect(third).not.toBe(first);
    expect([A.eva, A.ola, A.nils]).not.toContain(first);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(out.overlay.newToTheWeek).toBe(2);
    // The same each time and independent of the order the changes come in, and no real id is in what is minted.
    const reversed = overlayLeads(payload, [change(3, null, REAL.newbie2), change(2, null, REAL.newbie), change(1, null, REAL.newbie)], ids());
    expect(reversed.payload.requirements.map((requirement) => requirement.teacherId)).toEqual([first, second, third]);
    expect(first).toBe(derivedId(payload.requestId, 'proposed-teacher:0'));
    expect(JSON.stringify(out.payload)).not.toContain('e4e4e4e4');
  });

  it('leaves a post out that would have its new lead as its co-teacher', () => {
    const payload = frozen(payloadOf([post(1, { coTeacherId: A.ola })]));

    const out = overlayLeads(payload, [change(1, REAL.eva, REAL.ola)], ids());

    expect(out.payload).toBe(payload);
    expect(out.overlay.notLaidOver).toBe(1);
  });

  it('says which years the laid-over posts are in, from their spans, or null when a post\'s years are not known', () => {
    const payload = frozen(
      payloadOf([post(1, { minGradeLevel: 7, maxGradeLevel: 8 }), post(2, { minGradeLevel: 9, maxGradeLevel: 9 }), post(3, { minGradeLevel: null, maxGradeLevel: null })]),
    );

    expect(overlayLeads(payload, [change(1, REAL.eva, REAL.ola), change(2, REAL.eva, REAL.ola)], ids()).years).toEqual([7, 8, 9]);
    expect(overlayLeads(payload, [change(2, REAL.eva, REAL.ola)], ids()).years).toEqual([9]);
    expect(overlayLeads(payload, [change(3, REAL.eva, REAL.ola)], ids()).years).toBeNull();
  });
});

describe('compareCounts', () => {
  const load = (percent: number, flags: Partial<Extract<ChoiceCount, { kind: 'LOAD' }>> = {}): ChoiceCount => ({
    kind: 'LOAD',
    demandMinutes: percent * 20,
    capacityMinutes: 2000,
    percent,
    over: false,
    atLeast: false,
    period: null,
    ...flags,
  });
  const over = (percent: number, flags: Partial<Extract<ChoiceCount, { kind: 'LOAD' }>> = {}): ChoiceCount => load(percent, { over: true, ...flags });
  const cut = (percent: number): ChoiceCount => load(percent, { atLeast: true });
  const under: ChoiceCount = { kind: 'UNDER', below: 85 };
  const unknown: ChoiceCount = { kind: 'UNKNOWN' };
  const refused: ChoiceCount = { kind: 'REFUSED', code: 'ROOM_COUNT', params: {} };

  it('compares two values by their figures: heavier is TIGHTER, lighter is LOOSER, equal is SAME', () => {
    expect(compareCounts(load(95), load(98))).toBe('TIGHTER');
    expect(compareCounts(load(98), load(95))).toBe('LOOSER');
    expect(compareCounts(load(95), load(95))).toBe('SAME');
  });

  it('tells apart two weeks in one whole percent by their unrounded figures', () => {
    const a: ChoiceCount = { kind: 'LOAD', demandMinutes: 1990, capacityMinutes: 2000, percent: 99, over: false, atLeast: false, period: null };
    const b: ChoiceCount = { kind: 'LOAD', demandMinutes: 1999, capacityMinutes: 2000, percent: 99, over: false, atLeast: false, period: null };
    expect(compareCounts(a, b)).toBe('TIGHTER');
    expect(compareCounts(b, a)).toBe('LOOSER');
  });

  it('says a week that goes from under the threshold to a figure is TIGHTER, and back is LOOSER', () => {
    expect(compareCounts(under, load(90))).toBe('TIGHTER');
    expect(compareCounts(load(90), under)).toBe('LOOSER');
    expect(compareCounts(under, under)).toBe('SAME');
  });

  it('says a proposal that takes a week over the supply is TIGHTER whatever the week was, and one that takes it under is LOOSER', () => {
    expect(compareCounts(load(97), over(102))).toBe('TIGHTER');
    expect(compareCounts(under, over(101))).toBe('TIGHTER');
    expect(compareCounts(over(114), load(97))).toBe('LOOSER');
    expect(compareCounts(over(101), under)).toBe('LOOSER');
  });

  it('NEVER sets two figures over the supply in order: each is only the first period the engine refused, so 107 % and 144 % are not "worse" or "better"', () => {
    expect(compareCounts(over(107), over(144))).toBe('STILL_OVER');
    expect(compareCounts(over(144), over(107))).toBe('STILL_OVER');
    expect(compareCounts(over(110), over(110))).toBe('STILL_OVER');
  });

  it('never compares a count the seconds cut ("at least"), whichever side it is on', () => {
    expect(compareCounts(cut(90), load(95))).toBe('NOT_COMPARED');
    expect(compareCounts(load(95), cut(99))).toBe('NOT_COMPARED');
    expect(compareCounts(load(95), cut(80))).toBe('NOT_COMPARED');
    expect(compareCounts(cut(90), cut(95))).toBe('NOT_COMPARED');
    expect(compareCounts(under, cut(99))).toBe('NOT_COMPARED');
    // A cut figure that is over the supply is still over: set against another over figure it is not compared either.
    expect(compareCounts(over(103, { atLeast: true }), over(110))).toBe('STILL_OVER');
    expect(compareCounts(over(103, { atLeast: true }), cut(90))).toBe('NOT_COMPARED');
  });

  it('never compares a year the engine did not reach', () => {
    expect(compareCounts(unknown, load(95))).toBe('NOT_COMPARED');
    expect(compareCounts(load(95), unknown)).toBe('NOT_COMPARED');
    expect(compareCounts(unknown, unknown)).toBe('NOT_COMPARED');
  });

  it('says a week the engine refuses after the proposal for another reason, and did not before, is NEWLY_REFUSED; a refusal before is never compared', () => {
    expect(compareCounts(load(90), refused)).toBe('NEWLY_REFUSED');
    expect(compareCounts(under, refused)).toBe('NEWLY_REFUSED');
    expect(compareCounts(over(103), refused)).toBe('NEWLY_REFUSED');
    expect(compareCounts(refused, refused)).toBe('NOT_COMPARED');
    expect(compareCounts(refused, load(90))).toBe('NOT_COMPARED');
  });

  it('is a mirror: swapping before and after swaps TIGHTER and LOOSER and nothing else, for every pair of counts', () => {
    const counts: ChoiceCount[] = [load(90), load(97), load(97), cut(95), over(103), over(120), over(103, { atLeast: true }), under, unknown, refused];
    const mirror = { TIGHTER: 'LOOSER', LOOSER: 'TIGHTER', SAME: 'SAME', STILL_OVER: 'STILL_OVER', NOT_COMPARED: 'NOT_COMPARED' } as const;
    for (const a of counts) {
      for (const b of counts) {
        const forward = compareCounts(a, b);
        const backward = compareCounts(b, a);
        // NEWLY_REFUSED is one-way: a refusal after is the warning, a refusal before is not compared.
        if (forward === 'NEWLY_REFUSED' || backward === 'NEWLY_REFUSED') continue;
        expect(backward).toBe(mirror[forward]);
      }
    }
  });

  it('says LOOSER only when the week after is a value: nothing a bound, a cut count or a refusal is ever shown as an improvement', () => {
    const counts: ChoiceCount[] = [load(90), load(99), cut(80), over(103), over(103, { atLeast: true }), under, unknown, refused];
    for (const a of counts) {
      for (const b of counts) {
        if (compareCounts(a, b) === 'LOOSER') {
          expect(rankingFigure(b)).not.toBeNull();
          const was = rankingFigure(a);
          // And the week before is a value that is heavier, or a figure over the supply.
          expect(was === null ? a.kind === 'LOAD' && a.over : was > rankingFigure(b)!).toBe(true);
        }
        if (compareCounts(a, b) === 'TIGHTER') expect(rankingFigure(a)).not.toBeNull();
      }
    }
  });

  it('warns about TIGHTER and NEWLY_REFUSED and about nothing else', () => {
    expect(isWorse('TIGHTER')).toBe(true);
    expect(isWorse('NEWLY_REFUSED')).toBe(true);
    for (const verdict of ['LOOSER', 'SAME', 'STILL_OVER', 'NOT_COMPARED'] as const) expect(isWorse(verdict)).toBe(false);
  });
});

describe('yearsToShow', () => {
  const heavy = (year: number): number => year * 10;

  it('shows the years a change touches that have a row in either answer, the heaviest first', () => {
    expect(yearsToShow([9, 7], [9, 8], [7, 8, 9], heavy)).toEqual([9, 8, 7]);
  });

  it('leaves out a year no change touches, and every year when a post\'s years are not known (null touches all)', () => {
    expect(yearsToShow([9, 7], [9], [9], heavy)).toEqual([9]);
    expect(yearsToShow([9, 7], [9], null, heavy)).toEqual([9, 7]);
    expect(yearsToShow([9], [9], [], heavy)).toEqual([]);
  });

  it('keeps a year that has a row after the proposal only (it went from under the threshold), and skips unknown years', () => {
    expect(yearsToShow([], [9, null], [9], heavy)).toEqual([9]);
  });

  it('shows at most MAX_YEARS_SHOWN', () => {
    const many = Array.from({ length: MAX_YEARS_SHOWN + 3 }, (_, index) => index + 1);
    expect(yearsToShow(many, [], null, heavy)).toHaveLength(MAX_YEARS_SHOWN);
  });
});

describe('the digest of the week an apply carries', () => {
  const parts = (overrides: Partial<BasisParts> = {}): BasisParts =>
    Object.fromEntries(BASIS_PARTS.map((part) => [part, `${part}-digest`])) as BasisParts;
  const withPart = (part: (typeof BASIS_PARTS)[number], value: string): BasisParts => ({ ...parts(), [part]: value });

  it('is the same for the same week and moves with each part the check reads: the posts, the locks, the rooms, the rules, the pupils', () => {
    const base = weekBasisOf(parts());
    expect(weekBasisOf(parts())).toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    for (const part of ['requirements', 'preserved', 'rooms', 'rules', 'rosters'] as const) {
      expect(weekBasisOf(withPart(part, 'changed'))).not.toBe(base);
    }
  });

  it('does not move with the draft: a lesson moved by hand is not part of the question the engine was asked', () => {
    expect(weekBasisOf(withPart('draft', 'moved by hand'))).toBe(weekBasisOf(parts()));
  });

  it('is never a staffing basis or a week digest alone, and moves with each', () => {
    const staffing = 'a'.repeat(64);
    const week = weekBasisOf(parts());
    const both = withWeekBasis(staffing, week);

    expect(both).toMatch(/^[0-9a-f]{64}$/);
    expect(both).not.toBe(staffing);
    expect(both).not.toBe(week);
    expect(withWeekBasis(staffing, week)).toBe(both);
    expect(withWeekBasis('b'.repeat(64), week)).not.toBe(both);
    expect(withWeekBasis(staffing, weekBasisOf(withPart('rooms', 'x')))).not.toBe(both);
    // The two are not interchangeable: swapping them gives another digest.
    expect(withWeekBasis(week, staffing)).not.toBe(both);
  });
});

/**
 * The week the engine is asked about, as payloads: Kontrollera veckan med lärarval's two-period week (year 9, five classes,
 * the autumn's two Hemkunskap groups with a teacher each, the spring's three with ONE), with a proposal laid over it in
 * four ways. Written to src/optimization/__fixtures__/staffing-week-cases.json and read by optimization-engine/tests/
 * test_staffing_week.py, which asks the engine's /check-week about each: so a payload the engine would refuse (a minted
 * id it does not accept, a field it does not know) fails there, and the figures this file's comparison rests on
 * (a lead on a post nobody teaches makes the week tighter where the teacher has other posts in the period, and not where
 * the teacher is new) are the engine's own numbers.
 *
 * STAFFING_WEEK_WRITE=1 npx jest src/optimization/staffing-week.spec.ts writes it; without, a file that is not what the code
 * makes fails.
 */
describe('the fixture the engine is asked about', () => {
  const path = join(__dirname, '__fixtures__', 'staffing-week-cases.json');
  const choice = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'week-check-choice-cases.json'), 'utf8')) as {
    base: AiEngineScheduleRequest;
  };
  const base = choice.base;
  const spring = base.requirements.filter((requirement) => JSON.stringify(requirement.periods) === '[false,true]');
  const autumn = base.requirements.filter((requirement) => JSON.stringify(requirement.periods) === '[true,false]');
  const springTeacher = spring[0]!.teacherId!;
  const NEW_TEACHERS = ['ab000000-0000-4000-8000-0000000000a1', 'ab000000-0000-4000-8000-0000000000a2', 'ab000000-0000-4000-8000-0000000000a3'];

  // The fixture's ids are its own, so the "real" ids a proposal speaks in are the same strings: the identity.
  const identity = (): PayloadIds => ({
    requirementOf: new Map(base.requirements.map((requirement) => [requirement.id, requirement.id])),
    teacherOf: new Map(base.requirements.flatMap((requirement) => (requirement.teacherId ? [[requirement.teacherId, requirement.teacherId] as const] : []))),
  });
  /** The week with the spring's three posts nobody teaches. */
  const unstaffed: AiEngineScheduleRequest = {
    ...base,
    requirements: base.requirements.map((requirement) => (spring.includes(requirement) ? { ...requirement, teacherId: null } : requirement)),
  };
  const lay = (week: AiEngineScheduleRequest, changes: LeadChange[]) => overlayLeads(week, changes, identity());
  const give = (post: AnonymousRequirement, to: string, from: string | null = null): LeadChange => ({
    requirementId: post.id,
    fromTeacherId: from,
    toTeacherId: to,
  });

  const made = () => {
    const staffedAll = lay(unstaffed, spring.map((post) => give(post, springTeacher)));
    const staffedMixed = lay(unstaffed, [give(spring[0]!, springTeacher), give(spring[1]!, springTeacher), give(spring[2]!, NEW_TEACHERS[0]!)]);
    const staffedNew = lay(unstaffed, spring.map((post, index) => give(post, NEW_TEACHERS[index]!)));
    // The autumn's second group goes to the first group's teacher: they queue in the autumn, which is not the tight period.
    const autumnClash = lay(base, [give(autumn[1]!, autumn[0]!.teacherId!, autumn[1]!.teacherId)]);
    return {
      about:
        'Föreslå bemanning, veckan före och efter: Kontrollera veckan med lärarval\'s tvåperiodsvecka (week-check-choice-cases.json) med förslagets ' +
        'lärare lagda över i fyra former, och veckan där vårens tre poster saknar lärare. Skrivs av src/optimization/staffing-week.spec.ts ' +
        '(STAFFING_WEEK_WRITE=1) och läses av optimization-engine/tests/test_staffing_week.py, som frågar motorns /check-week om varje.',
      base,
      unstaffed,
      springPosts: spring.map((post) => post.id),
      autumnPosts: autumn.map((post) => post.id),
      springTeacher,
      cases: {
        staffedAll: { payload: staffedAll.payload, overlay: staffedAll.overlay, years: staffedAll.years },
        staffedMixed: { payload: staffedMixed.payload, overlay: staffedMixed.overlay, years: staffedMixed.years },
        staffedNew: { payload: staffedNew.payload, overlay: staffedNew.overlay, years: staffedNew.years },
        autumnClash: { payload: autumnClash.payload, overlay: autumnClash.overlay, years: autumnClash.years },
      },
    };
  };

  it('is what the code makes of its base', () => {
    const wanted = made();
    if (process.env.STAFFING_WEEK_WRITE === '1') {
      writeFileSync(path, `${JSON.stringify(wanted, null, 1)}\n`);
    }
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(JSON.parse(JSON.stringify(wanted)));
  });

  it('lays the leads over the spring\'s posts and leaves the autumn\'s as they were, and counts the teacher who is new to the week', () => {
    const wanted = made();
    expect(wanted.cases.staffedAll.overlay).toEqual({ given: 3, laidOver: 3, notLaidOver: 0, fromNobody: 3, newToTheWeek: 0 });
    expect(wanted.cases.staffedMixed.overlay).toMatchObject({ laidOver: 3, fromNobody: 3, newToTheWeek: 1 });
    expect(wanted.cases.staffedNew.overlay).toMatchObject({ laidOver: 3, newToTheWeek: 3 });
    expect(wanted.cases.autumnClash.overlay).toMatchObject({ laidOver: 1, fromNobody: 0 });
    // Laying the spring's own teacher back on the three posts is the week as it was.
    expect(wanted.cases.staffedAll.payload.requirements).toEqual(base.requirements);
  });
});
