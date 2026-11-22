import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { TemplateKind } from "@/lib/column-fields";
import { readTable } from "@/lib/column-table";
import { ColumnMappingPanel, type MappingState } from "./column-mapping-panel";

/**
 * A file from Skola24 with no header row, whose description is only OFFERED (X3 design §6.1 and §6.2): the user has not said "read it that
 * way", so no column is placed, but the first row is a person and not a header, and a person with the confidential mark is not read. Nothing
 * of the marked person, and no TF number, reaches the panel, the mapping or a template sent to the gateway.
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

function renderPanel(kind: TemplateKind, text: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onChange = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <ColumnMappingPanel kind={kind} table={readTable(text)} templates={[]} onChange={onChange} />
    </QueryClientProvider>,
  );
  return { state: () => onChange.mock.calls.at(-1)![0] as MappingState };
}

const MARKED_FIRST =
  "Testskolan;Avd A;99999001TF01;Skyddad;Person;SP;skyddad.person@example.invalid;1\r\n" + "Testskolan;;99999001TF02;Erik;Exempel;;erik.exempel@example.invalid;\r\n" + "Testskolan;Avd B;99999001TF03;Åsa;Berg;;asa.berg@example.invalid;0\r\n";
const MARKED_LAST = "Testskolan;Avd A;99999001TF01;Erik;Exempel;;erik.exempel@example.invalid;\r\n" + "Testskolan;Avd B;99999001TF02;Skyddad;Person;SP;skyddad.person@example.invalid;1\r\n";
const NOT_MARKED = "Testskolan;Avd A;99999001TF01;Erik;Exempel;;erik.exempel@example.invalid;\r\n" + "Testskolan;Avd B;99999001TF02;Åsa;Berg;;asa.berg@example.invalid;0\r\n";

describe("a file with no header row whose description is only offered", () => {
  it("shows nothing of the marked first row, no TF number as a column name, names the row, and offers the description", () => {
    const { state } = renderPanel("teachers", MARKED_FIRST);
    const shown = document.body.textContent ?? "";
    expect(shown).not.toMatch(/Skyddad|skyddad\.person/);
    expect(shown).not.toMatch(/TF0/);
    expect(screen.getByText("held(1|1)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "format.use" })).toBeInTheDocument();
    // Offered, not applied: nothing is recognised and no column is placed.
    expect(screen.queryByText(/^format\.recognised/)).not.toBeInTheDocument();
    expect(state().assignment.every((entry) => entry === undefined)).toBe(true);
    expect(state().block.rowNumbers).toEqual([2, 3]);
  });

  it("does not take the first person for a header row: both people are rows, and there is no header row to choose or template to save", () => {
    const { state } = renderPanel("teachers", NOT_MARKED);
    expect(state().block.headerRowNumber).toBe(0);
    expect(state().block.body).toHaveLength(2);
    expect(screen.queryByLabelText("headerRow.label")).not.toBeInTheDocument();
    expect(screen.queryByText("save.title")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/TF0/);
  });

  it("sends no template at all, and no row of a marked person further down reaches the mapping, whichever columns the user places", async () => {
    const user = userEvent.setup();
    const { state } = renderPanel("teachers", MARKED_LAST);
    // No column has a header to be called by, so each is named by its place: the user can tell them apart.
    for (const [place, field] of [
      [4, "firstName"],
      [5, "lastName"],
      [7, "email"],
    ] as const) {
      await user.selectOptions(screen.getByRole("combobox", { name: `columns.fieldOf(columns.noHeaderAt(${place}))` }), field);
    }
    expect(state().applied.rows).toEqual([["Erik", "Exempel", "erik.exempel@example.invalid"]]);
    expect(JSON.stringify(state())).not.toMatch(/Skyddad|skyddad\.person/);
    expect(api.post).not.toHaveBeenCalled();
    expect(screen.getByText("held(1|2)")).toBeInTheDocument();
  });

  it("is applied when the user chooses it, with the same rows and the same row named", async () => {
    const user = userEvent.setup();
    const { state } = renderPanel("teachers", MARKED_FIRST);
    await user.click(screen.getByRole("button", { name: "format.use" }));
    expect(screen.getByText(/^format\.recognised\(/)).toBeInTheDocument();
    expect(state().block.rowNumbers).toEqual([2, 3]);
    expect(state().assignment).toEqual([null, null, null, "firstName", "lastName", null, "email", null]);
    expect(screen.getByText("held(1|1)")).toBeInTheDocument();
  });
});
