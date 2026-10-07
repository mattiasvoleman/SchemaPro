import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../database/prisma.service';
import { testUser } from '../../test/utils/prisma-mock';
import { IDS, givenRolloverWorld, prismaFor, staffingRows, type RecordedCall, type Row } from '../../test/utils/rollover-world';
import { StaffingRolloverService } from './staffing-rollover.service';
import { YearRolloverService } from './year-rollover.service';

const admin = testUser();
const OPTIONS = { name: '2027/28', startDate: '2027-08-16', endDate: '2028-06-09' };

/** 2026/27 with a full staff, rolled to 2027/28 WITHOUT tjänster — as a year rolled before Fas 5. */
async function rolledWithoutStaffing(rows = staffingRows()) {
  const world = givenRolloverWorld(rows);
  const prisma = prismaFor(world);
  const rollover = new YearRolloverService(prisma as unknown as PrismaService);
  const preview = await rollover.previewRollover(IDS.yearA, OPTIONS, admin);
  const result = await rollover.executeRollover(IDS.yearA, { ...OPTIONS, graduatingGradeLevel: 9, planHash: preview.planHash }, admin);
  world.calls.length = 0;
  return { world, prisma, service: new StaffingRolloverService(prisma as unknown as PrismaService), yearB: result.academicYear.id };
}

const writesOf = (calls: RecordedCall[]) => calls.filter((call) => /^(create|update|delete|upsert)/.test(call.method));

describe('StaffingRolloverService — preview', () => {
  it('previews the carry from the predecessor, writing nothing, with the target’s groups as successors', async () => {
    const { world, service, yearB } = await rolledWithoutStaffing();
    const preview = await service.preview(yearB, admin);
    expect(writesOf(world.calls)).toEqual([]);
    expect(preview).toMatchObject({
      source: { id: IDS.yearA, name: '2026/27' },
      target: { id: yearB, name: '2027/28' },
      blocking: false,
      planHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      employments: { carried: 2, withReduction: [IDS.anna], withTargetOverride: [IDS.cecilia] },
      duties: { carried: 5, slots: 2, followedGroup: 1 },
    });
    expect(preview.duties.relabelled).toEqual([expect.objectContaining({ from: 'Mentor 7A', to: 'Mentor 8A' })]);
    expect(preview.problems.map((problem) => problem.code)).toEqual(
      expect.arrayContaining(['STAFFING_MENTORSKAP_NOT_CARRIED', 'STAFFING_PER_YEAR_TERMS_CARRIED']),
    );
    expect(preview).not.toHaveProperty('writes');
    // Not a roster reader: no requirement, no pupil, no load input (C13).
    expect(world.calls.some((call) => call.model === 'teachingRequirement' || call.model === 'studentGroupMember')).toBe(false);
    expect(world.calls.some((call) => call.model === 'staffingPolicy')).toBe(false);
  });

  it('404s a year RLS hides, and 409s a year nobody rolled into (the never-rolls case)', async () => {
    const { service } = await rolledWithoutStaffing();
    await expect(service.preview('99999999-9999-4999-8999-999999999999', admin)).rejects.toBeInstanceOf(NotFoundException);
    const refusal = await service.preview(IDS.yearA, admin).catch((e) => e);
    expect(refusal).toBeInstanceOf(ConflictException);
    expect(refusal.getResponse()).toMatchObject({
      code: 'STAFFING_ROLLOVER_NO_PREDECESSOR',
      message: 'Läsåret 2026/27 rullades inte vidare från något läsår, så det finns inga tjänster att ta med.',
    });
  });

  it('warns when a carried slot lands on a lesson the teacher already has in the target', async () => {
    const { world, service, yearB } = await rolledWithoutStaffing();
    world.rows['masterLesson']!.push(
      { academicYearId: yearB, teacherId: IDS.anna, coTeacherId: null, dayOfWeek: 2, startTime: new Date('1970-01-01T10:00:00Z'), endTime: new Date('1970-01-01T11:00:00Z'), isParked: false },
      { academicYearId: yearB, teacherId: IDS.anna, coTeacherId: null, dayOfWeek: 2, startTime: new Date('1970-01-01T10:00:00Z'), endTime: new Date('1970-01-01T11:00:00Z'), isParked: true },
    );
    const preview = await service.preview(yearB, admin);
    expect(preview.problems).toEqual(
      expect.arrayContaining([{ code: 'STAFFING_SLOTS_OVER_LESSONS', blocking: false, params: { duties: 1, lessons: 1 } }]),
    );
    const lessons = world.calls.find((call) => call.model === 'masterLesson')!;
    expect((lessons.args as { where: Row }).where).toMatchObject({ academicYearId: yearB, isParked: false });
  });
});

describe('StaffingRolloverService — execute', () => {
  it('locks the target year FOR KEY SHARE and never the source year, then its groups, the staff and the source rows (C1)', async () => {
    const { world, service, yearB } = await rolledWithoutStaffing();
    const preview = await service.preview(yearB, admin);
    world.calls.length = 0;
    await service.execute(yearB, preview.planHash, admin);
    const raw = world.calls.filter((call) => call.model === '$queryRaw');
    expect(raw.map((call) => call.sql!.replace(/^SELECT .*? FROM /, ''))).toEqual([
      '"AcademicYears" WHERE "id" = ?::uuid FOR KEY SHARE',
      '"StudentGroups" WHERE "academicYearId" = ?::uuid ORDER BY "id" FOR SHARE',
      '"Users" WHERE "id" = ANY(?::uuid[]) ORDER BY "id" FOR NO KEY UPDATE',
      '"TeacherEmployments" WHERE "academicYearId" = ?::uuid ORDER BY "id" FOR SHARE',
      '"TeacherDuties" WHERE "academicYearId" = ?::uuid ORDER BY "id" FOR SHARE',
    ]);
    expect(raw.map((call) => call.values![0])).toEqual([yearB, yearB, expect.any(Array), IDS.yearA, IDS.yearA]);
  });

  it('writes into the target only, inserts only, with the groups found through predecessorId, and a second run writes nothing', async () => {
    const { world, service, yearB } = await rolledWithoutStaffing();
    const sourceBefore = JSON.stringify(world.rows['teacherDuty']!.concat(world.rows['teacherEmployment']!));
    const preview = await service.preview(yearB, admin);
    world.calls.length = 0;
    const result = await service.execute(yearB, preview.planHash, admin);
    expect(result).toEqual({ targetYearId: yearB, counts: { employments: 2, duties: 5, dutySlots: 2 }, planHash: preview.planHash });
    const writes = writesOf(world.calls);
    expect(writes.map((call) => `${call.model}.${call.method}`)).toEqual([
      'teacherEmployment.createMany',
      'availabilityConstraint.createManyAndReturn',
      'teacherDuty.createMany',
    ]);
    for (const call of writes.filter((entry) => entry.model.startsWith('teacher'))) {
      for (const row of (call.args as { data: Row[] }).data) expect(row['academicYearId']).toBe(yearB);
    }
    const b8a = world.rows['studentGroup']!.find((group) => group['academicYearId'] === yearB && group['name'] === '8A')!['id'];
    expect(world.rows['teacherDuty']!.find((row) => row['academicYearId'] === yearB && row['kind'] === 'MENTORSKAP')).toMatchObject({
      label: 'Mentor 8A',
      studentGroupId: b8a,
    });
    // Nothing of the source year changed.
    expect(JSON.stringify(world.rows['teacherDuty']!.filter((row) => row['academicYearId'] === IDS.yearA).concat(
      world.rows['teacherEmployment']!.filter((row) => row['academicYearId'] === IDS.yearA),
    ))).toBe(sourceBefore);

    // Both teachers now have a post in 2027/28, so every uppdrag of theirs is
    // theirs already (C2) — except Mentor 9A, which never followed and is
    // still named as left behind, not counted among the five present.
    const again = await service.preview(yearB, admin);
    expect(again.employments).toMatchObject({ carried: 0, notCarried: expect.arrayContaining([{ userId: IDS.anna, reason: 'ALREADY_PRESENT' }]) });
    expect(again.duties.carried).toBe(0);
    expect(again.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'STAFFING_MENTORSKAP_NOT_CARRIED', params: { duties: 1, groups: ['9A'] } }),
      expect.objectContaining({ code: 'STAFFING_ALREADY_PRESENT', params: { teachers: 2, duties: 5 } }),
    ]));
    world.calls.length = 0;
    expect((await service.execute(yearB, again.planHash, admin)).counts).toEqual({ employments: 0, duties: 0, dutySlots: 0 });
    expect(writesOf(world.calls)).toEqual([]);
  });

  it('does not bring back an uppdrag the admin deleted after a carry (the teacher is the unit, C2)', async () => {
    const { world, service, yearB } = await rolledWithoutStaffing();
    await service.execute(yearB, (await service.preview(yearB, admin)).planHash, admin);
    world.rows['teacherDuty'] = world.rows['teacherDuty']!.filter(
      (row) => !(row['academicYearId'] === yearB && row['kind'] === 'RASTVAKT'),
    );
    const again = await service.preview(yearB, admin);
    expect(again.duties.carried).toBe(0);
    expect(again.duties.notCarried).toEqual(
      expect.arrayContaining([expect.objectContaining({ sourceDutyId: IDS.dutyRast, reason: 'TEACHER_ALREADY_SET_UP' })]),
    );
  });

  it('carries a teacher with no post in the target, matching their hand-made uppdrag one to one', async () => {
    const { world, service, yearB } = await rolledWithoutStaffing();
    // Anna was given a rastvakt by hand in the new year, and no post.
    world.rows['teacherDuty']!.push({ id: 'hand', schoolId: IDS.school, userId: IDS.anna, academicYearId: yearB, kind: 'RASTVAKT', label: 'rastvakt ', minutesPerWeek: 20, studentGroupId: null, blockedConstraintId: null });
    const preview = await service.preview(yearB, admin);
    expect(preview.duties.notCarried).toEqual(expect.arrayContaining([expect.objectContaining({ sourceDutyId: IDS.dutyRast, reason: 'ALREADY_PRESENT' })]));
    expect(preview.employments.carried).toBe(2);
    expect(preview.duties.carried).toBe(4);
  });

  it('409s a stale preview before any write, and a P2002 (a post or signature written meanwhile) as the same stale', async () => {
    const { world, service, yearB } = await rolledWithoutStaffing();
    const preview = await service.preview(yearB, admin);
    world.rows['teacherEmployment']!.find((row) => row['userId'] === IDS.anna && row['academicYearId'] === IDS.yearA)!['note'] = 'ändrad';
    world.calls.length = 0;
    const stale = await service.execute(yearB, preview.planHash, admin).catch((e) => e);
    expect(stale).toBeInstanceOf(ConflictException);
    expect(stale.getResponse()).toMatchObject({
      code: 'STAFFING_ROLLOVER_PREVIEW_STALE',
      message: 'Tjänster eller uppdrag har ändrats sedan förhandsvisningen. Inget skapades. Förhandsvisa igen.',
    });
    expect(writesOf(world.calls)).toEqual([]);

    const fresh = await service.preview(yearB, admin);
    (world.tx.teacherEmployment as unknown as Record<string, unknown>)['createMany'] = async () => {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: Prisma.prismaVersion.client });
    };
    await expect(service.execute(yearB, fresh.planHash, admin)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'STAFFING_ROLLOVER_PREVIEW_STALE' }),
    });
  });

  it('404s and 409s before it locks anything else', async () => {
    const { world, service } = await rolledWithoutStaffing();
    await expect(service.execute('99999999-9999-4999-8999-999999999999', 'a'.repeat(64), admin)).rejects.toBeInstanceOf(NotFoundException);
    world.calls.length = 0;
    await expect(service.execute(IDS.yearA, 'a'.repeat(64), admin)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'STAFFING_ROLLOVER_NO_PREDECESSOR' }),
    });
    expect(world.calls.filter((call) => call.model === '$queryRaw')).toHaveLength(1);
  });
});
