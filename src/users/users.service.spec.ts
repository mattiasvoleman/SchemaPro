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
import { recordedReads } from '../../test/utils/recorded-reads';
import type { PrismaService } from '../database/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { CreateUserDto } from './dto/user.dto';
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
        where: { decidedByUserId: USER_ID },
        select: { name: true },
        orderBy: { name: 'asc' },
      });
      expect(tx.user.delete).not.toHaveBeenCalled();
      expect(supabaseAdmin.deleteUser).not.toHaveBeenCalled();
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
