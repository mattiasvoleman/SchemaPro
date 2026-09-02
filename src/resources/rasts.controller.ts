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
import { RastsService, type RastResponse } from './rasts.service';
import { CreateRastDto, UpdateRastDto } from './dto/rast.dto';

/**
 * Raster — the minutes of a day each stage is not taught.
 *
 * School-scoped, like frame-times and lunch-servings: the shape of the day
 * describes the building and the yard, not one läsår's contents.
 *
 * Admin-only for the whole controller including the list, matching its
 * neighbours. The table's RLS lets every member SELECT a rast — when åk 4-6 has
 * rast is not confidential, and a pupil, a guardian and a teacher all need the
 * same answer — and they read it straight from PostgREST; this route is for the
 * admin UI that also writes.
 */
@Controller('api/v1/rasts')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class RastsController {
  constructor(private readonly rasts: RastsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<RastResponse[]> {
    return this.rasts.list(user);
  }

  @Post()
  create(
    @Body() dto: CreateRastDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RastResponse> {
    return this.rasts.create(dto, user);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateRastDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RastResponse> {
    return this.rasts.update(id, dto, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.rasts.remove(id, user);
  }
}
