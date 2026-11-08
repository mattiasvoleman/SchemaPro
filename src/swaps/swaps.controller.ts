import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Area } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { ApplySwapDto, SuggestSwapsDto } from './dto/swaps.dto';
import { SwapsService, type SwapApplyResult, type SwapSuggestion } from './swaps.service';

/**
 * Byten och flyttar (G1). Same door as every other hand edit of the
 * grundschema: the scheduler's, and the planning area's.
 */
@Controller('api/v1/swaps')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Area('SCHEMALAGGNING', 'DRIFT')
export class SwapsController {
  constructor(private readonly swaps: SwapsService) {}

  /**
   * `POST /api/v1/swaps/suggest` — the swaps and chains of three a lesson can
   * take part in. Each proposal holds every hard rule (judged by the write
   * path's own clash rule as one move), names the parallel lessons that go
   * with it, and says what it costs in the soft ones. Writes nothing. A POST
   * because the question is a body, not because it changes anything.
   */
  @Post('suggest')
  @HttpCode(200)
  suggest(@Body() dto: SuggestSwapsDto, @CurrentUser() user: AuthenticatedUser): Promise<SwapSuggestion> {
    return this.swaps.suggest(dto, user);
  }

  /**
   * `POST /api/v1/swaps/apply` — apply a proposal's moves as ONE move, through
   * the template's write path: a safety version first, the published calendar
   * following, a change-log row per lesson. 409 SWAP_STALE when a lesson no
   * longer stands where the page saw it, SWAP_SPLITS_PARALLEL when the moves
   * would part lessons that were laid together, SWAP_LOCKED for a locked
   * lesson that was not the picked one, and the clash rule's own 409 for a
   * double booking. Sent with `undo` from a previous answer, it takes one back.
   */
  @Post('apply')
  @HttpCode(200)
  apply(@Body() dto: ApplySwapDto, @CurrentUser() user: AuthenticatedUser): Promise<SwapApplyResult> {
    return this.swaps.apply(dto, user);
  }
}
