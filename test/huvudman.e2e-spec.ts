import request from 'supertest';
import { Prisma } from '@prisma/client';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * Huvudman (20261212090000) through the real routing table, validation and
 * RolesGuard: the huvudman's own routes, the school's answers, and that the
 * huvudman's reader writes nothing anywhere else.
 */

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const HUVUDMAN_ID = '55555555-5555-4555-8555-555555555555';
const MEMBER_ID = '66666666-6666-4666-8666-666666666666';
const OTHER_ID = '77777777-7777-4777-8777-777777777777';

const reader = () =>
  asUser({
    role: 'SCHOOL_ADMIN' as never,
    userId: undefined,
    adminProfile: 'LASARE',
    hrRead: false,
    huvudman: { id: HUVUDMAN_ID, name: 'Vimmerby kommun', memberId: MEMBER_ID, role: 'PLANERARE', firstName: 'Pia', lastName: 'P' },
  });
const member = () => JSON.stringify({ authId: '11111111-1111-4111-8111-111111111111', role: 'HUVUDMAN' });

/** The adapter's form of a database refusal of an SQLSTATE PostgreSQL does not define. */
const refusal = (state: string, message: string) =>
  new Prisma.PrismaClientKnownRequestError(`Database error. Code: \`${state}\`. Message: \`${message}\``, {
    code: 'P2039',
    clientVersion: 'test',
    meta: { driverAdapterError: { cause: { originalCode: state, originalMessage: message } } },
  });

describe('Huvudman (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();

  beforeAll(async () => {
    harness = await createTestApp();
  });
  afterAll(async () => harness.close());
  beforeEach(() => jest.clearAllMocks());

  describe("the reader writes nothing of the school's", () => {
    it.each([
      ['POST', '/api/v1/users', { role: 'TEACHER', firstName: 'A', lastName: 'B', email: 'a@example.invalid' }],
      ['POST', '/api/v1/devices', { token: 'ExponentPushToken[x]', platform: 'IOS' }],
      ['POST', '/api/v1/calendar-feeds', {}],
      ['POST', `/api/v1/huvudman-ownership/requests/${HUVUDMAN_ID}/accept`, {}],
      ['DELETE', '/api/v1/huvudman-ownership', {}],
    ])('%s %s is HUVUDMAN_READS_ONLY', async (method, path, body) => {
      const call = method === 'POST' ? request(http()).post(path) : request(http()).delete(path);
      const response = await call.set('x-test-user', reader()).send(body).expect(403);
      expect(response.body.code).toBe('HUVUDMAN_READS_ONLY');
      expect(response.body.message ?? response.body.detail).toContain('Vimmerby kommun');
    });

    it('reads as the läsare reads', async () => {
      harness.tx['huvudmanSchool']!['findUnique']!.mockResolvedValue(null);
      await request(http()).get('/api/v1/huvudman-ownership').set('x-test-user', reader()).expect(200);
    });
  });

  describe("the huvudman's own routes", () => {
    it("are a member's at no school, and the reader's", async () => {
      harness.tx['huvudmanMember']!['findMany']!.mockResolvedValue([]);
      await request(http()).get('/api/v1/huvudman').set('x-test-user', member()).expect(200);
      await request(http()).get('/api/v1/huvudman').set('x-test-user', reader()).expect(200);
    });

    it('take no other route for a member at no school', async () => {
      await request(http()).get('/api/v1/users').set('x-test-user', member()).expect(403);
    });

    it('ask for a school by its slug, and say what the database refused', async () => {
      harness.tx.$queryRaw.mockResolvedValueOnce([{ school_id: SCHOOL_ID, school_name: 'Ekbacken' }]);
      const asked = await request(http())
        .post(`/api/v1/huvudman/${HUVUDMAN_ID}/requests`)
        .set('x-test-user', reader())
        .send({ slug: 'ekbacken' })
        .expect(201);
      expect(asked.body).toEqual({ id: SCHOOL_ID, name: 'Ekbacken' });

      harness.tx.$queryRaw.mockRejectedValueOnce(refusal('HM409', 'HUVUDMAN_SCHOOL_HAS_A_HUVUDMAN'));
      const taken = await request(http())
        .post(`/api/v1/huvudman/${HUVUDMAN_ID}/requests`)
        .set('x-test-user', member())
        .send({ slug: 'granen' })
        .expect(409);
      expect(taken.body.code).toBe('HUVUDMAN_SCHOOL_HAS_A_HUVUDMAN');

      await request(http())
        .post(`/api/v1/huvudman/${HUVUDMAN_ID}/requests`)
        .set('x-test-user', member())
        .send({ slug: 'Not A Slug!' })
        .expect(400);
    });

    it("make a key shown once, sh_ and 48 hex, of the huvudman's read scopes only", async () => {
      harness.tx['huvudmanMember']!['findFirst']!.mockResolvedValue({
        id: MEMBER_ID,
        role: 'KOMMUNADMINISTRATOR',
        huvudman: { id: HUVUDMAN_ID, name: 'Vimmerby kommun', organisationNumber: null, municipalityCode: null },
      });
      harness.tx['huvudmanApiKey']!['create']!.mockImplementation(async ({ data }: { data: { name: string; scopes: string[] } }) => ({
        id: OTHER_ID,
        name: data.name,
        scopes: data.scopes,
      }));
      const made = await request(http())
        .post(`/api/v1/huvudman/${HUVUDMAN_ID}/keys`)
        .set('x-test-user', member())
        .send({ name: 'Elevregistret', scopes: ['groups.read', 'persons.read'] })
        .expect(201);
      expect(made.body.key).toMatch(/^sh_[0-9a-f]{48}$/);
      expect(made.body.scopes).toEqual(['persons.read', 'groups.read']);
      const data = harness.tx['huvudmanApiKey']!['create']!.mock.calls[0]![0].data as { keyHash: string; createdById: string };
      expect(data.keyHash).toMatch(/^[0-9a-f]{64}$/);
      expect(data.createdById).toBe(MEMBER_ID);

      for (const scopes of [['attendances.read'], ['subscriptions.write'], ['ss12000.v1'], []]) {
        await request(http())
          .post(`/api/v1/huvudman/${HUVUDMAN_ID}/keys`)
          .set('x-test-user', member())
          .send({ name: 'Fel', scopes })
          .expect(400);
      }
    });

    it("refuse a planner the kommunadministratör's acts before anything is asked", async () => {
      harness.tx['huvudmanMember']!['findFirst']!.mockResolvedValue({
        id: MEMBER_ID,
        role: 'PLANERARE',
        huvudman: { id: HUVUDMAN_ID, name: 'Vimmerby kommun', organisationNumber: null, municipalityCode: null },
      });
      const refused = await request(http())
        .delete(`/api/v1/huvudman/${HUVUDMAN_ID}/keys/${OTHER_ID}`)
        .set('x-test-user', member())
        .expect(403);
      expect(refused.body.code).toBe('HUVUDMAN_NOT_YOURS');
      expect(harness.tx['huvudmanApiKey']!['updateMany']).not.toHaveBeenCalled();
    });

    it('keep the huvudman an active kommunadministratör', async () => {
      harness.tx['huvudmanMember']!['findFirst']!.mockResolvedValue({
        id: MEMBER_ID,
        role: 'KOMMUNADMINISTRATOR',
        huvudman: { id: HUVUDMAN_ID, name: 'Vimmerby kommun', organisationNumber: null, municipalityCode: null },
      });
      // The caller's membership, then the member changed: the one active
      // kommunadministratör, with no other.
      harness.tx['huvudmanMember']!['findFirst']!
        .mockResolvedValueOnce({
          id: MEMBER_ID,
          role: 'KOMMUNADMINISTRATOR',
          huvudman: { id: HUVUDMAN_ID, name: 'Vimmerby kommun', organisationNumber: null, municipalityCode: null },
        })
        .mockResolvedValueOnce({ role: 'KOMMUNADMINISTRATOR', isActive: true });
      harness.tx['huvudmanMember']!['updateMany']!.mockResolvedValue({ count: 1 });
      harness.tx['huvudmanMember']!['count']!.mockResolvedValue(0);
      const refused = await request(http())
        .patch(`/api/v1/huvudman/${HUVUDMAN_ID}/members/${MEMBER_ID}`)
        .set('x-test-user', member())
        .send({ isActive: false })
        .expect(409);
      expect(refused.body.code).toBe('HUVUDMAN_KEEPS_AN_ADMIN');
      // Counted without the member changed, and nothing written.
      expect(harness.tx['huvudmanMember']!['count']).toHaveBeenCalledWith({
        where: { huvudmanId: HUVUDMAN_ID, role: 'KOMMUNADMINISTRATOR', isActive: true, id: { not: MEMBER_ID } },
      });
      expect(harness.tx['huvudmanMember']!['updateMany']).not.toHaveBeenCalled();
    });

    it('let a kommunadministratör leave while another is active', async () => {
      harness.tx['huvudmanMember']!['findFirst']!
        .mockResolvedValueOnce({
          id: MEMBER_ID,
          role: 'KOMMUNADMINISTRATOR',
          huvudman: { id: HUVUDMAN_ID, name: 'Vimmerby kommun', organisationNumber: null, municipalityCode: null },
        })
        .mockResolvedValueOnce({ role: 'KOMMUNADMINISTRATOR', isActive: true });
      harness.tx['huvudmanMember']!['updateMany']!.mockResolvedValue({ count: 1 });
      harness.tx['huvudmanMember']!['count']!.mockResolvedValue(1);
      await request(http())
        .patch(`/api/v1/huvudman/${HUVUDMAN_ID}/members/${MEMBER_ID}`)
        .set('x-test-user', member())
        .send({ isActive: false })
        .expect(204);
      expect(harness.tx['huvudmanMember']!['updateMany']).toHaveBeenCalledWith({
        where: { id: MEMBER_ID, huvudmanId: HUVUDMAN_ID },
        data: { isActive: false },
      });
    });

    const admin = {
      id: MEMBER_ID,
      role: 'KOMMUNADMINISTRATOR',
      huvudman: { id: HUVUDMAN_ID, name: 'Vimmerby kommun', organisationNumber: null, municipalityCode: null },
    };
    const invite = () =>
      request(http())
        .post(`/api/v1/huvudman/${HUVUDMAN_ID}/members`)
        .set('x-test-user', member())
        .send({ email: 'Planerare@Kommun.example', firstName: 'Per', lastName: 'Planerare', role: 'PLANERARE' });

    it('invite a member by address: Supabase first, then the row and its login together, and mark it', async () => {
      // The caller's membership, no member with the address; then the
      // membership again, in the transaction that writes.
      harness.tx['huvudmanMember']!['findFirst']!.mockResolvedValueOnce(admin).mockResolvedValueOnce(null).mockResolvedValueOnce(admin);
      harness.tx['huvudmanMember']!['create']!.mockResolvedValue({ id: OTHER_ID });
      const order: string[] = [];
      harness.supabase.inviteUser.mockImplementationOnce(async () => {
        order.push('invite');
        return { authId: '11111111-1111-4111-8111-111111111111', emailSent: true };
      });
      harness.tx['huvudmanMember']!['create']!.mockImplementationOnce(async () => {
        order.push('create');
        return { id: OTHER_ID };
      });
      const invited = await invite().expect(201);
      expect(invited.body).toEqual({ id: OTHER_ID, emailSent: true });
      expect(order).toEqual(['invite', 'create']);
      expect(harness.supabase.inviteUser).toHaveBeenCalledWith('planerare@kommun.example', `huvudman:${HUVUDMAN_ID}`);
      const handed = harness.tx.$executeRaw.mock.calls.map((call) => JSON.stringify(call[0]));
      expect(handed.some((sql) => sql.includes('app.huvudman_member_takes_login'))).toBe(true);
      expect(harness.supabase.markHuvudman).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
    });

    it('leave no member behind when Supabase does not answer', async () => {
      harness.tx['huvudmanMember']!['findFirst']!.mockResolvedValueOnce(admin).mockResolvedValueOnce(null);
      harness.supabase.inviteUser.mockRejectedValueOnce(new Error('Supabase invite failed: 429'));
      await invite().expect(500);
      expect(harness.tx['huvudmanMember']!['create']).not.toHaveBeenCalled();
    });

    it('refuse a login that is already a member as the 409 it is, in the transaction that would have made the row', async () => {
      harness.tx['huvudmanMember']!['findFirst']!.mockResolvedValueOnce(admin).mockResolvedValueOnce(null).mockResolvedValueOnce(admin);
      harness.tx['huvudmanMember']!['create']!.mockResolvedValue({ id: OTHER_ID });
      harness.tx.$executeRaw.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('duplicate key value violates unique constraint', {
          code: 'P2010',
          clientVersion: 'test',
          meta: { driverAdapterError: { cause: { originalCode: '23505', originalMessage: 'duplicate key' } } },
        }),
      );
      const refused = await invite().expect(409);
      expect(refused.body.code).toBe('HUVUDMAN_MEMBER_EXISTS');
      expect(harness.supabase.markHuvudman).not.toHaveBeenCalled();
    });

    it('ask Supabase again for a member an earlier invitation left without a login, and mark a refused one with a login', async () => {
      harness.tx['huvudmanMember']!['findFirst']!
        .mockResolvedValueOnce(admin)
        .mockResolvedValueOnce({ id: OTHER_ID, authId: null })
        .mockResolvedValueOnce(admin);
      const again = await invite().expect(201);
      expect(again.body).toEqual({ id: OTHER_ID, emailSent: true });
      expect(harness.tx['huvudmanMember']!['create']).not.toHaveBeenCalled();
      expect(harness.supabase.inviteUser).toHaveBeenCalledWith('planerare@kommun.example', OTHER_ID);

      harness.supabase.markHuvudman.mockClear();
      harness.tx['huvudmanMember']!['findFirst']!
        .mockResolvedValueOnce(admin)
        .mockResolvedValueOnce({ id: OTHER_ID, authId: '22222222-2222-4222-8222-222222222222' });
      const refused = await invite().expect(409);
      expect(refused.body.code).toBe('HUVUDMAN_MEMBER_EXISTS');
      // A login whose mark was lost gets it back here.
      expect(harness.supabase.markHuvudman).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222');
    });

    it("mark a member's login on its read of the huvudman when the token lacks the mark, and only then", async () => {
      harness.tx['huvudmanMember']!['findMany']!.mockResolvedValue([
        { id: MEMBER_ID, role: 'PLANERARE', huvudman: { id: HUVUDMAN_ID, name: 'Vimmerby kommun', organisationNumber: null, municipalityCode: null } },
      ]);
      const unmarked = JSON.stringify({ authId: '11111111-1111-4111-8111-111111111111', role: 'HUVUDMAN', huvudmanMarked: false });
      await request(http()).get('/api/v1/huvudman').set('x-test-user', unmarked).expect(200);
      expect(harness.supabase.markHuvudman).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
      harness.supabase.markHuvudman.mockClear();
      const marked = JSON.stringify({ authId: '11111111-1111-4111-8111-111111111111', role: 'HUVUDMAN', huvudmanMarked: true });
      await request(http()).get('/api/v1/huvudman').set('x-test-user', marked).expect(200);
      expect(harness.supabase.markHuvudman).not.toHaveBeenCalled();
    });

    it('refuse a name of spaces alone as the 400 it is', async () => {
      harness.tx['huvudmanMember']!['findFirst']!.mockResolvedValue({
        id: MEMBER_ID,
        role: 'KOMMUNADMINISTRATOR',
        huvudman: { id: HUVUDMAN_ID, name: 'Vimmerby kommun', organisationNumber: null, municipalityCode: null },
      });
      await request(http())
        .post(`/api/v1/huvudman/${HUVUDMAN_ID}/keys`)
        .set('x-test-user', member())
        .send({ name: '   ', scopes: ['persons.read'] })
        .expect(400);
      await request(http())
        .post(`/api/v1/huvudman/${HUVUDMAN_ID}/members`)
        .set('x-test-user', member())
        .send({ email: 'x@kommun.example', firstName: ' ', lastName: 'P', role: 'PLANERARE' })
        .expect(400);
    });
  });

  describe("the school's view of its huvudman", () => {
    it("shows the huvudman's keys to the school's deciders and keys: null to any other administrator", async () => {
      harness.tx['huvudmanSchool']!['findUnique']!.mockResolvedValue(null);
      harness.tx['huvudmanSchoolRequest']!['findMany']!.mockResolvedValue([]);
      const key = { key_id: OTHER_ID, name: 'Elevregistret', scopes: ['persons.read'], created_at: new Date('2026-10-01T08:00:00Z'), last_used_at: null, revoked_at: null };
      harness.tx.$queryRaw.mockImplementation(async (statement: { strings?: readonly string[] }) =>
        (statement.strings ?? []).join('?').includes('app.school_huvudman_keys()') ? [key] : [],
      );
      for (const profile of ['FULL', 'REKTOR']) {
        const decider = await request(http()).get('/api/v1/huvudman-ownership').set('x-test-user', asUser({ adminProfile: profile as never })).expect(200);
        expect({ profile, keys: decider.body.keys }).toEqual({ profile, keys: [expect.objectContaining({ id: OTHER_ID, name: 'Elevregistret' })] });
      }
      // Whatever the database would answer: who does not decide reads no key
      // of the huvudman's, and is told so, not that there are none.
      for (const profile of ['SCHEMALAGGARE', 'LASARE']) {
        const other = await request(http()).get('/api/v1/huvudman-ownership').set('x-test-user', asUser({ adminProfile: profile as never })).expect(200);
        expect({ profile, keys: other.body.keys }).toEqual({ profile, keys: null });
      }
    });
  });

  describe("the school's answers", () => {
    it("are rektor's or a full administrator's", async () => {
      const refused = await request(http())
        .post(`/api/v1/huvudman-ownership/requests/${HUVUDMAN_ID}/accept`)
        .set('x-test-user', asUser({ adminProfile: 'SCHEMALAGGARE' }))
        .expect(403);
      expect(refused.body.code).toBe('DECISION_NOT_YOURS');
      await request(http())
        .post(`/api/v1/huvudman-ownership/requests/${HUVUDMAN_ID}/accept`)
        .set('x-test-user', asUser({ adminProfile: 'REKTOR' }))
        .expect(204);
    });

    it("say the database's refusal", async () => {
      harness.tx.$executeRaw.mockRejectedValueOnce(refusal('HM404', 'HUVUDMAN_REQUEST_NOT_FOUND'));
      const missing = await request(http())
        .post(`/api/v1/huvudman-ownership/requests/${HUVUDMAN_ID}/decline`)
        .set('x-test-user', asUser({}))
        .expect(404);
      expect(missing.body.code).toBe('HUVUDMAN_REQUEST_NOT_FOUND');
    });
  });
});
