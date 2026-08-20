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
import type { PrismaService } from '../database/prisma.service';
import type { CreateUserDto } from './dto/user.dto';
import type { SupabaseAdminService } from './supabase-admin.service';
import { UsersService } from './users.service';

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

    it('invites first and stamps invitedAt when the admin asks for it', async () => {
      tx.user.create.mockResolvedValue({ id: USER_ID });

      await service.create(createDto({ sendInvitation: true }), testUser());

      expect(supabaseAdmin.inviteUser).toHaveBeenCalledWith('anna@school.se');
      const { data } = tx.user.create.mock.calls[0][0] as {
        data: { authId: string; invitedAt: Date | null };
      };
      expect(data.authId).toBe(AUTH_ID);
      expect(data.invitedAt).toBeInstanceOf(Date);
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
      ).rejects.toThrow(BadRequestException);

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

    it('maps an invite failure to 503 and persists nothing', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      supabaseAdmin.inviteUser.mockRejectedValue(new Error('gotrue down'));

      await expect(
        service.create(createDto({ sendInvitation: true }), testUser()),
      ).rejects.toThrow(ServiceUnavailableException);

      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('refuses an explicit invitation when Supabase is not configured', async () => {
      // Silently creating the row instead would tell the admin an invitation
      // went out when the deployment cannot send one at all.
      supabaseAdmin.isConfigured = false;

      await expect(
        service.create(createDto({ sendInvitation: true }), testUser()),
      ).rejects.toThrow(ServiceUnavailableException);

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
      tx.user.findUnique.mockResolvedValue(target());
      tx.user.update.mockResolvedValue({ id: USER_ID });

      await expect(service.invite(USER_ID, testUser())).resolves.toEqual({
        id: USER_ID,
        emailSent: true,
      });

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
      tx.user.findUnique.mockResolvedValue(target());
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
      tx.user.findUnique.mockResolvedValue(null);

      await expect(service.invite(USER_ID, testUser())).rejects.toThrow(
        NotFoundException,
      );
      expect(supabaseAdmin.inviteUser).not.toHaveBeenCalled();
    });

    it('refuses to invite a deactivated person', async () => {
      tx.user.findUnique.mockResolvedValue(target({ isActive: false }));

      await expect(service.invite(USER_ID, testUser())).rejects.toThrow(
        BadRequestException,
      );
      expect(supabaseAdmin.inviteUser).not.toHaveBeenCalled();
    });

    it('leaves the row untouched when the provider fails', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      tx.user.findUnique.mockResolvedValue(target());
      supabaseAdmin.inviteUser.mockRejectedValue(new Error('gotrue down'));

      await expect(service.invite(USER_ID, testUser())).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(tx.user.update).not.toHaveBeenCalled();
    });

    it('503s before any lookup when invitations are not configured', async () => {
      supabaseAdmin.isConfigured = false;

      await expect(service.invite(USER_ID, testUser())).rejects.toThrow(
        ServiceUnavailableException,
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
      tx.user.findUnique.mockResolvedValue({
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
      tx.user.findUnique.mockResolvedValue({
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
      tx.user.findUnique.mockResolvedValue({
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
      ).rejects.toThrow(BadRequestException);

      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('accepts a group change that does not name a role (current behaviour)', async () => {
      // SUSPECTED GAP (pinned, not fixed): the students-only guard requires
      // `dto.role` to be present, so `{ studentGroupId }` alone bypasses it and
      // can attach a group to a TEACHER/GUARDIAN row. See report.
      tx.user.update.mockResolvedValue({ id: USER_ID });

      await service.update(USER_ID, { studentGroupId: GROUP_ID }, testUser());

      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { studentGroupId: GROUP_ID },
      });
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
      tx.user.findUnique.mockResolvedValue({ authId: AUTH_ID });
      tx.user.delete.mockResolvedValue({ id: USER_ID });
      const user = testUser();

      await expect(service.remove(USER_ID, user)).resolves.toBeUndefined();

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.user.findUnique).toHaveBeenCalledWith({
        where: { id: USER_ID },
        select: { authId: true },
      });
      expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: USER_ID } });
      expect(supabaseAdmin.deleteUser).toHaveBeenCalledWith(AUTH_ID);
    });

    it('404s on an unknown (or other-tenant) user without touching Supabase', async () => {
      tx.user.findUnique.mockResolvedValue(null);

      await expect(service.remove(USER_ID, testUser())).rejects.toThrow(
        NotFoundException,
      );

      expect(tx.user.delete).not.toHaveBeenCalled();
      expect(supabaseAdmin.deleteUser).not.toHaveBeenCalled();
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
