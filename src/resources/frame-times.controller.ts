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
import { FrameTimesService, type FrameTimeResponse } from './frame-times.service';
import { CreateFrameTimeDto, UpdateFrameTimeDto } from './dto/frame-time.dto';

/**
 * Ramtider — the hours of the day each stage of the school may be taught in.
 *
 * No academicYearId anywhere, unlike school-breaks: a frame is school-scoped,
 * the same scope AvailabilityConstraints uses, because both describe the shape
 * of the school's day rather than the contents of one läsår. The migration
 * argues the tradeoff.
 *
 * Admin-only for the whole controller including the list, matching its
 * neighbours. The table's RLS lets every member SELECT a frame — a teacher whose
 * grid stops at 15:00 should be able to see why — and they read it straight
 * from PostgREST like the other catalog tables; this route is for the admin UI
 * that also writes.
 */
@Controller('api/v1/frame-times')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class FrameTimesController {
  constructor(private readonly frames: FrameTimesService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<FrameTimeResponse[]> {
    return this.frames.list(user);
  }

  @Post()
  create(
    @Body() dto: CreateFrameTimeDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<FrameTimeResponse> {
    return this.frames.create(dto, user);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateFrameTimeDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<FrameTimeResponse> {
    return this.frames.update(id, dto, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.frames.remove(id, user);
  }
}
