import type { RoomBookingStatus } from "@/lib/types";

/*
 * LOKAL (K3): resurser, externa bokare and utnyttjande, as the web sees them.
 *
 * The shapes are the gateway's (src/local/local-types.ts, the contract of the
 * phase); the web cannot import them, so this is the copy. THE WEB ONLY ASKS
 * AND DRAWS: whether a day clashes with a lesson, how many of a resource are
 * free and what share of a room's school time is booked are the gateway's to
 * say. What lives here is the arithmetic of a form (the limits of the DTOs, so
 * a field is refused before it is sent and the sentence names it), the plain
 * sentence of a rule, and the few formats a table needs.
 *
 * No answer carries a person with a login but the booker's name, for an
 * administrator. The contact of an external booking is personal data about
 * somebody who has none: it is in the answers to an administrator alone, is
 * drawn in the dialogs and the table of one page, and goes nowhere else (no
 * toast, no log, no URL).
 *
 * Plain functions with type-only imports: a page that reads a rule pays for
 * the arithmetic and nothing else.
 */

// ---------------------------------------------------------------------------
// The gateway's answers
// ---------------------------------------------------------------------------

export interface ResourceTypeResponse {
  id: string;
  name: string;
  /** How many resources are of the type: the delete guard's number. */
  resources: number;
}

export interface ResourceResponse {
  id: string;
  name: string;
  resourceTypeId: string;
  resourceTypeName: string;
  quantity: number;
  siteId: string | null;
  siteName: string | null;
  place: string | null;
  requiresApproval: boolean;
}

/** A resource, and how many of it nobody holds at any minute of the asked window. */
export interface ResourceAvailabilityResponse extends ResourceResponse {
  free: number;
}

export interface ResourceBookingResponse {
  id: string;
  resourceId: string;
  resourceName: string;
  title: string;
  quantity: number;
  startsAt: string;
  endsAt: string;
  status: RoomBookingStatus;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
  /** The booker's name, for an administrator; null for a teacher reading their own. */
  bookedByName: string | null;
  /** A day of an external hire: it has no booker to name and is not cancelled from here. */
  external: boolean;
}

export interface ResourceBookingResult {
  id: string;
  status: RoomBookingStatus;
}

export type ExternalConflictKind = "LESSON" | "BOOKING" | "FRAME" | "CLOSED" | "LOAN" | "ACTIVITY";

export interface ExternalConflict {
  kind: ExternalConflictKind;
  /** BLOCK refuses the day; WARN is told and does not. */
  severity: "BLOCK" | "WARN";
  /** What the expedition reads: "Matematik 7A", "Rumsbokning", "Ramtid 08:00-15:00". Never a person. */
  label: string;
}

export interface ExternalOccurrencePreview {
  date: string;
  startsAt: string;
  endsAt: string;
  conflicts: ExternalConflict[];
}

export interface ExternalPreviewResponse {
  occurrences: ExternalOccurrencePreview[];
  count: number;
  /** Days with at least one BLOCK conflict. */
  blocked: number;
  /** Days with only WARN conflicts. */
  warned: number;
  /** True when the school has declared no ramtider, so FRAME was not asked. */
  framesMissing: boolean;
}

export interface ExternalBookingTarget {
  kind: "ROOM" | "RESOURCE";
  id: string;
  name: string;
}

export interface ExternalBookingSummary {
  id: string;
  target: ExternalBookingTarget;
  resourceQuantity: number | null;
  organisation: string;
  contactName: string;
  contactPhone: string | null;
  contactEmail: string | null;
  purpose: string | null;
  note: string | null;
  weekdays: number[];
  intervalWeeks: number;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  cancelledAt: string | null;
  createdAt: string;
  registeredByName: string | null;
  days: {
    total: number;
    /** Active days that have not started. */
    upcoming: number;
    cancelled: number;
    /** Dates left out at registration because something else held them. */
    skipped: string[];
  };
  /** Upcoming active days that now clash with a lesson: the expedition's flag. */
  clashes: number;
}

export interface ExternalDayResponse {
  id: string;
  date: string;
  startsAt: string;
  endsAt: string;
  status: RoomBookingStatus;
  conflicts: ExternalConflict[];
}

export interface ExternalBookingDetail extends ExternalBookingSummary {
  occurrences: ExternalDayResponse[];
}

export interface ExternalBookingResult {
  id: string;
  created: number;
  skipped: Array<{ date: string; conflicts: ExternalConflict[] }>;
}

export interface ExternalClashResponse {
  seriesId: string;
  dayId: string;
  organisation: string;
  targetName: string;
  date: string;
  startsAt: string;
  endsAt: string;
  /** The lesson it clashes with, as the schedule names it: "Matematik 7A". */
  lesson: string;
}

export interface UtilisationBucket {
  schoolMinutes: number;
  bookedSchoolMinutes: number;
  /** 0..1; null when there is no school time. */
  schoolShare: number | null;
  outsideMinutes: number;
  bookedOutsideMinutes: number;
  outsideShare: number | null;
}

export interface UtilisationRow {
  kind: "ROOM" | "RESOURCE";
  id: string;
  name: string;
  /** What it counts in: minutes for a room, unit-minutes for a resource of more than one. */
  unit: "MINUTES" | "UNIT_MINUTES";
  total: UtilisationBucket;
  weeks: Array<{ weekStart: string } & UtilisationBucket>;
}

export interface UtilisationResponse {
  from: string;
  to: string;
  timezone: string;
  openFrom: string;
  openTo: string;
  /** True when the school has declared no ramtider: there is no school time to share. */
  framesMissing: boolean;
  weekStarts: string[];
  rows: UtilisationRow[];
}

// ---------------------------------------------------------------------------
// What the web sends
// ---------------------------------------------------------------------------

export interface ResourceTypeBody {
  name: string;
}

export interface ResourceBody {
  name: string;
  resourceTypeId: string;
  quantity: number;
  siteId: string | null;
  place: string | null;
  requiresApproval: boolean;
}

export interface ResourceBookingBody {
  resourceId: string;
  title: string;
  quantity: number;
  startsAt: string;
  endsAt: string;
}

/** The rule of a series, the body of the preview and the first half of a registration. */
export interface ExternalRuleBody {
  target: "ROOM" | "RESOURCE";
  roomId?: string;
  resourceId?: string;
  resourceQuantity?: number;
  weekdays: number[];
  intervalWeeks: number;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
}

export interface ExternalCreateBody extends ExternalRuleBody {
  organisation: string;
  contactName: string;
  contactPhone: string | null;
  contactEmail: string | null;
  purpose: string | null;
  note: string | null;
  skipConflicts: boolean;
}

export interface ExternalUpdateBody {
  organisation: string;
  contactName: string;
  contactPhone: string | null;
  contactEmail: string | null;
  purpose: string | null;
  note: string | null;
}

export type ExternalState = "active" | "ended" | "cancelled" | "all";
export const EXTERNAL_STATES: readonly ExternalState[] = ["active", "ended", "cancelled", "all"];

export type UtilisationKind = "ALL" | "ROOM" | "RESOURCE";
export const UTILISATION_KINDS: readonly UtilisationKind[] = ["ALL", "ROOM", "RESOURCE"];

export interface UtilisationParams {
  from: string;
  to: string;
  kind: UtilisationKind;
  openFrom: string;
  openTo: string;
}

/** The gateway's refusal of a series whose days clash, by the code it sends. */
export const EXTERNAL_CONFLICTS_CODE = "EXTERNAL_BOOKING_CONFLICTS";

/** The ISO weekdays, Monday first: the order a week is read in. */
export const WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5, 6, 7];

/** The `common` message of each ISO weekday's short name, by weekday - 1. */
export const WEEKDAY_KEYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

/** The limits of the DTOs (src/local/dto), repeated so a field is refused before it is sent. */
export const LIMITS = {
  typeName: 60,
  resourceName: 80,
  place: 120,
  title: 120,
  quantity: 1000,
  organisation: 120,
  contactName: 120,
  contactPhoneMin: 3,
  contactPhone: 40,
  contactEmail: 254,
  purpose: 120,
  note: 500,
  decisionNote: 500,
  /** A series ends at most this many days after it starts. */
  seriesDays: 400,
  /** A utilisation report covers at most this many days (src/local/utilisation.service.ts). */
  reportDays: 400,
} as const;

// ---------------------------------------------------------------------------
// Dates and clocks
// ---------------------------------------------------------------------------

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Is the text a real calendar day (2027-02-30 is not), written yyyy-mm-dd? */
export function isIsoDay(value: string): boolean {
  const match = ISO_DAY.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Whole days from one ISO day to another (negative when the second is earlier). */
export function daysBetween(from: string, to: string): number {
  const at = (value: string) => {
    const [year = 0, month = 1, day = 1] = value.split("-").map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((at(to) - at(from)) / 86_400_000);
}

/** Is the text a clock, "HH:MM", 00:00 to 23:59? */
export function isClock(value: string): boolean {
  return CLOCK.test(value);
}

/** Minutes since midnight of a valid clock. */
export function clockMinutes(value: string): number {
  const [hours = 0, minutes = 0] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

/**
 * The window a date and two clocks name, in the reader's own zone as the
 * booking of a lokal does (the browser is in the school's zone, and the
 * gateway checks the instants). Null while a clock is missing or the end is
 * not after the start.
 */
export function bookingWindow(date: string, start: string, end: string): { startsAt: string; endsAt: string } | null {
  if (!isIsoDay(date) || !isClock(start) || !isClock(end)) return null;
  const startsAt = new Date(`${date}T${start}:00`);
  const endsAt = new Date(`${date}T${end}:00`);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) return null;
  return { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() };
}

/** A booking that can still be cancelled: waiting or approved, and not over. */
export function isCancellable(booking: { status: RoomBookingStatus; endsAt: string }, now: number): boolean {
  return (booking.status === "APPROVED" || booking.status === "PENDING") && Date.parse(booking.endsAt) > now;
}

// ---------------------------------------------------------------------------
// A rule in plain words
// ---------------------------------------------------------------------------

/** A translator of the `local` namespace: next-intl's, or a stand-in. */
export type Translate = (key: string, values?: Record<string, string | number>) => string;

export interface RuleParts {
  weekdays: number[];
  intervalWeeks: number;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
}

/** "måndagar och onsdagar": the weekdays in week order, joined by the language's own list. */
export function weekdayList(weekdays: readonly number[], t: Translate, locale: string): string {
  const days = [...new Set(weekdays)].filter((day) => day >= 1 && day <= 7).sort((a, b) => a - b);
  return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(
    days.map((day) => t(`weekdayPlural.${day}`)),
  );
}

/**
 * "tisdagar 18:00–20:00, 2027-02-02–2027-06-08", and ", varannan vecka" when
 * it is not every week. The dates stay ISO, which reads the same in both
 * languages and cannot be taken for a month first.
 */
export function ruleText(rule: RuleParts, t: Translate, locale: string): string {
  const text = t("rule", {
    days: weekdayList(rule.weekdays, t, locale),
    start: rule.startTime,
    end: rule.endTime,
    from: rule.startDate,
    to: rule.endDate,
  });
  return rule.intervalWeeks > 1 ? `${text}, ${t("interval", { weeks: rule.intervalWeeks })}` : text;
}

export type SeriesState = "active" | "ended" | "cancelled";

/** Cancelled when it was cancelled, ended when its last date has passed, active otherwise. */
export function seriesState(series: Pick<ExternalBookingSummary, "cancelledAt" | "endDate">, today: string): SeriesState {
  if (series.cancelledAt !== null) return "cancelled";
  return series.endDate < today ? "ended" : "active";
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

export type DayState = "BLOCK" | "WARN" | "FREE";

/** BLOCK when anything refuses the day, WARN when only a warning does, FREE otherwise. */
export function dayState(conflicts: readonly ExternalConflict[]): DayState {
  if (conflicts.some((conflict) => conflict.severity === "BLOCK")) return "BLOCK";
  return conflicts.length > 0 ? "WARN" : "FREE";
}

/** The days of a preview with something BLOCK, the ones a registration without skipConflicts refuses. */
export function blockedDays(preview: ExternalPreviewResponse): ExternalOccurrencePreview[] {
  return preview.occurrences.filter((day) => dayState(day.conflicts) === "BLOCK");
}

/** The codes the gateway sends as the label of a LOAN conflict (src/local/external-conflicts.ts). */
export const LOAN_CODES: readonly string[] = ["ROOM_LENT", "ROOM_BORROWED_OUTSIDE_LOAN"];

/** How many of a resource are held, as the gateway writes it: "28 av 30". */
const HELD_LABEL = /^(\d+) av (\d+)$/;

/**
 * What a conflict's label says in the reader's language. The label is data
 * (a lesson's name, a booking's title, a ramtid, a closure's reason, an
 * activity's name) and is shown as it is; the two that are not names are
 * turned into a sentence: the loan's code, and the count of a resource that is
 * used up, which the gateway writes with a Swedish "av".
 */
export function conflictLabel(conflict: ExternalConflict, t: Translate): string {
  if (conflict.kind === "LOAN" && LOAN_CODES.includes(conflict.label)) return t(`loanCode.${conflict.label}`);
  if (conflict.kind === "BOOKING") {
    const held = HELD_LABEL.exec(conflict.label);
    if (held) return t("heldOf", { held: Number(held[1]), total: Number(held[2]) });
  }
  return conflict.label;
}

/** The conflicts as one line: "Lektion: Matematik 7A, Bokning: Körövning". */
export function conflictLine(conflicts: readonly ExternalConflict[], t: Translate): string {
  return conflicts
    .map((conflict) => {
      const label = conflictLabel(conflict, t);
      const kind = t(`conflictKind.${conflict.kind}`);
      return label === "" ? kind : `${kind}: ${label}`;
    })
    .join(", ");
}

// ---------------------------------------------------------------------------
// Days and clocks as text
// ---------------------------------------------------------------------------

/** The school's zone: the gateway counts its days in it, and so does every clock the page draws from an instant. */
export const SCHOOL_ZONE = "Europe/Stockholm";

/** The BCP 47 tag the app's two languages are written in. */
export function localeTag(locale: string): string {
  return locale === "en" ? "en-GB" : "sv-SE";
}

/** "tis 2 feb. 2027": an ISO day with its weekday. A day has no zone, so it is read as UTC and written as UTC. */
export function dayText(day: string, locale: string): string {
  if (!isIsoDay(day)) return day;
  return new Intl.DateTimeFormat(localeTag(locale), {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`));
}

/** "2 feb. 2027": the school's day an instant falls on (a series' registration, its cancellation). */
export function instantDayText(instant: string, locale: string): string {
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) return instant;
  return new Intl.DateTimeFormat(localeTag(locale), { day: "numeric", month: "short", year: "numeric", timeZone: SCHOOL_ZONE }).format(at);
}

/** "18:00–20:00": two instants as clocks in the school's zone. */
export function clockRangeText(startsAt: string, endsAt: string, locale: string): string {
  const clock = new Intl.DateTimeFormat(localeTag(locale), {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: SCHOOL_ZONE,
  });
  return `${clock.format(new Date(startsAt))}–${clock.format(new Date(endsAt))}`;
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

/** What is wrong with a field, by a code the page turns into a sentence. */
export type FieldError =
  | "required"
  | "tooLong"
  | "tooShort"
  | "number"
  | "weekdays"
  | "date"
  | "dateOrder"
  | "span"
  | "clock"
  | "clockOrder"
  | "email"
  | "contact";

export type Errors<K extends string> = Partial<Record<K, FieldError>>;

const trimmed = (value: string) => value.trim();
const orNull = (value: string) => (trimmed(value) === "" ? null : trimmed(value));

function textError(value: string, max: number, min = 1): FieldError | undefined {
  const text = trimmed(value);
  if (text.length < min) return min === 1 ? "required" : "tooShort";
  return text.length > max ? "tooLong" : undefined;
}

function optionalTextError(value: string, max: number, min = 0): FieldError | undefined {
  const text = trimmed(value);
  if (text === "") return undefined;
  return text.length < min ? "tooShort" : text.length > max ? "tooLong" : undefined;
}

/** A whole number from min to max in a text field; "" is no number. */
export function wholeNumber(value: string, min: number, max: number): number | null {
  const text = trimmed(value);
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return parsed >= min && parsed <= max ? parsed : null;
}

// ---- Resource types and resources

export type ResourceTypeField = "name";

export function resourceTypeErrors(name: string): Errors<ResourceTypeField> {
  const error = textError(name, LIMITS.typeName);
  return error ? { name: error } : {};
}

export interface ResourceForm {
  name: string;
  resourceTypeId: string;
  quantity: string;
  /** "" is no skolområde. */
  siteId: string;
  place: string;
  requiresApproval: boolean;
}

export const EMPTY_RESOURCE_FORM: ResourceForm = {
  name: "",
  resourceTypeId: "",
  quantity: "1",
  siteId: "",
  place: "",
  requiresApproval: false,
};

export function resourceFormOf(resource: ResourceResponse): ResourceForm {
  return {
    name: resource.name,
    resourceTypeId: resource.resourceTypeId,
    quantity: String(resource.quantity),
    siteId: resource.siteId ?? "",
    place: resource.place ?? "",
    requiresApproval: resource.requiresApproval,
  };
}

export type ResourceField = "name" | "resourceTypeId" | "quantity" | "place";

export function resourceErrors(form: ResourceForm): Errors<ResourceField> {
  const errors: Errors<ResourceField> = {};
  const name = textError(form.name, LIMITS.resourceName);
  if (name) errors.name = name;
  if (form.resourceTypeId === "") errors.resourceTypeId = "required";
  if (wholeNumber(form.quantity, 1, LIMITS.quantity) === null) errors.quantity = "number";
  const place = optionalTextError(form.place, LIMITS.place);
  if (place) errors.place = place;
  return errors;
}

/** The body a valid form means. Every key is sent, so a cleared place or skolområde reaches the gateway as null. */
export function resourceBody(form: ResourceForm): ResourceBody {
  return {
    name: trimmed(form.name),
    resourceTypeId: form.resourceTypeId,
    quantity: wholeNumber(form.quantity, 1, LIMITS.quantity) ?? 1,
    siteId: form.siteId === "" ? null : form.siteId,
    place: orNull(form.place),
    requiresApproval: form.requiresApproval,
  };
}

/** "Norra · Skåp 3 i B-huset": the skolområde, then the words; null when it has neither. */
export function placeText(resource: Pick<ResourceResponse, "siteName" | "place">): string | null {
  const parts = [resource.siteName, resource.place].filter((part): part is string => !!part && part.trim() !== "");
  return parts.length > 0 ? parts.join(" · ") : null;
}

// ---- A booking of a resource

export type ResourceBookingField = "quantity" | "window";

/** How many of a resource a teacher wants: whole, from 1 to the DTO's ceiling. */
export function wantedQuantity(value: string): number | null {
  return wholeNumber(value, 1, LIMITS.quantity);
}

// ---- An external series

export interface ExternalContactForm {
  organisation: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  purpose: string;
  note: string;
}

export interface ExternalForm extends ExternalContactForm {
  target: "ROOM" | "RESOURCE";
  roomId: string;
  resourceId: string;
  resourceQuantity: string;
  weekdays: number[];
  everyOtherWeek: boolean;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  skipConflicts: boolean;
}

export function emptyExternalForm(today: string): ExternalForm {
  return {
    target: "ROOM",
    roomId: "",
    resourceId: "",
    resourceQuantity: "1",
    weekdays: [],
    everyOtherWeek: false,
    startDate: today,
    endDate: today,
    startTime: "18:00",
    endTime: "20:00",
    organisation: "",
    contactName: "",
    contactPhone: "",
    contactEmail: "",
    purpose: "",
    note: "",
    skipConflicts: false,
  };
}

export function contactFormOf(series: ExternalBookingSummary): ExternalContactForm {
  return {
    organisation: series.organisation,
    contactName: series.contactName,
    contactPhone: series.contactPhone ?? "",
    contactEmail: series.contactEmail ?? "",
    purpose: series.purpose ?? "",
    note: series.note ?? "",
  };
}

export type RuleField = "target" | "quantity" | "weekdays" | "startDate" | "endDate" | "startTime" | "endTime";

/** What is wrong with the rule of a series: the part the preview and the registration share. */
export function ruleErrors(form: ExternalForm): Errors<RuleField> {
  const errors: Errors<RuleField> = {};
  if ((form.target === "ROOM" ? form.roomId : form.resourceId) === "") errors.target = "required";
  if (form.target === "RESOURCE" && wholeNumber(form.resourceQuantity, 1, LIMITS.quantity) === null) {
    errors.quantity = "number";
  }
  if (form.weekdays.length === 0) errors.weekdays = "weekdays";
  if (!isIsoDay(form.startDate)) errors.startDate = "date";
  if (!isIsoDay(form.endDate)) errors.endDate = "date";
  if (!errors.startDate && !errors.endDate) {
    const span = daysBetween(form.startDate, form.endDate);
    if (span < 0) errors.endDate = "dateOrder";
    else if (span > LIMITS.seriesDays) errors.endDate = "span";
  }
  if (!isClock(form.startTime)) errors.startTime = "clock";
  if (!isClock(form.endTime)) errors.endTime = "clock";
  if (!errors.startTime && !errors.endTime && clockMinutes(form.endTime) <= clockMinutes(form.startTime)) {
    errors.endTime = "clockOrder";
  }
  return errors;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ContactField = "organisation" | "contactName" | "contactPhone" | "contactEmail" | "purpose" | "note";

/** The longest each field of who a series is for may be. */
export const CONTACT_MAX: Record<ContactField, number> = {
  organisation: LIMITS.organisation,
  contactName: LIMITS.contactName,
  contactPhone: LIMITS.contactPhone,
  contactEmail: LIMITS.contactEmail,
  purpose: LIMITS.purpose,
  note: LIMITS.note,
};

/** What is wrong with who the series is for. At least one of the telephone number and the address is needed (the table's CHECK). */
export function contactErrors(form: ExternalContactForm): Errors<ContactField> {
  const errors: Errors<ContactField> = {};
  const organisation = textError(form.organisation, LIMITS.organisation);
  if (organisation) errors.organisation = organisation;
  const contactName = textError(form.contactName, LIMITS.contactName);
  if (contactName) errors.contactName = contactName;
  const phone = optionalTextError(form.contactPhone, LIMITS.contactPhone, LIMITS.contactPhoneMin);
  if (phone) errors.contactPhone = phone;
  const email = trimmed(form.contactEmail);
  if (email !== "" && (!EMAIL.test(email) || email.length > LIMITS.contactEmail)) errors.contactEmail = "email";
  if (trimmed(form.contactPhone) === "" && email === "") {
    errors.contactPhone ??= "contact";
    errors.contactEmail ??= "contact";
  }
  const purpose = optionalTextError(form.purpose, LIMITS.purpose);
  if (purpose) errors.purpose = purpose;
  const note = optionalTextError(form.note, LIMITS.note);
  if (note) errors.note = note;
  return errors;
}

/** The rule a valid form means. */
export function ruleBody(form: ExternalForm): ExternalRuleBody {
  return {
    target: form.target,
    ...(form.target === "ROOM"
      ? { roomId: form.roomId }
      : {
          resourceId: form.resourceId,
          resourceQuantity: wholeNumber(form.resourceQuantity, 1, LIMITS.quantity) ?? 1,
        }),
    weekdays: [...form.weekdays].sort((a, b) => a - b),
    intervalWeeks: form.everyOtherWeek ? 2 : 1,
    startDate: form.startDate,
    endDate: form.endDate,
    startTime: form.startTime,
    endTime: form.endTime,
  };
}

/** The same rule as one string: a preview shown for another rule is no longer the form's. */
export function ruleKey(form: ExternalForm): string {
  return JSON.stringify(ruleBody(form));
}

export function updateBody(form: ExternalContactForm): ExternalUpdateBody {
  return {
    organisation: trimmed(form.organisation),
    contactName: trimmed(form.contactName),
    contactPhone: orNull(form.contactPhone),
    contactEmail: orNull(form.contactEmail),
    purpose: orNull(form.purpose),
    note: orNull(form.note),
  };
}

export function createBody(form: ExternalForm): ExternalCreateBody {
  return { ...ruleBody(form), ...updateBody(form), skipConflicts: form.skipConflicts };
}

// ---------------------------------------------------------------------------
// Utnyttjande
// ---------------------------------------------------------------------------

export interface TermPreset {
  /** "2026-autumn": the select's value. */
  id: string;
  term: "spring" | "autumn";
  year: number;
  from: string;
  to: string;
}

/** Vårtermin is 1 January to 31 July; Hösttermin 1 August to 31 December. */
export function termOf(term: "spring" | "autumn", year: number): TermPreset {
  return term === "spring"
    ? { id: `${year}-spring`, term, year, from: `${year}-01-01`, to: `${year}-07-31` }
    : { id: `${year}-autumn`, term, year, from: `${year}-08-01`, to: `${year}-12-31` };
}

/** The term a day falls in. */
export function termContaining(day: string): TermPreset {
  const year = Number(day.slice(0, 4));
  return Number(day.slice(5, 7)) <= 7 ? termOf("spring", year) : termOf("autumn", year);
}

/** The terms of last year, this year and next, in time order: what the select offers. */
export function termPresets(today: string): TermPreset[] {
  const year = Number(today.slice(0, 4));
  return [year - 1, year, year + 1].flatMap((one) => [termOf("spring", one), termOf("autumn", one)]);
}

export const DEFAULT_OPEN_FROM = "07:00";
export const DEFAULT_OPEN_TO = "22:00";

export type UtilisationField = "from" | "to" | "openFrom" | "openTo";

/** What is wrong with a period and the open hours, before the gateway is asked. */
export function utilisationErrors(params: UtilisationParams): Errors<UtilisationField> {
  const errors: Errors<UtilisationField> = {};
  if (!isIsoDay(params.from)) errors.from = "date";
  if (!isIsoDay(params.to)) errors.to = "date";
  if (!errors.from && !errors.to) {
    const span = daysBetween(params.from, params.to);
    if (span < 0) errors.to = "dateOrder";
    else if (span + 1 > LIMITS.reportDays) errors.to = "span";
  }
  if (!isClock(params.openFrom)) errors.openFrom = "clock";
  if (!isClock(params.openTo)) errors.openTo = "clock";
  if (!errors.openFrom && !errors.openTo && clockMinutes(params.openTo) <= clockMinutes(params.openFrom)) {
    errors.openTo = "clockOrder";
  }
  return errors;
}

/** The query string of /utilisation and /utilisation/csv. */
export function utilisationQuery(params: UtilisationParams): string {
  return new URLSearchParams({
    from: params.from,
    to: params.to,
    kind: params.kind,
    openFrom: params.openFrom,
    openTo: params.openTo,
  }).toString();
}

/** The file the report is saved as, as the gateway names it (Content-Disposition). */
export function utilisationFilename(from: string, to: string): string {
  return `utnyttjande-${from}-${to}.csv`;
}

/** "45 %" or "45,3 %"; "–" when there is no school time to share. */
export function shareText(share: number | null, locale: string): string {
  if (share === null) return "–";
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(share);
}

/** Minutes as hours, one decimal at most: "12,5". */
export function hoursText(minutes: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(minutes / 60);
}

/** The ISO week number of an ISO day, for a week that starts on a Monday. */
export function weekNumber(day: string): number {
  const [year = 1970, month = 1, date = 1] = day.split("-").map(Number);
  const at = new Date(Date.UTC(year, month - 1, date));
  const weekday = at.getUTCDay() || 7;
  at.setUTCDate(at.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(at.getUTCFullYear(), 0, 1);
  return Math.ceil(((at.getTime() - yearStart) / 86_400_000 + 1) / 7);
}
