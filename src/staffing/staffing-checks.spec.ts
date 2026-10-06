import { ConflictException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_CHECK_POLICY,
  STAFF_TEACHER_NOT_QUALIFIED,
  STAFF_TEACHER_OVER_TARGET,
  STAFF_UNSTAFFED_REQUIREMENTS,
  gradesParam,
  judgeRequirementWrite,
  overTargetFinding,
  qualificationFinding,
  settleFindings,
  staffingSentence,
  type CheckPolicy,
  type StaffingFinding,
  type StaffingWarning,
} from './staffing-checks';
import type { LoadEmployment, LoadInput, LoadQualification, LoadRequirement } from './teacher-load';

const YEAR = { startDate: '2026-08-17', endDate: '2027-06-11' };
const ANNA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MA = 'subject-ma';

const policy = (overrides: Partial<CheckPolicy> = {}): CheckPolicy => ({
  ...DEFAULT_CHECK_POLICY,
  fullTimeTeachingMinutesPerWeek: 1000,
  ...overrides,
});

const qualification = (overrides: Partial<LoadQualification> = {}): LoadQualification => ({
  userId: ANNA,
  subjectId: MA,
  minGradeLevel: 7,
  maxGradeLevel: 9,
  kind: 'LEGITIMATION',
  validFrom: null,
  validTo: null,
  ...overrides,
});

const employment = (userId: string, overrides: Partial<LoadEmployment> = {}): LoadEmployment => ({
  userId,
  employmentPercent: 100,
  reductionPercent: 0,
  contractKind: 'FERIE',
  teachingTargetMinutesPerWeek: null,
  signature: null,
  ...overrides,
});

const requirement = (overrides: Partial<LoadRequirement> = {}): LoadRequirement => ({
  id: 'req-1',
  subjectId: MA,
  subjectName: 'Matematik',
  studentGroupId: 'group-7a',
  groupName: '7A',
  teacherId: null,
  coTeacherId: null,
  lessonsPerWeek: 2,
  minutesPerLesson: 60,
  teacherLoadPercent: 100,
  coTeacherLoadPercent: 100,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  gradeSpan: { min: 7, max: 9 },
  ...overrides,
});

const input = (overrides: Partial<LoadInput> = {}): LoadInput => ({
  year: YEAR,
  policy: null,
  employments: [employment(ANNA)],
  requirements: [],
  qualifications: [qualification()],
  closures: [],
  duties: [],
  ...overrides,
});

describe('gradesParam', () => {
  it('writes a span as the engine does: one year once, a range with an en dash, unknown as any', () => {
    expect(gradesParam({ min: 7, max: 7 })).toBe('7');
    expect(gradesParam({ min: 7, max: 9 })).toBe('7–9');
    expect(gradesParam(null)).toBe('any');
  });
});

describe('qualificationFinding', () => {
  const ask = (overrides: Partial<Parameters<typeof qualificationFinding>[0]> = {}) =>
    qualificationFinding({
      policy: policy(),
      qualifications: [qualification({ userId: BO })],
      userId: ANNA,
      role: 'TEACHER',
      subject: { id: MA, name: 'Matematik' },
      span: { min: 7, max: 9 },
      window: YEAR,
      ...overrides,
    });

  it('names the subject and the span, and whose role it is — never the person', () => {
    expect(ask()).toEqual({
      code: STAFF_TEACHER_NOT_QUALIFIED,
      mode: 'WARN',
      userId: ANNA,
      params: { role: 'TEACHER', subject: 'Matematik', grades: '7–9' },
    });
  });

  it('carries the mode it was asked under', () => {
    expect(ask({ policy: policy({ qualificationMode: 'REFUSE' }) })?.mode).toBe('REFUSE');
  });

  it('asks nothing under OFF', () => {
    expect(ask({ policy: policy({ qualificationMode: 'OFF' }) })).toBeNull();
  });

  it('asks nothing of a school with no behörighet rows at all', () => {
    // Not "nobody is qualified": nothing has been recorded, and the report
    // reads it the same way (qualificationsRecorded: false).
    expect(ask({ qualifications: [] })).toBeNull();
  });

  it('passes a teacher whose behörighet covers the whole span', () => {
    expect(ask({ qualifications: [qualification()] })).toBeNull();
  });

  it('refuses a span the behörighet only half covers', () => {
    expect(
      ask({ qualifications: [qualification({ minGradeLevel: 7, maxGradeLevel: 8 })] }),
    ).not.toBeNull();
  });

  it('passes any behörighet in the subject when the group has no derivable years', () => {
    expect(
      ask({ qualifications: [qualification({ minGradeLevel: 1, maxGradeLevel: 3 })], span: null }),
    ).toBeNull();
    expect(ask({ span: null })?.params.grades).toBe('any');
  });

  it('reads validity against the window: the läsår for the plan, a day for a vikarie', () => {
    const fromAugust = qualification({ validFrom: '2026-08-01' });
    // Planned in spring for a year starting in August: valid in the year.
    expect(ask({ qualifications: [fromAugust] })).toBeNull();
    // A lesson in June before it starts: not valid that day.
    expect(
      ask({ qualifications: [fromAugust], window: { startDate: '2026-06-01', endDate: '2026-06-01' } }),
    ).not.toBeNull();
  });
});

describe('overTargetFinding', () => {
  const ask = (overrides: Partial<Parameters<typeof overTargetFinding>[0]> = {}) =>
    overTargetFinding({
      policy: policy(),
      employment: employment(ANNA),
      userId: ANNA,
      role: 'TEACHER',
      before: 1000,
      after: 1120,
      ...overrides,
    });

  it('names the minutes, the target, the limit and the tolerance', () => {
    expect(ask()).toEqual({
      code: STAFF_TEACHER_OVER_TARGET,
      mode: 'WARN',
      userId: ANNA,
      params: { role: 'TEACHER', minutes: 1120, target: 1000, limit: 1100, tolerance: 10 },
    });
  });

  it('lets exactly the limit through and refuses the first minute past it', () => {
    expect(ask({ after: 1100 })).toBeNull();
    expect(ask({ after: 1100.5 })).not.toBeNull();
  });

  it('is inert for a teacher with no target', () => {
    expect(ask({ employment: null })).toBeNull();
    expect(ask({ policy: policy({ fullTimeTeachingMinutesPerWeek: null }) })).toBeNull();
  });

  it('reads a per-teacher target even without a riktmärke', () => {
    const finding = ask({
      policy: policy({ fullTimeTeachingMinutesPerWeek: null }),
      employment: employment(ANNA, { teachingTargetMinutesPerWeek: 600 }),
      after: 700,
      before: 600,
    });
    expect(finding?.params).toMatchObject({ target: 600, limit: 660, minutes: 700 });
  });

  it('never fires on a write that does not add to the load', () => {
    // A teacher already over, whose row loses a lesson: still over, and the
    // PATCH is the fix, not the problem.
    expect(ask({ before: 1300, after: 1240 })).toBeNull();
    expect(ask({ before: 1300, after: 1300 })).toBeNull();
  });

  it('asks nothing under OFF', () => {
    expect(ask({ policy: policy({ overAllocationMode: 'OFF' }) })).toBeNull();
  });
});

describe('judgeRequirementWrite', () => {
  const judge = (args: {
    input?: LoadInput;
    policy?: CheckPolicy;
    before?: LoadRequirement | null;
    after: LoadRequirement;
  }) =>
    judgeRequirementWrite({
      input: args.input ?? input(),
      policy: args.policy ?? policy(),
      before: args.before ?? null,
      after: args.after,
      subjectName: args.after.subjectName,
    });

  it('asks nothing of a row with no teacher', () => {
    expect(judge({ after: requirement() })).toEqual([]);
  });

  it('asks behörighet of a teacher newly put on the row, lead and co-teacher alike', () => {
    const findings = judge({ after: requirement({ teacherId: BO, coTeacherId: BO.replace('b', 'c') }) });
    expect(findings.map((f) => [f.code, f.params.role])).toEqual([
      [STAFF_TEACHER_NOT_QUALIFIED, 'TEACHER'],
      [STAFF_TEACHER_NOT_QUALIFIED, 'CO_TEACHER'],
    ]);
  });

  it('does not ask behörighet again of the teacher the row already had', () => {
    const stored = requirement({ teacherId: BO });
    expect(
      judge({
        input: input({ requirements: [stored] }),
        before: stored,
        after: { ...stored, lessonsPerWeek: 3 },
      }),
    ).toEqual([]);
  });

  it('counts the year and the uppdrag that count, and refuses the write that takes them past', () => {
    // Anna: 8 × 60 = 480 teaching + a 500-minute counted uppdrag = 980; the
    // new row adds 120 → 1 100 is the limit exactly, 1 160 is past it.
    const year = input({
      requirements: [requirement({ id: 'req-0', teacherId: ANNA, lessonsPerWeek: 8 })],
      duties: [
        { userId: ANNA, minutesPerWeek: 500, countsAsTeaching: true },
        { userId: ANNA, minutesPerWeek: 900, countsAsTeaching: false },
      ],
    });
    expect(judge({ input: year, after: requirement({ teacherId: ANNA, lessonsPerWeek: 2 }) })).toEqual([]);
    const findings = judge({
      input: year,
      policy: policy({ overAllocationMode: 'REFUSE' }),
      after: requirement({ teacherId: ANNA, lessonsPerWeek: 3 }),
    });
    expect(findings).toEqual([
      expect.objectContaining({
        code: STAFF_TEACHER_OVER_TARGET,
        mode: 'REFUSE',
        params: expect.objectContaining({ minutes: 1160, target: 1000 }),
      }),
    ]);
  });

  it('charges each teacher the row’s own percentage', () => {
    const year = input({
      employments: [employment(ANNA), employment(BO)],
      requirements: [requirement({ id: 'req-0', teacherId: ANNA, coTeacherId: BO, lessonsPerWeek: 16 })],
      qualifications: [],
    });
    // 16 × 60 = 960 each; a new 3 × 60 row at 0 % for the co-teacher leaves
    // Bo at 960, and at 100 % for the lead puts Anna at 1 140.
    const findings = judge({
      input: year,
      after: requirement({ teacherId: ANNA, coTeacherId: BO, lessonsPerWeek: 3, coTeacherLoadPercent: 0 }),
    });
    expect(findings.map((f) => [f.code, f.params.role])).toEqual([[STAFF_TEACHER_OVER_TARGET, 'TEACHER']]);
  });

  it('reads a PATCH against the row as it stood, so a lighter row is never refused', () => {
    const stored = requirement({ teacherId: ANNA, lessonsPerWeek: 20 });
    expect(
      judge({
        input: input({ requirements: [stored] }),
        policy: policy({ overAllocationMode: 'REFUSE' }),
        before: stored,
        after: { ...stored, lessonsPerWeek: 19 },
      }),
    ).toEqual([]);
  });

  it('puts the lead before the co-teacher and behörighet before load, every time', () => {
    const year = input({
      employments: [employment(ANNA), employment(BO)],
      requirements: [requirement({ id: 'req-0', teacherId: ANNA, coTeacherId: BO, lessonsPerWeek: 18 })],
      qualifications: [qualification({ userId: 'someone-else' })],
    });
    const findings = judge({
      input: year,
      after: requirement({ teacherId: ANNA, coTeacherId: BO, lessonsPerWeek: 2 }),
    });
    expect(findings.map((f) => `${f.params.role}:${f.code}`)).toEqual([
      `TEACHER:${STAFF_TEACHER_NOT_QUALIFIED}`,
      `TEACHER:${STAFF_TEACHER_OVER_TARGET}`,
      `CO_TEACHER:${STAFF_TEACHER_NOT_QUALIFIED}`,
      `CO_TEACHER:${STAFF_TEACHER_OVER_TARGET}`,
    ]);
  });

  it('asks nothing when both modes are OFF', () => {
    expect(
      judge({
        policy: policy({ qualificationMode: 'OFF', overAllocationMode: 'OFF' }),
        after: requirement({ teacherId: BO, lessonsPerWeek: 40 }),
      }),
    ).toEqual([]);
  });
});

describe('settleFindings', () => {
  const finding = (mode: 'WARN' | 'REFUSE', code: StaffingFinding['code'] = STAFF_TEACHER_NOT_QUALIFIED): StaffingFinding => ({
    code,
    mode,
    userId: ANNA,
    params: code === STAFF_TEACHER_NOT_QUALIFIED
      ? { role: 'TEACHER', subject: 'Matematik', grades: '7–9' }
      : { role: 'CO_TEACHER', minutes: 1250, target: 1080, limit: 1188, tolerance: 10 },
  });

  it('hands back WARNs as code and params, without whom they are about', () => {
    expect(settleFindings([finding('WARN')])).toEqual([
      { code: STAFF_TEACHER_NOT_QUALIFIED, params: { role: 'TEACHER', subject: 'Matematik', grades: '7–9' } },
    ]);
  });

  it('throws the first REFUSE as a 409 with its code, params and Swedish', () => {
    let thrown: unknown;
    try {
      settleFindings([finding('WARN'), finding('REFUSE', STAFF_TEACHER_OVER_TARGET), finding('REFUSE')]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConflictException);
    expect((thrown as ConflictException).getResponse()).toEqual({
      code: STAFF_TEACHER_OVER_TARGET,
      params: { role: 'CO_TEACHER', minutes: 1250, target: 1080, limit: 1188, tolerance: 10 },
      message:
        'Medläraren skulle få 1250 min/v mot riktmärket 1080 min/v (gränsen är 1188 min/v med 10 % tolerans).',
    });
  });

  it('downgrades a REFUSE to a warning when asked to — the vikarie', () => {
    expect(settleFindings([finding('REFUSE')], { downgrade: true })).toHaveLength(1);
  });
});

/**
 * The Swedish a 409 carries in `detail` and the Swedish the web renders from
 * the code are ONE sentence, written twice: here in staffingSentence, there in
 * web/messages/sv.json under engineMessages. Rendered with the ICU subset the
 * catalogue is written in (select and plural, see app/messages.py), so a reword
 * of either without the other fails here — and the params a finding carries
 * are exactly the arguments the catalogue's template takes.
 */
describe('the catalogue says what staffingSentence says', () => {
  const root = join(__dirname, '..', '..');
  const sv = (JSON.parse(readFileSync(join(root, 'web/messages/sv.json'), 'utf8')) as {
    engineMessages: Record<string, string>;
  }).engineMessages;
  const fixture = JSON.parse(
    readFileSync(join(root, 'web/i18n/__fixtures__/engine-messages.json'), 'utf8'),
  ) as Record<string, string>;

  /** {name}, {name, select, …} and {name, plural, …} with #, and nothing more. */
  const render = (template: string, params: Record<string, string | number>): string => {
    let out = '';
    for (let i = 0; i < template.length; ) {
      if (template[i] !== '{') {
        out += template[i++];
        continue;
      }
      let depth = 0;
      let end = i;
      for (; end < template.length; end++) {
        if (template[end] === '{') depth++;
        if (template[end] === '}' && --depth === 0) break;
      }
      const inside = template.slice(i + 1, end);
      i = end + 1;
      const [name, kind, ...rest] = inside.split(',');
      const value = params[name!.trim()]!;
      if (kind === undefined) {
        out += String(value);
        continue;
      }
      const branches = new Map<string, string>();
      const body = rest.join(',');
      const branch = /(\w+)\s*\{/g;
      let match: RegExpExecArray | null;
      while ((match = branch.exec(body)) !== null) {
        let d = 1;
        let j = branch.lastIndex;
        for (; j < body.length && d > 0; j++) d += body[j] === '{' ? 1 : body[j] === '}' ? -1 : 0;
        branches.set(match[1]!, body.slice(branch.lastIndex, j - 1));
        branch.lastIndex = j;
      }
      const key = kind.trim() === 'plural' ? (value === 1 ? 'one' : 'other') : String(value);
      const chosen = branches.get(key) ?? branches.get('other')!;
      out += render(kind.trim() === 'plural' ? chosen.replace('#', String(value)) : chosen, params);
    }
    return out;
  };

  const argumentsOf = (template: string): string[] => {
    const names = new Set<string>();
    let depth = 0;
    for (let i = 0; i < template.length; i++) {
      if (template[i] === '}') depth--;
      if (template[i] !== '{') continue;
      depth++;
      if (depth === 1) names.add(/^\w+/.exec(template.slice(i + 1))![0]);
    }
    return [...names].sort();
  };

  const cases: StaffingWarning[] = [
    { code: STAFF_TEACHER_NOT_QUALIFIED, params: { role: 'TEACHER', subject: 'Matematik', grades: '7–9' } },
    { code: STAFF_TEACHER_NOT_QUALIFIED, params: { role: 'SUBSTITUTE', subject: 'Engelska', grades: 'any' } },
    { code: STAFF_TEACHER_NOT_QUALIFIED, params: { role: 'CO_TEACHER', subject: 'Slöjd', grades: '4' } },
    {
      code: STAFF_TEACHER_OVER_TARGET,
      params: { role: 'TEACHER', minutes: 1250, target: 1080, limit: 1188, tolerance: 10 },
    },
    {
      code: STAFF_TEACHER_OVER_TARGET,
      params: { role: 'CO_TEACHER', minutes: 700, target: 600, limit: 600, tolerance: 0 },
    },
  ];

  it.each(cases.map((warning) => [warning.code, warning.params.role, warning] as const))(
    '%s (%s)',
    (_code, _role, warning) => {
      expect(staffingSentence(warning)).toBe(render(sv[warning.code]!, warning.params));
      expect(Object.keys(warning.params).sort()).toEqual(argumentsOf(fixture[warning.code]!));
    },
  );

  it('has the generate pre-flight’s sentence in both catalogues', () => {
    expect(argumentsOf(fixture[STAFF_UNSTAFFED_REQUIREMENTS]!)).toEqual(['count']);
    expect(render(sv[STAFF_UNSTAFFED_REQUIREMENTS]!, { count: 1 })).toMatch(/^1 timplanspost saknar lärare/);
    expect(render(sv[STAFF_UNSTAFFED_REQUIREMENTS]!, { count: 3 })).toMatch(/^3 timplansposter saknar lärare/);
  });
});
