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
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  CreateTimplanCreditDto,
  TimplanCreditsQueryDto,
  UpdateTimplanCreditDto,
} from './dto/timplan-credit.dto';
import { TimplanCreditsService, type TimplanCreditResponse } from './timplan-credits.service';

const uuid = () => new ParseUUIDPipe({ version: '4' });

/**
 * Tillgodoräknad tid — the school's decisions that a day counts as
 * undervisningstid ("Friluftsdag, 300 min idrott, åk 7–9").
 *
 * SCHOOL_ADMIN writes: a credit is the school's decision. TEACHER reads the
 * list, because a teacher's GET /timplan-coverage counts the same credits
 * under their own RLS and the breaks page is where they see why a group's
 * figure includes them. Pupils and guardians are not here, and have no read
 * arm on the table until P4 narrows it to their own groups.
 */
@Controller('api/v1/timplan-credits')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class TimplanCreditsController {
  constructor(private readonly credits: TimplanCreditsService) {}

  @Get()
  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  list(
    @Query() query: TimplanCreditsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TimplanCreditResponse[]> {
    return this.credits.list(query.academicYearId, user);
  }

  @Post()
  create(
    @Body() dto: CreateTimplanCreditDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TimplanCreditResponse> {
    return this.credits.create(dto, user);
  }

  @Patch(':id')
  update(
    @Param('id', uuid()) id: string,
    @Body() dto: UpdateTimplanCreditDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TimplanCreditResponse> {
    return this.credits.update(id, dto, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', uuid()) id: string, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.credits.remove(id, user);
  }
}
