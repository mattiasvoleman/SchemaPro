import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Area } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type {
  ChecklistSettings,
  ConsentAsked,
  ConsentClosed,
  ConsentDetail,
  ConsentListItem,
  ConsentWritten,
  GroupChoice,
  Instructor,
  ProofRoster,
  ProofsWritten,
  ProofVoided,
  PupilCard,
  TemplateView,
} from './checklists-views';
import { ConsentService } from './consent.service';
import {
  AskConsentDto,
  ConsentListsQueryDto,
  CreateConsentListDto,
  CreateTemplateDto,
  RecordConsentDto,
  RosterQueryDto,
  TemplatesQueryDto,
  TickProofsDto,
  UpdateTemplateDto,
  VoidProofDto,
} from './dto/checklists.dto';
import { InstructionService } from './instruction.service';

const uuid = () => new ParseUUIDPipe({ version: '4' });

/**
 * Checklistor: instruction proofs (/teacher|admin/checklists) and consent lists per class.
 *
 * An administrator writes under Drift; a teacher ticks the pupils of their own groups and lessons and writes
 * consents for their mentees; the database says which rows each may see and write. Nobody else has a route:
 * guardians confirm a consent through Kvittens (/api/v1/acknowledgements), and a pupil sees nothing here.
 * There is no export: the list is printed from the screen, and the print holds out a pupil the school has marked
 * as having a protected identity (web/lib/people-files.ts).
 */
@Controller('api/v1/checklists')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
@Area('DRIFT')
export class ChecklistsController {
  constructor(
    private readonly instructions: InstructionService,
    private readonly consents: ConsentService,
  ) {}

  /** Whether the school has Kvittens on (the app can be asked). */
  @Get('settings')
  settings(@CurrentUser() user: AuthenticatedUser): Promise<ChecklistSettings> {
    return this.consents.settings(user);
  }

  // ---- Instruktionsbevis

  @Get('templates')
  templates(@Query() query: TemplatesQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<TemplateView[]> {
    return this.instructions.templates(user, query.includeRetired === true);
  }

  @Post('templates')
  @Roles(Role.SCHOOL_ADMIN)
  createTemplate(@Body() dto: CreateTemplateDto, @CurrentUser() user: AuthenticatedUser): Promise<TemplateView> {
    return this.instructions.createTemplate(dto, user);
  }

  @Patch('templates/:id')
  @Roles(Role.SCHOOL_ADMIN)
  updateTemplate(@Param('id', uuid()) id: string, @Body() dto: UpdateTemplateDto, @CurrentUser() user: AuthenticatedUser): Promise<TemplateView> {
    return this.instructions.updateTemplate(id, dto, user);
  }

  /** The groups the caller can look at the proofs of. */
  @Get('groups')
  groups(@CurrentUser() user: AuthenticatedUser): Promise<GroupChoice[]> {
    return this.instructions.groups(user);
  }

  /** The staff who can have given an instruction. */
  @Get('instructors')
  instructors(@CurrentUser() user: AuthenticatedUser): Promise<Instructor[]> {
    return this.instructions.instructors(user);
  }

  /** A group's pupils and what they have had in a template. Recorded in the read log. */
  @Get('templates/:id/roster')
  roster(@Param('id', uuid()) id: string, @Query() query: RosterQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<ProofRoster> {
    return this.instructions.roster(id, query.groupId, user);
  }

  /**
   * The same roster for paper: a pupil with a protected identity is left out, and counted in `heldOut`. The web prints this and nothing
   * else (web/lib/people-files.ts), so a teacher, who cannot read the marks, can print too. Recorded in the read log.
   */
  @Get('templates/:id/roster/print')
  rosterForPaper(@Param('id', uuid()) id: string, @Query() query: RosterQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<ProofRoster> {
    return this.instructions.roster(id, query.groupId, user, true);
  }

  @Post('proofs')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  tick(@Body() dto: TickProofsDto, @CurrentUser() user: AuthenticatedUser): Promise<ProofsWritten> {
    return this.instructions.tick(dto, user);
  }

  /** The writer, or an administrator under Drift, voids a tick made in error. The tick stays, with why. */
  @Post('proofs/:id/void')
  @HttpCode(HttpStatus.OK)
  voidProof(@Param('id', uuid()) id: string, @Body() dto: VoidProofDto, @CurrentUser() user: AuthenticatedUser): Promise<ProofVoided> {
    return this.instructions.voidProof(id, dto, user);
  }

  // ---- Samtyckeslistor

  @Get('consent-lists')
  lists(@Query() query: ConsentListsQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<ConsentListItem[]> {
    return this.consents.lists(user, query);
  }

  @Post('consent-lists')
  createList(@Body() dto: CreateConsentListDto, @CurrentUser() user: AuthenticatedUser): Promise<ConsentListItem> {
    return this.consents.createList(dto, user);
  }

  /** The list's pupils and where each stands. Recorded in the read log. */
  @Get('consent-lists/:id')
  detail(@Param('id', uuid()) id: string, @CurrentUser() user: AuthenticatedUser): Promise<ConsentDetail> {
    return this.consents.detail(id, user);
  }

  /** The same list for paper: a pupil with a protected identity is left out, and counted in `heldOut`. Recorded in the read log. */
  @Get('consent-lists/:id/print')
  detailForPaper(@Param('id', uuid()) id: string, @CurrentUser() user: AuthenticatedUser): Promise<ConsentDetail> {
    return this.consents.detail(id, user, true);
  }

  @Post('consent-lists/:id/entries')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  record(@Param('id', uuid()) id: string, @Body() dto: RecordConsentDto, @CurrentUser() user: AuthenticatedUser): Promise<ConsentWritten> {
    return this.consents.record(id, dto, user);
  }

  /** Asks the guardians through Kvittens (the rule ALL), as that route does: five a minute, and its limits besides. */
  @Post('consent-lists/:id/ask')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  ask(@Param('id', uuid()) id: string, @Body() dto: AskConsentDto, @CurrentUser() user: AuthenticatedUser): Promise<ConsentAsked> {
    return this.consents.ask(id, dto, user);
  }

  @Post('consent-lists/:id/close')
  @HttpCode(HttpStatus.OK)
  close(@Param('id', uuid()) id: string, @CurrentUser() user: AuthenticatedUser): Promise<ConsentClosed> {
    return this.consents.close(id, user);
  }

  /** One pupil: every tick and where they stand on each list. Recorded in the read log. */
  @Get('students/:id')
  student(@Param('id', uuid()) id: string, @CurrentUser() user: AuthenticatedUser): Promise<PupilCard> {
    return this.consents.student(id, user);
  }
}
