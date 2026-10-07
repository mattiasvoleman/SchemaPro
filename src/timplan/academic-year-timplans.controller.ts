import { Body, Controller, Get, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { AcademicYearTimplansService } from './academic-year-timplans.service';
import { ReplaceYearTimplansDto } from './dto/year-timplans.dto';
import type { YearTimplanRow } from './year-timplans';

const uuid = () => new ParseUUIDPipe({ version: '4' });

/**
 * "Timplan per årskurs" in the year dialog, under the year's own path.
 *
 * In TimplanModule rather than beside AcademicYearsController: what a row
 * means (absence = no plan, a draft is legal and marked) is argued with the
 * rest of the timplan, and the year's create reaches the same code through
 * attachDefaultTimplans. SCHOOL_ADMIN only, like every year route; teachers,
 * pupils and guardians read the rows through PostgREST under the table's arms.
 */
@Controller('api/v1/academic-years')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class AcademicYearTimplansController {
  constructor(private readonly yearTimplans: AcademicYearTimplansService) {}

  @Get(':id/timplans')
  list(
    @Param('id', uuid()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<YearTimplanRow[]> {
    return this.yearTimplans.list(id, user);
  }

  @Put(':id/timplans')
  replace(
    @Param('id', uuid()) id: string,
    @Body() dto: ReplaceYearTimplansDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<YearTimplanRow[]> {
    return this.yearTimplans.replace(id, dto, user);
  }
}
