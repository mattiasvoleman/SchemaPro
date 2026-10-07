import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { downloadTemplate } from "@/lib/csv";
import { CsvImportDialog, type CsvImportDialogProps } from "./csv-import-dialog";

// Environment shims for Radix in jsdom — not behaviour under test.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// ---------------------------------------------------------------------------
// Module mocks. The real parseCsv/map*Rows run (they ARE the behaviour the
// preview shows); only the download side effect and the network are stubbed.
// ---------------------------------------------------------------------------

vi.mock("@/lib/csv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/csv")>();
  return { ...actual, downloadTemplate: vi.fn() };
});

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockPost = (api as unknown as { post: Mock }).post;
const mockDownloadTemplate = downloadTemplate as unknown as Mock;

// useAcademicYears reads "AcademicYears" through the Supabase browser client.
const supabaseState = vi.hoisted(() => ({ years: [] as unknown[] }));

vi.mock("@/utils/supabase/client", () => ({
  createClient: () => ({
    from: () => {
      const builder: Record<string, unknown> = {};
      // `range` included because full-list reads are paged — see selectAll.
      for (const method of ["select", "order", "eq", "limit", "range"]) {
        builder[method] = () => builder;
      }
      builder.then = (
        onFulfilled: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) =>
        Promise.resolve({ data: supabaseState.years, error: null }).then(
          onFulfilled,
          onRejected,
        );
      return builder;
    },
  }),
}));

// Key echo that surfaces interpolated values, so counts and report numbers can
// be asserted from the rendered text.
vi.mock("next-intl", () => ({
  // DateField reads the active locale for its month and weekday names.
  useLocale: () => "sv",
  useTranslations: (namespace: string) =>
    Object.assign(
      (key: string, values?: Record<string, unknown>) =>
        values
          ? `${key}(${Object.entries(values)
              .map(([name, value]) => `${name}=${String(value)}`)
              .join("|")})`
          : key,
      // The engine catalogue knows its codes; nothing else is asked.
      { has: () => namespace === "engineMessages" },
    ),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACTIVE_YEAR = {
  id: "y-1",
  name: "25/26",
  startDate: "2025-08-15",
  endDate: "2026-06-12",
  isActive: true,
};

// Swedish Excel reality: BOM + semicolons + CRLF, exactly what parseCsv gets.
const BOM = "﻿";
const STUDENTS_CSV =
  BOM +
  "fornamn;efternamn;epost;klass\r\n" +
  "Alma;Berg;alma@example.com;7A\r\n" +
  "Nils;Ek;nils@example.com;7B\r\n";
const TEACHERS_CSV = BOM + "fornamn;efternamn;epost\r\nKarin;Ek;karin.ek@example.com\r\n";
// The timplan template's own columns, in its own order — including the pupils'
// own minutes on either side of the lesson, which every exported file carries.
const REQUIREMENTS_CSV =
  BOM +
  "grupp;amne;lektioner_per_vecka;minuter_per_lektion;minutesBefore;minutesAfter;" +
  "larare;medlarare;veckor;fran;till\r\n" +
  "7A;IDH;2;60;10;20;karin.ek@example.com;;udda;;\r\n";

function renderDialog(props: Partial<CsvImportDialogProps> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <CsvImportDialog
        kinds={["students", "teachers"]}
        open
        onOpenChange={onOpenChange}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { queryClient, invalidateSpy, onOpenChange };
}

async function uploadCsv(user: UserEvent, content: string, name = "import.csv") {
  const file = new File([content], name, { type: "text/csv" });
  await user.upload(screen.getByLabelText("chooseFile"), file);
}

async function switchKind(user: UserEvent, kind: string) {
  await user.click(screen.getByRole("combobox", { name: "kindLabel" }));
  await user.click(screen.getByRole("option", { name: `kinds.${kind}` }));
}

const importButton = () => screen.getByRole("button", { name: "import" });

beforeEach(() => {
  vi.clearAllMocks();
  supabaseState.years = [ACTIVE_YEAR];
  mockPost.mockResolvedValue({ created: 0, skipped: 0, errors: [] });
});

// ---------------------------------------------------------------------------
// Kind selection + template download
// ---------------------------------------------------------------------------

describe("CsvImportDialog kinds and template", () => {
  it("preselects the first kind and downloads its template", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "downloadTemplate" }));
    expect(mockDownloadTemplate).toHaveBeenCalledWith("students");
  });

  it("offers exactly the kinds the page passed and downloads for the switched kind", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("combobox", { name: "kindLabel" }));
    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["kinds.students", "kinds.teachers"]);

    await user.click(screen.getByRole("option", { name: "kinds.teachers" }));
    await user.click(screen.getByRole("button", { name: "downloadTemplate" }));
    expect(mockDownloadTemplate).toHaveBeenLastCalledWith("teachers");
  });

  it("clears a parsed file when the kind changes", async () => {
    const user = userEvent.setup();
    renderDialog();

    await uploadCsv(user, STUDENTS_CSV);
    await screen.findByText("rowsReady(count=2)");

    await switchKind(user, "teachers");
    expect(screen.queryByText(/rowsReady/)).not.toBeInTheDocument();
    expect(importButton()).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Parse preview
// ---------------------------------------------------------------------------

describe("CsvImportDialog preview", () => {
  it("shows the row count and the first rows in a table after choosing a file", async () => {
    const user = userEvent.setup();
    renderDialog();

    await uploadCsv(user, STUDENTS_CSV);

    await screen.findByText("rowsReady(count=2)");
    // Header row from the file, then the data cells.
    for (const header of ["fornamn", "efternamn", "epost", "klass"]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeInTheDocument();
    }
    expect(screen.getByRole("cell", { name: "Alma" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "nils@example.com" })).toBeInTheDocument();
  });

  it("caps the preview at five rows while counting all of them", async () => {
    const user = userEvent.setup();
    renderDialog();
    const rows = Array.from(
      { length: 7 },
      (_, i) => `Elev${i};Berg;elev${i}@example.com;7A`,
    ).join("\r\n");

    await uploadCsv(user, `${BOM}fornamn;efternamn;epost;klass\r\n${rows}\r\n`);

    await screen.findByText("rowsReady(count=7)");
    expect(screen.getByRole("cell", { name: "Elev4" })).toBeInTheDocument();
    expect(screen.queryByRole("cell", { name: "Elev5" })).not.toBeInTheDocument();
  });

  it("lists mapping errors with their row numbers and disables import", async () => {
    const user = userEvent.setup();
    renderDialog();

    await uploadCsv(
      user,
      BOM +
        "fornamn;efternamn;epost;klass\r\n" +
        "Alma;;alma@example.com;7A\r\n" +
        "Nils;Ek;nils@example.com;7B\r\n",
    );

    await screen.findByText("mappingErrors");
    expect(
      screen.getByText('Rad 1: kolumnen "efternamn" är tom.'),
    ).toBeInTheDocument();
    // The valid row still counts, but errors block the import.
    expect(screen.getByText("rowsReady(count=1)")).toBeInTheDocument();
    expect(importButton()).toBeDisabled();
  });

  it("reports missing columns as a file-level error", async () => {
    const user = userEvent.setup();
    renderDialog();

    await uploadCsv(user, `${BOM}namn;epost\r\nAlma;alma@example.com\r\n`);

    await screen.findByText(/Kolumner saknas/);
    expect(importButton()).toBeDisabled();
  });

  it("a mojibake header is rejected with a clear missing-column message (by design)", async () => {
    // web/lib/csv.ts:20-24 claims normalizeHeader makes a wrong-encoding
    // "FÃ¶rnamn" resolve like "Förnamn". It does not: NFD of "Ã" is A + a
    // combining tilde, so the header normalizes to "farnamn" — not "fornamn" —
    // and the file fails with "Kolumner saknas". This test documents CURRENT
    // behaviour; fixing it means either amending the doc comment or adding the
    // mojibake spellings ("farnamn", "epostadress" variants…) to the aliases.
    const user = userEvent.setup();
    renderDialog();

    await uploadCsv(
      user,
      "FÃ¶rnamn;efternamn;epost;klass\r\nAlma;Berg;alma@example.com;7A\r\n",
    );

    await screen.findByText(/Kolumner saknas: fornamn/);
    expect(importButton()).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Button disabled states
// ---------------------------------------------------------------------------

describe("CsvImportDialog disabled states", () => {
  it("disables import before any file is chosen", () => {
    renderDialog();
    expect(importButton()).toBeDisabled();
  });

  it("disables import for a header-only file (zero rows, zero errors)", async () => {
    const user = userEvent.setup();
    renderDialog();

    await uploadCsv(user, `${BOM}fornamn;efternamn;epost;klass\r\n`);

    await screen.findByText("rowsReady(count=0)");
    expect(importButton()).toBeDisabled();
  });

  it("shows the hint and blocks a students import when no year is active", async () => {
    supabaseState.years = [{ ...ACTIVE_YEAR, isActive: false }];
    const user = userEvent.setup();
    renderDialog();

    await uploadCsv(user, STUDENTS_CSV);

    await screen.findByText("rowsReady(count=2)");
    expect(await screen.findByText("noActiveYear")).toBeInTheDocument();
    expect(importButton()).toBeDisabled();
  });

  it("lets teachers import without any academic year", async () => {
    supabaseState.years = [];
    const user = userEvent.setup();
    renderDialog();

    await switchKind(user, "teachers");
    await uploadCsv(user, TEACHERS_CSV);

    await screen.findByText("rowsReady(count=1)");
    expect(screen.queryByText("noActiveYear")).not.toBeInTheDocument();
    await waitFor(() => expect(importButton()).toBeEnabled());
  });
});

// ---------------------------------------------------------------------------
// Import + result
// ---------------------------------------------------------------------------

describe("CsvImportDialog import", () => {
  it("posts students with the active year and the mapped rows", async () => {
    mockPost.mockResolvedValue({ created: 2, skipped: 0, errors: [] });
    const user = userEvent.setup();
    renderDialog();

    await uploadCsv(user, STUDENTS_CSV);
    await screen.findByText("rowsReady(count=2)");
    await waitFor(() => expect(importButton()).toBeEnabled());
    await user.click(importButton());

    await screen.findByText("resultSummary(created=2|skipped=0)");
    expect(mockPost).toHaveBeenCalledWith("/api/v1/import/students", {
      academicYearId: "y-1",
      rows: [
        { firstName: "Alma", lastName: "Berg", email: "alma@example.com", className: "7A" },
        { firstName: "Nils", lastName: "Ek", email: "nils@example.com", className: "7B" },
      ],
    });
  });

  it("imports room types with no year in the body, even with a year active", async () => {
    // The API validates with forbidNonWhitelisted, so an academicYearId here
    // would be a 400 — not an ignored extra field. Room types are school-wide.
    mockPost.mockResolvedValue({ created: 3, skipped: 0, errors: [] });
    const user = userEvent.setup();
    renderDialog({ kinds: ["roomTypes"] });

    await uploadCsv(user, BOM + "namn\r\nHemkunskapssal\r\nTextilslöjd\r\n");
    await screen.findByText("rowsReady(count=2)");
    await waitFor(() => expect(importButton()).toBeEnabled());
    await user.click(importButton());

    await screen.findByText("resultSummary(created=3|skipped=0)");
    expect(supabaseState.years).toEqual([ACTIVE_YEAR]); // a year IS active
    expect(mockPost).toHaveBeenCalledWith("/api/v1/import/room-types", {
      rows: [{ name: "Hemkunskapssal" }, { name: "Textilslöjd" }],
    });
  });

  it("offers room types even when the school has no academic year yet", async () => {
    supabaseState.years = [];
    const user = userEvent.setup();
    renderDialog({ kinds: ["roomTypes"] });

    await uploadCsv(user, BOM + "namn\r\nBildsal\r\n");

    await screen.findByText("rowsReady(count=1)");
    expect(screen.queryByText("noActiveYear")).not.toBeInTheDocument();
    await waitFor(() => expect(importButton()).toBeEnabled());
  });

  it("posts teachers without an academicYearId in the body", async () => {
    mockPost.mockResolvedValue({ created: 1, skipped: 0, errors: [] });
    const user = userEvent.setup();
    renderDialog();

    await switchKind(user, "teachers");
    await uploadCsv(user, TEACHERS_CSV);
    await screen.findByText("rowsReady(count=1)");
    await user.click(importButton());

    await screen.findByText("resultSummary(created=1|skipped=0)");
    expect(mockPost).toHaveBeenCalledWith("/api/v1/import/teachers", {
      rows: [{ firstName: "Karin", lastName: "Ek", email: "karin.ek@example.com" }],
    });
  });

  it("posts classes to /import/groups with parsed grade levels", async () => {
    mockPost.mockResolvedValue({ created: 2, skipped: 0, errors: [] });
    const user = userEvent.setup();
    renderDialog({ kinds: ["classes", "teachingGroups"] });

    await uploadCsv(user, `${BOM}namn;arskurs\r\n7A;7\r\n8B;\r\n`);
    await screen.findByText("rowsReady(count=2)");
    await waitFor(() => expect(importButton()).toBeEnabled());
    await user.click(importButton());

    await screen.findByText("resultSummary(created=2|skipped=0)");
    expect(mockPost).toHaveBeenCalledWith("/api/v1/import/groups", {
      academicYearId: "y-1",
      rows: [{ name: "7A", gradeLevel: 7 }, { name: "8B" }],
    });
  });

  it("posts teaching-group memberships to /import/group-members", async () => {
    mockPost.mockResolvedValue({ created: 1, skipped: 0, errors: [] });
    const user = userEvent.setup();
    renderDialog({ kinds: ["classes", "teachingGroups"] });

    await switchKind(user, "teachingGroups");
    await uploadCsv(user, `${BOM}grupp;epost\r\nMa71;alma@example.com\r\n`);
    await screen.findByText("rowsReady(count=1)");
    await waitFor(() => expect(importButton()).toBeEnabled());
    await user.click(importButton());

    await screen.findByText("resultSummary(created=1|skipped=0)");
    expect(mockPost).toHaveBeenCalledWith("/api/v1/import/group-members", {
      academicYearId: "y-1",
      rows: [{ groupName: "Ma71", email: "alma@example.com" }],
    });
  });

  it("posts uppdrag to /import/teacher-duties with the läsår and the file's columns", async () => {
    supabaseState.years = [ACTIVE_YEAR];
    mockPost.mockResolvedValue({ created: 1, skipped: 0, updated: 0, errors: [] });
    const user = userEvent.setup();
    const { invalidateSpy } = renderDialog({ kinds: ["teacherQualifications", "teacherDuties"] });

    await switchKind(user, "teacherDuties");
    await uploadCsv(
      user,
      `${BOM}larare_epost;typ;benamning;minuter_per_vecka;grupp\r\nkarin.ek@example.com;mentorskap;Mentor 7B;90;7B\r\n`,
      "uppdrag.csv",
    );
    await screen.findByText("rowsReady(count=1)");
    await waitFor(() => expect(importButton()).toBeEnabled());
    await user.click(importButton());

    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    expect(mockPost).toHaveBeenCalledWith("/api/v1/import/teacher-duties", {
      academicYearId: "y-1",
      columns: ["teacherEmail", "kind", "label", "minutesPerWeek", "groupName"],
      rows: [
        {
          teacherEmail: "karin.ek@example.com",
          kind: "MENTORSKAP",
          label: "Mentor 7B",
          minutesPerWeek: 90,
          groupName: "7B",
        },
      ],
    });
    // The drawer's and the people page's uppdrag cards refetch.
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["teacherDuties"] }),
    );
  });

  it("renders the report's per-row errors", async () => {
    mockPost.mockResolvedValue({
      created: 1,
      skipped: 1,
      errors: [{ row: 2, message: "E-postadressen används redan" }],
    });
    const user = userEvent.setup();
    renderDialog();

    await uploadCsv(user, STUDENTS_CSV);
    await screen.findByText("rowsReady(count=2)");
    await waitFor(() => expect(importButton()).toBeEnabled());
    await user.click(importButton());

    await screen.findByText("resultSummary(created=1|skipped=1)");
    expect(screen.getByText("rowErrors")).toBeInTheDocument();
    expect(
      screen.getByText("rowError(row=2|message=E-postadressen används redan)"),
    ).toBeInTheDocument();
  });

  /*
   * Which läsår the rows land in.
   *
   * The dialog used to resolve that itself, always to the year carrying
   * isActive. A page with a year picker then disagreed with its own import: an
   * admin planning next autumn selected 2027/2028, saw and exported that year,
   * and the import wrote into the year still flagged active — with no year
   * named anywhere in the flow to give it away.
   */
  const NEXT_YEAR = {
    id: "y-2",
    name: "26/27",
    startDate: "2026-08-17",
    endDate: "2027-06-11",
    isActive: false,
  };

  it("tells the API which columns the file had, so the rest are left alone", async () => {
    /*
     * The rows cannot say it themselves. They omit a key whose column is
     * absent, but the API's ValidationPipe runs class-transformer, which
     * materialises every declared property — so by the time the service reads
     * the row the omission is gone, and "the file had no larare column" looks
     * exactly like "the school emptied the cell". One means leave it, the other
     * means clear it, and the import overwrites.
     */
    mockPost.mockResolvedValue({ created: 1, skipped: 0, updated: 0, errors: [] });
    const user = userEvent.setup();
    renderDialog({ kinds: ["requirements"] });

    await uploadCsv(
      user,
      BOM + "grupp;amne;lektioner_per_vecka;minuter_per_lektion\r\n7A;MA;3;60\r\n",
      "timplansposter.csv",
    );
    await waitFor(() => expect(importButton()).toBeEnabled());
    await user.click(importButton());

    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    const [, body] = mockPost.mock.calls[0] as [string, { columns: string[] }];
    expect(body.columns).toEqual(["groupName", "subject", "lessonsPerWeek", "minutesPerLesson"]);
  });

  it("sends no columns key for a kind that only ever creates", async () => {
    // Six of the seven kinds cannot overwrite anything, so there is nothing for
    // a column set to protect — and the API validates with forbidNonWhitelisted,
    // which would answer an unexpected key with a 400 rather than ignoring it.
    mockPost.mockResolvedValue({ created: 2, skipped: 0, errors: [] });
    const user = userEvent.setup();
    renderDialog();

    await uploadCsv(user, STUDENTS_CSV);
    await waitFor(() => expect(importButton()).toBeEnabled());
    await user.click(importButton());

    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    const [, body] = mockPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(body).not.toHaveProperty("columns");
  });

  it("imports into the läsår the page is showing, not the active one", async () => {
    supabaseState.years = [ACTIVE_YEAR, NEXT_YEAR];
    mockPost.mockResolvedValue({ created: 1, skipped: 0, updated: 0, errors: [] });
    const user = userEvent.setup();
    renderDialog({ kinds: ["requirements"], academicYearId: NEXT_YEAR.id });

    await uploadCsv(user, REQUIREMENTS_CSV, "timplansposter.csv");
    await waitFor(() => expect(importButton()).toBeEnabled());
    await user.click(importButton());

    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    const [, body] = mockPost.mock.calls[0] as [string, { academicYearId: string }];
    expect(body.academicYearId).toBe("y-2");
  });

  it("says which läsår it is importing into", async () => {
    supabaseState.years = [ACTIVE_YEAR, NEXT_YEAR];
    renderDialog({ kinds: ["requirements"], academicYearId: NEXT_YEAR.id });

    expect(await screen.findByText("importingIntoYear(year=26/27)")).toBeTruthy();
  });

  it("still falls back to the active year for a page without a picker", async () => {
    // The five other call sites pass no year and must keep working.
    supabaseState.years = [ACTIVE_YEAR, NEXT_YEAR];
    mockPost.mockResolvedValue({ created: 2, skipped: 0, errors: [] });
    const user = userEvent.setup();
    renderDialog();

    await uploadCsv(user, STUDENTS_CSV);
    await waitFor(() => expect(importButton()).toBeEnabled());
    await user.click(importButton());

    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    const [, body] = mockPost.mock.calls[0] as [string, { academicYearId: string }];
    expect(body.academicYearId).toBe("y-1");
  });

  it("posts the timplan to /import/requirements with the läsår from the dialog", async () => {
    // The year is the dialog's, never a column in the file: a läsår column
    // would let one upload scatter rows across years the admin is not looking
    // at. Same rule as teaching-group memberships.
    mockPost.mockResolvedValue({ created: 1, updated: 0, skipped: 0, errors: [] });
    const user = userEvent.setup();
    renderDialog({ kinds: ["requirements"] });

    await uploadCsv(user, REQUIREMENTS_CSV, "timplansposter.csv");
    await screen.findByText("rowsReady(count=1)");
    await waitFor(() => expect(importButton()).toBeEnabled());
    await user.click(importButton());

    await screen.findByText(/resultSummary/);
    expect(mockPost).toHaveBeenCalledWith("/api/v1/import/requirements", {
      academicYearId: "y-1",
      // Every column the header carried, so the server can leave the ones it
      // did not have exactly as they are.
      columns: [
        "groupName",
        "subject",
        "lessonsPerWeek",
        "minutesPerLesson",
        "minutesBefore",
        "minutesAfter",
        "teacherEmail",
        "coTeacherEmail",
        "recurrence",
        "startDate",
        "endDate",
      ],
      rows: [
        {
          groupName: "7A",
          subject: "IDH",
          lessonsPerWeek: 2,
          minutesPerLesson: 60,
          // The pupils' own minutes travel as numbers, not as the strings the
          // file holds — and the server must know the column was there at all,
          // which is what the two new names in `columns` say.
          minutesBefore: 10,
          minutesAfter: 20,
          teacherEmail: "karin.ek@example.com",
          coTeacherEmail: null,
          recurrence: "ODD_WEEKS",
          startDate: null,
          endDate: null,
        },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// The one kind that overwrites (IMPORT_UPDATES_ROWS)
//
// Everything here is driven off the DATA — a report that carries `updated`, a
// kind flagged as updating — rather than off the kind's name, so the six
// create-only kinds have to keep rendering exactly what they rendered before.
// The last test in this block is what pins that half.
// ---------------------------------------------------------------------------

describe("CsvImportDialog for an import that updates", () => {
  it("counts the rows it wrote over, separately from the ones it created", async () => {
    mockPost.mockResolvedValue({ created: 1, updated: 4, skipped: 2, errors: [] });
    const user = userEvent.setup();
    renderDialog({ kinds: ["requirements"] });

    await uploadCsv(user, REQUIREMENTS_CSV, "timplansposter.csv");
    await screen.findByText("rowsReady(count=1)");
    await waitFor(() => expect(importButton()).toBeEnabled());
    await user.click(importButton());

    expect(
      await screen.findByText("resultSummaryUpdated(created=1|updated=4|skipped=2)"),
    ).toBeInTheDocument();
  });

  it("still says so when it overwrote nothing this time", async () => {
    // `report.updated === undefined` and not falsiness. A zero here is an
    // import that COULD have overwritten and happened not to, which is a
    // different statement from an import that cannot overwrite at all — and
    // truthiness collapses the two, silently dropping the counter from the
    // sentence exactly when a school re-uploads an unchanged file.
    mockPost.mockResolvedValue({ created: 3, updated: 0, skipped: 0, errors: [] });
    const user = userEvent.setup();
    renderDialog({ kinds: ["requirements"] });

    await uploadCsv(user, REQUIREMENTS_CSV, "timplansposter.csv");
    await screen.findByText("rowsReady(count=1)");
    await waitFor(() => expect(importButton()).toBeEnabled());
    await user.click(importButton());

    expect(
      await screen.findByText("resultSummaryUpdated(created=3|updated=0|skipped=0)"),
    ).toBeInTheDocument();
  });

  it("lists rows saved with a staffing warning apart from the errors", async () => {
    // WARN saves the row; it must not read as a failure the admin has to fix
    // in the file. A REFUSED row is in errors, and that stays red.
    mockPost.mockResolvedValue({
      created: 1,
      updated: 0,
      skipped: 0,
      errors: [{ row: 1, message: "Läraren saknar behörighet i Matematik för åk 7–9." }],
      warnings: [
        {
          row: 1,
          code: "STAFF_TEACHER_OVER_TARGET",
          params: { role: "TEACHER", minutes: 1200, target: 1000, limit: 1100, tolerance: 10 },
          message: "Läraren hamnar på 1200 min/v.",
        },
      ],
    });
    const user = userEvent.setup();
    renderDialog({ kinds: ["requirements"] });

    await uploadCsv(user, REQUIREMENTS_CSV, "timplansposter.csv");
    await screen.findByText("rowsReady(count=1)");
    await waitFor(() => expect(importButton()).toBeEnabled());
    await user.click(importButton());

    expect(await screen.findByText("rowWarnings")).toBeInTheDocument();
    // From the catalogue, with the params — an English reader gets English,
    // not the gateway's Swedish `message`.
    const warned = screen.getByText(
      "rowError(row=1|message=STAFF_TEACHER_OVER_TARGET(role=TEACHER|minutes=1200|target=1000|limit=1100|tolerance=10))",
    );
    expect(warned).not.toHaveClass("text-destructive");
    expect(warned.closest("ul")).not.toHaveClass("text-destructive");
    expect(
      screen.getByText(
        "rowError(row=1|message=Läraren saknar behörighet i Matematik för åk 7–9.)",
      ).closest("ul"),
    ).toHaveClass("text-destructive");
  });

  it("says nothing about warnings when the report carries none", async () => {
    mockPost.mockResolvedValue({ created: 1, updated: 0, skipped: 0, errors: [], warnings: [] });
    const user = userEvent.setup();
    renderDialog({ kinds: ["requirements"] });

    await uploadCsv(user, REQUIREMENTS_CSV, "timplansposter.csv");
    await screen.findByText("rowsReady(count=1)");
    await waitFor(() => expect(importButton()).toBeEnabled());
    await user.click(importButton());

    await screen.findByText(/resultSummaryUpdated/);
    expect(screen.queryByText("rowWarnings")).not.toBeInTheDocument();
  });

  it("warns that a row deleted from the file is not deleted from the timplan", async () => {

    // The misreading this sentence exists to prevent: an import that updates
    // looks like the file REPLACING what was there, so an admin who uploads
    // only årskurs 7 concludes the rest is gone. It is not, and there is no
    // undo to reach for either way — which is why it has to be said before the
    // file is chosen and again on the result.
    const user = userEvent.setup();
    renderDialog({ kinds: ["requirements"] });

    expect(screen.getByText("updatesNotDeletes")).toBeInTheDocument();

    mockPost.mockResolvedValue({ created: 1, updated: 0, skipped: 0, errors: [] });
    await uploadCsv(user, REQUIREMENTS_CSV, "timplansposter.csv");
    await screen.findByText("rowsReady(count=1)");
    await waitFor(() => expect(importButton()).toBeEnabled());
    await user.click(importButton());

    await screen.findByText(/resultSummaryUpdated/);
    expect(screen.getByText("updatesNotDeletes")).toBeInTheDocument();
  });

  it("leaves the create-only kinds exactly as they were", async () => {
    // The whole reason `updated` is optional. A student import neither
    // overwrites nor warns, and a counter reading "0 uppdaterade" there would
    // be a sentence about something that cannot happen.
    mockPost.mockResolvedValue({ created: 2, skipped: 0, errors: [] });
    const user = userEvent.setup();
    renderDialog();

    expect(screen.queryByText("updatesNotDeletes")).not.toBeInTheDocument();

    await uploadCsv(user, STUDENTS_CSV);
    await screen.findByText("rowsReady(count=2)");
    await waitFor(() => expect(importButton()).toBeEnabled());
    await user.click(importButton());

    await screen.findByText("resultSummary(created=2|skipped=0)");
    expect(screen.queryByText(/resultSummaryUpdated/)).not.toBeInTheDocument();
    expect(screen.queryByText("updatesNotDeletes")).not.toBeInTheDocument();
  });
});

describe("CsvImportDialog import failures", () => {
  it("stays on the form and keeps the parse when the POST fails", async () => {
    mockPost.mockRejectedValue(new Error("HTTP 429"));
    const user = userEvent.setup();
    renderDialog();

    await uploadCsv(user, STUDENTS_CSV);
    await screen.findByText("rowsReady(count=2)");
    await waitFor(() => expect(importButton()).toBeEnabled());
    await user.click(importButton());

    // No result view; the file is still parsed and importable again.
    await waitFor(() => expect(importButton()).toBeEnabled());
    expect(screen.queryByText(/resultSummary/)).not.toBeInTheDocument();
    expect(screen.getByText("rowsReady(count=2)")).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith("HTTP 429");
  });
});
