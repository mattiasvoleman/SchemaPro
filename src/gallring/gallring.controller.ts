import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Decides } from '../auth/decorators/area.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { RetentionDecisionDto, RetentionPreviewQueryDto } from './dto/gallring.dto';
import {
  GallringService,
  type PurgedBeforeView,
  type RetentionOverview,
  type RetentionPreview,
} from './gallring.service';

/**
 * Gallring (/admin/dataskydd): the school's retention decisions, previews and
 * runs. ADMIN ONLY, except the "gallrat före" dates every role's reports
 * read. Row security and app.gallring_preview say the same.
 */
@Controller('api/v1/retention')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Decides()
export class GallringController {
  constructor(private readonly gallring: GallringService) {}

  @Get()
  overview(@CurrentUser() user: AuthenticatedUser): Promise<RetentionOverview> {
    return this.gallring.overview(user);
  }

  @Get('preview')
  preview(@Query() query: RetentionPreviewQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<RetentionPreview> {
    return this.gallring.preview(query, user);
  }

  @Post('decisions')
  decide(@Body() dto: RetentionDecisionDto, @CurrentUser() user: AuthenticatedUser): Promise<RetentionOverview> {
    return this.gallring.decide(dto, user);
  }

  @Get('purged-before')
  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER, Role.STUDENT, Role.GUARDIAN)
  purgedBefore(@CurrentUser() user: AuthenticatedUser): Promise<PurgedBeforeView[]> {
    return this.gallring.purgedBefore(user);
  }
}
