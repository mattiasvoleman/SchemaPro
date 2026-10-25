import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UseFilters, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../auth/decorators/public.decorator';
import { Ss12000V2ExceptionFilter, v2Errors } from './errors';
import { Ss12000HuvudmanReads, type GetMethod, type HuvudmanCaller, type ListMethod, type LookupMethod } from './huvudman-reads';
import { Ss12000V2Guard, type Ss12000V2Request } from './ss12000-v2.guard';
import { Ss12000V2Service, type V2Caller } from './ss12000-v2.service';
import { Ss12000SubscriptionsService } from './subscriptions.service';

function caller(request: Ss12000V2Request): V2Caller {
  // Set by Ss12000V2Guard from the verified key, never from request input.
  return request.ss12000!;
}

/**
 * A school's own key, for the subscriptions: a subscription holds one
 * school's signing secret and address, and a huvudman's key holds no
 * subscriptions.write (HUVUDMAN_SCOPES).
 */
function schoolKey(request: Ss12000V2Request): V2Caller {
  const found = request.ss12000!;
  if (found.huvudman) throw v2Errors.notASchoolKey();
  return found;
}

/** A huvudman's key, as Ss12000HuvudmanReads reads with it; null for a school's. */
function huvudmanKey(request: Ss12000V2Request): HuvudmanCaller | null {
  const found = request.ss12000!;
  return found.huvudman
    ? { keyId: found.keyId, scopes: found.scopes, huvudman: found.huvudman.huvudman, schools: found.huvudman.schools }
    : null;
}

type Raw = Record<string, unknown>;

/**
 * SS12000 2.1 (SIS's OpenAPI 2.1.0, S1) under the server path /v2.0, as
 * S1's servers.url and IST's layout have it: a consumer configured for an
 * IST source appends the same resource paths to
 * https://<api>/ss12000/v2.0. Beside /ss12000/v1, which keeps working byte
 * for byte.
 *
 * Every route: Ss12000V2Guard (Bearer or X-API-Key, per-key limit, the key's
 * scopes), S1's Error body (Ss12000V2ExceptionFilter, which logs the path
 * and never the query), and the global ThrottlerGuard skipped (it keys on
 * the address). Query strings reach the service whole and are checked
 * against S1's parameters there (query.ts).
 */
@Controller('ss12000/v2.0')
@Public()
@SkipThrottle()
@UseGuards(Ss12000V2Guard)
@UseFilters(Ss12000V2ExceptionFilter)
export class Ss12000V2Controller {
  constructor(
    private readonly provider: Ss12000V2Service,
    private readonly subscriptions: Ss12000SubscriptionsService,
    private readonly huvudmanReads: Ss12000HuvudmanReads,
  ) {}

  // A school's key reads its school; a huvudman's key (Huvudman,
  // 20261212090000) every school its huvudman owns, one at a time.
  private list(req: Ss12000V2Request, method: ListMethod, query: Raw) {
    const huvudman = huvudmanKey(req);
    return huvudman ? this.huvudmanReads.list(method, huvudman, query) : this.provider[method](caller(req), query);
  }
  private get(req: Ss12000V2Request, method: GetMethod, id: string, query: Raw) {
    const huvudman = huvudmanKey(req);
    return huvudman ? this.huvudmanReads.get(method, huvudman, id, query) : this.provider[method](caller(req), id, query);
  }
  private lookup(req: Ss12000V2Request, method: LookupMethod, body: unknown, query: Raw) {
    const huvudman = huvudmanKey(req);
    return huvudman ? this.huvudmanReads.lookup(method, huvudman, body, query) : this.provider[method](caller(req), body, query);
  }
  private deleted(req: Ss12000V2Request, query: Raw) {
    const huvudman = huvudmanKey(req);
    return huvudman ? this.huvudmanReads.deletedEntities(huvudman, query) : this.provider.deletedEntities(caller(req), query);
  }

  // --- organisations -----------------------------------------------------------
  @Get('organisations')
  organisations(@Req() req: Ss12000V2Request, @Query() query: Raw) {
    return this.list(req, 'listOrganisations', query);
  }
  @Post('organisations/lookup')
  @HttpCode(200)
  organisationsLookup(@Req() req: Ss12000V2Request, @Body() body: unknown, @Query() query: Raw) {
    return this.lookup(req, 'lookupOrganisations', body, query);
  }
  @Get('organisations/:id')
  organisation(@Req() req: Ss12000V2Request, @Param('id') id: string, @Query() query: Raw) {
    return this.get(req, 'getOrganisation', id, query);
  }

  // --- persons -----------------------------------------------------------------
  @Get('persons')
  persons(@Req() req: Ss12000V2Request, @Query() query: Raw) {
    return this.list(req, 'listPersons', query);
  }
  @Post('persons/lookup')
  @HttpCode(200)
  personsLookup(@Req() req: Ss12000V2Request, @Body() body: unknown, @Query() query: Raw) {
    return this.lookup(req, 'lookupPersons', body, query);
  }
  @Get('persons/:id')
  person(@Req() req: Ss12000V2Request, @Param('id') id: string, @Query() query: Raw) {
    return this.get(req, 'getPerson', id, query);
  }

  // --- groups ------------------------------------------------------------------
  @Get('groups')
  groups(@Req() req: Ss12000V2Request, @Query() query: Raw) {
    return this.list(req, 'listGroups', query);
  }
  @Post('groups/lookup')
  @HttpCode(200)
  groupsLookup(@Req() req: Ss12000V2Request, @Body() body: unknown, @Query() query: Raw) {
    return this.lookup(req, 'lookupGroups', body, query);
  }
  @Get('groups/:id')
  group(@Req() req: Ss12000V2Request, @Param('id') id: string, @Query() query: Raw) {
    return this.get(req, 'getGroup', id, query);
  }

  // --- duties ------------------------------------------------------------------
  @Get('duties')
  duties(@Req() req: Ss12000V2Request, @Query() query: Raw) {
    return this.list(req, 'listDuties', query);
  }
  @Post('duties/lookup')
  @HttpCode(200)
  dutiesLookup(@Req() req: Ss12000V2Request, @Body() body: unknown, @Query() query: Raw) {
    return this.lookup(req, 'lookupDuties', body, query);
  }
  @Get('duties/:id')
  duty(@Req() req: Ss12000V2Request, @Param('id') id: string, @Query() query: Raw) {
    return this.get(req, 'getDuty', id, query);
  }

  // --- activities --------------------------------------------------------------
  @Get('activities')
  activities(@Req() req: Ss12000V2Request, @Query() query: Raw) {
    return this.list(req, 'listActivities', query);
  }
  @Post('activities/lookup')
  @HttpCode(200)
  activitiesLookup(@Req() req: Ss12000V2Request, @Body() body: unknown, @Query() query: Raw) {
    return this.lookup(req, 'lookupActivities', body, query);
  }
  @Get('activities/:id')
  activity(@Req() req: Ss12000V2Request, @Param('id') id: string, @Query() query: Raw) {
    return this.get(req, 'getActivity', id, query);
  }

  // --- calendarEvents ----------------------------------------------------------
  @Get('calendarEvents')
  calendarEvents(@Req() req: Ss12000V2Request, @Query() query: Raw) {
    return this.list(req, 'listCalendarEvents', query);
  }
  @Post('calendarEvents/lookup')
  @HttpCode(200)
  calendarEventsLookup(@Req() req: Ss12000V2Request, @Body() body: unknown, @Query() query: Raw) {
    return this.lookup(req, 'lookupCalendarEvents', body, query);
  }
  @Get('calendarEvents/:id')
  calendarEvent(@Req() req: Ss12000V2Request, @Param('id') id: string, @Query() query: Raw) {
    return this.get(req, 'getCalendarEvent', id, query);
  }

  // --- rooms -------------------------------------------------------------------
  @Get('rooms')
  rooms(@Req() req: Ss12000V2Request, @Query() query: Raw) {
    return this.list(req, 'listRooms', query);
  }
  @Post('rooms/lookup')
  @HttpCode(200)
  roomsLookup(@Req() req: Ss12000V2Request, @Body() body: unknown, @Query() query: Raw) {
    return this.lookup(req, 'lookupRooms', body, query);
  }
  @Get('rooms/:id')
  room(@Req() req: Ss12000V2Request, @Param('id') id: string, @Query() query: Raw) {
    return this.get(req, 'getRoom', id, query);
  }

  // --- syllabuses --------------------------------------------------------------
  @Get('syllabuses')
  syllabuses(@Req() req: Ss12000V2Request, @Query() query: Raw) {
    return this.list(req, 'listSyllabuses', query);
  }
  @Post('syllabuses/lookup')
  @HttpCode(200)
  syllabusesLookup(@Req() req: Ss12000V2Request, @Body() body: unknown, @Query() query: Raw) {
    return this.lookup(req, 'lookupSyllabuses', body, query);
  }
  @Get('syllabuses/:id')
  syllabus(@Req() req: Ss12000V2Request, @Param('id') id: string, @Query() query: Raw) {
    return this.get(req, 'getSyllabus', id, query);
  }

  // --- attendances and absences (SS12000-närvaro: read only) ---------------------
  @Get('attendances')
  attendances(@Req() req: Ss12000V2Request, @Query() query: Raw) {
    return this.list(req, 'listAttendances', query);
  }
  @Post('attendances/lookup')
  @HttpCode(200)
  attendancesLookup(@Req() req: Ss12000V2Request, @Body() body: unknown, @Query() query: Raw) {
    return this.lookup(req, 'lookupAttendances', body, query);
  }
  @Get('attendances/:id')
  attendance(@Req() req: Ss12000V2Request, @Param('id') id: string, @Query() query: Raw) {
    return this.get(req, 'getAttendance', id, query);
  }
  @Get('absences')
  absences(@Req() req: Ss12000V2Request, @Query() query: Raw) {
    return this.list(req, 'listAbsences', query);
  }
  @Post('absences/lookup')
  @HttpCode(200)
  absencesLookup(@Req() req: Ss12000V2Request, @Body() body: unknown, @Query() query: Raw) {
    return this.lookup(req, 'lookupAbsences', body, query);
  }
  @Get('absences/:id')
  absence(@Req() req: Ss12000V2Request, @Param('id') id: string, @Query() query: Raw) {
    return this.get(req, 'getAbsence', id, query);
  }

  // --- deletedEntities ---------------------------------------------------------
  @Get('deletedEntities')
  deletedEntities(@Req() req: Ss12000V2Request, @Query() query: Raw) {
    return this.deleted(req, query);
  }

  // --- subscriptions -----------------------------------------------------------
  @Get('subscriptions')
  subscriptionList(@Req() req: Ss12000V2Request, @Query() query: Raw) {
    return this.subscriptions.list(schoolKey(req), query);
  }
  @Post('subscriptions')
  @HttpCode(201)
  subscriptionCreate(@Req() req: Ss12000V2Request, @Body() body: unknown) {
    return this.subscriptions.create(schoolKey(req), body);
  }
  @Get('subscriptions/:id')
  subscription(@Req() req: Ss12000V2Request, @Param('id') id: string) {
    return this.subscriptions.get(schoolKey(req), id);
  }
  @Patch('subscriptions/:id')
  subscriptionRenew(@Req() req: Ss12000V2Request, @Param('id') id: string) {
    return this.subscriptions.renew(schoolKey(req), id);
  }
  @Delete('subscriptions/:id')
  @HttpCode(204)
  async subscriptionEnd(@Req() req: Ss12000V2Request, @Param('id') id: string): Promise<void> {
    await this.subscriptions.end(schoolKey(req), id);
  }
}
