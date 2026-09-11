import {
  Body,
  Controller,
  Delete,
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
import { LunchSittingsService, type LunchSittingResponse } from './lunch-sittings.service';
import { MoveLunchSittingDto, PlaceLunchSittingDto } from './dto/lunch-sitting.dto';

/**
 * Meals placed by hand in the Grundschema.
 *
 * Admin-only, and writes only: the table is already read over PostgREST by
 * every screen that shows a meal. See LunchSittingsService for what placing,
 * moving and removing mean against the rows the solver writes.
 */
@Controller('api/v1/lunch-sittings')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class LunchSittingsController {
  constructor(private readonly sittings: LunchSittingsService) {}

  @Post()
  place(
    @Body() dto: PlaceLunchSittingDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<LunchSittingResponse> {
    return this.sittings.place(dto, user);
  }

  @Patch(':id')
  move(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: MoveLunchSittingDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<LunchSittingResponse> {
    return this.sittings.move(id, dto, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.sittings.remove(id, user);
  }
}
