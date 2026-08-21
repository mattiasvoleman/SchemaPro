import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { LunchSettingsService } from './lunch-settings.service';
import { UpsertLunchSettingsDto } from './dto/lunch-settings.dto';

/**
 * The school's lunch rules. One row, so PUT rather than POST/PATCH: there is
 * nothing to create a second of, and no id for a caller to hold.
 */
@Controller('api/v1/lunch-settings')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class LunchSettingsController {
  constructor(private readonly settings: LunchSettingsService) {}

  @Get()
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.settings.get(user);
  }

  @Put()
  upsert(
    @Body() dto: UpsertLunchSettingsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.settings.upsert(dto, user);
  }
}
