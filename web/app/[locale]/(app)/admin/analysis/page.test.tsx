import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type {
  CostBasis,
  CostFigures,
  CostRate,
  KeyFigures,
  PayrollBasis,
  PayrollFile,
  SchoolPart,
  TeacherKeyFigures,
} from "@/lib/analysis-types";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import AnalysisPage from "./page";

// Environment shims for Radix in jsdom — not behaviour under test.
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/**
 * Analys och planering, the administrator's page (/admin/analysis), through the
 * gateway's routes and the real messages: a key missing from sv.json or en.json
 * throws here instead of printing its path.
 *
 * What this guards: only the open tab asks the gateway anything, and the
 * payroll not until it is given a period; a failed read is said as such and
 * never "nothing here"; tjänstgöringsgrad is not a column for a reader without
 * HR-läs; the huvudman's reader is shown the school's figures and no teacher; a
 * cost the school has no rate for is UNKNOWN and not zero; a reader who is not
 * given the cost basis or the payroll is told so calmly; the files are handed
 * over as the gateway built them; and a skoldel and a rate are changed by those
 * who decide and read by the rest.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));

const profile = vi.hoisted(() => ({ readOnly: false, adminProfile: "FULL" as string | undefined }));
vi.mock("@/components/profile-context", () => ({
  useReadOnly: () => profile.readOnly,
  useProfile: () => ({ profile: profile.adminProfile === undefined ? null : { adminProfile: profile.adminProfile } }),
}));

vi.mock("@/lib/queries", () => ({
  usePeople: () => ({
    data: [
      { id: "t1", firstName: "Anna", lastName: "Lind" },
      { id: "t2", firstName: "Bo", lastName: "Ek" },
      { id: "t3", firstName: "Cy", lastName: "Åkesson" },
      { id: "pool-1", firstName: "Vera", lastName: "Vikarie" },
    ],
  }),
}));

vi.mock("@/components/schedule/year-select", () => ({
  useYearScope: () => ({
    years: [{ id: "y1", name: "2026/27", isActive: true }],
    year: { id: "y1", name: "2026/27", isActive: true },
    yearId: "y1",
    setYearId: vi.fn(),
    isLoading: false,
    isError: false,
  }),
  YearSelect: () => null,
}));

const files = vi.hoisted(() => ({ downloadCsv: vi.fn(), saveBase64: vi.fn() }));
vi.mock("@/lib/csv-export", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/csv-export")>()), downloadCsv: files.downloadCsv }));
vi.mock("@/lib/schedule-exchange", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/schedule-exchange")>()), saveBase64: files.saveBase64 }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const ROOT = "/api/v1/analysis";

const teacher = (userId: string, over: Partial<TeacherKeyFigures> = {}): TeacherKeyFigures => ({
  userId,
  teachingMinutesPerWeek: 600,
  dutyMinutesPerWeek: 0,
  countedMinutesPerWeek: 600,
  targetMinutesPerWeek: 1080,
  percentOfTarget: 56,
  status: "UNDER",
  scheduledMinutesPerWeek: null,
  teachingHoursPerYear: 400,
  employmentPercent: 100,
  groups: 3,
  pupils: 60,
  qualifiedShare: 1,
  ...over,
});

const keyFigures = (over: Partial<KeyFigures> = {}): KeyFigures => ({
  academicYearId: "y1",
  year: { startDate: "2026-08-17", endDate: "2027-06-11" },
  loadModel: "MINUTES",
  school: {
    pupils: 120,
    teachers: 3,
    teachingMinutesPerWeek: 1980,
    teachingHoursPerYear: 1320,
    fullTimeTeachingMinutesPerWeek: 1080,
    teachingFte: 1.83,
    teachingFtePer100Pupils: 1.53,
    teachersPer100Pupils: 2.5,
    pupilsPerTeacher: 40,
    qualificationsRecorded: true,
    qualifiedMinutesPerWeek: 1500,
    unqualifiedMinutesPerWeek: 480,
    qualifiedShare: 0.7576,
    unstaffedMinutesPerWeek: 0,
    employmentFte: 2.3,
    employmentFtePer100Pupils: 1.92,
  },
  teachers: [
    teacher("t1", { teachingMinutesPerWeek: 840, percentOfTarget: 78, pupils: 90, qualifiedShare: 1 }),
    teacher("t2", { teachingMinutesPerWeek: 360, percentOfTarget: 33, pupils: 30, qualifiedShare: 0, employmentPercent: 50 }),
    teacher("t3", { teachingMinutesPerWeek: 780, percentOfTarget: null, pupils: 60, qualifiedShare: 0.5, employmentPercent: 80 }),
  ],
  notices: [],
  ...over,
});

const figures = (over: Partial<CostFigures> = {}): CostFigures => ({
  pupils: 60,
  hours: { TEACHER: 1200.5, UNQUALIFIED_TEACHER: 80, SUBSTITUTE: 10.25 },
  hoursPerPupil: 21.5,
  cost: 520000,
  costPerPupil: 8667,
  ...over,
});

const costBasis = (over: Partial<CostBasis> = {}): CostBasis => ({
  academicYearId: "y1",
  year: { startDate: "2026-08-17", endDate: "2027-06-11" },
  gradeNumbering: "NIOARIG",
  substitutes: { from: "2026-08-17", to: "2026-11-06" },
  rates: [
    { category: "TEACHER", hourlyCost: 420 },
    { category: "SUBSTITUTE", hourlyCost: 310 },
  ],
  missingRates: [],
  parts: [{ schoolPartId: "high", name: "Högstadiet", account: "4030", ...figures({ pupils: 120 }) }],
  cells: [
    { schoolPartId: "high", gradeLevel: 7, ...figures() },
    { schoolPartId: "high", gradeLevel: 8, ...figures({ cost: null, costPerPupil: null }) },
  ],
  total: figures({ pupils: 120 }),
  notices: [],
  ...over,
});

const PARTS: SchoolPart[] = [
  { id: "low", name: "Lågstadiet", account: "4010", gradeFrom: 0, gradeTo: 3 },
  { id: "high", name: "Högstadiet", account: "4030", gradeFrom: 7, gradeTo: 9 },
];
const RATES: CostRate[] = [{ category: "TEACHER", hourlyCost: 420.5 }];

const payroll = (over: Partial<PayrollBasis> = {}): PayrollBasis => ({
  academicYearId: "y1",
  from: "2026-10-01",
  to: "2026-10-31",
  parts: PARTS,
  people: [
    { userId: "t1", kind: "STAFF", teachingMinutes: 1200, dutyMinutes: 120, substituteMinutes: 0, employmentPercent: 100 },
    { userId: "pool-1", kind: "POOL", teachingMinutes: 0, dutyMinutes: 0, substituteMinutes: 90, employmentPercent: null },
  ],
  lines: [
    { userId: "t1", kind: "STAFF", schoolPartId: "high", account: "4030", teachingMinutes: 1200, dutyMinutes: 120, substituteMinutes: 0 },
    { userId: "pool-1", kind: "POOL", schoolPartId: null, account: null, teachingMinutes: 0, dutyMinutes: 0, substituteMinutes: 90 },
  ],
  protectedInAnswer: 0,
  notices: [],
  ...over,
});

const state = vi.hoisted(() => ({
  key: undefined as unknown,
  cost: undefined as unknown,
  pay: undefined as unknown,
  parts: undefined as unknown,
  rates: undefined as unknown,
  fail: null as null | { path: string; error: Error },
}));

function renderPage(locale: "sv" | "en" = "sv") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider
        locale={locale}
        messages={locale === "sv" ? sv : en}
        timeZone="Europe/Stockholm"
        onError={(error) => {
          throw error;
        }}
      >
        <AnalysisPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  profile.readOnly = false;
  profile.adminProfile = "FULL";
  state.key = keyFigures();
  state.cost = costBasis();
  state.pay = payroll();
  state.parts = PARTS;
  state.rates = RATES;
  state.fail = null;
  api.get.mockImplementation(async (path: string) => {
    if (state.fail && path.startsWith(state.fail.path)) throw state.fail.error;
    if (path.startsWith(`${ROOT}/key-figures`)) return state.key;
    if (path.startsWith(`${ROOT}/cost-basis`)) return state.cost;
    if (path.startsWith(`${ROOT}/payroll-basis`)) return state.pay;
    if (path === `${ROOT}/school-parts`) return state.parts;
    if (path === `${ROOT}/cost-rates`) return state.rates;
    throw new Error(`unexpected read ${path}`);
  });
  api.post.mockResolvedValue({});
  api.put.mockResolvedValue({});
  api.patch.mockResolvedValue({});
  api.delete.mockResolvedValue(undefined);
});

const openTab = async (name: string) => {
  await userEvent.click(screen.getByRole("tab", { name }));
};
const paths = () => api.get.mock.calls.map(([path]) => path as string);
const rowsOf = (table: HTMLElement) => within(table).getAllByRole("row").slice(1);

describe("Analys och planering, the administrator's page", () => {
  it("opens on the key figures and reads nothing but them, in the school's year", async () => {
    renderPage();
    expect(await screen.findByRole("table", { name: "Nyckeltal per lärare" })).toBeInTheDocument();
    expect(paths()).toEqual([`${ROOT}/key-figures?academicYearId=y1`]);
  });

  it("says the school's figures in four tiles: pupils, density, the qualified share and the teaching", async () => {
    renderPage();
    await screen.findByRole("table", { name: "Nyckeltal per lärare" });
    expect(screen.getByText("Lärartäthet")).toBeInTheDocument();
    expect(screen.getByText("1,53")).toBeInTheDocument();
    expect(screen.getByText(/2,50 lärare per 100 elever \(3 lärare\)/)).toBeInTheDocument();
    expect(screen.getByText("75,8 %")).toBeInTheDocument();
    expect(screen.getByText("40,0 elever per lärare")).toBeInTheDocument();
    expect(screen.getByText("1 320 tim/år")).toBeInTheDocument();
    // The HR-based density, for a reader of HR data.
    expect(screen.getByText(/Efter tjänstgöringsgrad: 2,30 heltidstjänster, 1,92 per 100 elever\./)).toBeInTheDocument();
  });

  it("lists the teachers by name, hours a week and tjänstgöringsgrad, and sorts on a heading both ways", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: "Nyckeltal per lärare" });
    expect(rowsOf(table).map((row) => within(row).getAllByRole("cell")[0]!.textContent)).toEqual(["Ek, Bo", "Lind, Anna", "Åkesson, Cy"]);
    const lind = rowsOf(table).find((row) => within(row).getAllByRole("cell")[0]!.textContent === "Lind, Anna")!;
    expect(within(lind).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["Lind, Anna", "14,0", "78 %", "90", "100 %", "100,0 %"]);
    expect(within(rowsOf(table)[2]!).getAllByRole("cell")[2]!.textContent).toBe("Inget mål");

    await userEvent.click(screen.getByRole("button", { name: /Elever/ }));
    expect(rowsOf(table).map((row) => within(row).getAllByRole("cell")[0]!.textContent)).toEqual(["Lind, Anna", "Åkesson, Cy", "Ek, Bo"]);
    expect(screen.getByRole("columnheader", { name: /Elever/ })).toHaveAttribute("aria-sort", "descending");
    await userEvent.click(screen.getByRole("button", { name: /Elever/ }));
    expect(rowsOf(table)[0]!.textContent).toContain("Ek, Bo");
    expect(screen.getByRole("columnheader", { name: /Elever/ })).toHaveAttribute("aria-sort", "ascending");
  });

  it("has no column of tjänstgöringsgrad, and no HR-based density, for a reader without HR-läs", async () => {
    state.key = keyFigures({
      hrHidden: true,
      teachers: keyFigures().teachers!.map((one) => ({ ...one, employmentPercent: null })),
      school: { ...keyFigures().school, employmentFte: undefined, employmentFtePer100Pupils: undefined },
    });
    renderPage();
    const table = await screen.findByRole("table", { name: "Nyckeltal per lärare" });
    expect(within(table).queryByRole("columnheader", { name: /Tjänstgöringsgrad/ })).toBeNull();
    expect(screen.queryByText(/Efter tjänstgöringsgrad/)).toBeNull();
  });

  it("shows the huvudman's reader the school's figures and no teacher, and says so", async () => {
    state.key = keyFigures({ aggregateOnly: true, teachers: null });
    renderPage();
    expect(await screen.findByText(/Enskilda lärares siffror visas inte för huvudmannens läsare/)).toBeInTheDocument();
    expect(screen.getByText("Lärartäthet")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Nyckeltal per lärare" })).toBeNull();
  });

  it("says what could not be judged as notices, a missing riktmärke and unrecorded behörigheter among them", async () => {
    state.key = keyFigures({
      school: { ...keyFigures().school, fullTimeTeachingMinutesPerWeek: null, teachingFte: null, teachingFtePer100Pupils: null, qualifiedShare: null, qualificationsRecorded: false },
      notices: [{ code: "ANALYSIS_NO_FULL_TIME", params: {} }, { code: "ANALYSIS_QUALIFICATIONS_NOT_RECORDED", params: {} }],
    });
    renderPage();
    expect(await screen.findByText(/inget riktmärke för undervisning/)).toBeInTheDocument();
    expect(screen.getByText(/Inga behörigheter är registrerade/)).toBeInTheDocument();
    expect(screen.getByText("Riktmärke saknas")).toBeInTheDocument();
    expect(screen.getByText("Inga behörigheter registrerade")).toBeInTheDocument();
  });

  it("says a failed read as such and tries again on the button, and a rate limit with its own words", async () => {
    state.fail = { path: `${ROOT}/key-figures`, error: new ApiError(500, "boom") };
    renderPage();
    expect(await screen.findByText("Nyckeltalen kunde inte hämtas")).toBeInTheDocument();
    state.fail = null;
    await userEvent.click(screen.getByRole("button", { name: "Försök igen" }));
    expect(await screen.findByRole("table", { name: "Nyckeltal per lärare" })).toBeInTheDocument();
  });

  it("names a rate limit calmly", async () => {
    state.fail = { path: `${ROOT}/key-figures`, error: new ApiError(429, "slow") };
    renderPage();
    expect(await screen.findByText("Det går för snabbt")).toBeInTheDocument();
  });

  it("speaks English too", async () => {
    renderPage("en");
    expect(await screen.findByRole("table", { name: "Key figures per teacher" })).toBeInTheDocument();
    expect(screen.getByText("Teacher density")).toBeInTheDocument();
  });
});

describe("Analys och planering, kostnad per elev", () => {
  it("reads the cost basis on the tab alone, with the school's own rates said in a sentence", async () => {
    renderPage();
    await screen.findByRole("table", { name: "Nyckeltal per lärare" });
    await openTab("Kostnad per elev");
    const table = await screen.findByRole("table", { name: "Kostnadsunderlag per skoldel och årskurs" });
    expect(paths().filter((path) => path.includes("cost-basis"))).toEqual([`${ROOT}/cost-basis?academicYearId=y1`]);
    expect(screen.getByText(/Behörig lärare 420 kr, Vikarie 310 kr/)).toBeInTheDocument();
    expect(screen.getByText(/Vikariernas hållna pass är räknade från/)).toBeInTheDocument();
    const names = rowsOf(table).map((row) => within(row).getAllByRole("cell")[0]!.textContent);
    // A skoldel's row says its konto and årskurser beside its name.
    expect(names).toEqual(["Högstadietkonto 4030, årskurs 7–9", "Årskurs 7", "Årskurs 8", "Hela skolan"]);
  });

  it("says an unknown cost as unknown, with the reason, and never as a zero", async () => {
    renderPage();
    await openTab("Kostnad per elev");
    const table = await screen.findByRole("table", { name: "Kostnadsunderlag per skoldel och årskurs" });
    const eight = rowsOf(table).find((row) => within(row).getAllByRole("cell")[0]!.textContent === "Årskurs 8")!;
    const cells = within(eight).getAllByRole("cell");
    expect(cells[6]!.textContent).toBe("Okänd");
    expect(cells[6]!.querySelector("[title]")?.getAttribute("title")).toMatch(/ingen timkostnad/);
    expect(cells[7]!.textContent).toBe("–");
    expect(within(rowsOf(table)[1]!).getAllByRole("cell")[6]!.textContent).toMatch(/520/);
  });

  it("hands over a CSV of skoldelar and kronor, named after the läsår, that names nobody", async () => {
    renderPage();
    await openTab("Kostnad per elev");
    await screen.findByRole("table", { name: "Kostnadsunderlag per skoldel och årskurs" });
    await userEvent.click(screen.getByRole("button", { name: "Ladda ner CSV" }));
    expect(files.downloadCsv).toHaveBeenCalledTimes(1);
    const [name, content] = files.downloadCsv.mock.calls[0] as [string, string];
    expect(name).toBe("kostnad-per-elev-2026-27.csv");
    expect(content).toContain("Högstadiet;4030;7;");
    expect(content).not.toMatch(/Lind|Ek, Bo/);
  });

  it("tells a reader who is not given the cost basis so, calmly", async () => {
    state.fail = { path: `${ROOT}/cost-basis`, error: new ApiError(403, "no", "ANALYSIS_COST_NOT_YOURS") };
    renderPage();
    await openTab("Kostnad per elev");
    expect(await screen.findByText("Kostnaden är skolans ekonomi")).toBeInTheDocument();
    expect(screen.queryByText("Kostnadsunderlaget kunde inte hämtas")).toBeNull();
  });

  it("says the huvudman's reader reads sums, and a failed read as such", async () => {
    state.cost = costBasis({ aggregateOnly: true, rates: [], notices: [{ code: "ANALYSIS_RATE_MISSING", params: { category: "SUBSTITUTE" } }] });
    renderPage();
    await openTab("Kostnad per elev");
    expect(await screen.findByText(/som summor per skoldel och årskurs/)).toBeInTheDocument();
    expect(screen.getByText(/ingen timkostnad är angiven än/)).toBeInTheDocument();
    expect(screen.getByText(/Skolan har ingen timkostnad för Vikarie\. Kostnaden för de timmarna är okänd, inte noll\./)).toBeInTheDocument();
  });

  it("says a failed read as such, with a button to try again", async () => {
    state.fail = { path: `${ROOT}/cost-basis`, error: new ApiError(500, "boom") };
    renderPage();
    await openTab("Kostnad per elev");
    expect(await screen.findByText("Kostnadsunderlaget kunde inte hämtas")).toBeInTheDocument();
    state.fail = null;
    await userEvent.click(screen.getByRole("button", { name: "Försök igen" }));
    expect(await screen.findByRole("table", { name: "Kostnadsunderlag per skoldel och årskurs" })).toBeInTheDocument();
  });
});

describe("Analys och planering, löneunderlag", () => {
  it("asks nothing until it is given a period, and then asks for exactly that", async () => {
    renderPage();
    await openTab("Löneunderlag");
    expect(await screen.findByText("Välj en period")).toBeInTheDocument();
    expect(paths().filter((path) => path.includes("payroll"))).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Visa underlag" }));
    const table = await screen.findByRole("table", { name: "Löneunderlag per person och skoldel" });
    const read = paths().filter((path) => path.includes("payroll-basis"));
    expect(read).toHaveLength(1);
    expect(read[0]).toMatch(/^\/api\/v1\/analysis\/payroll-basis\?academicYearId=y1&from=\d{4}-\d{2}-01&to=\d{4}-\d{2}-\d{2}$/);
    expect(rowsOf(table).map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent))).toEqual([
      ["Lind, Anna", "Högstadiet (7–9)", "4030", "20,00", "2,00", "0,00", "22,00"],
      ["Vikarie, Veravikariepool", "Ej fördelat", "–", "0,00", "0,00", "1,50", "1,50"],
    ]);
  });

  it("hands over the file the gateway built, in the format asked for, and says it is downloaded", async () => {
    const file: PayrollFile = { filename: "loneunderlag-2026-10-01-2026-10-31.csv", contentType: "text/csv; charset=windows-1252", contentBase64: "QUJD", notices: [], protectedInFile: 0 };
    api.post.mockResolvedValue(file);
    renderPage();
    await openTab("Löneunderlag");
    await userEvent.click(screen.getByRole("button", { name: "Visa underlag" }));
    await screen.findByRole("table", { name: "Löneunderlag per person och skoldel" });
    await userEvent.click(screen.getByRole("button", { name: "CSV för Excel" }));
    await waitFor(() => expect(files.saveBase64).toHaveBeenCalledWith(file.filename, file.contentType, file.contentBase64));
    expect(api.post).toHaveBeenCalledWith(`${ROOT}/payroll-basis/export`, expect.objectContaining({ academicYearId: "y1", format: "CSV" }));
    expect(toast.success).toHaveBeenCalledWith("loneunderlag-2026-10-01-2026-10-31.csv är hämtad.");
    await userEvent.click(screen.getByRole("button", { name: "Excel" }));
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith(`${ROOT}/payroll-basis/export`, expect.objectContaining({ format: "XLSX" })));
  });

  it("says a file that could not be built, with the gateway's own words", async () => {
    api.post.mockRejectedValue(new Error("Filen kunde inte byggas"));
    renderPage();
    await openTab("Löneunderlag");
    await userEvent.click(screen.getByRole("button", { name: "Visa underlag" }));
    await screen.findByRole("table", { name: "Löneunderlag per person och skoldel" });
    await userEvent.click(screen.getByRole("button", { name: "CSV för Excel" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Filen kunde inte byggas"));
    expect(files.saveBase64).not.toHaveBeenCalled();
  });

  it("offers no file for a period with no time in it, and says so", async () => {
    state.pay = payroll({ people: [], lines: [] });
    renderPage();
    await openTab("Löneunderlag");
    await userEvent.click(screen.getByRole("button", { name: "Visa underlag" }));
    expect(await screen.findByText("Ingen tid i perioden")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "CSV för Excel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Excel" })).toBeDisabled();
  });

  it("tells a reader of no HR data that the payroll is HR data, and a protected identity that it is in the file", async () => {
    state.fail = { path: `${ROOT}/payroll-basis`, error: new ApiError(403, "no", "HR_NOT_YOURS") };
    renderPage();
    await openTab("Löneunderlag");
    await userEvent.click(screen.getByRole("button", { name: "Visa underlag" }));
    expect(await screen.findByText("Löneunderlaget är HR-uppgifter")).toBeInTheDocument();
  });

  it("says the notices of the period: a protected identity in the file, the cut to the läsår", async () => {
    state.pay = payroll({
      protectedInAnswer: 1,
      notices: [
        { code: "ANALYSIS_PROTECTED_IN_FILE", params: { people: 1 } },
        { code: "ANALYSIS_PERIOD_CLAMPED", params: { from: "2026-08-17", to: "2026-08-31" } },
      ],
    });
    renderPage();
    await openTab("Löneunderlag");
    await userEvent.click(screen.getByRole("button", { name: "Visa underlag" }));
    expect(await screen.findByText(/1 personer med skyddad identitet finns med i underlaget/)).toBeInTheDocument();
    expect(screen.getByText(/Perioden är beskuren till läsåret: 17 aug\. 2026 – 31 aug\. 2026\./)).toBeInTheDocument();
  });

  it("refuses a period that ends before it begins", async () => {
    renderPage();
    await openTab("Löneunderlag");
    const [from, to] = screen.getAllByRole("textbox");
    await userEvent.clear(from!);
    await userEvent.type(from!, "2026-10-31");
    await userEvent.clear(to!);
    await userEvent.type(to!, "2026-10-01");
    expect(screen.getByRole("button", { name: "Visa underlag" })).toBeDisabled();
  });
});

describe("Analys och planering, skoldelar och satser", () => {
  it("lists the skoldelar and the rates, and reads nothing else of the page", async () => {
    renderPage();
    await openTab("Skoldelar och satser");
    const table = await screen.findByRole("table", { name: "Skolans skoldelar" });
    expect(rowsOf(table).map((row) => within(row).getAllByRole("cell").slice(0, 3).map((cell) => cell.textContent))).toEqual([
      ["Lågstadiet", "4010", "F–3"],
      ["Högstadiet", "4030", "7–9"],
    ]);
    expect(await screen.findByDisplayValue("420,50")).toBeInTheDocument();
    expect(paths().sort()).toEqual([`${ROOT}/key-figures?academicYearId=y1`, `${ROOT}/cost-rates`, `${ROOT}/school-parts`].sort());
  });

  it("makes a skoldel and says it is saved, and says a refusal with the gateway's own words", async () => {
    renderPage();
    await openTab("Skoldelar och satser");
    await screen.findByRole("table", { name: "Skolans skoldelar" });
    await userEvent.type(screen.getByLabelText("Namn"), "Mellanstadiet");
    await userEvent.type(screen.getByLabelText("Konto"), "4020");
    await userEvent.selectOptions(screen.getByLabelText("Första årskurs"), "4");
    await userEvent.selectOptions(screen.getByLabelText("Sista årskurs"), "6");
    await userEvent.click(screen.getByRole("button", { name: "Lägg till" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${ROOT}/school-parts`, { name: "Mellanstadiet", account: "4020", gradeFrom: 4, gradeTo: 6 }));
    expect(toast.success).toHaveBeenCalledWith("Skoldelen är sparad.");

    // A saved skoldel empties the form; a second one that the gateway refuses is typed again.
    api.post.mockRejectedValue(new ApiError(409, 'Årskurserna ligger redan i skoldelen "Lågstadiet" (F–3).', "SCHOOL_PART_OVERLAPS"));
    await userEvent.type(screen.getByLabelText("Namn"), "Tre");
    await userEvent.type(screen.getByLabelText("Konto"), "4033");
    await userEvent.click(screen.getByRole("button", { name: "Lägg till" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Årskurserna ligger redan i skoldelen "Lågstadiet" (F–3).'));
  });

  it("changes a skoldel from its row and removes one after a question", async () => {
    renderPage();
    await openTab("Skoldelar och satser");
    const table = await screen.findByRole("table", { name: "Skolans skoldelar" });
    await userEvent.click(within(rowsOf(table)[0]!).getByRole("button", { name: "Redigera" }));
    expect(screen.getByLabelText("Namn")).toHaveValue("Lågstadiet");
    await userEvent.clear(screen.getByLabelText("Konto"));
    await userEvent.type(screen.getByLabelText("Konto"), "4011");
    await userEvent.click(within(screen.getByRole("group", { name: "Ändra skoldelen" })).getByRole("button", { name: "Spara" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith(`${ROOT}/school-parts/low`, { name: "Lågstadiet", account: "4011", gradeFrom: 0, gradeTo: 3 }));

    await userEvent.click(within(rowsOf(table)[1]!).getByRole("button", { name: "Ta bort skoldelen Högstadiet" }));
    expect(await screen.findByText("Ta bort skoldelen Högstadiet?")).toBeInTheDocument();
    expect(api.delete).not.toHaveBeenCalled();
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Ta bort" }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith(`${ROOT}/school-parts/high`));
  });

  it("states, changes and removes a rate, and refuses what is not kronor", async () => {
    renderPage();
    await openTab("Skoldelar och satser");
    await screen.findByDisplayValue("420,50");
    const vikarie = screen.getByLabelText("Vikarie");
    await userEvent.type(vikarie, "310,5");
    await userEvent.click(within(vikarie.closest("div")!.parentElement!).getByRole("button", { name: "Spara" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith(`${ROOT}/cost-rates/SUBSTITUTE`, { hourlyCost: 310.5 }));
    expect(toast.success).toHaveBeenCalledWith("Timkostnaden för Vikarie är sparad.");

    await userEvent.clear(vikarie);
    await userEvent.type(vikarie, "abc");
    await userEvent.click(within(vikarie.closest("div")!.parentElement!).getByRole("button", { name: "Spara" }));
    expect(toast.error).toHaveBeenCalledWith("Ange kronor per timme, 0 till 100 000, högst två decimaler.");

    const teacherRow = screen.getByLabelText("Behörig lärare").closest("div")!.parentElement!;
    await userEvent.click(within(teacherRow).getByRole("button", { name: "Ta bort" }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith(`${ROOT}/cost-rates/TEACHER`));
    expect(within(vikarie.closest("div")!.parentElement!).getByRole("button", { name: "Ta bort" })).toBeDisabled();
  });

  it("lets anyone but a decider read and change nothing, and says who decides", async () => {
    profile.adminProfile = "EXPEDITION";
    renderPage();
    await openTab("Skoldelar och satser");
    const table = await screen.findByRole("table", { name: "Skolans skoldelar" });
    expect(within(rowsOf(table)[0]!).getByRole("button", { name: "Redigera" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Lägg till" })).toBeDisabled();
    expect(screen.getByLabelText("Namn")).toBeDisabled();
    expect(screen.getAllByText(/ändras av rektor och fullständig administratör/).length).toBeGreaterThan(0);
  });

  it("changes nothing for the läsare either", async () => {
    profile.readOnly = true;
    renderPage();
    await openTab("Skoldelar och satser");
    await screen.findByRole("table", { name: "Skolans skoldelar" });
    expect(screen.getByRole("button", { name: "Lägg till" })).toBeDisabled();
  });

  it("says a failed read of either as such", async () => {
    state.fail = { path: `${ROOT}/school-parts`, error: new ApiError(500, "boom") };
    renderPage();
    await openTab("Skoldelar och satser");
    expect(await screen.findByText("Skoldelarna kunde inte hämtas")).toBeInTheDocument();
  });
});
