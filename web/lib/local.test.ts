import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import {
  CONTACT_MAX,
  DEFAULT_OPEN_FROM,
  DEFAULT_OPEN_TO,
  EMPTY_RESOURCE_FORM,
  LIMITS,
  blockedDays,
  bookingWindow,
  clockMinutes,
  clockRangeText,
  conflictLabel,
  conflictLine,
  contactErrors,
  contactFormOf,
  createBody,
  daysBetween,
  dayState,
  dayText,
  emptyExternalForm,
  hoursText,
  instantDayText,
  isCancellable,
  isClock,
  isIsoDay,
  localeTag,
  placeText,
  resourceBody,
  resourceErrors,
  resourceFormOf,
  resourceTypeErrors,
  ruleBody,
  ruleErrors,
  ruleKey,
  ruleText,
  seriesState,
  shareText,
  termContaining,
  termOf,
  termPresets,
  updateBody,
  utilisationErrors,
  utilisationFilename,
  utilisationQuery,
  wantedQuantity,
  weekNumber,
  weekdayList,
  wholeNumber,
  type ExternalConflict,
  type ExternalContactForm,
  type ExternalForm,
  type ExternalPreviewResponse,
  type ResourceResponse,
  type Translate,
  type UtilisationParams,
} from "./local";

/**
 * The arithmetic of Lokal's forms and tables: the limits of the gateway's DTOs (src/local/dto), the plain
 * sentence of a rule, the labels of a conflict, the terms of the utnyttjande's select. The web only asks and
 * draws what the gateway decides (whether a day clashes, how many are free): none of that is decided here.
 */

const local = (locale: "sv" | "en") =>
  createTranslator({ locale, messages: locale === "sv" ? sv : en, namespace: "local" }) as unknown as Translate;
const tSv = local("sv");
const tEn = local("en");

const RESOURCE: ResourceResponse = {
  id: "res-1",
  name: "Surfplattor klass 7",
  resourceTypeId: "type-1",
  resourceTypeName: "Surfplattor",
  quantity: 30,
  siteId: "site-1",
  siteName: "Norra",
  place: "Skåp 3 i B-huset",
  requiresApproval: true,
};

const conflict = (kind: ExternalConflict["kind"], label: string, severity: ExternalConflict["severity"] = "BLOCK"): ExternalConflict => ({
  kind,
  severity,
  label,
});

describe("days and clocks", () => {
  it("knows a real calendar day from a written one", () => {
    expect(isIsoDay("2027-02-28")).toBe(true);
    expect(isIsoDay("2028-02-29")).toBe(true);
    expect(isIsoDay("2027-02-29")).toBe(false);
    expect(isIsoDay("2027-02-30")).toBe(false);
    expect(isIsoDay("2027-2-3")).toBe(false);
    expect(isIsoDay("")).toBe(false);
  });

  it("counts whole days between two days, over a change of clocks and a leap day", () => {
    expect(daysBetween("2027-02-01", "2027-02-01")).toBe(0);
    expect(daysBetween("2027-02-01", "2027-03-01")).toBe(28);
    expect(daysBetween("2028-02-01", "2028-03-01")).toBe(29);
    expect(daysBetween("2027-03-27", "2027-03-29")).toBe(2);
    expect(daysBetween("2027-02-10", "2027-02-03")).toBe(-7);
  });

  it("reads a clock as hours and minutes, and refuses 24:00", () => {
    expect(isClock("00:00")).toBe(true);
    expect(isClock("23:59")).toBe(true);
    expect(isClock("24:00")).toBe(false);
    expect(isClock("9:00")).toBe(false);
    expect(isClock("12:60")).toBe(false);
    expect(clockMinutes("18:30")).toBe(1110);
  });

  it("makes the window of a date and two clocks, null while any is missing or the end is not after the start", () => {
    expect(bookingWindow("2027-02-03", "09:00", "10:30")).toEqual({
      startsAt: "2027-02-03T09:00:00.000Z",
      endsAt: "2027-02-03T10:30:00.000Z",
    });
    expect(bookingWindow("2027-02-03", "10:00", "10:00")).toBeNull();
    expect(bookingWindow("2027-02-03", "11:00", "10:00")).toBeNull();
    expect(bookingWindow("2027-02-03", "", "10:00")).toBeNull();
    expect(bookingWindow("", "09:00", "10:00")).toBeNull();
  });

  it("lets a booking be cancelled while it waits or stands and is not over", () => {
    const now = Date.parse("2027-02-03T12:00:00Z");
    expect(isCancellable({ status: "APPROVED", endsAt: "2027-02-03T13:00:00Z" }, now)).toBe(true);
    expect(isCancellable({ status: "PENDING", endsAt: "2027-02-03T13:00:00Z" }, now)).toBe(true);
    expect(isCancellable({ status: "APPROVED", endsAt: "2027-02-03T11:00:00Z" }, now)).toBe(false);
    expect(isCancellable({ status: "REJECTED", endsAt: "2027-02-03T13:00:00Z" }, now)).toBe(false);
    expect(isCancellable({ status: "CANCELLED", endsAt: "2027-02-03T13:00:00Z" }, now)).toBe(false);
  });

  it("writes a day with its weekday in the reader's language, and leaves a non-day as it is", () => {
    expect(localeTag("en")).toBe("en-GB");
    expect(localeTag("sv")).toBe("sv-SE");
    expect(dayText("2027-02-02", "sv")).toBe(new Intl.DateTimeFormat("sv-SE", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date("2027-02-02T00:00:00Z")));
    expect(dayText("2027-02-02", "en")).toMatch(/Tue/);
    expect(dayText("not a day", "sv")).toBe("not a day");
  });

  it("writes an instant as the school's clock and the school's day", () => {
    // 22:30 UTC on 1 February is 23:30 in Stockholm, still the 1st; 23:30 UTC is 00:30 on the 2nd.
    expect(clockRangeText("2027-02-01T17:00:00Z", "2027-02-01T19:00:00Z", "sv")).toBe("18:00–20:00");
    expect(clockRangeText("2027-07-01T16:00:00Z", "2027-07-01T18:00:00Z", "sv")).toBe("18:00–20:00");
    expect(instantDayText("2027-02-01T22:30:00Z", "en")).toMatch(/^1 Feb/);
    expect(instantDayText("2027-02-01T23:30:00Z", "en")).toMatch(/^2 Feb/);
    expect(instantDayText("nonsense", "en")).toBe("nonsense");
  });
});

describe("a rule in plain words", () => {
  const rule = { weekdays: [2], intervalWeeks: 1, startDate: "2027-02-02", endDate: "2027-06-08", startTime: "18:00", endTime: "20:00" };

  it("lists the weekdays in week order, once each, in the language's own list", () => {
    expect(weekdayList([3, 1], tSv, "sv")).toBe("måndagar och onsdagar");
    expect(weekdayList([5, 1, 3, 1], tSv, "sv")).toBe("måndagar, onsdagar och fredagar");
    expect(weekdayList([5, 1, 3], tEn, "en")).toBe("Mondays, Wednesdays, and Fridays");
    expect(weekdayList([9, 0, 2], tSv, "sv")).toBe("tisdagar");
  });

  it("says every week plainly and every other week with the words for it", () => {
    expect(ruleText(rule, tSv, "sv")).toBe("tisdagar 18:00–20:00, 2027-02-02–2027-06-08");
    expect(ruleText({ ...rule, intervalWeeks: 2 }, tSv, "sv")).toBe("tisdagar 18:00–20:00, 2027-02-02–2027-06-08, varannan vecka");
    expect(ruleText({ ...rule, intervalWeeks: 2 }, tEn, "en")).toBe("Tuesdays 18:00–20:00, 2027-02-02–2027-06-08, every other week");
    expect(ruleText({ ...rule, intervalWeeks: 3 }, tSv, "sv")).toMatch(/var 3:e vecka$/);
    expect(ruleText({ ...rule, intervalWeeks: 4 }, tEn, "en")).toMatch(/every 4 weeks$/);
  });

  it("calls a series cancelled, ended or active by what it says about itself and today", () => {
    expect(seriesState({ cancelledAt: "2027-02-01T10:00:00Z", endDate: "2027-06-08" }, "2027-02-02")).toBe("cancelled");
    expect(seriesState({ cancelledAt: null, endDate: "2027-02-01" }, "2027-02-02")).toBe("ended");
    expect(seriesState({ cancelledAt: null, endDate: "2027-02-02" }, "2027-02-02")).toBe("active");
    expect(seriesState({ cancelledAt: "2027-02-01T10:00:00Z", endDate: "2027-01-01" }, "2027-02-02")).toBe("cancelled");
  });
});

describe("conflicts", () => {
  it("is blocked when anything refuses the day, warned when only a warning does, free otherwise", () => {
    expect(dayState([])).toBe("FREE");
    expect(dayState([conflict("ACTIVITY", "Temadag", "WARN")])).toBe("WARN");
    expect(dayState([conflict("ACTIVITY", "Temadag", "WARN"), conflict("LESSON", "Matematik 7A")])).toBe("BLOCK");
  });

  it("picks the days of a preview that a registration without skipConflicts would refuse", () => {
    const preview: ExternalPreviewResponse = {
      occurrences: [
        { date: "2027-02-02", startsAt: "", endsAt: "", conflicts: [] },
        { date: "2027-02-09", startsAt: "", endsAt: "", conflicts: [conflict("LESSON", "Matematik 7A")] },
        { date: "2027-02-16", startsAt: "", endsAt: "", conflicts: [conflict("ACTIVITY", "Temadag", "WARN")] },
      ],
      count: 3,
      blocked: 1,
      warned: 1,
      framesMissing: false,
    };
    expect(blockedDays(preview).map((day) => day.date)).toEqual(["2027-02-09"]);
  });

  it("shows a label as the data it is, and turns the loan's code and a used-up count into a sentence", () => {
    expect(conflictLabel(conflict("LESSON", "Matematik 7A"), tSv)).toBe("Matematik 7A");
    expect(conflictLabel(conflict("FRAME", "08:00-16:00"), tSv)).toBe("08:00-16:00");
    expect(conflictLabel(conflict("CLOSED", "Renovering"), tEn)).toBe("Renovering");
    expect(conflictLabel(conflict("LOAN", "ROOM_LENT"), tSv)).toBe("utlånad till en annan skola då");
    expect(conflictLabel(conflict("LOAN", "ROOM_LENT"), tEn)).toBe("lent to another school then");
    expect(conflictLabel(conflict("LOAN", "ROOM_BORROWED_OUTSIDE_LOAN"), tSv)).toMatch(/^lånad sal/);
    // A closure or a lesson that happens to be named like a code is still a name.
    expect(conflictLabel(conflict("LESSON", "ROOM_LENT"), tSv)).toBe("ROOM_LENT");
    expect(conflictLabel(conflict("LOAN", "något annat"), tSv)).toBe("något annat");
    expect(conflictLabel(conflict("BOOKING", "28 av 30"), tSv)).toBe("28 av 30 upptagna");
    expect(conflictLabel(conflict("BOOKING", "28 av 30"), tEn)).toBe("28 of 30 in use");
    expect(conflictLabel(conflict("BOOKING", "Körövning"), tSv)).toBe("Körövning");
    expect(conflictLabel(conflict("LESSON", "28 av 30"), tSv)).toBe("28 av 30");
    expect(conflictLabel(conflict("BOOKING", ""), tSv)).toBe("");
  });

  it("puts a day's conflicts on one line, the kind first and nothing after it when the label is empty", () => {
    expect(conflictLine([conflict("LESSON", "Matematik 7A"), conflict("BOOKING", "Körövning")], tSv)).toBe(
      "Lektion: Matematik 7A, Bokning: Körövning",
    );
    expect(conflictLine([conflict("BOOKING", "")], tEn)).toBe("Booking");
    expect(conflictLine([], tSv)).toBe("");
  });
});

describe("resource types and resources", () => {
  it("wants a name of 1 to 60 letters for a kind", () => {
    expect(resourceTypeErrors("Surfplattor")).toEqual({});
    expect(resourceTypeErrors("  ")).toEqual({ name: "required" });
    expect(resourceTypeErrors("x".repeat(61))).toEqual({ name: "tooLong" });
    expect(resourceTypeErrors("x".repeat(60))).toEqual({});
  });

  it("refuses a resource form the gateway would refuse, naming the field", () => {
    const form = { ...EMPTY_RESOURCE_FORM, name: "Minibuss", resourceTypeId: "type-1" };
    expect(resourceErrors(form)).toEqual({});
    expect(resourceErrors({ ...form, name: "" })).toEqual({ name: "required" });
    expect(resourceErrors({ ...form, name: "x".repeat(81) })).toEqual({ name: "tooLong" });
    expect(resourceErrors({ ...form, resourceTypeId: "" })).toEqual({ resourceTypeId: "required" });
    expect(resourceErrors({ ...form, quantity: "0" })).toEqual({ quantity: "number" });
    expect(resourceErrors({ ...form, quantity: "1001" })).toEqual({ quantity: "number" });
    expect(resourceErrors({ ...form, quantity: "2,5" })).toEqual({ quantity: "number" });
    expect(resourceErrors({ ...form, quantity: "" })).toEqual({ quantity: "number" });
    expect(resourceErrors({ ...form, place: "x".repeat(121) })).toEqual({ place: "tooLong" });
    expect(resourceErrors({ ...form, place: "  " })).toEqual({});
  });

  it("makes the body of a form with every key sent, so a cleared place reaches the gateway as null", () => {
    expect(resourceBody({ name: " Minibuss ", resourceTypeId: "type-1", quantity: "2", siteId: "", place: "  ", requiresApproval: true })).toEqual({
      name: "Minibuss",
      resourceTypeId: "type-1",
      quantity: 2,
      siteId: null,
      place: null,
      requiresApproval: true,
    });
    expect(resourceBody(resourceFormOf(RESOURCE))).toEqual({
      name: "Surfplattor klass 7",
      resourceTypeId: "type-1",
      quantity: 30,
      siteId: "site-1",
      place: "Skåp 3 i B-huset",
      requiresApproval: true,
    });
  });

  it("starts a form from a row, with nulls as empty text", () => {
    expect(resourceFormOf({ ...RESOURCE, siteId: null, siteName: null, place: null })).toMatchObject({ siteId: "", place: "", quantity: "30" });
  });

  it("names the site and the words of a place, either alone, or none", () => {
    expect(placeText(RESOURCE)).toBe("Norra · Skåp 3 i B-huset");
    expect(placeText({ siteName: "Norra", place: null })).toBe("Norra");
    expect(placeText({ siteName: null, place: "Skåp 3" })).toBe("Skåp 3");
    expect(placeText({ siteName: " ", place: "" })).toBeNull();
  });

  it("reads a whole number in a range from a text field", () => {
    expect(wholeNumber("5", 1, 10)).toBe(5);
    expect(wholeNumber(" 5 ", 1, 10)).toBe(5);
    expect(wholeNumber("0", 1, 10)).toBeNull();
    expect(wholeNumber("11", 1, 10)).toBeNull();
    expect(wholeNumber("-1", 1, 10)).toBeNull();
    expect(wholeNumber("1.5", 1, 10)).toBeNull();
    expect(wholeNumber("", 1, 10)).toBeNull();
    expect(wantedQuantity("1000")).toBe(1000);
    expect(wantedQuantity("1001")).toBeNull();
  });
});

describe("an external series", () => {
  const form = (patch: Partial<ExternalForm> = {}): ExternalForm => ({
    ...emptyExternalForm("2027-02-02"),
    roomId: "room-1",
    weekdays: [3, 1],
    endDate: "2027-06-08",
    organisation: "Idrottsföreningen",
    contactName: "Kim Berg",
    contactEmail: "kim@if.example",
    ...patch,
  });

  it("opens on today, in the evening, for a room, with nobody named", () => {
    expect(emptyExternalForm("2027-02-02")).toMatchObject({
      target: "ROOM",
      startDate: "2027-02-02",
      endDate: "2027-02-02",
      startTime: "18:00",
      endTime: "20:00",
      weekdays: [],
      everyOtherWeek: false,
      skipConflicts: false,
      organisation: "",
    });
  });

  it("finds nothing wrong with a complete rule", () => {
    expect(ruleErrors(form())).toEqual({});
    expect(ruleErrors(form({ target: "RESOURCE", roomId: "", resourceId: "res-1", resourceQuantity: "3" }))).toEqual({});
  });

  it("asks for a room or a resource, weekdays, real dates in order, and times in order", () => {
    expect(ruleErrors(form({ roomId: "" }))).toEqual({ target: "required" });
    expect(ruleErrors(form({ target: "RESOURCE", resourceId: "", roomId: "room-1" }))).toEqual({ target: "required" });
    expect(ruleErrors(form({ target: "RESOURCE", resourceId: "res-1", resourceQuantity: "0" }))).toEqual({ quantity: "number" });
    expect(ruleErrors(form({ weekdays: [] }))).toEqual({ weekdays: "weekdays" });
    expect(ruleErrors(form({ startDate: "2027-02-30" }))).toEqual({ startDate: "date" });
    expect(ruleErrors(form({ endDate: "" }))).toEqual({ endDate: "date" });
    expect(ruleErrors(form({ endDate: "2027-02-01" }))).toEqual({ endDate: "dateOrder" });
    expect(ruleErrors(form({ endDate: "2027-02-02" }))).toEqual({});
    expect(ruleErrors(form({ endDate: "2028-03-09" }))).toEqual({ endDate: "span" });
    expect(ruleErrors(form({ endDate: "2028-03-07" }))).toEqual({});
    expect(ruleErrors(form({ startTime: "25:00" }))).toEqual({ startTime: "clock" });
    expect(ruleErrors(form({ endTime: "" }))).toEqual({ endTime: "clock" });
    expect(ruleErrors(form({ startTime: "20:00", endTime: "20:00" }))).toEqual({ endTime: "clockOrder" });
    expect(ruleErrors(form({ startTime: "20:00", endTime: "18:00" }))).toEqual({ endTime: "clockOrder" });
  });

  it("makes the rule's body for a room and for a resource, weekdays in order, every other week as 2", () => {
    expect(ruleBody(form({ everyOtherWeek: true }))).toEqual({
      target: "ROOM",
      roomId: "room-1",
      weekdays: [1, 3],
      intervalWeeks: 2,
      startDate: "2027-02-02",
      endDate: "2027-06-08",
      startTime: "18:00",
      endTime: "20:00",
    });
    expect(ruleBody(form({ target: "RESOURCE", resourceId: "res-1", resourceQuantity: "3" }))).toEqual({
      target: "RESOURCE",
      resourceId: "res-1",
      resourceQuantity: 3,
      weekdays: [1, 3],
      intervalWeeks: 1,
      startDate: "2027-02-02",
      endDate: "2027-06-08",
      startTime: "18:00",
      endTime: "20:00",
    });
  });

  it("keeps a preview for the rule it was made for and for no other", () => {
    expect(ruleKey(form())).toBe(ruleKey(form({ weekdays: [1, 3], organisation: "Någon annan" })));
    expect(ruleKey(form())).not.toBe(ruleKey(form({ weekdays: [1] })));
    expect(ruleKey(form())).not.toBe(ruleKey(form({ startTime: "17:00" })));
  });

  const contact = (patch: Partial<ExternalContactForm> = {}): ExternalContactForm => ({
    organisation: "Idrottsföreningen",
    contactName: "Kim Berg",
    contactPhone: "",
    contactEmail: "kim@if.example",
    purpose: "",
    note: "",
    ...patch,
  });

  it("asks who the series is for: a name, an organisation and at least one way to reach them", () => {
    expect(contactErrors(contact())).toEqual({});
    expect(contactErrors(contact({ contactEmail: "", contactPhone: "070-123 45 67" }))).toEqual({});
    expect(contactErrors(contact({ organisation: " " }))).toEqual({ organisation: "required" });
    expect(contactErrors(contact({ contactName: "x".repeat(121) }))).toEqual({ contactName: "tooLong" });
    expect(contactErrors(contact({ contactEmail: "", contactPhone: "" }))).toEqual({ contactPhone: "contact", contactEmail: "contact" });
    expect(contactErrors(contact({ contactEmail: "inte en adress" }))).toEqual({ contactEmail: "email" });
    expect(contactErrors(contact({ contactEmail: `${"x".repeat(250)}@a.se` }))).toEqual({ contactEmail: "email" });
    expect(contactErrors(contact({ contactPhone: "12" }))).toEqual({ contactPhone: "tooShort" });
    expect(contactErrors(contact({ contactPhone: "1".repeat(41) }))).toEqual({ contactPhone: "tooLong" });
    expect(contactErrors(contact({ purpose: "x".repeat(121), note: "y".repeat(501) }))).toEqual({ purpose: "tooLong", note: "tooLong" });
    // A bad address says so, and does not also say "at least one": one was given.
    expect(contactErrors(contact({ contactEmail: "fel", contactPhone: "" }))).toEqual({ contactEmail: "email" });
  });

  it("holds each field's longest in one table", () => {
    expect(CONTACT_MAX).toEqual({ organisation: 120, contactName: 120, contactPhone: 40, contactEmail: 254, purpose: 120, note: 500 });
    expect(LIMITS.seriesDays).toBe(400);
  });

  it("sends a cleared field as null and trims the rest", () => {
    expect(updateBody(contact({ organisation: " IF ", contactPhone: "  ", purpose: " ", note: " ett " }))).toEqual({
      organisation: "IF",
      contactName: "Kim Berg",
      contactPhone: null,
      contactEmail: "kim@if.example",
      purpose: null,
      note: "ett",
    });
    expect(createBody(form({ skipConflicts: true }))).toMatchObject({
      target: "ROOM",
      roomId: "room-1",
      organisation: "Idrottsföreningen",
      contactPhone: null,
      skipConflicts: true,
    });
  });

  it("starts the change form from the series, null as empty text", () => {
    expect(
      contactFormOf({ organisation: "IF", contactName: "Kim", contactPhone: null, contactEmail: "k@if.example", purpose: null, note: "n" } as never),
    ).toEqual({ organisation: "IF", contactName: "Kim", contactPhone: "", contactEmail: "k@if.example", purpose: "", note: "n" });
  });
});

describe("utnyttjande", () => {
  const params: UtilisationParams = { from: "2027-01-01", to: "2027-07-31", kind: "ALL", openFrom: DEFAULT_OPEN_FROM, openTo: DEFAULT_OPEN_TO };

  it("has the terms: spring is January to July, autumn August to December", () => {
    expect(termOf("spring", 2027)).toEqual({ id: "2027-spring", term: "spring", year: 2027, from: "2027-01-01", to: "2027-07-31" });
    expect(termOf("autumn", 2027)).toEqual({ id: "2027-autumn", term: "autumn", year: 2027, from: "2027-08-01", to: "2027-12-31" });
    expect(termContaining("2027-07-31").term).toBe("spring");
    expect(termContaining("2027-08-01").term).toBe("autumn");
    expect(termContaining("2027-12-31")).toMatchObject({ term: "autumn", year: 2027 });
    expect(termContaining("2027-01-01")).toMatchObject({ term: "spring", year: 2027 });
  });

  it("offers last year, this year and next, in time order", () => {
    expect(termPresets("2027-02-02").map((preset) => preset.id)).toEqual([
      "2026-spring",
      "2026-autumn",
      "2027-spring",
      "2027-autumn",
      "2028-spring",
      "2028-autumn",
    ]);
  });

  it("accepts the usual period and hours, and refuses what the gateway would", () => {
    expect(utilisationErrors(params)).toEqual({});
    expect(utilisationErrors({ ...params, from: "2027-13-01" })).toEqual({ from: "date" });
    expect(utilisationErrors({ ...params, to: "" })).toEqual({ to: "date" });
    expect(utilisationErrors({ ...params, to: "2026-12-31" })).toEqual({ to: "dateOrder" });
    expect(utilisationErrors({ ...params, from: "2027-02-01", to: "2027-02-01" })).toEqual({});
    // 400 days inclusive is the most: 2027-01-01 to 2028-02-04.
    expect(utilisationErrors({ ...params, to: "2028-02-04" })).toEqual({});
    expect(utilisationErrors({ ...params, to: "2028-02-05" })).toEqual({ to: "span" });
    expect(utilisationErrors({ ...params, openFrom: "7" })).toEqual({ openFrom: "clock" });
    expect(utilisationErrors({ ...params, openTo: "25:00" })).toEqual({ openTo: "clock" });
    expect(utilisationErrors({ ...params, openFrom: "22:00", openTo: "07:00" })).toEqual({ openTo: "clockOrder" });
  });

  it("writes the query string of the report and its file, and names the file as the gateway does", () => {
    expect(utilisationQuery(params)).toBe("from=2027-01-01&to=2027-07-31&kind=ALL&openFrom=07%3A00&openTo=22%3A00");
    expect(utilisationQuery({ ...params, kind: "RESOURCE" })).toContain("kind=RESOURCE");
    expect(utilisationFilename("2027-01-01", "2027-07-31")).toBe("utnyttjande-2027-01-01-2027-07-31.csv");
  });

  it("writes a share as a percentage in the language's own way, and a dash where there is no time to divide by", () => {
    expect(shareText(0.45, "sv")).toBe("45 %");
    expect(shareText(0.453, "sv")).toBe("45,3 %");
    expect(shareText(0.453, "en")).toBe("45.3%");
    expect(shareText(0, "sv")).toBe("0 %");
    expect(shareText(null, "sv")).toBe("–");
  });

  it("writes minutes as hours with one decimal at most", () => {
    expect(hoursText(750, "sv")).toBe("12,5");
    expect(hoursText(750, "en")).toBe("12.5");
    expect(hoursText(60, "sv")).toBe("1");
    expect(hoursText(0, "sv")).toBe("0");
    expect(hoursText(100, "sv")).toBe("1,7");
  });

  it("numbers the ISO weeks of the Mondays a report draws, across the new year", () => {
    expect(weekNumber("2027-02-01")).toBe(5);
    expect(weekNumber("2026-12-28")).toBe(53);
    expect(weekNumber("2027-01-04")).toBe(1);
    expect(weekNumber("2028-01-03")).toBe(1);
  });
});
