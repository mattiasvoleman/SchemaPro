import { teachingWeeks } from '../staffing/teaching-weeks';
import type {
  PlannedCoverageInput,
  PlannedGroup,
  PlannedPupilInput,
  PlannedRequirement,
  PlannedSubject,
} from './timplan-planned';
import { computePlannedCoverage } from './timplan-planned';
import plannedFixture from './__fixtures__/timplan-planned-cases.json';
import {
  computeScheduledCoverage,
  lessonMinutes,
  type ScheduledCoverageInput,
  type ScheduledLessonInput,
  type ScheduledLine,
} from './timplan-scheduled';

/*
 * The rules of schemalagt mot planerat, each pinned by a hand-computed number.
 * The shared fixture (timplan-scheduled.contract.spec.ts) pins the whole
 * document against its own past; these say WHY a figure is what it is.
 */

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const S = { MA: id(1), SV: id(2), IDH: id(3), SPA: id(4), MENT: id(5) };
const SUBJECTS: PlannedSubject[] = [
  { id: S.MA, name: 'Matematik', nationalCode: 'MA', countsTowardTimplan: true },
  { id: S.SV, name: 'Svenska', nationalCode: 'SV_SVA', countsTowardTimplan: true },
  { id: S.IDH, name: 'Idrott och hälsa', nationalCode: 'IDH', countsTowardTimplan: true },
  { id: S.SPA, name: 'Spanska', nationalCode: 'M2', countsTowardTimplan: true },
  { id: S.MENT, name: 'Mentorstid', nationalCode: null, countsTowardTimplan: false },
];
const YEAR = { startDate: '2026-08-17', endDate: '2027-06-11' };

let serial = 1000;
const group = (name: string, kind: PlannedGroup['kind'] = 'CLASS', gradeLevel: number | null = 7): PlannedGroup => ({
  id: id(serial++),
  name,
  kind,
  gradeLevel,
});
const req = (
  g: PlannedGroup,
  subjectId: string,
  lessonsPerWeek: number,
  minutesPerLesson: number,
  extra: Partial<PlannedRequirement> = {},
): PlannedRequirement => ({
  id: id(serial++),
  studentGroupId: g.id,
  subjectId,
  lessonsPerWeek,
  minutesPerLesson,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  ...extra,
});
const lesson = (
  g: PlannedGroup,
  subjectId: string,
  startTime = '08:00',
  endTime = '09:00',
  extra: Partial<ScheduledLessonInput> = {},
): ScheduledLessonInput => ({
  id: id(serial++),
  studentGroupId: g.id,
  subjectId,
  startTime,
  endTime,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  isParked: false,
  extraGroupIds: [],
  studentIds: [],
  ...extra,
});
const pupil = (home: PlannedGroup | null, groups: PlannedGroup[] = []): PlannedPupilInput => ({
  id: id(serial++),
  homeGroupId: home?.id ?? null,
  groupIds: groups.map((g) => g.id),
});

const compute = (overrides: Partial<ScheduledCoverageInput>) =>
  computeScheduledCoverage({
    year: YEAR,
    closures: [],
    subjects: SUBJECTS,
    groups: [],
    requirements: [],
    lessons: [],
    pupils: [],
    includePupils: true,
    ...overrides,
  });

const lineOf = (coverage: ReturnType<typeof compute>, g: PlannedGroup, subjectId: string): ScheduledLine => {
  const line = coverage.groups.find((s) => s.studentGroupId === g.id)?.lines.find((l) => l.subjectId === subjectId);
  if (!line) throw new Error(`no line for ${g.name} ${subjectId}`);
  return line;
};

describe('lessonMinutes', () => {
  it('reads HH:MM and HH:MM:SS alike, and a reversed or malformed pair as nothing', () => {
    expect(lessonMinutes({ startTime: '08:00', endTime: '08:55' })).toBe(55);
    expect(lessonMinutes({ startTime: '08:00:00', endTime: '09:20:00' })).toBe(80);
    expect(lessonMinutes({ startTime: '09:00', endTime: '08:00' })).toBe(0);
    expect(lessonMinutes({ startTime: 'nio', endTime: '10:00' })).toBe(0);
  });
});

describe('schemalagt mot planerat', () => {
  it('matches 3 × 60 against three 60-minute lessons, and says so in whole minutes and per cent', () => {
    const a = group('7A');
    const coverage = compute({
      groups: [a],
      requirements: [req(a, S.MA, 3, 60)],
      lessons: [lesson(a, S.MA), lesson(a, S.MA), lesson(a, S.MA)],
    });
    expect(lineOf(coverage, a, S.MA)).toMatchObject({
      plannedMinutesPerWeek: 180,
      scheduledMinutesPerWeek: 180,
      deltaMinutesPerWeek: 0,
      percent: 100,
      status: 'MATCH',
    });
    expect(coverage.groups[0]).toMatchObject({ linesMatching: 1, linesTotal: 1 });
    expect(coverage.verdicts).toEqual([]);
  });

  it('counts each lesson at its own duration: three 55s against 3 × 60 are 15 short a week', () => {
    const a = group('7A');
    const coverage = compute({
      groups: [a],
      requirements: [req(a, S.MA, 3, 60)],
      lessons: [0, 1, 2].map(() => lesson(a, S.MA, '08:00', '08:55')),
    });
    expect(lineOf(coverage, a, S.MA)).toMatchObject({
      scheduledMinutesPerWeek: 165,
      deltaMinutesPerWeek: -15,
      percent: 92,
      status: 'SHORT',
    });
    expect(coverage.verdicts.map((v) => [v.code, v.severity])).toEqual([['TIMPLAN_SCHEDULE_SHORT', 'warning']]);
  });

  it('compares minutes, never lengths: a split 80 + 40 post against two 60s is a match', () => {
    const a = group('7A');
    const coverage = compute({
      groups: [a],
      requirements: [req(a, S.IDH, 2, 80, { lessonLengths: [80, 40] })],
      lessons: [lesson(a, S.IDH), lesson(a, S.IDH, '10:00', '11:00')],
    });
    expect(lineOf(coverage, a, S.IDH)).toMatchObject({ plannedMinutesPerWeek: 120, scheduledMinutesPerWeek: 120, status: 'MATCH' });
  });

  it('weighs varannan vecka a half on both sides, and an every-week lesson against an odd-week post as extra', () => {
    const a = group('7A');
    const b = group('7B');
    const coverage = compute({
      groups: [a, b],
      requirements: [req(a, S.MA, 1, 60, { recurrence: 'ODD_WEEKS' }), req(b, S.MA, 1, 60, { recurrence: 'ODD_WEEKS' })],
      lessons: [lesson(a, S.MA, '08:00', '09:00', { recurrence: 'ODD_WEEKS' }), lesson(b, S.MA)],
    });
    expect(lineOf(coverage, a, S.MA)).toMatchObject({ plannedMinutesPerWeek: 30, scheduledMinutesPerWeek: 30, status: 'MATCH' });
    expect(lineOf(coverage, b, S.MA)).toMatchObject({ plannedMinutesPerWeek: 30, scheduledMinutesPerWeek: 60, status: 'EXTRA' });
    expect(coverage.verdicts.map((v) => [v.code, v.severity])).toEqual([['TIMPLAN_SCHEDULE_EXTRA', 'notice']]);
  });

  it('reads a dated odd-week window across ISO week 53 by the publisher’s week numbers: 53 and 1 are both odd', () => {
    // 2026-12-21 is week 52, 12-28 week 53, 2027-01-04 week 1: two odd weeks of three.
    const a = group('7A');
    const window = { recurrence: 'ODD_WEEKS' as const, startDate: '2026-12-21', endDate: '2027-01-10' };
    const coverage = compute({
      groups: [a],
      requirements: [req(a, S.MA, 1, 60, window)],
      lessons: [lesson(a, S.MA, '08:00', '09:00', window)],
    });
    const yearWeeks = teachingWeeks({}, YEAR, [], 7);
    expect(teachingWeeks(window, YEAR, [], 7)).toBe(2);
    expect(lineOf(coverage, a, S.MA)).toMatchObject({
      plannedMinutesPerWeek: Math.round((60 * 2) / yearWeeks),
      scheduledMinutesPerWeek: Math.round((60 * 2) / yearWeeks),
      status: 'MATCH',
    });
  });

  it('takes a lov for åk 7–9 out of a dated lesson at a class’s grade, and not at a teaching group’s', () => {
    const a = group('7A');
    const t = group('Ma-grupp', 'TEACHING_GROUP', null);
    const closures = [{ startDate: '2027-02-15', endDate: '2027-02-19', minGradeLevel: 7, maxGradeLevel: 9 }];
    const spring = { startDate: '2027-01-11', endDate: '2027-06-11' };
    const coverage = compute({
      groups: [a, t],
      closures,
      requirements: [req(a, S.MA, 1, 60), req(t, S.MA, 1, 60)],
      lessons: [lesson(a, S.MA, '08:00', '09:00', spring), lesson(t, S.MA, '08:00', '09:00', spring)],
    });
    const share = (grade: number | null) =>
      teachingWeeks(spring, YEAR, closures, grade) / teachingWeeks({}, YEAR, closures, grade);
    expect(share(7)).not.toBe(share(null));
    expect(lineOf(coverage, a, S.MA).scheduledMinutesPerWeek).toBe(Math.round(60 * share(7)));
    expect(lineOf(coverage, t, S.MA).scheduledMinutesPerWeek).toBe(Math.round(60 * share(null)));
    expect(lineOf(coverage, a, S.MA).status).toBe('SHORT');
  });

  it('leaves a parked lesson out, reports its minutes, and calls a line short only because of the tray a notice', () => {
    const a = group('7A');
    const parked = lesson(a, S.MA, '10:00', '11:00', { isParked: true });
    const coverage = compute({
      groups: [a],
      requirements: [req(a, S.MA, 2, 60)],
      lessons: [lesson(a, S.MA), parked],
    });
    expect(lineOf(coverage, a, S.MA)).toMatchObject({
      scheduledMinutesPerWeek: 60,
      parkedMinutesPerWeek: 60,
      status: 'SHORT',
    });
    expect(lineOf(coverage, a, S.MA).masterLessonIds.at(-1)).toBe(parked.id);
    expect(coverage.lessonCount).toBe(1);
    expect(coverage.verdicts.map((v) => [v.code, v.severity])).toEqual([['TIMPLAN_SCHEDULE_PARKED', 'notice']]);
  });

  it('says UNSCHEDULED for a post with no lesson and UNPLANNED for lessons with no post', () => {
    const a = group('7A');
    const coverage = compute({
      groups: [a],
      requirements: [req(a, S.MA, 3, 60)],
      lessons: [lesson(a, S.SV)],
    });
    expect(lineOf(coverage, a, S.MA).status).toBe('UNSCHEDULED');
    expect(lineOf(coverage, a, S.SV)).toMatchObject({ plannedMinutesPerWeek: 0, percent: null, status: 'UNPLANNED' });
    expect(coverage.verdicts.map((v) => [v.code, v.severity])).toEqual([
      ['TIMPLAN_SCHEDULE_UNSCHEDULED', 'warning'],
      ['TIMPLAN_SCHEDULE_UNPLANNED', 'notice'],
    ]);
  });

  it('says one notice and no line verdict when the year has posts and no grundschema at all', () => {
    const a = group('7A');
    const coverage = compute({ groups: [a], requirements: [req(a, S.MA, 3, 60)] });
    expect(lineOf(coverage, a, S.MA).status).toBe('UNSCHEDULED');
    expect(coverage.verdicts.map((v) => v.code)).toEqual(['TIMPLAN_SCHEDULE_NONE']);
  });

  it('excludes a subject that does not count toward the timplan, on both sides', () => {
    const a = group('7A');
    const coverage = compute({ groups: [a], requirements: [req(a, S.MENT, 1, 40)], lessons: [lesson(a, S.MENT)] });
    expect(coverage.groups[0]!.lines).toEqual([]);
    expect(coverage.lessonCount).toBe(0);
  });

  it('counts a lesson on its extra group’s line, and a named pupil’s lesson on nobody’s line but the pupil’s', () => {
    const a = group('7A');
    const b = group('7B');
    const ada = pupil(b);
    const coverage = compute({
      groups: [a, b],
      requirements: [req(a, S.SPA, 1, 60), req(b, S.SPA, 1, 60)],
      lessons: [
        lesson(a, S.SPA, '08:00', '09:00', { extraGroupIds: [b.id] }),
        lesson(a, S.SV, '09:00', '10:00', { studentIds: [ada.id] }),
      ],
      pupils: [ada],
    });
    expect(lineOf(coverage, b, S.SPA)).toMatchObject({ scheduledMinutesPerWeek: 60, status: 'MATCH' });
    expect(coverage.groups.find((g) => g.studentGroupId === b.id)!.lines.map((l) => l.subjectId)).toEqual([S.SPA]);
    // The named Svenska lesson is 7A's own line's (an UNPLANNED one), never 7B's.
    expect(lineOf(coverage, a, S.SV).status).toBe('UNPLANNED');
  });

  describe('the pupil', () => {
    // Bea is in 7A and in Ma7-fördjupning. 7A has 3 × 60 matematik on Mon,
    // Wed and Fri; Ma7-fördjupning has a 1 × 60 post and no lessons of its
    // own: its pupils join 7A's Wednesday lesson as an extra group.
    const a = group('7A');
    const fd = group('Ma7-fördjupning', 'TEACHING_GROUP', null);
    const bea = pupil(a, [fd]);
    const classmates = [pupil(a), pupil(a)];
    const wednesday = lesson(a, S.MA, '08:00', '09:00', { extraGroupIds: [fd.id] });
    const input = {
      groups: [a, fd],
      requirements: [req(a, S.MA, 3, 60), req(fd, S.MA, 1, 60)],
      lessons: [lesson(a, S.MA), wednesday, lesson(a, S.MA, '10:00', '11:00')],
      pupils: [bea, ...classmates],
    };

    it('counts a lesson reaching a pupil through two groups once, and lists the pupil both group lines hide', () => {
      const coverage = compute(input);
      expect(lineOf(coverage, a, S.MA)).toMatchObject({ plannedMinutesPerWeek: 180, scheduledMinutesPerWeek: 180, status: 'MATCH' });
      expect(lineOf(coverage, fd, S.MA)).toMatchObject({ plannedMinutesPerWeek: 60, scheduledMinutesPerWeek: 60, status: 'MATCH' });
      expect(coverage.pupils).toEqual([
        {
          pupilId: bea.id,
          homeGroupId: a.id,
          gradeLevel: 7,
          lines: [
            {
              subjectId: S.MA,
              plannedMinutesPerWeek: 240,
              scheduledMinutesPerWeek: 180,
              groupDeficitMinutesPerWeek: 0,
              sources: [
                { studentGroupId: a.id, masterLessonIds: input.lessons.map((l) => l.id).sort(), minutesPerWeek: 180 },
              ],
            },
          ],
        },
      ]);
      expect(coverage.verdicts.map((v) => [v.code, v.pupilId, v.params.deficitMinutesPerWeek])).toEqual([
        ['TIMPLAN_PUPIL_SCHEDULE_SHORT', bea.id, 60],
      ]);
      expect(coverage.pupilsBelowPlanned).toBe(1);
    });

    it('puts her at the minimum of the class’s statistics over the delta, which raw minutes would hide', () => {
      const stats = lineOf(compute(input), a, S.MA).pupils;
      expect(stats).toEqual({ min: -60, median: 0, max: 0, below: 1 });
    });

    it('counts, and does not list, the members of a short språkgrupp', () => {
      const lang = group('Spanska 7', 'TEACHING_GROUP', null);
      const members = [pupil(a, [lang]), pupil(a, [lang]), pupil(a, [lang])];
      const coverage = compute({
        groups: [a, lang],
        requirements: [req(lang, S.SPA, 2, 60)],
        lessons: [lesson(lang, S.SPA)],
        pupils: members,
      });
      expect(lineOf(coverage, lang, S.SPA)).toMatchObject({ status: 'SHORT', pupils: { min: -60, median: -60, max: -60, below: 3 } });
      expect(coverage.pupils).toEqual([]);
      expect(coverage.pupilsBelowPlanned).toBe(3);
      expect(coverage.verdicts.map((v) => v.code)).toEqual(['TIMPLAN_SCHEDULE_SHORT']);
    });

    it('does not list a pupil short only because a group of theirs is, with or without lessons naming them', () => {
      // A named lesson only ever ADDS to a pupil: no group line counts it, so
      // no group line is short or whole because of it. A pupil's own deficit
      // therefore comes from a lesson reaching them through two groups
      // counted once (Bea above), never from a missing named lesson.

      const support = group('Ma-stöd', 'TEACHING_GROUP', null);
      const cleo = pupil(a, [support]);
      const named = lesson(a, S.MA, '13:00', '14:00', { studentIds: [cleo.id] });
      const coverage = compute({
        groups: [a, support],
        requirements: [req(a, S.MA, 1, 60), req(support, S.MA, 2, 60)],
        lessons: [lesson(a, S.MA), named, lesson(support, S.MA, '14:00', '15:00')],
        pupils: [cleo],
      });
      // Ma-stöd plans 120 and schedules 60: its own line is 60 short. Cleo is
      // planned 180 and gets 7A's 60, Ma-stöd's 60 and her named 60 — 180.
      expect(lineOf(coverage, support, S.MA).deltaMinutesPerWeek).toBe(-60);
      expect(coverage.pupils).toEqual([]);
      // Without the named lesson she is 60 short — exactly Ma-stöd's
      // deficit, so still not her own finding.
      const without = compute({
        groups: [a, support],
        requirements: [req(a, S.MA, 1, 60), req(support, S.MA, 2, 60)],
        lessons: [lesson(a, S.MA), lesson(support, S.MA, '14:00', '15:00')],
        pupils: [cleo],
      });
      expect(without.pupils).toEqual([]);
      expect(without.pupilsBelowPlanned).toBe(1);
    });

    it('lists every pupil of a group in the drill-down, finding or not', () => {
      const coverage = compute({ ...input, drillGroupId: a.id });
      expect(coverage.pupils!.map((p) => p.pupilId).sort()).toEqual([bea.id, ...classmates.map((c) => c.id)].sort());
      expect(coverage.pupils!.every((p) => p.lines.length === 1)).toBe(true);
    });

    it('answers a drill-down for its group alone, as layer 3 does: its line, its pupils, its verdicts', () => {
      const overview = compute(input);
      expect(overview.groups.length).toBeGreaterThan(1);
      const coverage = compute({ ...input, drillGroupId: a.id });
      expect(coverage.groups.map((g) => g.studentGroupId)).toEqual([a.id]);
      expect(coverage.groups[0]).toEqual(overview.groups.find((g) => g.studentGroupId === a.id));
      expect(coverage.verdicts.every((v) => v.studentGroupId === undefined || v.studentGroupId === a.id)).toBe(true);
      expect(coverage.pupilCount).toBe(overview.pupilCount);
    });

    it('strips every pupil figure, list and verdict from a read without the pupil level', () => {
      const coverage = compute({ ...input, includePupils: false, drillGroupId: a.id });
      expect(coverage).toMatchObject({ pupilLevel: false, pupils: null, pupilsBelowPlanned: null });
      expect(coverage.verdicts.filter((v) => v.pupilId)).toEqual([]);
      expect(coverage.groups.flatMap((g) => g.lines).some((l) => l.pupils !== undefined)).toBe(false);
      for (const p of input.pupils) expect(JSON.stringify(coverage)).not.toContain(p.id);
    });

    it('gives the board, with no pupils at all, the same group lines', () => {
      const withPupils = compute({ ...input, includePupils: false });
      const board = compute({ ...input, pupils: [], includePupils: false });
      const strip = (c: typeof board) => c.groups.map((g) => ({ ...g, pupilCount: 0 }));
      expect(strip(board)).toEqual(strip(withPupils));
    });
  });

  it('plans exactly what P2’s planned layer plans, for every class cell of P2’s fixture', () => {
    const { cases } = plannedFixture as unknown as { cases: { name: string; input: PlannedCoverageInput }[] };
    let compared = 0;
    for (const { name, input } of cases) {
      const planned = computePlannedCoverage(input);
      const scheduled = computeScheduledCoverage({
        year: input.year,
        closures: input.closures,
        subjects: input.subjects,
        groups: input.groups,
        requirements: input.requirements,
        lessons: [],
        pupils: [],
        includePupils: false,
      });
      for (const cell of planned.cells) {
        const line = scheduled.groups
          .find((g) => g.studentGroupId === cell.studentGroupId)
          ?.lines.find((l) => l.subjectId === cell.subjectId);
        expect({ name, cell: `${cell.studentGroupId}:${cell.subjectId}`, planned: line?.plannedMinutesPerWeek ?? 0 }).toEqual({
          name,
          cell: `${cell.studentGroupId}:${cell.subjectId}`,
          planned: cell.plannedMinutesPerWeek,
        });
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(20);
  });

  it('computes a 600-pupil school in well under a second', () => {
    const classes = Array.from({ length: 24 }, (_, i) => group(`${7 + (i % 3)}${'ABCDEFGH'[i >> 2]}`, 'CLASS', 7 + (i % 3)));
    const langs = Array.from({ length: 12 }, (_, i) => group(`Språk ${i}`, 'TEACHING_GROUP', null));
    const requirements = classes.flatMap((c) => [req(c, S.MA, 3, 60), req(c, S.SV, 3, 60), req(c, S.IDH, 2, 60)]);
    requirements.push(...langs.map((l) => req(l, S.SPA, 2, 60)));
    const lessons = classes.flatMap((c) => [
      ...[0, 1, 2].map(() => lesson(c, S.MA, '08:00', '09:00', { recurrence: 'ODD_WEEKS', startDate: '2026-09-01', endDate: '2027-05-31' })),
      ...[0, 1, 2].map(() => lesson(c, S.SV)),
      ...[0, 1].map(() => lesson(c, S.IDH)),
    ]);
    lessons.push(...langs.map((l) => lesson(l, S.SPA, '08:00', '09:00', { extraGroupIds: [classes[0]!.id] })));
    const pupils = Array.from({ length: 600 }, (_, i) => pupil(classes[i % 24]!, [langs[i % 12]!]));
    const started = Date.now();
    const coverage = compute({
      groups: [...classes, ...langs],
      closures: [{ startDate: '2026-10-26', endDate: '2026-10-30' }, { startDate: '2027-02-15', endDate: '2027-02-19', minGradeLevel: 7, maxGradeLevel: 9 }],
      requirements,
      lessons,
      pupils,
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(coverage.pupilCount).toBe(600);
  });
});
