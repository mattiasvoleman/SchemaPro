import { computePlannedCoverage, type PlannedGroup, type PlannedPupilInput, type PlannedRequirement, type PlannedSubject } from './timplan-planned';
import {
  computeDeliveredCoverage,
  deliveredDatesToAsk,
  plannedMinutesBetween,
  type DeliveredAudienceRow,
  type DeliveredCoverage,
  type DeliveredCoverageInput,
  type DeliveredLineDetail,
  type DeliveredMasterLesson,
} from './timplan-delivered';
import type { PublishBreak } from '../calendar/publish-days';

/*
 * The rules of genomfört mot schemalagt, each pinned by a hand-computed
 * number — the spec's worked example first, as a test.
 */

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const S = { MA: id(1), IDH: id(2), SV: id(3), MENT: id(4) };
const SUBJECTS: PlannedSubject[] = [
  { id: S.MA, name: 'Matematik', nationalCode: 'MA', countsTowardTimplan: true },
  { id: S.IDH, name: 'Idrott och hälsa', nationalCode: 'IDH', countsTowardTimplan: true },
  { id: S.SV, name: 'Svenska', nationalCode: 'SV_SVA', countsTowardTimplan: true },
  { id: S.MENT, name: 'Mentorstid', nationalCode: null, countsTowardTimplan: false },
];
const YEAR = { startDate: '2026-08-17', endDate: '2027-06-11' };
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);
const lov = (from: string, to: string, min: number | null = null, max: number | null = null) => ({
  startDate: from,
  endDate: to,
  minGradeLevel: min,
  maxGradeLevel: max,
});
// Höstlov, jullov, sportlov, påsklov, Kristi himmelfärd + klämdag, and the
// friluftsdag entered as a lov for åk 7–9 (R22).
const CLOSURES = [
  lov('2026-10-26', '2026-10-30'),
  lov('2026-12-21', '2027-01-08'),
  lov('2027-03-01', '2027-03-05'),
  lov('2027-03-29', '2027-04-02'),
  lov('2027-05-06', '2027-05-07'),
  lov('2026-09-25', '2026-09-25', 7, 9),
];
const BREAKS: PublishBreak[] = CLOSURES.map((c) => ({
  startDate: day(c.startDate),
  endDate: day(c.endDate),
  minGradeLevel: c.minGradeLevel,
  maxGradeLevel: c.maxGradeLevel,
}));
const AS_OF = '2026-10-08T08:00:00.000Z'; // Thursday 10:00 in Stockholm
const AS_OF_DATE = '2026-10-08';

let serial = 1000;
const group = (name: string, kind: PlannedGroup['kind'] = 'CLASS', gradeLevel: number | null = 7): PlannedGroup => ({
  id: id(serial++),
  name,
  kind,
  gradeLevel,
});
const req = (g: PlannedGroup, subjectId: string, lessonsPerWeek: number, minutesPerLesson: number, extra: Partial<PlannedRequirement> = {}): PlannedRequirement => ({
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
const pupil = (home: PlannedGroup, groups: PlannedGroup[] = []): PlannedPupilInput => ({
  id: id(serial++),
  homeGroupId: home.id,
  groupIds: groups.map((g) => g.id),
});
const master = (g: PlannedGroup, subjectId: string, dayOfWeek: number, extra: Partial<DeliveredMasterLesson> = {}): DeliveredMasterLesson => ({
  id: id(serial++),
  studentGroupId: g.id,
  subjectId,
  extraGroupIds: [],
  studentIds: [],
  teacherId: id(9000),
  coTeacherId: null,
  dayOfWeek,
  startTime: '08:00',
  endTime: '09:00',
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  isParked: false,
  ...extra,
});
const row = (g: PlannedGroup, subjectId: string, bucket: DeliveredAudienceRow['bucket'], lessons: number, extra: Partial<DeliveredAudienceRow> = {}): DeliveredAudienceRow => ({
  studentGroupId: g.id,
  subjectId,
  bucket,
  extraGroupIds: [],
  studentIds: [],
  minutes: lessons * 60,
  lessons,
  ...extra,
});

const compute = (overrides: Partial<DeliveredCoverageInput> & { planned?: Partial<DeliveredCoverageInput['planned']> }): DeliveredCoverage =>
  computeDeliveredCoverage({
    audiences: [],
    horizon: [],
    dates: [],
    masterLessons: [],
    publish: { breaks: BREAKS, closures: [], timezone: 'Europe/Stockholm' },
    credits: [],
    asOf: AS_OF,
    asOfDate: AS_OF_DATE,
    published: { from: '2026-08-17', through: '2026-10-23' },
    drillGroupId: null,
    ...overrides,
    planned: {
      year: YEAR,
      closures: CLOSURES,
      plans: [],
      attachments: [],
      subjects: SUBJECTS,
      groups: [],
      requirements: [],
      pupils: [],
      includePupils: true,
      ...overrides.planned,
    },
  });

const lineOf = (coverage: DeliveredCoverage, g: PlannedGroup, key: string) => {
  const line = coverage.groups.find((s) => s.studentGroupId === g.id)?.lines.find((l) => l.key === key);
  if (!line) throw new Error(`no line ${key} for ${g.name}`);
  return line;
};

describe('the worked example (spec §4.4, recomputed in review R22)', () => {
  // 7A Matematik 3 × 60, lessons Mon/Wed/Fri 60, all staffed; asOf Thu
  // 2026-10-08 10:00; every lesson published 17 Aug – 23 Oct. Ma7-fördjupning
  // (1 × 60) has no lessons of its own: its pupils join 7A's Wednesdays.
  const a = group('7A');
  const fd = group('Ma7-fördjupning', 'TEACHING_GROUP', null);
  const bea = pupil(a, [fd]);
  const classmates = [pupil(a), pupil(a), pupil(a)];
  const monday = master(a, S.MA, 1);
  const wednesday = master(a, S.MA, 3, { extraGroupIds: [fd.id] });
  const friday = master(a, S.MA, 5);
  const shared = { extraGroupIds: [fd.id] };
  const input: Partial<DeliveredCoverageInput> & { planned: Partial<DeliveredCoverageInput['planned']> } = {
    planned: {
      groups: [a, fd],
      requirements: [req(a, S.MA, 3, 60), req(fd, S.MA, 1, 60)],
      pupils: [bea, ...classmates],
    },
    // 22 past published lessons (25 Sep is the friluftsdag: never published):
    // the 8 Wednesdays delivered; of the 14 Mondays and Fridays one cancelled
    // for the teacher, one by the school and one without a teacher.
    audiences: [
      row(a, S.MA, 'DELIVERED', 11),
      row(a, S.MA, 'CANCELLED_TEACHER_UNAVAILABLE', 1),
      row(a, S.MA, 'CANCELLED_MANUAL', 1),
      row(a, S.MA, 'TEACHERLESS', 1),
      row(a, S.MA, 'DELIVERED', 8, shared),
      // 8–23 Oct: 7 rows, one cancelled (a Friday).
      row(a, S.MA, 'AHEAD', 4),
      row(a, S.MA, 'AHEAD_CANCELLED', 1),
      row(a, S.MA, 'AHEAD', 2, shared),
    ],
    horizon: [
      { masterLessonId: monday.id, aheadRows: 2, firstDate: '2026-08-17', lastDate: '2026-10-19' },
      { masterLessonId: wednesday.id, aheadRows: 2, firstDate: '2026-08-19', lastDate: '2026-10-21' },
      { masterLessonId: friday.id, aheadRows: 3, firstDate: '2026-08-21', lastDate: '2026-10-23' },
    ],
    masterLessons: [monday, wednesday, friday],
    drillGroupId: a.id,
  };

  it('delivers 1 140 of 1 320 published, projects 6 300 against 6 552 and calls it SHORT, with scheduleGap −12', () => {
    const coverage = compute(input);
    const line = lineOf(coverage, a, `subject:${S.MA}`) as DeliveredLineDetail;
    expect(line).toMatchObject({
      publishedMinutes: 1320,
      deliveredMinutes: 1140,
      lostMinutes: 180,
      creditedMinutes: 0,
      projectedMinutes: 6300,
      plannedYearMinutes: 6552,
      unrecordedMinutes: 0,
      deliveredPercent: 86,
      status: 'SHORT',
    });
    expect(line.lost).toEqual({ cancelledTeacherUnavailable: 60, cancelledManual: 60, teacherless: 60 });
    expect(line.projection).toEqual({
      deliveredSoFar: 1140,
      calendarAhead: 360,
      aheadTeacherless: 0,
      aheadCancelled: 60,
      masterAhead: 4800,
      creditsAhead: 0,
      projectedMinutes: 6300,
      plannedYearMinutes: 6552,
      unrecordedMinutes: 0,
      targetYearMinutes: null,
      deltaMinutes: -252,
      scheduleGapMinutes: -12,
      lostMinutes: 240,
    });
    expect(line.masterLessonIds).toEqual([monday.id, wednesday.id, friday.id].sort());
    expect(coverage.drift).toBeNull();
    expect(coverage.verdicts.find((v) => v.code === 'TIMPLAN_PROJECTION_SHORT')).toMatchObject({
      studentGroupId: a.id,
      params: { projectedMinutes: 6300, plannedYearMinutes: 6552, deficitMinutes: 252, lostMinutes: 240, scheduleGapMinutes: -12 },
    });
  });

  it('keeps Ma7-fördjupning on track on its 37 Wednesdays, and lists Bea, who gets them once against two posts', () => {
    const coverage = compute({ ...input, drillGroupId: null });
    expect(lineOf(coverage, fd, `subject:${S.MA}`)).toMatchObject({ projectedMinutes: 2220, status: 'ON_TRACK' });
    const listed = coverage.pupils!.filter((p) => p.lines.some((l) => l.status === 'SHORT' && l.groupDeficitMinutes < 2000));
    expect(coverage.verdicts.filter((v) => v.code === 'TIMPLAN_PUPIL_PROJECTION_SHORT').map((v) => [v.pupilId, v.params.deficitMinutes, v.params.groupDeficitMinutes])).toEqual([
      [bea.id, 2436, 252],
    ]);
    const beaLine = coverage.pupils!.find((p) => p.pupilId === bea.id)!.lines[0]!;
    expect(beaLine).toMatchObject({ plannedYearMinutes: 8736, projectedMinutes: 6300, deliveredMinutes: 1140 });
    expect(beaLine.sources).toEqual([{ studentGroupId: a.id, deliveredMinutes: 1140, sharedWith: [fd.id] }]);
    expect(listed.map((p) => p.pupilId)).toContain(bea.id);
  });

  it('answers a drill-down for its group alone: the group with its detail, its pupils, its verdicts and the year’s', () => {
    const coverage = compute(input);
    expect(coverage.groups.map((g) => g.studentGroupId)).toEqual([a.id]);
    expect(coverage.pupils!.map((p) => p.pupilId).sort()).toEqual([bea.id, ...classmates.map((c) => c.id)].sort());
    expect(coverage.verdicts.every((v) => v.studentGroupId === undefined || v.studentGroupId === a.id)).toBe(true);
    // The overview has both groups and only Bea's own finding.
    const overview = compute({ ...input, drillGroupId: null });
    expect(overview.groups.map((g) => g.studentGroupId)).toEqual([a.id, fd.id]);
    expect(overview.pupils!.map((p) => p.pupilId)).toEqual([bea.id]);
    expect('projection' in overview.groups[0]!.lines[0]!).toBe(false);
  });

  it('puts Bea at the minimum of 7A’s projected-delta statistics, with her classmates counted', () => {
    const stats = lineOf(compute(input), a, `subject:${S.MA}`).pupils!;
    expect(stats.projectedDelta).toEqual({ min: -2436, median: -252, max: -252, below: 4 });
    expect(stats.delivered).toEqual({ min: 1140, median: 1140, max: 1140, below: 0 });
    expect(stats.belowPlanned).toBe(4);
  });

  it('gives a teacher the same group figures and the detail, and no pupil anywhere, drill-down or not', () => {
    const coverage = compute({ ...input, planned: { ...input.planned, includePupils: false } });
    expect(coverage).toMatchObject({ pupilLevel: false, pupils: null, pupilsBelowPlanned: null });
    expect((lineOf(coverage, a, `subject:${S.MA}`) as DeliveredLineDetail).projection.projectedMinutes).toBe(6300);
    const text = JSON.stringify(coverage);
    for (const p of [bea, ...classmates]) expect(text).not.toContain(p.id);
  });

  it('credits the friluftsdag to 7A’s Idrott, its pupils and the teaching groups wholly inside åk 7–9', () => {
    const b = group('6A', 'CLASS', 6);
    const idrott7 = group('Idrott 7 tjej', 'TEACHING_GROUP', null);
    const mixed = group('Idrott 6–7', 'TEACHING_GROUP', null);
    const ada = pupil(a, [idrott7, mixed]);
    const sixth = pupil(b, [mixed]);
    const coverage = compute({
      planned: { groups: [a, b, idrott7, mixed], pupils: [ada, sixth], requirements: [req(a, S.IDH, 2, 60)] },
      credits: [
        { id: id(7001), date: '2026-09-25', minutes: 300, subjectId: S.IDH, studentGroupId: null, minGradeLevel: 7, maxGradeLevel: 9, name: 'Friluftsdag' },
        { id: id(7002), date: '2026-09-25', minutes: 120, subjectId: S.IDH, studentGroupId: null, minGradeLevel: 4, maxGradeLevel: 5, name: 'Ingen klass' },
        { id: id(7003), date: '2026-09-25', minutes: 60, subjectId: S.MENT, studentGroupId: null, minGradeLevel: null, maxGradeLevel: null, name: 'Mentorsdag' },
        { id: id(7004), date: '2027-08-20', minutes: 60, subjectId: null, studentGroupId: null, minGradeLevel: null, maxGradeLevel: null, name: 'Fel år' },
      ],
    });
    expect(lineOf(coverage, a, `subject:${S.IDH}`)).toMatchObject({ creditedMinutes: 300 });
    expect(lineOf(coverage, idrott7, `subject:${S.IDH}`)).toMatchObject({ creditedMinutes: 300 });
    expect(coverage.groups.find((g) => g.studentGroupId === mixed.id)).toBeUndefined();
    expect(coverage.groups.find((g) => g.studentGroupId === b.id)!.lines).toEqual([]);
    expect(coverage.credits).toEqual({ count: 1, minutes: 300 });
    expect(coverage.verdicts.filter((v) => v.creditId).map((v) => [v.code, v.params.reason ?? ''])).toEqual([
      ['TIMPLAN_CREDIT_OUTSIDE_YEAR', ''],
      ['TIMPLAN_CREDIT_REACHES_NOBODY', 'SCOPE'],
      ['TIMPLAN_CREDIT_REACHES_NOBODY', 'SUBJECT'],
    ]);
  });
});

describe('genomfört mot schemalagt', () => {
  const a = group('8A', 'CLASS', 8);

  it('says only that nothing is published, when nothing is', () => {
    const coverage = compute({ planned: { groups: [a], requirements: [req(a, S.MA, 3, 60)] }, published: null });
    expect(coverage).toMatchObject({ groups: [], pupils: [], published: null, drift: null });
    expect(coverage.verdicts.map((v) => v.code)).toEqual(['TIMPLAN_NOT_PUBLISHED']);
  });

  it('does not count a cancellation on a later-entered lov as lost, and names a lesson delivered on a lov', () => {
    const coverage = compute({
      planned: { groups: [a], requirements: [req(a, S.MA, 1, 60)] },
      audiences: [row(a, S.MA, 'CANCELLED_ON_BREAK', 1), row(a, S.MA, 'DELIVERED', 2), row(a, S.MA, 'OTHER', 1)],
      dates: [{ studentGroupId: a.id, date: '2026-10-26', minutes: 60 }],
      drillGroupId: a.id,
    });
    const line = lineOf(coverage, a, `subject:${S.MA}`) as DeliveredLineDetail;
    expect(line).toMatchObject({ publishedMinutes: 180, lostMinutes: 60, cancelledOnBreak: 60, lost: { otherStatus: 60 } });
    expect(coverage.verdicts.find((v) => v.code === 'TIMPLAN_CALENDAR_ON_BREAK')).toMatchObject({
      studentGroupId: a.id,
      params: { minutes: 60, days: 1, dates: '2026-10-26' },
    });
  });

  it('names a credit on a day that still had delivered lessons in its scope, and never subtracts them', () => {
    const coverage = compute({
      planned: { groups: [a], requirements: [req(a, S.IDH, 2, 60)] },
      audiences: [row(a, S.IDH, 'DELIVERED', 2)],
      dates: [{ studentGroupId: a.id, date: '2026-09-30', minutes: 120 }],
      credits: [{ id: id(7100), date: '2026-09-30', minutes: 120, subjectId: S.IDH, studentGroupId: a.id, minGradeLevel: null, maxGradeLevel: null, name: 'Temaeftermiddag' }],
    });
    expect(lineOf(coverage, a, `subject:${S.IDH}`)).toMatchObject({ deliveredMinutes: 120, creditedMinutes: 120 });
    expect(coverage.verdicts.find((v) => v.code === 'TIMPLAN_CREDIT_OVERLAPS_DELIVERED')).toMatchObject({ params: { deliveredMinutes: 120 } });
  });

  it('shows a credit without a subject as its own line, never spread over subjects; one dated today counts ahead', () => {
    const coverage = compute({
      planned: { groups: [a] },
      credits: [
        { id: id(7200), date: '2026-09-02', minutes: 240, subjectId: null, studentGroupId: null, minGradeLevel: null, maxGradeLevel: null, name: 'Temadag' },
        { id: id(7201), date: AS_OF_DATE, minutes: 60, subjectId: null, studentGroupId: a.id, minGradeLevel: null, maxGradeLevel: null, name: 'I dag' },
      ],
      drillGroupId: a.id,
    });
    const none = lineOf(coverage, a, 'none') as DeliveredLineDetail;
    expect(none).toMatchObject({ subjectId: null, creditedMinutes: 240, projectedMinutes: 300, status: 'NO_PLAN' });
    expect(none.projection.creditsAhead).toBe(60);
  });

  it('walks each master lesson from its own horizon: a lesson created after publish, a gap, today’s lesson still to come', () => {
    const late = master(a, S.MA, 4, { startTime: '13:00', endTime: '14:00' }); // no rows; today 13:00 still ahead
    const early = master(a, S.MA, 4, { startTime: '08:00', endTime: '09:00' }); // no rows; today 08:00 already over
    const shortHorizon = master(a, S.MA, 1); // published only through 12 Oct
    const ahead = (lessons: DeliveredMasterLesson[], horizon: DeliveredCoverageInput['horizon'] = []) =>
      (
        lineOf(
          compute({ planned: { groups: [a] }, masterLessons: lessons, horizon, audiences: [row(a, S.MA, 'AHEAD', 0)], drillGroupId: a.id }),
          a,
          `subject:${S.MA}`,
        ) as DeliveredLineDetail
      ).projection.masterAhead;
    // Today's 13:00 lesson has not happened yet and counts; today's 08:00 has.
    expect(ahead([late]) - ahead([early])).toBe(60);
    // A lesson with no calendar row at all is projected from today, not
    // dropped (R1): the 29 Thursdays from 8 Oct to 10 Jun outside the lov.
    expect(ahead([late])).toBe(29 * 60);
    // Published only through Monday 12 Oct: walked from the 13th, so the 12th
    // is the calendar's and neither lost nor counted twice.
    expect(ahead([shortHorizon], [{ masterLessonId: shortHorizon.id, aheadRows: 1, firstDate: '2026-08-17', lastDate: '2026-10-12' }])).toBe(
      ahead([shortHorizon]) - 60,
    );
  });

  it('reports a parked lesson whose rows remain as drift, and a calendar missing a row the master would write', () => {
    const parked = master(a, S.MA, 1, { isParked: true });
    const live = master(a, S.MA, 5);
    const coverage = compute({
      planned: { groups: [a] },
      masterLessons: [parked, live],
      horizon: [
        { masterLessonId: parked.id, aheadRows: 2, firstDate: '2026-08-17', lastDate: '2026-10-19' },
        // Fridays 9, 16, 23 Oct would be written; the calendar holds two.
        { masterLessonId: live.id, aheadRows: 2, firstDate: '2026-08-21', lastDate: '2026-10-23' },
      ],
    });
    expect(coverage.drift).toEqual({ minutes: -120 + 60, lessons: 2 });
    expect(coverage.verdicts.find((v) => v.code === 'TIMPLAN_CALENDAR_DRIFT')).toMatchObject({ params: { minutes: -60, lessons: 2 } });
  });

  it('leaves teacherless time ahead out of the projection and reports it beside', () => {
    const nobody = master(a, S.MA, 2, { teacherId: null });
    const coverage = compute({
      planned: { groups: [a], requirements: [req(a, S.MA, 1, 60)] },
      masterLessons: [nobody],
      audiences: [row(a, S.MA, 'AHEAD_TEACHERLESS', 2)],
      drillGroupId: a.id,
    });
    const projection = (lineOf(coverage, a, `subject:${S.MA}`) as DeliveredLineDetail).projection;
    expect(projection.masterAhead).toBe(0);
    expect(projection.aheadTeacherless).toBeGreaterThan(120);
    expect(projection.projectedMinutes).toBe(0);
  });

  it('does not call a line short for the weeks before the school started publishing, and says so', () => {
    const coverage = compute({
      planned: { groups: [a], requirements: [req(a, S.MA, 1, 60)] },
      published: { from: '2026-10-05', through: '2026-10-23' },
      masterLessons: [master(a, S.MA, 1)],
      horizon: [],
      audiences: [row(a, S.MA, 'DELIVERED', 1)],
    });
    const line = lineOf(coverage, a, `subject:${S.MA}`);
    // 17 Aug – 2 Oct: 35 weekdays, less the friluftsdag (a lov for åk 7–9),
    // at a fifth of 60 each → 34 × 12.
    expect(line.unrecordedMinutes).toBe(408);
    expect(line.status).toBe('ON_TRACK');
    expect(coverage.verdicts.find((v) => v.code === 'TIMPLAN_PUBLISHED_LATE')).toMatchObject({ params: { from: '2026-10-05' } });
  });

  it('counts the planned minutes of unrecorded days by the day, odd weeks and lov out', () => {
    const odd = req(a, S.MA, 1, 60, { recurrence: 'ODD_WEEKS' });
    // 2026-10-26 … 11-06: höstlov week (44, even) then week 45 (odd): five days of 12.
    expect(plannedMinutesBetween(odd, '2026-10-26', '2026-11-06', YEAR, CLOSURES, 8)).toBe(60);
    expect(plannedMinutesBetween(req(a, S.MA, 1, 60), '2026-09-25', '2026-09-25', YEAR, CLOSURES, 8)).toBe(0);
    expect(plannedMinutesBetween(req(a, S.MA, 1, 60), '2026-09-25', '2026-09-25', YEAR, CLOSURES, 6)).toBe(12);
  });

  it('asks statement D about every credit date in the year and every past break day', () => {
    expect(deliveredDatesToAsk([{ date: '2026-09-02' }, { date: '2027-09-01' }], BREAKS, YEAR, AS_OF_DATE)).toEqual([
      '2026-09-02',
      '2026-09-25',
    ]);
  });

  it('counts a lesson in a DST week at its wall-clock 60 minutes', () => {
    // Sunday 25 Oct 2026 the clocks go back; Monday 26 is höstlov, so take Tuesday 3 Nov … and the master minutes.
    const dst = master(a, S.MA, 7, { startTime: '01:30', endTime: '02:30', startDate: '2026-10-25', endDate: '2026-10-25' });
    const coverage = compute({ planned: { groups: [a] }, masterLessons: [dst], drillGroupId: a.id });
    expect((lineOf(coverage, a, `subject:${S.MA}`) as DeliveredLineDetail).projection.masterAhead).toBe(60);
  });

  it('agrees with P2’s planned hours to the tenth for every class line', () => {
    const b = group('8B', 'CLASS', 8);
    const rows = [req(a, S.MA, 3, 60), req(a, S.SV, 2, 80, { lessonLengths: [80, 40] }), req(b, S.MA, 1, 60, { recurrence: 'ODD_WEEKS', startDate: '2027-01-11' })];
    const planned = computePlannedCoverage({ year: YEAR, closures: CLOSURES, plans: [], attachments: [], subjects: SUBJECTS, groups: [a, b], requirements: rows, pupils: [], includePupils: false });
    const delivered = compute({ planned: { groups: [a, b], requirements: rows } });
    for (const cell of planned.cells) {
      const line = lineOf(delivered, cell.studentGroupId === a.id ? a : b, `subject:${cell.subjectId}`);
      expect(Math.abs(line.plannedYearMinutes / 60 - cell.plannedHours)).toBeLessThanOrEqual(0.05);
    }
  });

  it('takes the median of an even number of pupils as the rounded mean of the middle two', () => {
    const c = group('9C', 'CLASS', 9);
    const t = group('Ma 9 extra', 'TEACHING_GROUP', null);
    const pupils = [pupil(c), pupil(c), pupil(c, [t]), pupil(c, [t])];
    const coverage = compute({
      planned: { groups: [c, t], requirements: [req(c, S.MA, 1, 60)], pupils },
      audiences: [row(c, S.MA, 'DELIVERED', 2), row(t, S.MA, 'DELIVERED', 1)],
    });
    expect(lineOf(coverage, c, `subject:${S.MA}`).pupils!.delivered).toEqual({ min: 120, median: 150, max: 180, below: 0 });
  });
});
