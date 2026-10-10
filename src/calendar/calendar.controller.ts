import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import type { PublishResult } from './calendar.service';
import { PublicationsService } from '../publication/publications.service';
import { PublishScheduleDto } from './dto/publish-schedule.dto';

@Controller('api/v1/calendar')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class CalendarController {
  constructor(private readonly publications: PublicationsService) {}

  /**
   * `POST /api/v1/calendar/publish` — materialize the master timetable into
   * dated calendar lessons. Idempotent per (masterLesson, date).
   *
   * Writes what it always wrote and answers what it always answered, plus a
   * LEGACY_PUBLISH row in the publication log; refused only by a gate the
   * school has set to REFUSE (PublicationsService.legacyPublish).
   */
  @Post('publish')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  publish(
    @Body() dto: PublishScheduleDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PublishResult> {
    return this.publications.legacyPublish(dto, user);
  }
}
