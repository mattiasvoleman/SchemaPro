import { buildKeyFigures } from './key-figures';
import { ANNA, BO, CY, audiences, report, schoolInput } from './__fixtures__/school';

const figures = (overrides: Parameters<typeof report>[0] = {}, extra: Partial<Parameters<typeof buildKeyFigures>[0]> = {}) =>
  buildKeyFigures({
    planned: report(overrides),
    scheduled: null,
    audiences,
    fullTimeMinutesPerWeek: 1080,
    readsHr: true,
    employmentOn: '2026-10-15',
    ...extra,
  });

const teacher = (result: ReturnType<typeof figures>, userId: string) => result.teachers.find((row) => row.userId === userId)!;

describe('buildKeyFigures: per teacher', () => {
  const result = figures();

  it("states the teacher's undervisning, uppdrag, target and status as the load report does, and adds nothing of its own", () => {
    const planned = report();
    const anna = planned.teachers.find((row) => row.userId === ANNA)!;
    expect(teacher(result, ANNA)).toMatchObject({
      teachingMinutesPerWeek: anna.assignedMinutesPerWeek,
      dutyMinutesPerWeek: anna.dutyMinutesPerWeek,
      countedMinutesPerWeek: anna.countedMinutesPerWeek,
      targetMinutesPerWeek: anna.targetMinutesPerWeek,
      percentOfTarget: anna.percentOfTarget,
      status: anna.status,
      teachingHoursPerYear: anna.annual.assignedHoursPerYear,
    });
    expect(teacher(result, ANNA).teachingMinutesPerWeek).toBe(420);
  });

  it('counts the distinct pupils and groups a teacher teaches, a pupil on two rows once', () => {
    // ANNA: 7A (p1–p4), 8A (p5, p6) and MaN (p1, p5): six pupils, three groups.
    expect(teacher(result, ANNA)).toMatchObject({ pupils: 6, groups: 3 });
    // BO: 7A, and 9A that has nobody.
    expect(teacher(result, BO)).toMatchObject({ pupils: 4, groups: 2 });
    // CY: beside ANNA in MaN alone.
    expect(teacher(result, CY)).toMatchObject({ pupils: 2, groups: 1 });
  });

  it("reads a post that changes during the year on the day it is asked for, not on its base row", () => {
    // ANNA starts the year at 100 % and goes down to 60 % from 1 January: the base row alone would say 100 all year.
    const employments = [
      { ...schoolInput().employments[0]!, periods: [{ validFrom: '2027-01-01', validTo: null, employmentPercent: 60, reductionPercent: 0, teachingTargetMinutesPerWeek: null }] },
      ...schoolInput().employments.slice(1),
    ];
    const before = figures({ employments }, { employmentOn: '2026-12-31' });
    const after = figures({ employments }, { employmentOn: '2027-01-01' });
    expect(teacher(before, ANNA).employmentPercent).toBe(100);
    expect(teacher(after, ANNA).employmentPercent).toBe(60);
    expect(teacher(after, BO).employmentPercent).toBe(50);
    // The school's heltidstjänster by tjänstgöringsgrad follow the same day: 1.0 + 0.5 + 0.8 before, 0.6 + 0.5 + 0.8 after.
    expect(before.school.employmentFte).toBe(2.3);
    expect(after.school.employmentFte).toBe(1.9);
  });

  it("states tjänstgöringsgrad only to a reader of HR data, and says nothing of it otherwise", () => {
    expect(teacher(result, ANNA).employmentPercent).toBe(100);
    expect(teacher(result, BO).employmentPercent).toBe(50);
    const hidden = figures({}, { readsHr: false });
    expect(hidden.teachers.every((row) => row.employmentPercent === null)).toBe(true);
    expect(hidden.school.employmentFte).toBeUndefined();
    expect(hidden.school.employmentFtePer100Pupils).toBeUndefined();
  });

  it("shares a teacher's clock time between the rows a behörighet covers and those it does not", () => {
    expect(teacher(result, ANNA).qualifiedShare).toBe(1);
    // BO holds no behörighet at all: every minute of 180 is outside it.
    expect(teacher(result, BO).qualifiedShare).toBe(0);
    expect(teacher(result, CY).qualifiedShare).toBe(1);
  });

  it('judges nobody when the school has recorded no behörighet', () => {
    const none = figures({ qualifications: [] });
    expect(none.teachers.every((row) => row.qualifiedShare === null)).toBe(true);
    expect(none.school).toMatchObject({ qualificationsRecorded: false, qualifiedShare: null, qualifiedMinutesPerWeek: 0, unqualifiedMinutesPerWeek: 0 });
  });

  it('keeps the grundschema out until a lesson is laid, and states it per teacher once it is', () => {
    expect(result.teachers.every((row) => row.scheduledMinutesPerWeek === null)).toBe(true);
    const laid = report({ requirements: schoolInput().requirements.slice(0, 1) });
    const withScheduled = figures({}, { scheduled: laid });
    expect(teacher(withScheduled, ANNA).scheduledMinutesPerWeek).toBe(180);
    // A teacher the laid schedule has no row for is at 0, not unknown.
    expect(teacher(withScheduled, BO).scheduledMinutesPerWeek).toBe(0);
    // A grundschema with no lesson in it is not "everybody at 0".
    const empty = figures({}, { scheduled: report({ requirements: [] }) });
    expect(empty.teachers.every((row) => row.scheduledMinutesPerWeek === null)).toBe(true);
  });
});

describe('buildKeyFigures: per school', () => {
  const { school } = figures();

  it('counts the pupils with a class and the teachers with a row', () => {
    expect(school.pupils).toBe(6);
    expect(school.teachers).toBe(3);
  });

  it("states the lärartäthet from the teaching alone: the load's minutes over the riktmärke, per 100 pupils", () => {
    // 420 + 180 + 60 = 660 charged minutes: the co-teacher's row charges CY the same hour as ANNA.
    const minutes = report().teachers.reduce((sum, row) => sum + row.assignedMinutesPerWeek, 0);
    expect(school.teachingMinutesPerWeek).toBe(minutes);
    expect(school.teachingFte).toBe(Math.round((minutes / 1080) * 100) / 100);
    expect(school.teachingFtePer100Pupils).toBe(Math.round(((minutes / 1080) / 6) * 10000) / 100);
    expect(school.teachersPer100Pupils).toBe(50);
    expect(school.pupilsPerTeacher).toBe(2);
  });

  it('gives behöriga lärares andel of the clock time and the lessons nobody leads beside it', () => {
    const covered = school.qualifiedMinutesPerWeek;
    const uncovered = school.unqualifiedMinutesPerWeek;
    expect(uncovered).toBe(180);
    expect(school.qualifiedShare).toBe(Math.round((covered / (covered + uncovered)) * 10000) / 10000);
    const unstaffed = figures({ requirements: [...schoolInput().requirements, { ...schoolInput().requirements[0]!, id: 'x', teacherId: null }] });
    expect(unstaffed.school.unstaffedMinutesPerWeek).toBe(180);
    expect(school.unstaffedMinutesPerWeek).toBe(0);
  });

  it('adds the tjänstgöringsgrad-based figure for a reader of HR data, and only for them', () => {
    expect(school.employmentFte).toBe(2.3);
    expect(school.employmentFtePer100Pupils).toBe(38.33);
  });

  it('states no heltidstjänst without a riktmärke, and no per-100 figure without pupils', () => {
    const noFullTime = figures({}, { fullTimeMinutesPerWeek: null }).school;
    expect(noFullTime).toMatchObject({ fullTimeTeachingMinutesPerWeek: null, teachingFte: null, teachingFtePer100Pupils: null });
    expect(noFullTime.teachersPer100Pupils).toBe(50);
    const noPupils = buildKeyFigures({
      planned: report(),
      scheduled: null,
      audiences: { ...audiences, schoolPupils: [] },
      fullTimeMinutesPerWeek: 1080,
      readsHr: true,
      employmentOn: '2026-10-15',
    }).school;
    expect(noPupils).toMatchObject({ pupils: 0, teachersPer100Pupils: null, teachingFtePer100Pupils: null, employmentFtePer100Pupils: null });
  });

  it('is empty and calm for a school without teachers', () => {
    const empty = figures({ requirements: [], employments: [], qualifications: [] }).school;
    expect(empty).toMatchObject({ teachers: 0, teachingMinutesPerWeek: 0, pupilsPerTeacher: null, qualifiedShare: null, teachingFte: 0 });
  });
});
