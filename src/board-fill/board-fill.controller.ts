import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Area } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { BoardFillService, type FillApplyResult, type FillProposal } from './board-fill.service';
import { FillApplyDto, FillProposeDto } from './dto/fill.dto';

/** Lägg det som går (E7a): a proposal for the tray's bricks, and "Ta in". The doors are the board's: Schemaläggning's and Drift's, as the lesson's own. */
@Controller('api/v1/board-fill')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Area('SCHEMALAGGNING', 'DRIFT')
export class BoardFillController {
  constructor(private readonly fill: BoardFillService) {}

  /**
   * `POST /api/v1/board-fill/propose` — the bricks asked for (marked ones, a class, a year or the school), laid one at a time on the best free time each
   * has, with a room, every one judged as a hand edit is. Nothing written. The answer says how many fitted, which did not and why, and the `basis` Ta in
   * gives back. A POST because the question is a body.
   */
  @Post('propose')
  @HttpCode(200)
  propose(@Body() dto: FillProposeDto, @CurrentUser() user: AuthenticatedUser): Promise<FillProposal> {
    return this.fill.propose(dto, user);
  }

  /**
   * `POST /api/v1/board-fill/apply` — "Ta in": the proposal, written as locked lessons in one transaction after a version. 409 BOARD_FILL_STALE and nothing
   * written when the grundschema is not the one the proposal was made on; 409 MASTER_LESSON_REFUSED when the judge now refuses one of its times;
   * 409 DIRECT_REACH_UNANSWERED in Direkt before the school has answered (P5).
   */
  @Post('apply')
  @HttpCode(200)
  apply(@Body() dto: FillApplyDto, @CurrentUser() user: AuthenticatedUser): Promise<FillApplyResult> {
    return this.fill.apply(dto, user);
  }
}
