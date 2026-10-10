import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { DevicesService } from './devices.service';
import { DeviceTokenDto, RegisterDeviceDto } from './dto/devices.dto';

/**
 * Push for the mobile app: whether the school has it, and the caller's own
 * devices. Every role, each for themself.
 */
@Controller('api/v1')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  /** The app asks before it asks the person for permission. */
  @Get('push/config')
  @Roles(Role.GUARDIAN, Role.STUDENT, Role.TEACHER, Role.SCHOOL_ADMIN)
  config(): { enabled: boolean } {
    return { enabled: this.devices.pushEnabled() };
  }

  @Post('devices')
  @HttpCode(204)
  @Roles(Role.GUARDIAN, Role.STUDENT, Role.TEACHER, Role.SCHOOL_ADMIN)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  register(@Body() dto: RegisterDeviceDto, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.devices.register(dto, user);
  }

  @Post('devices/unregister')
  @HttpCode(204)
  @Roles(Role.GUARDIAN, Role.STUDENT, Role.TEACHER, Role.SCHOOL_ADMIN)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  unregister(@Body() dto: DeviceTokenDto, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.devices.unregister(dto, user);
  }

  @Post('devices/release')
  @HttpCode(204)
  @Roles(Role.GUARDIAN, Role.STUDENT, Role.TEACHER, Role.SCHOOL_ADMIN)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  release(@Body() dto: DeviceTokenDto, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.devices.release(dto, user);
  }
}
