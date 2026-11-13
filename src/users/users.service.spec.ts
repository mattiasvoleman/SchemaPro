import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  ValidationPipe,
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
import { recordedReads } from '../../test/utils/recorded-reads';
import { BULK_TIMEOUT_MS } from '../common/bulk';
import type { PrismaService } from '../database/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { UpdateUserDto, type CreateUserDto } from './dto/user.dto';
import { UserLookupError, type SupabaseAdminService } from './supabase-admin.service';
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
    resendInvitation: jest.Mock;
    changeUserEmail: jest.Mock;
    deleteUser: jest.Mock;
    deleteOwnedUser: jest.Mock;
    markSeveralSchools: jest.Mock;
  };

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    supabaseAdmin = {
      isConfigured: true,
      inviteUser: jest.fn().mockResolvedValue({ authId: AUTH_ID, emailSent: true }),
      resendInvitation: jest.fn().mockResolvedValue(undefined),
      changeUserEmail: jest.fn().mockResolvedValue({ outcome: 'unchanged', confirmed: true }),
      deleteUser: jest.fn().mockResolvedValue(undefined),
      deleteOwnedUser: jest.fn().mockResolvedValue('deleted'),
      markSeveralSchools: jest.fn().mockResolvedValue(undefined),
    };
    service = new UsersService(
      prisma as unknown as PrismaService,
      supabaseAdmin as unknown as SupabaseAdminService,
    );
    answerHeldElsewhere(false);
  });

  /**
   * How app.login_is_held_elsewhere answers (Flera skolor per inloggning):
   * whether another school's row holds the login. Every other raw statement
   * answers as the shared mock does.
   */
  const answerHeldElsewhere = (held: boolean | 'fails') =>
    tx.$queryRaw.mockImplementation((...call: unknown[]) => {
      if (!rawSql(call).includes('app.login_is_held_elsewhere')) return Promise.resolve([]);
      return held === 'fails' ? Promise.reject(new Error('connection reset')) : Promise.resolve([{ held }]);
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
      // The answer is what the admin just typed: no read to record.
      expect(recordedReads(tx)).toEqual([]);
    });

    it('marks the login when the person it invites has it from another school', async () => {
      tx.user.create.mockResolvedValue({ id: USER_ID, email: 'anna@school.se' });
      tx.user.update.mockResolvedValue({ id: USER_ID, authId: AUTH_ID });
      answerHeldElsewhere(true);

      await service.create(createDto({ sendInvitation: true }), testUser());

      expect(supabaseAdmin.markSeveralSchools).toHaveBeenCalledWith(AUTH_ID);
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
      expect(supabaseAdmin.inviteUser).toHaveBeenCalledWith('anna@school.se', USER_ID);

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

    it('refuses a teaching group as a new pupil’s home class', async () => {
      tx.studentGroup.findUnique.mockResolvedValue({ kind: 'TEACHING_GROUP' });
      await expect(
        service.create(createDto({ role: UserRole.STUDENT, studentGroupId: GROUP_ID }), testUser()),
      ).rejects.toMatchObject({ response: { code: 'STUDENT_HOME_GROUP_NOT_A_CLASS' } });
      expect(tx.user.create).not.toHaveBeenCalled();
      expect(supabaseAdmin.inviteUser).not.toHaveBeenCalled();
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
    /** Somebody added and never invited: the placeholder create() wrote. */
    const target = (overrides: Record<string, unknown> = {}) => ({
      id: USER_ID,
      email: 'anna@school.se',
      isActive: true,
      authId: '55555555-5555-4555-8555-555555555555',
      invitedAt: null,
      ...overrides,
    });

    it('adopts the real identity, replacing the placeholder that blocked sign-in', async () => {
      arrangeUser(target());
      tx.user.update.mockResolvedValue({ id: USER_ID });

      await expect(service.invite(USER_ID, testUser())).resolves.toEqual({
        id: USER_ID,
        emailSent: true,
        loginMoved: false,
        sharedLogin: false,
      });

      expect(tx.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: USER_ID } }),
      );
      expect(supabaseAdmin.inviteUser).toHaveBeenCalledWith('anna@school.se', USER_ID);
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
        loginMoved: false,
        sharedLogin: false,
      });
    });

    it('names the row in app.login_join before it gives the row the login, in the same transaction', async () => {
      // The one writer that may give a row a login another school's row
      // holds (trigger Users_a_login_joins_another_school_by_invitation).
      arrangeUser(target());
      tx.user.update.mockResolvedValue({ id: USER_ID });

      await service.invite(USER_ID, testUser());

      const joins = tx.$executeRaw.mock.calls.filter((call) => rawSql(call).includes("set_config('app.login_join'"));
      expect(joins).toHaveLength(1);
      expect(joins[0]!.slice(1)).toEqual([USER_ID]);
      const joinOrder = tx.$executeRaw.mock.invocationCallOrder[tx.$executeRaw.mock.calls.indexOf(joins[0]!)]!;
      expect(joinOrder).toBeLessThan(tx.user.update.mock.invocationCallOrder[0]!);
    });

    it('says when the login it adopted is another school\'s too', async () => {
      arrangeUser(target());
      tx.user.update.mockResolvedValue({ id: USER_ID });
      supabaseAdmin.inviteUser.mockResolvedValue({ authId: AUTH_ID, emailSent: false });
      answerHeldElsewhere(true);

      await expect(service.invite(USER_ID, testUser())).resolves.toEqual({
        id: USER_ID,
        emailSent: false,
        loginMoved: false,
        sharedLogin: true,
      });
      const asked = tx.$queryRaw.mock.calls.find((call) => rawSql(call).includes('app.login_is_held_elsewhere'));
      expect(asked?.slice(1)).toEqual([AUTH_ID, USER_ID]);
      // Marked, after the row took it, so that the web shows the person the switcher.
      expect(supabaseAdmin.markSeveralSchools).toHaveBeenCalledWith(AUTH_ID);
      expect(supabaseAdmin.markSeveralSchools.mock.invocationCallOrder[0]).toBeGreaterThan(
        tx.user.update.mock.invocationCallOrder[0]!,
      );
    });

    it('marks no login that only this school\'s row holds', async () => {
      arrangeUser(target());
      tx.user.update.mockResolvedValue({ id: USER_ID });

      await service.invite(USER_ID, testUser());

      expect(supabaseAdmin.markSeveralSchools).not.toHaveBeenCalled();
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

    it('asks for no address change for somebody never invited: the placeholder is nobody\'s login', async () => {
      arrangeUser(target());
      tx.user.update.mockResolvedValue({ id: USER_ID });

      await service.invite(USER_ID, testUser());

      expect(supabaseAdmin.changeUserEmail).not.toHaveBeenCalled();
      expect(supabaseAdmin.deleteUser).not.toHaveBeenCalled();
      expect(supabaseAdmin.deleteOwnedUser).not.toHaveBeenCalled();
    });

    describe('somebody invited before', () => {
      // An SS12000 apply can have rewritten the row's address since
      // (PERSON_EMAIL_CHANGE_INVITED); the login then still has the old one.
      const LOGIN = '44444444-4444-4444-8444-444444444444';
      const INVITED_AT = new Date('2026-09-01T08:00:00Z');
      /** The row the login must be the own of, and since when it holds it. */
      const OWNER = { userId: USER_ID, since: INVITED_AT };
      const invited = () =>
        target({
          email: 'anna.ny@school.se',
          authId: LOGIN,
          invitedAt: INVITED_AT,
        });
      const adoptedAuthId = (): string =>
        (tx.user.update.mock.calls[0][0] as { data: { authId: string } }).data.authId;

      beforeEach(() => {
        arrangeUser(invited());
        tx.user.update.mockResolvedValue({ id: USER_ID });
      });

      it('neither moves nor deletes a login another school\'s row holds, and invites the row\'s address', async () => {
        // Flera skolor per inloggning: the login is the person's, and the
        // other school still signs them in with it.
        answerHeldElsewhere(true);
        supabaseAdmin.inviteUser.mockResolvedValue({ authId: AUTH_ID, emailSent: true });

        await expect(service.invite(USER_ID, testUser())).resolves.toEqual({
          id: USER_ID,
          emailSent: true,
          loginMoved: false,
          sharedLogin: true,
        });
        expect(supabaseAdmin.changeUserEmail).not.toHaveBeenCalled();
        expect(supabaseAdmin.deleteOwnedUser).not.toHaveBeenCalled();
        expect(supabaseAdmin.deleteUser).not.toHaveBeenCalled();
        expect(supabaseAdmin.inviteUser).toHaveBeenCalledWith('anna.ny@school.se', USER_ID);
        const asked = tx.$queryRaw.mock.calls.find((call) => rawSql(call).includes('app.login_is_held_elsewhere'));
        expect(asked?.slice(1)).toEqual([LOGIN, USER_ID]);
      });

      it('leaves the login as a shared one when it cannot ask whether it is', async () => {
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        // The question before anything is moved fails; the adoption's own
        // question afterwards is answered.
        let asked = 0;
        tx.$queryRaw.mockImplementation((...call: unknown[]) => {
          if (!rawSql(call).includes('app.login_is_held_elsewhere')) return Promise.resolve([]);
          asked += 1;
          return asked === 1 ? Promise.reject(new Error('connection reset')) : Promise.resolve([{ held: false }]);
        });

        await service.invite(USER_ID, testUser());

        expect(supabaseAdmin.changeUserEmail).not.toHaveBeenCalled();
        expect(supabaseAdmin.deleteOwnedUser).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`[authId=${LOGIN}]`));
      });

      it('moves a login that has signed in to the new address, and says nobody told the person', async () => {
        supabaseAdmin.changeUserEmail.mockResolvedValue({ outcome: 'changed', confirmed: true });

        await expect(service.invite(USER_ID, testUser())).resolves.toEqual({
          id: USER_ID,
          emailSent: false,
          loginMoved: true,
          sharedLogin: false,
        });

        expect(supabaseAdmin.changeUserEmail).toHaveBeenCalledWith(LOGIN, 'anna.ny@school.se', OWNER);
        // The address is that login's now: nothing is resolved by address,
        // and GoTrue sends a confirmed login no invitation anyway.
        expect(supabaseAdmin.inviteUser).not.toHaveBeenCalled();
        expect(supabaseAdmin.resendInvitation).not.toHaveBeenCalled();
        expect(adoptedAuthId()).toBe(LOGIN);
        expect(supabaseAdmin.deleteUser).not.toHaveBeenCalled();
        expect(supabaseAdmin.deleteOwnedUser).not.toHaveBeenCalled();
      });

      it('sends a never-accepted invitation again, to the new address', async () => {
        supabaseAdmin.changeUserEmail.mockResolvedValue({ outcome: 'changed', confirmed: false });

        await expect(service.invite(USER_ID, testUser())).resolves.toEqual({
          id: USER_ID,
          emailSent: true,
          loginMoved: true,
          sharedLogin: false,
        });

        expect(supabaseAdmin.resendInvitation).toHaveBeenCalledWith('anna.ny@school.se');
        expect(supabaseAdmin.changeUserEmail.mock.invocationCallOrder[0]).toBeLessThan(
          supabaseAdmin.resendInvitation.mock.invocationCallOrder[0],
        );
        expect(supabaseAdmin.inviteUser).not.toHaveBeenCalled();
        expect(adoptedAuthId()).toBe(LOGIN);
      });

      it('says a send that failed failed, rather than that the person needs none', async () => {
        // GoTrue's 429 or a mail server error. Resolved by address, the
        // refusal would read as "already registered" and find this login.
        jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        supabaseAdmin.changeUserEmail.mockResolvedValue({ outcome: 'unchanged', confirmed: false });
        supabaseAdmin.resendInvitation.mockRejectedValue(new Error('over_email_send_rate_limit'));

        await expect(service.invite(USER_ID, testUser())).rejects.toThrow(
          new ServiceUnavailableException('Could not send the invitation email. Please try again.'),
        );
        expect(supabaseAdmin.inviteUser).not.toHaveBeenCalled();
        expect(tx.user.update).not.toHaveBeenCalled();
      });

      it('leaves a login whose address is unchanged as it is, and restamps it', async () => {
        supabaseAdmin.changeUserEmail.mockResolvedValue({ outcome: 'unchanged', confirmed: true });

        await expect(service.invite(USER_ID, testUser())).resolves.toEqual({
          id: USER_ID,
          emailSent: false,
          loginMoved: false,
          sharedLogin: false,
        });

        expect(supabaseAdmin.inviteUser).not.toHaveBeenCalled();
        expect(supabaseAdmin.resendInvitation).not.toHaveBeenCalled();
        expect(adoptedAuthId()).toBe(LOGIN);
        expect(supabaseAdmin.deleteOwnedUser).not.toHaveBeenCalled();
      });

      it('deletes the old login once the row holds the one that already had the new address', async () => {
        supabaseAdmin.changeUserEmail.mockResolvedValue({ outcome: 'taken' });
        supabaseAdmin.inviteUser.mockResolvedValue({ authId: AUTH_ID, emailSent: false });

        await expect(service.invite(USER_ID, testUser())).resolves.toEqual({
          id: USER_ID,
          emailSent: false,
          loginMoved: false,
          sharedLogin: false,
        });

        expect(supabaseAdmin.inviteUser).toHaveBeenCalledWith('anna.ny@school.se', USER_ID);
        expect(adoptedAuthId()).toBe(AUTH_ID);
        // Only as the row's own, which the provider reads again then, with
        // the row's invitedAt from before this invitation restamped it.
        expect(supabaseAdmin.deleteOwnedUser).toHaveBeenCalledTimes(1);
        expect(supabaseAdmin.deleteOwnedUser).toHaveBeenCalledWith(LOGIN, OWNER);
        expect(supabaseAdmin.deleteUser).not.toHaveBeenCalled();
        // Never before the row has left it: until then the old login is the
        // one the person signs in with.
        expect(tx.user.update.mock.invocationCallOrder[0]).toBeLessThan(
          supabaseAdmin.deleteOwnedUser.mock.invocationCallOrder[0],
        );
      });

      it('keeps the old login when the row could not take the other one', async () => {
        jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        supabaseAdmin.changeUserEmail.mockResolvedValue({ outcome: 'taken' });
        supabaseAdmin.inviteUser.mockResolvedValue({ authId: AUTH_ID, emailSent: false });
        tx.user.update.mockRejectedValue(knownError('P2002'));

        await expect(service.invite(USER_ID, testUser())).rejects.toThrow(ConflictException);
        expect(supabaseAdmin.deleteOwnedUser).not.toHaveBeenCalled();
      });

      it('still reports the invitation when the old login cannot be deleted, and logs the pair', async () => {
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        supabaseAdmin.changeUserEmail.mockResolvedValue({ outcome: 'taken' });
        supabaseAdmin.inviteUser.mockResolvedValue({ authId: AUTH_ID, emailSent: true });
        supabaseAdmin.deleteOwnedUser.mockRejectedValue(new Error('gotrue down'));

        await expect(service.invite(USER_ID, testUser())).resolves.toEqual({
          id: USER_ID,
          emailSent: true,
          loginMoved: false,
          sharedLogin: false,
        });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('was not deleted'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`[user=${USER_ID}] [authId=${LOGIN}]`));
      });

      it('neither moves nor deletes a login that is not the row\'s own, and invites the new address as before', async () => {
        // A login the row was given by address can be anybody's, and the
        // row's address is the school's to set, through SS12000 too.
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        supabaseAdmin.changeUserEmail.mockResolvedValue({ outcome: 'foreign' });
        // Were it asked, a failed read would be logged as something else.
        supabaseAdmin.deleteOwnedUser.mockRejectedValue(new UserLookupError('gotrue down'));

        await expect(service.invite(USER_ID, testUser())).resolves.toEqual({
          id: USER_ID,
          emailSent: true,
          loginMoved: false,
          sharedLogin: false,
        });

        expect(supabaseAdmin.resendInvitation).not.toHaveBeenCalled();
        expect(supabaseAdmin.inviteUser).toHaveBeenCalledWith('anna.ny@school.se', USER_ID);
        expect(adoptedAuthId()).toBe(AUTH_ID);
        // changeUserEmail has said whose it is: no delete is even asked for.
        expect(supabaseAdmin.deleteOwnedUser).not.toHaveBeenCalled();
        expect(supabaseAdmin.deleteUser).not.toHaveBeenCalled();
        // The pair is what an operator finds the login it left by, and the
        // line is not the one that names a login to delete by hand.
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining(`not the row's own and was left [user=${USER_ID}] [authId=${LOGIN}]`),
        );
      });

      it('says so when the re-read finds the left login is not the row\'s own after all', async () => {
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        supabaseAdmin.changeUserEmail.mockResolvedValue({ outcome: 'taken' });
        supabaseAdmin.inviteUser.mockResolvedValue({ authId: AUTH_ID, emailSent: false });
        supabaseAdmin.deleteOwnedUser.mockResolvedValue('foreign');

        await service.invite(USER_ID, testUser());

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining(`not the row's own and was left [user=${USER_ID}] [authId=${LOGIN}]`),
        );
      });

      it('does not call a login "not deleted" when its owner could not be read', async () => {
        // "was not deleted" is the line an operator deletes a login by hand
        // on. A read that failed decided nothing about whose the login is.
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        supabaseAdmin.changeUserEmail.mockResolvedValue({ outcome: 'taken' });
        supabaseAdmin.inviteUser.mockResolvedValue({ authId: AUTH_ID, emailSent: false });
        supabaseAdmin.deleteOwnedUser.mockRejectedValue(
          new UserLookupError('Supabase user lookup failed: gateway timeout'),
        );

        await expect(service.invite(USER_ID, testUser())).resolves.toEqual({
          id: USER_ID,
          emailSent: false,
          loginMoved: false,
          sharedLogin: false,
        });

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining(`whose it is not checked [user=${USER_ID}] [authId=${LOGIN}]`),
        );
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('was not deleted'));
      });

      it('mints a login for the address when the old one is gone, and deletes nothing', async () => {
        supabaseAdmin.changeUserEmail.mockResolvedValue({ outcome: 'missing' });

        await service.invite(USER_ID, testUser());

        expect(supabaseAdmin.inviteUser).toHaveBeenCalledWith('anna.ny@school.se', USER_ID);
        expect(adoptedAuthId()).toBe(AUTH_ID);
        expect(supabaseAdmin.deleteOwnedUser).not.toHaveBeenCalled();
      });

      it('tags and checks with the row id as the database spells it, not as the request did', async () => {
        // ParseUUIDPipe and Postgres both take an upper-case uuid; a tag
        // written in one spelling would never match a check in the other.
        const ROW = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
        arrangeUser({ ...invited(), id: ROW });
        supabaseAdmin.changeUserEmail.mockResolvedValue({ outcome: 'foreign' });
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

        await service.invite(ROW.toUpperCase(), testUser());

        expect(supabaseAdmin.changeUserEmail).toHaveBeenCalledWith(LOGIN, 'anna.ny@school.se', {
          userId: ROW,
          since: INVITED_AT,
        });
        expect(supabaseAdmin.inviteUser).toHaveBeenCalledWith('anna.ny@school.se', ROW);
      });

      it('invites nobody when the login cannot be moved', async () => {
        jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        supabaseAdmin.changeUserEmail.mockRejectedValue(new Error('gotrue down'));

        await expect(service.invite(USER_ID, testUser())).rejects.toThrow(
          ServiceUnavailableException,
        );
        expect(supabaseAdmin.inviteUser).not.toHaveBeenCalled();
        expect(supabaseAdmin.resendInvitation).not.toHaveBeenCalled();
        expect(tx.user.update).not.toHaveBeenCalled();
        expect(supabaseAdmin.deleteUser).not.toHaveBeenCalled();
        expect(supabaseAdmin.deleteOwnedUser).not.toHaveBeenCalled();
      });
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
        'deactivatedAt', 'pseudonymisedAt', 'adminProfile', 'hrRead',
      ],
      lock: 'FOR NO KEY UPDATE',
    };
    /** The school's other active deciders, as keepADecider's locking read finds them. */
    let otherDeciders: { id: string }[];
    /** The rows update()'s locking read can find. */
    let users: Record<string, unknown>[];
    /** The locking read of the stored role and group. */
    let queryRaw: jest.Mock;

    /** The row as stored, found by its own id and by nothing else; null stores none. */
    const storeUser = (row: Record<string, unknown> | null) => {
      users =
        row === null
          ? []
          : [
              {
                id: USER_ID,
                schoolId: '33333333-3333-4333-8333-333333333333',
                isActive: true,
                hrRead: false,
                adminProfile: row.role === UserRole.SCHOOL_ADMIN ? 'FULL' : null,
                ...row,
              },
            ];
    };

    beforeEach(() => {
      // The auto-vivifying mock would hand back a model proxy for `$queryRaw`,
      // and a proxy is not callable. It answers as the table would, from the
      // row a test stored.
      otherDeciders = [{ id: 'another-decider' }];
      queryRaw = jest.fn((...call: unknown[]) =>
        Promise.resolve(
          rawSql(call).includes(`"adminProfile" IN ('FULL', 'REKTOR')`)
            ? otherDeciders
            : lockingRead(USERS, users, call),
        ),
      );
      Object.assign(tx, { $queryRaw: queryRaw });
      // Every patch is judged against the row it lands on, so the stored role
      // and group have to exist for any of these to reach the write at all.
      storeUser({
        role: UserRole.STUDENT,
        studentGroupId: null,
        pseudonymisedAt: null,
      });
    });

    // Sista arbetsdag (20270210090000, LÅG-2 of the review of #280): a person's time counts through the end of the
    // day an administrator names, where it counted to the click.
    describe('leftOn, the last working day', () => {
      const NOW = new Date('2026-11-13T09:00:00.000Z');
      /** The period Users_deactivations_are_kept has opened by the click, as the database holds it. */
      const RECORDED = new Date('2026-11-13T09:00:00.500Z');
      let previousReturn: { endsAt: Date } | null;
      /** Returns before the previous one: the database answers the extreme the query's own order asks for. */
      let earlierReturns: { endsAt: Date }[];
      let openPeriod: { recordedAt: Date } | null;

      beforeEach(() => {
        jest.useFakeTimers({ now: NOW });
        previousReturn = null;
        earlierReturns = [];
        openPeriod = { recordedAt: RECORDED };
        tx.school.findUnique.mockResolvedValue({ timezone: 'Europe/Stockholm' });
        // The person was added long ago, so no test below is about the lower bound unless it says so.
        tx.user.findUnique.mockResolvedValue({ createdAt: new Date('2020-01-01T08:00:00.000Z') });
        tx.userDeactivation.findFirst.mockImplementation((args: { where: { endsAt?: unknown }; orderBy?: { endsAt?: 'asc' | 'desc' } }) => {
          if (args.where.endsAt === null) return Promise.resolve(openPeriod);
          const all = [...(previousReturn ? [previousReturn] : []), ...earlierReturns].sort((a, b) => a.endsAt.getTime() - b.endsAt.getTime());
          return Promise.resolve((args.orderBy?.endsAt === 'asc' ? all[0] : all[all.length - 1]) ?? null);
        });
        tx.userDeactivation.updateMany.mockResolvedValue({ count: 1 });
        tx.user.update.mockResolvedValue({ id: USER_ID });
      });
      afterEach(() => jest.useRealTimers());

      it('starts the open period at the school\'s midnight after the day, in winter and in summer, and writes it after the person', async () => {
        await service.update(USER_ID, { isActive: false, leftOn: '2026-11-10' }, testUser());
        // The 11th at 00:00 in Stockholm (UTC+1).
        expect(tx.userDeactivation.updateMany).toHaveBeenCalledWith({
          where: { userId: USER_ID, endsAt: null },
          data: { startsAt: new Date('2026-11-10T23:00:00.000Z') },
        });
        expect(tx.user.update.mock.invocationCallOrder[0]).toBeLessThan(tx.userDeactivation.updateMany.mock.invocationCallOrder[0]);
        expect(tx.user.update).toHaveBeenCalledWith({ where: { id: USER_ID }, data: { isActive: false } });

        tx.userDeactivation.updateMany.mockClear();
        jest.setSystemTime(new Date('2026-06-20T09:00:00.000Z'));
        openPeriod = { recordedAt: new Date('2026-06-20T09:00:00.500Z') };
        await service.update(USER_ID, { isActive: false, leftOn: '2026-06-10' }, testUser());
        // The 11th at 00:00 in Stockholm (UTC+2).
        expect(tx.userDeactivation.updateMany).toHaveBeenCalledWith({
          where: { userId: USER_ID, endsAt: null },
          data: { startsAt: new Date('2026-06-10T22:00:00.000Z') },
        });
      });

      it('counts a person named for today to the click, as without a date: a last day is not in the future', async () => {
        await service.update(USER_ID, { isActive: false, leftOn: '2026-11-13' }, testUser());
        expect(tx.userDeactivation.updateMany).toHaveBeenCalledWith({
          where: { userId: USER_ID, endsAt: null },
          data: { startsAt: RECORDED },
        });
      });

      it('takes the school\'s day for today, not UTC\'s: at 00:30 on the 14th in Stockholm the 14th is today and the 13th is over', async () => {
        jest.setSystemTime(new Date('2026-11-13T23:30:00.000Z'));
        openPeriod = { recordedAt: new Date('2026-11-13T23:30:00.500Z') };
        // The 13th is over in Stockholm: its end is the 14th at 00:00, which is 23:00 UTC, before the click.
        await service.update(USER_ID, { isActive: false, leftOn: '2026-11-13' }, testUser());
        expect(tx.userDeactivation.updateMany).toHaveBeenCalledWith({
          where: { userId: USER_ID, endsAt: null },
          data: { startsAt: new Date('2026-11-13T23:00:00.000Z') },
        });
        // And the 14th is today for the school, though it is the 13th in UTC: named, it is counted to the click and refused by nobody.
        tx.userDeactivation.updateMany.mockClear();
        await expect(service.update(USER_ID, { isActive: false, leftOn: '2026-11-14' }, testUser())).resolves.toEqual({ id: USER_ID });
        expect(tx.userDeactivation.updateMany).toHaveBeenCalledWith({
          where: { userId: USER_ID, endsAt: null },
          data: { startsAt: new Date('2026-11-13T23:30:00.500Z') },
        });
        // The 15th is not.
        await expect(service.update(USER_ID, { isActive: false, leftOn: '2026-11-15' }, testUser())).rejects.toMatchObject({
          response: { code: 'USER_LEFT_ON_IN_THE_FUTURE' },
        });
        // In summer, 00:30 CEST on the 14th June is 22:30 UTC on the 13th.
        jest.setSystemTime(new Date('2026-06-13T22:30:00.000Z'));
        openPeriod = { recordedAt: new Date('2026-06-13T22:30:00.500Z') };
        await expect(service.update(USER_ID, { isActive: false, leftOn: '2026-06-14' }, testUser())).resolves.toEqual({ id: USER_ID });
      });

      it('refuses a day that has not been, writing nothing', async () => {
        await expect(service.update(USER_ID, { isActive: false, leftOn: '2026-11-14' }, testUser())).rejects.toMatchObject({
          status: 400,
          response: { code: 'USER_LEFT_ON_IN_THE_FUTURE' },
        });
        expect(tx.user.update).not.toHaveBeenCalled();
        expect(tx.userDeactivation.updateMany).not.toHaveBeenCalled();
      });

      it('refuses a last day for a person who stays or becomes active, and for an active person it does not deactivate', async () => {
        for (const body of [{ isActive: true, leftOn: '2026-11-10' }, { leftOn: '2026-11-10' }]) {
          await expect(service.update(USER_ID, body, testUser())).rejects.toMatchObject({
            status: 400,
            response: { code: 'USER_LEFT_ON_NEEDS_INACTIVE' },
          });
        }
        expect(tx.user.update).not.toHaveBeenCalled();
        expect(tx.userDeactivation.updateMany).not.toHaveBeenCalled();
      });

      it('names the last day alone for a person who is inactive already, which is how a day named late is corrected', async () => {
        storeUser({ role: UserRole.STUDENT, studentGroupId: null, pseudonymisedAt: null, isActive: false });
        await service.update(USER_ID, { leftOn: '2026-11-10' }, testUser());
        expect(tx.userDeactivation.updateMany).toHaveBeenCalledWith({
          where: { userId: USER_ID, endsAt: null },
          data: { startsAt: new Date('2026-11-10T23:00:00.000Z') },
        });
      });

      it('refuses a day before the person was last made active again, naming the day they came back', async () => {
        // Back on 5 November at 08:00 in Stockholm; the 3rd's end is the 4th at midnight, before that.
        previousReturn = { endsAt: new Date('2026-11-05T07:00:00.000Z') };
        await expect(service.update(USER_ID, { isActive: false, leftOn: '2026-11-03' }, testUser())).rejects.toMatchObject({
          status: 400,
          response: { code: 'USER_LEFT_ON_BEFORE_RETURN', params: { returned: '2026-11-05' } },
        });
        expect(tx.user.update).not.toHaveBeenCalled();
        // The day they came back is theirs to name: the 5th ends after they returned.
        await service.update(USER_ID, { isActive: false, leftOn: '2026-11-05' }, testUser());
        expect(tx.userDeactivation.updateMany).toHaveBeenCalledWith({
          where: { userId: USER_ID, endsAt: null },
          data: { startsAt: new Date('2026-11-05T23:00:00.000Z') },
        });
        // And the day that ends at the very instant they returned is not before it: periods may meet (the exclusion allows it).
        tx.userDeactivation.updateMany.mockClear();
        previousReturn = { endsAt: new Date('2026-11-05T23:00:00.000Z') };
        await service.update(USER_ID, { isActive: false, leftOn: '2026-11-05' }, testUser());
        expect(tx.userDeactivation.updateMany).toHaveBeenCalledTimes(1);
      });

      // The review of #308, MEDEL-1: class-validator's IsOptional lets null through, and the service read it as a date.
      it('reads leftOn: null as no day, through the real ValidationPipe, and deactivates', async () => {
        const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: false } });
        for (const body of [{ isActive: false, leftOn: null }, { isActive: false }]) {
          const dto = (await pipe.transform(body, { type: 'body', metatype: UpdateUserDto })) as UpdateUserDto;
          tx.userDeactivation.findFirst.mockClear();
          tx.userDeactivation.updateMany.mockClear();
          tx.user.update.mockClear();
          await expect(service.update(USER_ID, dto, testUser())).resolves.toEqual({ id: USER_ID });
          expect(tx.user.update).toHaveBeenCalledWith({ where: { id: USER_ID }, data: { isActive: false } });
          // No day: no read of the periods, no write of one, and the school is not asked its zone.
          expect(tx.userDeactivation.findFirst).not.toHaveBeenCalled();
          expect(tx.userDeactivation.updateMany).not.toHaveBeenCalled();
        }
        // On a person who is inactive already, null alone is a change of nothing and not an error.
        storeUser({ role: UserRole.STUDENT, studentGroupId: null, pseudonymisedAt: null, isActive: false });
        const dto = (await pipe.transform({ leftOn: null }, { type: 'body', metatype: UpdateUserDto })) as UpdateUserDto;
        await expect(service.update(USER_ID, dto, testUser())).resolves.toEqual({ id: USER_ID });
        expect(tx.userDeactivation.updateMany).not.toHaveBeenCalled();
      });

      // The review of #308, LÅG-4: nothing stopped a last day from before the person was there, and year 1 was a 500.
      it('refuses a day before the person was added to Rastra, in the school\'s days, and not the day they were added', async () => {
        // Added at 00:30 on the 11th in Stockholm (23:30 UTC on the 10th).
        tx.user.findUnique.mockResolvedValue({ createdAt: new Date('2026-11-10T23:30:00.000Z') });
        await expect(service.update(USER_ID, { isActive: false, leftOn: '2026-11-10' }, testUser())).rejects.toMatchObject({
          status: 400,
          response: { code: 'USER_LEFT_ON_BEFORE_START', params: { added: '2026-11-11' } },
        });
        expect(tx.user.update).not.toHaveBeenCalled();
        await service.update(USER_ID, { isActive: false, leftOn: '2026-11-11' }, testUser());
        expect(tx.userDeactivation.updateMany).toHaveBeenCalledTimes(1);
      });

      it.each(['0001-01-01', '0100-06-01', '1000-01-01', '1970-01-01', '2019-12-31'])('refuses %s for a person added in 2020, and writes nothing', async (leftOn) => {
        await expect(service.update(USER_ID, { isActive: false, leftOn }, testUser())).rejects.toMatchObject({
          response: { code: 'USER_LEFT_ON_BEFORE_START' },
        });
        expect(tx.user.update).not.toHaveBeenCalled();
        expect(tx.userDeactivation.updateMany).not.toHaveBeenCalled();
      });

      // The review of #308, MEDEL-2: with two earlier returns the LATEST decides, not the oldest.
      it('judges a day against the latest return of a person who has come back twice', async () => {
        earlierReturns = [{ endsAt: new Date('2026-10-05T06:00:00.000Z') }];
        previousReturn = { endsAt: new Date('2026-11-05T07:00:00.000Z') };
        // Between the two returns: after the first, before the second.
        await expect(service.update(USER_ID, { isActive: false, leftOn: '2026-10-20' }, testUser())).rejects.toMatchObject({
          response: { code: 'USER_LEFT_ON_BEFORE_RETURN', params: { returned: '2026-11-05' } },
        });
        expect(tx.user.update).not.toHaveBeenCalled();
        // After the second: fine.
        await service.update(USER_ID, { isActive: false, leftOn: '2026-11-06' }, testUser());
        expect(tx.userDeactivation.updateMany).toHaveBeenCalledTimes(1);
      });

      it('leaves the periods alone when no day is named', async () => {
        await service.update(USER_ID, { isActive: false }, testUser());
        expect(tx.userDeactivation.findFirst).not.toHaveBeenCalled();
        expect(tx.userDeactivation.updateMany).not.toHaveBeenCalled();
        expect(tx.school.findUnique).not.toHaveBeenCalled();
      });

      it('does nothing to a period that is not there (a person the trigger has not dated), and does not fail', async () => {
        openPeriod = null;
        await expect(service.update(USER_ID, { isActive: false, leftOn: '2026-11-10' }, testUser())).resolves.toEqual({ id: USER_ID });
        expect(tx.userDeactivation.updateMany).not.toHaveBeenCalled();
      });
    });

    it('refuses to make a pseudonymised person active again, naming the way out', async () => {
      storeUser({ role: UserRole.STUDENT, studentGroupId: null, pseudonymisedAt: new Date('2026-10-21T01:10:00Z') });

      await expect(service.update(USER_ID, { isActive: true }, testUser())).rejects.toMatchObject({
        status: 409,
        response: { code: 'USER_IS_PSEUDONYMISED' },
      });
      expect(tx.user.update).not.toHaveBeenCalled();
      // Anything else about the row is still the admin's to edit.
      tx.user.update.mockResolvedValue({ id: USER_ID });
      await service.update(USER_ID, { phone: null }, testUser());
      expect(tx.user.update).toHaveBeenCalledTimes(1);
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
        /SELECT "role", "studentGroupId", "pseudonymisedAt", "adminProfile", "hrRead", "isActive", "schoolId"\s+FROM "Users"\s+WHERE "id" = \?::uuid\s+FOR NO KEY UPDATE/,
      );
      expect(call.slice(1)).toEqual([USER_ID]);
      expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.user.update.mock.invocationCallOrder[0],
      );
    });

    it('records the patched person as PEOPLE after the write, in its transaction, whatever the body named', async () => {
      tx.user.update.mockResolvedValue({ id: USER_ID, email: 'maja@school.se', phone: '+46701234567' });
      const ranIn = transactionsOf(prisma);
      const writtenIn = ranIn(tx.user.update);
      const loggedIn = ranIn(tx.$executeRaw as jest.Mock);

      await service.update(USER_ID, {}, testUser({ channel: 'OTHER' }));

      // An empty body still answers with the whole row, e-mail and phone among it.
      expect(recordedReads(tx)).toEqual([{ kind: 'PEOPLE', channel: 'OTHER', ids: [USER_ID] }]);
      expect(loggedIn).toEqual(writtenIn);
      expect(tx.user.update.mock.invocationCallOrder[0]).toBeLessThan(
        (tx.$executeRaw as jest.Mock).mock.invocationCallOrder[0]!,
      );
    });

    it('records nothing for a patch it refuses', async () => {
      storeUser(null);
      await expect(service.update(USER_ID, { firstName: 'Maja' }, testUser())).rejects.toBeInstanceOf(NotFoundException);
      expect(recordedReads(tx)).toEqual([]);
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

    it('refuses a teaching group as a pupil’s home class, named; and leaves an unchanged home unasked', async () => {
      // Ersättande grupper: a teaching group keeps its MEMBERS on its own
      // lessons, and every reader asks membership. A "home" that is a
      // teaching group would let the database's helper and the rest disagree.
      tx.studentGroup.findUnique.mockResolvedValue({ kind: 'TEACHING_GROUP' });
      await expect(service.update(USER_ID, { role: UserRole.STUDENT, studentGroupId: GROUP_ID }, testUser())).rejects.toMatchObject({
        response: { code: 'STUDENT_HOME_GROUP_NOT_A_CLASS' },
      });
      expect(tx.user.update).not.toHaveBeenCalled();

      tx.studentGroup.findUnique.mockClear();
      tx.user.update.mockResolvedValue({ id: USER_ID });
      await service.update(USER_ID, { phone: null }, testUser());
      expect(tx.studentGroup.findUnique).not.toHaveBeenCalled();
    });

    it("holds the class a pupil moves into FOR SHARE before the person's row, after the school's lock, and no class for anything else", async () => {
      tx.user.update.mockResolvedValue({ id: USER_ID });

      await service.update(USER_ID, { studentGroupId: GROUP_ID }, testUser());

      // The one order of groups and pupils (src/common/lock-order.ts): a bulk
      // delete of the class holds it and then empties its pupils.
      const sent = tx.$executeRaw.mock.calls.map((call) => rawSql(call).replace(/\s+/g, ' ').trim());
      expect(sent.slice(0, 2)).toEqual([
        'SELECT pg_advisory_xact_lock_shared(hashtextextended(?, 0))',
        'SELECT 1 FROM "StudentGroups" g WHERE g."id" = ANY(?::uuid[]) ORDER BY g."id" FOR SHARE',
      ]);
      expect((tx.$executeRaw.mock.calls[1]![0] as { values: unknown[] }).values).toEqual([[GROUP_ID]]);
      expect(tx.$executeRaw.mock.invocationCallOrder[1]!).toBeLessThan(tx.$queryRaw.mock.invocationCallOrder[0]!);

      tx.$executeRaw.mockClear();
      await service.update(USER_ID, { phone: null }, testUser());
      await service.update(USER_ID, { studentGroupId: null }, testUser());
      expect(tx.$executeRaw.mock.calls.some((call) => /pg_advisory|"StudentGroups"/.test(rawSql(call)))).toBe(false);
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

    it('refuses a demotion on rastvaktspass, and says where they are planned', async () => {
      // lockStaffRow's other half (Rastvaktsschema, 20261207090000): a pupil
      // left on the schedule would watch a break and be charged it.
      storeUser({ role: UserRole.TEACHER, studentGroupId: null });
      tx.teacherEmployment.count.mockResolvedValue(0);
      tx.teacherSubjectQualification.count.mockResolvedValue(0);
      tx.teacherDuty.count.mockResolvedValue(0);
      tx.supervisionShift.count.mockResolvedValue(2);

      await expect(
        service.update(USER_ID, { role: UserRole.STUDENT }, testUser()),
      ).rejects.toThrow(
        new ConflictException(
          'Personen kan inte bli elev: 2 rastvaktspass finns registrerade. Ta bort dem under Rastvaktsschema först.',
        ),
      );
      expect(tx.supervisionShift.count).toHaveBeenCalledWith({ where: { userId: USER_ID } });
      tx.teacherDuty.count.mockResolvedValue(1);
      await expect(
        service.update(USER_ID, { role: UserRole.STUDENT }, testUser()),
      ).rejects.toThrow(
        new ConflictException(
          'Personen kan inte bli elev: 1 uppdrag och 2 rastvaktspass finns registrerade. Ta bort dem under Personer och Rastvaktsschema först.',
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
      // A new administrator is a full one when the patch names no profile.
      expect(tx.user.update).toHaveBeenLastCalledWith({
        where: { id: USER_ID },
        data: { role: UserRole.SCHOOL_ADMIN, adminProfile: 'FULL' },
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

    // A pupil's class says who their mentors are, and a teacher's role and
    // isActive whether they are one (app.leave_mentors): such a PATCH may give
    // a mentor a pending leave request nobody told them of.
    describe('the leave requests a class move gives a mentor (Mentorns ledighetsbeslut)', () => {
      const TELL = 'app.leave_requests_tell_new_mentors()';
      const MENTOR = '77777777-7777-4777-8777-777777777777';
      const NOTICE = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
      let deliver: jest.Mock;

      beforeEach(() => {
        deliver = jest.fn();
        service = new UsersService(
          prisma as unknown as PrismaService,
          supabaseAdmin as unknown as SupabaseAdminService,
          { deliver } as unknown as NotificationsService,
        );
        queryRaw.mockImplementation((...call: unknown[]) =>
          rawSql(call).includes(TELL)
            ? Promise.resolve([{ notificationId: NOTICE, userId: MENTOR, email: null, meta: { leaveRequestId: 'r1', schoolDays: 2 } }])
            : // Roller i skolan: demoting an administrator first locks the
              // school's deciders, of whom another stays.
              rawSql(call).includes('"adminProfile" IN')
              ? Promise.resolve([{ id: USER_ID }, { id: MENTOR }])
              : Promise.resolve(lockingRead(USERS, users, call)),
        );
        tx.user.update.mockResolvedValue({ id: USER_ID });
      });

      const told = () => queryRaw.mock.calls.filter((call) => rawSql(call).includes(TELL));

      it.each([
        ['a class move', { role: UserRole.STUDENT, studentGroupId: null, isActive: true }, { studentGroupId: GROUP_ID }],
        ['leaving the class', { role: UserRole.STUDENT, studentGroupId: GROUP_ID, isActive: true }, { studentGroupId: null }],
        ['a reactivation', { role: UserRole.TEACHER, studentGroupId: null, isActive: false }, { isActive: true }],
        ['a role change', { role: UserRole.SCHOOL_ADMIN, studentGroupId: null, isActive: true }, { role: UserRole.TEACHER }],
      ])('tells the mentors after %s, in the PATCH’s transaction', async (_what, stored, dto) => {
        storeUser({ ...stored, pseudonymisedAt: null });
        const ranIn = transactionsOf(prisma);
        const toldIn = ranIn(queryRaw);
        const writtenIn = ranIn(tx.user.update);

        await service.update(USER_ID, dto, testUser());

        expect(told()).toHaveLength(1);
        const at = queryRaw.mock.invocationCallOrder[queryRaw.mock.calls.findIndex((call) => rawSql(call).includes(TELL))]!;
        expect(at).toBeGreaterThan(tx.user.update.mock.invocationCallOrder[0]!);
        expect(new Set([...toldIn, ...writtenIn]).size).toBe(1);
        expect(deliver).toHaveBeenCalledWith(
          tx,
          expect.objectContaining({ schoolId: SCHOOL_ID, type: 'LEAVE_REQUESTED', recipients: [{ userId: MENTOR, notificationId: NOTICE }] }),
        );
      });

      it('asks nothing of a PATCH that moves no mentor: names, phone', async () => {
        await service.update(USER_ID, { firstName: 'Maja', lastName: 'Ek', phone: null }, testUser());
        expect(told()).toEqual([]);
        expect(deliver).not.toHaveBeenCalled();
      });

      // The People page sends role and class with every save: a name fix
      // there must not run the catch-up, which would re-send a notice
      // gallring removed for a request still pending.
      it('asks nothing of a save that sends the role, class and isActive it already has', async () => {
        storeUser({ role: UserRole.STUDENT, studentGroupId: GROUP_ID, isActive: true, pseudonymisedAt: null });
        await service.update(
          USER_ID,
          { firstName: 'Maja', role: UserRole.STUDENT, studentGroupId: GROUP_ID, isActive: true },
          testUser(),
        );
        expect(told()).toEqual([]);
        expect(deliver).not.toHaveBeenCalled();
      });

      it('asks nothing when the move is refused', async () => {
        storeUser({ role: UserRole.TEACHER, studentGroupId: null, pseudonymisedAt: null });
        await expect(service.update(USER_ID, { studentGroupId: GROUP_ID }, testUser())).rejects.toThrow(BadRequestException);
        expect(told()).toEqual([]);
      });
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
        select: { authId: true, invitedAt: true, role: true, adminProfile: true, isActive: true, schoolId: true },
      });
      expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: USER_ID } });
      expect(supabaseAdmin.deleteUser).toHaveBeenCalledWith(AUTH_ID);
    });

    it('keeps a login another school\'s row still holds, asking after the delete with no row excepted', async () => {
      // Flera skolor per inloggning: the person signs in to the other school
      // with it.
      tx.user.findUnique.mockResolvedValue({ authId: AUTH_ID, invitedAt: new Date('2026-08-01T00:00:00.000Z') });
      tx.user.delete.mockResolvedValue({ id: USER_ID });
      answerHeldElsewhere(true);

      await expect(service.remove(USER_ID, testUser())).resolves.toBeUndefined();

      expect(supabaseAdmin.deleteUser).not.toHaveBeenCalled();
      const asked = tx.$queryRaw.mock.calls.findIndex((call) => rawSql(call).includes('app.login_is_held_elsewhere'));
      expect(tx.$queryRaw.mock.calls[asked]!.slice(1)).toEqual([AUTH_ID, null]);
      expect(tx.$queryRaw.mock.invocationCallOrder[asked]!).toBeGreaterThan(tx.user.delete.mock.invocationCallOrder[0]!);
    });

    it('keeps the login when it cannot ask whether another school holds it', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      tx.user.findUnique.mockResolvedValue({ authId: AUTH_ID, invitedAt: new Date('2026-08-01T00:00:00.000Z') });
      tx.user.delete.mockResolvedValue({ id: USER_ID });
      answerHeldElsewhere('fails');

      await expect(service.remove(USER_ID, testUser())).resolves.toBeUndefined();

      expect(supabaseAdmin.deleteUser).not.toHaveBeenCalled();
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
        where: { OR: [{ decidedByUserId: USER_ID }, { gradeSpanSetByUserId: USER_ID }] },
        select: { name: true, decidedByUserId: true, gradeSpanSetByUserId: true },
        orderBy: { name: 'asc' },
      });
      expect(tx.user.delete).not.toHaveBeenCalled();
      expect(supabaseAdmin.deleteUser).not.toHaveBeenCalled();
    });

    it('409s removing the person who set a decided timplan’s årskurs span, in those words', async () => {
      tx.user.findUnique.mockResolvedValue({ authId: AUTH_ID, invitedAt: null });
      tx.localTimplan.findMany.mockResolvedValue([
        { name: 'Grundskolan 2024', decidedByUserId: 'someone-else', gradeSpanSetByUserId: USER_ID },
      ]);

      const error = await service.remove(USER_ID, testUser()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).message).toContain(
        'registrerade årskurspannet för den beslutade lokala timplanen "Grundskolan 2024"',
      );
      expect((error as ConflictException).message).not.toContain('registrerade beslutet');
      expect(tx.user.delete).not.toHaveBeenCalled();
    });

    it('names both when one person decided a plan and set another’s span', async () => {
      tx.user.findUnique.mockResolvedValue({ authId: AUTH_ID, invitedAt: null });
      tx.localTimplan.findMany.mockResolvedValue([
        { name: 'A', decidedByUserId: USER_ID, gradeSpanSetByUserId: null },
        { name: 'B', decidedByUserId: 'someone-else', gradeSpanSetByUserId: USER_ID },
      ]);

      await expect(service.remove(USER_ID, testUser())).rejects.toThrow(
        'registrerade beslutet eller årskurspannet för de beslutade lokala timplanerna "A" och "B"',
      );
    });

    it('says the same when the restrict key of the span refuses a span set after the question', async () => {
      tx.user.findUnique.mockResolvedValue({ authId: AUTH_ID, invitedAt: null });
      tx.user.delete.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Foreign key constraint violated', {
          code: 'P2003',
          clientVersion: Prisma.prismaVersion.client,
          meta: {
            modelName: 'User',
            driverAdapterError: {
              cause: { constraint: { index: 'LocalTimplans_gradeSpanSetByUserId_schoolId_fkey' } },
            },
          },
        }),
      );

      await expect(service.remove(USER_ID, testUser())).rejects.toThrow(
        'registrerade årskurspannet för en beslutad lokal timplan och kan inte tas bort',
      );
    });

    it('says the decision when the decider key refuses a decision recorded after the question', async () => {
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
        'registrerade beslutet om en beslutad lokal timplan och kan inte tas bort',
      );
    });

    it('409s removing a person whose rastvaktspass has a vikarie booked ahead, under the board\'s teacher lock', async () => {
      // Rastvakt i vardagen: the delete would cascade the pass, the absence
      // and the decision, and the vikarie would never be told.
      tx.user.findUnique.mockResolvedValue({ authId: AUTH_ID, invitedAt: null, role: 'TEACHER' });
      tx.supervisionCover.findFirst.mockResolvedValue({ date: new Date('2030-09-02T00:00:00.000Z') });

      const error = await service.remove(USER_ID, testUser()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'USER_HAS_BOOKED_PASS_COVERS',
        params: { date: '2030-09-02' },
      });
      expect((error as ConflictException).message).not.toMatch(/inaktivera/i);
      expect((error as ConflictException).message).toContain('första gången 2030-09-02');
      expect(tx.supervisionCover.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { absentTeacherId: USER_ID, decision: 'SUBSTITUTE', endsAt: { gt: expect.any(Date) } },
        }),
      );
      const locked = tx.$executeRaw.mock.calls.findIndex((call) => rawSql(call).includes("'cover-teacher:'"));
      expect(locked).toBeGreaterThanOrEqual(0);
      // Before any row is read or locked: a pass written for the person takes
      // it before their Users row.
      expect(tx.$executeRaw.mock.invocationCallOrder[locked]!).toBeLessThan(
        tx.user.findUnique.mock.invocationCallOrder[0]!,
      );
      expect(tx.user.delete).not.toHaveBeenCalled();
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

    describe('a series of external bookings the person registered (Lokal)', () => {
      // The days they booked are bookings in their name, and the key to the booker is CASCADE:
      // deleting them would free a hall let to an association every Tuesday, without a word.
      const NOW = new Date('2027-01-20T12:00:00.000Z');

      beforeEach(() => {
        jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
        tx.user.findUnique.mockResolvedValue({ authId: AUTH_ID, invitedAt: null });
        tx.user.delete.mockResolvedValue({ id: USER_ID });
      });

      afterEach(() => {
        jest.useRealTimers();
      });

      it('409s while a series they registered is running, naming the date it ends, and deletes nothing', async () => {
        tx.externalBooking.findFirst.mockResolvedValue({ endDate: new Date('2027-03-02T00:00:00.000Z') });

        const error = await service.remove(USER_ID, testUser()).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({
          code: 'EXTERNAL_BOOKINGS_REGISTERED',
          params: { date: '2027-03-02' },
        });
        expect((error as ConflictException).message).toContain('Personen har registrerat en extern bokning som pågår till 2027-03-02.');
        expect((error as ConflictException).message).toContain('Avboka den under Externa bokningar först');
        expect(tx.user.delete).not.toHaveBeenCalled();
        expect(supabaseAdmin.deleteUser).not.toHaveBeenCalled();
      });

      it('asks for a series that is not cancelled and not over, the one ending first, by the school’s today', async () => {
        await service.remove(USER_ID, testUser());

        expect(tx.externalBooking.findFirst).toHaveBeenCalledWith({
          where: { registeredById: USER_ID, cancelledAt: null, endDate: { gte: new Date('2027-01-20T00:00:00.000Z') } },
          select: { endDate: true },
          orderBy: { endDate: 'asc' },
        });
        // Before the delete it would otherwise cascade.
        expect(tx.externalBooking.findFirst.mock.invocationCallOrder[0]!).toBeLessThan(tx.user.delete.mock.invocationCallOrder[0]!);
      });

      it('reckons today on the school’s own zone, which is a day ahead of UTC in the morning in New Zealand', async () => {
        tx.school.findFirst.mockResolvedValue({ timezone: 'Pacific/Auckland' });

        await service.remove(USER_ID, testUser());

        expect(tx.externalBooking.findFirst.mock.calls[0]![0].where.endDate).toEqual({ gte: new Date('2027-01-21T00:00:00.000Z') });
      });

      it('deletes the person when the series they registered are over or cancelled', async () => {
        tx.externalBooking.findFirst.mockResolvedValue(null);

        await expect(service.remove(USER_ID, testUser())).resolves.toBeUndefined();

        expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: USER_ID } });
      });
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

  describe('Massåtgärder (bulk)', () => {
    const P1 = 'aaaaaaaa-0000-4000-8000-000000000001';
    const P2 = 'bbbbbbbb-0000-4000-8000-000000000002';
    const P3 = 'cccccccc-0000-4000-8000-000000000003';
    const TEACHER = 'dddddddd-0000-4000-8000-000000000004';
    const MISSING = 'eeeeeeee-0000-4000-8000-000000000005';
    const CLASS_A = '1a1a1a1a-0000-4000-8000-00000000000a';
    const CLASS_B = '1b1b1b1b-0000-4000-8000-00000000000b';
    const AUTH_1 = 'a1000000-0000-4000-8000-000000000001';
    const AUTH_2 = 'a2000000-0000-4000-8000-000000000002';
    const AUTH_3 = 'a3000000-0000-4000-8000-000000000003';
    const MENTOR = '78787878-7878-4878-8878-787878787878';
    const NOTICE = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
    const TELL = 'app.leave_requests_tell_new_mentors()';
    const HELD = 'app.login_is_held_elsewhere';
    const user = testUser();

    const NOT_A_STUDENT_SENTENCE =
      'Raden är ingen elev. Lärare, administratörer och vårdnadshavare ändras och tas bort en i taget.';
    const NOT_FOUND = { code: 'BULK_ROW_NOT_FOUND', message: expect.stringContaining('finns inte längre') };

    /** The columns the bulk reads of Users may name. */
    const COLUMNS = ['id', 'role', 'studentGroupId', 'isActive', 'pseudonymisedAt', 'authId', 'invitedAt', 'ss12000Id'];

    /** A pupil as the Users table holds them: not invited, in no class, active. */
    const pupil = (id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      id,
      role: 'STUDENT',
      studentGroupId: null,
      isActive: true,
      pseudonymisedAt: null,
      authId: id.replace(/^......../, 'f0000000'),
      invitedAt: null,
      ss12000Id: null,
      ...overrides,
    });
    const staff = (id: string, role: string): Record<string, unknown> => pupil(id, { role });

    /** The Users table. */
    let table: Record<string, unknown>[];
    /** What each table holds for the pupils by its first key column, as the inventory's SQL counts it. */
    let keyCounts: Record<string, number> = {};
    /** The logins another school's row holds (app.login_is_held_elsewhere answers true); 'fails' for a question that cannot be answered. */
    let heldLogins: Set<string> | 'fails';
    let deliver: jest.Mock;
    let queryRaw: jest.Mock;

    /**
     * What the table answers a bulk call's locking read with: the rows whose
     * id is in the one array bound into the statement, in id order, each with
     * the columns the SELECT names and no others. A statement that is not
     * `SELECT … FROM "Users" WHERE "id" = ANY($1::uuid[]) ORDER BY "id" <lock>`,
     * that takes another lock, or names a column the table lacks, throws, so
     * a read that drops its lock, its order or a column fails the test
     * instead of passing on rows it never asked for.
     */
    const lockedRead = (lock: 'FOR UPDATE' | 'FOR NO KEY UPDATE' | 'no lock', call: unknown[]) => {
      const sql = rawSql(call).replace(/\s+/g, ' ').trim();
      const read = /^SELECT (.+) FROM "Users" WHERE "id" = ANY\(\?::uuid\[\]\) ORDER BY "id"(?: (FOR (?:NO KEY )?UPDATE))?$/.exec(sql);
      if (read === null || (read[2] ?? 'no lock') !== lock || call.length !== 2) throw new Error(`Not a ${lock} read of the call's pupils: ${sql}`);
      const columns = read[1]!.split(',').map((column) => {
        const name = /^"(\w+)"$/.exec(column.trim())?.[1];
        if (name === undefined || !COLUMNS.includes(name)) throw new Error(`"Users" has no column ${column.trim()}`);
        return name;
      });
      const ids = call[1] as string[];
      return table
        .filter((row) => ids.includes(row['id'] as string))
        .sort((a, b) => ((a['id'] as string) < (b['id'] as string) ? -1 : 1))
        .map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
    };
    const givenReadsUnder = (lock: 'FOR UPDATE' | 'FOR NO KEY UPDATE' | 'no lock') => {
      queryRaw = jest.fn((...call: unknown[]) => {
        const sql = rawSql(call);
        if (sql.includes(HELD)) {
          if (heldLogins === 'fails') return Promise.reject(new Error('connection reset'));
          return Promise.resolve([{ held: heldLogins.has(call[1] as string) }]);
        }
        if (sql.includes(TELL)) {
          return Promise.resolve([
            { notificationId: NOTICE, userId: MENTOR, email: null, meta: { leaveRequestId: 'r1', schoolDays: 2 } },
          ]);
        }
        // The inventory's counts (removal-inventory.ts), by table and the key column first named.
        const count = /^SELECT count\(\*\)::int AS n FROM "(\w+)" WHERE "(\w+)"/.exec(sql);
        if (count) return Promise.resolve([{ n: keyCounts[`${count[1]}.${count[2]}`] ?? 0 }]);
        return Promise.resolve(lockedRead(lock, call));
      });
      Object.assign(tx, { $queryRaw: queryRaw });
    };

    /**
     * A bulk statement's answer as Prisma gives it: the rows it wrote, here
     * every row its `id in` names. writeAll tries the rows one by one when
     * the count falls short, so an unstubbed statement would not pass as one.
     */
    const writesEveryRowNamed = ({ where }: { where?: { id?: { in?: string[] } } }) =>
      Promise.resolve({ count: where?.id?.in?.length ?? 0 });

    beforeEach(() => {
      table = [pupil(P1), pupil(P2), pupil(P3), staff(TEACHER, 'TEACHER')];
      keyCounts = {};
      heldLogins = new Set();
      deliver = jest.fn();
      service = new UsersService(
        prisma as unknown as PrismaService,
        supabaseAdmin as unknown as SupabaseAdminService,
        { deliver } as unknown as NotificationsService,
      );
      tx.studentGroup.findUnique.mockResolvedValue({ kind: 'CLASS' });
      tx.user.updateMany.mockImplementation(writesEveryRowNamed);
      tx.user.deleteMany.mockImplementation(writesEveryRowNamed);
    });

    /** The transaction of the last withRls call: it rejects when its body threw, which rolls it back. */
    const lastTransaction = (): Promise<unknown> =>
      prisma.withRls.mock.results[prisma.withRls.mock.results.length - 1]!.value as Promise<unknown>;
    const expectCommitted = () => expect(lastTransaction()).resolves.toMatchObject({ applied: true });
    const expectRolledBack = () => expect(lastTransaction()).rejects.toThrow();

    /** The savepoint statements sent with $executeRaw. */
    const savepoints = () =>
      tx.$executeRaw.mock.calls.map((call) => rawSql(call)).filter((sql) => /SAVEPOINT/.test(sql));
    /** The school's lock and the row locks sent with $executeRaw, in order (src/common/lock-order.ts). */
    const lockOrder = () =>
      tx.$executeRaw.mock.calls
        .map((call) => rawSql(call).replace(/\s+/g, ' ').trim())
        .filter((sql) => / FOR (UPDATE|NO KEY UPDATE|SHARE|KEY SHARE)$|pg_advisory_xact_lock_shared/.test(sql));
    const PEOPLE_LOCK = 'SELECT pg_advisory_xact_lock_shared(hashtextextended(?, 0))';
    const CLASS_SHARED =
      'SELECT 1 FROM "StudentGroups" g WHERE g."id" = ANY(?::uuid[]) ORDER BY g."id" FOR SHARE';

    const told = () => queryRaw.mock.calls.filter((call) => rawSql(call).includes(TELL));

    /** The turns after the answer in which the shared mock runs the hooks of a commit. */
    const afterCommit = async () => {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    };

    describe('bulkUpdateStudents', () => {
      beforeEach(() => givenReadsUnder('FOR NO KEY UPDATE'));

      it('refuses a body whose changes name nothing before it opens a transaction', async () => {
        await expect(service.bulkUpdateStudents({ ids: [P1], changes: {}, dryRun: false }, user)).rejects.toThrow(BadRequestException);
        await expect(
          service.bulkUpdateStudents({ ids: [P1], changes: { isActive: undefined }, dryRun: false }, user),
        ).rejects.toThrow(BadRequestException);
        expect(prisma.withRls).not.toHaveBeenCalled();
      });

      it('locks the pupils once each, in id order, in one transaction with the bulk timeout', async () => {
        await service.bulkUpdateStudents({ ids: [P3, P1, P3], changes: { isActive: false }, dryRun: false }, user);

        expect(prisma.withRls).toHaveBeenCalledTimes(1);
        expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function), { timeoutMs: BULK_TIMEOUT_MS });
        expect(queryRaw.mock.calls[0]!.slice(1)).toEqual([[P1, P3]]);
      });

      it('moves the pupils into the class in one statement, commits, and records no read in the läslogg', async () => {
        table = [pupil(P1), pupil(P2, { studentGroupId: CLASS_B })];

        const result = await service.bulkUpdateStudents({ ids: [P2, P1], changes: { studentGroupId: CLASS_A }, dryRun: false }, user);

        expect(result).toEqual({ applied: true, dryRun: false, done: [P1, P2], refused: [] });
        expect(tx.user.updateMany).toHaveBeenCalledTimes(1);
        expect(tx.user.updateMany).toHaveBeenCalledWith({
          where: { id: { in: [P1, P2] } },
          data: { studentGroupId: CLASS_A },
        });
        expect(tx.user.update).not.toHaveBeenCalled();
        expect(savepoints()).toEqual(['SAVEPOINT bulk_whole', 'RELEASE SAVEPOINT bulk_whole']);
        // The answer is ids only: the register the page reads afterwards records its own read.
        expect(recordedReads(tx)).toEqual([]);
        await expectCommitted();
      });

      it("holds the class the pupils move into FOR SHARE before their rows, after the school's lock", async () => {
        table = [pupil(P1), pupil(P2, { studentGroupId: CLASS_B })];

        await service.bulkUpdateStudents({ ids: [P2, P1], changes: { studentGroupId: CLASS_A }, dryRun: false }, user);

        // The one order of groups and pupils: a delete of the class holds it
        // and then empties its pupils, so the move holds it first too.
        expect(lockOrder()).toEqual([PEOPLE_LOCK, CLASS_SHARED]);
        const classHeld = tx.$executeRaw.mock.calls.findIndex((call) => rawSql(call).includes('FOR SHARE'));
        expect((tx.$executeRaw.mock.calls[classHeld]![0] as { values: unknown[] }).values).toEqual([[CLASS_A]]);
        expect(tx.$executeRaw.mock.invocationCallOrder[classHeld]!).toBeLessThan(queryRaw.mock.invocationCallOrder[0]!);
        expect(queryRaw.mock.invocationCallOrder[0]!).toBeLessThan(tx.studentGroup.findUnique.mock.invocationCallOrder[0]!);
      });

      it('holds no class for a status, nor for Ingen klass', async () => {
        await service.bulkUpdateStudents({ ids: [P1], changes: { isActive: false }, dryRun: false }, user);
        await service.bulkUpdateStudents({ ids: [P1], changes: { studentGroupId: null }, dryRun: false }, user);

        expect(lockOrder()).toEqual([PEOPLE_LOCK, PEOPLE_LOCK]);
      });

      it('sets the status alone without asking about any class', async () => {
        const result = await service.bulkUpdateStudents({ ids: [P1, P2], changes: { isActive: false }, dryRun: false }, user);

        expect(result).toMatchObject({ applied: true, done: [P1, P2] });
        expect(tx.user.updateMany).toHaveBeenCalledWith({ where: { id: { in: [P1, P2] } }, data: { isActive: false } });
        expect(tx.studentGroup.findUnique).not.toHaveBeenCalled();
      });

      it('takes null as a change, "no class", and asks about no class for it', async () => {
        table = [pupil(P1, { studentGroupId: CLASS_A }), pupil(P2)];

        await service.bulkUpdateStudents({ ids: [P1, P2], changes: { studentGroupId: null }, dryRun: false }, user);

        // P2 is in no class already: not written.
        expect(tx.user.updateMany).toHaveBeenCalledWith({ where: { id: { in: [P1] } }, data: { studentGroupId: null } });
        expect(tx.studentGroup.findUnique).not.toHaveBeenCalled();
      });

      it('does not write a pupil already in the class and status asked: updatedAt and the class history stay', async () => {
        table = [pupil(P1, { studentGroupId: CLASS_A }), pupil(P2), pupil(P3, { studentGroupId: CLASS_A, isActive: false })];

        const result = await service.bulkUpdateStudents({ ids: [P1, P2, P3], changes: { studentGroupId: CLASS_A }, dryRun: false }, user);
        expect(tx.user.updateMany).toHaveBeenLastCalledWith({
          where: { id: { in: [P2] } },
          data: { studentGroupId: CLASS_A },
        });
        // Judged all the same: the pupil who is there already is done, not skipped.
        expect(result.done).toEqual([P1, P2, P3]);

        // Both fields: a pupil who differs in either is written, with both.
        await service.bulkUpdateStudents({ ids: [P1, P3], changes: { studentGroupId: CLASS_A, isActive: true }, dryRun: false }, user);
        expect(tx.user.updateMany).toHaveBeenLastCalledWith({
          where: { id: { in: [P3] } },
          data: { studentGroupId: CLASS_A, isActive: true },
        });
      });

      it('writes nothing, and says applied, when every pupil is as asked already', async () => {
        table = [pupil(P1, { studentGroupId: CLASS_A }), pupil(P2, { studentGroupId: CLASS_A })];

        const result = await service.bulkUpdateStudents({ ids: [P1, P2], changes: { studentGroupId: CLASS_A }, dryRun: false }, user);

        expect(result).toEqual({ applied: true, dryRun: false, done: [P1, P2], refused: [] });
        expect(tx.user.updateMany).not.toHaveBeenCalled();
        // And nobody is moved, so the class is not asked about either.
        expect(tx.studentGroup.findUnique).not.toHaveBeenCalled();
        expect(told()).toEqual([]);
      });

      it('asks once whether the class is a class, and refuses a teaching group for the whole call, writing nothing', async () => {
        await service.bulkUpdateStudents({ ids: [P1, P2, P3], changes: { studentGroupId: CLASS_A }, dryRun: false }, user);
        expect(tx.studentGroup.findUnique).toHaveBeenCalledTimes(1);
        expect(tx.studentGroup.findUnique).toHaveBeenCalledWith({ where: { id: CLASS_A }, select: { kind: true } });

        tx.user.updateMany.mockClear();
        queryRaw.mockClear();
        tx.studentGroup.findUnique.mockResolvedValue({ kind: 'TEACHING_GROUP' });
        table = [pupil(P1), pupil(P2)];
        await expect(
          service.bulkUpdateStudents({ ids: [P1, P2], changes: { studentGroupId: CLASS_B }, dryRun: false }, user),
        ).rejects.toMatchObject({ status: 400, response: { code: 'STUDENT_HOME_GROUP_NOT_A_CLASS' } });
        expect(tx.user.updateMany).not.toHaveBeenCalled();
        expect(told()).toEqual([]);
      });

      it('refuses a member of staff, a administrator and a guardian as no pupil, and writes nothing', async () => {
        table = [pupil(P1), staff(TEACHER, 'TEACHER'), staff(P2, 'SCHOOL_ADMIN'), staff(P3, 'GUARDIAN')];

        const result = await service.bulkUpdateStudents({ ids: [P1, P2, P3, TEACHER], changes: { isActive: false }, dryRun: false }, user);

        expect(result).toEqual({
          applied: false,
          dryRun: false,
          done: [P1],
          refused: [P2, P3, TEACHER].map((id) => ({ id, code: 'NOT_A_STUDENT', message: NOT_A_STUDENT_SENTENCE })),
        });
        // The pupil that passed was written in the transaction and rolled back with it; no other row was offered.
        expect(tx.user.updateMany).toHaveBeenCalledWith({ where: { id: { in: [P1] } }, data: { isActive: false } });
        await expectRolledBack();
      });

      it('names an id that is not there', async () => {
        const result = await service.bulkUpdateStudents({ ids: [P1, MISSING], changes: { isActive: false }, dryRun: false }, user);

        expect(result).toEqual({ applied: false, dryRun: false, done: [P1], refused: [{ id: MISSING, ...NOT_FOUND }] });
        await expectRolledBack();
      });

      it('moves a pseudonymised pupil to another class: the refusal is for making them active, not for a class change', async () => {
        table = [pupil(P1, { pseudonymisedAt: new Date('2026-07-01T00:00:00Z'), isActive: false, studentGroupId: CLASS_B })];

        const result = await service.bulkUpdateStudents({ ids: [P1], changes: { studentGroupId: CLASS_A }, dryRun: false }, user);

        expect(result).toEqual({ applied: true, dryRun: false, done: [P1], refused: [] });
        expect(tx.user.updateMany).toHaveBeenCalledWith({ where: { id: { in: [P1] } }, data: { studentGroupId: CLASS_A } });
      });

      it('answers 400 for the whole call, writing nothing, when the class is none of the school\'s', async () => {
        tx.studentGroup.findUnique.mockResolvedValue(null);

        await expect(
          service.bulkUpdateStudents({ ids: [P1, P2], changes: { studentGroupId: CLASS_A }, dryRun: false }, user),
        ).rejects.toThrow(BadRequestException);
        expect(tx.user.updateMany).not.toHaveBeenCalled();
      });

      it('refuses to make a pseudonymised pupil active, naming the way out, and lets everything else be done to them', async () => {
        table = [pupil(P1), pupil(P2, { pseudonymisedAt: new Date('2026-10-21T01:10:00Z'), isActive: false })];

        const result = await service.bulkUpdateStudents({ ids: [P1, P2], changes: { isActive: true }, dryRun: false }, user);

        expect(result).toEqual({
          applied: false,
          dryRun: false,
          done: [P1],
          refused: [
            {
              id: P2,
              code: 'USER_IS_PSEUDONYMISED',
              message:
                'Personen är pseudonymiserad efter skolans gallringsbeslut och kan inte aktiveras igen. Lägg till personen på nytt.',
            },
          ],
        });
        await expectRolledBack();

        // Made inactive or moved to a class they are not refused: the rule is about being made active.
        const other = await service.bulkUpdateStudents({ ids: [P1, P2], changes: { studentGroupId: CLASS_A }, dryRun: false }, user);
        expect(other).toMatchObject({ applied: true, done: [P1, P2], refused: [] });
        const inactive = await service.bulkUpdateStudents({ ids: [P2], changes: { isActive: false }, dryRun: false }, user);
        expect(inactive).toMatchObject({ applied: true, done: [P2], refused: [] });
      });

      it('names the pupil the database refused when it refuses the statement, trying the pupils one by one', async () => {
        const classIsNotTheSchools = new Prisma.PrismaClientKnownRequestError('Foreign key constraint violated', {
          code: 'P2003',
          clientVersion: Prisma.prismaVersion.client,
          meta: {
            modelName: 'User',
            driverAdapterError: {
              cause: {
                originalMessage:
                  'insert or update on table "Users" violates foreign key constraint "Users_studentGroupId_fkey"',
                constraint: { index: 'Users_studentGroupId_fkey' },
              },
            },
          },
        });
        tx.user.updateMany.mockRejectedValue(classIsNotTheSchools);
        tx.user.update.mockImplementation(({ where }: { where: { id: string } }) =>
          where.id === P2 ? Promise.reject(classIsNotTheSchools) : Promise.resolve({ id: where.id }),
        );

        const result = await service.bulkUpdateStudents({ ids: [P1, P2, P3], changes: { studentGroupId: CLASS_A }, dryRun: false }, user);

        expect(result).toEqual({
          applied: false,
          dryRun: false,
          done: [P1, P3],
          refused: [{ id: P2, code: null, message: 'studentGroupId: klassen finns inte i skolan.' }],
        });
        expect(tx.user.update.mock.calls.map(([args]) => (args as { where: { id: string } }).where.id)).toEqual([P1, P2, P3]);
        expect(told()).toEqual([]);
        await expectRolledBack();
      });

      it('on a dry run does the work and rolls it back, saying what would be done, and tells the mentors nothing', async () => {
        const result = await service.bulkUpdateStudents(
          { ids: [P1, P2], changes: { studentGroupId: CLASS_A }, dryRun: true },
          user,
        );

        expect(result).toEqual({ applied: false, dryRun: true, done: [P1, P2], refused: [] });
        expect(tx.user.updateMany).toHaveBeenCalledWith({ where: { id: { in: [P1, P2] } }, data: { studentGroupId: CLASS_A } });
        expect(told()).toEqual([]);
        expect(deliver).not.toHaveBeenCalled();
        expect(recordedReads(tx)).toEqual([]);
        await expectRolledBack();
      });

      it('rethrows a failure that is no pupil’s refusal: the call fails, it is not a report', async () => {
        tx.user.updateMany.mockRejectedValue(new Error('connection reset'));

        await expect(service.bulkUpdateStudents({ ids: [P1], changes: { isActive: false }, dryRun: false }, user)).rejects.toThrow(
          'connection reset',
        );
        expect(tx.user.update).not.toHaveBeenCalled();
      });

      // A move, a reactivation or a deactivation changes who a pupil's mentor is
      // told about (app.leave_school_days), as update() tells them.
      describe('the mentors, told once after every pupil', () => {
        it('tells them once for the whole call, after the last statement, in its transaction', async () => {
          const ranIn = transactionsOf(prisma);
          const toldIn = ranIn(queryRaw);
          const writtenIn = ranIn(tx.user.updateMany);

          await service.bulkUpdateStudents({ ids: [P1, P2, P3], changes: { studentGroupId: CLASS_A }, dryRun: false }, user);

          expect(told()).toHaveLength(1);
          const at = queryRaw.mock.invocationCallOrder[queryRaw.mock.calls.findIndex((call) => rawSql(call).includes(TELL))]!;
          const writes = tx.user.updateMany.mock.invocationCallOrder;
          expect(at).toBeGreaterThan(writes[writes.length - 1]!);
          expect(new Set([...toldIn, ...writtenIn]).size).toBe(1);
          expect(deliver).toHaveBeenCalledTimes(1);
          expect(deliver).toHaveBeenCalledWith(
            tx,
            expect.objectContaining({
              schoolId: SCHOOL_ID,
              type: 'LEAVE_REQUESTED',
              recipients: [{ userId: MENTOR, notificationId: NOTICE }],
            }),
          );
        });

        it('tells them of a status change as well as of a class move', async () => {
          table = [pupil(P1, { isActive: false })];
          await service.bulkUpdateStudents({ ids: [P1], changes: { isActive: true }, dryRun: false }, user);
          expect(told()).toHaveLength(1);
        });

        it('tells nobody when no pupil moves, or when a row is refused', async () => {
          table = [pupil(P1, { studentGroupId: CLASS_A }), pupil(P2), staff(TEACHER, 'TEACHER')];

          await service.bulkUpdateStudents({ ids: [P1], changes: { studentGroupId: CLASS_A }, dryRun: false }, user);
          await service.bulkUpdateStudents({ ids: [P2, TEACHER], changes: { studentGroupId: CLASS_A }, dryRun: false }, user);

          expect(told()).toEqual([]);
          expect(deliver).not.toHaveBeenCalled();
        });
      });
    });

    describe('bulkRemoveStudents', () => {
      /** What the counts of the dry run answer, per model. */
      const KEY_COUNTS = {
        'StudentGroupMembers.studentId': 5,
        'StudentEnrollments.studentId': 6,
        'GuardianStudents.studentId': 3,
        'AbsenceReports.studentId': 20,
        'LeaveRequests.studentId': 2,
        'AttendanceRecords.studentId': 400,
        'MasterLessonStudents.studentId': 4,
        'CalendarLessonStudents.studentId': 30,
        'TimplanStatements.studentId': 2,
        // otherRows: their role history; otherLinks: an attendance mark one of them recorded.
        'UserRoleChanges.userId': 2,
        'AttendanceRecords.recordedById': 1,
      };
      const givenCounts = () => {
        keyCounts = { ...KEY_COUNTS };
      };
      /** The count statements sent: their SQL, the transaction each ran in and the ids each named. */
      const countsSent = (ranIn: (string | undefined)[]) =>
        queryRaw.mock.calls.flatMap((call, index) => {
          const sql = rawSql(call);
          return sql.startsWith('SELECT count(*)')
            ? [{ sql, transaction: ranIn[index], ids: (call[0] as { values: unknown[] }).values }]
            : [];
        });
      /** What the second transaction of a dry run reads the pupils from: the table, as `select` has it. */
      const givenPupilsToCount = () =>
        tx.user.findMany.mockImplementation(({ where, select }: { where: { id: { in: string[] } }; select: Record<string, unknown> }) =>
          Promise.resolve(table.filter((row) => where.id.in.includes(row['id'] as string)).map((row) => asSelected(row, select))),
        );

      const decidedPlan = (name: string, overrides: Record<string, unknown> = {}) => ({
        name,
        decidedByUserId: null,
        gradeSpanSetByUserId: null,
        ...overrides,
      });
      const timplanSentence = (which: string, what: string) =>
        `Personen står som den som registrerade ${what} ${which} och kan inte tas bort. ` +
        'Inaktivera kontot i stället; beslutet behåller sitt namn.';

      beforeEach(() => {
        givenReadsUnder('FOR UPDATE');
        table = [
          pupil(P1, { authId: AUTH_1, invitedAt: new Date('2026-08-01T00:00:00Z'), ss12000Id: 'ss-1' }),
          pupil(P2, { authId: AUTH_2, invitedAt: new Date('2026-08-02T00:00:00Z') }),
          pupil(P3, { authId: AUTH_3, invitedAt: null }),
          staff(TEACHER, 'TEACHER'),
        ];
      });

      it('locks the pupils FOR UPDATE once each, in id order, and asks the questions of the pupils alone', async () => {
        await service.bulkRemoveStudents({ ids: [TEACHER, P2, P1, P2], dryRun: false }, user);

        expect(queryRaw.mock.calls[0]!.slice(1)).toEqual([[P1, P2, TEACHER]]);
        expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function), { timeoutMs: BULK_TIMEOUT_MS });
        expect(tx.localTimplan.findMany).toHaveBeenCalledWith({
          where: { OR: [{ decidedByUserId: { in: [P1, P2] } }, { gradeSpanSetByUserId: { in: [P1, P2] } }] },
          select: { name: true, decidedByUserId: true, gradeSpanSetByUserId: true },
          orderBy: { name: 'asc' },
        });
        expect(tx.supervisionCover.findMany).toHaveBeenCalledWith({
          where: { absentTeacherId: { in: [P1, P2] }, decision: 'SUBSTITUTE', endsAt: { gt: expect.any(Date) } },
          select: { absentTeacherId: true, date: true },
          orderBy: { date: 'asc' },
        });
      });

      it('deletes the pupils in one statement, counts nothing, and takes no cover lock a pupil has no use for', async () => {
        const result = await service.bulkRemoveStudents({ ids: [P2, P1, P3], dryRun: false }, user);

        // The school's lock before the pupils' rows (src/common/lock-order.ts).
        expect(lockOrder()).toEqual([PEOPLE_LOCK]);
        const held = tx.$executeRaw.mock.calls.findIndex((call) => rawSql(call).includes('pg_advisory'));
        expect(tx.$executeRaw.mock.invocationCallOrder[held]!).toBeLessThan(queryRaw.mock.invocationCallOrder[0]!);

        expect(result).toEqual({ applied: true, dryRun: false, done: [P1, P2, P3], refused: [] });
        expect(result).not.toHaveProperty('consequences');
        expect(tx.user.deleteMany).toHaveBeenCalledTimes(1);
        expect(tx.user.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [P1, P2, P3] } } });
        expect(savepoints()).toEqual(['SAVEPOINT bulk_whole', 'RELEASE SAVEPOINT bulk_whole']);
        // A real call is no read of the pupils: it counts nothing and records nothing.
        expect(prisma.withRls).toHaveBeenCalledTimes(1);
        expect(queryRaw.mock.calls.some((call) => rawSql(call).startsWith('SELECT count(*)'))).toBe(false);
        expect(recordedReads(tx)).toEqual([]);
        expect(tx.$executeRaw.mock.calls.some((call) => rawSql(call).includes("'cover-teacher:'"))).toBe(false);
        await expectCommitted();
      });

      it('refuses a member of staff as no pupil, and a missing id, and deletes nothing', async () => {
        const result = await service.bulkRemoveStudents({ ids: [P1, TEACHER, MISSING], dryRun: false }, user);

        expect(result).toEqual({
          applied: false,
          dryRun: false,
          done: [P1],
          // In id order, whatever the reason.
          refused: [
            { id: TEACHER, code: 'NOT_A_STUDENT', message: NOT_A_STUDENT_SENTENCE },
            { id: MISSING, ...NOT_FOUND },
          ],
        });
        // Only the pupil was offered to the delete, which the body’s throw rolls back.
        expect(tx.user.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [P1] } } });
        await expectRolledBack();
      });

      it('refuses a pupil a decided timplan names, in the sentence remove() gives, naming the plans', async () => {
        tx.localTimplan.findMany.mockResolvedValue([
          decidedPlan('Grundskolan 2024', { decidedByUserId: P1 }),
          decidedPlan('Grundskolan 2025', { decidedByUserId: 'someone-else', gradeSpanSetByUserId: P2 }),
        ]);

        const result = await service.bulkRemoveStudents({ ids: [P1, P2, P3], dryRun: false }, user);

        expect(result.refused).toEqual([
          {
            id: P1,
            code: null,
            message: timplanSentence('den beslutade lokala timplanen "Grundskolan 2024"', 'beslutet om'),
          },
          {
            id: P2,
            code: null,
            message: timplanSentence('den beslutade lokala timplanen "Grundskolan 2025"', 'årskurspannet för'),
          },
        ]);
        expect(result).toMatchObject({ applied: false, done: [P3] });
        expect(tx.user.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [P3] } } });
        await expectRolledBack();

        // The very words of the single route, asked of the same plans.
        tx.user.findUnique.mockResolvedValue({ authId: AUTH_1, invitedAt: null, role: 'STUDENT' });
        tx.localTimplan.findMany.mockResolvedValue([decidedPlan('Grundskolan 2024', { decidedByUserId: P1 })]);
        const single = await service.remove(P1, user).catch((e: unknown) => e);
        expect(single).toBeInstanceOf(ConflictException);
        expect((single as ConflictException).message).toBe(result.refused[0]!.message);
      });

      it('names both when one pupil decided a plan and set another’s span', async () => {
        tx.localTimplan.findMany.mockResolvedValue([
          decidedPlan('A', { decidedByUserId: P1 }),
          decidedPlan('B', { gradeSpanSetByUserId: P1 }),
        ]);

        const result = await service.bulkRemoveStudents({ ids: [P1], dryRun: false }, user);

        expect(result.refused).toEqual([
          {
            id: P1,
            code: null,
            message: timplanSentence('de beslutade lokala timplanerna "A" och "B"', 'beslutet eller årskurspannet för'),
          },
        ]);
      });

      it('refuses a pupil whose rastvaktspass has a vikarie booked ahead, with the date, as the single route does', async () => {
        tx.supervisionCover.findMany.mockResolvedValue([
          { absentTeacherId: P2, date: new Date('2030-09-02T00:00:00.000Z') },
          { absentTeacherId: P2, date: new Date('2030-09-09T00:00:00.000Z') },
        ]);

        const result = await service.bulkRemoveStudents({ ids: [P1, P2], dryRun: false }, user);

        expect(result.refused).toEqual([
          {
            id: P2,
            code: 'USER_HAS_BOOKED_PASS_COVERS',
            message:
              'Personens rastvaktspass har en inbokad vikarie framåt, första gången 2030-09-02. ' +
              'Ångra besluten på vikarietavlan först, så att vikarien får veta det.',
            params: { date: '2030-09-02' },
          },
        ]);
        expect(result).toMatchObject({ applied: false, done: [P1] });
      });

      it('gives a pupil with both a decided plan and a booked pass the plan, as remove() asks first', async () => {
        tx.localTimplan.findMany.mockResolvedValue([decidedPlan('A', { decidedByUserId: P1 })]);
        tx.supervisionCover.findMany.mockResolvedValue([{ absentTeacherId: P1, date: new Date('2030-09-02T00:00:00.000Z') }]);

        const result = await service.bulkRemoveStudents({ ids: [P1], dryRun: false }, user);

        expect(result.refused).toHaveLength(1);
        expect(result.refused[0]!.code).toBeNull();
        expect(result.refused[0]!.message).toContain('beslutet om den beslutade lokala timplanen "A"');
      });

      it.each([
        ['decider', 'LocalTimplans_decidedByUserId_schoolId_fkey', 'beslutet om'],
        ['span', 'LocalTimplans_gradeSpanSetByUserId_schoolId_fkey', 'årskurspannet för'],
      ])('lists the pupil the %s key refuses when a plan is decided after the question, trying the pupils one by one', async (_which, constraint, what) => {
        const restrict = new Prisma.PrismaClientKnownRequestError('Foreign key constraint violated', {
          code: 'P2003',
          clientVersion: Prisma.prismaVersion.client,
          meta: { modelName: 'User', driverAdapterError: { cause: { constraint: { index: constraint } } } },
        });
        tx.user.deleteMany.mockRejectedValue(restrict);
        tx.user.delete.mockImplementation(({ where }: { where: { id: string } }) =>
          where.id === P2 ? Promise.reject(restrict) : Promise.resolve({ id: where.id }),
        );

        const result = await service.bulkRemoveStudents({ ids: [P1, P2, P3], dryRun: false }, user);

        expect(result).toEqual({
          applied: false,
          dryRun: false,
          done: [P1, P3],
          refused: [{ id: P2, code: null, message: timplanSentence('en beslutad lokal timplan', what) }],
        });
        expect(tx.user.delete.mock.calls.map(([args]) => (args as { where: { id: string } }).where.id)).toEqual([P1, P2, P3]);
        await afterCommit();
        expect(prisma.onCommit).not.toHaveBeenCalled();
        expect(supabaseAdmin.deleteUser).not.toHaveBeenCalled();
        await expectRolledBack();
      });

      it('fails the call, with its own answer, when the database’s error is no pupil’s refusal', async () => {
        tx.user.deleteMany.mockRejectedValue(new Error('connection reset'));

        await expect(service.bulkRemoveStudents({ ids: [P1], dryRun: false }, user)).rejects.toThrow('connection reset');
        expect(tx.user.delete).not.toHaveBeenCalled();
        await afterCommit();
        expect(supabaseAdmin.deleteUser).not.toHaveBeenCalled();
      });

      describe('the confirmation binds the counts (expected)', () => {
        const confirmed = {
          memberships: 5, enrolments: 6, guardianLinks: 3, absenceReports: 20, leaveRequests: 2, attendanceMarks: 400,
          lessonParticipations: 34, teachingTimeStatements: 2, otherRows: 2, otherLinks: 1,
        };

        it('deletes when nothing grew since the dry run, recording no read: the counts it compared are not answered', async () => {
          givenCounts();

          const result = await service.bulkRemoveStudents({ ids: [P1, P2], dryRun: false, expected: confirmed }, user);

          expect(result).toEqual({ applied: true, dryRun: false, done: [P1, P2], refused: [] });
          expect(tx.user.deleteMany).toHaveBeenCalledTimes(1);
          expect(recordedReads(tx)).toEqual([]);
          expect(prisma.withRls).toHaveBeenCalledTimes(1);
        });

        it('deletes nothing when a kind grew, and answers the new counts read and recorded in a transaction of their own', async () => {
          givenCounts();
          givenPupilsToCount();

          const result = await service.bulkRemoveStudents(
            { ids: [P1, P2], dryRun: false, expected: { ...confirmed, absenceReports: 19 } },
            user,
          );

          expect(result).toMatchObject({
            applied: false,
            dryRun: false,
            done: [P1, P2],
            refused: [],
            consequencesGrew: ['absenceReports'],
            consequences: expect.objectContaining({ absenceReports: 20 }),
          });
          expect(tx.user.deleteMany).not.toHaveBeenCalled();
          expect(prisma.withRls).toHaveBeenCalledTimes(2);
          await expect(prisma.withRls.mock.results[0]!.value).rejects.toThrow();
          expect(recordedReads(tx).map((read) => read.kind)).toContain('ABSENCE_REPORTS');
          await afterCommit();
          expect(supabaseAdmin.deleteUser).not.toHaveBeenCalled();
        });
      });

      describe('a dry run', () => {
        beforeEach(() => {
          givenReadsUnder('no lock');
          givenCounts();
        });

        it('judges and counts in one transaction that deletes nothing, holds no row, and commits with the reads it counts', async () => {
          const app = testUser({ channel: 'APP' });

          const result = await service.bulkRemoveStudents({ ids: [TEACHER, P2, P1], dryRun: true }, app);

          expect(result).toEqual({
            applied: false,
            dryRun: true,
            done: [P1, P2],
            refused: [{ id: TEACHER, code: 'NOT_A_STUDENT', message: NOT_A_STUDENT_SENTENCE }],
            consequences: {
              memberships: 5,
              enrolments: 6,
              guardianLinks: 3,
              absenceReports: 20,
              leaveRequests: 2,
              attendanceMarks: 400,
              lessonParticipations: 34,
              teachingTimeStatements: 2,
              otherRows: 2,
              otherLinks: 1,
              logins: 2,
              fromSource: 1,
            },
          });
          // One transaction, which commits: nothing in it to roll back, and
          // its läslogg rows kept (src/common/bulk.ts, A DELETE'S DRY RUN
          // DELETES NOTHING).
          expect(prisma.withRls).toHaveBeenCalledTimes(1);
          await expect(prisma.withRls.mock.results[0]!.value).resolves.toMatchObject({ dryRun: true });
          expect(tx.user.deleteMany).not.toHaveBeenCalled();
          expect(tx.user.delete).not.toHaveBeenCalled();
          // No row held: the read is unlocked (givenReadsUnder) and no lock is sent.
          expect(lockOrder()).toEqual([]);
          // The same checks as the real call's, of the pupils alone.
          expect(tx.localTimplan.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { OR: [{ decidedByUserId: { in: [P1, P2] } }, { gradeSpanSetByUserId: { in: [P1, P2] } }] } }),
          );
          const counts = countsSent(queryRaw.mock.calls.map(() => undefined));
          expect(counts.length).toBeGreaterThan(30);
          for (const count of counts) expect(count.ids.every((ids) => JSON.stringify(ids) === JSON.stringify([P1, P2]))).toBe(true);
          // Nothing of their accounts, which no administrator reads, is counted.
          for (const table of ['Notifications', 'NotificationOptOuts', 'DevicePushTokens', 'LeaveRequestNotices', 'CalendarFeeds']) {
            expect(counts.some((count) => count.sql.includes(`"${table}"`))).toBe(false);
          }
          // Each kind of fact counted about them is a read of them in the läslogg, by the channel the caller came by.
          expect(recordedReads(tx)).toEqual(
            ['ROSTER', 'GUARDIANS', 'ABSENCE_REPORTS', 'LEAVE_REQUESTS', 'ATTENDANCE', 'TEACHING_TIME'].map((kind) => ({
              kind,
              channel: 'APP',
              ids: [P1, P2],
            })),
          );
        });

        it('refuses as the real call does: a pupil a decided timplan names', async () => {
          tx.localTimplan.findMany.mockResolvedValue([decidedPlan('Grundskolan 2024', { decidedByUserId: P1 })]);

          const result = await service.bulkRemoveStudents({ ids: [P1, P2], dryRun: true }, user);

          expect(result.done).toEqual([P2]);
          expect(result.refused).toEqual([
            { id: P1, code: null, message: timplanSentence('den beslutade lokala timplanen "Grundskolan 2024"', 'beslutet om') },
          ]);
        });

        it('asks the provider for nothing, then or after, and takes no login from anyone', async () => {
          await service.bulkRemoveStudents({ ids: [P1, P2], dryRun: true }, user);
          await afterCommit();

          expect(prisma.onCommit).not.toHaveBeenCalled();
          expect(supabaseAdmin.deleteUser).not.toHaveBeenCalled();
        });

        it('counts nothing and records no read when no pupil would be removed', async () => {
          const result = await service.bulkRemoveStudents({ ids: [TEACHER, MISSING], dryRun: true }, user);

          expect(result).toMatchObject({
            applied: false,
            dryRun: true,
            done: [],
            refused: [
              { id: TEACHER, code: 'NOT_A_STUDENT', message: NOT_A_STUDENT_SENTENCE },
              { id: MISSING, ...NOT_FOUND },
            ],
          });
          expect(Object.values(result.consequences!).every((count) => count === 0)).toBe(true);
          expect(queryRaw.mock.calls.some((call) => rawSql(call).startsWith('SELECT count(*)'))).toBe(false);
          expect(prisma.withRls).toHaveBeenCalledTimes(1);
          expect(recordedReads(tx)).toEqual([]);
        });
      });

      describe('the logins of the invited', () => {
        it('goes after the commit, not before the answer, for the invited pupils only', async () => {
          const result = await service.bulkRemoveStudents({ ids: [P1, P2, P3], dryRun: false }, user);

          expect(result.applied).toBe(true);
          expect(prisma.onCommit).toHaveBeenCalledTimes(1);
          expect(prisma.onCommit).toHaveBeenCalledWith(tx, expect.any(Function));
          // Not held against the request: the answer is out before the provider is asked.
          expect(supabaseAdmin.deleteUser).not.toHaveBeenCalled();

          await afterCommit();

          expect(supabaseAdmin.deleteUser.mock.calls).toEqual([[AUTH_1], [AUTH_2]]);
          expect(supabaseAdmin.deleteUser.mock.invocationCallOrder[0]!).toBeGreaterThan(
            tx.user.deleteMany.mock.invocationCallOrder[0]!,
          );
        });

        it('keeps a login another school’s row holds, asking after the delete with no row excepted', async () => {
          heldLogins = new Set([AUTH_1]);

          await service.bulkRemoveStudents({ ids: [P1, P2], dryRun: false }, user);
          await afterCommit();

          expect(supabaseAdmin.deleteUser.mock.calls).toEqual([[AUTH_2]]);
          const asked = queryRaw.mock.calls.filter((call) => rawSql(call).includes(HELD));
          expect(asked.map((call) => call.slice(1))).toEqual([
            [AUTH_1, null],
            [AUTH_2, null],
          ]);
          expect(asked[0] && queryRaw.mock.invocationCallOrder[queryRaw.mock.calls.indexOf(asked[0])]!).toBeGreaterThan(
            tx.user.deleteMany.mock.invocationCallOrder[0]!,
          );
        });

        it('keeps every login it cannot ask about', async () => {
          jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
          heldLogins = 'fails';

          await service.bulkRemoveStudents({ ids: [P1, P2], dryRun: false }, user);
          await afterCommit();

          expect(supabaseAdmin.deleteUser).not.toHaveBeenCalled();
        });

        it('goes on with the rest when the provider fails one, and logs how many failed', async () => {
          const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
          supabaseAdmin.deleteUser.mockRejectedValueOnce(new Error('gotrue down'));

          const result = await service.bulkRemoveStudents({ ids: [P1, P2], dryRun: false }, user);
          await afterCommit();

          // The rows are gone whatever the provider says.
          expect(result.applied).toBe(true);
          expect(supabaseAdmin.deleteUser.mock.calls).toEqual([[AUTH_1], [AUTH_2]]);
          expect(warn).toHaveBeenCalledWith('Failed to delete 1 Supabase identities for removed users.');
        });

        it('asks the provider for nothing when nobody removed was invited, or when a row is refused', async () => {
          await service.bulkRemoveStudents({ ids: [P3], dryRun: false }, user);
          await afterCommit();
          expect(prisma.onCommit).not.toHaveBeenCalled();

          // One row refused: nothing is removed, and nothing is asked of the provider.
          await service.bulkRemoveStudents({ ids: [P1, P2, TEACHER], dryRun: false }, user);
          await afterCommit();
          expect(prisma.onCommit).not.toHaveBeenCalled();
          expect(supabaseAdmin.deleteUser).not.toHaveBeenCalled();
        });
      });
    });
  });

  /**
   * Roller i skolan: an administrator, and anybody's role, profile and
   * HR-läs, are rektor's or a full administrator's to change, and the school
   * always keeps one of them. The database holds the same
   * (Users_administrators_are_decided, section 108); these are the 403s and
   * 409s that say so first.
   */
  describe('roles and profiles', () => {
    const USERS: LockedTable = {
      name: 'Users',
      columns: ['role', 'studentGroupId', 'pseudonymisedAt', 'adminProfile', 'hrRead', 'isActive', 'schoolId'],
      lock: 'FOR NO KEY UPDATE',
    };
    const expedition = testUser({ adminProfile: 'EXPEDITION' });
    const rektor = testUser({ adminProfile: 'REKTOR' });
    let stored: Record<string, unknown>;
    let otherDeciders: { id: string }[];

    beforeEach(() => {
      stored = {
        id: USER_ID,
        role: UserRole.TEACHER,
        studentGroupId: null,
        pseudonymisedAt: null,
        adminProfile: null,
        hrRead: false,
        isActive: true,
        schoolId: SCHOOL_ID,
      };
      otherDeciders = [{ id: 'another-decider' }];
      Object.assign(tx, {
        $queryRaw: jest.fn((...call: unknown[]) =>
          Promise.resolve(
            rawSql(call).includes(`"adminProfile" IN ('FULL', 'REKTOR')`)
              ? otherDeciders
              : lockingRead(USERS, [stored], call),
          ),
        ),
      });
      tx.user.update.mockResolvedValue({ id: USER_ID });
      tx.user.create.mockResolvedValue({ id: USER_ID });
    });

    it('lets the expedition add a teacher, and refuses it an administrator', async () => {
      await service.create(createDto(), expedition);
      expect(tx.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ role: UserRole.TEACHER, adminProfile: null, hrRead: false }),
      });

      tx.user.create.mockClear();
      await expect(
        service.create(createDto({ role: UserRole.SCHOOL_ADMIN, adminProfile: 'FULL' }), expedition),
      ).rejects.toMatchObject({ status: 403, response: { code: 'DECISION_NOT_YOURS' } });
      expect(tx.user.create).not.toHaveBeenCalled();
    });

    it("writes rektor's new administrator with the chosen profile, and FULL when none is named", async () => {
      await service.create(
        createDto({ role: UserRole.SCHOOL_ADMIN, adminProfile: 'SCHEMALAGGARE', hrRead: true }),
        rektor,
      );
      expect(tx.user.create).toHaveBeenLastCalledWith({
        data: expect.objectContaining({ role: UserRole.SCHOOL_ADMIN, adminProfile: 'SCHEMALAGGARE', hrRead: true }),
      });
      await service.create(createDto({ role: UserRole.SCHOOL_ADMIN }), rektor);
      expect(tx.user.create).toHaveBeenLastCalledWith({
        data: expect.objectContaining({ adminProfile: 'FULL', hrRead: false }),
      });
    });

    it('refuses a profile on somebody who is not an administrator, and HR-läs where it means nothing', async () => {
      await expect(service.create(createDto({ adminProfile: 'REKTOR' }), rektor)).rejects.toMatchObject({
        status: 400,
      });
      await expect(
        service.create(createDto({ role: UserRole.SCHOOL_ADMIN, adminProfile: 'REKTOR', hrRead: true }), rektor),
      ).rejects.toMatchObject({ status: 400 });
      expect(tx.user.create).not.toHaveBeenCalled();
    });

    it("lets the expedition edit a teacher's details, but not their role", async () => {
      await service.update(USER_ID, { phone: '070-1' }, expedition);
      expect(tx.user.update).toHaveBeenCalledTimes(1);

      await expect(service.update(USER_ID, { role: UserRole.SCHOOL_ADMIN }, expedition)).rejects.toMatchObject({
        status: 403,
        response: { code: 'DECISION_NOT_YOURS' },
      });
      expect(tx.user.update).toHaveBeenCalledTimes(1);
    });

    it("refuses the expedition an administrator's row, even their name", async () => {
      stored = { ...stored, role: UserRole.SCHOOL_ADMIN, adminProfile: 'SCHEMALAGGARE' };
      await expect(service.update(USER_ID, { firstName: 'Ny' }, expedition)).rejects.toMatchObject({
        status: 403,
      });
      expect(tx.user.update).not.toHaveBeenCalled();
    });

    it("writes rektor's change of profile and HR-läs, and only what changed", async () => {
      stored = { ...stored, role: UserRole.SCHOOL_ADMIN, adminProfile: 'EXPEDITION', hrRead: false };
      await service.update(USER_ID, { adminProfile: 'SCHEMALAGGARE', hrRead: true }, rektor);
      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { adminProfile: 'SCHEMALAGGARE', hrRead: true },
      });
    });

    it('takes HR-läs away when a planner becomes rektor, who reads tjänst % anyway', async () => {
      stored = { ...stored, role: UserRole.SCHOOL_ADMIN, adminProfile: 'SCHEMALAGGARE', hrRead: true };
      await service.update(USER_ID, { adminProfile: 'REKTOR' }, rektor);
      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { adminProfile: 'REKTOR', hrRead: false },
      });
    });

    it('keeps one decider: refuses demoting, deactivating or removing the last, and allows it beside another', async () => {
      stored = { ...stored, role: UserRole.SCHOOL_ADMIN, adminProfile: 'FULL' };
      otherDeciders = [{ id: USER_ID }];
      for (const patch of [{ adminProfile: 'EXPEDITION' as const }, { isActive: false }, { role: UserRole.TEACHER }]) {
        await expect(service.update(USER_ID, patch, rektor)).rejects.toMatchObject({
          status: 409,
          response: { code: 'LAST_DECIDER' },
        });
      }
      arrangeUser({ ...stored, authId: AUTH_ID, invitedAt: null });
      await expect(service.remove(USER_ID, rektor)).rejects.toMatchObject({ status: 409 });
      expect(tx.user.update).not.toHaveBeenCalled();
      expect(tx.user.delete).not.toHaveBeenCalled();

      otherDeciders = [{ id: USER_ID }, { id: 'another-decider' }];
      await service.update(USER_ID, { adminProfile: 'EXPEDITION' }, rektor);
      expect(tx.user.update).toHaveBeenCalledTimes(1);
    });

    it("refuses the expedition an administrator's invitation and removal", async () => {
      arrangeUser({ id: USER_ID, email: 'a@b.se', isActive: true, authId: AUTH_ID, invitedAt: null, role: 'SCHOOL_ADMIN' });
      await expect(service.invite(USER_ID, expedition)).rejects.toMatchObject({ status: 403 });
      expect(supabaseAdmin.inviteUser).not.toHaveBeenCalled();
      arrangeUser({ authId: AUTH_ID, invitedAt: null, role: 'SCHOOL_ADMIN', adminProfile: 'SCHEMALAGGARE', isActive: true, schoolId: SCHOOL_ID });
      await expect(service.remove(USER_ID, expedition)).rejects.toMatchObject({ status: 403 });
      expect(tx.user.delete).not.toHaveBeenCalled();
    });

    it("lists the school's administrators with their profile and HR-läs, for any administrator", async () => {
      tx.user.findMany.mockResolvedValue([
        { id: 'a1', adminProfile: 'REKTOR', hrRead: false },
        { id: 'a2', adminProfile: 'SCHEMALAGGARE', hrRead: true },
      ]);
      await expect(service.administrators(expedition)).resolves.toEqual([
        { id: 'a1', adminProfile: 'REKTOR', hrRead: false },
        { id: 'a2', adminProfile: 'SCHEMALAGGARE', hrRead: true },
      ]);
      expect(tx.user.findMany).toHaveBeenCalledWith({
        where: { role: 'SCHOOL_ADMIN' },
        select: { id: true, adminProfile: true, hrRead: true },
        orderBy: { id: 'asc' },
      });
      // Each one's profile and HR-läs, recorded as the role history records them.
      expect(recordedReads(tx)).toEqual([{ kind: 'PEOPLE', channel: null, ids: ['a1', 'a2'] }]);
    });

    it('lists the role history newest first, naming who changed it and nobody for a migration', async () => {
      tx.userRoleChange.findMany.mockResolvedValue([
        { id: 'c2', fromRole: 'SCHOOL_ADMIN', toRole: 'SCHOOL_ADMIN', fromProfile: 'FULL', toProfile: 'EXPEDITION',
          fromHrRead: false, toHrRead: true, actorId: 'actor-1', createdAt: new Date('2026-10-25T09:00:00Z') },
        { id: 'c1', fromRole: null, toRole: 'SCHOOL_ADMIN', fromProfile: null, toProfile: 'FULL',
          fromHrRead: null, toHrRead: false, actorId: null, createdAt: new Date('2026-10-01T09:00:00Z') },
      ]);
      tx.user.findMany.mockResolvedValue([{ id: 'actor-1', firstName: 'Rita', lastName: 'Rektor' }]);

      const changes = await service.roleChanges(USER_ID, expedition);

      expect(tx.userRoleChange.findMany).toHaveBeenCalledWith({
        where: { userId: USER_ID },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      expect(changes.map((c) => [c.id, c.toProfile, c.actorName, c.createdAt])).toEqual([
        ['c2', 'EXPEDITION', 'Rita Rektor', '2026-10-25T09:00:00.000Z'],
        ['c1', 'FULL', null, '2026-10-01T09:00:00.000Z'],
      ]);
      // In the läslogg: the person and the actor it names (PEOPLE).
      expect(recordedReads(tx)).toEqual([{ kind: 'PEOPLE', channel: null, ids: [USER_ID, 'actor-1'] }]);
    });

    it('records nothing for a person without role history', async () => {
      tx.userRoleChange.findMany.mockResolvedValue([]);
      await expect(service.roleChanges(USER_ID, expedition)).resolves.toEqual([]);
      expect(recordedReads(tx)).toEqual([]);
    });
  });
});
