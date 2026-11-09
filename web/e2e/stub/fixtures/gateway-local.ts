import type {
  ExternalBookingDetail,
  ExternalBookingSummary,
  ExternalClashResponse,
  ResourceAvailabilityResponse,
  ResourceBookingResponse,
  ResourceResponse,
  ResourceTypeResponse,
  UtilisationBucket,
  UtilisationResponse,
} from "../../../lib/local";
import { Reply, route, type GatewayContext, type GatewayRoute } from "../gateway-routes";
import { KIND, uid } from "../sessions";
import { addDays, isoWeekday, mondayOf, NOW, stockholmInstant, TODAY } from "./calendar";
import { ROOMS } from "./world";

/**
 * Lokal as the gateway answers it (src/local/): the school's resource types and resources, what is free of them in
 * a window, the bookings of resources, the external hirers' series and the utilisation report.
 *
 * Two kinds and three resources (a class set of tablets of 30, a minibus that needs Drift's yes, the hall); a
 * teacher with one booking waiting and one standing; one series let to an association, Tuesday evenings in the
 * gym from today, with one day that now clashes with a lesson, so the band and the badge are drawn; and a report
 * for two rooms and a resource, one with no school time to divide by.
 */

const TABLETS = uid(KIND.misc, 7001);
const BUS = uid(KIND.misc, 7002);
const HALL = uid(KIND.misc, 7003);
const TYPE_TABLETS = uid(KIND.misc, 7101);
const TYPE_VEHICLES = uid(KIND.misc, 7102);
const SERIES = uid(KIND.misc, 7201);

const TYPES: ResourceTypeResponse[] = [
  { id: TYPE_TABLETS, name: "Surfplattor", resources: 2 },
  { id: TYPE_VEHICLES, name: "Fordon", resources: 1 },
];

const RESOURCES: ResourceResponse[] = [
  { id: TABLETS, name: "Klassuppsättning surfplattor", resourceTypeId: TYPE_TABLETS, resourceTypeName: "Surfplattor", quantity: 30, siteId: null, siteName: null, place: "Skåp 3 i B-huset", requiresApproval: false },
  { id: BUS, name: "Minibuss", resourceTypeId: TYPE_VEHICLES, resourceTypeName: "Fordon", quantity: 1, siteId: null, siteName: null, place: null, requiresApproval: true },
  { id: HALL, name: "Aulan", resourceTypeId: TYPE_TABLETS, resourceTypeName: "Surfplattor", quantity: 1, siteId: null, siteName: null, place: "Entréplan", requiresApproval: false },
];

function staff(context: GatewayContext): Reply | null {
  if (!context.person) return new Reply(401, { message: "Not authenticated." });
  return context.person.persona === "admin" || context.person.persona === "teacher" ? null : new Reply(403, { message: "Forbidden." });
}

function administrator(context: GatewayContext): Reply | null {
  if (!context.person) return new Reply(401, { message: "Not authenticated." });
  return context.person.persona === "admin" ? null : new Reply(403, { message: "Forbidden." });
}

function availability(context: GatewayContext): ResourceAvailabilityResponse[] | Reply {
  const refused = staff(context);
  if (refused) return refused;
  if (!context.query.get("from") || !context.query.get("to")) return new Reply(400, { message: "from and to are required." });
  // Six of the tablets are held in whatever window is asked, and the minibus is free.
  return RESOURCES.map((resource) => ({ ...resource, free: resource.id === TABLETS ? 24 : resource.quantity }));
}

const booking = (over: Partial<ResourceBookingResponse>): ResourceBookingResponse => ({
  id: uid(KIND.misc, 7301),
  resourceId: TABLETS,
  resourceName: "Klassuppsättning surfplattor",
  title: "NO-lektion",
  quantity: 12,
  startsAt: stockholmInstant(addDays(TODAY, 2), "09:00"),
  endsAt: stockholmInstant(addDays(TODAY, 2), "10:00"),
  status: "APPROVED",
  decidedAt: null,
  decisionNote: null,
  createdAt: NOW,
  bookedByName: null,
  external: false,
  ...over,
});

function resourceBookings(context: GatewayContext): ResourceBookingResponse[] | Reply {
  const refused = staff(context);
  if (refused) return refused;
  if (context.query.get("mine") === "true") {
    return [
      booking({}),
      booking({ id: uid(KIND.misc, 7302), resourceId: BUS, resourceName: "Minibuss", title: "Utflykt", quantity: 1, status: "PENDING" }),
    ];
  }
  if (context.person!.persona !== "admin") return [];
  const requested = booking({ id: uid(KIND.misc, 7302), resourceId: BUS, resourceName: "Minibuss", title: "Utflykt", quantity: 1, status: "PENDING", bookedByName: "Anna Lind" });
  return context.query.get("status") === "PENDING" ? [requested] : [];
}

const FIRST_TUESDAY = addDays(TODAY, (9 - isoWeekday(TODAY)) % 7);

const SUMMARY: ExternalBookingSummary = {
  id: SERIES,
  target: { kind: "ROOM", id: ROOMS.gym.id, name: ROOMS.gym.name },
  resourceQuantity: null,
  organisation: "Exempelstadens IF",
  contactName: "Kim Berg",
  contactPhone: "070-123 45 67",
  contactEmail: "kim@exempelstadensif.example",
  purpose: "Innebandy",
  note: null,
  weekdays: [2],
  intervalWeeks: 1,
  startDate: FIRST_TUESDAY,
  endDate: addDays(FIRST_TUESDAY, 77),
  startTime: "18:00",
  endTime: "20:00",
  cancelledAt: null,
  createdAt: NOW,
  registeredByName: "Rut Rektorsson",
  days: { total: 12, upcoming: 12, cancelled: 0, skipped: [] },
  clashes: 1,
};

const CLASH_DAY = addDays(FIRST_TUESDAY, 7);

const CLASH: ExternalClashResponse = {
  seriesId: SERIES,
  dayId: uid(KIND.misc, 7402),
  organisation: SUMMARY.organisation,
  targetName: SUMMARY.target.name,
  date: CLASH_DAY,
  startsAt: stockholmInstant(CLASH_DAY, "18:00"),
  endsAt: stockholmInstant(CLASH_DAY, "20:00"),
  lesson: "Idrott 8A",
};

function detail(): ExternalBookingDetail {
  return {
    ...SUMMARY,
    occurrences: Array.from({ length: 12 }, (_, index) => {
      const date = addDays(FIRST_TUESDAY, index * 7);
      return {
        id: index === 1 ? CLASH.dayId : uid(KIND.misc, 7410 + index),
        date,
        startsAt: stockholmInstant(date, "18:00"),
        endsAt: stockholmInstant(date, "20:00"),
        status: "APPROVED" as const,
        conflicts: index === 1 ? [{ kind: "LESSON" as const, severity: "BLOCK" as const, label: CLASH.lesson }] : [],
      };
    }),
  };
}

function externalList(context: GatewayContext): ExternalBookingSummary[] | Reply {
  const refused = administrator(context);
  if (refused) return refused;
  return (context.query.get("state") ?? "active") === "active" ? [SUMMARY] : [];
}

const bucket = (school: number, bookedSchool: number, outside: number, bookedOutside: number): UtilisationBucket => ({
  schoolMinutes: school,
  bookedSchoolMinutes: bookedSchool,
  schoolShare: school === 0 ? null : bookedSchool / school,
  outsideMinutes: outside,
  bookedOutsideMinutes: bookedOutside,
  outsideShare: outside === 0 ? null : bookedOutside / outside,
});

function utilisation(context: GatewayContext): UtilisationResponse | Reply {
  const refused = administrator(context);
  if (refused) return refused;
  const from = context.query.get("from") ?? TODAY;
  const to = context.query.get("to") ?? addDays(TODAY, 30);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return new Reply(400, { message: "from and to must be dates." });
  const first = mondayOf(from);
  const weekStarts = [first, addDays(first, 7)];
  const weeks = (school: number, bookedSchool: number, outside: number, bookedOutside: number) =>
    weekStarts.map((weekStart) => ({ weekStart, ...bucket(school, bookedSchool, outside, bookedOutside) }));
  const kind = context.query.get("kind") ?? "ALL";
  const rows: UtilisationResponse["rows"] = [
    { kind: "ROOM", id: ROOMS.gym.id, name: ROOMS.gym.name, unit: "MINUTES", total: bucket(6000, 3000, 12000, 1200), weeks: weeks(3000, 1500, 6000, 600) },
    { kind: "ROOM", id: ROOMS.art.id, name: ROOMS.art.name, unit: "MINUTES", total: bucket(0, 0, 12000, 0), weeks: weeks(0, 0, 6000, 0) },
    { kind: "RESOURCE", id: TABLETS, name: "Klassuppsättning surfplattor", unit: "UNIT_MINUTES", total: bucket(180000, 18000, 360000, 3600), weeks: weeks(90000, 9000, 180000, 1800) },
  ].filter((row) => kind === "ALL" || row.kind === kind) as UtilisationResponse["rows"];
  return {
    from,
    to,
    timezone: "Europe/Stockholm",
    openFrom: context.query.get("openFrom") ?? "07:00",
    openTo: context.query.get("openTo") ?? "22:00",
    framesMissing: false,
    weekStarts,
    rows,
  };
}

export const localRoutes: GatewayRoute[] = [
  route("GET", "/api/v1/resource-types", (context) => staff(context) ?? TYPES),
  route("GET", "/api/v1/resources", (context) => staff(context) ?? RESOURCES),
  route("GET", "/api/v1/resources/availability", availability),
  route("GET", "/api/v1/resource-bookings", resourceBookings),
  route("GET", "/api/v1/external-bookings", externalList),
  route("GET", "/api/v1/external-bookings/clashes", (context) => administrator(context) ?? [CLASH]),
  route("GET", "/api/v1/external-bookings/:id", (context) => administrator(context) ?? (context.params.id === SERIES ? detail() : new Reply(404, { message: "Not found." }))),
  route("GET", "/api/v1/utilisation", utilisation),
];
