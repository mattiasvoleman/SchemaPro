import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  CancellationBatchesService,
  type CancellationBatchView,
  type CancellationPreview,
  type ReversePreview,
} from './cancellation-batches.service';
import {
  CancellationBatchListQueryDto,
  CancellationSelectionDto,
  CreateCancellationBatchDto,
} from './dto/cancellation-batch.dto';

/**
 * Bulk avbokning. ADMIN ONLY: a batch cancels lessons for whole classes and
 * years at once, and reversing one reinstates them; teachers, pupils and
 * guardians read the outcome in the calendar.
 */
@Controller('api/v1/cancellation-batches')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class CancellationBatchesController {
  constructor(private readonly batches: CancellationBatchesService) {}

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  preview(
    @Body() dto: CancellationSelectionDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CancellationPreview> {
    return this.batches.preview(dto, user);
  }

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  create(
    @Body() dto: CreateCancellationBatchDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ batch: CancellationBatchView; cancelled: number; credits: number }> {
    return this.batches.create(dto, user);
  }

  @Get()
  list(
    @Query() query: CancellationBatchListQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CancellationBatchView[]> {
    return this.batches.list(query.academicYearId, user);
  }

  @Post(':id/reapply')
  @HttpCode(HttpStatus.OK)
  reapply(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ batch: CancellationBatchView; added: number }> {
    return this.batches.reapply(id, user);
  }

  @Post(':id/reverse/preview')
  @HttpCode(HttpStatus.OK)
  reversePreview(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReversePreview> {
    return this.batches.reversePreview(id, user);
  }

  @Post(':id/reverse')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  reverse(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReversePreview> {
    return this.batches.reverse(id, user);
  }
}
