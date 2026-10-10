import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UseFilters, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../auth/decorators/public.decorator';
import { Ss12000V2ExceptionFilter } from './errors';
import { Ss12000V2Guard, type Ss12000V2Request } from './ss12000-v2.guard';
import { Ss12000V2Service, type V2Caller } from './ss12000-v2.service';
import { Ss12000SubscriptionsService } from './subscriptions.service';

function caller(request: Ss12000V2Request): V2Caller {
  // Set by Ss12000V2Guard from the verified key, never from request input.
  return request.ss12000!;
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
  ) {}

  // --- organisations -----------------------------------------------------------
  @Get('organisations')
  organisations(@Req() req: Ss12000V2Request, @Query() query: Raw) {
    return this.provider.listOrganisations(caller(req), query);
  }
  @Post('organisations/lookup')
  @HttpCode(200)
  organisationsLookup(@Req() req: Ss12000V2Request, @Body() body: unknown, @Query() query: Raw) {
    return this.provider.lookupOrganisations(caller(req), body, query);
  }
  @Get('organisations/:id')
  organisation(@Req() req: Ss12000V2Request, @Param('id') id: string, @Query() query: Raw) {
    return this.provider.getOrganisation(caller(req), id, query);
  }

  // --- persons -----------------------------------------------------------------
  @Get('persons')
  persons(@Req() req: Ss12000V2Request, @Query() query: Raw) {
    return this.provider.listPersons(caller(req), query);
  }
  @Post('persons/lookup')
  @HttpCode(200)
  personsLookup(@Req() req: Ss12000V2Request, @Body() body: unknown, @Query() query: Raw) {
    return this.provider.lookupPersons(caller(req), body, query);
  }
  @Get('persons/:id')
  person(@Req() req: Ss12000V2Request, @Param('id') id: string, @Query() query: Raw) {
    return this.provider.getPerson(caller(req), id, query);
  }

  // --- groups ------------------------------------------------------------------
  @Get('groups')
  groups(@Req() req: Ss12000V2Request, @Query() query: Raw) {
    return this.provider.listGroups(caller(req), query);
  }
  @Post('groups/lookup')
  @HttpCode(200)
  groupsLookup(@Req() req: Ss12000V2Request, @Body() body: unknown, @Query() query: Raw) {
    return this.provider.lookupGroups(caller(req), body, query);
  }
  @Get('groups/:id')
  group(@Req() req: Ss12000V2Request, @Param('id') id: string, @Query() query: Raw) {
    return this.provider.getGroup(caller(req), id, query);
  }

  // --- duties ------------------------------------------------------------------
  @Get('duties')
  duties(@Req() req: Ss12000V2Request, @Query() query: Raw) {
    return this.provider.listDuties(caller(req), query);
  }
  @Post('duties/lookup')
  @HttpCode(200)
  dutiesLookup(@Req() req: Ss12000V2Request, @Body() body: unknown, @Query() query: Raw) {
    return this.provider.lookupDuties(caller(req), body, query);
  }
  @Get('duties/:id')
  duty(@Req() req: Ss12000V2Request, @Param('id') id: string, @Query() query: Raw) {
    return this.provider.getDuty(caller(req), id, query);
  }

  // --- activities --------------------------------------------------------------
  @Get('activities')
  activities(@Req() req: Ss12000V2Request, @Query() query: Raw) {
    return this.provider.listActivities(caller(req), query);
  }
  @Post('activities/lookup')
  @HttpCode(200)
  activitiesLookup(@Req() req: Ss12000V2Request, @Body() body: unknown, @Query() query: Raw) {
    return this.provider.lookupActivities(caller(req), body, query);
  }
  @Get('activities/:id')
  activity(@Req() req: Ss12000V2Request, @Param('id') id: string, @Query() query: Raw) {
    return this.provider.getActivity(caller(req), id, query);
  }

  // --- calendarEvents ----------------------------------------------------------
  @Get('calendarEvents')
  calendarEvents(@Req() req: Ss12000V2Request, @Query() query: Raw) {
    return this.provider.listCalendarEvents(caller(req), query);
  }
  @Post('calendarEvents/lookup')
  @HttpCode(200)
  calendarEventsLookup(@Req() req: Ss12000V2Request, @Body() body: unknown, @Query() query: Raw) {
    return this.provider.lookupCalendarEvents(caller(req), body, query);
  }
  @Get('calendarEvents/:id')
  calendarEvent(@Req() req: Ss12000V2Request, @Param('id') id: string, @Query() query: Raw) {
    return this.provider.getCalendarEvent(caller(req), id, query);
  }

  // --- rooms -------------------------------------------------------------------
  @Get('rooms')
  rooms(@Req() req: Ss12000V2Request, @Query() query: Raw) {
    return this.provider.listRooms(caller(req), query);
  }
  @Post('rooms/lookup')
  @HttpCode(200)
  roomsLookup(@Req() req: Ss12000V2Request, @Body() body: unknown, @Query() query: Raw) {
    return this.provider.lookupRooms(caller(req), body, query);
  }
  @Get('rooms/:id')
  room(@Req() req: Ss12000V2Request, @Param('id') id: string, @Query() query: Raw) {
    return this.provider.getRoom(caller(req), id, query);
  }

  // --- syllabuses --------------------------------------------------------------
  @Get('syllabuses')
  syllabuses(@Req() req: Ss12000V2Request, @Query() query: Raw) {
    return this.provider.listSyllabuses(caller(req), query);
  }
  @Post('syllabuses/lookup')
  @HttpCode(200)
  syllabusesLookup(@Req() req: Ss12000V2Request, @Body() body: unknown, @Query() query: Raw) {
    return this.provider.lookupSyllabuses(caller(req), body, query);
  }
  @Get('syllabuses/:id')
  syllabus(@Req() req: Ss12000V2Request, @Param('id') id: string, @Query() query: Raw) {
    return this.provider.getSyllabus(caller(req), id, query);
  }

  // --- deletedEntities ---------------------------------------------------------
  @Get('deletedEntities')
  deletedEntities(@Req() req: Ss12000V2Request, @Query() query: Raw) {
    return this.provider.deletedEntities(caller(req), query);
  }

  // --- subscriptions -----------------------------------------------------------
  @Get('subscriptions')
  subscriptionList(@Req() req: Ss12000V2Request, @Query() query: Raw) {
    return this.subscriptions.list(caller(req), query);
  }
  @Post('subscriptions')
  @HttpCode(201)
  subscriptionCreate(@Req() req: Ss12000V2Request, @Body() body: unknown) {
    return this.subscriptions.create(caller(req), body);
  }
  @Get('subscriptions/:id')
  subscription(@Req() req: Ss12000V2Request, @Param('id') id: string) {
    return this.subscriptions.get(caller(req), id);
  }
  @Patch('subscriptions/:id')
  subscriptionRenew(@Req() req: Ss12000V2Request, @Param('id') id: string) {
    return this.subscriptions.renew(caller(req), id);
  }
  @Delete('subscriptions/:id')
  @HttpCode(204)
  async subscriptionEnd(@Req() req: Ss12000V2Request, @Param('id') id: string): Promise<void> {
    await this.subscriptions.end(caller(req), id);
  }
}
