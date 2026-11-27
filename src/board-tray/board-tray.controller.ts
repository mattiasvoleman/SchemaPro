import { Body, Controller, Get, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Area } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { LayBrickDto } from './dto/lay-brick.dto';
import { BoardTrayService, type BoardTrayResponse, type LayBrickResult } from './board-tray.service';

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

  /**
   * Lays a brick as a locked lesson of its post (or moves back the lesson on the tray that is the brick). 409 REQUIREMENT_PLACEMENTS_STALE,
   * and nothing written, when the part is not as the request read it (somebody laid a brick of it since); 409 MASTER_LESSON_REFUSED when the
   * time may not stand, as for every hand edit; 409 BOARD_BRICK_CANNOT_BE_LAID for a brick of a block or a lesson nobody teaches.
   */
  @Post('lay')
  lay(@Body() dto: LayBrickDto, @CurrentUser() user: AuthenticatedUser): Promise<LayBrickResult> {
    return this.tray.lay(dto, user);
  }
}
