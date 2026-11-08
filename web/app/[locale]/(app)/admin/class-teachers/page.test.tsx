import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { AdminProfile } from "@/lib/admin-areas";
import type { AppointmentView, DraftRowView, OpenTimeView } from "@/lib/class-teacher";
import { CLASS_ID, YEAR_ID, appointment, draft, draftRow, openTime } from "@/lib/__fixtures__/class-teacher";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import ClassTeachersPage from "./page";

// The page is a lot of component for jsdom, and the machines this runs on are shared: waits are generous, not slow.
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

// Environment shims for Radix in jsdom — not behaviour under test.
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/**
 * /admin/class-teachers, through the gateway's routes and the real messages:
 * the appointments (and the ones that lapsed), the open hours of a scope as
 * a small editor, the school's option with the sentence a rektor reads before
 * turning it on, and the waiting drafts with their verdicts, published a class
 * at a time. Controls an administrator's profile does not write are disabled
 * and say whose they are.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const me = vi.hoisted(() => ({ adminProfile: "SCHEMALAGGARE" as string | null | undefined }));
vi.mock("@/components/profile-context", () => ({
  useProfile: () => ({ profile: { id: "u-admin", role: "SCHOOL_ADMIN", adminProfile: me.adminProfile } }),
  useReadOnly: () => false,
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const years = vi.hoisted(() => ({ data: undefined as unknown, isLoading: false, isError: false }));
vi.mock("@/lib/queries", () => ({
  useAcademicYears: () => years,
  useGroups: () => ({
    data: [
      { id: "c-3a", academicYearId: "y-2026", name: "3A", kind: "CLASS", gradeLevel: 3, halfOfId: null },
      { id: "c-3b", academicYearId: "y-2026", name: "3B", kind: "CLASS", gradeLevel: 3, halfOfId: null },
      { id: "c-3a-1", academicYearId: "y-2026", name: "3A-1", kind: "CLASS", gradeLevel: 3, halfOfId: "c-3a" },
      { id: "g-en3", academicYearId: "y-2026", name: "En3", kind: "TEACHING_GROUP", gradeLevel: null, halfOfId: null },
      { id: "c-2a", academicYearId: "y-2025", name: "2A", kind: "CLASS", gradeLevel: 2, halfOfId: null },
    ],
  }),
  usePeople: () => ({
    data: [
      { id: "t-anna", role: "TEACHER", firstName: "Anna", lastName: "Svensson", isActive: true },
      { id: "t-bo", role: "TEACHER", firstName: "Bo", lastName: "Ek", isActive: true },
      { id: "t-cecilia", role: "TEACHER", firstName: "Cecilia", lastName: "Ås", isActive: false },
      { id: "u-admin", role: "SCHOOL_ADMIN", firstName: "Dan", lastName: "Admin", isActive: true },
    ],
  }),
  useRooms: () => ({ data: [{ id: "r-12", name: "Sal 12" }, { id: "r-14", name: "Sal 14" }] }),
}));

const ADMIN = "/api/v1/class-teachers";

const state = vi.hoisted(() => ({
  appointments: [] as unknown[],
  openTimes: [] as unknown[],
  settings: { selfPublish: false } as { selfPublish: boolean },
  drafts: [] as unknown[],
}));

function serve(patch: { appointments?: AppointmentView[]; openTimes?: OpenTimeView[]; selfPublish?: boolean; drafts?: DraftRowView[] } = {}) {
  state.appointments = patch.appointments ?? [appointment()];
  state.openTimes = patch.openTimes ?? [openTime(), openTime({ id: "ot-2", studentGroupId: CLASS_ID, dayOfWeek: 3, startTime: "13:00", endTime: "15:00" })];
  state.settings = { selfPublish: patch.selfPublish ?? false };
  state.drafts = patch.drafts ?? [];
}

function renderPage(locale: "sv" | "en" = "sv") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
        <ClassTeachersPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const reads = (prefix: string) => api.get.mock.calls.map(([path]) => path as string).filter((path) => path.startsWith(prefix));

beforeEach(() => {
  vi.clearAllMocks();
  api.post.mockReset();
  api.put.mockReset();
  api.delete.mockReset();
  me.adminProfile = "SCHEMALAGGARE";
  years.data = [
    { id: YEAR_ID, name: "2026/27", isActive: true },
    { id: "y-2025", name: "2025/26", isActive: false },
  ];
  years.isLoading = false;
  years.isError = false;
  serve();
  api.get.mockImplementation(async (path: string) => {
    if (path.startsWith(`${ADMIN}/appointments`)) return state.appointments;
    if (path.startsWith(`${ADMIN}/open-times`)) return state.openTimes;
    if (path === `${ADMIN}/settings`) return state.settings;
    if (path === `${ADMIN}/drafts`) return state.drafts;
    throw new Error(`unexpected read ${path}`);
  });
});

describe("the page", () => {
  it("has the four parts, for the active läsår", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { level: 1, name: "Klasslärare" })).toBeInTheDocument();
    for (const name of ["Utnämningar", "Öppna tider", "Publicering", "Utkast att granska"]) {
      expect(await screen.findByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
    expect(screen.getByLabelText("Läsår")).toHaveValue(YEAR_ID);
    expect(reads(`${ADMIN}/appointments`)).toEqual([`${ADMIN}/appointments?academicYearId=${YEAR_ID}`]);
  });

  it("reads another läsår when it is chosen", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { level: 2, name: "Utnämningar" });
    await user.selectOptions(screen.getByLabelText("Läsår"), "y-2025");
    await waitFor(() => expect(reads(`${ADMIN}/appointments`)).toContain(`${ADMIN}/appointments?academicYearId=y-2025`));
    expect(reads(`${ADMIN}/open-times`)).toContain(`${ADMIN}/open-times?academicYearId=y-2025`);
  });

  it("says a school without a läsår has none", async () => {
    years.data = [];
    renderPage();
    expect(await screen.findByRole("heading", { level: 2, name: "Inga läsår ännu" })).toBeInTheDocument();
    expect(reads(ADMIN)).toEqual([]);
  });

  it("says in English what it is", async () => {
    renderPage("en");
    expect(await screen.findByRole("heading", { level: 1, name: "Class teachers" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 2, name: "Appointments" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Open hours" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Drafts to review" })).toBeInTheDocument();
  });
});

describe("the appointments", () => {
  it("lists who is klasslärare of which class, and says a lapsed appointment is to be made again", async () => {
    serve({
      appointments: [
        appointment(),
        appointment({ id: "ap-2", studentGroupId: "c-3b", className: "3B", userId: "t-bo", teacherName: "Bo Ek", runs: false }),
      ],
    });
    renderPage();
    const table = await screen.findByRole("table", { name: "Utsedda klasslärare" });
    const [, anna, bo] = within(table).getAllByRole("row");
    expect(within(anna!).getByText("3A")).toBeInTheDocument();
    expect(within(anna!).getByText("Anna Svensson")).toBeInTheDocument();
    expect(within(anna!).getByText("Gäller")).toBeInTheDocument();
    expect(within(anna!).queryByRole("button", { name: /Utse .* på nytt/ })).not.toBeInTheDocument();
    expect(within(bo!).getByText("Gäller inte längre")).toBeInTheDocument();
    expect(within(bo!).getByText("Utnämningen gäller inte längre – utse på nytt.")).toBeInTheDocument();
    expect(within(bo!).getByRole("button", { name: "Utse Bo Ek på nytt för 3B" })).toBeEnabled();
  });

  it("appoints the same teacher to the same class again, which takes the appointment over", async () => {
    serve({ appointments: [appointment({ runs: false })] });
    api.post.mockResolvedValue([appointment({ runs: true })]);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Utse Anna Svensson på nytt för 3A" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${ADMIN}/appointments`, { studentGroupId: CLASS_ID, userId: "t-anna" }));
    expect(await screen.findByText("Gäller")).toBeInTheDocument();
    expect(screen.queryByText("Gäller inte längre")).not.toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith("Utnämningen är sparad");
  });

  it("offers the classes of the läsår and its active teachers, and no half-class, group, other year or administrator", async () => {
    renderPage();
    const classes = await screen.findByLabelText("Klass");
    expect(within(classes).getAllByRole("option").map((one) => one.textContent)).toEqual(["Välj klass", "3A", "3B"]);
    expect(within(screen.getByLabelText("Klasslärare")).getAllByRole("option").map((one) => one.textContent)).toEqual([
      "Välj lärare",
      "Anna Svensson",
      "Bo Ek",
    ]);
  });

  it("appoints a teacher to a class", async () => {
    api.post.mockResolvedValue([appointment(), appointment({ id: "ap-2", studentGroupId: "c-3b", className: "3B", userId: "t-bo", teacherName: "Bo Ek" })]);
    const user = userEvent.setup();
    renderPage();
    const add = await screen.findByRole("button", { name: "Utse" });
    expect(add).toBeDisabled();
    await user.selectOptions(screen.getByLabelText("Klass"), "c-3b");
    await user.selectOptions(screen.getByLabelText("Klasslärare"), "t-bo");
    await user.click(add);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${ADMIN}/appointments`, { studentGroupId: "c-3b", userId: "t-bo" }));
    expect(await screen.findByText("Bo Ek", { selector: "td" })).toBeInTheDocument();
    // The teacher is cleared for the next one; the class stays.
    expect(screen.getByLabelText("Klasslärare")).toHaveValue("");
  });

  it("says a school year without appointments has none", async () => {
    serve({ appointments: [] });
    renderPage();
    expect(await screen.findByText("Inga klasslärare är utsedda för läsåret ännu.")).toBeInTheDocument();
  });

  it("removes an appointment after asking", async () => {
    api.delete.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Ta bort utnämningen av Anna Svensson för 3A" }));
    const dialog = await screen.findByRole("dialog", { name: "Ta bort utnämningen?" });
    expect(within(dialog).getByText("Anna Svensson slutar vara klasslärare för 3A.")).toBeInTheDocument();
    expect(api.delete).not.toHaveBeenCalled();
    state.appointments = [];
    await user.click(within(dialog).getByRole("button", { name: "Ta bort" }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith(`${ADMIN}/appointments/ap-1`));
    expect(await screen.findByText("Inga klasslärare är utsedda för läsåret ännu.")).toBeInTheDocument();
  });

  it("says the gateway's sentence when it refuses the write for the profile", async () => {
    api.post.mockRejectedValue(new ApiError(403, "Expeditionen ändrar inte schemaläggning.", "AREA_NOT_YOURS"));
    const user = userEvent.setup();
    renderPage();
    await user.selectOptions(await screen.findByLabelText("Klass"), "c-3b");
    await user.selectOptions(screen.getByLabelText("Klasslärare"), "t-bo");
    await user.click(screen.getByRole("button", { name: "Utse" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Expeditionen ändrar inte schemaläggning."));
  });
});

describe("the open hours", () => {
  const rows = () => screen.queryAllByRole("group", { name: /^Tid \d+$/ });
  const editor = () => screen.getByRole("form", { name: "Redigera öppna tider" });

  it("starts with the hours that hold for every class, as rows of a weekday and two times", async () => {
    renderPage();
    await waitFor(() => expect(rows()).toHaveLength(1));
    const [monday] = rows();
    expect(within(monday!).getByLabelText("Veckodag")).toHaveValue("1");
    expect(within(monday!).getByLabelText("Från")).toHaveValue("08:00");
    expect(within(monday!).getByLabelText("Till")).toHaveValue("12:00");
    expect(screen.getByRole("button", { name: "Spara tiderna" })).toBeDisabled();
  });

  it("adds a span and saves the scope whole", async () => {
    api.put.mockImplementation(async (_path: string, body: { spans: Array<{ dayOfWeek: number; startTime: string; endTime: string }> }) =>
      body.spans.map((span, index) => openTime({ id: `ot-${index}`, ...span })),
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Lägg till en tid" }));
    expect(rows()).toHaveLength(2);
    expect(screen.getByText("Ändringarna är inte sparade.")).toBeInTheDocument();
    const second = rows()[1]!;
    await user.selectOptions(within(second).getByLabelText("Veckodag"), "3");
    fireEvent.change(within(second).getByLabelText("Från"), { target: { value: "13:00" } });
    fireEvent.change(within(second).getByLabelText("Till"), { target: { value: "14:00" } });
    await user.click(screen.getByRole("button", { name: "Spara tiderna" }));
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(`${ADMIN}/open-times`, {
        academicYearId: YEAR_ID,
        studentGroupId: null,
        spans: [
          { dayOfWeek: 1, startTime: "08:00", endTime: "12:00" },
          { dayOfWeek: 3, startTime: "13:00", endTime: "14:00" },
        ],
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Tiderna är sparade");
    expect(await screen.findByRole("button", { name: "Spara tiderna" })).toBeDisabled();
    expect(screen.queryByText("Ändringarna är inte sparade.")).not.toBeInTheDocument();
  });

  it("shows what was kept when spans that touch or overlap were made one", async () => {
    api.put.mockResolvedValue([openTime({ endTime: "14:00" })]);
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Lägg till en tid" }));
    const second = rows()[1]!;
    fireEvent.change(within(second).getByLabelText("Från"), { target: { value: "11:00" } });
    fireEvent.change(within(second).getByLabelText("Till"), { target: { value: "14:00" } });
    await user.click(screen.getByRole("button", { name: "Spara tiderna" }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(within(rows()[0]!).getByLabelText("Till")).toHaveValue("14:00");
    expect(screen.getByText(/slås ihop när du sparar/)).toBeInTheDocument();
  });

  it("does not take a span that ends before it starts", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.change(within(rows()[0]!).getByLabelText("Till"), { target: { value: "07:00" } });
    expect(await screen.findByText("Tid 1: Sluttiden ska vara efter starttiden.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Spara tiderna" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Ta bort tid 1" }));
    expect(rows()).toHaveLength(0);
    expect(screen.queryByText(/Tid 1:/)).not.toBeInTheDocument();
  });

  it("edits one class apart, which is added to the hours of every class, and says so", async () => {
    api.put.mockResolvedValue([openTime()]);
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await user.selectOptions(screen.getByLabelText("Gäller för"), CLASS_ID);
    expect(await screen.findByText("Det gäller redan för alla klasser: Måndag 08:00–12:00.")).toBeInTheDocument();
    await waitFor(() => expect(within(rows()[0]!).getByLabelText("Veckodag")).toHaveValue("3"));
    expect(within(rows()[0]!).getByLabelText("Från")).toHaveValue("13:00");
    await user.click(screen.getByRole("button", { name: "Ta bort tid 1" }));
    expect(screen.getByText("Inga tider är öppna för det här valet.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Spara tiderna" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith(`${ADMIN}/open-times`, { academicYearId: YEAR_ID, studentGroupId: CLASS_ID, spans: [] }));
    expect(editor()).toBeInTheDocument();
  });
});

describe("the option that a klasslärare publishes for themselves", () => {
  it("is off until an administrator turns it on, and says what it does in plain words", async () => {
    renderPage();
    const toggle = await screen.findByRole("switch", { name: "Klasslärare publicerar sin klass utkast själva" });
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeEnabled();
    expect(screen.getByText(/^Av\. En klasslärare sparar utkast, och en schemaläggare går igenom och publicerar dem\./)).toBeInTheDocument();
  });

  it("turns on, with a sentence a rektor reads before pressing, and keeps what the gateway answers", async () => {
    api.put.mockResolvedValue({ selfPublish: true });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("switch", { name: "Klasslärare publicerar sin klass utkast själva" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith(`${ADMIN}/settings`, { selfPublish: true }));
    expect(await screen.findByText(/utan att en schemaläggare tittat först/)).toBeInTheDocument();
    expect(screen.getByText(/de öppna tiderna och klassens egna lektioner/)).toBeInTheDocument();
    expect(screen.getByText(/samma kontroller som schemaläggarens egna ändringar, så krockar stoppas/)).toBeInTheDocument();
    expect(screen.getByRole("switch")).toBeChecked();
    expect(toast.success).toHaveBeenCalledWith("Klasslärare publicerar nu själva");
  });

  it("shows a school that has it on as on", async () => {
    serve({ selfPublish: true });
    renderPage();
    expect(await screen.findByRole("switch", { name: "Klasslärare publicerar sin klass utkast själva" })).toBeChecked();
  });
});

describe("the drafts to review", () => {
  const two = (): DraftRowView[] => [
    draftRow(),
    draftRow({
      change: draft({ id: "d-2", kind: "OCCASION_CANCEL", targetDate: null, targetStart: null, targetEnd: null, note: "Sjukdom" }),
      verdict: { state: "CONFLICT", conflicts: [{ kind: "ROOM", other: { className: "3B", subjectName: "Svenska", date: "2026-11-04", start: "10:00", end: "11:00" } }] },
    }),
    draftRow({
      change: draft({ id: "d-3", studentGroupId: "c-3b" }),
      className: "3B",
      authorName: null,
      subjectName: "Svenska",
      verdict: { state: "REFUSED", reason: "TIME_CLOSED" },
    }),
  ];

  it("says there are none", async () => {
    renderPage();
    expect(await screen.findByText("Inga utkast väntar.")).toBeInTheDocument();
  });

  it("lists the drafts a class at a time with who wrote them, what they ask for and what the check says", async () => {
    serve({ drafts: two() });
    renderPage();
    const card = await screen.findByRole("region", { name: "Utkast att granska" });
    expect(await within(card).findByRole("heading", { level: 3, name: "Klass 3A: 2 utkast" })).toBeInTheDocument();
    expect(within(card).getByRole("heading", { level: 3, name: "Klass 3B: 1 utkast" })).toBeInTheDocument();
    expect(within(card).getAllByText("Skrivet av Anna Svensson")).toHaveLength(2);
    expect(within(card).getByText("Skrivet av en okänd person")).toBeInTheDocument();
    expect(within(card).getByText(/^Flytta Matematik .* till .* 10:00–11:00$/)).toBeInTheDocument();
    expect(within(card).getByText(/^Ställ in Matematik/)).toBeInTheDocument();
    expect(within(card).getByText("Anteckning: Sjukdom")).toBeInTheDocument();
    expect(within(card).getByText("Kan publiceras")).toBeInTheDocument();
    expect(within(card).getByText("Utkastet krockar i schemat")).toBeInTheDocument();
    expect(within(card).getByText(/Salen är upptagen då: 3B, Svenska/)).toBeInTheDocument();
    expect(within(card).getByText("Tiden är inte öppen för klasslärarens ändringar.")).toBeInTheDocument();
  });

  it("publishes a class's drafts and tells what happened to each", async () => {
    serve({ drafts: two() });
    api.post.mockResolvedValue({
      outcomes: [
        { id: "d-1", outcome: "PUBLISHED" },
        { id: "d-2", outcome: "STALE", changed: [{ field: "roomId", was: "r-12", now: "r-14" }] },
      ],
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Publicera utkasten för 3A" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${ADMIN}/classes/${CLASS_ID}/publish`, {}));
    const outcomes = (await screen.findByText("Så gick publiceringen")).closest("[role=status]") as HTMLElement;
    expect(within(outcomes).getByText("Publicerad")).toBeInTheDocument();
    expect(within(outcomes).getByText("Publicerades inte: lektionen har ändrats")).toBeInTheDocument();
    expect(within(outcomes).getByText("Det som ändrats: Sal (Sal 12 → Sal 14).")).toBeInTheDocument();
    // The drafts are read again.
    await waitFor(() => expect(reads(`${ADMIN}/drafts`).length).toBeGreaterThan(1));
  });

  it("throws a draft away after asking", async () => {
    serve({ drafts: two() });
    api.delete.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();
    const buttons = await screen.findAllByRole("button", { name: /^Släng utkastet: Flytta Matematik/ });
    await user.click(buttons[0]!);
    const dialog = await screen.findByRole("dialog", { name: "Släng utkastet?" });
    expect(api.delete).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Släng" }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith(`${ADMIN}/drafts/d-1`));
    expect(toast.success).toHaveBeenCalledWith("Utkastet är slängt");
  });

  it("says the gateway's sentence when the publication is refused for the profile", async () => {
    serve({ drafts: two() });
    api.post.mockRejectedValue(new ApiError(403, "Expeditionen ändrar inte publicering.", "AREA_NOT_YOURS"));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Publicera utkasten för 3A" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Expeditionen ändrar inte publicering."));
  });
});

describe("a profile that does not write the areas", () => {
  const mark = (element: HTMLElement) => element.closest("[data-writes]")?.getAttribute("data-writes");

  it("leaves the appointments and the hours to Schemaläggning, and says who has it", async () => {
    me.adminProfile = "EXPEDITION";
    renderPage();
    const add = await screen.findByRole("button", { name: "Utse" });
    expect(add).toBeDisabled();
    expect(screen.getByLabelText("Klass")).toBeDisabled();
    expect(screen.getByLabelText("Klasslärare")).toBeDisabled();
    expect(mark(add)).toBe("SCHEMALAGGNING");
    const remove = await screen.findByRole("button", { name: "Ta bort utnämningen av Anna Svensson för 3A" });
    expect(remove).toBeDisabled();
    expect(mark(remove)).toBe("SCHEMALAGGNING");
    await waitFor(() => expect(screen.getByRole("button", { name: "Lägg till en tid" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Spara tiderna" })).toBeDisabled();
    expect(await screen.findByLabelText("Från")).toBeDisabled();
    expect(screen.getAllByText("Din profil ändrar inte Schemaläggning. Schemaläggning ändras av rektor, en fullständig administratör eller en schemaläggare.").length).toBeGreaterThan(0);
  });

  it("leaves the option and the publishing to Publicering", async () => {
    me.adminProfile = "EXPEDITION";
    serve({ drafts: [draftRow()] });
    renderPage();
    const toggle = await screen.findByRole("switch");
    expect(toggle).toBeDisabled();
    expect(screen.getByText("Din profil ändrar inte Publicering. Publicering ändras av rektor, en fullständig administratör eller en schemaläggare.")).toBeInTheDocument();
    const publish = await screen.findByRole("button", { name: "Publicera utkasten för 3A" });
    expect(publish).toBeDisabled();
    expect(mark(publish)).toBe("SCHEMALAGGNING DRIFT PUBLICERING");
    const discard = screen.getByRole("button", { name: /^Släng utkastet:/ });
    expect(discard).toBeDisabled();
    expect(mark(discard)).toBe("PUBLICERING");
  });

  it("changes nothing at all for a läsare", async () => {
    me.adminProfile = "LASARE";
    serve({ drafts: [draftRow()] });
    renderPage();
    expect(await screen.findByRole("button", { name: "Utse" })).toBeDisabled();
    expect(await screen.findByRole("switch")).toBeDisabled();
    expect(await screen.findByRole("button", { name: "Publicera utkasten för 3A" })).toBeDisabled();
    // What is read is still read.
    expect(await screen.findByText("Anna Svensson", { selector: "td" })).toBeInTheDocument();
  });

  it("changes everything for a profile built without one, which reads as a full administrator", async () => {
    me.adminProfile = undefined;
    serve({ drafts: [draftRow()] });
    renderPage();
    expect(await screen.findByRole("switch")).toBeEnabled();
    expect(await screen.findByRole("button", { name: "Publicera utkasten för 3A" })).toBeEnabled();
    expect(screen.getByLabelText("Klass")).toBeEnabled();
    expect(screen.queryByText(/Din profil ändrar inte/)).not.toBeInTheDocument();
  });
});
