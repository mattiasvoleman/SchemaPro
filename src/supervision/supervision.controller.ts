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
  Query,
  UseGuards,
} from '@nestjs/common';
import { Area } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  CreateSupervisionAreaDto,
  CreateSupervisionShiftDto,
  SupervisionRotaQueryDto,
  SupervisionWeekQueryDto,
  UpdateSupervisionAreaDto,
  UpdateSupervisionShiftDto,
} from './dto/supervision.dto';
import { SupervisionService, type WeekPass } from './supervision.service';

const uuid = () => new ParseUUIDPipe({ version: '4' });

/**
 * Rastvaktsområden: the places the school watches. Read by its
 * administrators, written by planering — grunddata beside the rasts.
 */
@Controller('api/v1/supervision-areas')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Area('PLANERING')
export class SupervisionAreasController {
  constructor(private readonly supervision: SupervisionService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.supervision.listAreas(user);
  }

  @Post()
  create(@Body() dto: CreateSupervisionAreaDto, @CurrentUser() user: AuthenticatedUser) {
    return this.supervision.createArea(dto, user);
  }

  @Patch(':id')
  update(@Param('id', uuid()) id: string, @Body() dto: UpdateSupervisionAreaDto, @CurrentUser() user: AuthenticatedUser) {
    return this.supervision.updateArea(id, dto, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', uuid()) id: string, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.supervision.removeArea(id, user);
  }
}

/**
 * Rastvaktsschemat: a läsår's passes, written by planering as the uppdrag
 * are, and the schedule read laid over the breaks. Administrators only: a
 * teacher's own passes reach them through their load (Min tjänst).
 */
@Controller('api/v1')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Area('PLANERING')
export class SupervisionShiftsController {
  constructor(private readonly supervision: SupervisionService) {}

  /** `?academicYearId=` — the areas, the passes, the breaks, the gaps and the teachers' minutes. */
  @Get('supervision-rota')
  rota(@Query() query: SupervisionRotaQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.supervision.rota(query.academicYearId, user);
  }

  @Post('supervision-shifts')
  create(@Body() dto: CreateSupervisionShiftDto, @CurrentUser() user: AuthenticatedUser) {
    return this.supervision.createShift(dto, user);
  }

  @Patch('supervision-shifts/:id')
  update(@Param('id', uuid()) id: string, @Body() dto: UpdateSupervisionShiftDto, @CurrentUser() user: AuthenticatedUser) {
    return this.supervision.updateShift(id, dto, user);
  }

  @Delete('supervision-shifts/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', uuid()) id: string, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.supervision.removeShift(id, user);
  }
}

/**
 * The signed-in person's own passes over a few days (Rastvakt i vardagen):
 * their week on the web and in the app. Every member of staff, for
 * themself only; a read, so no area.
 */
@Controller('api/v1/supervision')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
export class SupervisionWeekController {
  constructor(private readonly supervision: SupervisionService) {}

  /** `?from=&to=` — at most fourteen days. */
  @Get('week')
  week(
    @Query() query: SupervisionWeekQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ from: string; to: string; passes: WeekPass[] }> {
    return this.supervision.week(query.from, query.to, user);
  }
}
