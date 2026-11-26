import { Controller, Get, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { Area } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { BoardTrayService, type BoardTrayResponse } from './board-tray.service';

/**
 * Att lägga (E4): the grundschema's tray. The GET is open to every administrator, as the week of förläggningar is (RolesGuard asks an area only
 * of a write); the writes of the board (lay a brick, lock many) are Schemaläggning's and Drift's, as the lesson's own.
 */
@Controller('api/v1/board-tray')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Area('SCHEMALAGGNING', 'DRIFT')
export class BoardTrayController {
  constructor(private readonly tray: BoardTrayService) {}

  /** The year's bricks (one per lesson a post has left), of one class when `groupId` is given, with the year's tally. */
  @Get()
  trayOfYear(
    @Query('academicYearId', new ParseUUIDPipe({ version: '4' })) academicYearId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('groupId', new ParseUUIDPipe({ version: '4', optional: true })) groupId?: string,
  ): Promise<BoardTrayResponse> {
    return this.tray.trayOfYear(academicYearId, groupId, user);
  }
}
