import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  LocalTimplansService,
  type LocalTimplanCheckResponse,
  type LocalTimplanDetail,
  type LocalTimplanListItem,
  type LocalTimplanResponse,
  type ReplaceEntriesResponse,
} from './local-timplans.service';
import {
  CopyLocalTimplanDto,
  CreateLocalTimplanDto,
  DecideLocalTimplanDto,
  ReplaceLocalTimplanEntriesDto,
  UpdateLocalTimplanDto,
} from './dto/local-timplan.dto';
import { GenerateRequirementsDto } from './dto/generate-requirements.dto';
import {
  TimplanRequirementsService,
  type GenerateRequirementsResponse,
} from './timplan-requirements.service';

const uuid = () => new ParseUUIDPipe({ version: '4' });

/**
 * Lokala timplaner.
 *
 * TEACHER IS IN THE CLASS ROLES FOR THE THREE READS ONLY: the list, one plan
 * with its entries, and its check. A draft timplan is discussed with the
 * teachers, and the table's staff_select arm reads every plan for the same
 * reason. Every write carries its own @Roles(SCHOOL_ADMIN) — the table has no
 * teacher write arm — so a teacher's write stops at the guard with a 403 that
 * names the role.
 *
 * STUDENT and GUARDIAN are not here although the family arm lets them read
 * decided plans: they read through PostgREST, and a route nobody calls is a
 * route nobody tests.
 *
 * The three actions are POSTs on the plan: decide answers 200 with the plan it
 * stamped; reopen and copy answer 201 with the NEW draft, entries included.
 */
@Controller('api/v1/local-timplans')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
export class LocalTimplansController {
  constructor(
    private readonly timplans: LocalTimplansService,
    private readonly requirements: TimplanRequirementsService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<LocalTimplanListItem[]> {
    return this.timplans.list(user);
  }

  @Get(':id')
  get(
    @Param('id', uuid()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<LocalTimplanDetail> {
    return this.timplans.get(id, user);
  }

  /** The national comparison as a verdict document. Every verdict is a warning. */
  @Get(':id/check')
  check(
    @Param('id', uuid()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<LocalTimplanCheckResponse> {
    return this.timplans.check(id, user);
  }

  @Post()
  @Roles(Role.SCHOOL_ADMIN)
  create(
    @Body() dto: CreateLocalTimplanDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<LocalTimplanDetail> {
    return this.timplans.create(dto, user);
  }

  @Patch(':id')
  @Roles(Role.SCHOOL_ADMIN)
  update(
    @Param('id', uuid()) id: string,
    @Body() dto: UpdateLocalTimplanDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<LocalTimplanResponse> {
    return this.timplans.update(id, dto, user);
  }

  @Delete(':id')
  @Roles(Role.SCHOOL_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', uuid()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.timplans.remove(id, user);
  }

  @Put(':id/entries')
  @Roles(Role.SCHOOL_ADMIN)
  replaceEntries(
    @Param('id', uuid()) id: string,
    @Body() dto: ReplaceLocalTimplanEntriesDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReplaceEntriesResponse> {
    return this.timplans.replaceEntries(id, dto, user);
  }

  @Post(':id/decide')
  @Roles(Role.SCHOOL_ADMIN)
  @HttpCode(HttpStatus.OK)
  decide(
    @Param('id', uuid()) id: string,
    @Body() dto: DecideLocalTimplanDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<LocalTimplanResponse> {
    return this.timplans.decide(id, dto, user);
  }

  @Post(':id/reopen')
  @Roles(Role.SCHOOL_ADMIN)
  reopen(
    @Param('id', uuid()) id: string,
    @Body() dto: CopyLocalTimplanDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<LocalTimplanDetail> {
    return this.timplans.reopen(id, dto, user);
  }

  /**
   * Skapa timplansposter for a läsår: dryRun true previews, false creates the
   * missing rows (idempotent). 200 either way — an apply that creates nothing
   * is an answer, not a new resource. Throttled like the imports: one call can
   * write a few hundred rows.
   */
  @Post(':id/generate-requirements')
  @Roles(Role.SCHOOL_ADMIN)
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  generateRequirements(
    @Param('id', uuid()) id: string,
    @Body() dto: GenerateRequirementsDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<GenerateRequirementsResponse> {
    return this.requirements.generate(id, dto, user);
  }

  @Post(':id/copy')
  @Roles(Role.SCHOOL_ADMIN)
  copy(
    @Param('id', uuid()) id: string,
    @Body() dto: CopyLocalTimplanDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<LocalTimplanDetail> {
    return this.timplans.copy(id, dto, user);
  }
}
