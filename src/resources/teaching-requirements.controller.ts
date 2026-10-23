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
import { Area } from '../auth/decorators/area.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { TeachingRequirementsService } from './teaching-requirements.service';
import { TermHalvesService } from './term-halves.service';
import {
  CreateTeachingRequirementDto,
  UpdateTeachingRequirementDto,
} from './dto/teaching-requirement.dto';
import { SplitByTermDto } from './dto/term-halves.dto';

@Controller('api/v1/teaching-requirements')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Area('PLANERING')
export class TeachingRequirementsController {
  constructor(
    private readonly requirements: TeachingRequirementsService,
    private readonly termHalves: TermHalvesService,
  ) {}

  @Post()
  create(
    @Body() dto: CreateTeachingRequirementDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.requirements.create(dto, user);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateTeachingRequirementDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.requirements.update(id, dto, user);
  }

  /**
   * "Dela terminsvis i halvklass": the class's post replaced by four on its
   * two halves, the two subjects swapping at the spring term, in one block
   * per term (term-halves.service.ts).
   */
  @Post(':id/term-halves')
  splitByTerm(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: SplitByTermDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.termHalves.split(id, dto, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.requirements.remove(id, user);
  }
}
