import { Body, Controller, Get, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { Area } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { BlockPlacementsService } from './block-placements.service';
import { ReplaceBlockPlacementsDto } from './dto/block-placements.dto';

/**
 * Förlagda block: where the school has put a parallel block's lessons before Generera. The block's own prefix, beside
 * the block's own routes (resources/teaching-blocks.controller.ts); the GET is open to every administrator (RolesGuard
 * asks an area only of a write), the PUT is Planering's.
 */
@Controller('api/v1/teaching-blocks')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Area('PLANERING')
export class BlockPlacementsController {
  constructor(private readonly placements: BlockPlacementsService) {}

  /** One block's förläggningar with a verdict for each lesson and member, judged now. */
  @Get(':id/placements')
  listOfBlock(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.placements.listOfBlock(id, user);
  }

  /** Replaces the block's förläggningar; 409 and nothing written when they do not fit, the week does not hold one, or the read was stale. */
  @Put(':id/placements')
  replace(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ReplaceBlockPlacementsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.placements.replace(id, dto, user);
  }
}
