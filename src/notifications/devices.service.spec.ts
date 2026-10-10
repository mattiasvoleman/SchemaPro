import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { DevicesService, PUSH_DISABLED, PUSH_TOKEN_BUSY } from './devices.service';
import { EXPO_PUSH_TOKEN } from './dto/devices.dto';

const TOKEN = 'ExponentPushToken[abcdefgh1234]';
const ME = '22222222-2222-4222-8222-222222222222';

describe('DevicesService', () => {
  let tx: TxMock;
  let prisma: ReturnType<typeof createPrismaMock>;
  let enabled: boolean;
  const config = { get: (key: string) => (key === 'push' ? { enabled } : undefined) };
  const user = testUser({ role: 'GUARDIAN' as never, userId: ME });

  beforeEach(() => {
    enabled = true;
    tx = createTxMock();
    prisma = createPrismaMock(tx);
  });
  const service = () => new DevicesService(prisma as unknown as PrismaService, config as never);

  it('refuses registration while push is off, before touching the database', async () => {
    enabled = false;
    const error = await service().register({ token: TOKEN, platform: 'IOS', locale: 'sv' }, user).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({ code: PUSH_DISABLED });
    expect(prisma.withRls).not.toHaveBeenCalled();
    expect(new DevicesService(prisma as unknown as PrismaService).pushEnabled()).toBe(false);
  });

  it('registers through the claim function, under the caller’s own claims', async () => {
    await service().register({ token: TOKEN, platform: 'ANDROID', locale: 'en' }, user);
    expect(prisma.withRls.mock.calls[0][0]).toBe(user);
    const sql = tx.$queryRaw.mock.calls[0][0] as { strings: string[]; values: unknown[] };
    expect(sql.strings.join('?')).toContain('app.claim_device_push_token(');
    expect(sql.values).toEqual([TOKEN, 'ANDROID', 'en']);
  });

  it('answers a concurrent claim of the same token with 409 PUSH_TOKEN_BUSY, and rethrows anything else', async () => {
    const busy = new Prisma.PrismaClientKnownRequestError('Raw query failed. Code: `PU409`. Message: `PUSH_TOKEN_BUSY`', {
      code: 'P2010',
      clientVersion: 'test',
    });
    tx.$queryRaw.mockRejectedValueOnce(busy);
    const error = await service().register({ token: TOKEN, platform: 'IOS', locale: 'sv' }, user).catch((e: unknown) => e);
    expect((error as ConflictException).getResponse()).toMatchObject({ code: PUSH_TOKEN_BUSY });
    tx.$queryRaw.mockRejectedValueOnce(new TypeError('other'));
    await expect(service().register({ token: TOKEN, platform: 'IOS', locale: 'sv' }, user)).rejects.toThrow(TypeError);
  });

  it('unregisters only the caller’s own row of the token, push on or off', async () => {
    enabled = false;
    await service().unregister({ token: TOKEN }, user);
    expect(tx.devicePushToken.deleteMany).toHaveBeenCalledWith({ where: { token: TOKEN, userId: ME } });
  });

  it('releases whichever row holds the token through the release function', async () => {
    enabled = false;
    await service().release({ token: TOKEN }, user);
    const sql = tx.$executeRaw.mock.calls[0][0] as { strings: string[]; values: unknown[] };
    expect(sql.strings.join('?')).toContain('app.release_device_push_token(');
    expect(sql.values).toEqual([TOKEN]);
  });

  it('knows an Expo token as the database does', () => {
    expect(EXPO_PUSH_TOKEN.test(TOKEN)).toBe(true);
    expect(EXPO_PUSH_TOKEN.test('ExpoPushToken[abcdefgh]')).toBe(true);
    expect(EXPO_PUSH_TOKEN.test('ExponentPushToken[short]')).toBe(false);
    expect(EXPO_PUSH_TOKEN.test('ExponentPushToken[abc def gh]')).toBe(false);
    expect(EXPO_PUSH_TOKEN.test('fcm:abcdefgh')).toBe(false);
  });
});
