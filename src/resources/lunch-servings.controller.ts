import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  LunchServingsService,
  type LunchServingResponse,
} from './lunch-servings.service';
import {
  CreateLunchServingDto,
  UpdateLunchServingDto,
} from './dto/lunch-serving.dto';

/**
 * Lunchsittningar — when each stage of the school may eat.
 *
 * School-scoped, like frame-times and availability-constraints: the flow
 * through the middle of the day describes the building and the kitchen, not one
 * läsår's contents.
 *
 * Admin-only for the whole controller including the list, matching its
 * neighbours. The table's RLS lets every member SELECT a sitting — a pupil
 * asking when their class eats is asking an ordinary question — and they read
 * it straight from PostgREST; this route is for the admin UI that also writes.
 */
@Controller('api/v1/lunch-servings')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class LunchServingsController {
  constructor(private readonly servings: LunchServingsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<LunchServingResponse[]> {
    return this.servings.list(user);
  }

  @Post()
  create(
    @Body() dto: CreateLunchServingDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<LunchServingResponse> {
    return this.servings.create(dto, user);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateLunchServingDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<LunchServingResponse> {
    return this.servings.update(id, dto, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.servings.remove(id, user);
  }
}
