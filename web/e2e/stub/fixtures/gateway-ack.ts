import type {
  AckDetail,
  AckGuardianRow,
  AckListItem,
  AckMine,
  AckPage,
  AckPupilChoice,
  AckPupilRow,
  AckSettings,
  AckUsage,
} from "../../../lib/ack";
import { Reply, route, type GatewayContext, type GatewayRoute } from "../gateway-routes";
import { KIND, uid } from "../sessions";
import { addDays, THIS_MONDAY } from "./calendar";
import { DUTIES } from "./staffing-rows";
import { ADMIN, byId, GROUP_LIST, GUARDIAN_LINKS, GUARDIANS, STUDENTS, STUDENT_LIST, TEACHERS } from "./world";

/**
 * Kvittens as the gateway answers it (src/ack/): the school's switch, the
 * requests staff have made for a guardian's confirmation with who confirmed
 * them, and the guardian's own list.
 *
 * Kvittens is on, with a reminder after two days. Three requests:
 *  - Anna's "Utflykten på torsdag" (one guardian is enough) about 7A: Ella's
 *    guardian has confirmed, Ines's has not. Jamal has no guardian to ask and is
 *    not in it. The reminder is scheduled, and Anna (who wrote it) and the
 *    administrator may stop it.
 *  - Rektor's "Beslutet om ledighet" (every guardian must confirm): Sara has not
 *    confirmed for either of her children, and Tom's custody of Ines has ended,
 *    so nobody can confirm for Ines. The reminder is scheduled, and only the
 *    administrator (who wrote it) may stop it: Anna may not.
 *  - Anna's "Vad som hände vid larmet" (every guardian), long since done, the
 *    reminder gone out.
 * The day's use of the limits (GET /usage) is counted from the first two, which were written within the
 * last day; the third is a week old and counts for nothing. An administrator reads the school's, their own share
 * and the senders; a teacher only their own share.
 * A teacher sees the requests with a pupil of the class they mentor and only
 * those pupils; the guardian sees their own children's and their own time.
 *
 * The lists answer a page (`limit` and `after` are honoured, newest first). A
 * confirmation and a stopped reminder are answered but not kept, as the
 * confirmation always was: the requests are the same on the next read.
 */

const SETTINGS: AckSettings = { enabled: true, remindAfterDays: 2 };

const at = (days: number, time: string) => `${addDays(THIS_MONDAY, days)}T${time}:00.000Z`;

const nameOf = (pupil: (typeof STUDENT_LIST)[number]) => `${pupil.firstName} ${pupil.lastName}`;
const classOf = (pupil: (typeof STUDENT_LIST)[number]) => byId(GROUP_LIST, pupil.studentGroupId)?.name ?? null;
const guardianName = (guardian: (typeof GUARDIANS)[keyof typeof GUARDIANS]) => `${guardian.firstName} ${guardian.lastName}`;

function guardianRow(
  guardian: (typeof GUARDIANS)[keyof typeof GUARDIANS],
  state: AckGuardianRow["state"],
  ackedAt: string | null = null,
  remindedAt: string | null = null,
): AckGuardianRow {
  return { id: guardian.id, name: guardianName(guardian), state, ackedAt, remindedAt };
}

function pupilRow(pupil: (typeof STUDENT_LIST)[number], guardians: AckGuardianRow[]): AckPupilRow {
  return { id: pupil.id, name: nameOf(pupil), className: classOf(pupil), met: guardians.some((one) => one.state === "CONFIRMED"), guardians };
}

/** The page the query asks for: `limit` items after the id `after`, and the id to ask after for the next. */
function pageOf<T extends { id: string }>(items: T[], query: URLSearchParams): AckPage<T> {
  const limit = Math.min(Number(query.get("limit")) || 50, 100);
  const after = query.get("after");
  const from = after ? items.findIndex((one) => one.id === after) + 1 : 0;
  const shown = items.slice(from, from + limit);
  return { items: shown, next: from + limit < items.length ? shown[shown.length - 1]!.id : null };
}

const DETAILS: AckDetail[] = [
  {
    id: uid(KIND.misc, 8301),
    title: "Utflykten på torsdag",
    body: "Vi åker med buss kl 8.15 från skolgården.\nTa med matsäck och regnkläder.",
    rule: "ANY",
    authorName: `${TEACHERS.anna.firstName} ${TEACHERS.anna.lastName}`,
    createdAt: at(0, "07:30"),
    remindAt: at(2, "07:30"),
    reminderSentAt: null,
    reminderMirroredAt: null,
    reminder: "SCHEDULED",
    mayStopReminder: false,
    pupils: [
      pupilRow(STUDENTS.ella, [guardianRow(GUARDIANS.sara, "CONFIRMED", at(0, "08:12"))]),
      pupilRow(STUDENTS.ines, [guardianRow(GUARDIANS.tom, "WAITING")]),
    ],
  },
  {
    id: uid(KIND.misc, 8302),
    title: "Beslutet om ledighet",
    body: "Beslutet finns i Rastra. Läs det och bekräfta att du har tagit del av det.",
    rule: "ALL",
    authorName: `${ADMIN.firstName} ${ADMIN.lastName}`,
    createdAt: at(-1, "09:00"),
    remindAt: at(1, "09:00"),
    reminderSentAt: null,
    reminderMirroredAt: null,
    reminder: "SCHEDULED",
    mayStopReminder: false,
    pupils: [
      pupilRow(STUDENTS.ella, [guardianRow(GUARDIANS.sara, "WAITING")]),
      pupilRow(STUDENTS.hugo, [guardianRow(GUARDIANS.sara, "WAITING")]),
      pupilRow(STUDENTS.ines, [guardianRow(GUARDIANS.tom, "ENDED")]),
    ],
  },
  {
    id: uid(KIND.misc, 8303),
    title: "Vad som hände vid larmet",
    body: "Skolan hade ett larm i går förmiddag. Alla är oskadda och lektionerna har börjat igen.",
    rule: "ALL",
    authorName: `${TEACHERS.anna.firstName} ${TEACHERS.anna.lastName}`,
    createdAt: at(-8, "13:00"),
    remindAt: at(-6, "13:00"),
    reminderSentAt: at(-6, "13:01"),
    reminderMirroredAt: at(-6, "13:02"),
    reminder: "SENT",
    mayStopReminder: false,
    pupils: [
      pupilRow(STUDENTS.ella, [guardianRow(GUARDIANS.sara, "CONFIRMED", at(-6, "17:40"), at(-6, "13:01"))]),
      pupilRow(STUDENTS.hugo, [guardianRow(GUARDIANS.sara, "CONFIRMED", at(-6, "17:40"), at(-6, "13:01"))]),
    ],
  },
];

/** Who wrote each request (Users.id), which is who besides an administrator may stop its reminder. */
const AUTHOR_OF: Record<string, string> = {
  [DETAILS[0]!.id]: TEACHERS.anna.id,
  [DETAILS[1]!.id]: ADMIN.id,
  [DETAILS[2]!.id]: TEACHERS.anna.id,
};

/** The day's use: the receipts of the requests written within the last day, by who wrote them. */
const TODAY = [DETAILS[0]!, DETAILS[1]!];
const receiptsOf = (one: AckDetail) => one.pupils.reduce((sum, pupil) => sum + pupil.guardians.length, 0);
const usedBy = (userId: string) => TODAY.filter((one) => AUTHOR_OF[one.id] === userId).reduce((sum, one) => sum + receiptsOf(one), 0);

function usageOf(context: GatewayContext): AckUsage {
  const person = context.person!;
  const admin = person.persona === "admin";
  const mine = { used: usedBy(person.userId), limit: admin ? 8000 : 2000 };
  if (!admin) return { school: null, mine, senders: null };
  const sender = (name: string, userId: string, limit: number) => ({ name, used: usedBy(userId), limit });
  return {
    school: { used: TODAY.reduce((sum, one) => sum + receiptsOf(one), 0), limit: 20000 },
    mine,
    senders: [
      sender(`${ADMIN.firstName} ${ADMIN.lastName}`, ADMIN.id, 8000),
      sender(`${TEACHERS.anna.firstName} ${TEACHERS.anna.lastName}`, TEACHERS.anna.id, 2000),
    ].sort((a, b) => b.used - a.used),
  };
}

/** The request as the reader gets it: they may stop a scheduled reminder if they wrote it or administer the school. */
function withStopRight(one: AckDetail, context: GatewayContext): AckDetail {
  const person = context.person!;
  const mayStopReminder = one.reminder === "SCHEDULED" && (person.persona === "admin" || AUTHOR_OF[one.id] === person.userId);
  return { ...one, mayStopReminder };
}

/** The classes a teacher holds MENTORSKAP for. */
function mentored(userId: string): Set<string> {
  return new Set(DUTIES.filter((duty) => duty.kind === "MENTORSKAP" && duty.userId === userId).map((duty) => duty.studentGroupId ?? ""));
}

const guardiansOf = (pupilId: string) => GUARDIAN_LINKS.filter((link) => link.studentId === pupilId).length;

/** The pupils the reader may ask about: every one for an administrator, the mentees for a teacher. */
function askable(context: GatewayContext): AckPupilChoice[] {
  const person = context.person!;
  const classes = person.persona === "teacher" ? mentored(person.userId) : null;
  return STUDENT_LIST.filter((pupil) => classes === null || classes.has(pupil.studentGroupId ?? "")).map((pupil) => ({
    id: pupil.id,
    name: nameOf(pupil),
    className: classOf(pupil),
    guardians: guardiansOf(pupil.id),
  }));
}

/** A request as the reader sees it: a teacher's only with the pupils of the classes they mentor. */
function seenBy(context: GatewayContext): AckDetail[] {
  const person = context.person!;
  if (person.persona === "admin") return DETAILS;
  const classes = mentored(person.userId);
  const mine = new Set(STUDENT_LIST.filter((pupil) => classes.has(pupil.studentGroupId ?? "")).map((pupil) => pupil.id));
  return DETAILS.map((one) => ({ ...one, pupils: one.pupils.filter((pupil) => mine.has(pupil.id)) })).filter((one) => one.pupils.length > 0);
}

function listItem(one: AckDetail): AckListItem {
  return {
    id: one.id,
    title: one.title,
    rule: one.rule,
    authorName: one.authorName,
    createdAt: one.createdAt,
    pupils: one.pupils.length,
    met: one.pupils.filter((pupil) => pupil.met).length,
    waiting: one.pupils.reduce((sum, pupil) => sum + pupil.guardians.filter((guardian) => guardian.state === "WAITING").length, 0),
    remindAt: one.remindAt,
    reminder: one.reminder,
  };
}

/** The guardian's own: the requests about a child of theirs, and the time of their own confirmation. */
function mineOf(context: GatewayContext): AckMine[] {
  const me = context.person!.userId;
  const children = new Set(GUARDIAN_LINKS.filter((link) => link.guardianId === me).map((link) => link.studentId));
  return DETAILS.flatMap((one) => {
    const own = one.pupils.filter((pupil) => children.has(pupil.id) && pupil.guardians.some((guardian) => guardian.id === me));
    if (own.length === 0) return [];
    const times = own.flatMap((pupil) => pupil.guardians.filter((guardian) => guardian.id === me).map((guardian) => guardian.ackedAt));
    return [
      {
        id: one.id,
        title: one.title,
        body: one.body,
        rule: one.rule,
        authorName: one.authorName,
        createdAt: one.createdAt,
        children: own.map((pupil) => ({ id: pupil.id, name: pupil.name })),
        ackedAt: times.every((time) => time !== null) ? times.map((time) => time!).sort()[0]! : null,
      },
    ];
  });
}

const staffOnly = (context: GatewayContext): Reply | null => {
  if (!context.person) return new Reply(401, { message: "Not authenticated." });
  return context.person.persona === "admin" || context.person.persona === "teacher" ? null : new Reply(403, { message: "Forbidden." });
};

export const ackRoutes: GatewayRoute[] = [
  route("GET", "/api/v1/acknowledgements/settings", (context) => staffOnly(context) ?? SETTINGS),
  route("PUT", "/api/v1/acknowledgements/settings", (context) => {
    if (!context.person) return new Reply(401, { message: "Not authenticated." });
    return context.person.persona === "admin" ? { ...SETTINGS, ...(context.body as Partial<AckSettings>) } : new Reply(403, { message: "Forbidden." });
  }),
  route("GET", "/api/v1/acknowledgements/usage", (context) => staffOnly(context) ?? usageOf(context)),
  route("GET", "/api/v1/acknowledgements/pupils", (context) => staffOnly(context) ?? askable(context)),
  route("GET", "/api/v1/acknowledgements/mine", (context) => {
    if (!context.person) return new Reply(401, { message: "Not authenticated." });
    return context.person.persona === "guardian" ? pageOf(mineOf(context), context.query) : new Reply(403, { message: "Forbidden." });
  }),
  route("GET", "/api/v1/acknowledgements", (context) => staffOnly(context) ?? pageOf(seenBy(context).map(listItem), context.query)),
  route("GET", "/api/v1/acknowledgements/:id", (context) => {
    const refused = staffOnly(context);
    if (refused) return refused;
    const found = seenBy(context).find((one) => one.id === context.params.id);
    return found ? withStopRight(found, context) : new Reply(404, { message: "Meddelandet finns inte, eller gäller inte dig.", code: "ACK_NOT_FOUND" });
  }),
  route("POST", "/api/v1/acknowledgements", (context) => {
    const refused = staffOnly(context);
    if (refused) return refused;
    const ids = (context.body as { studentIds?: string[] } | null)?.studentIds ?? [];
    const asked = ids.filter((id) => guardiansOf(id) > 0);
    return {
      id: uid(KIND.misc, 8399),
      pupils: asked.length,
      guardians: asked.reduce((sum, id) => sum + guardiansOf(id), 0),
      withoutGuardian: ids.filter((id) => guardiansOf(id) === 0),
    };
  }),
  route("POST", "/api/v1/acknowledgements/:id/stop-reminder", (context) => {
    const refused = staffOnly(context);
    if (refused) return refused;
    const found = seenBy(context).find((one) => one.id === context.params.id);
    if (!found) return new Reply(404, { message: "Meddelandet finns inte, eller gäller inte dig.", code: "ACK_NOT_FOUND" });
    if (found.reminder !== "SCHEDULED") return { reminder: found.reminder };
    return withStopRight(found, context).mayStopReminder
      ? { reminder: "STOPPED" }
      : new Reply(403, { message: "Bara den som skrev meddelandet, eller en administratör, kan stoppa påminnelsen.", code: "ACK_NOT_STAFF" });
  }),
  route("POST", "/api/v1/acknowledgements/:id/confirm", (context) => {
    if (!context.person) return new Reply(401, { message: "Not authenticated." });
    if (context.person.persona !== "guardian") return new Reply(403, { message: "Forbidden." });
    return mineOf(context).some((one) => one.id === context.params.id)
      ? { ackedAt: at(2, "08:00") }
      : new Reply(404, { message: "Meddelandet finns inte, eller gäller inte dig.", code: "ACK_NOT_FOUND" });
  }),
];
