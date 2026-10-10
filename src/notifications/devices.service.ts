import { ConflictException, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import type { PushConfig } from '../config/configuration';
import { requireUserId } from '../common/utils/request-context';
import { PrismaService } from '../database/prisma.service';
import { sqlStateOf } from '../cover/cover-errors';
import type { DeviceTokenDto, RegisterDeviceDto } from './dto/devices.dto';

export const PUSH_DISABLED = 'PUSH_DISABLED';
export const PUSH_TOKEN_BUSY = 'PUSH_TOKEN_BUSY';

/**
 * The device-token registry (DevicePushTokens, 20261013110000), for the
 * caller's own devices.
 *
 *   * register: app.claim_device_push_token under the caller's claims — the
 *     only way a row is written. Refused (409 PUSH_DISABLED) while push is
 *     off, so nothing is stored until somebody turns it on;
 *   * unregister: the caller's own row of that token, deleted under their
 *     RLS with their id in the WHERE (C17), whether push is on or not;
 *   * release: whichever row holds that token, through
 *     app.release_device_push_token — a logout that could not reach the API
 *     finished at the next sign-in on that device.
 *
 * unregister and release answer the same whether or not a row existed.
 */
@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  pushEnabled(): boolean {
    return this.config?.get<PushConfig>('push')?.enabled === true;
  }

  async register(dto: RegisterDeviceDto, user: AuthenticatedUser): Promise<void> {
    if (!this.pushEnabled()) {
      throw new ConflictException({ message: 'Push är inte påslaget för skolan.', code: PUSH_DISABLED });
    }
    try {
      await this.prisma.withRls(user, (tx) =>
        tx.$queryRaw(
          Prisma.sql`SELECT app.claim_device_push_token(${dto.token}, ${dto.platform}::"DevicePlatform", ${dto.locale})::text AS id`,
        ),
      );
    } catch (error) {
      if (sqlStateOf(error) === 'PU409') {
        throw new ConflictException({ message: 'Enheten registreras redan, försök igen.', code: PUSH_TOKEN_BUSY });
      }
      throw error;
    }
  }

  async unregister(dto: DeviceTokenDto, user: AuthenticatedUser): Promise<void> {
    const userId = requireUserId(user);
    await this.prisma.withRls(user, (tx) => tx.devicePushToken.deleteMany({ where: { token: dto.token, userId } }));
  }

  async release(dto: DeviceTokenDto, user: AuthenticatedUser): Promise<void> {
    await this.prisma.withRls(user, (tx) => tx.$executeRaw(Prisma.sql`SELECT app.release_device_push_token(${dto.token})`));
  }
}
