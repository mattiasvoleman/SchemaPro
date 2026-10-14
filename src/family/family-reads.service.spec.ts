import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import { recordedReads } from '../../test/utils/recorded-reads';
import { Role } from '../auth/enums/role.enum';
import type { PrismaService } from '../database/prisma.service';
import { FAMILY_READ_LIMIT, FamilyReadsService } from './family-reads.service';

const GUARDIAN_ID = '44444444-4444-4444-8444-444444444444';
const CHILD_A = '55555555-5555-4555-8555-555555555555';
const CHILD_B = '56565656-5656-4565-8565-565656565656';
const OTHER_GUARDIAN = '57575757-5757-4575-8575-575757575757';

describe('FamilyReadsService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let service: FamilyReadsService;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new FamilyReadsService(prisma as unknown as PrismaService);
  });

  const guardian = () => testUser({ role: Role.GUARDIAN, userId: GUARDIAN_ID, channel: 'APP' });

  describe('children', () => {
    it('lists the guardian\'s own links, names only, and records them as PEOPLE in the read\'s transaction', async () => {
      tx.guardianStudent.findMany.mockResolvedValue([
        { id: 'l1', student: { id: CHILD_A, firstName: 'Alva', lastName: 'Ek', isActive: true, studentGroupId: 'g1' } },
        { id: 'l2', student: { id: CHILD_B, firstName: 'Bo', lastName: 'Ek', isActive: false, studentGroupId: null } },
      ]);
      await expect(service.children(guardian())).resolves.toEqual([
        { linkId: 'l1', id: CHILD_A, firstName: 'Alva', lastName: 'Ek', isActive: true, studentGroupId: 'g1' },
        { linkId: 'l2', id: CHILD_B, firstName: 'Bo', lastName: 'Ek', isActive: false, studentGroupId: null },
      ]);
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
          id: 'r1', studentId: CHILD_A, reportedById: GUARDIAN_ID, date: new Date('2026-10-14T00:00:00.000Z'),
          startTime: new Date('1970-01-01T08:30:00.000Z'), endTime: new Date('1970-01-01T11:00:05.000Z'),
          type: 'APPOINTMENT', note: 'Tandläkare', createdAt: new Date('2026-10-13T06:00:00.000Z'),
        },
        {
          id: 'r2', studentId: CHILD_B, reportedById: OTHER_GUARDIAN, date: new Date('2026-10-13T00:00:00.000Z'),
          startTime: null, endTime: null, type: 'SICK', note: null, createdAt: new Date('2026-10-13T05:00:00.000Z'),
        },
      ]);
      await expect(service.absenceReports({}, guardian())).resolves.toEqual([
        {
          id: 'r1', studentId: CHILD_A, reportedById: GUARDIAN_ID, date: '2026-10-14', startTime: '08:30:00', endTime: '11:00:05',
          type: 'APPOINTMENT', note: 'Tandläkare', createdAt: '2026-10-13T06:00:00.000Z',
        },
        {
          id: 'r2', studentId: CHILD_B, reportedById: OTHER_GUARDIAN, date: '2026-10-13', startTime: null, endTime: null,
          type: 'SICK', note: null, createdAt: '2026-10-13T05:00:00.000Z',
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
