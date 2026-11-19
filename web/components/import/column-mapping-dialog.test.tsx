import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { MappingTemplate } from "@/lib/column-mapping";
import { ColumnMappingDialog, type ColumnMappingDialogProps } from "./column-mapping-dialog";

/**
 * What this file guards: a table is mapped in the browser before anything is sent. A column nobody placed is named and not
 * read, a column that looks like a personnummer is dropped and never shown, a saved template is recognised and can be
 * saved, changed and removed, and what the dialog hands back is the mapped text, UTF-8, under the reader's own headers.
 */

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

const { get, post, patch, del } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() }));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { get, post, patch, delete: del },
}));

vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) => (values ? `${key}(${Object.values(values).join("|")})` : key);
    t.has = () => true;
    return t;
  },
}));

const TABLE = ["Schema hösten", "Kurs\tFack\tPed\tRum\tDag\tTid\tAnteckning", "7A\tMatematik\tABC\tA1\tMån\t08:10-09:00\tse mall", "7B\tSvenska\tDEF, GHI\tB2\tTis\t09:20-10:10\t"].join("\n");

const FIELDS_BY_COLUMN = { Kurs: "group", Fack: "subject", Ped: "teacherList", Rum: "room", Dag: "day", Tid: "timeRange" } as const;

function renderDialog(over: Partial<ColumnMappingDialogProps> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onUse = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <ColumnMappingDialog open onOpenChange={vi.fn()} kind="scheduleLessons" source={{ text: TABLE }} onUse={onUse} {...over} />
    </QueryClientProvider>,
  );
  return { ...view, onUse };
}

const fieldSelect = (column: string) => screen.getByRole("combobox", { name: `columns.fieldOf(${column})` });

async function mapAll() {
  await screen.findByLabelText("headerRow.label");
  fireEvent.change(screen.getByLabelText("headerRow.label"), { target: { value: "2" } });
  for (const [column, field] of Object.entries(FIELDS_BY_COLUMN)) fireEvent.change(fieldSelect(column), { target: { value: field } });
}

const template = (over: Partial<MappingTemplate> = {}): MappingTemplate => ({
  id: "t1",
  kind: "scheduleLessons",
  name: "Höstens tabell",
  headerRow: 2,
  placements: [
    { key: "kurs", label: "Kurs", field: "group" },
    { key: "fack", label: "Fack", field: "subject" },
    { key: "ped", label: "Ped", field: "teacherList" },
    { key: "rum", label: "Rum", field: "room" },
    { key: "dag", label: "Dag", field: "day" },
    { key: "tid", label: "Tid", field: "timeRange" },
    { key: "anteckning", label: "Anteckning", field: null },
  ],
  ...over,
});

beforeEach(() => {
  get.mockReset().mockResolvedValue([]);
  post.mockReset();
  patch.mockReset();
  del.mockReset();
});

describe("Peka ut kolumnerna", () => {
  it("lists every column with what it holds, and asks for the school's templates of the kind", async () => {
    renderDialog();
    expect(await screen.findByRole("combobox", { name: "columns.fieldOf(Schema hösten)" })).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("/api/v1/import-templates?kind=scheduleLessons");
    // A title above the headers: the first row with content is the title, and the user is asked where the headers stand.
    expect(screen.getByLabelText("headerRow.label")).toHaveValue("1");
    fireEvent.change(screen.getByLabelText("headerRow.label"), { target: { value: "2" } });
    expect(fieldSelect("Fack")).toBeInTheDocument();
    expect(screen.getByText("7A · 7B")).toBeInTheDocument();
  });

  it("names every column nobody placed, reads none of them, and refuses the table until the required fields are placed", async () => {
    renderDialog();
    await screen.findByLabelText("headerRow.label");
    fireEvent.change(screen.getByLabelText("headerRow.label"), { target: { value: "2" } });
    fireEvent.change(fieldSelect("Kurs"), { target: { value: "group" } });
    // "Dag" is a spelling the reader already knows, so it is placed; the five others are named, and read nothing.
    expect(screen.getByText(/^unplaced\(5\|Fack, Ped, Rum, Tid, Anteckning\)/)).toBeInTheDocument();
    expect(screen.getByText("summary.cannot")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "dialog.use" })).toBeDisabled();
    expect(screen.getAllByText(/^problems\.MISSING_REQUIRED\(/).length).toBeGreaterThanOrEqual(3);
  });

  it("hands back the mapped table when the mapping is whole: UTF-8 text under the reader's headers, with the rows' own numbers", async () => {
    const { onUse } = renderDialog();
    await mapAll();
    expect(screen.getByText("summary.ready(2)")).toBeInTheDocument();
    // The columns nobody placed or chose to skip are said to be skipped, and the preview shows what is read.
    fireEvent.change(fieldSelect("Anteckning"), { target: { value: "__skip__" } });
    expect(screen.getByText("dialog.preview")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "dialog.use" }));
    expect(onUse).toHaveBeenCalledTimes(1);
    const handed = onUse.mock.calls[0]![0] as { csv: string; rows: number; name: string };
    expect(handed).toMatchObject({ rows: 2, name: "pasted" });
    expect(handed.csv).toBe("\r\nKlass/grupp;Ämne;Sal;Dag;Start;Slut;Lärare;Medlärare\r\n7A;Matematik;A1;Mån;08:10;09:00;ABC;\r\n7B;Svenska;B2;Tis;09:20;10:10;DEF;GHI\r\n");
  });

  it("never holds a column that looks like a personnummer: it is dropped, not shown, and not in what is handed back", async () => {
    const text = "Namn\tPersonnr\tKlass\tÄmne\tDag\tStart\tSlut\nAnna\t19800101-1234\t7A\tMa\tMån\t08:10\t09:00\nBo\t800101-1235\t7B\tSv\tTis\t09:20\t10:10";
    const { onUse } = renderDialog({ source: { text } });
    await screen.findByRole("combobox", { name: "columns.fieldOf(Namn)" });
    expect(screen.getByText("personalNumber")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /Personnr/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/19800101|800101-1235/)).not.toBeInTheDocument();
    for (const [column, field] of [["Klass", "group"], ["Ämne", "subject"], ["Dag", "day"], ["Start", "start"], ["Slut", "end"]] as const) {
      fireEvent.change(fieldSelect(column), { target: { value: field } });
    }
    expect(screen.getByText("dropped(1)")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "dialog.use" }));
    const handed = onUse.mock.calls[0]![0] as { csv: string };
    expect(handed.csv).not.toMatch(/1980|800101|Personnr/);
  });

  it("holds a row back for a personnummer in a column it reads, naming the row and never the number", async () => {
    const text = "Klass\tÄmne\tDag\tStart\tSlut\n7A\tMa\tMån\t08:10\t09:00\n7B\tAnna 19800101-1234\tTis\t09:20\t10:10\n7C\tEn\tOns\t10:20\t11:00";
    renderDialog({ source: { text } });
    await screen.findByRole("combobox", { name: "columns.fieldOf(Klass)" });
    for (const [column, field] of [["Klass", "group"], ["Ämne", "subject"], ["Dag", "day"], ["Start", "start"], ["Slut", "end"]] as const) {
      fireEvent.change(fieldSelect(column), { target: { value: field } });
    }
    expect(screen.getByText("rowProblems.title")).toBeInTheDocument();
    expect(screen.getByText(/^Rad 3: kolumnen ”Ämne” har en cell som ser ut som ett personnummer/)).toBeInTheDocument();
    expect(screen.queryByText(/19800101/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "dialog.use" })).toBeDisabled();
  });

  it("uses the template that fits, preselects its columns, and says so", async () => {
    get.mockResolvedValue([template()]);
    const { onUse } = renderDialog();
    expect(await screen.findByText("template.applied(Höstens tabell)")).toBeInTheDocument();
    expect(fieldSelect("Fack")).toHaveValue("subject");
    expect(fieldSelect("Anteckning")).toHaveValue("__skip__");
    await userEvent.setup().click(screen.getByRole("button", { name: "dialog.use" }));
    expect(onUse).toHaveBeenCalledTimes(1);
  });

  it("offers a template that expects a column the table lacks, and applies it only when told to", async () => {
    get.mockResolvedValue([template({ headerRow: 2, placements: [...template().placements, { key: "nyttfalt", label: "Nytt fält", field: "weeks" }] })]);
    renderDialog();
    expect(await screen.findByText("template.offered(Höstens tabell|1)")).toBeInTheDocument();
    expect(screen.queryByText(/^template.applied/)).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "template.useAnyway" }));
    expect(screen.getByText("template.applied(Höstens tabell)")).toBeInTheDocument();
  });

  it("asks which template when two fit equally well, and takes none by itself", async () => {
    get.mockResolvedValue([template({ id: "a", name: "A" }), template({ id: "b", name: "B" })]);
    renderDialog();
    expect(await screen.findByText("template.ambiguous")).toBeInTheDocument();
    expect(screen.queryByText(/^template.applied/)).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "B" }));
    expect(screen.getByText("template.applied(B)")).toBeInTheDocument();
  });

  it("works with no templates at all when they cannot be read", async () => {
    get.mockRejectedValue(new ApiError(404, "Not found"));
    renderDialog();
    expect(await screen.findByRole("combobox", { name: "columns.fieldOf(Schema hösten)" })).toBeInTheDocument();
    expect(screen.queryByText(/^template\./)).not.toBeInTheDocument();
  });
});

describe("Spara som mall", () => {
  it("saves the mapping as it stands, headers and fields and no value, under the name, with the header row when a title lies above", async () => {
    post.mockResolvedValue(template({ id: "new", name: "Min mall" }));
    renderDialog();
    await mapAll();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("save.name"), "Min mall");
    await user.click(screen.getByRole("button", { name: "save.button" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, body] = post.mock.calls[0]! as [string, { kind: string; name: string; headerRow: number | null; placements: { key: string; label: string; field: string | null }[] }];
    expect(path).toBe("/api/v1/import-templates");
    expect(body).toMatchObject({ kind: "scheduleLessons", name: "Min mall", headerRow: 2 });
    expect(body.placements.filter((post) => post.field !== null).map((post) => [post.key, post.field])).toEqual([
      ["kurs", "group"], ["fack", "subject"], ["ped", "teacherList"], ["rum", "room"], ["dag", "day"], ["tid", "timeRange"],
    ]);
    // Nothing of the table's cells is in it.
    expect(JSON.stringify(body)).not.toMatch(/Matematik|ABC|08:10/);
    expect(await screen.findByText("save.saved(Min mall)")).toBeInTheDocument();
  });

  it.each([
    ["a name taken", new ApiError(409, "x", "TEMPLATE_NAME_TAKEN"), "save.nameTaken"],
    ["no Planering", new ApiError(403, "x", "AREA_NOT_YOURS"), "save.notYours"],
    ["too many", new ApiError(409, "x", "TEMPLATE_LIMIT", { limit: 20 }), "save.limit(20)"],
    ["anything else", new ApiError(500, "x"), "save.failed"],
  ])("says so when the save is refused for %s, and the table can still be used", async (_label, error, text) => {
    post.mockRejectedValue(error);
    const { onUse } = renderDialog();
    await mapAll();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("save.name"), "Min mall");
    await user.click(screen.getByRole("button", { name: "save.button" }));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "dialog.use" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "dialog.use" }));
    expect(onUse).toHaveBeenCalledTimes(1);
  });

  it("does not offer to save a mapping that places nothing, nor one without a name", async () => {
    renderDialog({ source: { text: "Kurs\tFack\n7A\tMa" } });
    await screen.findByRole("combobox", { name: "columns.fieldOf(Kurs)" });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("save.name"), "x");
    expect(screen.getByRole("button", { name: "save.button" })).toBeDisabled();
    fireEvent.change(fieldSelect("Kurs"), { target: { value: "group" } });
    expect(screen.getByRole("button", { name: "save.button" })).toBeEnabled();
    await user.clear(screen.getByLabelText("save.name"));
    expect(screen.getByRole("button", { name: "save.button" })).toBeDisabled();
  });

  it("saves over the template in use and removes it, by id", async () => {
    get.mockResolvedValue([template()]);
    patch.mockResolvedValue(template());
    del.mockResolvedValue(undefined);
    renderDialog();
    await screen.findByText("template.applied(Höstens tabell)");
    const user = userEvent.setup();
    fireEvent.change(fieldSelect("Anteckning"), { target: { value: "block" } });
    // The template stays the one in use after a change, and the table is said to differ from it.
    expect(screen.getByText("template.changed(Höstens tabell)")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "save.update(Höstens tabell)" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0]![0]).toBe("/api/v1/import-templates/t1");
    expect(patch.mock.calls[0]![1]).toMatchObject({ headerRow: 2 });
    expect((patch.mock.calls[0]![1] as { placements: { key: string; field: string | null }[] }).placements.find((post) => post.key === "anteckning")!.field).toBe("block");
    await user.click(screen.getByRole("button", { name: "save.delete" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/api/v1/import-templates/t1"));
    expect(await screen.findByText("save.deleted")).toBeInTheDocument();
    expect(screen.queryByText(/^template.applied/)).not.toBeInTheDocument();
  });
});

describe("a table that is not text", () => {
  it("reads a file in the encoding it was saved in, and says which", async () => {
    // "Klass;Ämne;Dag;Start;Slut" and a row, in Windows-1252: Ä is the single byte C4.
    const bytes = new Uint8Array([...Buffer.from("Klass;"), 0xc4, ...Buffer.from("mne;Dag;Start;Slut\n7A;Ma;Mån;08:10;09:00\n")]);
    const file = new File([bytes], "schema.csv");
    Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer });
    renderDialog({ source: { file } });
    expect(await screen.findByText("readAs(Windows-1252)")).toBeInTheDocument();
    expect(await screen.findByRole("combobox", { name: "columns.fieldOf(Ämne)" })).toBeInTheDocument();
  });

  it("turns back a file saved as UTF-16, with what to do instead, and an empty paste", async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]);
    const file = new File([bytes], "schema.csv");
    Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer });
    const { unmount } = renderDialog({ source: { file } });
    expect(await screen.findByText(/UTF-16/)).toBeInTheDocument();
    unmount();
    renderDialog({ source: { text: " \n\n" } });
    expect(await screen.findByText("empty")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "dialog.use" })).toBeDisabled();
  });

  it("turns back a table that is too large to send, and a text far too long to be one", async () => {
    const rows = Array.from({ length: 30000 }, (_, i) => `7A;Matematik;Mån;08:10;09:00;${"x".repeat(20)}${i}`).join("\n");
    renderDialog({ source: { text: `Klass;Ämne;Dag;Start;Slut;Ort\n${rows}` } });
    await screen.findByRole("combobox", { name: "columns.fieldOf(Klass)" });
    for (const [column, field] of [["Klass", "group"], ["Ämne", "subject"], ["Dag", "day"], ["Start", "start"], ["Slut", "end"], ["Ort", "room"]] as const) {
      fireEvent.change(fieldSelect(column), { target: { value: field } });
    }
    expect(screen.getByText(/^dialog.tooLarge/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "dialog.use" })).toBeDisabled();
  });
});

describe("a second table", () => {
  it("starts over: the choices made for the last table's columns are not carried to the next, of the same width or not", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = (text: string) => (
      <QueryClientProvider client={client}>
        <ColumnMappingDialog open onOpenChange={vi.fn()} kind="scheduleLessons" source={{ text }} onUse={vi.fn()} />
      </QueryClientProvider>
    );
    const view = render(ui("Kurs\tFack\n7A\tMa"));
    fireEvent.change(await screen.findByRole("combobox", { name: "columns.fieldOf(Kurs)" }), { target: { value: "group" } });
    fireEvent.change(screen.getByRole("combobox", { name: "columns.fieldOf(Fack)" }), { target: { value: "__skip__" } });
    view.rerender(ui("Foo\tBar\n1\t2"));
    expect(await screen.findByRole("combobox", { name: "columns.fieldOf(Foo)" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "columns.fieldOf(Bar)" })).toHaveValue("");
  });
});

describe("the dialog's own buttons", () => {
  it("closes on Avbryt without handing anything back", async () => {
    const onOpenChange = vi.fn();
    const { onUse } = renderDialog({ onOpenChange });
    await userEvent.setup().click(await screen.findByRole("button", { name: "dialog.cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onUse).not.toHaveBeenCalled();
    expect(within(screen.getByRole("dialog")).getByText("dialog.title")).toBeInTheDocument();
  });
});
