import type {
  AckDetail,
  AckGuardianRow,
  AckListItem,
  AckMine,
  AckPupilChoice,
  AckPupilRow,
  AckSettings,
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
 *    not in it.
 *  - Rektor's "Beslutet om ledighet" (every guardian must confirm): Sara has not
 *    confirmed for either of her children, and Tom's custody of Ines has ended,
 *    so nobody can confirm for Ines.
 *  - Anna's "Vad som hände vid larmet" (every guardian), long since done, the
 *    reminder gone out.
 * A teacher sees the requests with a pupil of the class they mentor and only
 * those pupils; the guardian sees their own children's and their own time.
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
    pupils: [
      pupilRow(STUDENTS.ella, [guardianRow(GUARDIANS.sara, "CONFIRMED", at(-6, "17:40"), at(-6, "13:01"))]),
      pupilRow(STUDENTS.hugo, [guardianRow(GUARDIANS.sara, "CONFIRMED", at(-6, "17:40"), at(-6, "13:01"))]),
    ],
  },
];

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
    reminderSent: one.reminderSentAt !== null,
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
  route("GET", "/api/v1/acknowledgements/pupils", (context) => staffOnly(context) ?? askable(context)),
  route("GET", "/api/v1/acknowledgements/mine", (context) => {
    if (!context.person) return new Reply(401, { message: "Not authenticated." });
    return context.person.persona === "guardian" ? mineOf(context) : new Reply(403, { message: "Forbidden." });
  }),
  route("GET", "/api/v1/acknowledgements", (context) => staffOnly(context) ?? seenBy(context).map(listItem)),
  route("GET", "/api/v1/acknowledgements/:id", (context) => {
    const refused = staffOnly(context);
    if (refused) return refused;
    return (
      seenBy(context).find((one) => one.id === context.params.id) ??
      new Reply(404, { message: "Meddelandet finns inte, eller gäller inte dig.", code: "ACK_NOT_FOUND" })
    );
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
  route("POST", "/api/v1/acknowledgements/:id/confirm", (context) => {
    if (!context.person) return new Reply(401, { message: "Not authenticated." });
    if (context.person.persona !== "guardian") return new Reply(403, { message: "Forbidden." });
    return mineOf(context).some((one) => one.id === context.params.id)
      ? { ackedAt: at(2, "08:00") }
      : new Reply(404, { message: "Meddelandet finns inte, eller gäller inte dig.", code: "ACK_NOT_FOUND" });
  }),
];
