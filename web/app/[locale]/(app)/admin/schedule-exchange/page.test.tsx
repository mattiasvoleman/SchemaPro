import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { ImportPlanDto } from "@/lib/schedule-exchange";
import ScheduleExchangePage from "./page";

/**
 * What this file guards: nothing is written until the preview has been read.
 * Skriv in is dead while any row is refused, the apply carries the PREVIEW's
 * fingerprint (so a plan that moved is refused by the gateway), a refused
 * row is shown with its reason by its code, and a file over the gateway's
 * body limit is turned back before it is sent.
 */

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

const { get, post, saveBase64 } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), saveBase64: vi.fn() }));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { get, post },
}));
vi.mock("@/lib/schedule-exchange", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/schedule-exchange")>()),
  saveBase64,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

let years: { yearId: string | null; isLoading: boolean; isError: boolean; years: unknown[] } = { yearId: "y1", isLoading: false, isError: false, years: [{ id: "y1", name: "2026/2027" }] };
vi.mock("@/components/schedule/year-select", () => ({
  useYearScope: () => ({ ...years, setYearId: vi.fn() }),
  YearSelect: () => <span>year-select</span>,
}));

vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) => (values ? `${key}(${Object.values(values).join("|")})` : key);
    t.has = (key: string) => key.startsWith("UNKNOWN_") || key.startsWith("EXISTS_") || key.startsWith("OUTSIDE_") || key.length < 4;
    return t;
  },
}));

const SUMMARY = { academicYearId: "y1", yearName: "2026/2027", publishMode: "DIRECT", lessons: 31, parked: 2, teachers: 6, teachersWithoutSignature: 0 };

const plan = (over: Partial<ImportPlanDto> = {}): ImportPlanDto => ({
  format: "TABLE_CSV",
  yearName: "2026/2027",
  summary: { rows: 2, create: 1, unchanged: 0, refused: 1, unreadable: 0, notInFile: 4 },
  rows: [
    { ref: "rad 2", label: "Matematik · 7A · mån 08:10–09:10", action: "CREATE", refusals: [], changes: [] },
    {
      ref: "rad 3",
      label: "Svenska · 9Z · tis 08:10–09:10",
      action: "REFUSED",
      refusals: [{ code: "UNKNOWN_GROUP", params: { name: "9Z" }, detail: "Klassen 9Z finns inte." }],
      changes: [],
    },
  ],
  unreadable: [],
  requirements: [],
  newBlocks: [],
  warnings: [],
  notes: ["GPU001 har inga veckomönster."],
  canApply: false,
  fingerprint: "f".repeat(32),
  ...over,
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ScheduleExchangePage />
    </QueryClientProvider>,
  );
}

const csvFile = (name = "schema.csv", size = 10) => new File([new Uint8Array(size).fill(65)], name, { type: "text/csv" });

async function choose(file: File) {
  const input = screen.getByLabelText("import.file") as HTMLInputElement;
  // The input’s accept list is the browser’s filter; here the page must cope with whatever arrives.
  await userEvent.setup({ applyAccept: false }).upload(input, file);
}

beforeEach(() => {
  years = { yearId: "y1", isLoading: false, isError: false, years: [{ id: "y1", name: "2026/2027" }] };
  get.mockReset().mockResolvedValue(SUMMARY);
  post.mockReset();
  saveBase64.mockReset();
});

describe("Schema som fil: export", () => {
  it("says what an export holds and downloads the file the gateway returns", async () => {
    post.mockResolvedValue({ filename: "rastra-schema-2026-2027.csv", contentType: "text/csv", contentBase64: "QQ==" });
    renderPage();
    expect(await screen.findByText(/export.summary\(31\|2\|2026\/2027\)/)).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("/api/v1/schedule-exchange/summary?academicYearId=y1");
    const csv = screen.getAllByText("formats.TABLE_CSV.name").find((node) => node.tagName === "P")!.closest("li")!;
    await userEvent.setup().click(within(csv).getByRole("button", { name: "export.download" }));
    expect(post).toHaveBeenCalledWith("/api/v1/schedule-exchange/export", { academicYearId: "y1", format: "TABLE_CSV" });
    await waitFor(() => expect(saveBase64).toHaveBeenCalledWith("rastra-schema-2026-2027.csv", "text/csv", "QQ=="));
  });

  it("warns about teachers with no signature, and offers nothing to export from an empty year", async () => {
    get.mockResolvedValue({ ...SUMMARY, lessons: 0, teachersWithoutSignature: 2 });
    renderPage();
    expect(await screen.findByText("export.noSignature(2)")).toBeInTheDocument();
    for (const button of screen.getAllByRole("button", { name: "export.download" })) expect(button).toBeDisabled();
  });

  it("shows the draft when the school publishes through one", async () => {
    get.mockResolvedValue({ ...SUMMARY, publishMode: "DRAFT" });
    renderPage();
    expect(await screen.findByText(/export.draft/)).toBeInTheDocument();
  });

  it("shows a skeleton while the years load and says so when they could not", () => {
    years = { ...years, isLoading: true };
    const { unmount } = renderPage();
    expect(screen.queryByText("export.title")).not.toBeInTheDocument();
    unmount();
    years = { ...years, isLoading: false, isError: true };
    renderPage();
    expect(screen.getByText("loadFailed")).toBeInTheDocument();
  });
});

describe("Schema som fil: import", () => {
  it("reads the format from the file name and previews with the file in base64", async () => {
    post.mockResolvedValue(plan());
    renderPage();
    await choose(csvFile());
    expect(screen.getByLabelText("import.format")).toHaveValue("TABLE_CSV");
    await userEvent.setup().click(screen.getByRole("button", { name: "import.preview" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith("/api/v1/schedule-exchange/import/preview", {
      academicYearId: "y1",
      format: "TABLE_CSV",
      files: [{ name: "schema.csv", contentBase64: Buffer.from("AAAAAAAAAA").toString("base64") }],
    });
  });

  it("asks for the school’s own time grid only for an Untis file, and sends it with the files", async () => {
    post.mockResolvedValue(plan());
    renderPage();
    await choose(csvFile());
    expect(screen.queryByLabelText("import.periods")).not.toBeInTheDocument();
    await choose(new File(["1,2"], "GPU001.TXT"));
    expect(screen.getByLabelText("import.format")).toHaveValue("UNTIS_GPU");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "import.preview" }));
    expect(post.mock.calls[0]![1]).not.toHaveProperty("periods");
    await user.type(screen.getByLabelText("import.periods"), "1 08:10-09:10");
    await user.click(screen.getByRole("button", { name: "import.preview" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1]![1]).toMatchObject({ format: "UNTIS_GPU", periods: "1 08:10-09:10" });
  });

  it("will not preview a file whose format the name does not show, until one is chosen", async () => {
    renderPage();
    await choose(csvFile("schema.pdf"));
    expect(screen.getByText("import.unknownFormat")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "import.preview" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("import.format"), { target: { value: "ASC_XML" } });
    expect(screen.getByRole("button", { name: "import.preview" })).toBeEnabled();
  });

  it("turns a file over the body limit back before it is sent", async () => {
    renderPage();
    await choose(csvFile("big.csv", 701 * 1024));
    expect(screen.getByText(/import.tooLarge/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "import.preview" })).toBeDisabled();
  });

  it("names a refused row with its reason and keeps Skriv in dead while any row is refused", async () => {
    post.mockResolvedValue(plan());
    renderPage();
    await choose(csvFile());
    await userEvent.setup().click(screen.getByRole("button", { name: "import.preview" }));
    const row = (await screen.findByText("Svenska · 9Z · tis 08:10–09:10")).closest("tr")!;
    expect(within(row).getByText("rad 3")).toBeInTheDocument();
    expect(within(row).getByText("UNKNOWN_GROUP(9Z)")).toBeInTheDocument();
    expect(screen.getByText("GPU001 har inga veckomönster.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^apply/ })).toBeDisabled();
    // With only the refused rows shown by default, the new one is behind the checkbox.
    expect(screen.queryByText("Matematik · 7A · mån 08:10–09:10")).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByLabelText("onlyRefused"));
    expect(screen.getByText("Matematik · 7A · mån 08:10–09:10")).toBeInTheDocument();
  });

  it("applies the previewed plan with its fingerprint, and says what was written", async () => {
    const ready = plan({ canApply: true, summary: { rows: 1, create: 1, unchanged: 0, refused: 0, unreadable: 0, notInFile: 0 }, rows: [plan().rows[0]!] });
    post.mockResolvedValueOnce(ready).mockResolvedValueOnce({ created: 1, unchanged: 0, requirementsCreated: 1, blocksCreated: 0 });
    renderPage();
    await choose(csvFile());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "import.preview" }));
    await user.click(await screen.findByRole("button", { name: /^apply/ }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1]![0]).toBe("/api/v1/schedule-exchange/import/apply");
    expect(post.mock.calls[1]![1]).toMatchObject({ academicYearId: "y1", format: "TABLE_CSV", fingerprint: "f".repeat(32) });
    expect(await screen.findByText("import.done(1|0|1|0)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^apply/ })).not.toBeInTheDocument();
  });

  it("asks for a new preview when the plan moved, and shows any other refusal as the gateway worded it", async () => {
    const ready = plan({ canApply: true, summary: { ...plan().summary, refused: 0 }, rows: [plan().rows[0]!] });
    post.mockResolvedValueOnce(ready).mockRejectedValueOnce(new ApiError(409, "moved", "IMPORT_PLAN_CHANGED"));
    renderPage();
    await choose(csvFile());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "import.preview" }));
    await user.click(await screen.findByRole("button", { name: /^apply/ }));
    expect(await screen.findByText("import.planChanged")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^apply/ })).not.toBeInTheDocument();

    post.mockReset().mockRejectedValueOnce(new ApiError(400, "Filen går inte att läsa.", "IMPORT_UNREADABLE"));
    await user.click(screen.getByRole("button", { name: "import.preview" }));
    expect(await screen.findByText("Filen går inte att läsa.")).toBeInTheDocument();
  });

  it("lists the unread lines, the warnings and the posts it would make", async () => {
    post.mockResolvedValue(
      plan({
        unreadable: [{ ref: "rad 9", code: "TABLE_BAD_TIME", message: "Tiden går inte att läsa." }],
        warnings: [{ code: "REQ_X", params: {}, detail: "Posten ändrades inte." }],
        requirements: [{ groupName: "7A", subjectName: "Matematik", action: "CREATE", lessonsPerWeek: 2, minutesPerLesson: 60, lessonLengths: [], recurrence: "ALL", block: "Språkval" }],
        newBlocks: ["Språkval"],
      }),
    );
    renderPage();
    await choose(csvFile());
    await userEvent.setup().click(screen.getByRole("button", { name: "import.preview" }));
    expect(await screen.findByText(/Tiden går inte att läsa/)).toBeInTheDocument();
    expect(screen.getByText("Posten ändrades inte.")).toBeInTheDocument();
    expect(screen.getByText(/Matematik · 7A: 2 × 60 min · Språkval/)).toBeInTheDocument();
    expect(screen.getByText("newBlocks(Språkval)")).toBeInTheDocument();
  });
});
