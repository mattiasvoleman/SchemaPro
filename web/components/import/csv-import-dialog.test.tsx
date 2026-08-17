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
      for (const method of ["select", "order", "eq", "limit"]) {
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
  useTranslations:
    () => (key: string, values?: Record<string, unknown>) =>
      values
        ? `${key}(${Object.entries(values)
            .map(([name, value]) => `${name}=${String(value)}`)
            .join("|")})`
        : key,
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
