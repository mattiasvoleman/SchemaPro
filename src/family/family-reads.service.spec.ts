import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import { recordedReads } from '../../test/utils/recorded-reads';
import { Role } from '../auth/enums/role.enum';
import type { PrismaService } from '../database/prisma.service';
import { FAMILY_READ_LIMIT, FamilyReadsService } from './family-reads.service';

const GUARDIAN_ID = '44444444-4444-4444-8444-444444444444';
const CHILD_A = '55555555-5555-4555-8555-555555555555';
const CHILD_B = '56565656-5656-4565-8565-565656565656';
const OTHER_GUARDIAN = '57575757-5757-4575-8575-575757575757';
const SCHOOL_ID = '99999999-9999-4999-8999-999999999999';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
/** 10:00 in Stockholm: UTC and the school agree on the day. */
const NOW = new Date('2026-10-14T08:00:00.000Z');

describe('FamilyReadsService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let service: FamilyReadsService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new FamilyReadsService(prisma as unknown as PrismaService);
    arrangeSchool();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const guardian = () => testUser({ role: Role.GUARDIAN, userId: GUARDIAN_ID, channel: 'APP' });

  /** The school, found by its id, in the given zone; any other id is a row RLS does not show. */
  const arrangeSchool = (timezone = 'Europe/Stockholm') =>
    tx.school.findUnique.mockImplementation(({ where }: { where?: { id?: string } }) =>
      Promise.resolve(where?.id === SCHOOL_ID ? { timezone } : null),
    );

  describe('children', () => {
    it('lists the guardian\'s own links, names only, and records them as PEOPLE in the read\'s transaction', async () => {
      tx.guardianStudent.findMany.mockResolvedValue([
        { id: 'l1', schoolId: SCHOOL_ID, student: { id: CHILD_A, firstName: 'Alva', lastName: 'Ek', isActive: true, studentGroupId: 'g1' } },
        { id: 'l2', schoolId: SCHOOL_ID, student: { id: CHILD_B, firstName: 'Bo', lastName: 'Ek', isActive: false, studentGroupId: null } },
      ]);
      await expect(service.children(guardian())).resolves.toEqual([
        { linkId: 'l1', id: CHILD_A, firstName: 'Alva', lastName: 'Ek', isActive: true, studentGroupId: 'g1', schoolToday: '2026-10-14' },
        { linkId: 'l2', id: CHILD_B, firstName: 'Bo', lastName: 'Ek', isActive: false, studentGroupId: null, schoolToday: '2026-10-14' },
      ]);
      // One school, one read of its zone, however many children it has.
      expect(tx.school.findUnique).toHaveBeenCalledTimes(1);
      expect(tx.school.findUnique).toHaveBeenCalledWith({ where: { id: SCHOOL_ID }, select: { timezone: true } });
      const [query] = tx.guardianStudent.findMany.mock.calls[0] as [{ where: unknown; select: { student: { select: object } } }];
      expect(query.where).toEqual({ guardianId: GUARDIAN_ID });
      // No contact details leave for a child.
      expect(Object.keys(query.select.student.select).sort()).toEqual(['firstName', 'id', 'isActive', 'lastName', 'studentGroupId']);
      expect(recordedReads(tx)).toEqual([{ kind: 'PEOPLE', channel: 'APP', ids: [CHILD_A, CHILD_B] }]);
      expect(prisma.withRls).toHaveBeenCalledTimes(1);
    });

    it('records nothing for a guardian with no linked child', async () => {
      await expect(service.children(guardian())).resolves.toEqual([]);
      expect(recordedReads(tx)).toEqual([]);
    });
  });

  describe('absenceReports', () => {
    it('answers PostgREST\'s shape (a bare date, wall clocks to the second) and records ABSENCE_REPORTS', async () => {
      tx.absenceReport.findMany.mockResolvedValue([
        {
          id: 'r1', schoolId: SCHOOL_ID, studentId: CHILD_A, reportedById: GUARDIAN_ID, date: new Date('2026-10-14T00:00:00.000Z'),
          startTime: new Date('1970-01-01T08:30:00.000Z'), endTime: new Date('1970-01-01T11:00:05.000Z'),
          type: 'APPOINTMENT', note: 'Tandläkare', createdAt: new Date('2026-10-13T06:00:00.000Z'),
        },
        {
          id: 'r2', schoolId: SCHOOL_ID, studentId: CHILD_B, reportedById: OTHER_GUARDIAN, date: new Date('2026-10-13T00:00:00.000Z'),
          startTime: null, endTime: null, type: 'SICK', note: null, createdAt: new Date('2026-10-13T05:00:00.000Z'),
        },
      ]);
      // The school id is read for the school's day and not handed out.
      await expect(service.absenceReports({}, guardian())).resolves.toEqual([
        {
          id: 'r1', studentId: CHILD_A, reportedById: GUARDIAN_ID, date: '2026-10-14', startTime: '08:30:00', endTime: '11:00:05',
          type: 'APPOINTMENT', note: 'Tandläkare', createdAt: '2026-10-13T06:00:00.000Z', removable: true,
        },
        {
          id: 'r2', studentId: CHILD_B, reportedById: OTHER_GUARDIAN, date: '2026-10-13', startTime: null, endTime: null,
          type: 'SICK', note: null, createdAt: '2026-10-13T05:00:00.000Z', removable: false,
        },
      ]);
      const [query] = tx.absenceReport.findMany.mock.calls[0] as [{ where: unknown; take: number; orderBy: unknown }];
      expect(query.where).toEqual({});
      expect(query.take).toBe(FAMILY_READ_LIMIT);
      expect(query.orderBy).toEqual([{ date: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }]);
      expect(recordedReads(tx)).toEqual([{ kind: 'ABSENCE_REPORTS', channel: 'APP', ids: [CHILD_A, CHILD_B] }]);
    });

    it('narrows to one day and one pupil when asked', async () => {
      await service.absenceReports({ date: '2026-10-14', studentId: CHILD_A }, guardian());
      const [query] = tx.absenceReport.findMany.mock.calls[0] as [{ where: unknown }];
      expect(query.where).toEqual({ date: new Date('2026-10-14T00:00:00.000Z'), studentId: CHILD_A });
      expect(recordedReads(tx)).toEqual([]);
    });
  });

  /*
   * "Today" for a report or a leave request is the school's day, whatever
   * the reader's device says. At 00:30 in Stockholm UTC is still on
   * yesterday (22:30Z in summer time, 23:30Z in winter time); at 23:30 the
   * two agree. The withdrawal refuses by the same rule the read answers.
   */
  describe.each([
    { at: '00:30 in summer time', now: '2026-08-06T22:30:00.000Z', today: '2026-08-07', yesterday: '2026-08-06' },
    { at: '00:30 in winter time', now: '2026-12-07T23:30:00.000Z', today: '2026-12-08', yesterday: '2026-12-07' },
    { at: '23:30 in summer time', now: '2026-08-07T21:30:00.000Z', today: '2026-08-07', yesterday: '2026-08-06' },
    { at: '23:30 in winter time', now: '2026-12-08T22:30:00.000Z', today: '2026-12-08', yesterday: '2026-12-07' },
  ])('the school\'s day at $at in Stockholm', ({ now, today, yesterday }) => {
    beforeEach(() => {
      jest.setSystemTime(new Date(now));
    });

    const report = (id: string, date: string, reportedById: string) => ({
      id, schoolId: SCHOOL_ID, studentId: CHILD_A, reportedById, date: new Date(`${date}T00:00:00.000Z`),
      startTime: null, endTime: null, type: 'SICK', note: null, createdAt: new Date('2026-08-01T06:00:00.000Z'),
    });

    it('answers a child\'s schoolToday as the school\'s day', async () => {
      tx.guardianStudent.findMany.mockResolvedValue([
        { id: 'l1', schoolId: SCHOOL_ID, student: { id: CHILD_A, firstName: 'Alva', lastName: 'Ek', isActive: true, studentGroupId: null } },
      ]);
      const [child] = await service.children(guardian());
      expect(child!.schoolToday).toBe(today);
    });

    it('marks the reporter\'s report removable from the school\'s today on, never another guardian\'s', async () => {
      tx.absenceReport.findMany.mockResolvedValue([
        report('today', today, GUARDIAN_ID),
        report('yesterday', yesterday, GUARDIAN_ID),
        report('theirs', today, OTHER_GUARDIAN),
      ]);
      const rows = await service.absenceReports({}, guardian());
      expect(rows.map((row) => [row.id, row.removable])).toEqual([
        ['today', true],
        ['yesterday', false],
        ['theirs', false],
      ]);
    });

    it('marks any of the school\'s current reports removable for the administrator, and no past one', async () => {
      tx.absenceReport.findMany.mockResolvedValue([report('theirs', today, OTHER_GUARDIAN), report('past', yesterday, OTHER_GUARDIAN)]);
      const rows = await service.absenceReports({}, testUser({ role: Role.SCHOOL_ADMIN, userId: ADMIN_ID }));
      expect(rows.map((row) => [row.id, row.removable])).toEqual([
        ['theirs', true],
        ['past', false],
      ]);
    });
  });

  it('takes each report\'s day from its own school, and a school RLS hides is Stockholm\'s', async () => {
    // 00:30 in Stockholm is 22:30 the day before in Reykjavík.
    jest.setSystemTime(new Date('2026-08-06T22:30:00.000Z'));
    arrangeSchool('Atlantic/Reykjavik');
    const HIDDEN_SCHOOL = '98989898-9898-4989-8989-989898989898';
    tx.absenceReport.findMany.mockResolvedValue([
      { id: 'here', schoolId: SCHOOL_ID, studentId: CHILD_A, reportedById: GUARDIAN_ID, date: new Date('2026-08-06T00:00:00.000Z'),
        startTime: null, endTime: null, type: 'SICK', note: null, createdAt: new Date('2026-08-01T06:00:00.000Z') },
      { id: 'hidden', schoolId: HIDDEN_SCHOOL, studentId: CHILD_B, reportedById: GUARDIAN_ID, date: new Date('2026-08-06T00:00:00.000Z'),
        startTime: null, endTime: null, type: 'SICK', note: null, createdAt: new Date('2026-08-01T06:00:00.000Z') },
    ]);
    const rows = await service.absenceReports({}, guardian());
    expect(rows.map((row) => [row.id, row.removable])).toEqual([
      ['here', true],
      ['hidden', false],
    ]);
  });

  describe('guardianLinks', () => {
    it('records the pupil and their guardians as GUARDIANS', async () => {
      tx.guardianStudent.findMany.mockResolvedValue([
        { id: 'l1', guardianId: GUARDIAN_ID, guardian: { id: GUARDIAN_ID, firstName: 'Gun', lastName: 'Ek', email: 'gun@example.test' } },
        { id: 'l2', guardianId: OTHER_GUARDIAN, guardian: { id: OTHER_GUARDIAN, firstName: 'Gert', lastName: 'Ek', email: 'gert@example.test' } },
      ]);
      const admin = testUser({ channel: 'WEB' });
      await expect(service.guardianLinks({ studentId: CHILD_A }, admin)).resolves.toHaveLength(2);
      const [query] = tx.guardianStudent.findMany.mock.calls[0] as [{ where: unknown }];
      expect(query.where).toEqual({ studentId: CHILD_A });
      expect(recordedReads(tx)).toEqual([{ kind: 'GUARDIANS', channel: 'WEB', ids: [CHILD_A, GUARDIAN_ID, OTHER_GUARDIAN] }]);
    });

    it('records nothing when the pupil has no guardian: the read named nobody but the pupil\'s id, which the caller sent', async () => {
      await expect(service.guardianLinks({ studentId: CHILD_A }, testUser())).resolves.toEqual([]);
      expect(recordedReads(tx)).toEqual([]);
    });
  });
});
