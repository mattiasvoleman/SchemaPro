import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Area } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { BoardRequest } from './cover-request-reads';
import { CoverRequestsService, type FairnessResponse, type MyCoverResponse } from './cover-requests.service';
import { CreateCoverRequestDto, FairnessQueryDto } from './dto/cover-requests.dto';

const uuid = () => new ParseUUIDPipe({ version: '4' });

/**
 * Vikariefrågan, the school's side: ask chosen colleagues for one or more
 * lessons, take the question back, and the fairness view beside the cover
 * counter. Drift's, as the board's decisions are; the requests themselves
 * come back on the board (GET /api/v1/cover/board: requests, confirmations).
 */
@Controller('api/v1/cover')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Area('DRIFT')
export class CoverRequestsAdminController {
  constructor(private readonly requests: CoverRequestsService) {}

  @Post('requests')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  create(@Body() dto: CreateCoverRequestDto, @CurrentUser() user: AuthenticatedUser): Promise<BoardRequest> {
    return this.requests.create(dto, user);
  }

  @Post('requests/:id/withdraw')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  withdraw(@Param('id', uuid()) id: string, @CurrentUser() user: AuthenticatedUser): Promise<BoardRequest> {
    return this.requests.withdraw(id, user);
  }

  @Get('fairness')
  fairness(@Query() query: FairnessQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<FairnessResponse> {
    return this.requests.fairness(query.from, query.to, user);
  }
}

/**
 * Vikariefrågan, the colleague's side: the questions they were asked and the
 * passes they hold, a yes (which places them: the first yes gets the lessons),
 * a no, and the tap on a pass. A TEACHER's, and nobody else's.
 */
@Controller('api/v1/cover-requests')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.TEACHER)
export class CoverRequestsTeacherController {
  constructor(private readonly requests: CoverRequestsService) {}

  @Get('mine')
  mine(@CurrentUser() user: AuthenticatedUser): Promise<MyCoverResponse> {
    return this.requests.mine(user);
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  accept(@Param('id', uuid()) id: string, @CurrentUser() user: AuthenticatedUser): Promise<{ requestId: string; lessons: number }> {
    return this.requests.accept(id, user);
  }

  @Post(':id/decline')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  decline(@Param('id', uuid()) id: string, @CurrentUser() user: AuthenticatedUser): Promise<{ requestId: string }> {
    return this.requests.decline(id, user);
  }

  @Post('lessons/:lessonId/confirm')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  confirm(
    @Param('lessonId', uuid()) lessonId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ lessonId: string; confirmed: number }> {
    return this.requests.confirm(lessonId, user);
  }
}
