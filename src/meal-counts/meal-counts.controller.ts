import { Body, Controller, Get, Header, Put, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { Area } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { MealCountsQueryDto, MealSettingsDto } from './dto/meal-counts.dto';
import type { MealCountsView } from './meal-counts';
import { MealCountsService, type MealSettingsView } from './meal-counts.service';

/**
 * Måltidskollen (/admin/meals): the portions of each lunch sitting, from today on, and the school's cut-off,
 * kitchen address and switch for the daily letter.
 *
 * Every administrator reads the counts (a figure, never a pupil), and those who write Drift change the settings,
 * as RolesGuard holds with the class's @Area on a write alone. The kitchen has no login of its own: it gets the
 * printed page, the file and, when the school has asked for it, the letter.
 */
@Controller('api/v1/meal-counts')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Area('DRIFT')
export class MealCountsController {
  constructor(private readonly meals: MealCountsService) {}

  /** The days, their sittings and totals. `from` is today without it, `to` the same day. */
  @Get()
  view(@Query() query: MealCountsQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<MealCountsView> {
    return this.meals.view(query, user);
  }

  /** The same days for Excel: windows-1252, `;`, one row per day and sitting. */
  @Get('csv')
  @Header('Content-Type', 'text/csv; charset=windows-1252')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async csv(@Query() query: MealCountsQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<StreamableFile> {
    const file = await this.meals.csv(query, user);
    return new StreamableFile(file.body, {
      type: 'text/csv; charset=windows-1252',
      disposition: `attachment; filename="${file.filename}"`,
      length: file.body.length,
    });
  }

  @Get('settings')
  settings(@CurrentUser() user: AuthenticatedUser): Promise<MealSettingsView> {
    return this.meals.settings(user);
  }

  @Put('settings')
  updateSettings(@Body() dto: MealSettingsDto, @CurrentUser() user: AuthenticatedUser): Promise<MealSettingsView> {
    return this.meals.updateSettings(dto, user);
  }
}
