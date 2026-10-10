import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CreatePublicLinkDto, PublicationListQueryDto, TeacherPublicLabelDto } from './dto/publication.dto';
import { PublicLinksService, type PublicLinkView } from './public-links.service';

/** The viewer's share links and hidden teachers. ADMIN ONLY. */
@Controller('api/v1')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class PublicLinksController {
  constructor(private readonly links: PublicLinksService) {}

  @Get('public-links')
  list(@Query() query: PublicationListQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<PublicLinkView[]> {
    return this.links.list(query.academicYearId, user);
  }

  /** The token is in this answer and nowhere else, ever. */
  @Post('public-links')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  create(
    @Body() dto: CreatePublicLinkDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ link: PublicLinkView; token: string }> {
    return this.links.create(dto, user);
  }

  @Post('public-links/:id/revoke')
  @HttpCode(HttpStatus.OK)
  revoke(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PublicLinkView> {
    return this.links.revoke(id, user);
  }

  @Get('teacher-public-labels')
  hidden(@CurrentUser() user: AuthenticatedUser): Promise<string[]> {
    return this.links.hiddenTeachers(user);
  }

  @Put('teacher-public-labels/:userId')
  setHidden(
    @Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string,
    @Body() dto: TeacherPublicLabelDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ userId: string; hidden: boolean }> {
    return this.links.setHidden(userId, dto.hidden, user);
  }
}
