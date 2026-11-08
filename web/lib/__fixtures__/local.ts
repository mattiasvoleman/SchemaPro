import type {
  ExternalBookingDetail,
  ExternalBookingSummary,
  ExternalClashResponse,
  ExternalDayResponse,
  ResourceAvailabilityResponse,
  ResourceBookingResponse,
  ResourceResponse,
  ResourceTypeResponse,
  UtilisationBucket,
  UtilisationResponse,
  UtilisationRow,
} from "@/lib/local";

/*
 * Lokal's answers as the page tests need them: a few builders over the gateway's shapes
 * (src/local/local-types.ts), each filling in what a test does not care about.
 */

export const TYPE_TABLETS: ResourceTypeResponse = { id: "t-1", name: "Surfplattor", resources: 1 };
export const TYPE_BUS: ResourceTypeResponse = { id: "t-2", name: "Minibuss", resources: 0 };

export const resource = (over: Partial<ResourceResponse> = {}): ResourceResponse => ({
  id: "r-1",
  name: "Surfplattor klass 7",
  resourceTypeId: "t-1",
  resourceTypeName: "Surfplattor",
  quantity: 30,
  siteId: null,
  siteName: null,
  place: "Skåp 3 i B-huset",
  requiresApproval: false,
  ...over,
});

export const available = (over: Partial<ResourceAvailabilityResponse> = {}): ResourceAvailabilityResponse => ({
  ...resource(),
  free: 24,
  ...over,
});

export const resourceBooking = (over: Partial<ResourceBookingResponse> = {}): ResourceBookingResponse => ({
  id: "b-1",
  resourceId: "r-1",
  resourceName: "Surfplattor klass 7",
  title: "NO-lektion",
  quantity: 12,
  startsAt: "2099-03-02T08:00:00.000Z",
  endsAt: "2099-03-02T09:00:00.000Z",
  status: "APPROVED",
  decidedAt: null,
  decisionNote: null,
  createdAt: "2099-03-01T08:00:00.000Z",
  bookedByName: "Nils Berg",
  external: false,
  ...over,
});

export const series = (over: Partial<ExternalBookingSummary> = {}): ExternalBookingSummary => ({
  id: "s-1",
  target: { kind: "ROOM", id: "room-1", name: "Gymnastiksalen" },
  resourceQuantity: null,
  organisation: "Idrottsföreningen",
  contactName: "Kim Berg",
  contactPhone: "070-123 45 67",
  contactEmail: "kim@if.example",
  purpose: "Innebandy",
  note: null,
  weekdays: [2],
  intervalWeeks: 1,
  startDate: "2099-02-02",
  endDate: "2099-06-08",
  startTime: "18:00",
  endTime: "20:00",
  cancelledAt: null,
  createdAt: "2099-01-15T10:00:00.000Z",
  registeredByName: "Anna Lind",
  days: { total: 18, upcoming: 17, cancelled: 1, skipped: [] },
  clashes: 0,
  ...over,
});

export const day = (over: Partial<ExternalDayResponse> = {}): ExternalDayResponse => ({
  id: "d-1",
  date: "2099-02-02",
  startsAt: "2099-02-02T17:00:00.000Z",
  endsAt: "2099-02-02T19:00:00.000Z",
  status: "APPROVED",
  conflicts: [],
  ...over,
});

export const detail = (over: Partial<ExternalBookingDetail> = {}): ExternalBookingDetail => ({
  ...series(),
  occurrences: [
    day({ id: "d-1", date: "2099-02-02" }),
    day({ id: "d-2", date: "2099-02-09", conflicts: [{ kind: "LESSON", severity: "BLOCK", label: "Matematik 7A" }] }),
    day({ id: "d-3", date: "2099-02-16", status: "CANCELLED" }),
    day({ id: "d-4", date: "2020-01-07", startsAt: "2020-01-07T17:00:00.000Z", endsAt: "2020-01-07T19:00:00.000Z" }),
  ],
  ...over,
});

export const clash = (over: Partial<ExternalClashResponse> = {}): ExternalClashResponse => ({
  seriesId: "s-1",
  dayId: "d-2",
  organisation: "Idrottsföreningen",
  targetName: "Gymnastiksalen",
  date: "2099-02-09",
  startsAt: "2099-02-09T17:00:00.000Z",
  endsAt: "2099-02-09T19:00:00.000Z",
  lesson: "Matematik 7A",
  ...over,
});

export const bucket = (over: Partial<UtilisationBucket> = {}): UtilisationBucket => ({
  schoolMinutes: 6000,
  bookedSchoolMinutes: 3000,
  schoolShare: 0.5,
  outsideMinutes: 12000,
  bookedOutsideMinutes: 1200,
  outsideShare: 0.1,
  ...over,
});

export const row = (over: Partial<UtilisationRow> = {}): UtilisationRow => ({
  kind: "ROOM",
  id: "room-1",
  name: "Gymnastiksalen",
  unit: "MINUTES",
  total: bucket(),
  weeks: [
    { weekStart: "2027-02-01", ...bucket({ bookedSchoolMinutes: 600, schoolShare: 0.4, schoolMinutes: 1500 }) },
    { weekStart: "2027-02-08", ...bucket({ bookedSchoolMinutes: 900, schoolShare: 0.6, schoolMinutes: 1500 }) },
  ],
  ...over,
});

export const report = (over: Partial<UtilisationResponse> = {}): UtilisationResponse => ({
  from: "2027-01-01",
  to: "2027-07-31",
  timezone: "Europe/Stockholm",
  openFrom: "07:00",
  openTo: "22:00",
  framesMissing: false,
  weekStarts: ["2027-02-01", "2027-02-08"],
  rows: [
    row(),
    row({
      kind: "RESOURCE",
      id: "res-1",
      name: "Surfplattor klass 7",
      unit: "UNIT_MINUTES",
      total: bucket({ schoolShare: null, outsideShare: 0.025 }),
      weeks: [{ weekStart: "2027-02-01", ...bucket() }],
    }),
  ],
  ...over,
});
