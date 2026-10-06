import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import { lockingRead, rawSql, transactionsOf, type LockedTable } from '../../test/utils/locking-read';
import type { PrismaService } from '../database/prisma.service';
import type { CreateUserDto } from './dto/user.dto';
import type { SupabaseAdminService } from './supabase-admin.service';
import { UsersService } from './users.service';

/**
 * A row as Prisma returns it: only the fields the query selected. The shared
 * mock resolves whatever a spec stubs, whole, so a field the service stopped
 * selecting would still reach its output here and be undefined in production.
 */
const asSelected = (row: unknown, select?: Record<string, unknown>): unknown => {
  if (!select || row === null || typeof row !== 'object') return row;
  if (Array.isArray(row)) return row.map((item) => asSelected(item, select));
  return Object.fromEntries(
    Object.entries(select)
      .filter(([, wanted]) => Boolean(wanted))
      .map(([field, wanted]) => [
        field,
        asSelected(
          (row as Record<string, unknown>)[field],
          (wanted as { select?: Record<string, unknown> }).select,
        ),
      ]),
  );
};

const USER_ID = '66666666-6666-4666-8666-666666666666';
const AUTH_ID = '77777777-7777-4777-8777-777777777777';
const GROUP_ID = '88888888-8888-4888-8888-888888888888';
const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';

const knownError = (code: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError(`Simulated ${code}`, {
    code,
    clientVersion: Prisma.prismaVersion.client,
  });

describe('UsersService', () => {
  let service: UsersService;
  let tx: TxMock;
  let prisma: PrismaMock;
  let supabaseAdmin: {
    isConfigured: boolean;
    inviteUser: jest.Mock;
    deleteUser: jest.Mock;
  };

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    supabaseAdmin = {
      isConfigured: true,
      inviteUser: jest.fn().mockResolvedValue({ authId: AUTH_ID, emailSent: true }),
      deleteUser: jest.fn().mockResolvedValue(undefined),
    };
    service = new UsersService(
      prisma as unknown as PrismaService,
      supabaseAdmin as unknown as SupabaseAdminService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** A user row as the lookup returns it: only the columns the query selected. */
  const arrangeUser = (row: Record<string, unknown> | null) =>
    tx.user.findUnique.mockImplementation(
      ({ select }: { select?: Record<string, unknown> }) =>
        Promise.resolve(asSelected(row, select)),
    );

  const createDto = (overrides: Partial<CreateUserDto> = {}): CreateUserDto => ({
    role: UserRole.TEACHER,
    firstName: 'Anna',
    lastName: 'Svensson',
    email: 'anna@school.se',
    ...overrides,
  });

  describe('create', () => {
    it('emails nobody by default — adding a person is not contacting them', async () => {
      tx.user.create.mockResolvedValue({ id: USER_ID });
      const user = testUser();

      await expect(service.create(createDto(), user)).resolves.toEqual({
        id: USER_ID,
      });

      expect(supabaseAdmin.inviteUser).not.toHaveBeenCalled();
      // Tenancy: the write must run under withRls with the acting principal.
      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));

      const { data } = tx.user.create.mock.calls[0][0] as {
        data: { authId: string; invitedAt: Date | null };
      };
      expect(data).toMatchObject({
        schoolId: SCHOOL_ID,
        role: UserRole.TEACHER,
        email: 'anna@school.se',
        invitedAt: null,
      });
      // A placeholder identity: a real uuid, matching no Supabase user, so
      // auth.uid() resolves to nothing and this person cannot sign in.
      expect(data.authId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(data.authId).not.toBe(AUTH_ID);
    });

    it('persists first and invites second, then adopts the identity', async () => {
      tx.user.create.mockResolvedValue({ id: USER_ID, email: 'anna@school.se' });
      tx.user.update.mockResolvedValue({ id: USER_ID, authId: AUTH_ID });

      await expect(
        service.create(createDto({ sendInvitation: true }), testUser()),
      ).resolves.toEqual({ id: USER_ID, authId: AUTH_ID });

      // Order is the whole point: nothing may be emailed before the row that
      // makes the invitation meaningful exists.
      expect(tx.user.create.mock.invocationCallOrder[0]).toBeLessThan(
        supabaseAdmin.inviteUser.mock.invocationCallOrder[0],
      );
      expect(supabaseAdmin.inviteUser).toHaveBeenCalledWith('anna@school.se');

      const { data } = tx.user.create.mock.calls[0][0] as {
        data: { authId: string; invitedAt: Date | null };
      };
      expect(data.authId).not.toBe(AUTH_ID);
      expect(data.invitedAt).toBeNull();

      const args = tx.user.update.mock.calls[0][0] as {
        where: { id: string };
        data: { authId: string; invitedAt: Date };
      };
      expect(args.where).toEqual({ id: USER_ID });
      expect(args.data.authId).toBe(AUTH_ID);
      expect(args.data.invitedAt).toBeInstanceOf(Date);
    });

    it('invites nobody when the row itself is rejected', async () => {
      // The identity and the email are unrecallable side effects. A duplicate
      // email must not leave a stranger holding a set-password link for an
      // account that was never created.
      tx.user.create.mockRejectedValue(knownError('P2002'));

      await expect(
        service.create(createDto({ sendInvitation: true }), testUser()),
      ).rejects.toThrow(ConflictException);

      expect(supabaseAdmin.inviteUser).not.toHaveBeenCalled();
      expect(supabaseAdmin.deleteUser).not.toHaveBeenCalled();
    });

    it('keeps both row and identity when the link write fails, so a retry heals it', async () => {
      // The email is already gone; deleting the identity would kill the link
      // the person is holding, and it may not even be ours to delete.
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      tx.user.create.mockResolvedValue({ id: USER_ID, email: 'anna@school.se' });
      tx.user.update.mockRejectedValue(knownError('P2025'));

      await expect(
        service.create(createDto({ sendInvitation: true }), testUser()),
      ).rejects.toThrow(NotFoundException);

      expect(supabaseAdmin.deleteUser).not.toHaveBeenCalled();
      expect(tx.user.delete).not.toHaveBeenCalled();
    });

    it('persists the tenant from the principal, never from the payload', async () => {
      tx.user.create.mockResolvedValue({ id: USER_ID });

      await service.create(createDto(), testUser({ schoolId: 'school-A' }));

      expect(tx.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ schoolId: 'school-A' }),
        }),
      );
    });

    it('stores the phone number it was given', async () => {
      tx.user.create.mockResolvedValue({ id: USER_ID });

      await service.create(createDto({ phone: '+46701234567' }), testUser());

      expect(tx.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ phone: '+46701234567' }),
        }),
      );
    });

    it('keeps the student group for a STUDENT', async () => {
      tx.user.create.mockResolvedValue({ id: USER_ID });

      await service.create(
        createDto({ role: UserRole.STUDENT, studentGroupId: GROUP_ID }),
        testUser(),
      );

      expect(tx.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            role: UserRole.STUDENT,
            studentGroupId: GROUP_ID,
          }),
        }),
      );
    });

    it('rejects a group assignment for a non-student before touching anything', async () => {
      await expect(
        service.create(createDto({ studentGroupId: GROUP_ID }), testUser()),
      ).rejects.toThrow(
        new BadRequestException('Only students can be assigned to a student group.'),
      );

      expect(supabaseAdmin.inviteUser).not.toHaveBeenCalled();
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('rejects a principal with no school before inviting an identity', async () => {
      await expect(
        service.create(createDto(), testUser({ schoolId: undefined })),
      ).rejects.toThrow(ForbiddenException);

      expect(supabaseAdmin.inviteUser).not.toHaveBeenCalled();
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('maps an invite failure to 503 and takes the new row back', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      tx.user.create.mockResolvedValue({ id: USER_ID, email: 'anna@school.se' });
      supabaseAdmin.inviteUser.mockRejectedValue(new Error('gotrue down'));

      await expect(
        service.create(createDto({ sendInvitation: true }), testUser()),
      ).rejects.toThrow(
        // Says what to do, and nothing of what GoTrue said.
        new ServiceUnavailableException(
          'Could not send the invitation email. Please try again.',
        ),
      );

      // Nothing was sent, so "create and invite" keeps its all-or-nothing
      // promise — and the row we drop is our own, seconds old, with a
      // placeholder identity that was never registered anywhere.
      expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: USER_ID } });
      expect(supabaseAdmin.deleteUser).not.toHaveBeenCalled();
    });

    it('still reports the invitation failure when the row cannot be taken back', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      tx.user.create.mockResolvedValue({ id: USER_ID, email: 'anna@school.se' });
      supabaseAdmin.inviteUser.mockRejectedValue(new Error('gotrue down'));
      tx.user.delete.mockRejectedValue(knownError('P2025'));

      await expect(
        service.create(createDto({ sendInvitation: true }), testUser()),
      ).rejects.toThrow(ServiceUnavailableException);

      expect(warn).toHaveBeenCalled();
    });

    it('refuses an explicit invitation when Supabase is not configured', async () => {
      // Silently creating the row instead would tell the admin an invitation
      // went out when the deployment cannot send one at all.
      supabaseAdmin.isConfigured = false;

      await expect(
        service.create(createDto({ sendInvitation: true }), testUser()),
      ).rejects.toThrow(
        new ServiceUnavailableException(
          'Invitations are not configured for this deployment.',
        ),
      );

      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('still creates people without invitations when Supabase is absent', async () => {
      supabaseAdmin.isConfigured = false;
      tx.user.create.mockResolvedValue({ id: USER_ID });

      await service.create(createDto(), testUser());

      expect(tx.user.create).toHaveBeenCalled();
      expect(supabaseAdmin.inviteUser).not.toHaveBeenCalled();
    });

    it('maps a duplicate email (P2002) to 409', async () => {
      tx.user.create.mockRejectedValue(knownError('P2002'));

      await expect(service.create(createDto(), testUser())).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('invite', () => {
    const target = (overrides: Record<string, unknown> = {}) => ({
      id: USER_ID,
      email: 'anna@school.se',
      isActive: true,
      ...overrides,
    });

    it('adopts the real identity, replacing the placeholder that blocked sign-in', async () => {
      arrangeUser(target());
      tx.user.update.mockResolvedValue({ id: USER_ID });

      await expect(service.invite(USER_ID, testUser())).resolves.toEqual({
        id: USER_ID,
        emailSent: true,
      });

      expect(tx.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: USER_ID } }),
      );
      expect(supabaseAdmin.inviteUser).toHaveBeenCalledWith('anna@school.se');
      const args = tx.user.update.mock.calls[0][0] as {
        where: { id: string };
        data: { authId: string; invitedAt: Date };
      };
      expect(args.where).toEqual({ id: USER_ID });
      expect(args.data.authId).toBe(AUTH_ID);
      expect(args.data.invitedAt).toBeInstanceOf(Date);
    });

    it('reports honestly when the address already had an identity', async () => {
      // No email leaves GoTrue in this case; claiming one did would send the
      // admin waiting for a message that is never coming.
      arrangeUser(target());
      tx.user.update.mockResolvedValue({ id: USER_ID });
      supabaseAdmin.inviteUser.mockResolvedValue({
        authId: AUTH_ID,
        emailSent: false,
      });

      await expect(service.invite(USER_ID, testUser())).resolves.toEqual({
        id: USER_ID,
        emailSent: false,
      });
    });

    it('404s an id the caller cannot see', async () => {
      arrangeUser(null);

      await expect(service.invite(USER_ID, testUser())).rejects.toThrow(
        new NotFoundException('The requested record does not exist.'),
      );
      expect(supabaseAdmin.inviteUser).not.toHaveBeenCalled();
    });

    it('refuses to invite a deactivated person', async () => {
      arrangeUser(target({ isActive: false }));

      await expect(service.invite(USER_ID, testUser())).rejects.toThrow(
        new BadRequestException(
          'Inactive people cannot be invited. Reactivate them first.',
        ),
      );
      expect(supabaseAdmin.inviteUser).not.toHaveBeenCalled();
    });

    it('leaves the row untouched when the provider fails', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      arrangeUser(target());
      supabaseAdmin.inviteUser.mockRejectedValue(new Error('gotrue down'));

      await expect(service.invite(USER_ID, testUser())).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(tx.user.update).not.toHaveBeenCalled();
    });

    it('maps a row that vanished mid-invitation to 404, not a raw Prisma error', async () => {
      // The identity survives on purpose: the invitation link is already in
      // the person's inbox, and re-inviting adopts the same identity again.
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      arrangeUser(target());
      tx.user.update.mockRejectedValue(knownError('P2025'));

      await expect(service.invite(USER_ID, testUser())).rejects.toThrow(
        NotFoundException,
      );
      expect(supabaseAdmin.deleteUser).not.toHaveBeenCalled();
    });

    it('503s before any lookup when invitations are not configured', async () => {
      supabaseAdmin.isConfigured = false;

      await expect(service.invite(USER_ID, testUser())).rejects.toThrow(
        new ServiceUnavailableException(
          'Invitations are not configured for this deployment.',
        ),
      );
      expect(prisma.withRls).not.toHaveBeenCalled();
    });
  });

  describe('inviteMany', () => {
    const ids = ['id-1', 'id-2', 'id-3'];

    beforeEach(() => {
      tx.user.update.mockResolvedValue({ id: USER_ID });
    });

    it('counts sent and already-registered separately', async () => {
      arrangeUser({
        id: USER_ID,
        email: 'anna@school.se',
        isActive: true,
      });
      supabaseAdmin.inviteUser
        .mockResolvedValueOnce({ authId: AUTH_ID, emailSent: true })
        .mockResolvedValueOnce({ authId: AUTH_ID, emailSent: false })
        .mockResolvedValueOnce({ authId: AUTH_ID, emailSent: true });

      await expect(service.inviteMany(ids, testUser())).resolves.toEqual({
        sent: 2,
        alreadyRegistered: 1,
        errors: [],
      });
    });

    it('keeps going after a failure and names who it was', async () => {
      // Each invitation is an external side effect no transaction can undo,
      // so one bad address must not discard the invitations already sent.
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      arrangeUser({
        id: USER_ID,
        email: 'anna@school.se',
        isActive: true,
      });
      supabaseAdmin.inviteUser
        .mockResolvedValueOnce({ authId: AUTH_ID, emailSent: true })
        .mockRejectedValueOnce(new Error('gotrue down'))
        .mockResolvedValueOnce({ authId: AUTH_ID, emailSent: true });

      const report = await service.inviteMany(ids, testUser());

      expect(report.sent).toBe(2);
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0]?.userId).toBe('id-2');
    });

    it('reports a deactivated person as an error rather than skipping silently', async () => {
      arrangeUser({
        id: USER_ID,
        email: 'anna@school.se',
        isActive: false,
      });

      const report = await service.inviteMany(['id-1'], testUser());

      expect(report).toMatchObject({ sent: 0, alreadyRegistered: 0 });
      expect(report.errors).toHaveLength(1);
    });
  });

  describe('update', () => {
    const USERS: LockedTable = {
      name: 'Users',
      columns: [
        'id', 'schoolId', 'authId', 'role', 'firstName', 'lastName', 'email',
        'phone', 'isActive', 'invitedAt', 'createdAt', 'updatedAt', 'studentGroupId',
      ],
      lock: 'FOR NO KEY UPDATE',
    };
    /** The rows update()'s locking read can find. */
    let users: Record<string, unknown>[];
    /** The locking read of the stored role and group. */
    let queryRaw: jest.Mock;

    /** The row as stored, found by its own id and by nothing else; null stores none. */
    const storeUser = (row: Record<string, unknown> | null) => {
      users = row === null ? [] : [{ id: USER_ID, ...row }];
    };

    beforeEach(() => {
      // The auto-vivifying mock would hand back a model proxy for `$queryRaw`,
      // and a proxy is not callable. It answers as the table would, from the
      // row a test stored.
      queryRaw = jest.fn((...call: unknown[]) =>
        Promise.resolve(lockingRead(USERS, users, call)),
      );
      Object.assign(tx, { $queryRaw: queryRaw });
      // Every patch is judged against the row it lands on, so the stored role
      // and group have to exist for any of these to reach the write at all.
      storeUser({
        role: UserRole.STUDENT,
        studentGroupId: null,
      });
    });

    it('updates only the provided fields, under the caller RLS context', async () => {
      tx.user.update.mockResolvedValue({ id: USER_ID });
      const user = testUser();

      await expect(
        service.update(USER_ID, { firstName: 'Maja' }, user),
      ).resolves.toEqual({ id: USER_ID });

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { firstName: 'Maja' },
      });
    });

    // Against a student with no group, a PATCH making them a teacher and one
    // putting them in a class would each pass on a row read without a lock, and
    // together try to store a teacher in the class, a row
    // app.current_user_group_id() reads without asking the role. The CHECK on
    // Users refuses it only as a 500. withRls runs READ COMMITTED, so only a
    // lock makes the second PATCH wait for the first and be judged, with a
    // 400, against what it wrote.
    it('reads the row it merges against under a lock, in the transaction that writes it', async () => {
      tx.user.update.mockResolvedValue({ id: USER_ID });
      const ranIn = transactionsOf(prisma);
      const readIn = ranIn(queryRaw);
      const writtenIn = ranIn(tx.user.update);

      await service.update(USER_ID, { studentGroupId: GROUP_ID }, testUser());

      // A lock lasts as long as the transaction that took it, so the read and
      // the write have to share one, and it has to be withRls's, the one
      // interactive transaction under the caller's claims.
      expect(readIn).toEqual([expect.stringMatching(/^withRls#\d+$/)]);
      expect(writtenIn).toEqual(readIn);
      const [call] = queryRaw.mock.calls;
      expect(rawSql(call)).toMatch(
        /SELECT "role", "studentGroupId"\s+FROM "Users"\s+WHERE "id" = \?::uuid\s+FOR NO KEY UPDATE/,
      );
      expect(call.slice(1)).toEqual([USER_ID]);
      expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.user.update.mock.invocationCallOrder[0],
      );
    });

    it('passes an explicit null through to clear a field', async () => {
      tx.user.update.mockResolvedValue({ id: USER_ID });

      await service.update(USER_ID, { phone: null }, testUser());

      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { phone: null },
      });
    });

    it('maps a full update including deactivation', async () => {
      tx.user.update.mockResolvedValue({ id: USER_ID });

      await service.update(
        USER_ID,
        {
          role: UserRole.STUDENT,
          firstName: 'Maja',
          lastName: 'Karlsson',
          phone: '+46701234567',
          studentGroupId: GROUP_ID,
          isActive: false,
        },
        testUser(),
      );

      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: {
          role: UserRole.STUDENT,
          firstName: 'Maja',
          lastName: 'Karlsson',
          phone: '+46701234567',
          studentGroupId: GROUP_ID,
          isActive: false,
        },
      });
    });

    it('rejects assigning a group while switching to a non-student role', async () => {
      await expect(
        service.update(
          USER_ID,
          { role: UserRole.TEACHER, studentGroupId: GROUP_ID },
          testUser(),
        ),
      ).rejects.toThrow(
        new BadRequestException('Only students can be assigned to a student group.'),
      );

      expect(tx.user.update).not.toHaveBeenCalled();
    });

    it('rejects a group change that names no role, against the stored role', async () => {
      // The patch alone looks innocent. app.current_user_group_id() does not
      // read roles, so a teacher left sitting in a student group is handed the
      // students' view of that group's lessons.
      storeUser({
        role: UserRole.TEACHER,
        studentGroupId: null,
      });

      await expect(
        service.update(USER_ID, { studentGroupId: GROUP_ID }, testUser()),
      ).rejects.toThrow(BadRequestException);

      expect(tx.user.update).not.toHaveBeenCalled();
    });

    it('rejects a role change that would leave a group behind', async () => {
      // The other door to the same row: the group is already stored, and the
      // patch only moves the person out of being a student.
      storeUser({
        role: UserRole.STUDENT,
        studentGroupId: GROUP_ID,
      });

      await expect(
        service.update(USER_ID, { role: UserRole.GUARDIAN }, testUser()),
      ).rejects.toThrow(BadRequestException);

      expect(tx.user.update).not.toHaveBeenCalled();
    });

    it('allows that same role change when the patch clears the group with it', async () => {
      // The control: the rule is about the merged row, so the legitimate
      // "this person is staff now" edit must still go through.
      storeUser({
        role: UserRole.STUDENT,
        studentGroupId: GROUP_ID,
      });
      tx.user.update.mockResolvedValue({ id: USER_ID });

      await service.update(
        USER_ID,
        { role: UserRole.GUARDIAN, studentGroupId: null },
        testUser(),
      );

      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { role: UserRole.GUARDIAN, studentGroupId: null },
      });
    });

    it('allows a group change on a row the database says is a student', async () => {
      // The other control: moving a student between classes is the everyday
      // edit and must not need a role in the body.
      tx.user.update.mockResolvedValue({ id: USER_ID });

      await service.update(USER_ID, { studentGroupId: GROUP_ID }, testUser());

      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { studentGroupId: GROUP_ID },
      });
    });

    it('refuses to make a teacher a pupil while their post or behörighet stands, naming both', async () => {
      // The other half of src/staffing/staff-lock.ts: the staffing writes
      // check the role under the Users lock, and this is what stops the role
      // from leaving afterwards with the rows still there.
      storeUser({ role: UserRole.TEACHER, studentGroupId: null });
      tx.teacherEmployment.count.mockResolvedValue(1);
      tx.teacherSubjectQualification.count.mockResolvedValue(3);

      await expect(
        service.update(USER_ID, { role: UserRole.STUDENT }, testUser()),
      ).rejects.toThrow(
        new ConflictException(
          'Personen kan inte bli elev: 1 tjänst och 3 behörigheter finns registrerade. Ta bort dem under Personer först.',
        ),
      );

      // Counted in the transaction that holds the lock, by the row's own id.
      expect(tx.teacherEmployment.count).toHaveBeenCalledWith({ where: { userId: USER_ID } });
      expect(tx.teacherSubjectQualification.count).toHaveBeenCalledWith({
        where: { userId: USER_ID },
      });
      expect(tx.user.update).not.toHaveBeenCalled();
    });

    it('counts uppdrag too, and lists all three kinds when all three stand', async () => {
      // A pupil who is still mentor for 7B would be a row in the matrix, and
      // their rastvakt slot an UNAVAILABLE block on a pupil.
      storeUser({ role: UserRole.TEACHER, studentGroupId: null });
      tx.teacherEmployment.count.mockResolvedValue(1);
      tx.teacherSubjectQualification.count.mockResolvedValue(2);
      tx.teacherDuty.count.mockResolvedValue(3);

      await expect(
        service.update(USER_ID, { role: UserRole.STUDENT }, testUser()),
      ).rejects.toThrow(
        new ConflictException(
          'Personen kan inte bli elev: 1 tjänst, 2 behörigheter och 3 uppdrag finns registrerade. Ta bort dem under Personer först.',
        ),
      );
      expect(tx.teacherDuty.count).toHaveBeenCalledWith({ where: { userId: USER_ID } });
      expect(tx.user.update).not.toHaveBeenCalled();
    });

    it('refuses a demotion on uppdrag alone', async () => {
      storeUser({ role: UserRole.TEACHER, studentGroupId: null });
      tx.teacherEmployment.count.mockResolvedValue(0);
      tx.teacherSubjectQualification.count.mockResolvedValue(0);
      tx.teacherDuty.count.mockResolvedValue(1);

      await expect(
        service.update(USER_ID, { role: UserRole.GUARDIAN }, testUser()),
      ).rejects.toThrow(
        new ConflictException(
          'Personen kan inte bli vårdnadshavare: 1 uppdrag finns registrerade. Ta bort dem under Personer först.',
        ),
      );
      expect(tx.user.update).not.toHaveBeenCalled();
    });

    it('names only the rows that exist when a rektor becomes a guardian', async () => {
      storeUser({ role: UserRole.SCHOOL_ADMIN, studentGroupId: null });
      tx.teacherEmployment.count.mockResolvedValue(0);
      tx.teacherSubjectQualification.count.mockResolvedValue(1);

      await expect(
        service.update(USER_ID, { role: UserRole.GUARDIAN }, testUser()),
      ).rejects.toThrow(
        new ConflictException(
          'Personen kan inte bli vårdnadshavare: 1 behörighet finns registrerade. Ta bort dem under Personer först.',
        ),
      );
      expect(tx.user.update).not.toHaveBeenCalled();
    });

    it('lets a teacher become a pupil once nothing is registered, and staff stay staff unasked', async () => {
      // The control: with no rows the demotion goes through; and a change
      // between the two staff roles never counts anything, since a teaching
      // rektor keeps their post.
      storeUser({ role: UserRole.TEACHER, studentGroupId: null });
      tx.teacherEmployment.count.mockResolvedValue(0);
      tx.teacherSubjectQualification.count.mockResolvedValue(0);
      tx.user.update.mockResolvedValue({ id: USER_ID });

      await service.update(USER_ID, { role: UserRole.STUDENT }, testUser());
      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { role: UserRole.STUDENT },
      });

      tx.teacherEmployment.count.mockClear();
      tx.teacherEmployment.count.mockResolvedValue(1);
      await service.update(USER_ID, { role: UserRole.SCHOOL_ADMIN }, testUser());
      expect(tx.teacherEmployment.count).not.toHaveBeenCalled();
      expect(tx.user.update).toHaveBeenLastCalledWith({
        where: { id: USER_ID },
        data: { role: UserRole.SCHOOL_ADMIN },
      });
    });

    it('404s an id the caller cannot see before validating anything', async () => {
      storeUser(null);

      await expect(
        service.update(USER_ID, { studentGroupId: GROUP_ID }, testUser()),
      ).rejects.toThrow(new NotFoundException('The requested record does not exist.'));

      expect(tx.user.update).not.toHaveBeenCalled();
    });

    it('maps P2025 to 404 — unknown id and cross-tenant rows look identical', async () => {
      tx.user.update.mockRejectedValue(knownError('P2025'));

      await expect(
        service.update(USER_ID, { firstName: 'X' }, testUser()),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('deletes the tenant row, then the Supabase identity, in the caller RLS context', async () => {
      tx.user.findUnique.mockResolvedValue({
        authId: AUTH_ID,
        invitedAt: new Date('2026-08-01T00:00:00.000Z'),
      });
      tx.user.delete.mockResolvedValue({ id: USER_ID });
      const user = testUser();

      await expect(service.remove(USER_ID, user)).resolves.toBeUndefined();

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.user.findUnique).toHaveBeenCalledWith({
        where: { id: USER_ID },
        select: { authId: true, invitedAt: true },
      });
      expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: USER_ID } });
      expect(supabaseAdmin.deleteUser).toHaveBeenCalledWith(AUTH_ID);
    });

    it('asks the provider for nothing when the person was never invited', async () => {
      // `authId` is a placeholder uuid written at create time that matches
      // nothing at the provider. Asking it to delete one logged a warning that
      // read like a failure — on most removals, while a school is still
      // building its catalog and few people have been contacted.
      tx.user.findUnique.mockResolvedValue({ authId: AUTH_ID, invitedAt: null });
      tx.user.delete.mockResolvedValue({ id: USER_ID });

      await expect(service.remove(USER_ID, testUser())).resolves.toBeUndefined();

      expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: USER_ID } });
      expect(supabaseAdmin.deleteUser).not.toHaveBeenCalled();
    });

    it('404s on an unknown (or other-tenant) user without touching Supabase', async () => {
      tx.user.findUnique.mockResolvedValue(null);

      await expect(service.remove(USER_ID, testUser())).rejects.toThrow(
        new NotFoundException('The requested record does not exist.'),
      );

      expect(tx.user.delete).not.toHaveBeenCalled();
      expect(supabaseAdmin.deleteUser).not.toHaveBeenCalled();
    });

    it('409s removing the person a decided timplan names as its decider, naming the plan', async () => {
      tx.user.findUnique.mockResolvedValue({ authId: AUTH_ID, invitedAt: null });
      tx.localTimplan.findMany.mockResolvedValue([{ name: 'Grundskolan 2024' }]);

      const error = await service.remove(USER_ID, testUser()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).message).toContain(
        'den beslutade lokala timplanen "Grundskolan 2024"',
      );
      expect((error as ConflictException).message).toContain('Inaktivera kontot i stället');
      expect(tx.localTimplan.findMany).toHaveBeenCalledWith({
        where: { decidedByUserId: USER_ID },
        select: { name: true },
        orderBy: { name: 'asc' },
      });
      expect(tx.user.delete).not.toHaveBeenCalled();
      expect(supabaseAdmin.deleteUser).not.toHaveBeenCalled();
    });

    it('says the same when the restrict key refuses a decision recorded after the question', async () => {
      tx.user.findUnique.mockResolvedValue({ authId: AUTH_ID, invitedAt: null });
      tx.user.delete.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Foreign key constraint violated', {
          code: 'P2003',
          clientVersion: Prisma.prismaVersion.client,
          meta: {
            modelName: 'User',
            driverAdapterError: {
              cause: { constraint: { index: 'LocalTimplans_decidedByUserId_schoolId_fkey' } },
            },
          },
        }),
      );

      await expect(service.remove(USER_ID, testUser())).rejects.toThrow(
        'Inaktivera kontot i stället',
      );
    });

    it('maps a P2025 race on the delete itself to 404', async () => {
      tx.user.findUnique.mockResolvedValue({ authId: AUTH_ID });
      tx.user.delete.mockRejectedValue(knownError('P2025'));

      await expect(service.remove(USER_ID, testUser())).rejects.toThrow(
        NotFoundException,
      );

      expect(supabaseAdmin.deleteUser).not.toHaveBeenCalled();
    });

    it('still succeeds when the identity cleanup fails (best effort)', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      tx.user.findUnique.mockResolvedValue({ authId: AUTH_ID });
      tx.user.delete.mockResolvedValue({ id: USER_ID });
      supabaseAdmin.deleteUser.mockRejectedValue(new Error('gotrue down'));

      await expect(service.remove(USER_ID, testUser())).resolves.toBeUndefined();
    });

    it('skips the identity cleanup when the row has no linked identity', async () => {
      tx.user.findUnique.mockResolvedValue({ authId: null });
      tx.user.delete.mockResolvedValue({ id: USER_ID });

      await expect(service.remove(USER_ID, testUser())).resolves.toBeUndefined();

      expect(supabaseAdmin.deleteUser).not.toHaveBeenCalled();
    });
  });
});
