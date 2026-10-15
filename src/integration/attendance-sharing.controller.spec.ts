import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { AttendanceSharingController, ATTENDANCE_SHARING_HISTORY, RecordAttendanceSharingDto } from './attendance-sharing.controller';

const ADMIN_ID = '20000000-0000-4000-8000-000000000001';
const OTHER_ADMIN = '20000000-0000-4000-8000-000000000002';
const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';

describe('AttendanceSharingController', () => {
  let controller: AttendanceSharingController;
  let tx: TxMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    controller = new AttendanceSharingController(prisma as unknown as PrismaService);
  });

  it('is the administrator\'s alone', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AttendanceSharingController)).toEqual([Role.SCHOOL_ADMIN]);
  });

  it('answers nothing in force when the school never decided: not shared', async () => {
    tx.attendanceSharingDecision.findMany.mockResolvedValue([]);
    await expect(controller.get(testUser({ userId: ADMIN_ID }))).resolves.toEqual({ current: null, history: [] });
  });

  it('answers the latest decision in force and the history, newest first, with the deciders\' names', async () => {
    tx.attendanceSharingDecision.findMany.mockResolvedValue([
      { shares: false, reference: null, decidedAt: new Date('2026-11-20T08:00:00Z'), decidedById: OTHER_ADMIN },
      { shares: true, reference: 'Dnr 2026:41', decidedAt: new Date('2026-11-14T08:00:00Z'), decidedById: ADMIN_ID },
    ]);
    tx.user.findMany.mockResolvedValue([
      { id: ADMIN_ID, firstName: 'Anna', lastName: 'Admin' },
      { id: OTHER_ADMIN, firstName: 'Rolf', lastName: 'Rektor' },
    ]);
    const answer = await controller.get(testUser({ userId: ADMIN_ID }));
    expect(answer.current).toEqual({ shares: false, reference: null, decidedAt: '2026-11-20T08:00:00.000Z', decidedBy: 'Rolf Rektor' });
    expect(answer.history.map((row) => [row.shares, row.decidedBy])).toEqual([
      [false, 'Rolf Rektor'],
      [true, 'Anna Admin'],
    ]);
    expect(tx.attendanceSharingDecision.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }], take: ATTENDANCE_SHARING_HISTORY }),
    );
    expect(prisma.withRls).toHaveBeenCalledTimes(1);
  });

  it('records a new decision under the administrator\'s RLS, never who or when (the database stamps them)', async () => {
    tx.attendanceSharingDecision.create.mockResolvedValue({ shares: true, reference: 'Dnr 2026:41', decidedAt: new Date('2026-11-14T08:00:00Z'), decidedById: ADMIN_ID });
    tx.user.findMany.mockResolvedValue([{ id: ADMIN_ID, firstName: 'Anna', lastName: 'Admin' }]);
    const user = testUser({ userId: ADMIN_ID, schoolId: SCHOOL_ID });
    await expect(controller.record({ shares: true, reference: '  Dnr 2026:41  ' }, user)).resolves.toEqual({
      shares: true,
      reference: 'Dnr 2026:41',
      decidedAt: '2026-11-14T08:00:00.000Z',
      decidedBy: 'Anna Admin',
    });
    expect(tx.attendanceSharingDecision.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { schoolId: SCHOOL_ID, shares: true, reference: 'Dnr 2026:41' } }),
    );
    expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
  });

  it('takes shares as a boolean and a reference of 1..200 characters that is not blank', async () => {
    const errors = async (body: unknown) => (await validate(plainToInstance(RecordAttendanceSharingDto, body))).map((error) => error.property);
    expect(await errors({ shares: true })).toEqual([]);
    expect(await errors({ shares: false, reference: 'Konsekvensbedömning 2026-11' })).toEqual([]);
    expect(await errors({})).toEqual(['shares']);
    expect(await errors({ shares: 'yes' })).toEqual(['shares']);
    expect(await errors({ shares: true, reference: '   ' })).toEqual(['reference']);
    expect(await errors({ shares: true, reference: 'x'.repeat(201) })).toEqual(['reference']);
  });
});
