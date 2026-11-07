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
 * KRISLÄGE (20270113091000) IS DECIDED HERE TOO, though no route of it is
 * listed: the alarm's lists and the protocol (GET /api/v1/crisis/alarms/:id and
 * .../protocol) answer the screen in JSON, and no path of them is a file or a
 * feed. They name every pupil on purpose, a protected one too: the roll call
 * exists to account for everyone in the building, the register already names
 * the pupil to the teacher, and a pupil nobody could see on the list would be
 * a pupil nobody looked for. The files made from them, the protocol as CSV and
 * on paper, are the web's, and there the rule is HOLDS_OUT: a marked pupil is
 * not named and is counted (web/lib/people-files.ts, protocol-actions.ts). The
 * same goes for the teacher's route (GET /api/v1/crisis/mine): its `others` is
 * every pupil of the school by name and class, so that a teacher who finds a
 * pupil who is on nobody's list of hers can say so; a protected pupil is in it,
 * because the pupil nobody can pick is the pupil nobody finds, and staff read
 * the school's pupils directly already. It is JSON for the phone's encrypted
 * store, not a file. The app has no export. A route of Krisläge that ever answers a file belongs in
 * the list below, by name, before it ships.
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
  /**
   * The marked persons are never in the answer, and the answer does not count them: it goes to a reader who must not learn that
   * someone is held back (Schemavisaren, 20270118090000; the print set of the same pages).
   */
  | 'NEVER_SHOWN'
  /** The recipient is to have everyone: the marked are in it, and the answer counts them. */
  | 'KEEPS_AND_SAYS'
  /** Names staff and no pupil or guardian (pupils, if at all, as a count); the one exception, a user who holds a lesson without being staff by role, is said in that route's `why`. Not filtered: see `why`. */
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
      'Registerutdrag (GDPR art. 15): one person\'s own data, the person themselves included if marked, and no other marked person (held out and counted). ' +
      'The extract of a marked person names nobody else, by id or address, in any file; any extract leaves out the pupil\'s part of a row that is not about the person.',
  },
  'GET /api/v1/staffing/scb-file': {
    rule: 'KEEPS_AND_SAYS',
    why: 'SCB is to have every teacher (lärarregistret): the file keeps them, and protectedInFile says how many.',
  },
  'POST /api/v1/schedule-exchange/export': {
    rule: 'NAMES_STAFF',
    why:
      'The timetable for Untis, aSc or a spreadsheet: teachers by signature, name and e-mail, lessons by group. A user who holds a lesson without being a teacher or ' +
      'administrator by role (a pupil or guardian put on it by hand) is named like a teacher, since the lesson is theirs, unless the person is marked: a marked one is ' +
      'left out, the lesson stands without a teacher, and the file\'s notes say how many. A marked teacher stays, as in every schedule file.',
  },
  'GET /api/v1/print/timetables': {
    rule: 'NEVER_SHOWN',
    why:
      'The print set: teachers by signature or name, without a teacher hidden from public timetables (TeacherPublicLabels) and without a teacher with a protected identity, ' +
      'and without a class or room the school hides from the viewer (PublicTimetableHidden), named neither as a sheet nor on another sheet ' +
      '(the week builder is Schemavisaren\'s, app.timetable_week_days); never a pupil. Uncounted: the sheet of the school\'s teachers is the school\'s own.',
  },
  'GET /api/v1/lesson-logs/class-book': {
    rule: 'NAMES_STAFF',
    why: 'The klassbok: teachers by name, pupils only as a count.',
  },
  'GET /public/v1/calendar-feeds/:file': {
    rule: 'ONE_PERSON',
    why:
      'A person\'s own week, or a guardian\'s child\'s, behind an address the person made (its own authority, not Schemavisaren\'s modes): colleagues as teachers, no other pupil. ' +
      'The people it names besides the owner follow the viewer\'s rule: a teacher hidden by the school or with a protected identity is not named.',
  },
  'GET /public/v1/timetables/:token': {
    rule: 'NEVER_SHOWN',
    why:
      'Schemavisaren (20270118090000; GET /api/v1/schemavisaren/:token is the same door for signed-in staff): groups, rooms and teachers, and a pupil\'s own week by a code. ' +
      'Never a person with a protected identity, whatever the mode or the audience: no such teacher is named, listed or given a page; no such pupil, nor a pupil with a ' +
      'protected guardian, is given a page; no guardian is in any document. A teacher hidden by the school (TeacherPublicLabels) and a class, group, room or pupil ' +
      'hidden one by one (PublicTimetableHidden) read as a link that does not exist, as does everything else the viewer will not show. The answer says nothing of who is held back.',
  },
  'GET /public/v1/timetables/:token/embed': {
    rule: 'NEVER_SHOWN',
    why: 'Schemavisaren embedded: the same document, only for a viewer open to everyone, and never for a pupil.',
  },
  'GET /api/v1/access-log': {
    rule: 'ONE_PERSON',
    why: 'The läslogg of one data subject, dataskydd\'s answer to that person.',
  },
  'GET /ss12000/*': {
    rule: 'INTEGRATION',
    why:
      'The SS12000 providers (v1, v2.0) answer the systems the school connected with a key, under an agreement, for the pupils ' +
      'they serve: a pupil left out would lose their lessons and attendance there. v2.0 passes the register\'s marking on ' +
      '(securityMarking, 20270111090000) so the system can protect the person: the sync\'s kind on Person, and on a reference ' +
      'with the name; nothing for a mark by hand. v1 has no field for it.',
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
