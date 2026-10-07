import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { ExecuteActivationDto, ExecuteRolloverDto, RolloverOptionsDto } from './dto/year-rollover.dto';
import { YearRolloverService } from './year-rollover.service';

/**
 * Läsårsrullning and activation, beside the year's own CRUD
 * (AcademicYearsController) under the same prefix. SCHOOL_ADMIN only: both
 * write a whole year at once, and the activation moves every pupil's class.
 *
 * Each operation is a POST preview, which writes nothing and answers 200 with
 * a plan and its planHash, and a POST execute that takes the hash back.
 */
@Controller('api/v1/academic-years')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class YearRolloverController {
  constructor(private readonly rollover: YearRolloverService) {}

  @Post(':id/rollover/preview')
  @HttpCode(HttpStatus.OK)
  previewRollover(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: RolloverOptionsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.rollover.previewRollover(id, dto, user);
  }

  @Post(':id/rollover')
  executeRollover(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ExecuteRolloverDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.rollover.executeRollover(id, dto, user);
  }

  @Post(':id/activation/preview')
  @HttpCode(HttpStatus.OK)
  previewActivation(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.rollover.previewActivation(id, user);
  }

  @Post(':id/activation')
  @HttpCode(HttpStatus.OK)
  executeActivation(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ExecuteActivationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.rollover.executeActivation(id, dto, user);
  }
}
