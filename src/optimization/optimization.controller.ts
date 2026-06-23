import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { TriggerOptimizationDto } from './dto/trigger-optimization.dto';
import { OptimizationProxyService } from './optimization-proxy.service';
import type { AiEngineScheduleResponse } from './interfaces/ai-engine-payload.interface';

/**
 * Exposes the scheduling optimization trigger exclusively to school- and
 * platform-level administrators. No PII ever passes through this endpoint —
 * the proxy service strips everything before forwarding to the AI engine.
 */
@Controller('api/v1/optimization')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN, Role.SYSTEM_ADMIN)
export class OptimizationController {
  constructor(private readonly proxy: OptimizationProxyService) {}

  /**
   * Triggers a full scheduling run for the given academic year.
   * Returns the AI engine's raw status + generated master lessons count.
   */
  @Post('trigger')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async trigger(
    @Body() dto: TriggerOptimizationDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ status: AiEngineScheduleResponse['status']; lessonsGenerated: number }> {
    const result = await this.proxy.triggerScheduling(dto.academicYearId, user);
    return { status: result.status, lessonsGenerated: result.lessons.length };
  }
}
