import cases from '../common/__fixtures__/pupil-gaps-cases.json';
import { lockMarginOf, pupilCohortsOf } from '../optimization/pupil-cohorts';
import { dayIdleMinutes, frameWindow, mergeIntervals } from './swap-gaps';
import { buildSoftMeasure } from './swap-soft';
import type { SwapLesson } from './swap-types';

/*
 * The håltimmar of a proposal are the håltimmesrapport's and the generator's:
 * every case of src/common/__fixtures__/pupil-gaps-cases.json gives, through
 * the cohorts and the arithmetic this module uses, the number the report
 * (web/lib/gaps.contract.test.ts) and the engine (test_pupil_gaps.py) give.
 */

interface SchoolCase {
  name: string;
  groups: { id: string; kind: string; halfOfId: string | null; replacesSubjectId: string | null; years: [number, number] }[];
  pupils: { id: string; home: string; groups: string[] }[];
  buffers: { group: string; subject: string; minutesBefore: number; minutesAfter: number }[];
  lessons: {
    id: string;
    groups: string[];
    subject: string;
    day: number;
    start: string;
    end: string;
    pupils: string[];
    locked: boolean;
    weeks?: 'ODD_WEEKS' | 'EVEN_WEEKS';
  }[];
  constraints: { kind: 'STUDENT_GROUP' | 'GRADE_LEVEL'; group: string | null; min: number | null; max: number | null; day: number | null; start: string; end: string }[];
  frames: { min: number; max: number; day: number | null; start: string; end: string }[];
  lunch: { start: string; end: string; minutes: number } | null;
  pupilIdleMinutes: number;
}

const all = (cases as unknown as { cases: SchoolCase[] }).cases;

const minutes = (time: string): number => {
  const [h, m] = time.split(':');
  return Number(h) * 60 + Number(m);
};

function idleOf(school: SchoolCase): number {
  const lessons: SwapLesson[] = school.lessons.map((lesson) => ({
    id: lesson.id,
    subjectId: lesson.subject,
    subjectName: lesson.subject,
    studentGroupId: lesson.groups[0]!,
    groupName: lesson.groups[0]!,
    teacherId: null,
    coTeacherId: null,
    roomId: null,
    dayOfWeek: lesson.day,
    startMinutes: minutes(lesson.start),
    endMinutes: minutes(lesson.end),
    recurrence: lesson.weeks ?? 'ALL_WEEKS',
    startDate: null,
    endDate: null,
    isLocked: lesson.locked,
    isGenerated: false,
    extraGroupIds: lesson.groups.slice(1),
    studentIds: lesson.pupils,
  }));
  const cohorts = pupilCohortsOf({
    homeOf: new Map(school.pupils.map((pupil) => [pupil.id, pupil.home])),
    groupsOf: new Map(school.pupils.map((pupil) => [pupil.id, new Set([pupil.home, ...pupil.groups])])),
    groups: school.groups,
    derivedKeys: [],
    locks: lessons.map((lesson) => ({
      id: lesson.id,
      groupIds: [lesson.studentGroupId, ...lesson.extraGroupIds],
      subjectId: lesson.subjectId,
      pupilIds: lesson.studentIds,
    })),
  });
  const rows = new Map(
    school.buffers.map((row) => [`${row.group}:${row.subject}`, { minutesBefore: row.minutesBefore, minutesAfter: row.minutesAfter }]),
  );
  const margins = new Map<string, { before: number; after: number }>();
  for (const lesson of lessons) {
    const margin = lockMarginOf(rows, { groupIds: [lesson.studentGroupId, ...lesson.extraGroupIds], subjectId: lesson.subjectId });
    if (margin) margins.set(lesson.id, { before: margin.minutesBefore, after: margin.minutesAfter });
  }
  return buildSoftMeasure({
    lessons,
    cohorts: cohorts.map((cohort) => ({
      pupils: cohort.pupils,
      lessonIds: new Set(cohort.fixedLessonIds),
      groups: cohort.groupIds,
    })),
    margins,
    spans: new Map(school.groups.map((group) => [group.id, group.years])),
    constraints: school.constraints.map((row) => ({
      kind: row.kind,
      group: row.group,
      min: row.min,
      max: row.max,
      day: row.day,
      start: minutes(row.start),
      end: minutes(row.end),
    })),
    frames: school.frames.map((row) => ({ ...row, start: minutes(row.start), end: minutes(row.end) })),
    lunch: school.lunch ? { start: minutes(school.lunch.start), end: minutes(school.lunch.end), minutes: school.lunch.minutes } : null,
    teacherRules: new Map(),
    distribution: new Map(),
  }).baseline().pupilIdleMinutes;
}

describe('håltimmar: the contract fixture', () => {
  it.each(all.map((school) => [school.name, school] as const))('%s', (_name, school) => {
    expect(idleOf(school)).toBe(school.pupilIdleMinutes);
  });
});

describe('håltimmar: the arithmetic', () => {
  it('counts a hole of a quarter of an hour and not one under it', () => {
    expect(dayIdleMinutes([[480, 540], [555, 600]], [], null)).toBe(15);
    expect(dayIdleMinutes([[480, 540], [554, 600]], [], null)).toBe(0);
  });

  it('hands lunch out once, in clock order', () => {
    // Two holes of 40 minutes, both inside the window, 30 minutes of lunch: the
    // first takes all of it and is left with 10 (a rast); the second is a hole of 40.
    expect(dayIdleMinutes([[480, 540], [580, 640], [680, 740]], [], { start: 540, end: 680, minutes: 30 })).toBe(40);
  });

  it('does not count closed time as a hole', () => {
    expect(dayIdleMinutes([[480, 540], [660, 720]], [[540, 660]], null)).toBe(0);
  });

  it('joins touching intervals', () => {
    expect(mergeIntervals([[0, 10], [10, 20], [30, 40]])).toEqual([[0, 20], [30, 40]]);
  });

  it('takes the intersection of the frames that reach the span, and nothing when they do not meet', () => {
    const frames = [
      { min: 7, max: 9, day: null, start: 480, end: 900 },
      { min: 7, max: 9, day: 5, start: 480, end: 780 },
    ];
    expect(frameWindow(frames, [7, 7], 2)).toEqual([480, 900]);
    expect(frameWindow(frames, [7, 7], 5)).toEqual([480, 780]);
    expect(frameWindow([{ min: 7, max: 9, day: null, start: 900, end: 600 }], [8, 8], 1)).toBeNull();
    expect(frameWindow(frames, [1, 3], 1)).toEqual([0, 1440]);
  });
});
