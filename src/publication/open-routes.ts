/*
 * THE OPEN ROUTES AND SCHEMAVISAREN'S LÄGEN (20270118090000): every route of
 * the gateway that answers without a signed-in person (@Public), and what it
 * has to do with the school's choice of how the viewer shows each kind of
 * schedule, and to whom.
 *
 * A dataskyddsombud's question is "what can a stranger read, and who decided
 * it?". A route that shows a timetable to a stranger is answered by the
 * school's modes or it is a leak, and nothing in a route's code says which.
 * So each open route is classified here, by name, and
 * test/route-guards.e2e-spec.ts fails on an open route that is not listed, on
 * a listing whose route is gone, and test/public-viewer.e2e-spec.ts asks every
 * route classed VIEWER whether it reaches the database only through the door
 * it names and answers the one not-found when that door says nothing. The
 * database half is the RLS suite (section 376): the doors a visitor may
 * execute are exactly the ones named here.
 *
 *   VIEWER          a schedule (or what frames one) shown to a stranger. It
 *                   asks one SECURITY DEFINER door of the database, which
 *                   applies the school's mode for the kind, its audience, the
 *                   schedules it hides and every protected identity; the route
 *                   itself decides nothing but the shape of the answer.
 *   OWN_CAPABILITY  a schedule behind an address the person it is about made
 *                   and holds, switched on per audience by the school
 *                   (calendarFeed*). Its authority is the person's own, not the
 *                   viewer's modes; what it names besides the owner follows
 *                   the viewer's rules (hidden or protected: not named).
 *   KEY_AUTHORITY   shows schedules, and more, to a connected system that holds
 *                   an integration key the school issued under an agreement
 *                   (the SS12000 providers). The key is the authority, and
 *                   it is not a stranger's; the viewer's modes do not govern
 *                   it (see PEOPLE_ROUTES for what it leaves out).
 *   NOT_A_SCHEDULE  shows no schedule of anyone.
 *
 * A new open route is decided here before it ships; "not a schedule" is a
 * claim the reviewer reads.
 */

export type OpenRouteRelation =
  | { relation: 'VIEWER'; door: string; why: string }
  | { relation: 'OWN_CAPABILITY'; why: string }
  | { relation: 'KEY_AUTHORITY'; why: string }
  | { relation: 'NOT_A_SCHEDULE'; why: string };

/**
 * Keyed `VERB /path` as the routing table has it; a key ending in `*` holds
 * every route under its prefix.
 */
export const OPEN_ROUTES: Readonly<Record<string, OpenRouteRelation>> = {
  'GET /public/v1/timetables/:token': {
    relation: 'VIEWER',
    door: 'app.public_timetable(',
    why: 'Schemavisaren: a class, group, teacher, room or pupil by a link or a code, or a list of one kind. app.public_timetable answers by the mode of the kind, the audience (staff-only answers a visitor as an unknown link), the hidden and the protected.',
  },
  'GET /public/v1/timetables/:token/embed': {
    relation: 'VIEWER',
    door: 'app.public_timetable_embed(',
    why: 'The websites that may frame a link\'s viewer page: asked only of a viewer open to everyone, never of a pupil\'s link, and only of a link the viewer itself answers.',
  },
  'GET /public/v1/calendar-feeds/:file': {
    relation: 'OWN_CAPABILITY',
    why: 'Kalenderprenumeration: a person\'s own week behind an address they made (app.calendar_feed), on while the school has the audience on. It is not the viewer, so no mode governs it; colleagues it names follow the viewer\'s hidden and protected rules.',
  },
  'GET /health*': {
    relation: 'NOT_A_SCHEDULE',
    why: 'Liveness and readiness probes.',
  },
  'GET /public/v1/sign-in-methods*': {
    relation: 'NOT_A_SCHEDULE',
    why: 'The login page\'s lookup of the sign-in method for an e-mail domain.',
  },
  'GET /ss12000/*': {
    relation: 'KEY_AUTHORITY',
    why: 'The SS12000 providers answer a connected system that holds an integration key, under an agreement; the key is the authority, not the viewer (see PEOPLE_ROUTES).',
  },
  'POST /ss12000/*': {
    relation: 'KEY_AUTHORITY',
    why: 'The providers\' lookups, behind the integration key.',
  },
  'PATCH /ss12000/*': {
    relation: 'KEY_AUTHORITY',
    why: 'A webhook subscription renewed, behind the integration key.',
  },
  'DELETE /ss12000/*': {
    relation: 'KEY_AUTHORITY',
    why: 'A webhook subscription ended, behind the integration key.',
  },
};

/** The listed relation for an open route, if any. */
export function openRouteOf(verb: string, path: string): OpenRouteRelation | null {
  const exact = OPEN_ROUTES[`${verb} ${path}`];
  if (exact) return exact;
  for (const [key, relation] of Object.entries(OPEN_ROUTES)) {
    if (!key.endsWith('*')) continue;
    const [keyVerb, prefix] = key.slice(0, -1).split(' ');
    if (keyVerb === verb && path.startsWith(prefix!)) return relation;
  }
  return null;
}
