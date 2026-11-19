import type { PrismaClient } from '@prisma/client';
import {
  expandInheritedQualifications,
  readHeldQualifications,
  readQualificationLinks,
  type HeldQualification,
} from './qualification-inheritance';
import {
  DEFAULT_LOAD_POLICY,
  buildTeacherLoadReport,
  qualificationCovers,
  strongestCoveringQualification,
  type LoadInput,
  type LoadQualification,
  type LoadRequirement,
} from './teacher-load';

/*
 * BEHÖRIGHET SOM I ETT ANNAT ÄMNE, the rule and its one reader.
 *
 * "SO WS" -> "SO": a teacher who holds SO is qualified for SO WS with the SO
 * row's årskurser, kind and validity. The reader adds a copy of the source's
 * rows under the using subject's id; every consumer then compares subjectId as
 * it always did, which these specs hold to: the coverage rule, the strongest
 * kind, the report's unqualified list and its bottleneck.
 */

const ANNA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SO = 'so-subject';
const SO_WS = 'so-ws-subject';
const SO_FORD = 'so-ford-subject';
const MA = 'ma-subject';
const YEAR = { startDate: '2026-08-17', endDate: '2027-06-11' };

const held = (overrides: Partial<HeldQualification> = {}): HeldQualification => ({
  userId: ANNA,
  subjectId: SO,
  minGradeLevel: 7,
  maxGradeLevel: 9,
  kind: 'BEHORIG',
  validFrom: null,
  validTo: null,
  ...overrides,
});

const LINKS = new Map([[SO_WS, SO]]);

describe('expandInheritedQualifications', () => {
  it('returns the stored rows as they are when no subject uses another’s behörighet', () => {
    const rows = [held(), held({ userId: BO, subjectId: MA })];
    expect(expandInheritedQualifications(rows, new Map())).toEqual(rows);
  });

  it('copies each row of a source under the using subject, with the span, kind and validity of the source', () => {
    const source = held({ kind: 'LEGITIMATION', minGradeLevel: 4, maxGradeLevel: 6, validFrom: '2026-01-01' as never, validTo: '2028-06-30' as never });

    const expanded = expandInheritedQualifications([source], LINKS);

    expect(expanded).toEqual([source, { ...source, subjectId: SO_WS, viaSubjectId: SO }]);
  });

  it('marks only the derived row, which a stored row never carries', () => {
    const [stored, derived] = expandInheritedQualifications([held()], LINKS);
    expect(stored).not.toHaveProperty('viaSubjectId');
    expect(derived).toMatchObject({ subjectId: SO_WS, viaSubjectId: SO });
  });

  it('leaves another subject’s rows, and a row of the using subject itself, as they are', () => {
    const own = held({ subjectId: SO_WS, kind: 'TILLATEN' });
    const other = held({ subjectId: MA });

    const expanded = expandInheritedQualifications([own, other], LINKS);

    // Nothing holds SO here, so nothing is derived; the using subject's own row is not a source.
    expect(expanded).toEqual([own, other]);
  });

  it('adds the derived row BESIDE a stored row of the same teacher and subject: a union, never a replacement', () => {
    const own = held({ subjectId: SO_WS, kind: 'TILLATEN', minGradeLevel: 1, maxGradeLevel: 3 });
    const source = held({ kind: 'LEGITIMATION' });

    const expanded = expandInheritedQualifications([own, source], LINKS);

    expect(expanded.filter((row) => row.subjectId === SO_WS)).toEqual([
      own,
      { ...source, subjectId: SO_WS, viaSubjectId: SO },
    ]);
  });

  it('copies a row once for each subject that uses its subject, in subject id order', () => {
    const links = new Map([
      [SO_WS, SO],
      [SO_FORD, SO],
    ]);

    const expanded = expandInheritedQualifications([held()], links);

    expect(expanded.map((row) => row.subjectId)).toEqual([SO, SO_FORD, SO_WS]);
  });

  it('follows ONE step: a source that itself appears as a using subject does not pass its source’s rows on', () => {
    // The database refuses this chain; the expansion would not walk it either.
    const links = new Map([
      [SO_WS, SO],
      [SO, MA],
    ]);

    const expanded = expandInheritedQualifications([held({ subjectId: MA })], links);

    expect(expanded.map((row) => row.subjectId)).toEqual([MA, SO]);
  });
});

describe('qualificationCovers over a derived row', () => {
  const requirementOn = (subjectId: string, gradeSpan: LoadRequirement['gradeSpan']) => ({ subjectId, gradeSpan });
  const derived = (overrides: Partial<LoadQualification> = {}): LoadQualification => ({
    userId: ANNA,
    subjectId: SO_WS,
    minGradeLevel: 7,
    maxGradeLevel: 9,
    kind: 'BEHORIG',
    validFrom: null,
    validTo: null,
    ...overrides,
  });

  it('covers a requirement on the using subject, which the source row alone never did', () => {
    const source = derived({ subjectId: SO });
    expect(qualificationCovers(source, requirementOn(SO_WS, { min: 7, max: 8 }), YEAR)).toBe(false);
    expect(qualificationCovers(derived(), requirementOn(SO_WS, { min: 7, max: 8 }), YEAR)).toBe(true);
  });

  it('keeps the source’s årskurser: a 7–9 row does not reach a lower grade of the using subject', () => {
    expect(qualificationCovers(derived(), requirementOn(SO_WS, { min: 6, max: 7 }), YEAR)).toBe(false);
    expect(qualificationCovers(derived({ minGradeLevel: 1, maxGradeLevel: 9 }), requirementOn(SO_WS, { min: 6, max: 7 }), YEAR)).toBe(true);
  });

  it('keeps the source’s validity: a row that ended before the year covers nothing, one ending inside it does', () => {
    expect(qualificationCovers(derived({ validTo: '2026-06-30' }), requirementOn(SO_WS, { min: 7, max: 7 }), YEAR)).toBe(false);
    expect(qualificationCovers(derived({ validTo: '2026-12-31' }), requirementOn(SO_WS, { min: 7, max: 7 }), YEAR)).toBe(true);
    expect(qualificationCovers(derived({ validFrom: '2027-08-01' }), requirementOn(SO_WS, { min: 7, max: 7 }), YEAR)).toBe(false);
  });

  it('judges a tioårig year through the nine-year numbering, as every behörighet is', () => {
    const tioarig = { ...YEAR, gradeNumbering: 'TIOARIG' as const };
    // 10th grade of a tioårig year is the 9 a "7–9" holds.
    expect(qualificationCovers(derived(), requirementOn(SO_WS, { min: 10, max: 10 }), tioarig)).toBe(true);
    expect(qualificationCovers(derived(), requirementOn(SO_WS, { min: 11, max: 11 }), tioarig)).toBe(false);
  });

  it('takes the stronger kind between an own row on the subject and the derived one', () => {
    const rows = expandInheritedQualifications(
      [
        { ...derived({ subjectId: SO_WS, kind: 'TILLATEN' }) },
        { ...derived({ subjectId: SO, kind: 'LEGITIMATION' }) },
      ],
      LINKS,
    );

    expect(strongestCoveringQualification(rows, ANNA, requirementOn(SO_WS, { min: 7, max: 7 }), YEAR)).toBe('LEGITIMATION');
    // Without the pointer the own, weaker row is all there is.
    expect(
      strongestCoveringQualification(
        expandInheritedQualifications([derived({ subjectId: SO_WS, kind: 'TILLATEN' }), derived({ subjectId: SO, kind: 'LEGITIMATION' })], new Map()),
        ANNA,
        requirementOn(SO_WS, { min: 7, max: 7 }),
        YEAR,
      ),
    ).toBe('TILLATEN');
  });
});

describe('the load report over derived rows', () => {
  const post = (userId: string) => ({
    userId,
    employmentPercent: 100,
    reductionPercent: 0,
    contractKind: 'FERIE' as const,
    teachingTargetMinutesPerWeek: null,
    signature: userId.slice(0, 3),
  });
  const row = (teacherId: string | null): LoadRequirement => ({
    id: 'req-so-ws',
    subjectId: SO_WS,
    subjectName: 'SO WS',
    studentGroupId: 'g-8a',
    groupName: '8A',
    teacherId,
    coTeacherId: null,
    lessonsPerWeek: 2,
    minutesPerLesson: 60,
    teacherLoadPercent: 100,
    coTeacherLoadPercent: 100,
    recurrence: 'ALL_WEEKS',
    startDate: null,
    endDate: null,
    gradeSpan: { min: 8, max: 8 },
  });
  const reportOver = (qualifications: LoadQualification[], teacherId: string | null) =>
    buildTeacherLoadReport({
      year: YEAR,
      policy: { ...DEFAULT_LOAD_POLICY, fullTimeTeachingMinutesPerWeek: 1080 },
      employments: [post(ANNA), post(BO)],
      requirements: [row(teacherId)],
      qualifications,
      closures: [],
      duties: [],
    } satisfies LoadInput);

  // Anna holds SO 7–9; Bo holds MA only (so the school has behörigheter recorded).
  const stored: HeldQualification[] = [held(), held({ userId: BO, subjectId: MA })];
  const asLoad = (rows: HeldQualification[]): LoadQualification[] => rows.map(({ viaSubjectId: _via, ...rest }) => rest as LoadQualification);

  it('flags a teacher with SO on a SO WS post when nothing is derived: the problem the pointer solves', () => {
    const result = reportOver(asLoad(expandInheritedQualifications(stored, new Map())), ANNA);
    expect(result.unqualifiedAssignments).toEqual([expect.objectContaining({ userId: ANNA, subjectId: SO_WS })]);
  });

  it('does not flag her once SO WS uses SO’s behörighet, and still flags a teacher with no SO', () => {
    const expanded = asLoad(expandInheritedQualifications(stored, LINKS));

    expect(reportOver(expanded, ANNA).unqualifiedAssignments).toEqual([]);
    expect(reportOver(expanded, BO).unqualifiedAssignments).toEqual([expect.objectContaining({ userId: BO, subjectId: SO_WS })]);
  });

  it('counts the SO teacher as capacity in the bottleneck of the unstaffed SO WS post', () => {
    const without = reportOver(asLoad(expandInheritedQualifications(stored, new Map())), null);
    const via = reportOver(asLoad(expandInheritedQualifications(stored, LINKS)), null);

    expect(without.subjectBottlenecks[0]).toMatchObject({ subjectId: SO_WS, qualifiedTeacherCount: 0 });
    expect(via.subjectBottlenecks[0]).toMatchObject({ subjectId: SO_WS, qualifiedTeacherCount: 1 });
  });
});

describe('readHeldQualifications', () => {
  type Row = HeldQualification;
  /** The two tables, answering the queries the reader sends as the database does. */
  const database = (rows: Row[], pointers: Record<string, string | null>) => {
    const qualificationFindMany = jest.fn(async (query: { where?: { subjectId?: { in: string[] } } } = {}) => {
      const wanted = query.where?.subjectId?.in;
      return rows.filter((row) => !wanted || wanted.includes(row.subjectId));
    });
    const subjectFindMany = jest.fn(async (query: { where: { id?: { in: string[] } } }) =>
      Object.entries(pointers)
        .filter(([id, source]) => source !== null && (!query.where.id || query.where.id.in.includes(id)))
        .map(([id, source]) => ({ id, qualificationSubjectId: source })),
    );
    const tx = {
      teacherSubjectQualification: { findMany: qualificationFindMany },
      subject: { findMany: subjectFindMany },
    } as unknown as PrismaClient;
    return { tx, qualificationFindMany, subjectFindMany };
  };

  it('with no stored row, derives nothing and does not even read the pointers', async () => {
    const { tx, subjectFindMany } = database([], { [SO_WS]: SO });

    await expect(readHeldQualifications(tx)).resolves.toEqual([]);

    expect(subjectFindMany).not.toHaveBeenCalled();
  });

  it('returns the whole school’s rows with the derived ones in', async () => {
    const { tx } = database([held(), held({ userId: BO, subjectId: MA })], { [SO_WS]: SO });

    const rows = await readHeldQualifications(tx);

    expect(rows.map((row) => [row.userId, row.subjectId, row.viaSubjectId])).toEqual([
      [ANNA, SO, undefined],
      [BO, MA, undefined],
      [ANNA, SO_WS, SO],
    ]);
  });

  it('returns the stored rows alone for a subject whose pointer is gone, as the source subject’s deletion leaves it', async () => {
    // The key's SET NULL cleared the pointer: the row is read as it always was.
    const { tx } = database([held()], { [SO_WS]: null });

    const rows = await readHeldQualifications(tx);

    expect(rows).toEqual([held()]);
  });

  it('scoped to a subject, asks for the rows of the subject AND of its source, and returns only the subject’s', async () => {
    const { tx, qualificationFindMany } = database(
      [held(), held({ userId: BO, subjectId: MA }), held({ userId: BO, subjectId: SO_WS, kind: 'TILLATEN' })],
      { [SO_WS]: SO },
    );

    const rows = await readHeldQualifications(tx, { subjectIds: [SO_WS] });

    expect(qualificationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { subjectId: { in: [SO_WS, SO] } } }),
    );
    // Anna's derived row and Bo's own: nothing of SO itself, nothing of MA.
    expect(rows.map((row) => [row.userId, row.subjectId, row.kind, row.viaSubjectId])).toEqual([
      [BO, SO_WS, 'TILLATEN', undefined],
      [ANNA, SO_WS, 'BEHORIG', SO],
    ]);
  });

  it('scoped to a subject that uses nobody, reads that subject’s rows alone', async () => {
    const { tx, qualificationFindMany } = database([held(), held({ userId: BO, subjectId: MA })], { [SO_WS]: SO });

    const rows = await readHeldQualifications(tx, { subjectIds: [MA] });

    expect(qualificationFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { subjectId: { in: [MA] } } }));
    expect(rows.map((row) => row.subjectId)).toEqual([MA]);
  });

  it('scoped to no subject, reads nothing', async () => {
    const { tx, qualificationFindMany, subjectFindMany } = database([held()], { [SO_WS]: SO });

    await expect(readHeldQualifications(tx, { subjectIds: [] })).resolves.toEqual([]);

    expect(qualificationFindMany).not.toHaveBeenCalled();
    expect(subjectFindMany).not.toHaveBeenCalled();
  });
});

describe('readQualificationLinks', () => {
  it('lists the subjects that use another’s behörighet, by subject id', async () => {
    const tx = {
      subject: {
        findMany: jest.fn(async () => [
          { id: SO_WS, qualificationSubjectId: SO },
          { id: 'x', qualificationSubjectId: null },
        ]),
      },
    } as unknown as PrismaClient;

    await expect(readQualificationLinks(tx)).resolves.toEqual(new Map([[SO_WS, SO]]));
    expect(tx.subject.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { qualificationSubjectId: { not: null } } }),
    );
  });
});
