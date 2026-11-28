import { Body, Controller, Get, HttpCode, HttpStatus, Put, UseGuards } from '@nestjs/common';
import { Area } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { RolesGuard } from '../auth/roles.guard';
import { SaveOptimizationProfileDto } from './dto/optimization-profile.dto';
import type { OptimizationProfileView } from './optimization-profile';
import { OptimizationProfileService } from './optimization-profile.service';

/**
 * Optimeringsprofilen: the weights Generera's sliders set, the school's and not the browser's (P5). Read by every administrator (a läsare
 * sees the profile the school runs with); saved by Schemaläggning, as the runs it steers. Beside the run's routes, under the optimization
 * prefix, and no part of them: a run still takes the weights it is sent.
 */
@Controller('api/v1/optimization/profile')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Area('SCHEMALAGGNING')
export class OptimizationProfileController {
  constructor(private readonly profile: OptimizationProfileService) {}

  @Get()
  read(@CurrentUser() user: AuthenticatedUser): Promise<OptimizationProfileView> {
    return this.profile.read(user);
  }

  @Put()
  @HttpCode(HttpStatus.OK)
  save(@Body() dto: SaveOptimizationProfileDto, @CurrentUser() user: AuthenticatedUser): Promise<OptimizationProfileView> {
    return this.profile.save(dto, user);
  }
}
