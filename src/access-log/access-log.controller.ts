import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { AccessLogService, type AccessLogAnswer } from './access-log.service';
import { AccessLogQueryDto } from './dto/access-log.dto';

/**
 * Läsloggen: "vem har läst om eleven?" for the school's administrator
 * (/admin/dataskydd). The read is itself recorded (ACCESS_LOG).
 */
@Controller('api/v1/access-log')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class AccessLogController {
  constructor(private readonly accessLog: AccessLogService) {}

  @Get()
  forPerson(@Query() query: AccessLogQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<AccessLogAnswer> {
    return this.accessLog.forPerson(query, user);
  }
}
