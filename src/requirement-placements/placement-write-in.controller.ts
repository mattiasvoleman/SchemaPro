import { Body, Controller, Get, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Area } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { WriteInPlacementsDto } from './dto/placement-write-in.dto';
import { PlacementWriteInService } from './placement-write-in.service';

/**
 * Skriv in förläggningarna (E4b): the year's förläggningar that hold and name a room written to the grundschema without Generera. The write is
 * the scheduler's, as a hand edit of the grundschema is; the preview is a read every administrator may make.
 */
@Controller('api/v1/placement-write-in')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Area('SCHEMALAGGNING', 'DRIFT')
export class PlacementWriteInController {
  constructor(private readonly writeIn: PlacementWriteInService) {}

  /** What a write would do now: how many lessons, how many replaced, and every förläggning that would be left, with its reason. Writes nothing. */
  @Get()
  preview(@Query('academicYearId', new ParseUUIDPipe({ version: '4' })) academicYearId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.writeIn.preview(academicYearId, user);
  }

  /** Writes them. 409 SCHEDULE_BUSY while the year is being rewritten by something else. */
  @Post()
  write(@Body() dto: WriteInPlacementsDto, @CurrentUser() user: AuthenticatedUser) {
    return this.writeIn.write(dto.academicYearId, user);
  }
}
