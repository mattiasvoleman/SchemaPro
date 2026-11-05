import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createPrismaMock, createTxMock, testUser } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { AbsenceWatchService, figuresOf } from './absence-watch.service';

const admin = testUser({ schoolId: 'school-1' });

function setup() {
  const tx = createTxMock();
  const prisma = createPrismaMock(tx);
  const service = new AbsenceWatchService(prisma as unknown as PrismaService);
  return { tx, prisma, service };
}

const limitRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'limit-1',
  schoolId: 'school-1',
  recipientGroup: 'MENTOR',
  kind: 'SHARE',
  basis: 'INVALID',
  percent: 10,
  windowDays: 14,
  consecutiveDays: null,
  ...overrides,
});

describe('figuresOf', () => {
  it('gives a share its percent and window and a run its days, and refuses the figures of the other kind', () => {
    expect(figuresOf('SHARE', { percent: 10, windowDays: 14 })).toEqual({ percent: 10, windowDays: 14, consecutiveDays: null });
    expect(figuresOf('CONSECUTIVE', { consecutiveDays: 5 })).toEqual({ percent: null, windowDays: null, consecutiveDays: 5 });
    expect(() => figuresOf('SHARE', { percent: 10 })).toThrow(BadRequestException);
    expect(() => figuresOf('SHARE', { windowDays: 14 })).toThrow(BadRequestException);
    expect(() => figuresOf('SHARE', { percent: 10, windowDays: 14, consecutiveDays: 3 })).toThrow(BadRequestException);
    expect(() => figuresOf('CONSECUTIVE', {})).toThrow(BadRequestException);
    expect(() => figuresOf('CONSECUTIVE', { consecutiveDays: 3, percent: 10 })).toThrow(BadRequestException);
    expect(() => figuresOf('CONSECUTIVE', { consecutiveDays: 3, windowDays: 14 })).toThrow(BadRequestException);
  });

  it('reads a null figure as not given, as a form that sends null for the field its kind does not use means it', () => {
    expect(figuresOf('SHARE', { percent: 10, windowDays: 14, consecutiveDays: null as never })).toEqual({ percent: 10, windowDays: 14, consecutiveDays: null });
    expect(figuresOf('CONSECUTIVE', { consecutiveDays: 5, percent: null as never, windowDays: null as never })).toEqual({
      percent: null,
      windowDays: null,
      consecutiveDays: 5,
    });
    // A share with its percent null is a share without one: a 400 here, not a CHECK in the database.
    expect(() => figuresOf('SHARE', { percent: null as never, windowDays: 14 })).toThrow(BadRequestException);
    expect(() => figuresOf('SHARE', { percent: 10, windowDays: null as never })).toThrow(BadRequestException);
    expect(() => figuresOf('CONSECUTIVE', { consecutiveDays: null as never })).toThrow(BadRequestException);
  });
});

describe('AbsenceWatchService', () => {
  describe('overview', () => {
    it('says off, with weekly staff and monthly guardians, for a school with no row', async () => {
      const { tx, service } = setup();
      tx['absenceWatchSetting']!['findFirst']!.mockResolvedValue(null);
      const view = await service.overview(admin);
      expect(view.settings).toEqual({
        enabled: false,
        enabledOn: null,
        cadence: { MENTOR: 'WEEKLY', REKTOR: 'WEEKLY', KANSLI: 'WEEKLY', GUARDIAN: 'MONTHLY' },
      });
      expect(view.limits).toEqual([]);
    });

    it('reads the switch, its date and the limits in order', async () => {
      const { tx, service } = setup();
      tx['absenceWatchSetting']!['findFirst']!.mockResolvedValue({
        enabled: true,
        enabledOn: new Date('2026-09-10T00:00:00Z'),
        mentorCadence: 'MONTHLY',
        rektorCadence: 'WEEKLY',
        kansliCadence: 'WEEKLY',
        guardianCadence: 'MONTHLY',
      });
      tx['absenceWatchLimit']!['findMany']!.mockResolvedValue([limitRow()]);
      const view = await service.overview(admin);
      expect(view.settings.enabled).toBe(true);
      expect(view.settings.enabledOn).toBe('2026-09-10');
      expect(view.settings.cadence.MENTOR).toBe('MONTHLY');
      expect(view.limits).toEqual([
        { id: 'limit-1', recipientGroup: 'MENTOR', kind: 'SHARE', basis: 'INVALID', percent: 10, windowDays: 14, consecutiveDays: null },
      ]);
      expect(tx['absenceWatchLimit']!['findMany']).toHaveBeenCalledWith({
        orderBy: [{ recipientGroup: 'asc' }, { kind: 'asc' }, { basis: 'asc' }],
      });
    });
  });

  describe('updateSettings', () => {
    it('upserts only what the save names, for the school of the caller', async () => {
      const { tx, service } = setup();
      await service.updateSettings({ enabled: true, guardianCadence: 'WEEKLY' }, admin);
      expect(tx['absenceWatchSetting']!['upsert']).toHaveBeenCalledWith({
        where: { schoolId: 'school-1' },
        create: { schoolId: 'school-1', enabled: true, guardianCadence: 'WEEKLY' },
        update: { enabled: true, guardianCadence: 'WEEKLY' },
      });
    });

    it('can turn it off', async () => {
      const { tx, service } = setup();
      await service.updateSettings({ enabled: false }, admin);
      expect(tx['absenceWatchSetting']!['upsert']).toHaveBeenCalledWith(expect.objectContaining({ update: { enabled: false } }));
    });
  });

  describe('limits', () => {
    it('creates a limit with the figures of its kind', async () => {
      const { tx, service } = setup();
      tx['absenceWatchLimit']!['create']!.mockResolvedValue(limitRow({ kind: 'CONSECUTIVE', percent: null, windowDays: null, consecutiveDays: 5 }));
      const view = await service.createLimit(
        { recipientGroup: 'REKTOR', kind: 'CONSECUTIVE', basis: 'ALL', consecutiveDays: 5 },
        admin,
      );
      expect(tx['absenceWatchLimit']!['create']).toHaveBeenCalledWith({
        data: { schoolId: 'school-1', recipientGroup: 'REKTOR', kind: 'CONSECUTIVE', basis: 'ALL', percent: null, windowDays: null, consecutiveDays: 5 },
      });
      expect(view.consecutiveDays).toBe(5);
    });

    it('refuses figures of the wrong kind before the database does', async () => {
      const { tx, service } = setup();
      await expect(service.createLimit({ recipientGroup: 'MENTOR', kind: 'SHARE', basis: 'ALL', percent: 10 }, admin)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(tx['absenceWatchLimit']!['create']).not.toHaveBeenCalled();
    });

    it('answers 409 for a limit the school already has for the group, kind and basis', async () => {
      const { tx, service } = setup();
      tx['absenceWatchLimit']!['create']!.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' }),
      );
      await expect(
        service.createLimit({ recipientGroup: 'MENTOR', kind: 'SHARE', basis: 'ALL', percent: 10, windowDays: 14 }, admin),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('changes the figures of a limit by the kind it has, and finds none that belongs to another school', async () => {
      const { tx, service } = setup();
      tx['absenceWatchLimit']!['findUnique']!.mockResolvedValue(limitRow());
      tx['absenceWatchLimit']!['update']!.mockResolvedValue(limitRow({ percent: 20, windowDays: 28 }));
      const view = await service.updateLimit('limit-1', { percent: 20, windowDays: 28 }, admin);
      expect(tx['absenceWatchLimit']!['update']).toHaveBeenCalledWith({
        where: { id: 'limit-1' },
        data: { percent: 20, windowDays: 28, consecutiveDays: null },
      });
      expect(view.percent).toBe(20);
      await expect(service.updateLimit('limit-1', { consecutiveDays: 3 }, admin)).rejects.toBeInstanceOf(BadRequestException);
      tx['absenceWatchLimit']!['findUnique']!.mockResolvedValue(null);
      await expect(service.updateLimit('nope', { percent: 20, windowDays: 28 }, admin)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('removes a limit, and says so when there is none', async () => {
      const { tx, service } = setup();
      tx['absenceWatchLimit']!['deleteMany']!.mockResolvedValue({ count: 1 });
      await expect(service.deleteLimit('limit-1', admin)).resolves.toBeUndefined();
      tx['absenceWatchLimit']!['deleteMany']!.mockResolvedValue({ count: 0 });
      await expect(service.deleteLimit('limit-2', admin)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('findings', () => {
    const finding = (overrides: Record<string, unknown> = {}) => ({
      id: 'f-1',
      studentId: 'pupil-1',
      recipientGroup: 'MENTOR',
      kind: 'SHARE',
      basis: 'INVALID',
      percent: 10,
      windowDays: 14,
      consecutiveDays: null,
      firstCrossedOn: new Date('2026-09-24T00:00:00Z'),
      lastSeenOn: new Date('2026-09-25T00:00:00Z'),
      clearedOn: null,
      absentMinutes: 60,
      recordedMinutes: 600,
      streakDays: null,
      student: { firstName: 'Elev', lastName: 'Ett', studentGroup: { name: '7A' } },
      ...overrides,
    });

    it('hands out the open findings with the pupil, and records the read as attendance and as people', async () => {
      const { tx, service } = setup();
      tx['absenceWatchFinding']!['findMany']!.mockResolvedValue([finding(), finding({ id: 'f-2', studentId: 'pupil-2', student: null })]);
      const view = await service.findings({}, { ...admin, channel: 'WEB' });
      expect(view.truncated).toBe(false);
      expect(view.findings[0]).toEqual({
        id: 'f-1',
        studentId: 'pupil-1',
        studentName: 'Elev Ett',
        className: '7A',
        recipientGroup: 'MENTOR',
        kind: 'SHARE',
        basis: 'INVALID',
        percent: 10,
        windowDays: 14,
        consecutiveDays: null,
        firstCrossedOn: '2026-09-24',
        lastSeenOn: '2026-09-25',
        clearedOn: null,
        absentMinutes: 60,
        recordedMinutes: 600,
        streakDays: null,
      });
      // A pupil whose row the reader may not read has no name, and is still a pupil handed out.
      expect(view.findings[1]).toMatchObject({ studentId: 'pupil-2', studentName: null, className: null });
      const reads = tx.$executeRaw.mock.calls.map(([statement]) => ({
        sql: (statement as { strings: string[] }).strings.join('?'),
        values: (statement as { values: unknown[] }).values,
      }));
      expect(reads).toHaveLength(2);
      expect(reads.every((read) => read.sql.includes('app.personal_data_read'))).toBe(true);
      expect(reads.map((read) => read.values[0])).toEqual(['ATTENDANCE', 'PEOPLE']);
      expect(reads.map((read) => read.values[1])).toEqual(['WEB', 'WEB']);
      expect(reads.map((read) => read.values[2])).toEqual([['pupil-1', 'pupil-2'], ['pupil-1', 'pupil-2']]);
    });

    it('asks for the open ones, or with `recent` those closed in the last 60 days too', async () => {
      const { tx, service } = setup();
      await service.findings({}, admin);
      expect(tx['absenceWatchFinding']!['findMany']).toHaveBeenLastCalledWith(expect.objectContaining({ where: { clearedOn: null } }));
      await service.findings({ recent: true }, admin, new Date('2026-10-01T10:00:00Z'));
      expect(tx['absenceWatchFinding']!['findMany']).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: { OR: [{ clearedOn: null }, { clearedOn: { gte: new Date('2026-08-02T10:00:00Z') } }] } }),
      );
    });

    it('records no read when nobody is handed out', async () => {
      const { tx, service } = setup();
      tx['absenceWatchFinding']!['findMany']!.mockResolvedValue([]);
      await expect(service.findings({}, admin)).resolves.toEqual({ findings: [], truncated: false });
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('says when it left the oldest out, and records only the pupils it handed out', async () => {
      const { tx, service } = setup();
      const many = Array.from({ length: 2001 }, (_unused, i) => finding({ id: `f-${i}`, studentId: `pupil-${i}` }));
      tx['absenceWatchFinding']!['findMany']!.mockResolvedValue(many);
      const view = await service.findings({}, admin);
      expect(view.truncated).toBe(true);
      expect(view.findings).toHaveLength(2000);
      const recorded = (tx.$executeRaw.mock.calls[0]![0] as { values: unknown[] }).values[2] as string[];
      expect(recorded).toHaveLength(2000);
      expect(recorded).not.toContain('pupil-2000');
    });
  });
});
