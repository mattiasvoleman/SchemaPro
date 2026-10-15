import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { uppdragLoad } from "@/lib/__fixtures__/staffing-fas3";
import type { StaffingReconciliationResponse } from "@/lib/staffing-reconciliation";
import { hoursText } from "@/lib/staffing-reconciliation";
import { ApiError } from "@/lib/api";
import enMessages from "@/messages/en.json";
import svMessages from "@/messages/sv.json";
import { StaffingReport } from "./staffing-report";

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.scrollIntoView ??= () => {};

const download = vi.hoisted(() => vi.fn());
const downloadText = vi.hoisted(() => vi.fn());
const apiGet = vi.hoisted(() => vi.fn());
const YEAR_1 = { id: "y1", name: "2026/27", isActive: true, startDate: "2026-08-17", endDate: "2027-06-11" };
const YEAR_2 = { id: "y2", name: "2027/28", isActive: false, startDate: "2027-08-16", endDate: "2028-06-09" };
const state = vi.hoisted(() => ({
  years: [] as unknown[],
  rec: { data: undefined as unknown, isLoading: false, isError: false, error: null as unknown },
  recArgs: [] as unknown[][],
}));

vi.mock("@/lib/csv-export", async (original) => ({
  ...(await original<typeof import("@/lib/csv-export")>()),
  downloadCsv: download,
}));
vi.mock("@/lib/scb-file", async (original) => ({
  ...(await original<typeof import("@/lib/scb-file")>()),
  downloadScbText: downloadText,
}));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: { get: apiGet },
}));
vi.mock("./use-staffing-reconciliation", () => ({
  useStaffingReconciliation: (...args: unknown[]) => {
    state.recArgs.push(args);
    return state.rec;
  },
}));
vi.mock("@/lib/staffing-queries", () => ({
  useStaffingLoad: () => ({
    data: { loadModel: "MINUTES", teachers: [uppdragLoad] },
    isLoading: false,
    isError: false,
  }),
}));
vi.mock("@/lib/queries", () => ({
  useAcademicYears: () => ({ data: state.years }),
  usePeople: () => ({
    data: [
      { id: "t-anna", role: "TEACHER", firstName: "Anna", lastName: "Öberg" },
      { id: "t-bo", role: "TEACHER", firstName: "Bo", lastName: "Alm" },
    ],
  }),
  useSubjects: () => ({ data: [{ id: "s-ma", name: "Matematik", nationalCode: "MA", code: "MA" }] }),
  useGroups: () => ({ data: [{ id: "g-7a", name: "7A" }, { id: "g-7b", name: "7B" }] }),
}));
vi.mock("@/components/profile-context", () => ({
  useProfile: () => ({ profile: { id: "u-admin" }, school: { name: "Norra skolan", timezone: "Europe/Stockholm" } }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    `${namespace === "timplanCoverage.delivered.cause" ? "cause." : ""}${key}${
      values ? `(${Object.values(values).join("|")})` : ""
    }`,
}));

const lost = { cancelledTeacherUnavailable: 0, cancelledRoomUnavailable: 0, cancelledManual: 0, cancelledUnknown: 0, otherStatus: 0 };
const response = (overrides: Partial<StaffingReconciliationResponse> = {}): StaffingReconciliationResponse => ({
  academicYearId: "y1",
  year: { startDate: "2026-08-17", endDate: "2027-06-11" },
  asOf: "2026-10-09T10:00:00.000Z",
  asOfDate: "2026-10-09",
  from: "2026-08-17",
  to: "2026-10-09",
  comparison: { from: "2026-08-24", to: "2026-10-09" },
  loadModel: "MINUTES",
  published: { from: "2026-08-24", through: "2026-12-18" },
  teachers: [
    {
      userId: "t-anna",
      planned: 2400,
      scheduled: 2380,
      delivered: 2200,
      substituteMinutes: 0,
      coveredByOthersMinutes: 120,
      aheadMinutes: 60,
      lost: { ...lost, cancelledManual: 80 },
      lostMinutes: 80,
      deliveredLessons: 40,
      displacedLessons: 0,
      lines: [
        { subjectId: "s-ma", studentGroupId: "g-7a", extraGroupIds: ["g-7b"], planned: 2400, scheduled: 2380, delivered: 2200, substituteMinutes: 0, lostMinutes: 80 },
      ],
    },
    {
      userId: "t-bo",
      planned: 0,
      scheduled: 0,
      delivered: 300,
      substituteMinutes: 300,
      coveredByOthersMinutes: 0,
      aheadMinutes: 0,
      lost,
      lostMinutes: 0,
      deliveredLessons: 5,
      displacedLessons: 0,
      lines: [],
    },
  ],
  groupLosses: [{ studentGroupId: "g-7a", subjectId: "s-ma", teacherless: 40, ...lost, cancelledManual: 80, lessons: 3 }],
  totals: { planned: 2400, scheduled: 2380, delivered: 2500, substituteMinutes: 300, coveredByOthersMinutes: 120, lostMinutes: 80, aheadMinutes: 60 },
  notices: [{ code: "STAFFING_RANGE_BEFORE_PUBLISHED", params: { publishedFrom: "2026-08-24" } }],
  ...overrides,
});

describe("Rapporter › Tjänstefördelning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.recArgs = [];
    state.years = [YEAR_1];
    state.rec = { data: response(), isLoading: false, isError: false, error: null };
  });

  it("asks for the active year with the gateway's default range, and states the range it used", () => {
    render(<StaffingReport />);
    expect(state.recArgs.at(-1)).toEqual(["y1", null, null]);
    expect(screen.getByText("comparison(2026-08-24|2026-10-09|model.MINUTES)")).toBeInTheDocument();
    expect(screen.getByText("notice.STAFFING_RANGE_BEFORE_PUBLISHED(2026-08-24)")).toBeInTheDocument();
  });

  it("shows the KPIs in minutes and hours, and one row per teacher by family name", () => {
    render(<StaffingReport />);
    expect(screen.getByText("minutes(2500)")).toBeInTheDocument();
    expect(screen.getByText("hours(41,7)")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: /tableCaption/ });
    const names = within(table)
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(names).toEqual(["Bo Alm", "Anna Öberg"]);
    const anna = within(table).getByRole("button", { name: "showLines(Anna Öberg)" }).closest("tr")!;
    expect(within(anna).getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
      "Anna Öberg", "80 %", "2400", "2380", "2200", "-200", "0", "120", "80", "60",
    ]);
  });

  it("unfolds a teacher's lines per subject and group, naming the samläsning", async () => {
    const user = userEvent.setup();
    render(<StaffingReport />);
    await user.click(screen.getByRole("button", { name: "showLines(Anna Öberg)" }));
    expect(screen.getByRole("button", { name: "hideLines(Anna Öberg)" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Matematik · 7A withGroups(7B)")).toBeInTheDocument();
  });

  it("lists the bortfall per group with P3's cause names, and the footnotes, Faktor only when it is on", () => {
    const { unmount } = render(<StaffingReport />);
    expect(screen.getByRole("columnheader", { name: "cause.teacherless" })).toBeInTheDocument();
    expect(screen.getByText("7A · Matematik").closest("tr")).toHaveTextContent("7A · Matematik400080003120");
    expect(screen.getByText("footCredit")).toBeInTheDocument();
    expect(screen.queryByText("footFactor")).not.toBeInTheDocument();
    unmount();
    state.rec = { data: response({ loadModel: "FACTOR" }), isLoading: false, isError: false, error: null };
    render(<StaffingReport />);
    expect(screen.getByText("footFactor")).toBeInTheDocument();
  });

  it("adds the avbokning column only when a bulk avbokning cost minutes, and counts them in the row's total", () => {
    const { unmount } = render(<StaffingReport />);
    expect(screen.queryByRole("columnheader", { name: "cause.cancelledEvent" })).not.toBeInTheDocument();
    unmount();
    const withEvent = response();
    withEvent.groupLosses = [{ ...withEvent.groupLosses[0]!, cancelledEvent: 60 }];
    state.rec = { data: withEvent, isLoading: false, isError: false, error: null };
    render(<StaffingReport />);
    expect(screen.getByRole("columnheader", { name: "cause.cancelledEvent" })).toBeInTheDocument();
    expect(screen.getByText("7A · Matematik").closest("tr")).toHaveTextContent("7A · Matematik40008000603180");
  });

  it("keeps the other date at what it showed when one is edited, and never asks for a start after the end", async () => {
    const user = userEvent.setup();
    const { container } = render(<StaffingReport />);
    const from = container.querySelector<HTMLInputElement>("#staffing-from")!;
    await user.clear(from);
    await user.type(from, "2026-09-01");
    // "Till" is fixed at the default the answer stated, not dropped to null.
    expect(state.recArgs.at(-1)).toEqual(["y1", "2026-09-01", "2026-10-09"]);
    expect(container.querySelector<HTMLInputElement>("#staffing-to")!.value).toBe("2026-10-09");

    const asked = state.recArgs.length;
    await user.clear(from);
    await user.type(from, "2026-11-01");
    expect(screen.getByRole("alert")).toHaveTextContent("rangeCrossed");
    // The query still asks for the last range that makes sense.
    expect(state.recArgs.slice(asked).every((args) => args[1] !== "2026-11-01")).toBe(true);
  });

  it("dims the figures it keeps while a new range loads, instead of a skeleton", () => {
    state.rec = { data: response(), isLoading: false, isError: false, error: null, isPlaceholderData: true } as typeof state.rec;
    render(<StaffingReport />);
    expect(screen.getByText("minutes(2500)").closest("[aria-busy]")).toHaveClass("opacity-60");
  });

  it("says the reconciliation could not be read rather than drawing an empty report", () => {
    state.rec = { data: undefined, isLoading: false, isError: true, error: new Error("academic year not active") };
    render(<StaffingReport />);
    // The page's error recipe (LoadError): what failed, and that nothing
    // changed. The gateway's message is English prose written for a log, so
    // it is no longer put in front of the reader.
    expect(screen.getByRole("heading", { level: 2, name: "loadFailed" })).toBeInTheDocument();
    expect(screen.getByText("loadFailedHint")).toBeInTheDocument();
    expect(screen.queryByText("academic year not active")).not.toBeInTheDocument();
    expect(screen.queryByText(/minutes\(/)).not.toBeInTheDocument();
  });

  it("names the reason when the gateway refuses a year whose predecessor is not activated", () => {
    state.rec = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: new ApiError(409, "Klasslistorna för 2027/28 …", "ROLLOVER_NOT_ACTIVATED", {
        year: "2027/28",
        predecessor: "2026/27",
      }),
    };
    render(<StaffingReport />);
    expect(screen.getByRole("heading", { level: 2, name: "loadFailed" })).toBeInTheDocument();
    // The code's own sentence, with what to activate; not "try again later".
    expect(screen.getByText("ROLLOVER_NOT_ACTIVATED(2027/28|2026/27)")).toBeInTheDocument();
    expect(screen.queryByText("loadFailedHint")).not.toBeInTheDocument();
  });

  it("shows the gateway's sentence, without its field tag, for a period it will not read", () => {
    state.rec = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: new ApiError(400, "from/to: perioden ligger helt utanför läsåret (2026-08-17 – 2027-06-11)."),
    };
    render(<StaffingReport />);
    expect(screen.getByText("Perioden ligger helt utanför läsåret (2026-08-17 – 2027-06-11).")).toBeInTheDocument();
    expect(screen.queryByText("loadFailedHint")).not.toBeInTheDocument();
  });

  it("offers only the year's days in the period's calendars", async () => {
    const user = userEvent.setup();
    render(<StaffingReport />);
    await user.click(screen.getByRole("button", { name: "openCalendarFor(from)" }));
    expect(screen.getByRole("button", { name: "16 augusti 2026" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "17 augusti 2026" })).toBeEnabled();
  });

  it("keeps the generic hint for a server failure", () => {
    state.rec = { data: undefined, isLoading: false, isError: true, error: new ApiError(503, "Service Unavailable") };
    render(<StaffingReport />);
    expect(screen.getByText("loadFailedHint")).toBeInTheDocument();
    expect(screen.queryByText("Service Unavailable")).not.toBeInTheDocument();
  });

  it("downloads the samverkan file with the vikarie in it, and behörigheter only when ticked", async () => {
    const user = userEvent.setup();
    render(<StaffingReport />);
    await user.click(screen.getByRole("button", { name: "exportSamverkan" }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    const [filename, csv] = download.mock.calls[0] as [string, string];
    expect(filename).toBe("tjanstefordelning-2026-27-2026-08-17-2026-10-09.csv");
    expect(csv).toContain("Alm;Bo;");
    expect(csv).not.toContain("Behörigheter");
    expect(apiGet).not.toHaveBeenCalled();

    apiGet.mockResolvedValueOnce([]);
    await user.click(screen.getByRole("checkbox", { name: "includeQualifications" }));
    await user.click(screen.getByRole("button", { name: "exportSamverkan" }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(2));
    expect(apiGet).toHaveBeenCalledWith("/api/v1/teacher-qualifications");
    expect(download.mock.calls[1]![1]).toContain("Behörigheter");
  });

  it("saves the gateway's SCB file as it came, and lists PersonNr, the rows that lack more, and the notices", async () => {
    const user = userEvent.setup();
    const file = {
      filename: "scb-pedagogisk-personal-2026-27.txt",
      matdatum: "2026-10-15",
      specVersionDate: "2026-05-07",
      columns: ["System", "Datum", "PersonNamn"],
      rows: [
        ["SchemaPro", "2026-10-16", "Bo Alm"],
        ["SchemaPro", "2026-10-16", "Anna Öberg"],
      ],
      text: "SchemaPro;2026-10-16;Bo Alm\r\nSchemaPro;2026-10-16;Anna Öberg\r\n",
      missing: [{ line: 1, name: "Bo Alm", unit: "Norra skolan", verksamhetstyp: "", fields: ["ANSTFORM", "VERKSAMHETSTYP"] }],
      notices: [{ code: "REDUCTION", params: { name: "Anna Öberg" } }],
    };
    apiGet.mockImplementation(async (path: string) => {
      if (path === "/api/v1/staffing/scb-file?academicYearId=y1") return file;
      throw new Error(path);
    });
    render(<StaffingReport />);
    expect(screen.getByText("scbNotice")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "exportScb" }));
    await waitFor(() => expect(downloadText).toHaveBeenCalledTimes(1));
    // One read: the gateway built it; the browser asks nothing else.
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(downloadText).toHaveBeenCalledWith(file);
    expect(download).not.toHaveBeenCalled();

    expect(await screen.findByText("scbFileSummary(scb-pedagogisk-personal-2026-27.txt|2|2026-10-15)")).toBeInTheDocument();
    expect(screen.getByText("scbPersonNr(2)")).toBeInTheDocument();
    expect(screen.getByText("scbMissingTitle(1)")).toBeInTheDocument();
    expect(
      screen.getByText("scbMissingRow(1|Bo Alm|Norra skolan|none|scb.missing.ANSTFORM, scb.missing.VERKSAMHETSTYP)"),
    ).toBeInTheDocument();
    expect(screen.getByText("scb.notice.REDUCTION(Anna Öberg)")).toBeInTheDocument();

    // The CSV is the same rows, from the answer held: no second read.
    await user.click(screen.getByRole("button", { name: "exportScbCsv" }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    expect(apiGet).toHaveBeenCalledTimes(1);
    const [filename, csv] = download.mock.calls[0] as [string, string];
    expect(filename).toBe("scb-pedagogisk-personal-2026-27.csv");
    expect(csv.split("\r\n")[0]).toBe("\uFEFFSystem;Datum;PersonNamn");
    expect(csv.split("\r\n")[2]).toBe("SchemaPro;2026-10-16;Anna Öberg");
  });

  it("says a refusal in its own words, never Nest's English, and leaves no older file's panel standing", async () => {
    const user = userEvent.setup();
    const { toast } = await import("sonner");
    const file = {
      filename: "f.txt", matdatum: "2026-10-15", specVersionDate: "2026-05-07", columns: ["System"],
      rows: [["SchemaPro"]], text: "SchemaPro\r\n", missing: [], notices: [],
    };
    apiGet.mockResolvedValueOnce(file);
    render(<StaffingReport />);
    await user.click(screen.getByRole("button", { name: "exportScb" }));
    expect(await screen.findByText("scbFileSummary(f.txt|1|2026-10-15)")).toBeInTheDocument();

    // A 403 is Nest's English: the tab says the export failed. A 409 says its reason.
    apiGet.mockRejectedValueOnce(new ApiError(403, "Forbidden resource"));
    await user.click(screen.getByRole("button", { name: "exportScb" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("exportFailed"));
    expect(screen.queryByText(/^scbFileSummary/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "exportScbCsv" })).not.toBeInTheDocument();
    expect(downloadText).toHaveBeenCalledTimes(1);

    apiGet.mockRejectedValueOnce(new ApiError(409, "läsåret: klasserna går inte att räkna ut än"));
    await user.click(screen.getByRole("button", { name: "exportScb" }));
    await waitFor(() => expect(toast.error).toHaveBeenLastCalledWith("Läsåret: klasserna går inte att räkna ut än"));
  });

  it("shows a file only under the year it was asked for, when the year changes while it is fetched", async () => {
    state.years = [YEAR_1, YEAR_2];
    const user = userEvent.setup();
    let answer: (file: unknown) => void = () => {};
    apiGet.mockImplementation(
      (path: string) =>
        new Promise((resolve, reject) =>
          path.startsWith("/api/v1/staffing/scb-file") ? (answer = resolve) : reject(new Error(path)),
        ),
    );
    render(<StaffingReport />);
    await user.click(screen.getByRole("button", { name: "exportScb" }));
    expect(apiGet).toHaveBeenCalledWith("/api/v1/staffing/scb-file?academicYearId=y1");
    await user.click(screen.getByRole("combobox", { name: "year" }));
    await user.click(screen.getByRole("option", { name: /2027\/28/ }));
    answer({
      filename: "scb-pedagogisk-personal-2026-27.txt", matdatum: "2026-10-15", specVersionDate: "2026-05-07",
      columns: ["System"], rows: [["SchemaPro"]], text: "SchemaPro\r\n", missing: [], notices: [],
    });
    // The file asked for is saved under its own year's name; its lists stay with that year.
    await waitFor(() => expect(downloadText).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/^scbFileSummary/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "exportScbCsv" })).not.toBeInTheDocument();
  });
});

/*
 * The mocked translator above never parses a message body, so a count put
 * bare into a sentence — "1 hållna lektioner", "1 dagar" — is invisible to
 * the rows above. next-intl is un-mocked here and the real catalogues are
 * formatted, at one and at three.
 */
describe("the tab's sentences, formatted by the real catalogues", () => {
  it("counts lessons and gap days in the singular and the plural, in Swedish and English", async () => {
    const { createTranslator } = await vi.importActual<typeof import("next-intl")>("next-intl");
    const sv = createTranslator({ locale: "sv", messages: svMessages, namespace: "reports.staffing.notice" });
    const en = createTranslator({ locale: "en", messages: enMessages, namespace: "reports.staffing.notice" });
    const gap = (days: number) => ({ days, from: "2026-09-16", through: "2026-09-16" });
    expect(sv("STAFFING_LEAD_BESIDE_SUBSTITUTE", { lessons: 1 })).toMatch(/^1 hållen lektion har /);
    expect(sv("STAFFING_LEAD_BESIDE_SUBSTITUTE", { lessons: 3 })).toMatch(/^3 hållna lektioner har /);
    expect(sv("STAFFING_RANGE_HAS_GAPS", gap(1))).toContain("1 dag mellan");
    expect(sv("STAFFING_RANGE_HAS_GAPS", gap(4))).toContain("4 dagar mellan");
    expect(en("STAFFING_LEAD_BESIDE_SUBSTITUTE", { lessons: 1 })).toMatch(/^1 held lesson has /);
    expect(en("STAFFING_LEAD_BESIDE_SUBSTITUTE", { lessons: 3 })).toMatch(/^3 held lessons have /);
    expect(en("STAFFING_RANGE_HAS_GAPS", gap(1))).toContain("1 day between");
  });

  it("says PersonNr, the rows that lack more, and a row without a verksamhetstyp in both languages", async () => {
    const { createTranslator } = await vi.importActual<typeof import("next-intl")>("next-intl");
    const sv = createTranslator({ locale: "sv", messages: svMessages, namespace: "reports.staffing" });
    const en = createTranslator({ locale: "en", messages: enMessages, namespace: "reports.staffing" });
    const row = { line: 3, name: "Bo Alm", unit: "Norra 7–9", fields: "anställningsform" };
    expect(sv("scbMissingRow", { ...row, type: "none" })).toBe("Rad 3: Bo Alm, Norra 7–9. Saknar anställningsform.");
    expect(sv("scbMissingRow", { ...row, type: "6" })).toBe("Rad 3: Bo Alm, Norra 7–9, verksamhetstyp 6. Saknar anställningsform.");
    expect(en("scbMissingRow", { ...row, type: "6" })).toContain("type of activity 6");
    expect(sv("scbMissingTitle", { count: 0 })).toBe("Ingen rad saknar något mer än personnummer.");
    expect(sv("scbMissingTitle", { count: 1 })).toBe("1 rad saknar mer än personnummer:");
    expect(sv("scbPersonNr", { count: 1 })).toMatch(/^PersonNr är tomt på filens rad\./);
    expect(sv("scbPersonNr", { count: 12 })).toMatch(/^PersonNr är tomt på alla 12 rader\./);
    expect(en("scbFileSummary", { filename: "f.txt", count: 1, matdatum: "2026-10-15" })).toBe(
      "f.txt is downloaded: 1 row, the posts as they are on the reference date 2026-10-15.",
    );
    expect(sv("scb.notice.LEAVE", { name: "Anna", from: "2026-10-12", to: "2026-12-18" })).toContain("AnstForm L");
  });

  it("writes hours in the reader's decimal mark, and calls SCB's file the file everywhere", () => {
    expect(hoursText(1290, "sv")).toBe("21,5");
    expect(hoursText(1290, "en")).toBe("21.5");
    expect(hoursText(-90, "sv")).toBe("-1,5");
    expect(hoursText(1200, "en")).toBe("20");
    expect(enMessages.staffing.unitHintPercentFactor).toMatch(/the SCB file/);
    expect(svMessages.staffing.unitHintPercentFactor).toMatch(/SCB-filen/);
    // The browser-built underlag is gone: no sentence still names it.
    expect(JSON.stringify(svMessages)).not.toMatch(/SCB-underlag/);
    expect(JSON.stringify(enMessages)).not.toMatch(/SCB working file/);
  });
});
