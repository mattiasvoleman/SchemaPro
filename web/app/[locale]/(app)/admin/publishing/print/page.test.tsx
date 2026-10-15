import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { ApiError, api } from "@/lib/api";
import PrintTimetablesPage from "./page";

/**
 * /admin/publishing/print over the real hooks and the Swedish messages, the
 * gateway answering by path. What only this page decides: what it asks for
 * (the kind, the week, how teachers are named — by default as the school
 * names them, or by signature when it names nobody — and a class's lunch),
 * that every sheet is its own page with the week's validity, that a sheet
 * left out is left off paper, and that a week in no läsår says so.
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } };
});
const get = api.get as unknown as Mock;
vi.mock("@/i18n/navigation", () => ({ Link: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

const settings = { publicTeacherDisplay: "NONE", publicShowMeals: true };
const sheet = (id: string, title: string) => ({
  id,
  title,
  days: [
    { date: "2026-10-12", lessons: [{ start: "08:00", end: "08:50", subject: "Matematik", groups: [title], room: "Sal 12", teachers: ["ANLI"], cancelled: false }] },
    ...["13", "14", "15", "16", "17", "18"].map((day) => ({ date: `2026-10-${day}`, lessons: [] })),
  ],
});
const setOf = (kind: string, sheets: ReturnType<typeof sheet>[]) => ({
  kind,
  school: "Skolan i Exempelby",
  academicYearId: "y26",
  week: { from: "2026-10-12", to: "2026-10-18", isoWeek: "2026-W42" },
  validity: [{ from: "2026-08-17", to: "2027-06-11" }],
  teachers: "SIGNATURE",
  meals: true,
  sheets,
});

function answer(sets: Record<string, unknown> = {}) {
  get.mockImplementation(async (path: string) => {
    if (path === "/api/v1/publication-settings") return settings;
    if (path.startsWith("/api/v1/print/timetables")) {
      const kind = new URLSearchParams(path.split("?")[1]).get("kind")!;
      const set = sets[kind] ?? setOf(kind, kind === "GROUP" ? [sheet("g-7a", "7A"), sheet("g-7b", "7B")] : [sheet(`${kind}-1`, kind === "ROOM" ? "Sal 12" : "ANLI")]);
      if (set instanceof Error) throw set;
      return set;
    }
    throw new Error(`unexpected GET ${path}`);
  });
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <PrintTimetablesPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const askedFor = () =>
  get.mock.calls
    .map(([path]) => path as string)
    .filter((path) => path.startsWith("/api/v1/print/timetables"))
    .map((path) => Object.fromEntries(new URLSearchParams(path.split("?")[1])));

describe("/admin/publishing/print", () => {
  const print = vi.fn();
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-14T10:00:00"));
    vi.stubGlobal("print", print);
    answer();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("asks for every class's week of today, naming teachers as the school's Schemavisaren does, with the lunch", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { level: 2, name: "7A" })).toBeInTheDocument();
    // Asked once, with the school's settings read: never first by a default that names more.
    expect(askedFor()).toEqual([{ kind: "GROUP", date: "2026-10-14", teachers: "NONE", meals: "true" }]);
    expect(screen.getByRole("combobox", { name: /Lärare visas som/ })).toHaveValue("NONE");
    // Each sheet headed with the school, the week and its validity.
    const sheet7a = screen.getByRole("heading", { level: 2, name: "7A" }).closest("article") as HTMLElement;
    expect(within(sheet7a).getByText("Skolan i Exempelby · Klass eller grupp")).toBeInTheDocument();
    expect(within(sheet7a).getByText("Vecka 42 · 12 okt. – 18 okt.")).toBeInTheDocument();
    expect(within(sheet7a).getByText("Giltig fr.o.m. 17 aug. 2026 t.o.m. 11 juni 2027")).toBeInTheDocument();
    // One page each on paper.
    expect(sheet7a).toHaveClass("print:break-after-page");
  });

  it("asks for a teacher's set by signature when the school names nobody, by name when chosen, and never offers to name nobody on it", async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    renderPage();
    await screen.findByRole("heading", { level: 2, name: "7A" });
    await user.click(screen.getByRole("tab", { name: "Lärare" }));
    await waitFor(() => expect(askedFor().at(-1)).toEqual({ kind: "TEACHER", date: "2026-10-14", teachers: "SIGNATURE", meals: "false" }));
    const select = screen.getByRole("combobox", { name: /Lärare visas som/ });
    expect(select).toHaveValue("SIGNATURE");
    expect(within(select).queryByRole("option", { name: "Inte alls" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Visa klassens lunch" })).not.toBeInTheDocument();
    await user.selectOptions(select, "NAME");
    await waitFor(() => expect(askedFor().at(-1)).toEqual({ kind: "TEACHER", date: "2026-10-14", teachers: "NAME", meals: "false" }));
  });

  it("moves a week at a time, and leaves a class without its lunch when asked", async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    renderPage();
    await screen.findByRole("heading", { level: 2, name: "7A" });
    await user.click(screen.getByRole("button", { name: "Nästa vecka" }));
    await user.click(screen.getByRole("checkbox", { name: "Visa klassens lunch" }));
    await waitFor(() => expect(askedFor().at(-1)).toEqual({ kind: "GROUP", date: "2026-10-21", teachers: "NONE", meals: "false" }));
  });

  it("prints the sheets chosen, and leaves the others off paper", async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    renderPage();
    await screen.findByRole("heading", { level: 2, name: "7A" });
    await user.click(screen.getByRole("checkbox", { name: "7B" }));
    expect(screen.getByText("1 av 2 scheman skrivs ut.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "7B" })).not.toBeInTheDocument();
    // The last sheet drawn is the last on paper: no page break after it.
    const articles = screen.getAllByRole("article");
    expect(articles).toHaveLength(1);
    expect(articles[0].parentElement!.lastElementChild).toBe(articles[0]);
    await user.click(screen.getByRole("button", { name: "Skriv ut 1 schema" }));
    expect(print).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Inga" }));
    expect(screen.getByRole("button", { name: "Inget att skriva ut" })).toBeDisabled();
  });

  it("says a week in no läsår in words, and a failed read as one", async () => {
    answer({ GROUP: new ApiError(404, "Veckan ligger inte i något av skolans läsår.", "PRINT_WEEK_OUTSIDE_YEARS"), ROOM: new ApiError(500, "boom") });
    const user = userEvent.setup({ advanceTimers: () => undefined });
    renderPage();
    expect(await screen.findByRole("heading", { level: 2, name: "Veckan ligger inte i något läsår" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Salar" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Schemana kunde inte hämtas" })).toBeInTheDocument();
  });

  it("says why a teachers' set is empty", async () => {
    answer({ TEACHER: setOf("TEACHER", []) });
    const user = userEvent.setup({ advanceTimers: () => undefined });
    renderPage();
    await screen.findByRole("heading", { level: 2, name: "7A" });
    await user.click(screen.getByRole("tab", { name: "Lärare" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Inga lärare att skriva ut" })).toBeInTheDocument();
    expect(screen.getByText(/aldrig visas i Schemavisaren/)).toBeInTheDocument();
  });
});
