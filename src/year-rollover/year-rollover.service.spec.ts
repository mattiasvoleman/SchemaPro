import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../database/prisma.service';
import { testUser } from '../../test/utils/prisma-mock';
import {
  GRUNDSKOLA_2024,
  IDS,
  defaultRolloverRows,
  givenRolloverWorld,
  prismaFor,
  staffingRows,
  type RecordedCall,
  type RolloverWorld,
  type Row,
} from '../../test/utils/rollover-world';
import { rolloverRowsAtFa4a3d6 } from '../../test/utils/rollover-rows-fa4a3d6';
import { ROLLOVER_REGISTRY, carriedModels, type ColumnRule } from './rollover-registry';
import type { ExecuteRolloverDto, RolloverOptionsDto } from './dto/year-rollover.dto';
import { YearRolloverService } from './year-rollover.service';

const admin = testUser();
const OPTIONS: RolloverOptionsDto = {
  name: '2027/28',
  startDate: '2027-08-16',
  endDate: '2028-06-09',
};

function setup(rows?: Record<string, Row[]>) {
  const world = givenRolloverWorld(rows);
  const prisma = prismaFor(world);
  const service = new YearRolloverService(prisma as unknown as PrismaService);
  return { world, prisma, service };
}

async function previewAndExecute(
  world: RolloverWorld,
  service: YearRolloverService,
  options: RolloverOptionsDto = OPTIONS,
) {
  const preview = await service.previewRollover(IDS.yearA, options, admin);
  const dto: ExecuteRolloverDto = {
    ...options,
    graduatingGradeLevel: options.graduatingGradeLevel ?? (preview.graduatingGradeLevel as number),
    planHash: preview.planHash,
  };
  world.calls.length = 0;
  const result = await service.executeRollover(IDS.yearA, dto, admin);
  return { preview, result };
}

const writesOf = (calls: RecordedCall[]) =>
  calls.filter((call) => /^(create|update|delete|upsert)/.test(call.method));

describe('YearRolloverService — rollover preview', () => {
  it('plans 7A → 8A, 8A → 9A, graduates 9A, and promotes the teaching group, in one withRls call', async () => {
    const { prisma, service, world } = setup();
    const preview = await service.previewRollover(IDS.yearA, OPTIONS, admin);

    expect(prisma.withRls).toHaveBeenCalledTimes(1);
    expect(writesOf(world.calls)).toEqual([]);
    expect(preview.graduatingGradeLevel).toBe(9);
    expect(preview.graduatingGradeSource).toBe('CLASSES');
    const byName = Object.fromEntries(preview.groups.map((group) => [group.sourceName, group]));
    expect(byName['7A']).toMatchObject({ outcome: 'PROMOTE', targetName: '8A', targetGradeLevel: 8, homePupils: 2 });
    expect(byName['8A']).toMatchObject({ outcome: 'PROMOTE', targetName: '9A' });
    expect(byName['9A']).toMatchObject({ outcome: 'GRADUATE', targetName: null, homePupils: 1 });
    // The 9A pupil in Ma7 graduates and is not copied; the other two are.
    expect(byName['Ma7 grupp 1']).toMatchObject({
      outcome: 'PROMOTE',
      targetName: 'Ma8 grupp 1',
      membersCopied: 2,
      membersExcluded: { graduating: 1, noSuccessor: 0 },
    });
    expect(preview.target).toMatchObject({ dateShiftDays: 364, crossesIsoWeek53: true });
    expect(preview).not.toHaveProperty('writes');
    expect(preview.planHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('carries requirements by cohort, clearing an inactive teacher and a teacher twice, and anchoring a period at the year’s end', async () => {
    const { service } = setup();
    const preview = await service.previewRollover(IDS.yearA, OPTIONS, admin);

    // r1, r2, r6 (7A), r3 (8A), r5 (Ma7) carried; r4 (9A) not.
    expect(preview.requirements).toMatchObject({ carried: 5, notCarried: 1, periodBoundAnchored: 1, oddEvenRows: 1 });
    expect(preview.requirements.teachersCleared).toEqual([
      expect.objectContaining({ subjectName: 'Svenska', groupName: '8A', role: 'TEACHER', reason: 'INACTIVE' }),
      expect.objectContaining({ subjectName: 'Matematik', groupName: '9A', role: 'CO_TEACHER', reason: 'SAME_TEACHER_TWICE' }),
    ]);
    expect(preview.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'ISO_WEEK_53_CROSSED', blocking: false }),
        expect.objectContaining({ code: 'DUTY_SLOTS_NOT_CARRIED', params: { duties: 1, blockedSlots: 1, mentorskap: 0 } }),
      ]),
    );
    expect(preview.blocking).toBe(false);
  });

  it('proposes lov dates, none selected by default, and lists the weekly class rule against its successor', async () => {
    const { service } = setup();
    const preview = await service.previewRollover(IDS.yearA, OPTIONS, admin);

    expect(preview.breaks.map((lov) => [lov.name, lov.anchor, lov.proposedStart, lov.selected])).toEqual([
      ['Höstlov', 'ISO_WEEK', '2027-11-01', false],
      ['Jullov', 'CHRISTMAS', '2027-12-20', false],
      ['Studiedagar v53', 'NONE', null, false],
      ['Påsklov', 'EASTER', '2028-04-17', false],
    ]);
    expect(preview.classRules).toEqual([
      expect.objectContaining({ sourceGroupName: '7A', targetGroupName: '8A', dayOfWeek: 5, startTime: '13:00', stageChange: false }),
    ]);
    expect(preview.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: 'MasterLesson', count: 2 }),
        expect.objectContaining({ model: 'LunchSitting', count: 1 }),
        expect.objectContaining({ model: 'ScheduleVersion', count: null }),
      ]),
    );
  });

  it('gives the same hash twice, and another one when a row changes', async () => {
    const { service, world } = setup();
    const first = await service.previewRollover(IDS.yearA, OPTIONS, admin);
    const second = await service.previewRollover(IDS.yearA, OPTIONS, admin);
    expect(second.planHash).toBe(first.planHash);
    world.rows['teachingRequirement']![0]!['lessonsPerWeek'] = 4;
    const third = await service.previewRollover(IDS.yearA, OPTIONS, admin);
    expect(third.planHash).not.toBe(first.planHash);
  });

  /**
   * The promise a deploy keeps: a rollover planned before it executes after
   * it. The literal is this school's planHash at fa4a3d6, computed over a
   * frozen copy of its rows (rollover-rows-fa4a3d6.ts) so that a row added to
   * the live fixture for another test cannot move it. A change here is a
   * change to what a rollover writes or how its hash is serialized, and every
   * preview open in a browser at the deploy would answer 409 stale.
   */
  it('hashes a rollover exactly as fa4a3d6 did (the pin, over a frozen copy of the school)', async () => {
    const { service } = setup(rolloverRowsAtFa4a3d6());
    const preview = await service.previewRollover(IDS.yearA, OPTIONS, admin);
    expect(preview.planHash).toBe('ad548651574bc2a534bab3564dded501c71d6cb1c549fb935de895e610a0a621');
  });

  it('404s a year RLS hides', async () => {
    const { service } = setup();
    await expect(
      service.previewRollover('99999999-9999-4999-8999-999999999999', OPTIONS, admin),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('409s YEAR_HAS_SUCCESSOR naming it', async () => {
    const rows = defaultRolloverRows();
    rows['academicYear']!.push({
      id: '90000000-0000-4000-8000-0000000000b0',
      name: '2027/28',
      predecessorId: IDS.yearA,
      startDate: new Date('2027-08-16'),
      endDate: new Date('2028-06-09'),
      isActive: false,
    });
    const { service } = setup(rows);
    const refusal = await service.previewRollover(IDS.yearA, { ...OPTIONS, name: '2027/28 b' }, admin).catch((e) => e);
    expect(refusal).toBeInstanceOf(ConflictException);
    expect(refusal.getResponse()).toMatchObject({
      code: 'YEAR_HAS_SUCCESSOR',
      message: 'Läsåret 2026/27 har redan rullats vidare till 2027/28.',
    });
  });

  it('409s ROLLOVER_SOURCE_NOT_ACTIVATED while the source’s own pupils have not moved in', async () => {
    const rows = defaultRolloverRows();
    // Roll B out of A, then ask to roll B before activating it.
    const { world, service } = setup(rows);
    const { result } = await previewAndExecute(world, service);
    const refusal = await service
      .previewRollover(result.academicYear.id, { name: '2028/29', startDate: '2028-08-14', endDate: '2029-06-08' }, admin)
      .catch((e) => e);
    expect(refusal).toBeInstanceOf(ConflictException);
    expect(refusal.getResponse()).toMatchObject({ code: 'ROLLOVER_SOURCE_NOT_ACTIVATED', params: { pupils: 4 } });
  });

  it('judges a kept teacher against the projected grade under REFUSE, keeps and warns under WARN, says nothing under OFF', async () => {
    const qualified = (mode: string) => {
      const rows = defaultRolloverRows();
      rows['staffingPolicy'] = [{ qualificationMode: mode }];
      // Anna is behörig in matematik for åk 7–8 only: next year's 9A (today's
      // 8A) and Ma8 (pupils who will be in 8 and 9) fall outside it.
      rows['teacherSubjectQualification'] = [
        { userId: IDS.anna, subjectId: IDS.ma, minGradeLevel: 7, maxGradeLevel: 8, kind: 'LEGITIMATION', validFrom: null, validTo: null },
      ];
      return rows;
    };
    const refuse = await setup(qualified('REFUSE')).service.previewRollover(IDS.yearA, OPTIONS, admin);
    expect(
      refuse.requirements.teachersCleared.filter((row) => row.reason === 'NOT_QUALIFIED').map((row) => row.groupName),
    ).toEqual(['9A', 'Ma8 grupp 1']);
    expect(refuse.requirements.qualificationWarnings).toEqual([]);

    const warn = await setup(qualified('WARN')).service.previewRollover(IDS.yearA, OPTIONS, admin);
    expect(warn.requirements.teachersCleared.some((row) => row.reason === 'NOT_QUALIFIED')).toBe(false);
    expect(warn.requirements.qualificationWarnings.map((row) => [row.groupName, row.grades])).toEqual([
      ['9A', '9'],
      ['Ma8 grupp 1', '8–9'],
    ]);

    const off = await setup(qualified('OFF')).service.previewRollover(IDS.yearA, OPTIONS, admin);
    expect(off.requirements.qualificationWarnings).toEqual([]);
    expect(off.requirements.teachersCleared.every((row) => row.reason !== 'NOT_QUALIFIED')).toBe(true);
  });

  it('carries a split timplanspost with its lengths, measures its volume by them, and writes every uniform row as before', async () => {
    const rows = defaultRolloverRows();
    // 7A's Matematik as 1 × 80 + 1 × 40: 120 minutes, not 2 × 80.
    const ma7 = rows['teachingRequirement']!.find(
      (row) => row['studentGroupId'] === IDS.g7a && row['subjectId'] === IDS.ma,
    )!;
    Object.assign(ma7, { lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] });
    rows['academicYearTimplan'] = [];
    rows['localTimplan'] = [
      {
        id: 'plan',
        name: 'Lokal timplan 2026',
        schoolForm: 'GRUNDSKOLA',
        status: 'DECIDED',
        decidedAt: new Date('2026-05-01T00:00:00Z'),
        nationalVersion: GRUNDSKOLA_2024,
        entries: [{ subjectId: IDS.ma, gradeLevel: 8, minutesPerWeek: 120 }],
      },
    ];
    const { world, service } = setup(rows);

    const { preview } = await previewAndExecute(world, service, { ...OPTIONS, graduatingGradeLevel: 9 });

    // Met by its lengths: no Matematik finding for 8A (as 2 × 80 it would be 160 of 120).
    const eighth = preview.groups.find((group) => group.targetName === '8A')!;
    expect(eighth.volumeFindings.map((finding) => finding.subjectId)).not.toContain(IDS.ma);
    const written = world.calls
      .filter((call) => call.model === 'teachingRequirement' && call.method === 'createMany')
      .flatMap((call) => (call.args as { data: Row[] }).data);
    const split = written.filter((row) => 'lessonLengths' in row);
    expect(split).toEqual([
      expect.objectContaining({ subjectId: IDS.ma, lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] }),
    ]);
    expect(written.length).toBeGreaterThan(1);
  });

  it('flags a class rule across a stage change and a carried volume that differs from the decided timplan', async () => {
    const rows = defaultRolloverRows();
    rows['frameTime'] = [
      { minGradeLevel: 7, maxGradeLevel: 7, dayOfWeek: null, startTime: new Date('1970-01-01T08:00:00Z'), endTime: new Date('1970-01-01T14:00:00Z') },
      { minGradeLevel: 8, maxGradeLevel: 9, dayOfWeek: null, startTime: new Date('1970-01-01T08:00:00Z'), endTime: new Date('1970-01-01T15:30:00Z') },
    ];
    // No timplan per årskurs in the source year (a year from before P2): the
    // new year's grades take the decided plan by P2's default rule, and the
    // carried volume is measured against it.
    rows['academicYearTimplan'] = [];
    rows['localTimplan'] = [
      {
        id: 'plan',
        name: 'Lokal timplan 2026',
        schoolForm: 'GRUNDSKOLA',
        status: 'DECIDED',
        decidedAt: new Date('2026-05-01T00:00:00Z'),
        nationalVersion: GRUNDSKOLA_2024,
        entries: [
          { subjectId: IDS.ma, gradeLevel: 8, minutesPerWeek: 180 },
          { subjectId: IDS.sv, gradeLevel: 8, minutesPerWeek: 200 },
          { subjectId: IDS.ma, gradeLevel: 9, minutesPerWeek: 180 },
        ],
      },
    ];
    const { service } = setup(rows);
    const preview = await service.previewRollover(IDS.yearA, OPTIONS, admin);
    expect(preview.classRules[0]).toMatchObject({ stageChange: true });
    expect(preview.graduatingGradeLevel).toBe(9);
    expect(preview.graduatingGradeSource).toBe('TIMPLAN');
    const eighth = preview.groups.find((group) => group.targetName === '8A')!;
    expect(eighth.volumePlanName).toBe('Lokal timplan 2026');
    expect(eighth.volumeFindings).toEqual([
      { subjectId: IDS.sv, subjectName: 'Svenska', carried: 180, planned: 200 },
      expect.objectContaining({ subjectId: IDS.tk, subjectName: 'Teknik', planned: 0 }),
    ]);
    expect(preview.problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'VOLUME_DIFFERS_FROM_TIMPLAN', params: { groups: ['8A'] } })]),
    );
  });

  it('asks for G when the timplan and the classes disagree, and blocks until it is given', async () => {
    const rows = defaultRolloverRows();
    rows['localTimplan'] = [
      ...rows['localTimplan']!,
      { id: 'p', name: 'F–6', schoolForm: 'GRUNDSKOLA', status: 'DECIDED', decidedAt: new Date(), nationalVersion: GRUNDSKOLA_2024, entries: [{ subjectId: IDS.ma, gradeLevel: 6, minutesPerWeek: 60 }] },
    ];
    const { service } = setup(rows);
    const preview = await service.previewRollover(IDS.yearA, OPTIONS, admin);
    expect(preview.graduatingGradeConflict).toEqual({ timplan: [6], classes: 9 });
    expect(preview.problems).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'GRADUATING_GRADE_REQUIRED', blocking: true })]));
    const chosen = await service.previewRollover(IDS.yearA, { ...OPTIONS, graduatingGradeLevel: 9 }, admin);
    expect(chosen).toMatchObject({ graduatingGradeLevel: 9, graduatingGradeSource: 'REQUEST', blocking: false });
  });

  it('counts a member whose home class takes INTAKE in a one-grade school as graduating, as the activation will', async () => {
    const rows = defaultRolloverRows();
    // Only 9A, and an ungraded språkval group with one of its pupils.
    rows['studentGroup'] = [
      { id: IDS.g9a, academicYearId: IDS.yearA, name: '9A', kind: 'CLASS', gradeLevel: 9, predecessorId: null },
      { id: IDS.gMa7, academicYearId: IDS.yearA, name: 'Språkval', kind: 'TEACHING_GROUP', gradeLevel: null, predecessorId: null },
    ];
    rows['studentGroupMember'] = [{ studentGroupId: IDS.gMa7, studentId: IDS.p9a1, student: { studentGroupId: IDS.g9a } }];
    rows['teachingRequirement'] = [];
    rows['availabilityConstraint'] = [];
    const { service } = setup(rows);
    const preview = await service.previewRollover(
      IDS.yearA,
      { ...OPTIONS, graduatingGradeLevel: 9, groups: [{ sourceGroupId: IDS.g9a, outcome: 'INTAKE' }] },
      admin,
    );
    expect(preview.groups.find((group) => group.sourceGroupId === IDS.g9a)).toMatchObject({ outcome: 'INTAKE', targetName: null });
    expect(preview.groups.find((group) => group.sourceGroupId === IDS.gMa7)).toMatchObject({
      outcome: 'CARRY',
      membersCopied: 0,
      membersExcluded: { graduating: 1, noSuccessor: 0 },
    });
  });

  it('strands the non-graduating members of a skipped teaching group, and warns on overlapping years and case-only names', async () => {
    const rows = defaultRolloverRows();
    rows['academicYear']!.push({ id: 'other', name: 'Sommarskola 2028', startDate: new Date('2028-06-01'), endDate: new Date('2028-06-30'), isActive: false, predecessorId: null });
    rows['studentGroup']!.push({ id: 'b0000000-0000-4000-8000-00000000000c', academicYearId: IDS.yearA, name: '9a', kind: 'CLASS', gradeLevel: null, predecessorId: null });
    const { service } = setup(rows);
    const preview = await service.previewRollover(
      IDS.yearA,
      { ...OPTIONS, groups: [{ sourceGroupId: IDS.gMa7, outcome: 'SKIP' }] },
      admin,
    );
    const ma7 = preview.groups.find((group) => group.sourceGroupId === IDS.gMa7)!;
    expect(ma7).toMatchObject({ outcome: 'SKIP', membersStranded: 2, membersCopied: 0 });
    expect(preview.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'YEAR_DATES_OVERLAP', blocking: false, params: { years: ['Sommarskola 2028'] } }),
        expect.objectContaining({ code: 'ROLLOVER_NAME_CASE_COLLISION', blocking: false }),
      ]),
    );
  });
});

describe('YearRolloverService — rollover execute', () => {
  it('writes the plan into a new year, inserts only, in one withRls call', async () => {
    const { world, prisma, service } = setup();
    const before = JSON.stringify(defaultRolloverRows());
    const { result, preview } = await previewAndExecute(world, service, {
      ...OPTIONS,
      breaks: [{ sourceBreakId: IDS.hostlov }, { sourceBreakId: IDS.vecka53, startDate: '2027-12-27', endDate: '2027-12-29' }],
      groups: [{ sourceGroupId: IDS.g7a, outcome: 'INTAKE' }],
    });

    expect(prisma.withRls).toHaveBeenCalledTimes(2);
    expect(prisma.withRls.mock.calls[1]![2]).toEqual({ timeoutMs: 60_000 });
    expect(result.academicYear).toMatchObject({
      name: '2027/28',
      startDate: '2027-08-16',
      isActive: false,
      predecessorId: IDS.yearA,
      graduatingGradeLevel: 9,
    });
    // 8A, 9A, Ma8 and the intake 7A; two members; r1 r2 r3 r5 r6 plus r1 r2 r6 for the intake 7A.
    // And åk 8 and 9 on the draft their cohorts follow, åk 7 keeping its own
    // (the school has no decided plan to default to).
    expect(result.counts).toEqual({ groups: 4, members: 2, requirements: 8, breaks: 2, classRules: 1, timplans: 3 });
    expect(result.planHash).toBe(preview.planHash);

    const groups = world.rows['studentGroup']!.filter((group) => group['academicYearId'] === result.academicYear.id);
    expect(groups.map((group) => [group['name'], group['gradeLevel'], group['predecessorId']]).sort()).toEqual([
      ['7A', 7, null],
      ['8A', 8, IDS.g7a],
      ['9A', 9, IDS.g8a],
      ['Ma8 grupp 1', 8, IDS.gMa7],
    ]);
    const intake = groups.find((group) => group['name'] === '7A')!;
    const intakeRows = world.rows['teachingRequirement']!.filter((row) => row['studentGroupId'] === intake['id']);
    expect(intakeRows.every((row) => row['teacherId'] === null && row['coTeacherId'] === null)).toBe(true);
    expect(intakeRows).toHaveLength(3);
    const lov = world.rows['schoolBreak']!.filter((row) => row['academicYearId'] === result.academicYear.id);
    expect(lov.map((row) => (row['startDate'] as Date).toISOString().slice(0, 10)).sort()).toEqual(['2027-11-01', '2027-12-27']);

    // Nothing of the source year changed.
    const sourceNow = JSON.stringify(
      Object.fromEntries(
        Object.entries(world.rows).map(([model, rows]) => [
          model,
          rows.filter((row) => !String(row['id'] ?? '').startsWith('90000000')),
        ]),
      ),
    );
    expect(sourceNow).toBe(before);
  });

  /**
   * Test 3: the execute's every call against the recording transaction.
   * Allowed: reads, creates, and the two FOR SHARE reads of the source year
   * and its groups. Every create targets the new year: academicYearId is its
   * id where the table has one, studentGroupId is one of its new groups.
   */
  it('reads, locks the source FOR SHARE and creates into the new year only (write audit)', async () => {
    const { world, service } = setup();
    const { result } = await previewAndExecute(world, service, {
      ...OPTIONS,
      breaks: [{ sourceBreakId: IDS.jullov }],
    });
    const target = result.academicYear.id;
    const newGroups = new Set(
      world.rows['studentGroup']!.filter((group) => group['academicYearId'] === target).map((group) => group['id']),
    );

    for (const call of world.calls) {
      if (call.model === '$queryRaw') {
        expect(call.sql).toMatch(/^SELECT .* FROM "(AcademicYears|StudentGroups)" WHERE .* FOR SHARE$/);
        expect(call.values![0]).toBe(IDS.yearA);
        continue;
      }
      expect({ call: `${call.model}.${call.method}` }).toEqual({
        call: expect.stringMatching(/\.(findMany|findUnique|findFirst|count|create|createMany|createManyAndReturn)$/),
      });
      if (!call.method.startsWith('create')) continue;
      const data = (call.args as { data: Row | Row[] }).data;
      for (const row of Array.isArray(data) ? data : [data]) {
        if (call.model === 'academicYear') {
          expect(row).toMatchObject({ predecessorId: IDS.yearA, isActive: false });
          continue;
        }
        if ('academicYearId' in row) expect(row['academicYearId']).toBe(target);
        if (call.model !== 'studentGroup' && 'studentGroupId' in row) {
          expect(newGroups.has(row['studentGroupId'])).toBe(true);
        }
      }
    }
    const created = new Set(world.calls.filter((call) => call.method.startsWith('create')).map((call) => call.model));
    expect([...created].sort()).toEqual([
      'academicYear',
      'academicYearTimplan',
      'availabilityConstraint',
      'schoolBreak',
      'studentGroup',
      'studentGroupMember',
      'teachingRequirement',
    ]);
    // And they are exactly the tables the registry says are carried.
    const carried = carriedModels()
      .map(({ model }) => model[0]!.toLowerCase() + model.slice(1))
      .sort();
    expect([...created].sort()).toEqual(carried);
  });

  /**
   * Test 2 holds the registry's columns to the DMMF; this holds the writes to
   * the registry. Every source row carries a value no default would give, so
   * a column the planner or the apply step forgets (or fills with a constant)
   * differs from its source. COPY must equal the source row's value, NULL
   * must be null on both sides, TARGET_YEAR is the new year and MAP_GROUP a
   * new group that continues the source row's group.
   */
  it.each([
    ['without tjänster', false],
    ['with tjänster and uppdrag (carryStaffing)', true],
  ])('writes every COPY column as the source has it, and every NULL column as null (registry against the writes), %s', async (_label, carryStaffing) => {
    const rows = carryStaffing ? staffingRows() : defaultRolloverRows();
    // A decided plan, so the new year's entry grade (åk 7) is written from
    // the default rule and not only the cohorts' rows are audited.
    rows['localTimplan']!.push({
      id: 'f2000000-0000-4000-8000-0000000000d1',
      name: 'Grundskola 2024',
      schoolForm: 'GRUNDSKOLA',
      status: 'DECIDED',
      decidedAt: new Date('2024-05-01T00:00:00Z'),
      createdAt: new Date('2024-04-01T00:00:00Z'),
      nationalVersion: GRUNDSKOLA_2024,
      entries: [],
    });
    Object.assign(rows['teachingRequirement']![0]!, {
      lessonsPerWeek: 2,
      minutesPerLesson: 45,
      minutesBefore: 5,
      minutesAfter: 10,
      teacherLoadPercent: 60,
      coTeacherLoadPercent: 40,
      recurrence: 'EVEN_WEEKS',
    });
    Object.assign(rows['schoolBreak']![0]!, { kind: 'STAFF_DAY', minGradeLevel: 7, maxGradeLevel: 8 });
    Object.assign(rows['availabilityConstraint']![0]!, { type: 'PREFERRED_FREE', minGradeLevel: 7, maxGradeLevel: 9, userId: null, roomId: null });
    const { world, service } = setup(rows);
    const source = JSON.parse(JSON.stringify(rows)) as Record<string, Row[]>;
    const { result } = await previewAndExecute(world, service, {
      ...OPTIONS,
      breaks: [{ sourceBreakId: IDS.hostlov }],
      groups: [{ sourceGroupId: IDS.g7a, outcome: 'INTAKE' }],
      carryStaffing,
    });
    const target = result.academicYear.id;
    const created = (id: unknown) => world.rows['studentGroup']!.find((group) => group['id'] === id)!;
    /** The source duty a carried slot holds the time of: the teacher's, on that weekday and start. */
    const dutyOfSlot = (row: Row) =>
      source['teacherDuty']!.find((duty) => {
        const slot = source['availabilityConstraint']!.find((constraint) => constraint['id'] === duty['blockedConstraintId']);
        return (
          duty['userId'] === row['userId'] &&
          slot?.['dayOfWeek'] === row['dayOfWeek'] &&
          slot?.['startTime'] === (row['startTime'] as Date).toISOString()
        );
      });
    // The source group a new group continues: its link, or (the intake twin) its name.
    const sourceGroupOf = (id: unknown): unknown => {
      const group = created(id);
      return (
        group['predecessorId'] ??
        source['studentGroup']!.find((candidate) => candidate['name'] === group['name'])!['id']
      );
    };
    const sourceRowOf: Record<string, (row: Row) => Row | undefined> = {
      academicYear: () => source['academicYear']![0],
      studentGroup: (row) => source['studentGroup']!.find((group) => group['id'] === sourceGroupOf(row['id'] ?? findId(row))),
      studentGroupMember: (row) =>
        source['studentGroupMember']!.find(
          (member) => member['studentId'] === row['studentId'] && member['studentGroupId'] === sourceGroupOf(row['studentGroupId']),
        ),
      teachingRequirement: (row) =>
        source['teachingRequirement']!.find(
          (requirement) =>
            requirement['subjectId'] === row['subjectId'] && requirement['studentGroupId'] === sourceGroupOf(row['studentGroupId']),
        ),
      schoolBreak: (row) => source['schoolBreak']!.find((lov) => lov['name'] === row['name']),
      // A class rule continues the rule of the group it moved from; an
      // uppdrag's slot (C12) copies the slot of the duty it is carried with.
      availabilityConstraint: (row) =>
        row['resourceType'] === 'TEACHER'
          ? source['availabilityConstraint']!.find((constraint) => constraint['id'] === dutyOfSlot(row)?.['blockedConstraintId'])
          : source['availabilityConstraint']!.find(
              (rule) => rule['dayOfWeek'] === row['dayOfWeek'] && rule['studentGroupId'] === sourceGroupOf(row['studentGroupId']),
            ),
      teacherEmployment: (row) => source['teacherEmployment']!.find((post) => post['userId'] === row['userId']),
      // Every source duty carries a note naming it (staffingRows).
      teacherDuty: (row) => source['teacherDuty']!.find((duty) => duty['note'] === row['note']),
      // The source row a written grade comes from (timplanOrigin).
      academicYearTimplan: (row) => timplanOrigin(row).from,
    };
    /**
     * Where a written timplan row must come from, read off the source rows
     * and not off the planner: CARRIED from the source row below it when a
     * class of that grade moves up (none of this run's choices keeps one
     * back, and G is 9), otherwise DEFAULT to the school's newest decided
     * plan (every plan here hangs on GRUNDSKOLA_2024, so it speaks for 1–9),
     * or KEPT as the grade's own row when nothing is decided.
     */
    const timplanOrigin = (row: Row): { kind: 'CARRIED' | 'DEFAULT' | 'KEPT'; from: Row | undefined; plan: unknown } => {
      const grade = row['gradeLevel'] as number;
      const below = source['academicYearTimplan']!.find((attached) => attached['gradeLevel'] === grade - 1);
      const classMovesUp = source['studentGroup']!.some(
        (group) => group['kind'] === 'CLASS' && group['gradeLevel'] === grade - 1 && grade - 1 < 9,
      );
      if (below && classMovesUp) return { kind: 'CARRIED', from: below, plan: below['localTimplanId'] };
      const newest = source['localTimplan']!
        .filter((plan) => plan['status'] === 'DECIDED')
        .sort((a, b) => String(b['decidedAt']).localeCompare(String(a['decidedAt'])))[0];
      const own = source['academicYearTimplan']!.find((attached) => attached['gradeLevel'] === grade);
      return newest
        ? { kind: 'DEFAULT', from: own, plan: newest['id'] }
        : { kind: 'KEPT', from: own, plan: own?.['localTimplanId'] };
    };
    const timplanKinds: string[] = [];
    function findId(row: Row): unknown {
      return world.rows['studentGroup']!.find((group) => group['academicYearId'] === target && group['name'] === row['name'])!['id'];
    }
    // A Decimal(6,3) is read as a Prisma Decimal and written as its toFixed(3) string (C12).
    const comparable = (value: unknown) =>
      value instanceof Date
        ? value.toISOString()
        : value instanceof Prisma.Decimal || (typeof value === 'object' && value !== null && 'toFixed' in value)
          ? Number(value).toFixed(3)
          : (value ?? null);
    // JSON.parse turned the source's Decimals into strings; read them as numbers.
    const comparableSource = (column: string, value: unknown) =>
      /Percent$/.test(column) && typeof value === 'string' ? Number(value).toFixed(3) : comparable(value);
    const newSlots = new Set<unknown>();
    for (const call of world.calls) {
      if (call.model === 'availabilityConstraint' && call.method === 'createManyAndReturn') {
        for (const row of world.rows['availabilityConstraint']!.slice(-((call.args as { data: Row[] }).data.length))) newSlots.add(row['id']);
      }
    }
    const staffingRules: string[] = [];

    let checked = 0;
    for (const call of world.calls) {
      if (!call.method.startsWith('create')) continue;
      const modelName = call.model[0]!.toUpperCase() + call.model.slice(1);
      const disposition = ROLLOVER_REGISTRY[modelName] as {
        columns: Record<string, ColumnRule>;
        alsoWrittenBy?: { columns: Record<string, ColumnRule> }[];
      };
      const data = (call.args as { data: Row | Row[] }).data;
      for (const row of Array.isArray(data) ? data : [data]) {
        const from = sourceRowOf[call.model]!(row);
        expect({ model: call.model, found: from !== undefined }).toEqual({ model: call.model, found: true });
        // AvailabilityConstraints has two writers (C12): a TEACHER row is an
        // uppdrag's slot, held to the duties step's rules.
        const columns =
          call.model === 'availabilityConstraint' && row['resourceType'] === 'TEACHER'
            ? disposition.alsoWrittenBy![0]!.columns
            : disposition.columns;
        for (const [column, rule] of Object.entries(columns)) {
          const at = { model: call.model, column, rule };
          if (['PROMOTE_LABEL', 'FOLLOW_GROUP', 'NEW_SLOT', 'DUTY_SLOT_REASON'].includes(rule)) staffingRules.push(rule);
          if (rule === 'COPY') {
            const expected = column === 'schoolId' ? admin.schoolId : comparableSource(column, from![column]);
            expect({ ...at, written: column in row, value: comparable(row[column]) }).toEqual({ ...at, written: true, value: expected });
            checked++;
          } else if (rule === 'COPY_UNLESS_DEFAULT') {
            // Written as the source has it when the source is not the column's
            // default; left to the default (not written at all) when it is.
            const value = from![column];
            const isDefault = value === undefined || value === null || (Array.isArray(value) && value.length === 0);
            expect({ ...at, written: column in row, value: column in row ? comparable(row[column]) : null }).toEqual({
              ...at,
              written: !isDefault,
              value: isDefault ? null : comparableSource(column, value),
            });
            checked++;
          } else if (rule === 'NULL') {
            expect({ ...at, written: column in row, value: row[column], source: from![column] ?? null }).toEqual({ ...at, written: true, value: null, source: null });
            checked++;
          } else if (rule === 'TARGET_YEAR') {
            expect({ ...at, value: row[column] }).toEqual({ ...at, value: target });
          } else if (rule === 'MAP_GROUP') {
            expect({ ...at, continues: sourceGroupOf(row[column]) }).toEqual({ ...at, continues: from![column] });
          } else if (rule === 'COHORT_GRADE') {
            const origin = timplanOrigin(row);
            const grade = (from!['gradeLevel'] as number) + (origin.kind === 'CARRIED' ? 1 : 0);
            expect({ ...at, value: row[column] }).toEqual({ ...at, value: grade });
          } else if (rule === 'COHORT_PLAN') {
            const origin = timplanOrigin(row);
            expect({ ...at, kind: origin.kind, value: row[column] }).toEqual({ ...at, kind: origin.kind, value: origin.plan });
            timplanKinds.push(origin.kind);
            checked++;
          } else if (rule === 'FOLLOW_GROUP') {
            // The successor of the source duty's group, or null when it has none.
            const successor = world.rows['studentGroup']!.find(
              (group) => group['academicYearId'] === target && group['predecessorId'] === from![column],
            );
            expect({ ...at, value: row[column] }).toEqual({ ...at, value: from![column] === null ? null : (successor?.['id'] ?? null) });
            checked++;
          } else if (rule === 'PROMOTE_LABEL') {
            const fromGroup = source['studentGroup']!.find((group) => group['id'] === from!['studentGroupId']);
            const toGroup = world.rows['studentGroup']!.find((group) => group['id'] === row['studentGroupId']);
            const expected =
              fromGroup && toGroup
                ? String(from![column]).split(String(fromGroup['name'])).join(String(toGroup['name']))
                : from![column];
            expect({ ...at, value: row[column] }).toEqual({ ...at, value: expected });
            checked++;
          } else if (rule === 'NEW_SLOT') {
            // A slot made in this run for this teacher, never the source's own;
            // none where the source had none (or one off the grid: 15:02).
            const sourceSlot = source['availabilityConstraint']!.find((constraint) => constraint['id'] === from![column]);
            const onGrid = sourceSlot !== undefined && new Date(String(sourceSlot['startTime'])).getUTCMinutes() % 5 === 0;
            const slot = world.rows['availabilityConstraint']!.find((constraint) => constraint['id'] === row[column]);
            expect({ ...at, made: row[column] === null ? null : newSlots.has(row[column]), sameTeacher: slot ? slot['userId'] === row['userId'] : null }).toEqual({
              ...at,
              made: onGrid ? true : null,
              sameTeacher: onGrid ? true : null,
            });
            expect(row[column]).not.toBe(from![column] ?? 'none');
            checked++;
          } else if (rule === 'DUTY_SLOT_REASON') {
            expect({ ...at, value: row[column] }).toEqual({ ...at, value: 'Uppdrag' });
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(40);
    // Both ways a timplan row is written were audited.
    expect(timplanKinds.sort()).toEqual(['CARRIED', 'CARRIED', 'DEFAULT']);
    // And every staffing rule, when tjänster are carried; none without.
    expect([...new Set(staffingRules)].sort()).toEqual(
      carryStaffing ? ['DUTY_SLOT_REASON', 'FOLLOW_GROUP', 'NEW_SLOT', 'PROMOTE_LABEL'] : [],
    );
  });

  it('refuses a stale preview with 409 before any write', async () => {
    const { world, service } = setup();
    const preview = await service.previewRollover(IDS.yearA, OPTIONS, admin);
    world.rows['user']!.push({ id: 'c0000000-0000-4000-8000-000000000073', role: 'STUDENT', isActive: true, studentGroupId: IDS.g7a });
    world.rows['studentGroupMember']!.push({ studentGroupId: IDS.gMa7, studentId: 'c0000000-0000-4000-8000-000000000073', student: { studentGroupId: IDS.g7a } });
    world.calls.length = 0;
    const refusal = await service
      .executeRollover(IDS.yearA, { ...OPTIONS, graduatingGradeLevel: 9, planHash: preview.planHash }, admin)
      .catch((e) => e);
    expect(refusal).toBeInstanceOf(ConflictException);
    expect(refusal.getResponse()).toMatchObject({ code: 'ROLLOVER_PREVIEW_STALE' });
    expect(writesOf(world.calls)).toEqual([]);
  });

  it.each([
    ['a name collision', { groups: [{ sourceGroupId: IDS.g9a, outcome: 'CARRY' as const }] }, 'ROLLOVER_NAME_COLLISION'],
    ['PROMOTE on a graduating group', { groups: [{ sourceGroupId: IDS.g9a, outcome: 'PROMOTE' as const }] }, 'PROMOTE_GRADUATING'],
    ['INTAKE on a group that is not the lowest', { groups: [{ sourceGroupId: IDS.g8a, outcome: 'INTAKE' as const }] }, 'INTAKE_NOT_LOWEST'],
    ['a group of another year', { groups: [{ sourceGroupId: '99999999-9999-4999-8999-999999999999' }] }, 'ROLLOVER_UNKNOWN_GROUP'],
    ['a lov without dates and no proposal', { breaks: [{ sourceBreakId: IDS.vecka53 }] }, 'BREAK_NEEDS_DATES'],
    ['a lov outside the year', { breaks: [{ sourceBreakId: IDS.hostlov, startDate: '2028-07-01', endDate: '2028-07-02' }] }, 'BREAK_OUTSIDE_YEAR'],
    ['a lov of another year', { breaks: [{ sourceBreakId: '99999999-9999-4999-8999-999999999999' }] }, 'ROLLOVER_UNKNOWN_BREAK'],
    ['a start before the source ends', { startDate: '2027-06-01' }, 'ROLLOVER_TARGET_DATES'],
  ])('answers 400 for %s, naming it, before any write', async (_label, change, code) => {
    const { world, service } = setup();
    const options = { ...OPTIONS, ...change };
    const preview = await service.previewRollover(IDS.yearA, options, admin);
    expect(preview.blocking).toBe(true);
    world.calls.length = 0;
    const refusal = await service
      .executeRollover(IDS.yearA, { ...options, graduatingGradeLevel: 9, planHash: preview.planHash }, admin)
      .catch((e) => e);
    expect(refusal).toBeInstanceOf(BadRequestException);
    expect(refusal.getResponse()).toMatchObject({ code });
    expect(writesOf(world.calls)).toEqual([]);
  });

  it('answers 409 YEAR_NAME_TAKEN for a name the school already has', async () => {
    const { service } = setup();
    const preview = await service.previewRollover(IDS.yearA, { ...OPTIONS, name: '2026/27' }, admin);
    const refusal = await service
      .executeRollover(IDS.yearA, { ...OPTIONS, name: '2026/27', graduatingGradeLevel: 9, planHash: preview.planHash }, admin)
      .catch((e) => e);
    expect(refusal).toBeInstanceOf(ConflictException);
    expect(refusal.getResponse()).toMatchObject({ code: 'YEAR_NAME_TAKEN' });
  });

  it('turns a P2002 on the predecessor key into YEAR_HAS_SUCCESSOR, re-read and named', async () => {
    const { world, service } = setup();
    const preview = await service.previewRollover(IDS.yearA, OPTIONS, admin);
    // A second rollover committed between this one's check and its insert.
    const original = world.tx.academicYear.create.bind(world.tx.academicYear);
    (world.tx.academicYear as unknown as Record<string, unknown>)['create'] = async () => {
      world.rows['academicYear']!.push({ id: 'winner', name: '2027/28 (den andra)', predecessorId: IDS.yearA });
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: Prisma.prismaVersion.client,
        meta: { driverAdapterError: { cause: { constraint: { index: 'AcademicYears_predecessorId_schoolId_key' } } } },
      });
    };
    const refusal = await service
      .executeRollover(IDS.yearA, { ...OPTIONS, graduatingGradeLevel: 9, planHash: preview.planHash }, admin)
      .catch((e) => e);
    expect(original).toBeDefined();
    expect(refusal).toBeInstanceOf(ConflictException);
    expect(refusal.getResponse()).toMatchObject({
      code: 'YEAR_HAS_SUCCESSOR',
      message: 'Läsåret 2026/27 har redan rullats vidare till 2027/28 (den andra).',
    });
  });

  it('turns a P2002 on the name key into YEAR_NAME_TAKEN', async () => {
    const { world, service } = setup();
    const preview = await service.previewRollover(IDS.yearA, OPTIONS, admin);
    (world.tx.academicYear as unknown as Record<string, unknown>)['create'] = async () => {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: Prisma.prismaVersion.client,
        meta: { driverAdapterError: { cause: { constraint: { index: 'AcademicYears_schoolId_name_key' } } } },
      });
    };
    const refusal = await service
      .executeRollover(IDS.yearA, { ...OPTIONS, graduatingGradeLevel: 9, planHash: preview.planHash }, admin)
      .catch((e) => e);
    expect(refusal.getResponse()).toMatchObject({ code: 'YEAR_NAME_TAKEN' });
  });
});

describe('YearRolloverService — tjänster and uppdrag (carryStaffing)', () => {
  const PINNED = 'ad548651574bc2a534bab3564dded501c71d6cb1c549fb935de895e610a0a621';
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const callNames = (calls: RecordedCall[]) => calls.map((call) => call.sql ?? `${call.model}.${call.method}`);

  /**
   * fa4a3d6's preview and execute of the frozen school, statement by
   * statement: the preview's calls with their arguments as a digest, the
   * execute's as names (its creates carry fresh ids). Recorded against a
   * `git archive fa4a3d6` of src/ and test/ before this change, and equal to
   * what the code sends now with the option absent or false (C3).
   */
  const FA4A3D6_PREVIEW_CALLS = '4f1fba52e20373abfa1905fd30742edc9cf3d591dc62f473e77db45dccdb114e';
  const FA4A3D6_EXECUTE_CALLS = [
    'SELECT "startDate", "endDate" FROM "AcademicYears" WHERE "id" = ?::uuid FOR SHARE',
    'SELECT "id" FROM "StudentGroups" WHERE "academicYearId" = ?::uuid ORDER BY "id" FOR SHARE',
    'academicYear.findUnique', 'academicYear.findFirst', 'academicYear.findMany', 'studentGroup.findMany',
    'user.findMany', 'studentGroupMember.findMany', 'teachingRequirement.findMany', 'schoolBreak.findMany',
    'availabilityConstraint.findMany', 'frameTime.findMany', 'localTimplan.findMany', 'subject.findMany',
    'academicYearTimplan.findMany', 'localTimplan.findMany', 'user.findMany', 'staffingPolicy.findFirst',
    'teacherSubjectQualification.findMany', 'masterLesson.count', 'masterLesson.count', 'lunchSitting.count',
    'lunchSitting.count', 'teacherEmployment.count', 'teacherDuty.count', 'teacherDuty.count', 'teacherDuty.count',
    'academicYear.findMany', 'studentGroup.findMany', 'user.findMany', 'studentGroupMember.findMany',
    'academicYear.create', 'studentGroup.createManyAndReturn', 'studentGroupMember.createMany',
    'teachingRequirement.createMany', 'availabilityConstraint.createMany', 'academicYearTimplan.count',
    'academicYearTimplan.createMany',
  ];

  it.each([
    ['absent', {}],
    ['false', { carryStaffing: false }],
  ])('with the option %s, plans, hashes, reads and writes exactly as fa4a3d6 (C3, D2)', async (_label, option) => {
    const { world, service } = setup(rolloverRowsAtFa4a3d6());
    const preview = await service.previewRollover(IDS.yearA, { ...OPTIONS, ...option }, admin);
    expect(preview.planHash).toBe(PINNED);
    // The ONE difference from fa4a3d6, named rather than re-recorded: the
    // source read of the timplansposter selects lessonLengths (lektionslängder,
    // 20261008090000). Asserted on its own, then taken out of that select, and
    // every call with every argument is then fa4a3d6's, byte for byte.
    const requirementReads = world.calls.filter(
      (call) => call.model === 'teachingRequirement' && call.method === 'findMany',
    );
    expect(requirementReads.length).toBeGreaterThan(0);
    for (const call of requirementReads) {
      expect((call.args as { select: Record<string, unknown> }).select).toMatchObject({ lessonLengths: true });
    }
    const asAtFa4a3d6 = world.calls.map((call) => {
      if (call.model !== 'teachingRequirement' || call.method !== 'findMany') return call;
      const args = call.args as { select: Record<string, unknown> };
      const { lessonLengths: _added, ...select } = args.select;
      return { ...call, args: { ...args, select } };
    });
    expect(digest(asAtFa4a3d6)).toBe(FA4A3D6_PREVIEW_CALLS);
    expect(preview.staffing).toBeNull();
    expect(preview.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'DUTY_SLOTS_NOT_CARRIED', params: { duties: 1, blockedSlots: 1, mentorskap: 0 } }),
      ]),
    );
    expect(preview.problems.filter((problem) => problem.code.startsWith('STAFFING_'))).toEqual([]);
    expect(preview.skipped.filter((entry) => entry.model.startsWith('Teacher'))).toEqual([
      { model: 'TeacherEmployment', reason: 'Tjänster are rolled by staffing Fas 5, which decides what a post carries into the next year.', count: 1 },
      expect.objectContaining({ model: 'TeacherDuty', count: 1 }),
    ]);
    world.calls.length = 0;
    const result = await service.executeRollover(
      IDS.yearA,
      { ...OPTIONS, ...option, graduatingGradeLevel: 9, planHash: preview.planHash },
      admin,
    );
    expect(callNames(world.calls)).toEqual(FA4A3D6_EXECUTE_CALLS);
    expect(result.staffing).toBeNull();
    expect(result.planHash).toBe(PINNED);
  });

  it('previews who and what is carried, names every nedsättning and target override, and blocks on none of it', async () => {
    const { world, service } = setup(staffingRows());
    const preview = await service.previewRollover(IDS.yearA, { ...OPTIONS, carryStaffing: true }, admin);
    expect(writesOf(world.calls)).toEqual([]);
    expect(preview.blocking).toBe(false);
    expect(preview.staffing!.employments).toEqual({
      carried: 2,
      withReduction: [IDS.anna],
      withTargetOverride: [IDS.cecilia],
      notCarried: [{ userId: IDS.bo, reason: 'INACTIVE' }],
      signaturesDropped: [],
    });
    const duties = preview.staffing!.duties;
    expect(duties).toMatchObject({ carried: 5, slots: 2, followedGroup: 1 });
    expect(duties.relabelled).toEqual([{ sourceDutyId: IDS.dutyMentor7a, userId: IDS.anna, from: 'Mentor 7A', to: 'Mentor 8A' }]);
    expect(duties.groupDropped).toEqual([expect.objectContaining({ sourceDutyId: IDS.dutyStudie9a, groupName: '9A' })]);
    expect(duties.slotDropped).toEqual([expect.objectContaining({ sourceDutyId: IDS.dutyApt, reason: 'OFF_GRID' })]);
    expect(duties.notCarried.map((row) => [row.sourceDutyId, row.reason])).toEqual([
      [IDS.dutyMentor9a, 'GROUP_LEAVES'],
      [IDS.dutyBo, 'TEACHER_NOT_CARRIED'],
      [IDS.dutyGuardian, 'TEACHER_NOT_CARRIED'],
    ]);
    expect(preview.staffing!.teachers).toEqual([
      { userId: IDS.anna, employment: 'CARRIED', duties: 2, dutyMinutesPerWeek: 90 },
      { userId: IDS.bo, employment: 'NOT_CARRIED', duties: 0, dutyMinutesPerWeek: 0 },
      { userId: IDS.cecilia, employment: 'CARRIED', duties: 3, dutyMinutesPerWeek: 190 },
      { userId: IDS.guardian, employment: 'NONE', duties: 0, dutyMinutesPerWeek: 0 },
    ]);
    const codes = preview.problems.filter((problem) => problem.code.startsWith('STAFFING_') || problem.code === 'DUTY_SLOTS_NOT_CARRIED');
    expect(codes).toEqual([
      { code: 'STAFFING_MENTORSKAP_NOT_CARRIED', blocking: false, params: { duties: 1, groups: ['9A'] } },
      { code: 'STAFFING_DUTY_GROUP_DROPPED', blocking: false, params: { duties: 1, groups: ['9A'] } },
      { code: 'STAFFING_TEACHERS_NOT_CARRIED', blocking: false, params: { teachers: 2 } },
      { code: 'STAFFING_SLOT_OFF_GRID', blocking: false, params: { duties: 1 } },
      { code: 'STAFFING_PER_YEAR_TERMS_CARRIED', blocking: false, params: { reductions: 1, overrides: 1 } },
    ]);
    // Carried tables are not "left behind".
    expect(preview.skipped.map((entry) => entry.model)).not.toEqual(expect.arrayContaining(['TeacherEmployment']));
    expect(preview.skipped.map((entry) => entry.model)).not.toContain('TeacherDuty');
    // Params name no teacher.
    expect(JSON.stringify(preview.problems)).not.toContain(IDS.anna);
  });

  it('writes the posts, the uppdrag and NEW slots into the new year, takes the staff and their rows under lock, and changes nothing of the source', async () => {
    const rows = staffingRows();
    const { world, service } = setup(rows);
    const before = JSON.stringify(rows);
    const { result } = await previewAndExecute(world, service, {
      ...OPTIONS,
      carryStaffing: true,
      breaks: [{ sourceBreakId: IDS.jullov }],
    });
    const target = result.academicYear.id;

    expect(result.staffing).toEqual({ employments: 2, duties: 5, dutySlots: 2 });
    // `counts` keeps its shape: the adapter probe compares it whole.
    expect(Object.keys(result.counts).sort()).toEqual(['breaks', 'classRules', 'groups', 'members', 'requirements', 'timplans']);

    expect(
      world.calls.filter((call) => call.model === '$queryRaw').map((call) => call.sql!.replace(/^SELECT .*? FROM /, '')),
    ).toEqual([
      '"AcademicYears" WHERE "id" = ?::uuid FOR SHARE',
      '"StudentGroups" WHERE "academicYearId" = ?::uuid ORDER BY "id" FOR SHARE',
      '"Users" WHERE "id" = ANY(?::uuid[]) ORDER BY "id" FOR NO KEY UPDATE',
      '"TeacherEmployments" WHERE "academicYearId" = ?::uuid ORDER BY "id" FOR SHARE',
      '"TeacherDuties" WHERE "academicYearId" = ?::uuid ORDER BY "id" FOR SHARE',
    ]);
    const usersLock = world.calls.find((call) => call.sql?.includes('"Users"'))!;
    expect(usersLock.values![0]).toEqual([IDS.anna, IDS.bo, IDS.cecilia, IDS.guardian]);

    const posts = world.rows['teacherEmployment']!.filter((row) => row['academicYearId'] === target);
    expect(posts.map((row) => [row['userId'], row['employmentPercent'], row['reductionPercent'], row['signature']]).sort()).toEqual([
      [IDS.anna, '90.500', '20.000', 'AN'],
      [IDS.cecilia, '80.000', '0.000', 'CE'],
    ]);
    const carried = world.rows['teacherDuty']!.filter((row) => row['academicYearId'] === target);
    const g8a = world.rows['studentGroup']!.find((group) => group['academicYearId'] === target && group['name'] === '8A')!['id'];
    expect(carried.find((row) => row['kind'] === 'MENTORSKAP')).toMatchObject({ label: 'Mentor 8A', studentGroupId: g8a, countsAsTeaching: true });
    expect(carried.find((row) => row['note'] === 'studie')).toMatchObject({ studentGroupId: null, label: 'Studiehandledning 9A' });
    expect(carried.find((row) => row['note'] === 'apt')).toMatchObject({ blockedConstraintId: null });
    const slots = carried.filter((row) => row['blockedConstraintId'] !== null).map((row) =>
      world.rows['availabilityConstraint']!.find((constraint) => constraint['id'] === row['blockedConstraintId'])!,
    );
    expect(slots.map((slot) => [slot['userId'], slot['dayOfWeek'], slot['reason'], slot['type'], slot['resourceType']]).sort()).toEqual([
      [IDS.anna, 1, 'Uppdrag', 'UNAVAILABLE', 'TEACHER'],
      [IDS.anna, 2, 'Uppdrag', 'UNAVAILABLE', 'TEACHER'],
    ]);
    expect(slots.map((slot) => slot['id'])).not.toEqual(expect.arrayContaining([IDS.slotRast, IDS.slotMentor]));

    // Every create targets the new year, and the created tables are the
    // registry's carried ones with the option on.
    const created = new Set(world.calls.filter((call) => call.method.startsWith('create')).map((call) => call.model));
    expect([...created].sort()).toEqual(
      carriedModels({ carryStaffing: true }).map(({ model }) => model[0]!.toLowerCase() + model.slice(1)).sort(),
    );
    for (const call of world.calls.filter((entry) => entry.method.startsWith('create') && entry.model.startsWith('teacher'))) {
      for (const row of (call.args as { data: Row[] }).data) expect(row['academicYearId']).toBe(target);
    }
    expect(writesOf(world.calls).every((call) => call.method.startsWith('create'))).toBe(true);
    // The source year, its staff and their slots, untouched.
    const sourceNow = JSON.stringify(
      Object.fromEntries(
        Object.entries(world.rows).map(([model, list]) => [
          model,
          list.filter((row) => !String(row['id'] ?? '').startsWith('90000000') && row['academicYearId'] !== target),
        ]),
      ),
    );
    expect(sourceNow).toBe(before);
  });

  it('refuses a stale preview before any write when a carried row changed, and says tjänster', async () => {
    const { world, service } = setup(staffingRows());
    const preview = await service.previewRollover(IDS.yearA, { ...OPTIONS, carryStaffing: true }, admin);
    world.rows['teacherDuty']!.find((duty) => duty['id'] === IDS.dutyAmne)!['minutesPerWeek'] = 45;
    world.calls.length = 0;
    const refusal = await service
      .executeRollover(IDS.yearA, { ...OPTIONS, carryStaffing: true, graduatingGradeLevel: 9, planHash: preview.planHash }, admin)
      .catch((e) => e);
    expect(refusal).toBeInstanceOf(ConflictException);
    expect(refusal.getResponse()).toMatchObject({ code: 'ROLLOVER_PREVIEW_STALE' });
    expect(refusal.message).toContain('tjänster eller uppdrag');
    expect(writesOf(world.calls)).toEqual([]);
  });

  it('asks the option of the hash: the same school hashes differently with and without tjänster, and either way twice the same', async () => {
    const { service } = setup(staffingRows());
    const off = await service.previewRollover(IDS.yearA, OPTIONS, admin);
    const on = await service.previewRollover(IDS.yearA, { ...OPTIONS, carryStaffing: true }, admin);
    expect(on.planHash).not.toBe(off.planHash);
    expect((await service.previewRollover(IDS.yearA, { ...OPTIONS, carryStaffing: true }, admin)).planHash).toBe(on.planHash);
  });

  it('takes no Users lock when the source year has no tjänster, and writes none', async () => {
    const rows = defaultRolloverRows();
    rows['teacherEmployment'] = [];
    rows['teacherDuty'] = [];
    const { world, service } = setup(rows);
    const { result, preview } = await previewAndExecute(world, service, { ...OPTIONS, carryStaffing: true });
    expect(preview.staffing).toMatchObject({ employments: { carried: 0 }, duties: { carried: 0 }, teachers: [] });
    expect(world.calls.some((call) => call.sql?.includes('"Users"'))).toBe(false);
    expect(result.staffing).toEqual({ employments: 0, duties: 0, dutySlots: 0 });
    expect(world.calls.some((call) => call.model.startsWith('teacher') && call.method.startsWith('create'))).toBe(false);
  });

  it('carries a mentorskap to the successor of a CARRY group, never to an INTAKE twin, and not with a teaching group left behind', async () => {
    const rows = staffingRows();
    rows['teacherDuty']!.push({
      ...rows['teacherDuty']![1]!,
      id: 'f4000000-0000-4000-8000-000000000009',
      label: 'Mentor Ma7 grupp 1',
      studentGroupId: IDS.gMa7,
      blockedConstraintId: null,
      note: 'ma7',
    });
    const { service } = setup(rows);
    const intake = await service.previewRollover(
      IDS.yearA,
      { ...OPTIONS, carryStaffing: true, groups: [{ sourceGroupId: IDS.g7a, outcome: 'INTAKE' }] },
      admin,
    );
    // 7A's cohort moves to 8A (the twin 7A is new, with no predecessor).
    expect(intake.staffing!.duties.relabelled.map((row) => row.to).sort()).toEqual(['Mentor 8A', 'Mentor Ma8 grupp 1']);
    const carry = await service.previewRollover(
      IDS.yearA,
      { ...OPTIONS, carryStaffing: true, groups: [{ sourceGroupId: IDS.g7a, outcome: 'CARRY' }] },
      admin,
    );
    expect(carry.staffing!.duties.notCarried.some((row) => row.sourceDutyId === IDS.dutyMentor7a)).toBe(false);
    expect(carry.staffing!.duties.relabelled.map((row) => row.to)).toEqual(['Mentor Ma8 grupp 1']);
    const noGroups = await service.previewRollover(IDS.yearA, { ...OPTIONS, carryStaffing: true, carryTeachingGroups: false }, admin);
    expect(noGroups.staffing!.duties.notCarried).toEqual(
      expect.arrayContaining([expect.objectContaining({ sourceDutyId: 'f4000000-0000-4000-8000-000000000009', reason: 'GROUP_LEAVES', groupName: 'Ma7 grupp 1' })]),
    );
  });
});

describe('YearRolloverService — timplan per årskurs by cohort', () => {
  /** A decided plan the school adopted in 2024, P2's default for new years. */
  const decided = (): Row => ({
    id: 'f2000000-0000-4000-8000-0000000000d1',
    name: 'Grundskola 2024',
    schoolForm: 'GRUNDSKOLA',
    status: 'DECIDED',
    decidedAt: new Date('2024-05-01T00:00:00Z'),
    createdAt: new Date('2024-04-01T00:00:00Z'),
    nationalVersion: GRUNDSKOLA_2024,
    entries: [],
  });

  it('previews per grade the plan it will follow and why, says a carried draft is a draft, and keeps åk 7’s own plan when nothing is decided', async () => {
    const { service } = setup();
    const preview = await service.previewRollover(IDS.yearA, OPTIONS, admin);
    expect(preview.timplans).toEqual([
      { gradeLevel: 7, reason: 'KEPT', fromGradeLevel: null, localTimplanId: IDS.draftPlan, planName: 'Utkast 2027', planStatus: 'DRAFT', laterPlan: null },
      { gradeLevel: 8, reason: 'CARRIED', fromGradeLevel: 7, localTimplanId: IDS.draftPlan, planName: 'Utkast 2027', planStatus: 'DRAFT', laterPlan: null },
      { gradeLevel: 9, reason: 'CARRIED', fromGradeLevel: 8, localTimplanId: IDS.draftPlan, planName: 'Utkast 2027', planStatus: 'DRAFT', laterPlan: null },
    ]);
  });

  it('writes the cohort rows and the entry grade’s default, and none of the grades P2’s create would add (never a mix)', async () => {
    const rows = defaultRolloverRows();
    rows['localTimplan']!.push(decided());
    const { world, service } = setup(rows);
    const { preview, result } = await previewAndExecute(world, service);
    expect(preview.timplans.map((row) => [row.gradeLevel, row.reason, row.planName])).toEqual([
      [7, 'DEFAULT', 'Grundskola 2024'],
      [8, 'CARRIED', 'Utkast 2027'],
      [9, 'CARRIED', 'Utkast 2027'],
    ]);
    const written = world.rows['academicYearTimplan']!
      .filter((row) => row['academicYearId'] === result.academicYear.id)
      .map((row) => [row['gradeLevel'], row['localTimplanId']]);
    // A 7–9 school: åk 1–6, which the default plan speaks for, are not added.
    expect(written).toEqual([
      [7, 'f2000000-0000-4000-8000-0000000000d1'],
      [8, IDS.draftPlan],
      [9, IDS.draftPlan],
    ]);
    expect(result.counts.timplans).toBe(3);
    // The source year's own rows are untouched.
    expect(world.rows['academicYearTimplan']!.filter((row) => row['academicYearId'] === IDS.yearA)).toHaveLength(3);
  });

  it('reads the cohorts off the classes, not off the F–6 rows P2’s create gave a 7–9 school, and gives F a plan that plans F', async () => {
    const rows = defaultRolloverRows();
    // The year was created when "Grundskola 2024" (which plans förskoleklass)
    // was the newest decided plan, so P2's create attached it to F–9; the
    // school has classes in åk 7–9 only. "Grundskola 2027" has been decided
    // since and plans no F.
    rows['localTimplan']!.push(
      { ...decided(), entries: [{ subjectId: IDS.ma, gradeLevel: 0, minutesPerWeek: 60 }] },
      { ...decided(), id: 'f2000000-0000-4000-8000-0000000000d3', name: 'Grundskola 2027', decidedAt: new Date('2027-03-01T00:00:00Z') },
    );
    rows['academicYearTimplan'] = Array.from({ length: 10 }, (_, gradeLevel) => ({
      schoolId: IDS.school,
      academicYearId: IDS.yearA,
      gradeLevel,
      localTimplanId: 'f2000000-0000-4000-8000-0000000000d1',
    }));
    const { service } = setup(rows);
    const preview = await service.previewRollover(IDS.yearA, OPTIONS, admin);
    expect(preview.timplans.map((row) => [row.gradeLevel, row.reason, row.fromGradeLevel, row.planName])).toEqual([
      [0, 'DEFAULT', null, 'Grundskola 2024'],
      ...[1, 2, 3, 4, 5, 6, 7].map((grade) => [grade, 'DEFAULT', null, 'Grundskola 2027']),
      [8, 'CARRIED', 7, 'Grundskola 2024'],
      [9, 'CARRIED', 8, 'Grundskola 2024'],
    ]);
  });

  it('does not give åk 7 of 2027/28 the HT2028 plan decided last, and says which plan it skipped', async () => {
    const rows = defaultRolloverRows();
    rows['localTimplan']!.push(decided(), {
      ...decided(),
      id: 'f2000000-0000-4000-8000-0000000000d4',
      name: 'Tioårig 2028',
      decidedAt: new Date('2027-03-01T00:00:00Z'),
      nationalVersion: { schoolForm: 'GRUNDSKOLA', appliesFromCohortTerm: 'HT2028' },
    });
    const { service } = setup(rows);
    const preview = await service.previewRollover(IDS.yearA, OPTIONS, admin);
    expect(preview.timplans[0]).toMatchObject({
      gradeLevel: 7,
      reason: 'DEFAULT',
      planName: 'Grundskola 2024',
      laterPlan: { name: 'Tioårig 2028', appliesFromCohortTerm: 'HT2028' },
    });
  });

  it('makes the preview stale when the source year’s mapping changes before the execute', async () => {
    const { world, service } = setup();
    const preview = await service.previewRollover(IDS.yearA, OPTIONS, admin);
    world.rows['localTimplan']!.push(decided());
    world.rows['academicYearTimplan']!.find((row) => row['gradeLevel'] === 8)!['localTimplanId'] =
      'f2000000-0000-4000-8000-0000000000d1';
    await expect(
      service.executeRollover(IDS.yearA, { ...OPTIONS, graduatingGradeLevel: 9, planHash: preview.planHash }, admin),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'ROLLOVER_PREVIEW_STALE' }) });
  });

  it('measures a carried class against the plan its grade will follow, not the newest decided one', async () => {
    const rows = defaultRolloverRows();
    // 7A follows an older decided plan with åk 8 minutes; the newest decided
    // plan has other minutes for åk 8. The cohort keeps the older one.
    rows['localTimplan']!.push(
      { ...decided(), id: 'f2000000-0000-4000-8000-0000000000d2', name: 'Grundskola 2018', decidedAt: new Date('2018-05-01T00:00:00Z'),
        entries: [{ subjectId: IDS.ma, gradeLevel: 8, minutesPerWeek: 180 }, { subjectId: IDS.sv, gradeLevel: 8, minutesPerWeek: 180 }, { subjectId: IDS.tk, gradeLevel: 8, minutesPerWeek: 0 }] },
      { ...decided(), entries: [{ subjectId: IDS.ma, gradeLevel: 8, minutesPerWeek: 240 }] },
    );
    rows['academicYearTimplan']!.find((row) => row['gradeLevel'] === 7)!['localTimplanId'] = 'f2000000-0000-4000-8000-0000000000d2';
    const { service } = setup(rows);
    const preview = await service.previewRollover(IDS.yearA, OPTIONS, admin);
    const eighth = preview.groups.find((group) => group.targetName === '8A')!;
    expect(eighth.volumePlanName).toBe('Grundskola 2018');
    expect(eighth.volumeFindings.map((finding) => finding.subjectId)).not.toContain(IDS.ma);
  });
});

describe('YearRolloverService — activation', () => {
  const AFTER = { today: '2027-06-14' };

  async function rolled() {
    const context = setup();
    const { result } = await previewAndExecute(context.world, context.service);
    context.world.calls.length = 0;
    return { ...context, yearB: result.academicYear.id };
  }
  const homeOf = (world: RolloverWorld, id: string) =>
    world.rows['user']!.find((user) => user['id'] === id)!['studentGroupId'];
  const groupNamed = (world: RolloverWorld, yearId: string, name: string) =>
    world.rows['studentGroup']!.find((group) => group['academicYearId'] === yearId && group['name'] === name)!['id'];

  it('previews the moves with ids and no names, and writes nothing', async () => {
    const { world, service, yearB } = await rolled();
    const preview = await service.previewActivation(yearB, admin, AFTER);
    expect(preview.moves.map((move) => [move.fromGroupName, move.toGroupName, move.count])).toEqual(
      expect.arrayContaining([
        ['7A', '8A', 2],
        ['8A', '9A', 1],
      ]),
    );
    expect(preview.graduates).toEqual({ count: 1, studentIds: [IDS.p9a1] });
    expect(preview).not.toHaveProperty('writes');
    expect(writesOf(world.calls)).toEqual([]);
  });

  it('hands over the active flag and moves exactly the planned pupils by id; a second run moves nobody', async () => {
    const { world, service, yearB } = await rolled();
    const preview = await service.previewActivation(yearB, admin, AFTER);
    world.calls.length = 0;
    const result = await service.executeActivation(yearB, { planHash: preview.planHash }, admin, AFTER);

    expect(result).toEqual({ year: { id: yearB, name: '2027/28', isActive: true }, moved: 3, graduated: 1, unplaced: 0 });
    expect(homeOf(world, IDS.p7a1)).toBe(groupNamed(world, yearB, '8A'));
    expect(homeOf(world, IDS.p8a1)).toBe(groupNamed(world, yearB, '9A'));
    expect(homeOf(world, IDS.p9a1)).toBeNull();
    expect(homeOf(world, IDS.pGone)).toBe(IDS.g7a);
    const years = Object.fromEntries(world.rows['academicYear']!.map((year) => [year['id'], year['isActive']]));
    expect(years).toEqual({ [IDS.yearA]: false, [yearB]: true });
    // Locks: the year FOR NO KEY UPDATE, the chain's groups FOR SHARE, the pupils FOR NO KEY UPDATE.
    expect(world.calls.filter((call) => call.model === '$queryRaw').map((call) => call.sql!.replace(/^SELECT "id" FROM /, ''))).toEqual([
      '"AcademicYears" WHERE "id" = ?::uuid FOR NO KEY UPDATE',
      '"StudentGroups" WHERE "academicYearId" = ANY(?::uuid[]) ORDER BY "id" FOR SHARE',
      '"Users" WHERE "id" = ANY(?::uuid[]) ORDER BY "id" FOR NO KEY UPDATE',
    ]);
    const moves = world.calls.filter((call) => call.model === 'user' && call.method === 'updateMany');
    for (const move of moves) {
      expect((move.args as { where: Row }).where).toMatchObject({
        id: { in: expect.any(Array) },
        role: 'STUDENT',
        isActive: true,
      });
    }

    const again = await service.previewActivation(yearB, admin, AFTER);
    expect(again).toMatchObject({ moves: [], alreadyInYear: 3, blocking: false });
    world.calls.length = 0;
    const second = await service.executeActivation(yearB, { planHash: again.planHash }, admin, AFTER);
    expect(second).toMatchObject({ moved: 0, graduated: 0, unplaced: 0 });
    expect(writesOf(world.calls)).toEqual([]);
  });

  it('names the stragglers of an ACTIVE year instead of calling it not activated, and its own activation moves them', async () => {
    const { world, service, yearB } = await rolled();
    const preview = await service.previewActivation(yearB, admin, AFTER);
    await service.executeActivation(yearB, { planHash: preview.planHash }, admin, AFTER);
    // The pupil on leave at the activation comes back in the autumn, still in last year's 7A.
    world.rows['user']!.find((user) => user['id'] === IDS.pGone)!['isActive'] = true;

    const next = { name: '2028/29', startDate: '2028-08-14', endDate: '2029-06-08', graduatingGradeLevel: 9 };
    const refusal = await service.previewRollover(yearB, next, admin).catch((e) => e);
    expect(refusal).toBeInstanceOf(ConflictException);
    expect(refusal.getResponse()).toMatchObject({
      code: 'ROLLOVER_SOURCE_HAS_STRAGGLERS',
      params: { year: '2027/28', pupils: 1 },
    });
    expect(refusal.message).not.toMatch(/inte aktiverat/);

    // The remedy the refusal names: the active year's activation, which hands no flag over.
    const again = await service.previewActivation(yearB, admin, AFTER);
    expect(again).toMatchObject({ year: { isActive: true }, blocking: false });
    expect(again.moves).toEqual([expect.objectContaining({ fromGroupId: IDS.g7a, toGroupName: '8A', count: 1, studentIds: [IDS.pGone] })]);
    await service.executeActivation(yearB, { planHash: again.planHash }, admin, AFTER);
    expect(homeOf(world, IDS.pGone)).toBe(groupNamed(world, yearB, '8A'));
    await expect(service.previewRollover(yearB, next, admin)).resolves.toMatchObject({ planHash: expect.any(String) });
  });

  it('refuses while the old year runs, a superseded year, a stale preview and a hidden year', async () => {
    const { world, service, yearB } = await rolled();
    const early = await service.previewActivation(yearB, admin, { today: '2027-06-11' });
    const tooEarly = await service
      .executeActivation(yearB, { planHash: early.planHash }, admin, { today: '2027-06-11' })
      .catch((e) => e);
    expect(tooEarly.getResponse()).toMatchObject({ code: 'YEAR_ACTIVATION_TOO_EARLY', params: { endDate: '2027-06-11' } });

    const preview = await service.previewActivation(yearB, admin, AFTER);
    world.rows['user']!.find((user) => user['id'] === IDS.p7a2)!['studentGroupId'] = IDS.g8a;
    const stale = await service.executeActivation(yearB, { planHash: preview.planHash }, admin, AFTER).catch((e) => e);
    expect(stale.getResponse()).toMatchObject({ code: 'ACTIVATION_PREVIEW_STALE' });
    expect(homeOf(world, IDS.p7a1)).toBe(IDS.g7a);

    const fresh = await service.previewActivation(yearB, admin, AFTER);
    await service.executeActivation(yearB, { planHash: fresh.planHash }, admin, AFTER);
    const back = await service.previewActivation(IDS.yearA, admin, AFTER);
    const superseded = await service
      .executeActivation(IDS.yearA, { planHash: back.planHash }, admin, AFTER)
      .catch((e) => e);
    expect(superseded).toBeInstanceOf(ConflictException);
    expect(superseded.getResponse()).toMatchObject({ code: 'YEAR_IS_SUPERSEDED' });

    world.queryRaw = () => [];
    await expect(
      service.executeActivation(yearB, { planHash: fresh.planHash }, admin, AFTER),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.previewActivation('99999999-9999-4999-8999-999999999999', admin, AFTER),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
