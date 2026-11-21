import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TemplateKind } from "@/lib/column-fields";
import type { MappingTemplate } from "@/lib/column-mapping";
import { readTable } from "@/lib/column-table";
import { readFixture } from "@/lib/__fixtures__/skola24-read";
import { ColumnMappingPanel, type MappingState } from "./column-mapping-panel";

/**
 * Filer från Skola24 in the one panel (Formatbeskrivare, X3): which description is applied and when, what the panel says of a
 * file read by one, and what it takes away (the header row to choose, the template to save) when the file has no header row.
 */

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) => (values ? `${key}(${Object.values(values).join("|")})` : key);
    t.has = () => true;
    return t;
  },
}));

function renderPanel(kind: TemplateKind, text: string, templates: MappingTemplate[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onChange = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <ColumnMappingPanel kind={kind} table={readTable(text)} templates={templates} onChange={onChange} />
    </QueryClientProvider>,
  );
  const state = () => onChange.mock.calls.at(-1)![0] as MappingState;
  return { onChange, state };
}

const PUPILS = readFixture("elever-klass.tsv");
const PARENTS = readFixture("foraldrar.csv");
const STAFF = readFixture("personal.csv");

const pupilsTemplate = (): MappingTemplate => ({
  id: "t1",
  kind: "students",
  name: "Skolans egen",
  headerRow: null,
  placements: [
    { key: "personnummer", label: "", field: null },
    { key: "efternamn", label: "Efternamn", field: "lastName" },
    { key: "fornamn", label: "Förnamn", field: "firstName" },
    { key: "klass", label: "Klass", field: "className" },
  ],
});

describe("a Skola24 description in the column panel", () => {
  it("is applied by itself on the exact documented headers, and says what it cannot give Rastra's import", () => {
    const { state } = renderPanel("students", PUPILS);
    expect(screen.getByText(/^format\.recognised\(/)).toBeInTheDocument();
    expect(screen.getByText("format.gap(1|fields.students.email)")).toBeInTheDocument();
    expect(state().assignment).toEqual([null, "lastName", "firstName", "className"]);
    expect(state().applied.problems).toEqual([{ code: "MISSING_REQUIRED", field: "email" }]);
    // Skola24's page gives the pupils' columns in no one order, so there is no header row to ask about.
    expect(screen.queryByLabelText("format.header.label")).not.toBeInTheDocument();
  });

  it("says where it comes from: the page, and the date the page carries", () => {
    renderPanel("students", PUPILS);
    expect(screen.getByText("format.source(2026-06-24)")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "format.sourceLink" });
    expect(link).toHaveAttribute("href", "https://www.skola24.com/support/schema/manualer/elevhantering/");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  it("is not applied by itself when a school's own template fits: the template is what the school said", async () => {
    const user = userEvent.setup();
    const { state } = renderPanel("students", PUPILS, [pupilsTemplate()]);
    expect(screen.queryByText(/^format\.recognised/)).not.toBeInTheDocument();
    expect(screen.getByText("template.applied(Skolans egen)")).toBeInTheDocument();
    expect(state().assignment).toEqual([null, "lastName", "firstName", "className"]);

    // The user's own choice of the description is applied, template or not.
    await user.selectOptions(screen.getByLabelText("format.label"), "skola24-elever-klass");
    expect(screen.getByText(/^format\.recognised\(/)).toBeInTheDocument();
    expect(screen.queryByText(/^template\.applied/)).not.toBeInTheDocument();
  });

  it("offers a file that is not exact and applies it when the user says so, naming the columns it lacks", async () => {
    const user = userEvent.setup();
    const { state } = renderPanel("students", "Personnummer\tEfternamn\tFörnamn\n19000105-0001\tTestsson\tÅsa\n");
    expect(screen.queryByText(/^format\.recognised/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "format.use" }));
    expect(screen.getByText(/^format\.recognised\(/)).toBeInTheDocument();
    expect(screen.getByText("format.missing(1|Klass)")).toBeInTheDocument();
    expect(state().assignment).toEqual([null, "lastName", "firstName"]);
  });

  it("is dropped when the user says none of them, and the columns are as X2 places them", async () => {
    const user = userEvent.setup();
    const { state } = renderPanel("students", PUPILS);
    await user.selectOptions(screen.getByLabelText("format.label"), "none");
    expect(screen.queryByText(/^format\.recognised/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^format\.gap/)).not.toBeInTheDocument();
    // The importer's own spellings place every header it knows; the personnummer column is left to X2, which drops it.
    expect(state().assignment).toEqual([undefined, "lastName", "firstName", "className"]);
    expect(state().applied.dropped).toHaveLength(1);
  });

  it("is not in the panel at all for a kind Skola24 has no file for", () => {
    renderPanel("rooms", "namn;kod\nA1;a\n");
    expect(screen.queryByLabelText("format.label")).not.toBeInTheDocument();
  });
});

describe("a file with no header row", () => {
  it("has no header row to choose and no template to save: the description is what recognises it", async () => {
    const user = userEvent.setup();
    const { state } = renderPanel("guardians", PARENTS);
    expect(screen.getByRole("button", { name: "format.use" })).toBeInTheDocument();
    // Read as X2 reads a file, the first guardian is the header row; the picker offers every row of the first ten.
    expect(screen.getByLabelText("headerRow.label")).toBeInTheDocument();
    expect(state().block.headerRowNumber).toBe(1);

    await user.click(screen.getByRole("button", { name: "format.use" }));
    expect(state().block.headerRowNumber).toBe(0);
    expect(state().block.body).toHaveLength(4);
    expect(screen.queryByLabelText("headerRow.label")).not.toBeInTheDocument();
    expect(screen.queryByText("save.title")).not.toBeInTheDocument();
    // The description said which column is the mobile number, so it is not dropped as a personnummer: two columns are, not three.
    expect(state().applied.dropped).toHaveLength(2);
    expect(state().assignment).toEqual([null, null, "firstName", "lastName", "email", "phone"]);
  });

  it("reads a file of TF numbers with every row a person, as Skola24's own course files are", async () => {
    const user = userEvent.setup();
    const { state } = renderPanel("guardians", readFixture("foraldrar-tf.csv"));
    await user.click(screen.getByRole("button", { name: "format.use" }));
    expect(state().block.headerRowNumber).toBe(0);
    expect(state().block.body).toHaveLength(4);
    expect(state().assignment).toEqual([null, null, "firstName", "lastName", "email"]);
    expect(state().applied.dropped).toHaveLength(2);
    expect(screen.getByText("format.missing(1|Mobilnummer för vårdnadshavare)")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/TF0/);
  });

  it("can be told that it has a header row after all, and is then read on its headers", async () => {
    const user = userEvent.setup();
    const { state } = renderPanel("guardians", PARENTS);
    await user.click(screen.getByRole("button", { name: "format.use" }));
    await user.selectOptions(screen.getByLabelText("format.header.label"), "present");
    expect(state().block.headerRowNumber).toBe(1);
    expect(screen.getByLabelText("headerRow.label")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("format.header.label"), "absent");
    expect(state().block.headerRowNumber).toBe(0);
  });
});

describe("what the description says of a column that is not read", () => {
  it("says why under the column, and stops saying it when the user places the column", async () => {
    const user = userEvent.setup();
    const { state } = renderPanel("teachers", STAFF);
    await user.click(screen.getByRole("button", { name: "format.use" }));
    for (const reason of ["school", "department", "confidentialMark", "needsPost"]) {
      expect(screen.getAllByText(`format.unread.${reason}`).length).toBeGreaterThan(0);
    }
    expect(state().assignment[5]).toBeNull();

    // The signature: placed by the user, who then has what the importer says of it.
    await user.selectOptions(screen.getByRole("combobox", { name: "columns.fieldOf(signatur)" }), "signature");
    expect(state().assignment[5]).toBe("signature");
    expect(screen.queryByText("format.unread.needsPost")).not.toBeInTheDocument();
  });

  it("leaves out the row Skola24's own mark names, says so, and reads the rest", async () => {
    const user = userEvent.setup();
    const { state } = renderPanel("teachers", STAFF);
    await user.click(screen.getByRole("button", { name: "format.use" }));
    expect(state().applied.held).toEqual([3]);
    expect(state().applied.rows).toHaveLength(2);
    expect(screen.getByText("held(1|3)")).toBeInTheDocument();
    expect(state().applied.ok).toBe(true);
  });
});
