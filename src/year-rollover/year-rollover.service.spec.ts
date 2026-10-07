import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../database/prisma.service';
import { testUser } from '../../test/utils/prisma-mock';
import {
  IDS,
  defaultRolloverRows,
  givenRolloverWorld,
  prismaFor,
  type RecordedCall,
  type RolloverWorld,
  type Row,
} from '../../test/utils/rollover-world';
import { carriedModels } from './rollover-registry';
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

  it('flags a class rule across a stage change and a carried volume that differs from the decided timplan', async () => {
    const rows = defaultRolloverRows();
    rows['frameTime'] = [
      { minGradeLevel: 7, maxGradeLevel: 7, dayOfWeek: null, startTime: new Date('1970-01-01T08:00:00Z'), endTime: new Date('1970-01-01T14:00:00Z') },
      { minGradeLevel: 8, maxGradeLevel: 9, dayOfWeek: null, startTime: new Date('1970-01-01T08:00:00Z'), endTime: new Date('1970-01-01T15:30:00Z') },
    ];
    rows['localTimplan'] = [
      {
        id: 'plan',
        name: 'Lokal timplan 2026',
        schoolForm: 'GRUNDSKOLA',
        status: 'DECIDED',
        decidedAt: new Date('2026-05-01T00:00:00Z'),
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
      { id: 'p', name: 'F–6', schoolForm: 'GRUNDSKOLA', status: 'DECIDED', decidedAt: new Date(), entries: [{ subjectId: IDS.ma, gradeLevel: 6, minutesPerWeek: 60 }] },
    ];
    const { service } = setup(rows);
    const preview = await service.previewRollover(IDS.yearA, OPTIONS, admin);
    expect(preview.graduatingGradeConflict).toEqual({ timplan: [6], classes: 9 });
    expect(preview.problems).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'GRADUATING_GRADE_REQUIRED', blocking: true })]));
    const chosen = await service.previewRollover(IDS.yearA, { ...OPTIONS, graduatingGradeLevel: 9 }, admin);
    expect(chosen).toMatchObject({ graduatingGradeLevel: 9, graduatingGradeSource: 'REQUEST', blocking: false });
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
    expect(result.counts).toEqual({ groups: 4, members: 2, requirements: 8, breaks: 2, classRules: 1 });
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
