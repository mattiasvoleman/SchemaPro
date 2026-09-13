import { createHash } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type { IntegrationRequest } from './integration-key.guard';
import type { Ss12000Service } from './ss12000.service';
import {
  IntegrationKeysController,
  Ss12000Controller,
} from './integration.controller';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const KEY_ID = '66666666-6666-4666-8666-666666666666';
const CREATED_AT = new Date('2026-08-07T09:00:00.000Z');

describe('IntegrationKeysController', () => {
  let controller: IntegrationKeysController;
  let tx: TxMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    controller = new IntegrationKeysController(prisma as unknown as PrismaService);
  });

  describe('list', () => {
    it('lists the tenant’s keys under the caller’s RLS context, newest first', async () => {
      const rows = [{ id: KEY_ID, name: 'Vklass', lastUsedAt: null, revokedAt: null, createdAt: CREATED_AT }];
      tx.integrationApiKey.findMany.mockResolvedValue(rows);
      const user = testUser();

      await expect(controller.list(user)).resolves.toEqual(rows);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
    });

    it('never selects the key hash', async () => {
      tx.integrationApiKey.findMany.mockResolvedValue([]);

      await controller.list(testUser());

      // Exact match: keyHash absent from the select is the security property.
      expect(tx.integrationApiKey.findMany).toHaveBeenCalledWith({
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          lastUsedAt: true,
          revokedAt: true,
          createdAt: true,
        },
      });
    });
  });

  describe('create', () => {
    beforeEach(() => {
      tx.integrationApiKey.create.mockImplementation(
        ({ data }: { data: { name: string } }) =>
          Promise.resolve({ id: KEY_ID, name: data.name, createdAt: CREATED_AT }),
      );
    });

    it('returns the stored row plus a plaintext key shown exactly once', async () => {
      const result = await controller.create({ name: 'Vklass' }, testUser());

      expect(result).toEqual({
        id: KEY_ID,
        name: 'Vklass',
        createdAt: CREATED_AT,
        key: expect.stringMatching(/^sp_[0-9a-f]{48}$/),
      });
    });

    it('stores only the SHA-256 hash of the returned key, never the plaintext', async () => {
      const result = await controller.create({}, testUser());

      const { data } = tx.integrationApiKey.create.mock.calls[0][0] as {
        data: { keyHash: string };
      };
      expect(data.keyHash).toBe(
        createHash('sha256').update(result.key).digest('hex'),
      );
      expect(JSON.stringify(data)).not.toContain(result.key);
    });

    it('binds the key to the principal’s tenant under their RLS context', async () => {
      const user = testUser({ schoolId: 'school-A', userId: 'admin-1' });

      await controller.create({ name: 'Sync' }, user);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.integrationApiKey.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            schoolId: 'school-A',
            createdById: 'admin-1',
          }),
        }),
      );
    });

    it('403s a principal with no school before touching the database', async () => {
      // The tenant column is required. The controller is SCHOOL_ADMIN-only and
      // JwtStrategy reads schoolId from the Users row, where it is not
      // nullable, so no HTTP caller arrives without one. The check keeps the
      // controller from depending on that, and fails as
      // RoomBookingsService.create does rather than at the insert.
      await expect(
        controller.create({ name: 'Sync' }, testUser({ schoolId: undefined })),
      ).rejects.toThrow(
        new ForbiddenException('No school is associated with this account.'),
      );
      expect(prisma.withRls).not.toHaveBeenCalled();
      expect(tx.integrationApiKey.create).not.toHaveBeenCalled();
    });

    it('stores createdById as null when the token carries no userId', async () => {
      await controller.create({}, testUser({ userId: undefined }));

      expect(tx.integrationApiKey.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ createdById: null }),
        }),
      );
    });

    it.each([
      [{}, 'Integration'],
      [{ name: '   ' }, 'Integration'],
      [{ name: '  Municipal sync  ' }, 'Municipal sync'],
    ])('normalizes the name %j to %j', async (body, expected) => {
      await controller.create(body, testUser());

      expect(tx.integrationApiKey.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ name: expected }),
        }),
      );
    });

    it('truncates an oversized name to 120 characters', async () => {
      await controller.create({ name: 'x'.repeat(300) }, testUser());

      expect(tx.integrationApiKey.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ name: 'x'.repeat(120) }),
        }),
      );
    });

    it('issues a fresh random key per call', async () => {
      const first = await controller.create({}, testUser());
      const second = await controller.create({}, testUser());

      expect(first.key).not.toBe(second.key);
    });
  });

  describe('revoke', () => {
    it('marks the key revoked under the caller’s RLS context and echoes the id', async () => {
      tx.integrationApiKey.update.mockResolvedValue({ id: KEY_ID });
      const user = testUser();

      await expect(controller.revoke(KEY_ID, user)).resolves.toEqual({
        id: KEY_ID,
      });

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.integrationApiKey.update).toHaveBeenCalledWith({
        where: { id: KEY_ID },
        data: { revokedAt: expect.any(Date) },
      });
    });
  });
});

describe('Ss12000Controller', () => {
  let controller: Ss12000Controller;
  let ss12000: {
    organisation: jest.Mock;
    persons: jest.Mock;
    groups: jest.Mock;
    activities: jest.Mock;
    calendarEvents: jest.Mock;
    importPersons: jest.Mock;
  };

  /** A request as IntegrationKeyGuard leaves it: school id already resolved. */
  const req = { integrationSchoolId: SCHOOL_ID } as IntegrationRequest;

  beforeEach(() => {
    ss12000 = {
      organisation: jest.fn().mockResolvedValue({ id: SCHOOL_ID }),
      persons: jest.fn().mockResolvedValue({ data: [] }),
      groups: jest.fn().mockResolvedValue({ data: [] }),
      activities: jest.fn().mockResolvedValue({ data: [] }),
      calendarEvents: jest.fn().mockResolvedValue({ data: [] }),
      importPersons: jest.fn().mockResolvedValue({ updated: 0 }),
    };
    controller = new Ss12000Controller(ss12000 as unknown as Ss12000Service);
  });

  it('serves the organisation of the key’s school', async () => {
    await expect(controller.organisation(req)).resolves.toEqual({
      id: SCHOOL_ID,
    });
    expect(ss12000.organisation).toHaveBeenCalledWith(SCHOOL_ID);
  });

  it('passes paging and role filters through to persons', async () => {
    await controller.persons(req, '25', '50', 'TEACHER');

    expect(ss12000.persons).toHaveBeenCalledWith(
      SCHOOL_ID,
      '25',
      '50',
      'TEACHER',
    );
  });

  it('passes paging through to groups', async () => {
    await controller.groups(req, '10', '20');

    expect(ss12000.groups).toHaveBeenCalledWith(SCHOOL_ID, '10', '20');
  });

  it('passes paging through to activities', async () => {
    await controller.activities(req, '10', '20');

    expect(ss12000.activities).toHaveBeenCalledWith(SCHOOL_ID, '10', '20');
  });

  it('passes the date window and paging through to calendarEvents', async () => {
    await controller.calendarEvents(req, '2026-08-01', '2026-08-31', '10', '0');

    expect(ss12000.calendarEvents).toHaveBeenCalledWith(
      SCHOOL_ID,
      '2026-08-01',
      '2026-08-31',
      '10',
      '0',
    );
  });

  it('forwards the roster payload to importPersons', async () => {
    const persons = [{ email: 'karin@example.test' }];

    await controller.importPersons(req, { persons });

    expect(ss12000.importPersons).toHaveBeenCalledWith(SCHOOL_ID, persons);
  });

  it('defaults a missing persons array to [] (the service then rejects it)', async () => {
    await controller.importPersons(req, {});

    expect(ss12000.importPersons).toHaveBeenCalledWith(SCHOOL_ID, []);
  });
});
