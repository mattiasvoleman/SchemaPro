/*
 * SKYDDAD IDENTITET (20270107090000): every route of the gateway that hands
 * out a file or a feed naming people, and what it does with a person the
 * school has marked as having a protected identity (src/users/person-
 * protections.ts). The web's files are the other half of the list
 * (web/lib/people-files.ts, with its own test).
 *
 * test/route-guards.e2e-spec.ts reads the routing table and fails on a route
 * whose path looks like a file or a feed (FILE_ROUTE) and is not listed
 * here, and on a listed route that is gone. A new export is decided here, by
 * name, before it ships.
 *
 * Why the database cannot hold this instead: an export is built in the
 * gateway or the browser from ordinary reads under RLS, and nothing in the
 * catalogue says which reads become a file. The rule that can be held there
 * is held there (the marks' arms, RLS sections 340–344); which reads are
 * files is held here.
 */

export type PeopleRouteRule =
  /** The marked persons, and every row naming one, are not in the answer; it counts them. */
  | 'HOLDS_OUT'
  /** The recipient is to have everyone: the marked are in it, and the answer counts them. */
  | 'KEEPS_AND_SAYS'
  /** Names staff and no pupil or guardian (pupils, if at all, as a count). Not filtered: see `why`. */
  | 'NAMES_STAFF'
  /** About one person, for that person's own sake or the person's guardian's. */
  | 'ONE_PERSON'
  /** A system the school connected; not filtered in this release: see `why`. */
  | 'INTEGRATION';

export interface PeopleRoute {
  rule: PeopleRouteRule;
  why: string;
}

/**
 * A route path that looks like a file or a feed. The route-guards test also
 * counts a handler that sets Content-Disposition or writes the response
 * itself (@Res), whatever its path.
 */
export const FILE_ROUTE =
  /\/export\b|\/subject-access\b|scb-file|\/print\/|class-book|^\/public\/v1\/(calendar-feeds|timetables)\/|^\/ss12000\/|^\/api\/v1\/access-log$|\.(csv|tsv|txt|xlsx?|ics|pdf|zip|xml)$/i;

/**
 * Keyed `VERB /path` as the routing table has it; a key ending in `/*` holds
 * every route under its prefix (the SS12000 providers).
 */
export const PEOPLE_ROUTES: Readonly<Record<string, PeopleRoute>> = {
  'GET /api/v1/guardian-links/export': {
    rule: 'HOLDS_OUT',
    why: 'vardnadshavare.csv: a link where the pupil or the guardian is marked is held out, and counted (heldOut).',
  },
  'GET /api/v1/school-exports/:id/file': {
    rule: 'HOLDS_OUT',
    why:
      'Hela skolans data: the zip holds out every marked person and every row about one (the build reads the marks first; the manifest counts them, ' +
      'heldOut). Fetched only by rektor and a full administrator, and recorded in the läslogg before the first byte.',
  },
  'POST /api/v1/school-exports/subject-access': {
    rule: 'ONE_PERSON',
    why:
      'Registerutdrag (GDPR art. 15): one person\'s own data, the person themselves included if marked, and no other marked person (held out and counted).',
  },
  'GET /api/v1/staffing/scb-file': {
    rule: 'KEEPS_AND_SAYS',
    why: 'SCB is to have every teacher (lärarregistret): the file keeps them, and protectedInFile says how many.',
  },
  'POST /api/v1/schedule-exchange/export': {
    rule: 'NAMES_STAFF',
    why: 'The timetable for Untis, aSc or a spreadsheet: teachers by signature, name and e-mail, lessons by group, no pupil.',
  },
  'GET /api/v1/print/timetables': {
    rule: 'NAMES_STAFF',
    why: 'The print set: teachers by signature or name, already without a teacher hidden from public timetables (TeacherPublicLabels).',
  },
  'GET /api/v1/lesson-logs/class-book': {
    rule: 'NAMES_STAFF',
    why: 'The klassbok: teachers by name, pupils only as a count.',
  },
  'GET /public/v1/calendar-feeds/:file': {
    rule: 'ONE_PERSON',
    why: 'A person\'s own week, or a guardian\'s child\'s: colleagues as teachers, no other pupil.',
  },
  'GET /public/v1/timetables/:token': {
    rule: 'NAMES_STAFF',
    why: 'Schemavisaren: groups and teachers, without a teacher hidden from public timetables; no pupil.',
  },
  'GET /public/v1/timetables/:token/embed': {
    rule: 'NAMES_STAFF',
    why: 'Schemavisaren embedded: as above.',
  },
  'GET /api/v1/access-log': {
    rule: 'ONE_PERSON',
    why: 'The läslogg of one data subject, dataskydd\'s answer to that person.',
  },
  'GET /ss12000/*': {
    rule: 'INTEGRATION',
    why:
      'The SS12000 providers (v1, v2.0) answer the systems the school connected with a key, under an agreement, for the pupils ' +
      'they serve: a pupil left out would lose their lessons and attendance there. SS12000 carries the marking itself ' +
      '(securityMarking), which needs the kind of protection, which Rastra does not store. Not filtered in this release.',
  },
  'POST /ss12000/*': {
    rule: 'INTEGRATION',
    why: 'The providers\' lookups (S1 persons/lookup and the like) and a subscription made: as above.',
  },
  'PATCH /ss12000/*': {
    rule: 'INTEGRATION',
    why: 'A webhook subscription renewed: it names entity types, no person.',
  },
  'DELETE /ss12000/*': {
    rule: 'INTEGRATION',
    why: 'A webhook subscription ended: it names nobody.',
  },
};

/** The listed rule for a route, if any. */
export function peopleRouteOf(verb: string, path: string): PeopleRoute | null {
  const exact = PEOPLE_ROUTES[`${verb} ${path}`];
  if (exact) return exact;
  for (const [key, rule] of Object.entries(PEOPLE_ROUTES)) {
    if (!key.endsWith('/*')) continue;
    const [keyVerb, prefix] = key.slice(0, -1).split(' ');
    if (keyVerb === verb && path.startsWith(prefix!)) return rule;
  }
  return null;
}
