import fixture from './__fixtures__/timplan-planned-cases.json';
import {
  computePlannedCoverage,
  type PlannedCoverage,
  type PlannedCoverageInput,
  type PlannedGroupSummary,
  type PlannedPupil,
} from './timplan-planned';

/**
 * The planned layer's drill-down (drillGroupId): every pupil of one class with
 * every line, where the overview lists only the pupils with a finding of their
 * own.
 *
 * THE DRILL-DOWN IS THE OVERVIEW'S PUPILS, NOT A SECOND COMPUTATION. A line's
 * min / median / max and `below` in the overview are figures over the class's
 * pupils; the drill-down lists those pupils line by line. So for every class of
 * every fixture case (54 of them: halves, replacing groups, the alternatives,
 * the parts of a national subject, dated rows, a rolled year's rosters) the
 * figures re-derived from the drilled pupils must equal the overview's, and
 * nothing else in the answer may move.
 */

interface FixtureCase {
  name: string;
  input: PlannedCoverageInput;
  coverage: PlannedCoverage;
}

const { cases } = fixture as unknown as { cases: FixtureCase[] };

/** min / median / max / below of a line over the pupils, re-derived from the drilled lines alone. */
function figuresOf(pupils: PlannedPupil[], key: string, target: number | null) {
  const values = pupils
    .map((pupil) => pupil.lines.find((line) => line.key === key)?.plannedMinutesPerWeek ?? 0)
    .sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return {
    min: values[0]!,
    median: values.length % 2 === 1 ? values[middle]! : Math.round((values[middle - 1]! + values[middle]!) / 2),
    max: values[values.length - 1]!,
    below: target === null ? 0 : values.filter((value) => value < target).length,
  };
}

const classesOf = (coverage: PlannedCoverage): PlannedGroupSummary[] => coverage.groups;

describe('the planned layer’s drill-down agrees with the overview', () => {
  const withPupils = cases.filter((entry) => entry.input.includePupils && entry.input.pupils.length > 0);

  it('has cases with pupils to drill into, in more than one kind of class', () => {
    expect(withPupils.length).toBeGreaterThanOrEqual(40);
    const lines = withPupils.flatMap((entry) => entry.coverage.groups.flatMap((group) => group.lines));
    expect(lines.some((line) => line.nationalCode !== undefined)).toBe(true);
    expect(lines.some((line) => line.alternativeCode !== null)).toBe(true);
    expect(lines.some((line) => line.status === 'PUPILS')).toBe(true);
    expect(withPupils.some((entry) => entry.input.groups.some((group) => group.halfOfId))).toBe(true);
    expect(withPupils.some((entry) => entry.input.groups.some((group) => group.replacesSubjectId))).toBe(true);
  });

  it.each(withPupils.map((entry) => [entry.name, entry] as const))(
    'figures every class of: %s',
    (_name, entry) => {
      const overview = computePlannedCoverage(entry.input);
      for (const summary of classesOf(overview)) {
        const drilled = computePlannedCoverage({ ...entry.input, drillGroupId: summary.studentGroupId });
        const ofClass = (drilled.pupils ?? []).filter((pupil) => pupil.homeGroupId === summary.studentGroupId);

        // Every pupil of the class, once — the ones the overview counts.
        expect(ofClass).toHaveLength(summary.pupilCount);
        expect(new Set(ofClass.map((pupil) => pupil.pupilId)).size).toBe(summary.pupilCount);

        // The overview's min / median / max and below, from the drilled lines.
        for (const line of summary.lines) {
          if (line.pupils === undefined) {
            expect(summary.pupilCount).toBe(0);
            continue;
          }
          expect({ line: line.key, ...figuresOf(ofClass, line.key, line.targetMinutesPerWeek) }).toEqual({
            line: line.key,
            ...line.pupils,
          });
        }

        // The pupils with a finding of their own keep exactly the lines they had.
        for (const own of overview.pupils ?? []) {
          if (own.homeGroupId !== summary.studentGroupId) continue;
          const listed = ofClass.find((pupil) => pupil.pupilId === own.pupilId)!;
          for (const line of own.lines) expect(listed.lines).toContainEqual(line);
        }
      }
    },
  );

  it.each(withPupils.map((entry) => [entry.name, entry] as const))(
    'moves nothing but the pupil list of: %s',
    (_name, entry) => {
      const overview = computePlannedCoverage(entry.input);
      for (const summary of classesOf(overview)) {
        const drilled = computePlannedCoverage({ ...entry.input, drillGroupId: summary.studentGroupId });
        expect({ ...drilled, pupils: null }).toEqual({ ...overview, pupils: null });
        // The other classes are listed as before.
        const others = (list: PlannedPupil[] | null) =>
          (list ?? []).filter((pupil) => pupil.homeGroupId !== summary.studentGroupId);
        expect(others(drilled.pupils)).toEqual(others(overview.pupils));
      }
    },
  );

  it.each(cases.filter((entry) => entry.input.pupils.length > 0).map((entry) => [entry.name, entry] as const))(
    'gives a teacher’s read no pupil by being asked for a class: %s',
    (_name, entry) => {
      const teacher = { ...entry.input, includePupils: false };
      const classId = entry.input.groups.find((group) => group.kind === 'CLASS')?.id ?? null;
      const asked = computePlannedCoverage({ ...teacher, drillGroupId: classId });
      expect(asked).toEqual(computePlannedCoverage(teacher));
      expect(asked.pupils).toBeNull();
      expect(JSON.stringify(asked)).not.toContain(entry.input.pupils[0]!.id);
    },
  );
});

describe('the planned layer’s drill-down, by hand', () => {
  const PLAN = '00000000-0000-4000-8000-000000000201';
  const MA = '00000000-0000-4000-8000-000000000101';
  const SPA = '00000000-0000-4000-8000-000000000102';
  const IDH = '00000000-0000-4000-8000-000000000103';
  const A8 = '00000000-0000-4000-8000-000000000301';
  const B8 = '00000000-0000-4000-8000-000000000302';
  const SPANSKA = '00000000-0000-4000-8000-000000000303';
  const ANNA = '00000000-0000-4000-8000-000000000401';
  const BO = '00000000-0000-4000-8000-000000000402';
  const CIA = '00000000-0000-4000-8000-000000000403';
  const DAN = '00000000-0000-4000-8000-000000000404';

  /**
   * 8A is short of Matematik (120 of 180) and nobody in it is short alone: the
   * overview counts Anna, Bo and Cia below target and lists none of them. Anna
   * has Spanska 8 (90 of 90); Bo and Cia have no Spanska at all, but Spanska
   * 8 reaches one pupil of three, so the class line is UNPLANNED and the
   * shortfall is the class's. Idrott has posts and no target. 8B is a class of
   * one on target, so the drill-down of one class says nothing of the other.
   */
  const world = (patch: Partial<PlannedCoverageInput> = {}): PlannedCoverageInput => ({
    year: { startDate: '2026-08-17', endDate: '2027-06-11' },
    closures: [],
    plans: [
      {
        id: PLAN,
        name: 'Grundskolan 2024',
        status: 'DECIDED',
        entries: [
          { subjectId: MA, gradeLevel: 8, minutesPerWeek: 180 },
          { subjectId: SPA, gradeLevel: 8, minutesPerWeek: 90 },
        ],
      },
    ],
    attachments: [{ gradeLevel: 8, localTimplanId: PLAN }],
    subjects: [
      { id: MA, name: 'Matematik', nationalCode: 'MA', countsTowardTimplan: true },
      { id: SPA, name: 'Spanska', nationalCode: 'M2', countsTowardTimplan: true },
      { id: IDH, name: 'Idrott och hälsa', nationalCode: 'IDH', countsTowardTimplan: true },
    ],
    groups: [
      { id: A8, name: '8A', kind: 'CLASS', gradeLevel: 8 },
      { id: B8, name: '8B', kind: 'CLASS', gradeLevel: 8 },
      { id: SPANSKA, name: 'Spanska 8', kind: 'TEACHING_GROUP', gradeLevel: null },
    ],
    requirements: [
      { id: 'r1', studentGroupId: A8, subjectId: MA, lessonsPerWeek: 2, minutesPerLesson: 60, recurrence: 'ALL_WEEKS', startDate: null, endDate: null },
      { id: 'r2', studentGroupId: A8, subjectId: IDH, lessonsPerWeek: 2, minutesPerLesson: 40, recurrence: 'ALL_WEEKS', startDate: null, endDate: null },
      { id: 'r3', studentGroupId: SPANSKA, subjectId: SPA, lessonsPerWeek: 3, minutesPerLesson: 30, recurrence: 'ALL_WEEKS', startDate: null, endDate: null },
      { id: 'r4', studentGroupId: B8, subjectId: MA, lessonsPerWeek: 3, minutesPerLesson: 60, recurrence: 'ALL_WEEKS', startDate: null, endDate: null },
      { id: 'r5', studentGroupId: B8, subjectId: SPA, lessonsPerWeek: 3, minutesPerLesson: 30, recurrence: 'ALL_WEEKS', startDate: null, endDate: null },
    ],
    pupils: [
      { id: ANNA, homeGroupId: A8, groupIds: [SPANSKA] },
      { id: BO, homeGroupId: A8, groupIds: [] },
      { id: CIA, homeGroupId: A8, groupIds: [] },
      { id: DAN, homeGroupId: B8, groupIds: [] },
    ],
    includePupils: true,
    ...patch,
  });

  const lineOf = (pupil: PlannedPupil | undefined, subjectId: string) =>
    pupil?.lines.find((line) => line.subjectIds.includes(subjectId));

  it('counts a pupil who is short because the class is short, and does not list them', () => {
    const overview = computePlannedCoverage(world());
    expect(overview.pupilsBelowTarget).toBe(3);
    expect(overview.pupils).toEqual([]);
    expect(overview.groups[0]!.lines.find((line) => line.subjectIds.includes(MA))).toMatchObject({
      status: 'UNDER',
      pupils: { min: 120, median: 120, max: 120, below: 3 },
    });
  });

  it('lists them all in the drill-down, each with every line, its target, its sources and its status', () => {
    const drilled = computePlannedCoverage(world({ drillGroupId: A8 }));
    const ofA8 = (drilled.pupils ?? []).filter((pupil) => pupil.homeGroupId === A8);
    expect(ofA8.map((pupil) => pupil.pupilId)).toEqual([ANNA, BO, CIA]);

    const [anna, bo, cia] = ofA8;
    // Idrott och hälsa has no target: a line to read, not one to judge.
    expect(lineOf(bo, IDH)).toMatchObject({
      targetMinutesPerWeek: null,
      plannedMinutesPerWeek: 80,
      status: 'NO_TARGET',
      sources: [{ studentGroupId: A8, subjectId: IDH, minutesPerWeek: 80 }],
    });
    // Matematik comes from the class alone, 120 of 180, for all three.
    for (const pupil of [anna, bo, cia]) {
      expect(lineOf(pupil, MA)).toMatchObject({
        targetMinutesPerWeek: 180,
        plannedMinutesPerWeek: 120,
        status: 'UNDER',
        sources: [{ studentGroupId: A8, subjectId: MA, minutesPerWeek: 120 }],
      });
    }
    // Spanska is Anna's from the group, and nobody else's: 0 of 90 with no source.
    expect(lineOf(anna, SPA)).toMatchObject({
      targetMinutesPerWeek: 90,
      plannedMinutesPerWeek: 90,
      status: 'MET',
      sources: [{ studentGroupId: SPANSKA, subjectId: SPA, minutesPerWeek: 90 }],
    });
    for (const pupil of [bo, cia]) {
      expect(lineOf(pupil, SPA)).toMatchObject({ plannedMinutesPerWeek: 0, status: 'UNDER', sources: [] });
    }
    // The lines come in the overview's order, by subject name.
    expect(anna!.lines.map((line) => line.subjectIds[0])).toEqual([IDH, MA, SPA]);
  });

  it('is the class’s pupils alone, and leaves 8B to its own drill-down', () => {
    const drilled = computePlannedCoverage(world({ drillGroupId: A8 }));
    expect((drilled.pupils ?? []).some((pupil) => pupil.pupilId === DAN)).toBe(false);

    const other = computePlannedCoverage(world({ drillGroupId: B8 }));
    const dan = (other.pupils ?? []).find((pupil) => pupil.pupilId === DAN);
    expect(dan?.lines.map((line) => line.status)).toEqual(['MET', 'MET']);
    expect((other.pupils ?? []).some((pupil) => pupil.homeGroupId === A8)).toBe(false);
  });

  it('lists a class of no plan with its pupils and the lines their posts make', () => {
    const drilled = computePlannedCoverage(world({ drillGroupId: A8, attachments: [] }));
    const bo = (drilled.pupils ?? []).find((pupil) => pupil.pupilId === BO)!;
    expect(bo.lines.map((line) => [line.subjectIds[0], line.status])).toEqual([
      [IDH, 'NO_TARGET'],
      [MA, 'NO_TARGET'],
    ]);
  });

  it('lists a pupil with no line at all rather than leaving them out', () => {
    const input = world({ drillGroupId: A8, attachments: [], requirements: [] });
    const drilled = computePlannedCoverage(input);
    expect((drilled.pupils ?? []).map((pupil) => [pupil.pupilId, pupil.lines])).toEqual([
      [ANNA, []],
      [BO, []],
      [CIA, []],
    ]);
    // And without the drill-down the same pupils are not listed.
    expect(computePlannedCoverage(world({ attachments: [], requirements: [] })).pupils).toEqual([]);
  });

  it('asks nothing of a group that is not a class', () => {
    const base = computePlannedCoverage(world());
    expect(computePlannedCoverage(world({ drillGroupId: SPANSKA }))).toEqual(base);
    expect(computePlannedCoverage(world({ drillGroupId: '00000000-0000-4000-8000-0000000009ff' }))).toEqual(base);
    expect(computePlannedCoverage(world({ drillGroupId: null }))).toEqual(base);
  });

  it('gives a teacher’s read nothing for the class it is asked about', () => {
    const asked = computePlannedCoverage(world({ drillGroupId: A8, includePupils: false }));
    expect(asked.pupils).toBeNull();
    expect(asked.pupilsBelowTarget).toBeNull();
    expect(JSON.stringify(asked)).not.toContain(ANNA);
    expect(asked).toEqual(computePlannedCoverage(world({ includePupils: false })));
  });
});
