import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { LocalTimplansService } from './local-timplans.service';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const PLAN_ID = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const NEW_ID = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2';
const VERSION_ID = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3';
const MA = 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4';
const PROG = 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5';

const prismaError = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError(`Simulated ${code}`, {
    code,
    clientVersion: Prisma.prismaVersion.client,
    ...(meta ? { meta } : {}),
  });

/** The decided-plan trigger's refusal, in the shape the pg adapter delivers it. */
const triggerRefusal = (planName: string) => {
  const message = `TIMPLAN_IS_DECIDED: lokal timplan "${planName}" är beslutad och dess poster kan inte ändras`;
  return prismaError('P2039', {
    driverAdapterError: {
      cause: { originalCode: 'TP409', originalMessage: message, detail: `localTimplanId=${PLAN_ID}` },
    },
  });
};

const storedPlan = (overrides: Record<string, unknown> = {}) => ({
  id: PLAN_ID,
  schoolId: SCHOOL_ID,
  name: 'Grundskolan 2024',
  schoolForm: 'GRUNDSKOLA',
  nationalTimplanVersionId: VERSION_ID,
  planningWeeks: new Prisma.Decimal('35.6'),
  status: 'DRAFT',
  decidedAt: null,
  decidedByUserId: null,
  decisionNote: null,
  copiedFromId: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  ...overrides,
});

const decided = (overrides: Record<string, unknown> = {}) =>
  storedPlan({
    status: 'DECIDED',
    decidedAt: new Date('2026-05-12T10:00:00.000Z'),
    decidedByUserId: USER_ID,
    decisionNote: 'Beslutat av huvudman 2026-05-12, dnr 2026/17',
    ...overrides,
  });

const entry = (subjectId: string, gradeLevel: number, minutesPerWeek: number, note: string | null = null) => ({
  id: `entry-${subjectId.slice(0, 4)}-${gradeLevel}`,
  subjectId,
  gradeLevel,
  minutesPerWeek,
  note,
});

/** A slice of bilaga 1 big enough to say something: matematik and the total. */
const VERSION = {
  code: 'SFS2023:945/B1',
  schoolForm: 'GRUNDSKOLA',
  totalHours: 6890,
  skolansValHours: 600,
  reductionCapPercent: 20,
  appliesFromCohortTerm: 'HT2024',
  entries: [
    { subjectCode: 'MA', stage: 'LAG', hours: 420, minimumHoursPerChild: null, protectedFromReduction: true },
  ],
};

describe('LocalTimplansService', () => {
  let service: LocalTimplansService;
  let tx: TxMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new LocalTimplansService(prisma as unknown as PrismaService);
  });

  const givenTheStatute = () => {
    tx.nationalTimplanVersion.findUnique.mockImplementation((args: { select?: { entries?: unknown } }) =>
      Promise.resolve(args.select?.entries ? VERSION : { code: VERSION.code, schoolForm: 'GRUNDSKOLA' }),
    );
    tx.nationalSubject.findMany.mockResolvedValue([{ code: 'MA', name: 'Matematik', parentCode: null }]);
    tx.subject.findMany.mockResolvedValue([
      { id: MA, name: 'Matematik', nationalCode: 'MA', countsTowardTimplan: true },
      { id: PROG, name: 'Programmering', nationalCode: null, countsTowardTimplan: true },
    ]);
  };

  describe('reads', () => {
    it('lists the school’s plans with planningWeeks as a number and the entry count', async () => {
      tx.localTimplan.findMany.mockResolvedValue([{ ...storedPlan(), _count: { entries: 27 } }]);

      const rows = await service.list(testUser());

      expect(rows).toEqual([
        expect.objectContaining({ id: PLAN_ID, planningWeeks: 35.6, entryCount: 27 }),
      ]);
      expect(rows[0]).not.toHaveProperty('_count');
      expect(typeof rows[0]!.planningWeeks).toBe('number');
      expect(tx.localTimplan.findMany).toHaveBeenCalledWith({
        orderBy: { name: 'asc' },
        include: { _count: { select: { entries: true } } },
      });
    });

    it('reads one plan with its entries, ordered by årskurs then subject, and 404s one RLS hides', async () => {
      tx.localTimplan.findUnique.mockResolvedValueOnce({ ...storedPlan(), entries: [entry(MA, 4, 180)] });
      await expect(service.get(PLAN_ID, testUser())).resolves.toMatchObject({
        planningWeeks: 35.6,
        entries: [{ subjectId: MA, gradeLevel: 4, minutesPerWeek: 180 }],
      });
      expect(tx.localTimplan.findUnique).toHaveBeenCalledWith({
        where: { id: PLAN_ID },
        include: {
          entries: {
            select: { id: true, subjectId: true, gradeLevel: true, minutesPerWeek: true, note: true },
            orderBy: [{ gradeLevel: 'asc' }, { subjectId: 'asc' }],
          },
        },
      });

      tx.localTimplan.findUnique.mockResolvedValueOnce(null);
      await expect(service.get(PLAN_ID, testUser())).rejects.toThrow(NotFoundException);
    });

    it('checks a stored plan with the Decimal weeks it holds, each verdict with a Swedish sentence', async () => {
      givenTheStatute();
      tx.localTimplan.findUnique.mockResolvedValue({
        ...storedPlan(),
        entries: [entry(MA, 1, 236), entry(MA, 2, 236), entry(MA, 3, 235), entry(PROG, 8, 60)],
      });

      const result = await service.check(PLAN_ID, testUser());

      expect(result.localTimplanId).toBe(PLAN_ID);
      expect(result.planningWeeks).toBe(35.6);
      expect(result.verdicts.map((v) => v.code)).toEqual([
        'TIMPLAN_SUBJECT_UNMAPPED',
        'TIMPLAN_PROTECTED_SUBJECT_REDUCED',
        'TIMPLAN_TOTAL_BELOW_GUARANTEE',
      ]);
      expect(result.verdicts[1]!.message).toBe(
        'Matematik i lågstadiet: 419,4 h planerat, 0,6 h under målet 420 h. Ämnet får inte minskas för skolans val.',
      );
      expect(result.verdicts[0]!.message).toContain('Programmering har ingen nationell ämneskod');
      expect(tx.subject.findMany).toHaveBeenCalledWith({
        where: { id: { in: [MA, PROG] } },
        select: { id: true, name: true, nationalCode: true, countsTowardTimplan: true },
      });
    });
  });

  describe('create', () => {
    it('writes a trimmed DRAFT with the weeks as exact decimal text, after checking the version’s form', async () => {
      givenTheStatute();
      tx.localTimplan.create.mockResolvedValue(storedPlan({ planningWeeks: new Prisma.Decimal('36.5') }));

      const result = await service.create(
        { name: '  Grundskolan 2024  ', schoolForm: 'GRUNDSKOLA', nationalTimplanVersionId: VERSION_ID, planningWeeks: 36.5 },
        testUser(),
      );

      expect(result).toMatchObject({ planningWeeks: 36.5, entries: [] });
      expect(tx.localTimplan.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          name: 'Grundskolan 2024',
          schoolForm: 'GRUNDSKOLA',
          nationalTimplanVersionId: VERSION_ID,
          planningWeeks: '36.5',
        },
      });
    });

    it('defaults the weeks to 35.6, stated rather than left to the column', async () => {
      givenTheStatute();
      tx.localTimplan.create.mockResolvedValue(storedPlan());

      await service.create(
        { name: 'G', schoolForm: 'GRUNDSKOLA', nationalTimplanVersionId: VERSION_ID },
        testUser(),
      );

      expect(tx.localTimplan.create.mock.calls[0]![0].data.planningWeeks).toBe('35.6');
    });

    it('400s a version of another school form, naming both, and an unknown version', async () => {
      tx.nationalTimplanVersion.findUnique.mockResolvedValueOnce({
        code: 'SFS2023:945/B4',
        schoolForm: 'SAMESKOLA',
      });
      await expect(
        service.create(
          { name: 'G', schoolForm: 'GRUNDSKOLA', nationalTimplanVersionId: VERSION_ID },
          testUser(),
        ),
      ).rejects.toThrow(
        'nationalTimplanVersionId: SFS2023:945/B4 är timplanen för sameskolan, och planen gäller grundskolan.',
      );

      tx.nationalTimplanVersion.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.create(
          { name: 'G', schoolForm: 'GRUNDSKOLA', nationalTimplanVersionId: VERSION_ID },
          testUser(),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(tx.localTimplan.create).not.toHaveBeenCalled();
    });

    it('409s a name the school already uses, naming it', async () => {
      givenTheStatute();
      tx.localTimplan.create.mockRejectedValue(prismaError('P2002'));

      await expect(
        service.create(
          { name: 'Grundskolan 2024', schoolForm: 'GRUNDSKOLA', nationalTimplanVersionId: VERSION_ID },
          testUser(),
        ),
      ).rejects.toThrow('Det finns redan en lokal timplan som heter "Grundskolan 2024".');
    });
  });

  describe('update', () => {
    it('renames and re-weighs a draft', async () => {
      tx.localTimplan.findUnique.mockResolvedValue(storedPlan());
      tx.localTimplan.update.mockResolvedValue(storedPlan({ name: 'Ny', planningWeeks: new Prisma.Decimal('36') }));

      await expect(service.update(PLAN_ID, { name: ' Ny ', planningWeeks: 36 }, testUser())).resolves.toMatchObject({
        name: 'Ny',
        planningWeeks: 36,
      });
      expect(tx.localTimplan.update).toHaveBeenCalledWith({
        where: { id: PLAN_ID },
        data: { name: 'Ny', planningWeeks: '36.0' },
      });
    });

    it('holds a new version to the plan’s own school form', async () => {
      tx.localTimplan.findUnique.mockResolvedValue(storedPlan({ schoolForm: 'SPECIALSKOLA' }));
      tx.nationalTimplanVersion.findUnique.mockResolvedValue({ code: VERSION.code, schoolForm: 'GRUNDSKOLA' });

      await expect(
        service.update(PLAN_ID, { nationalTimplanVersionId: VERSION_ID }, testUser()),
      ).rejects.toThrow('och planen gäller specialskolan');
      expect(tx.localTimplan.update).not.toHaveBeenCalled();
    });

    it('409s TIMPLAN_IS_DECIDED for a decided plan, naming it, and writes nothing', async () => {
      tx.localTimplan.findUnique.mockResolvedValue(decided());

      const error = await service.update(PLAN_ID, { name: 'x' }, testUser()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toEqual({
        code: 'TIMPLAN_IS_DECIDED',
        message:
          'Den lokala timplanen "Grundskolan 2024" är beslutad och kan inte ändras. Öppna den igen som ett nytt utkast för att göra ändringar.',
      });
      expect(tx.localTimplan.update).not.toHaveBeenCalled();
    });

    it('turns the trigger’s refusal — decided between the read and the write — into the same 409', async () => {
      tx.localTimplan.findUnique.mockResolvedValue(storedPlan());
      tx.localTimplan.update.mockRejectedValue(triggerRefusal('Grundskolan 2024'));

      await expect(service.update(PLAN_ID, { name: 'x' }, testUser())).rejects.toMatchObject({
        response: { code: 'TIMPLAN_IS_DECIDED' },
      });
    });

    it('404s a plan RLS hides', async () => {
      tx.localTimplan.findUnique.mockResolvedValue(null);
      await expect(service.update(PLAN_ID, { name: 'x' }, testUser())).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('deletes a plan without asking its status — a decided plan included', async () => {
      tx.localTimplan.delete.mockResolvedValue(decided());

      await expect(service.remove(PLAN_ID, testUser())).resolves.toBeUndefined();

      expect(tx.localTimplan.delete).toHaveBeenCalledWith({ where: { id: PLAN_ID } });
      expect(tx.localTimplan.findUnique).not.toHaveBeenCalled();
    });

    it('404s one RLS hides', async () => {
      tx.localTimplan.delete.mockRejectedValue(prismaError('P2025'));
      await expect(service.remove(PLAN_ID, testUser())).rejects.toThrow('Den lokala timplanen finns inte.');
    });
  });

  describe('replaceEntries', () => {
    it('touches the plan first, replaces the entries, and answers with the plan and its verdicts', async () => {
      givenTheStatute();
      tx.localTimplan.findUnique
        .mockResolvedValueOnce(storedPlan())
        .mockResolvedValueOnce({ ...storedPlan(), entries: [entry(MA, 1, 708, 'skolans val: +20 min')] });
      tx.subject.findMany.mockResolvedValueOnce([{ id: MA }]);

      const result = await service.replaceEntries(
        PLAN_ID,
        { entries: [{ subjectId: MA, gradeLevel: 1, minutesPerWeek: 708, note: ' skolans val: +20 min ' }] },
        testUser(),
      );

      const order = [
        tx.localTimplan.update.mock.invocationCallOrder[0]!,
        tx.localTimplanEntry.deleteMany.mock.invocationCallOrder[0]!,
        tx.localTimplanEntry.createMany.mock.invocationCallOrder[0]!,
      ];
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(tx.localTimplan.update).toHaveBeenCalledWith({
        where: { id: PLAN_ID },
        data: { updatedAt: expect.any(Date) },
      });
      expect(tx.localTimplanEntry.deleteMany).toHaveBeenCalledWith({ where: { localTimplanId: PLAN_ID } });
      expect(tx.localTimplanEntry.createMany).toHaveBeenCalledWith({
        data: [
          {
            schoolId: SCHOOL_ID,
            localTimplanId: PLAN_ID,
            subjectId: MA,
            gradeLevel: 1,
            minutesPerWeek: 708,
            note: 'skolans val: +20 min',
          },
        ],
      });
      expect(result.plan.entries).toHaveLength(1);
      expect(result.check.cells).toContainEqual(
        expect.objectContaining({ subjectCode: 'MA', stage: 'LAG', plannedHours: 420.1 }),
      );
      // Only the total is short: one cell of a whole timplan is planned.
      expect(result.check.verdicts.map((v) => v.code)).toEqual(['TIMPLAN_TOTAL_BELOW_GUARANTEE']);
    });

    it('empties a plan with an empty list, and writes no createMany', async () => {
      givenTheStatute();
      tx.localTimplan.findUnique
        .mockResolvedValueOnce(storedPlan())
        .mockResolvedValueOnce({ ...storedPlan(), entries: [] });

      await service.replaceEntries(PLAN_ID, { entries: [] }, testUser());

      expect(tx.localTimplanEntry.deleteMany).toHaveBeenCalled();
      expect(tx.localTimplanEntry.createMany).not.toHaveBeenCalled();
    });

    it('400s two rows for one subject and årskurs before touching the database', async () => {
      await expect(
        service.replaceEntries(
          PLAN_ID,
          {
            entries: [
              { subjectId: MA, gradeLevel: 4, minutesPerWeek: 180 },
              { subjectId: PROG, gradeLevel: 4, minutesPerWeek: 60 },
              { subjectId: MA, gradeLevel: 4, minutesPerWeek: 120 },
            ],
          },
          testUser(),
        ),
      ).rejects.toThrow('entries: rad 3 har samma ämne och årskurs 4 som rad 1.');
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('400s a subject the school does not have, naming it, and replaces nothing', async () => {
      tx.localTimplan.findUnique.mockResolvedValue(storedPlan());
      tx.subject.findMany.mockResolvedValueOnce([{ id: MA }]);

      await expect(
        service.replaceEntries(
          PLAN_ID,
          {
            entries: [
              { subjectId: MA, gradeLevel: 4, minutesPerWeek: 180 },
              { subjectId: PROG, gradeLevel: 4, minutesPerWeek: 60 },
            ],
          },
          testUser(),
        ),
      ).rejects.toThrow(`entries: ämnet finns inte i skolan: ${PROG}.`);
      expect(tx.localTimplanEntry.deleteMany).not.toHaveBeenCalled();
    });

    it('409s a decided plan before the touch, and the trigger’s refusal after it', async () => {
      tx.localTimplan.findUnique.mockResolvedValueOnce(decided());
      await expect(service.replaceEntries(PLAN_ID, { entries: [] }, testUser())).rejects.toMatchObject({
        response: { code: 'TIMPLAN_IS_DECIDED' },
      });
      expect(tx.localTimplan.update).not.toHaveBeenCalled();

      tx.localTimplan.findUnique.mockResolvedValueOnce(storedPlan());
      tx.localTimplan.update.mockRejectedValueOnce(triggerRefusal('Grundskolan 2024'));
      await expect(service.replaceEntries(PLAN_ID, { entries: [] }, testUser())).rejects.toMatchObject({
        response: { code: 'TIMPLAN_IS_DECIDED', message: expect.stringContaining('"Grundskolan 2024"') },
      });
      expect(tx.localTimplanEntry.deleteMany).not.toHaveBeenCalled();
    });

    it('404s a plan RLS hides', async () => {
      tx.localTimplan.findUnique.mockResolvedValue(null);
      await expect(service.replaceEntries(PLAN_ID, { entries: [] }, testUser())).rejects.toThrow(NotFoundException);
    });
  });

  describe('decide', () => {
    it('stamps the caller, now and the trimmed note, conditioned on the plan still being a draft', async () => {
      tx.localTimplan.findUnique
        .mockResolvedValueOnce(storedPlan())
        .mockResolvedValueOnce(decided({ decidedByUserId: USER_ID }));
      tx.localTimplan.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.decide(PLAN_ID, { decisionNote: '  dnr 2026/17 ' }, testUser());

      expect(result).toMatchObject({ status: 'DECIDED', planningWeeks: 35.6 });
      expect(tx.localTimplan.updateMany).toHaveBeenCalledWith({
        where: { id: PLAN_ID, status: 'DRAFT' },
        data: {
          status: 'DECIDED',
          decidedAt: expect.any(Date),
          decidedByUserId: USER_ID,
          decisionNote: 'dnr 2026/17',
        },
      });
    });

    it('409s deciding a decided plan, and the loser of two racing decides', async () => {
      tx.localTimplan.findUnique.mockResolvedValueOnce(decided());
      await expect(service.decide(PLAN_ID, { decisionNote: 'x' }, testUser())).rejects.toThrow(ConflictException);
      expect(tx.localTimplan.updateMany).not.toHaveBeenCalled();

      tx.localTimplan.findUnique.mockResolvedValueOnce(storedPlan()).mockResolvedValueOnce(decided());
      tx.localTimplan.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.decide(PLAN_ID, { decisionNote: 'x' }, testUser())).rejects.toMatchObject({
        response: { code: 'TIMPLAN_IS_DECIDED' },
      });
    });

    it('refuses a principal with no user id, whose decision could name nobody', async () => {
      await expect(
        service.decide(PLAN_ID, { decisionNote: 'x' }, testUser({ userId: undefined })),
      ).rejects.toThrow('No user identity');
      expect(prisma.withRls).not.toHaveBeenCalled();
    });
  });

  describe('reopen and copy', () => {
    const givenSource = (source: Record<string, unknown>) => {
      tx.localTimplan.findUnique
        .mockResolvedValueOnce({ ...source, entries: [entry(MA, 4, 180, 'not'), entry(PROG, 8, 60)] })
        .mockResolvedValueOnce({ ...storedPlan({ id: NEW_ID, copiedFromId: PLAN_ID }), entries: [] });
      tx.localTimplan.create.mockResolvedValue(storedPlan({ id: NEW_ID }));
    };

    it('reopens a decided plan as a new draft pointing back at it, entries and weeks copied', async () => {
      givenSource(decided());
      tx.localTimplan.findMany.mockResolvedValue([{ name: 'Grundskolan 2024' }]);

      const result = await service.reopen(PLAN_ID, {}, testUser());

      expect(result).toMatchObject({ id: NEW_ID, copiedFromId: PLAN_ID });
      expect(tx.localTimplan.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          name: 'Grundskolan 2024 (utkast)',
          schoolForm: 'GRUNDSKOLA',
          nationalTimplanVersionId: VERSION_ID,
          planningWeeks: new Prisma.Decimal('35.6'),
          copiedFromId: PLAN_ID,
        },
      });
      expect(tx.localTimplanEntry.createMany).toHaveBeenCalledWith({
        data: [
          { schoolId: SCHOOL_ID, localTimplanId: NEW_ID, subjectId: MA, gradeLevel: 4, minutesPerWeek: 180, note: 'not' },
          { schoolId: SCHOOL_ID, localTimplanId: NEW_ID, subjectId: PROG, gradeLevel: 8, minutesPerWeek: 60, note: null },
        ],
      });
      // The decided plan itself is not written.
      expect(tx.localTimplan.update).not.toHaveBeenCalled();
      expect(tx.localTimplan.updateMany).not.toHaveBeenCalled();
    });

    it('picks the next free name, and keeps it within 100 characters', async () => {
      givenSource(decided({ name: 'G'.repeat(100) }));
      tx.localTimplan.findMany.mockResolvedValue([
        { name: `${'G'.repeat(91)} (utkast)` },
      ]);

      await service.reopen(PLAN_ID, {}, testUser());

      const name = tx.localTimplan.create.mock.calls[0]![0].data.name as string;
      expect(name).toBe(`${'G'.repeat(89)} (utkast 2)`);
      expect(name.length).toBeLessThanOrEqual(100);
    });

    it('409s reopening a draft, which can be edited as it is', async () => {
      tx.localTimplan.findUnique.mockResolvedValueOnce({ ...storedPlan(), entries: [] });

      await expect(service.reopen(PLAN_ID, {}, testUser())).rejects.toMatchObject({
        response: { code: 'TIMPLAN_IS_DRAFT' },
      });
      expect(tx.localTimplan.create).not.toHaveBeenCalled();
    });

    it('copies any plan under the name given, and 409s a name already taken', async () => {
      givenSource(storedPlan());

      await service.copy(PLAN_ID, { name: ' Anpassad 2026 ' }, testUser());
      expect(tx.localTimplan.create.mock.calls[0]![0].data).toMatchObject({
        name: 'Anpassad 2026',
        copiedFromId: PLAN_ID,
      });
      expect(tx.localTimplan.findMany).not.toHaveBeenCalled();

      tx.localTimplan.findUnique.mockResolvedValueOnce({ ...storedPlan(), entries: [] });
      tx.localTimplan.create.mockRejectedValueOnce(prismaError('P2002'));
      await expect(service.copy(PLAN_ID, { name: 'Grundskolan 2024' }, testUser())).rejects.toThrow(
        'Det finns redan en lokal timplan som heter "Grundskolan 2024".',
      );
    });

    it('404s a source RLS hides', async () => {
      tx.localTimplan.findUnique.mockResolvedValue(null);
      await expect(service.copy(PLAN_ID, {}, testUser())).rejects.toThrow(NotFoundException);
    });
  });
});
