import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import { rawSql } from '../../test/utils/locking-read';
import type { PrismaService } from '../database/prisma.service';
import { MySchoolsService } from './my-schools.service';

const A = '33333333-3333-4333-8333-333333333333';
const B = '44444444-4444-4444-8444-444444444444';

describe('MySchoolsService (Flera skolor per inloggning)', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let service: MySchoolsService;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new MySchoolsService(prisma as unknown as PrismaService);
  });

  it("reads the login's schools from app.my_schools() under the caller's own claims", async () => {
    const user = testUser({ schoolId: A });
    tx.$queryRaw.mockResolvedValue([
      { school_id: A, school_name: 'Ekbacken', role: 'TEACHER', admin_profile: null, closed_reason: null, is_current: true },
      { school_id: B, school_name: 'Granen', role: 'SCHOOL_ADMIN', admin_profile: 'LASARE', closed_reason: 'sso_required', is_current: false },
    ]);

    await expect(service.list(user)).resolves.toEqual([
      { schoolId: A, schoolName: 'Ekbacken', role: 'TEACHER', adminProfile: null, closed: null, current: true, huvudman: null },
      { schoolId: B, schoolName: 'Granen', role: 'SCHOOL_ADMIN', adminProfile: 'LASARE', closed: 'sso_required', current: false, huvudman: null },
    ]);
    expect(prisma.queryWithRls).toHaveBeenCalledWith(user, expect.any(Function));
    // No membership read for a login with only its own rows: one statement, as before.
    expect(prisma.queryWithRls).toHaveBeenCalledTimes(1);
    expect(rawSql(tx.$queryRaw.mock.calls[0]!)).toContain('FROM app.my_schools()');
  });

  it('says nothing about any school beyond the switcher\'s fields', async () => {
    tx.$queryRaw.mockResolvedValue([
      { school_id: A, school_name: 'Ekbacken', role: 'GUARDIAN', admin_profile: null, closed_reason: null, is_current: true, user_id: 'x' },
    ]);

    const [school] = await service.list(testUser());
    expect(Object.keys(school!).sort()).toEqual(['adminProfile', 'closed', 'current', 'huvudman', 'role', 'schoolId', 'schoolName']);
  });

  it("names the huvudman and the member's own name on a school the login reads as its huvudman's (Huvudman)", async () => {
    const member = '55555555-5555-4555-8555-555555555555';
    tx.$queryRaw.mockResolvedValue([
      { school_id: A, school_name: 'Ekbacken', role: 'TEACHER', admin_profile: null, closed_reason: null, is_current: true,
        huvudman_member_id: null, huvudman_name: null, huvudman_role: null },
      { school_id: B, school_name: 'Granen', role: 'SCHOOL_ADMIN', admin_profile: 'LASARE', closed_reason: null, is_current: false,
        huvudman_member_id: member, huvudman_name: 'Vimmerby kommun', huvudman_role: 'PLANERARE' },
    ]);
    tx.huvudmanMember.findMany.mockResolvedValue([{ id: member, huvudmanId: 'h1', firstName: 'Pia', lastName: 'Planerare' }]);

    const [own, read] = await service.list(testUser());
    expect(own!.huvudman).toBeNull();
    expect(read!.huvudman).toEqual({ id: 'h1', name: 'Vimmerby kommun', role: 'PLANERARE', memberId: member, firstName: 'Pia', lastName: 'Planerare' });
    expect(tx.huvudmanMember.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: [member] } } }));
  });
});
