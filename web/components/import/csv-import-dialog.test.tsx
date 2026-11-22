import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
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
      screen.getByText('Rad 2: kolumnen "efternamn" är tom.'),
    ).toBeInTheDocument();
    // The valid row still counts, but errors block the import.
    expect(screen.getByText("rowsReady(count=1)")).toBeInTheDocument();
    expect(importButton()).toBeDisabled();
  });

  it("reports missing columns as a file-level error", async () => {
    const user = userEvent.setup();
    renderDialog();

    await uploadCsv(user, `${BOM}namn;epost\r\nAlma;alma@example.com\r\n`);

    // The mapping says what is missing and where to point it out; the importer's own sentence is not said a second time.
    await screen.findByText(/problems\.MISSING_REQUIRED\(field=fields\.students\.firstName/);
    expect(screen.getByText(/problems\.MISSING_REQUIRED\(field=fields\.students\.className/)).toBeInTheDocument();
    expect(screen.queryByText(/Kolumner saknas/)).not.toBeInTheDocument();
    expect(importButton()).toBeDisabled();
  });

  it("a mojibake header is not guessed at: it is named as a column nothing places, and the import waits", async () => {
    // web/lib/csv.ts claims normalizeHeader makes a wrong-encoding "FÃ¶rnamn" resolve like "Förnamn". It does not: NFD of "Ã"
    // is A + a combining tilde, so the header normalizes to "farnamn", not "fornamn". The importer used to fail with "Kolumner
    // saknas"; the mapping now names the column that was not placed and the field nothing was placed on, and the user points
    // it out (see "pointing out the columns").
    const user = userEvent.setup();
    renderDialog();

    await uploadCsv(
      user,
      "FÃ¶rnamn;efternamn;epost;klass\r\nAlma;Berg;alma@example.com;7A\r\n",
    );

    await screen.findByText(/problems\.MISSING_REQUIRED\(field=fields\.students\.firstName/);
    expect(screen.getByText(/unplaced\(count=1\|names=FÃ¶rnamn\)/)).toBeInTheDocument();
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
        { firstName: "Alma", lastName: "Berg", email: "alma@example.com", phone: null, className: "7A" },
        { firstName: "Nils", lastName: "Ek", email: "nils@example.com", phone: null, className: "7B" },
      ],
      // Each row's line in the file, the header being line 1.
      rowNumbers: [2, 3],
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
      rowNumbers: [2, 3],
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
      rowNumbers: [2],
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
      rowNumbers: [2, 3],
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
      rowNumbers: [2],
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
      rowNumbers: [2],
    });
    // The drawer's and the people page's uppdrag cards refetch.
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["teacherDuties"] }),
    );
  });

  describe("vårdnadshavare", () => {
    const GUARDIANS_CSV =
      BOM +
      "fornamn;efternamn;epost;telefon;elev_epost\r\n" +
      "Gun;Berg;gun@example.com;070-123 45 67;alma@example.com\r\n" +
      "Gun;Berg;gun@example.com;070-123 45 67;nils@example.com\r\n" +
      "Gert;Ek;gert@example.com;;ghost@example.com\r\n";

    it("says before the file is chosen what a row is and what an existing guardian keeps", async () => {
      const user = userEvent.setup();
      renderDialog({ kinds: ["students", "guardians"] });

      expect(screen.queryByText("guardiansNotice")).toBeNull();
      await switchKind(user, "guardians");

      expect(screen.getByText("guardiansNotice")).toBeInTheDocument();
      // Said beside it: the file may name pupils whose protected identity the school has not stored.
      expect(screen.getByText("protectedNotice")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "downloadTemplate" }));
      expect(mockDownloadTemplate).toHaveBeenCalledWith("guardians");
    });

    it("posts the rows to /import/guardians with no läsår, the file's own row numbers, and refreshes a pupil's guardians", async () => {
      mockPost.mockResolvedValue({ created: 1, skipped: 0, linked: 2, errors: [] });
      const user = userEvent.setup();
      const { invalidateSpy } = renderDialog({ kinds: ["guardians"] });

      await uploadCsv(user, GUARDIANS_CSV, "vardnadshavare.csv");
      await screen.findByText("rowsReady(count=3)");
      await user.click(importButton());

      await waitFor(() => expect(mockPost).toHaveBeenCalled());
      expect(mockPost).toHaveBeenCalledWith("/api/v1/import/guardians", {
        rows: [
          { firstName: "Gun", lastName: "Berg", email: "gun@example.com", phone: "070-123 45 67", studentEmail: "alma@example.com" },
          { firstName: "Gun", lastName: "Berg", email: "gun@example.com", phone: "070-123 45 67", studentEmail: "nils@example.com" },
          { firstName: "Gert", lastName: "Ek", email: "gert@example.com", phone: null, studentEmail: "ghost@example.com" },
        ],
        rowNumbers: [2, 3, 4],
      });
      await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["studentGuardians"] }));
      await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["people"] }));
    });

    it("sums up the guardians made, the links added and the rows that were there, and lists the row the gateway refused", async () => {
      mockPost.mockResolvedValue({
        created: 1,
        skipped: 0,
        linked: 2,
        errors: [{ row: 4, message: 'Kolumnen "elev_epost": ingen elev har e-postadressen "ghost@example.com".' }],
      });
      const user = userEvent.setup();
      renderDialog({ kinds: ["guardians"] });

      await uploadCsv(user, GUARDIANS_CSV, "vardnadshavare.csv");
      await screen.findByText("rowsReady(count=3)");
      await user.click(importButton());

      expect(await screen.findByText("resultSummaryGuardians(created=1|linked=2|skipped=0)")).toBeInTheDocument();
      expect(screen.getByText(/rowError\(row=4\|message=Kolumnen "elev_epost"/)).toBeInTheDocument();
    });

    it("refuses a row whose pupil address is no address before anything is sent", async () => {
      const user = userEvent.setup();
      renderDialog({ kinds: ["guardians"] });

      await uploadCsv(
        user,
        `${BOM}fornamn;efternamn;epost;telefon;elev_epost\r\nGun;Berg;gun@example.com;;Alma Berg\r\n`,
        "vardnadshavare.csv",
      );

      expect(await screen.findByText('Rad 2: elev_epost "Alma Berg" är inte en e-postadress. Skriv den som namn@skolan.se.')).toBeInTheDocument();
      expect(importButton()).toBeDisabled();
      expect(mockPost).not.toHaveBeenCalled();
    });

    it("needs no läsår: a school without an active one can import its guardians", async () => {
      supabaseState.years = [];
      const user = userEvent.setup();
      renderDialog({ kinds: ["guardians"] });

      await uploadCsv(user, GUARDIANS_CSV, "vardnadshavare.csv");
      await screen.findByText("rowsReady(count=3)");

      expect(screen.queryByText("noActiveYear")).toBeNull();
      expect(importButton()).toBeEnabled();
    });
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
      rowNumbers: [2],
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

describe("CsvImportDialog with files as schools save them", () => {
  it("reads a file Excel saved as CSV (semikolonavgränsad), in Windows-1252, with å, ä and ö intact", async () => {
    mockPost.mockResolvedValue({ created: 1, skipped: 0, errors: [] });
    const user = userEvent.setup();
    renderDialog();

    // "Östen;Åberg;osten@example.com;7Ä" in the code page Excel writes: Ö D6, Å C5, Ä C4.
    const latin1 = (text: string) => Uint8Array.from([...text].map((char) => char.charCodeAt(0)));
    const file = new File([latin1("fornamn;efternamn;epost;klass\r\nÖsten;Åberg;osten@example.com;7Ä\r\n")], "elever.csv", {
      type: "text/csv",
    });
    await user.upload(screen.getByLabelText("chooseFile"), file);

    await screen.findByText("rowsReady(count=1)");
    // Said, so a wrong guess is checked against the preview.
    expect(screen.getByText("readAs(encoding=Windows-1252)")).toBeInTheDocument();
    // In the preview table (the column panel's samples show the same cells).
    const previewTable = screen.getAllByRole("table").at(-1)!;
    expect(within(previewTable).getByText("Östen")).toBeInTheDocument();
    expect(within(previewTable).getByText("7Ä")).toBeInTheDocument();
    await waitFor(() => expect(importButton()).toBeEnabled());
    await user.click(importButton());
    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    expect(mockPost.mock.calls[0]?.[1]).toMatchObject({
      rows: [{ firstName: "Östen", lastName: "Åberg", email: "osten@example.com", className: "7Ä" }],
    });
  });

  describe("warnings in the preview, which do not stop the import", () => {
    /** A file in the code page Excel writes: one byte a character, "?" where the page has none. */
    const windows1252 = (text: string) =>
      new File([Uint8Array.from([...text].map((char) => (char.charCodeAt(0) < 256 ? char.charCodeAt(0) : 0x3f)))], "elever.csv", {
        type: "text/csv",
      });
    const GUARDIAN_HEADER = "fornamn;efternamn;epost;telefon;elev_epost\r\n";
    const warningRows = () => screen.queryAllByText(/^(questionMarkInName|guardianDetailsDiffer)\(/);

    it("names a row whose name has a ? in a file that was not UTF-8, where Excel lacked the character (Łukasz)", async () => {
      const user = userEvent.setup();
      renderDialog();

      await user.upload(
        screen.getByLabelText("chooseFile"),
        windows1252("fornamn;efternamn;epost;klass\r\nŁukasz;Ek;lukasz@example.com;7A\r\nÅsa;Berg;asa@example.com;7A\r\n"),
      );

      await screen.findByText("rowsReady(count=2)");
      expect(screen.getByText("fileWarnings")).toBeInTheDocument();
      expect(screen.getByText("questionMarkInName(row=2|name=?ukasz Ek)")).toBeInTheDocument();
      expect(warningRows()).toHaveLength(1);
      // A warning, not an error: the school may mean it.
      expect(screen.queryByText("mappingErrors")).toBeNull();
      expect(importButton()).toBeEnabled();
    });

    it("says nothing of a ? in a file read as UTF-8, where it was typed", async () => {
      const user = userEvent.setup();
      renderDialog();

      await uploadCsv(user, BOM + "fornamn;efternamn;epost;klass\r\nLukasz?;Ek;lukasz@example.com;7A\r\n");

      await screen.findByText("rowsReady(count=1)");
      expect(screen.queryByText("fileWarnings")).toBeNull();
    });

    it("asks only the names: a ? in a class or an address is not a lost character", async () => {
      const user = userEvent.setup();
      renderDialog();

      await user.upload(
        screen.getByLabelText("chooseFile"),
        windows1252("fornamn;efternamn;epost;klass\r\nÅsa;Berg;asa@example.com;7A?\r\n"),
      );

      await screen.findByText("rowsReady(count=1)");
      expect(warningRows()).toHaveLength(0);
    });

    it("names a guardian address that a later row gives other details, and which row applies", async () => {
      const user = userEvent.setup();
      renderDialog({ kinds: ["guardians"] });

      await uploadCsv(
        user,
        BOM +
          GUARDIAN_HEADER +
          "Anna;Ek;anna@example.com;070-1;alma@example.com\r\n" +
          "Annika;Ek;ANNA@example.com;070-1;bo@example.com\r\n" +
          "Anna;Ek;anna@example.com;;cleo@example.com\r\n" +
          "Anna;Ek;anna@example.com;070-2;dan@example.com\r\n",
      );

      await screen.findByText("rowsReady(count=4)");
      // Row 3 has another first name, row 5 another phone; row 4 says the same with a phone left out.
      expect(screen.getByText("guardianDetailsDiffer(row=3|first=2|email=ANNA@example.com)")).toBeInTheDocument();
      expect(screen.getByText("guardianDetailsDiffer(row=5|first=2|email=anna@example.com)")).toBeInTheDocument();
      expect(warningRows()).toHaveLength(2);
      expect(importButton()).toBeEnabled();
    });

    it("is quiet about a guardian of two pupils whose rows agree", async () => {
      const user = userEvent.setup();
      renderDialog({ kinds: ["guardians"] });

      await uploadCsv(
        user,
        BOM +
          GUARDIAN_HEADER +
          "Anna;Ek;anna@example.com;070-1;alma@example.com\r\nAnna;Ek;anna@example.com;070-1;bo@example.com\r\n",
      );

      await screen.findByText("rowsReady(count=2)");
      expect(screen.queryByText("fileWarnings")).toBeNull();
    });
  });

  it("says in the reader's language that nothing was imported when the gateway refuses the body", async () => {
    mockPost.mockRejectedValue(new Error("One or more fields failed validation."));
    const user = userEvent.setup();
    renderDialog();

    await uploadCsv(user, STUDENTS_CSV);
    await waitFor(() => expect(importButton()).toBeEnabled());
    await user.click(importButton());

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("rejectedByServer"));
  });

  it("names the row and the column of a cell it will not send, and says how rows are counted", async () => {
    const user = userEvent.setup();
    renderDialog();

    await uploadCsv(user, BOM + "fornamn;efternamn;epost;klass\r\nAlma;Berg;alma.berg@;7A\r\n");

    expect(
      await screen.findByText('Rad 2: epost "alma.berg@" är inte en e-postadress. Skriv den som namn@skolan.se.'),
    ).toBeInTheDocument();
    expect(screen.getByText("rowNumbering")).toBeInTheDocument();
    expect(importButton()).toBeDisabled();
  });
});

describe("CsvImportDialog: what the file itself says", () => {
  const latin = (text: string) => Uint8Array.from([...text].map((char) => char.charCodeAt(0)));

  it("refuses a UTF-16 file with what to save it as, and sends nothing", async () => {
    const user = userEvent.setup();
    renderDialog();
    const utf16 = new Uint8Array([0xff, 0xfe, ...[..."fornamn"].flatMap((char) => [char.charCodeAt(0), 0])]);
    await user.upload(screen.getByLabelText("chooseFile"), new File([utf16], "elever.csv", { type: "text/csv" }));

    expect(await screen.findByText(/Filen är sparad som Unicode-text \(UTF-16\)/)).toBeInTheDocument();
    expect(importButton()).toBeDisabled();
  });

  it("names the row a quote opens on and never closes", async () => {
    const user = userEvent.setup();
    renderDialog();
    await uploadCsv(user, BOM + 'fornamn;efternamn;epost;klass\r\nAlma;Berg;alma@example.com;7A\r\n"Nils;Ek;nils@example.com;7B\r\n');

    expect(await screen.findByText(/^Rad 3: ett citattecken öppnas men stängs aldrig/)).toBeInTheDocument();
    expect(importButton()).toBeDisabled();
  });

  it("counts the pupils a file creates without a class, before and after the import", async () => {
    mockPost.mockResolvedValue({
      created: 2,
      skipped: 0,
      errors: [],
      warnings: [
        { row: 3, code: "IMPORT_STUDENT_WITHOUT_CLASS", params: {}, message: "Eleven skapades utan klass." },
        { row: 2, code: "STAFF_TEACHER_NOT_QUALIFIED", params: {}, message: "Obehörig." },
      ],
    });
    const user = userEvent.setup();
    renderDialog();
    await uploadCsv(user, BOM + "fornamn;efternamn;epost;klass\r\nAlma;Berg;alma@example.com;7A\r\nNils;Ek;nils@example.com;\r\n");

    expect(await screen.findByText("withoutClass(count=1)")).toBeInTheDocument();
    await waitFor(() => expect(importButton()).toBeEnabled());
    await user.click(importButton());

    expect(await screen.findByText("createdWithoutClass(count=1)")).toBeInTheDocument();
    // Counted in its sentence, not listed among the tjänstefördelning's warnings.
    expect(screen.queryByText(/Eleven skapades utan klass/)).not.toBeInTheDocument();
    expect(screen.getByText("rowWarnings")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("refuses a file Excel saved as CSV (MS-DOS), whose å, ä and ö cannot be read safely", async () => {
    const user = userEvent.setup();
    renderDialog();
    // "Åsa;Öberg" and "Märta;Ström" in code page 850.
    const bytes = new Uint8Array([
      ...latin("fornamn;efternamn;epost;klass\r\n"),
      0x8f, ...latin("sa;"), 0x99, ...latin("berg;a@example.com;7A\r\nM"), 0x84, ...latin("rta;Str"), 0x94, ...latin("m;m@example.com;7A\r\n"),
    ]);
    await user.upload(screen.getByLabelText("chooseFile"), new File([bytes], "elever.csv", { type: "text/csv" }));

    expect(await screen.findByText(/CSV \(MS-DOS\)/)).toBeInTheDocument();
    expect(importButton()).toBeDisabled();
  });
});


// ---------------------------------------------------------------------------
// Kolumnmappning (X2): the columns of a file or a paste are pointed out before anything is read
// ---------------------------------------------------------------------------

describe("CsvImportDialog: pointing out the columns", () => {
  const mockGet = (api as unknown as { get: Mock }).get;
  const COLUMN = (name: string) => screen.getByRole("combobox", { name: `columns.fieldOf(column=${name})` });

  beforeEach(() => {
    mockGet.mockReset();
  });

  it("folds the list of columns away for a file whose headers are the importer's own, and reads it as it always did", async () => {
    mockPost.mockResolvedValue({ created: 2, skipped: 0, errors: [] });
    const user = userEvent.setup();
    renderDialog();

    await uploadCsv(user, STUDENTS_CSV);

    await screen.findByText("rowsReady(count=2)");
    const summary = screen.getByText("compact.allPlaced(placed=4|total=4)");
    expect(summary.closest("details")).not.toHaveAttribute("open");
    // Nothing is said of columns that need nothing said.
    expect(screen.queryByText(/^unplaced\(/)).not.toBeInTheDocument();
    await user.click(importButton());
    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    expect(mockPost.mock.calls[0]?.[1]).toMatchObject({
      rows: [
        { firstName: "Alma", lastName: "Berg", email: "alma@example.com", className: "7A" },
        { firstName: "Nils", lastName: "Ek", email: "nils@example.com", className: "7B" },
      ],
    });
  });

  it("opens the list for a column nothing places, names it, and imports once the user has pointed the columns out", async () => {
    mockPost.mockResolvedValue({ created: 1, skipped: 0, errors: [] });
    const user = userEvent.setup();
    renderDialog();

    // "Mejladress" and "Grupp" are not spellings the importer takes; Rastra does not guess at them.
    await uploadCsv(user, "fornamn;efternamn;Mejladress;Grupp\r\nAlma;Berg;alma@example.com;7A\r\n");

    await screen.findByText("unplaced(count=2|names=Mejladress, Grupp)");
    expect(screen.getByText("compact.needsSay(placed=2|total=4)").closest("details")).toHaveAttribute("open");
    expect(importButton()).toBeDisabled();

    await user.selectOptions(COLUMN("Mejladress"), "email");
    await user.selectOptions(COLUMN("Grupp"), "className");

    await screen.findByText("rowsReady(count=1)");
    expect(screen.queryByText(/^unplaced\(/)).not.toBeInTheDocument();
    await waitFor(() => expect(importButton()).toBeEnabled());
    // The list is still open: what the user has just done is not folded away under their hand.
    expect(screen.getByText(/^compact\./).closest("details")).toHaveAttribute("open");
    await user.click(importButton());
    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    expect(mockPost.mock.calls[0]?.[1]).toMatchObject({
      rows: [{ firstName: "Alma", lastName: "Berg", email: "alma@example.com", className: "7A" }],
    });
  });

  it("reads a table pasted from another program, tab-separated, and sends the same rows as a file would", async () => {
    mockPost.mockResolvedValue({ created: 1, skipped: 0, errors: [] });
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByLabelText("pasteLabel"));
    await user.paste("fornamn\tefternamn\tepost\tklass\nAlma\tBerg\talma@example.com\t7A\n");
    await user.click(screen.getByRole("button", { name: "pasteRead" }));

    await screen.findByText("rowsReady(count=1)");
    // A paste has no code page to name.
    expect(screen.queryByText(/^readAs\(/)).not.toBeInTheDocument();
    await waitFor(() => expect(importButton()).toBeEnabled());
    await user.click(importButton());
    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    expect(mockPost.mock.calls[0]?.[1]).toMatchObject({
      rows: [{ firstName: "Alma", lastName: "Berg", email: "alma@example.com", className: "7A" }],
    });
  });

  it("offers nothing to read until something is pasted, and says so when the paste holds no table", async () => {
    const user = userEvent.setup();
    renderDialog();
    expect(screen.getByRole("button", { name: "pasteRead" })).toBeDisabled();

    await user.click(screen.getByLabelText("pasteLabel"));
    await user.paste("   \n  ");
    expect(screen.getByRole("button", { name: "pasteRead" })).toBeDisabled();
  });

  it("drops a personnummer column in the browser: it is said, and nothing of it is sent", async () => {
    mockPost.mockResolvedValue({ created: 1, skipped: 0, errors: [] });
    const user = userEvent.setup();
    renderDialog();

    await uploadCsv(user, "fornamn;efternamn;epost;klass;Personnummer\r\nAlma;Berg;alma@example.com;7A;19800101-1234\r\n");

    await screen.findByText("rowsReady(count=1)");
    expect(screen.getByText("dropped(count=1)")).toBeInTheDocument();
    await waitFor(() => expect(importButton()).toBeEnabled());
    await user.click(importButton());
    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    expect(JSON.stringify(mockPost.mock.calls[0])).not.toMatch(/19800101|1234/);
  });

  it("holds the import back for a personnummer in a column that is read, naming the row and the column, never the value", async () => {
    const user = userEvent.setup();
    renderDialog();

    // One cell in three: fewer than half, so the column is an e-mail column with a stray number in it, not a personnummer column.
    await uploadCsv(
      user,
      "fornamn;efternamn;epost;klass\r\nAlma;Berg;alma@example.com;7A\r\nNils;Ek;19800101-1234;7B\r\nEva;Lind;eva@example.com;7C\r\n",
    );

    await screen.findByText("rowProblems.title");
    expect(screen.getByText(/Rad 3/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/19800101-1234/);
    expect(importButton()).toBeDisabled();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("places the columns of a file by the school's saved template, and says which", async () => {
    mockPost.mockResolvedValue({ created: 1, skipped: 0, errors: [] });
    mockGet.mockImplementation(async (url: string) =>
      url.startsWith("/api/v1/import-templates")
        ? [
            {
              id: "t1",
              kind: "students",
              name: "Skolans elevlista",
              headerRow: null,
              placements: [
                { key: "fn", label: "Fn", field: "firstName" },
                { key: "en", label: "En", field: "lastName" },
                { key: "mejl", label: "Mejl", field: "email" },
                { key: "kl", label: "Kl", field: "className" },
              ],
            },
          ]
        : undefined,
    );
    const user = userEvent.setup();
    renderDialog();

    await uploadCsv(user, "Fn;En;Mejl;Kl\r\nAlma;Berg;alma@example.com;7A\r\n");

    await screen.findByText("template.applied(name=Skolans elevlista)");
    await screen.findByText("rowsReady(count=1)");
    await waitFor(() => expect(importButton()).toBeEnabled());
    await user.click(importButton());
    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    expect(mockPost.mock.calls[0]?.[1]).toMatchObject({
      rows: [{ firstName: "Alma", lastName: "Berg", email: "alma@example.com", className: "7A" }],
    });
  });

  it("works as before when the templates cannot be read", async () => {
    mockGet.mockRejectedValue(new Error("down"));
    const user = userEvent.setup();
    renderDialog();

    await uploadCsv(user, STUDENTS_CSV);

    await screen.findByText("rowsReady(count=2)");
    await waitFor(() => expect(importButton()).toBeEnabled());
  });

  it("reads a table the page already holds as soon as the dialog opens", async () => {
    renderDialog({ kinds: ["students"], source: { text: "fornamn;efternamn;epost;klass\nAlma;Berg;alma@example.com;7A\n" } });

    await screen.findByText("rowsReady(count=1)");
    await waitFor(() => expect(importButton()).toBeEnabled());
  });

  describe("a timplan post with the teacher by signature (a Skola24 Tjänstefördelning names no addresses)", () => {
    it("sends the signatures, and tells the API the file had those columns", async () => {
      mockPost.mockResolvedValue({ created: 1, skipped: 0, updated: 0, errors: [] });
      const user = userEvent.setup();
      renderDialog({ kinds: ["requirements"] });

      await uploadCsv(user, "grupp;amne;lektioner_per_vecka;minuter_per_lektion;larare_signatur;medlarare_signatur\r\n7A;MA;3;60;KBE;BLU\r\n");

      await screen.findByText("rowsReady(count=1)");
      await waitFor(() => expect(importButton()).toBeEnabled());
      await user.click(importButton());
      await waitFor(() => expect(mockPost).toHaveBeenCalled());
      const [, body] = mockPost.mock.calls[0] as [string, { rows: Array<Record<string, unknown>>; columns: string[] }];
      expect(body.rows[0]).toMatchObject({ teacherSignature: "KBE", coTeacherSignature: "BLU" });
      expect(body.columns).toEqual(expect.arrayContaining(["teacherSignature", "coTeacherSignature"]));
    });

    it("refuses a row that names the same teacher both ways, as the gateway would", async () => {
      const user = userEvent.setup();
      renderDialog({ kinds: ["requirements"] });

      await uploadCsv(user, "grupp;amne;lektioner_per_vecka;minuter_per_lektion;larare;larare_signatur\r\n7A;MA;3;60;karin@example.com;KBE\r\n");

      expect(await screen.findByText(/läraren står både i larare och i larare_signatur/)).toBeInTheDocument();
      expect(importButton()).toBeDisabled();
    });
  });
});

describe("CsvImportDialog telephone numbers written without hyphens", () => {
  it("sends the numbers of a guardians file: ten digits are no personnummer in the telephone column", async () => {
    mockPost.mockResolvedValue({ created: 3, linked: 3, skipped: 0, errors: [] });
    const user = userEvent.setup();
    renderDialog({ kinds: ["guardians"] });

    await uploadCsv(
      user,
      "fornamn;efternamn;epost;telefon;elev_epost\r\nGun;Berg;gun@example.com;0701234567;alma@example.com\r\nOla;Ek;ola@example.com;0709876543;nils@example.com\r\nEva;Li;eva@example.com;070 123 45 67;bo@example.com\r\n",
    );

    await screen.findByText("rowsReady(count=3)");
    expect(screen.queryByText(/^dropped\(/)).not.toBeInTheDocument();
    await waitFor(() => expect(importButton()).toBeEnabled());
    await user.click(importButton());
    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    const [, body] = mockPost.mock.calls[0] as [string, { rows: Array<{ phone: string | null }> }];
    expect(body.rows.map((row) => row.phone)).toEqual(["0701234567", "0709876543", "070 123 45 67"]);
  });

  it("still holds a row back for a personnummer written as one in the telephone column", async () => {
    const user = userEvent.setup();
    renderDialog({ kinds: ["students"] });

    await uploadCsv(
      user,
      "fornamn;efternamn;epost;telefon;klass\r\nAlma;Berg;alma@example.com;0701234567;7A\r\nNils;Ek;nils@example.com;800101-1234;7B\r\nEva;Lind;eva@example.com;031-123456;7C\r\n",
    );

    await screen.findByText("rowProblems.title");
    expect(screen.getByText(/Rad 3/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/800101-1234/);
    expect(importButton()).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Files from Skola24 (Formatbeskrivare, X3): synthetic files made from what Skola24's own pages say of its files
// ---------------------------------------------------------------------------

describe("CsvImportDialog a file from Skola24", () => {
  // Skola24's staff file: eight columns, no header row, the last the confidential mark. The middle row is marked 1.
  const STAFF_FILE =
    [
      "Testskolan;Avd A;19000103-0001;Åsa;Provsson;ASP;asa.provsson@example.invalid;",
      "Testskolan;Avd B;19000103-0002;Maria;Fiktiv;MFI;maria.fiktiv@example.invalid;1",
      "Testskolan;;19000103-0003;Erik;Exempel;EEX;erik.exempel@example.invalid;",
    ].join("\r\n") + "\r\n";

  it("offers the description of a file with no header row, never applies it by itself, and reads every row once it is chosen", async () => {
    const user = userEvent.setup();
    renderDialog({ kinds: ["teachers"] });

    await uploadCsv(user, STAFF_FILE);
    await screen.findByText(/^format\.offered\(/);
    // Not applied by itself: no column is placed (the import waits), but the first person is a row and not the header row.
    expect(screen.queryByText(/^format\.recognised/)).not.toBeInTheDocument();
    expect(importButton()).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "format.use" }));
    await screen.findByText(/^format\.recognised\(/);
    // Said in the same notice: there is no header row, so the columns stand where Skola24 says they stand.
    expect(screen.getByText(/format\.byPosition/)).toBeInTheDocument();
    // The marked row is left out and named; the other two are read, and the import is not stopped by it.
    await screen.findByText("rowsReady(count=2)");
    expect(screen.getByText("held(count=1|rows=2)")).toBeInTheDocument();
    // The columns the description skips are not "as you chose": the line is its own.
    expect(screen.getByText(/^format\.skipped\(count=4\|names=/)).toBeInTheDocument();
    expect(screen.queryByText(/^skipped\(/)).not.toBeInTheDocument();
    expect(importButton()).toBeEnabled();
  });

  it("says why each column that is not read is not, and posts neither the signature, the marked row nor a personnummer", async () => {
    mockPost.mockResolvedValue({ created: 2, skipped: 0, errors: [] });
    const user = userEvent.setup();
    renderDialog({ kinds: ["teachers"] });

    await uploadCsv(user, STAFF_FILE);
    await user.click(await screen.findByRole("button", { name: "format.use" }));
    await screen.findByText("rowsReady(count=2)");
    for (const reason of ["school", "department", "confidentialMark", "needsPost"]) {
      expect(screen.getByText(`format.unread.${reason}`)).toBeInTheDocument();
    }

    await user.click(importButton());
    await screen.findByText("resultSummary(created=2|skipped=0)");
    expect(mockPost).toHaveBeenCalledWith("/api/v1/import/teachers", {
      rows: [
        { firstName: "Åsa", lastName: "Provsson", email: "asa.provsson@example.invalid" },
        { firstName: "Erik", lastName: "Exempel", email: "erik.exempel@example.invalid" },
      ],
      // The file's own rows, no header row to count: the first person is row 1.
      rowNumbers: [1, 3],
    });
    expect(JSON.stringify(mockPost.mock.calls)).not.toMatch(/19000|Maria|MFI|ASP/);
  });

  it("is read as before when the user says it is none of Skola24's", async () => {
    const user = userEvent.setup();
    renderDialog({ kinds: ["teachers"] });

    await uploadCsv(user, STAFF_FILE);
    await user.click(await screen.findByRole("button", { name: "format.use" }));
    await screen.findByText("rowsReady(count=2)");

    await user.selectOptions(screen.getByLabelText("format.label"), "none");
    expect(screen.queryByText(/^format\.recognised/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^held\(/)).not.toBeInTheDocument();
    // As X2 reads a file: the first row is the header, so the columns have a person's names and nothing places them, and the panel says so.
    await screen.findByText("summary.cannot");
    expect(importButton()).toBeDisabled();
  });

  it("applies the pupils' file by itself on its exact headers, and says what it cannot give: Rastra's import wants an e-mail", async () => {
    const user = userEvent.setup();
    renderDialog({ kinds: ["students"] });

    await uploadCsv(user, "Personnummer\tEfternamn\tFörnamn\tKlass\r\n19000105-0001\tTestsson\tÅsa\t7A\r\n19000105-0002\tProvsson\tÖrjan\t7B\r\n");
    await screen.findByText(/^format\.recognised\(/);
    expect(screen.getByText("format.gap(count=1|names=fields.students.email)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "format.use" })).not.toBeInTheDocument();
    expect(importButton()).toBeDisabled();
  });

  it("does not take a mobile number for a personnummer, and names the guardians' file's gap: the pupil is its personnummer, not an e-mail", async () => {
    const user = userEvent.setup();
    renderDialog({ kinds: ["guardians"] });

    await uploadCsv(user, "19000101-0001;19000102-0002;Åsa;Testsson;asa@example.invalid;0701234567\r\n19000101-0003;19000102-0004;Bo;Provsson;;\r\n");
    await user.click(await screen.findByRole("button", { name: "format.use" }));
    await screen.findByText(/^format\.recognised\(/);
    // Two personnummer columns are dropped; the mobile column is not a third.
    expect(screen.getByText("dropped(count=2)")).toBeInTheDocument();
    expect(screen.getByText("format.gap(count=1|names=fields.guardians.studentEmail)")).toBeInTheDocument();
    expect(importButton()).toBeDisabled();
  });

  it("reads a guardians' file of TF numbers, the form Skola24's own files have, and shows none of them once it is read", async () => {
    const user = userEvent.setup();
    renderDialog({ kinds: ["guardians"] });

    // Five columns, no header row, ÅÅÅÅMMDDTFnn in the ID columns: nothing a personnummer test sees.
    await uploadCsv(user, "19000101TF01;19000102TF01;Åsa;Testsson;asa@example.invalid\r\n19000101TF02;19000102TF02;Bo;Provsson;bo@example.invalid\r\n");
    await user.click(await screen.findByRole("button", { name: "format.use" }));
    await screen.findByText(/^format\.recognised\(/);
    expect(screen.getByText("dropped(count=2)")).toBeInTheDocument();
    // Both rows are rows of people: the first is not taken for a header (the surname column's examples name both), and no number is shown
    // anywhere in the dialog. The file cannot be imported as it stands (no pupil e-mail), so there is no preview table to look in.
    expect(screen.queryByLabelText("headerRow.label")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/TF0/);
    expect(screen.getByText("Testsson · Provsson")).toBeInTheDocument();
  });

  it("says nothing of Skola24 about a school's own list", async () => {
    const user = userEvent.setup();
    renderDialog({ kinds: ["teachers"] });

    await uploadCsv(user, TEACHERS_CSV);
    await screen.findByText("rowsReady(count=1)");
    expect(screen.queryByText(/^format\.(offered|recognised)/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "format.use" })).not.toBeInTheDocument();
  });
});

describe("CsvImportDialog a file from Skola24 that is only offered", () => {
  // The marked person is the first row; the ID column holds TF numbers, which X2's own test for a personnummer does not know.
  const MARKED_FIRST =
    "Testskolan;Avd A;99999001TF01;Skyddad;Person;SP;skyddad.person@example.invalid;1\r\n" + "Testskolan;;99999001TF02;Erik;Exempel;;erik.exempel@example.invalid;\r\n" + "Testskolan;Avd B;99999001TF03;Åsa;Berg;;asa.berg@example.invalid;0\r\n";

  it("shows nothing of a marked first row and no TF number before the user chooses the description, and posts nothing of them after", async () => {
    mockPost.mockResolvedValue({ created: 2, skipped: 0, errors: [] });
    const user = userEvent.setup();
    renderDialog({ kinds: ["teachers"] });

    await uploadCsv(user, MARKED_FIRST);
    await screen.findByText(/^format\.offered\(/);
    // Offered, not applied: the import waits. The first row is a person, so it is no column name, and the marked one is named by its row only.
    expect(screen.getByText("held(count=1|rows=1)")).toBeInTheDocument();
    expect(importButton()).toBeDisabled();
    expect(document.body.textContent).not.toMatch(/Skyddad|skyddad\.person|TF0/);

    await user.click(screen.getByRole("button", { name: "format.use" }));
    await screen.findByText("rowsReady(count=2)");
    await user.click(importButton());
    await screen.findByText("resultSummary(created=2|skipped=0)");
    expect(mockPost).toHaveBeenCalledWith("/api/v1/import/teachers", {
      rows: [
        { firstName: "Erik", lastName: "Exempel", email: "erik.exempel@example.invalid" },
        { firstName: "Åsa", lastName: "Berg", email: "asa.berg@example.invalid" },
      ],
      rowNumbers: [2, 3],
    });
    expect(JSON.stringify(mockPost.mock.calls)).not.toMatch(/Skyddad|skyddad\.person|TF0/);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });
});
