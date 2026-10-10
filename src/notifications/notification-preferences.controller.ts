import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { NotificationPreferencesDto } from './dto/notification-preferences.dto';
import { NotificationPreferencesService, type NotificationPreference } from './notification-preferences.service';

/** Every role chooses for themself what leaves SchemaPro; nobody chooses for anybody else. */
@Controller('api/v1/notification-preferences')
@UseGuards(JwtAuthGuard, RolesGuard)
export class NotificationPreferencesController {
  constructor(private readonly preferences: NotificationPreferencesService) {}

  @Get()
  @Roles(Role.GUARDIAN, Role.STUDENT, Role.TEACHER, Role.SCHOOL_ADMIN)
  get(@CurrentUser() user: AuthenticatedUser): Promise<{ types: NotificationPreference[] }> {
    return this.preferences.get(user);
  }

  @Put()
  @Roles(Role.GUARDIAN, Role.STUDENT, Role.TEACHER, Role.SCHOOL_ADMIN)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  put(@Body() dto: NotificationPreferencesDto, @CurrentUser() user: AuthenticatedUser): Promise<{ types: NotificationPreference[] }> {
    return this.preferences.put(dto, user);
  }
}
