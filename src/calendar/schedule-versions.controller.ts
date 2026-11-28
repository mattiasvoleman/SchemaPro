import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Area } from '../auth/decorators/area.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  ScheduleVersionsService,
  type ScheduleVersionSummary,
  type VersionLesson,
} from './schedule-versions.service';
import { CreateScheduleVersionDto, RenameScheduleVersionDto } from './dto/schedule-version.dto';
import { ScheduleVersionAnnouncer } from './schedule-version-announcer';
import { ScheduleVersionNamesService } from './schedule-version-names.service';

@Controller('api/v1/schedule-versions')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Area('SCHEMALAGGNING')
export class ScheduleVersionsController {
  constructor(
    private readonly versions: ScheduleVersionsService,
    private readonly names: ScheduleVersionNamesService,
    private readonly announcer: ScheduleVersionAnnouncer,
  ) {}

  /** `GET /api/v1/schedule-versions?academicYearId=…` — list saved snapshots. */
  @Get()
  list(
    @Query('academicYearId', new ParseUUIDPipe({ version: '4' }))
    academicYearId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ScheduleVersionSummary[]> {
    return this.versions.list(academicYearId, user);
  }

  /** `POST /api/v1/schedule-versions` — snapshot the current timetable. */
  @Post()
  create(
    @Body() dto: CreateScheduleVersionDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ScheduleVersionSummary> {
    return this.versions.create(dto.academicYearId, dto.name, user);
  }

  /** `GET /api/v1/schedule-versions/:id` — snapshot content (for diffs). */
  @Get(':id')
  get(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ScheduleVersionSummary & { lessons: VersionLesson[] }> {
    return this.versions.get(id, user);
  }

  /**
   * `PATCH /api/v1/schedule-versions/:id` — döp om en version (E9). Bara namnet kan ändras: en version är en ögonblicksbild. 404 för en version som inte är
   * skolans, 400 för ett namn som är tomt eller längre än 120 tecken.
   */
  @Patch(':id')
  rename(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: RenameScheduleVersionDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ScheduleVersionSummary> {
    return this.names.rename(id, dto.name, user);
  }

  /**
   * `POST /api/v1/schedule-versions/:id/restore` — replace the live timetable
   * with the snapshot. An automatic safety snapshot of the current state is
   * taken first, so a restore can always be reverted. The staff room is told
   * (realtime) that the timetable was replaced once the restore has committed.
   */
  @Post(':id/restore')
  async restore(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ restoredLessons: number; safetyVersionId: string }> {
    const restored = await this.versions.restore(id, user);
    // The restore has committed: the staff room is told that the grundschema was replaced, and reads the year (E9, g465 L-4).
    await this.announcer.restored(user);
    return restored;
  }

  /** `DELETE /api/v1/schedule-versions/:id` — remove a snapshot. */
  @Delete(':id')
  remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ id: string }> {
    return this.versions.remove(id, user);
  }
}
