import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { ApiError, api } from "@/lib/api";
import { PUBLICATION_KEYS } from "@/lib/publication-keys";
import type { PublicationSettings } from "@/lib/publication-types";
import SchemavisarenPage from "./page";

/**
 * /admin/schemavisaren over the real hooks and the real Swedish messages (an
 * untranslated key or an unfilled ICU argument throws), with the gateway
 * answering by path. What only this page decides: which choice it offers per
 * kind (a pupil is never in a list, a teacher only while named), that a save
 * sends only what was changed and what a refusal says, what it tells about a
 * code before it is made, that a code is shown once as the gateway returned
 * it, which schedules it offers to hide, and when embedding is offered at all.
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } };
});
const get = api.get as unknown as Mock;
const post = api.post as unknown as Mock;
const put = api.put as unknown as Mock;

vi.mock("@/lib/queries", () => ({
  useAcademicYears: () => ({
    data: [
      { id: "y26", name: "2026/27", startDate: "2026-08-17", endDate: "2027-06-11", isActive: true, predecessorId: null },
      { id: "y25", name: "2025/26", startDate: "2025-08-18", endDate: "2026-06-12", isActive: false, predecessorId: null },
    ],
  }),
  useGroups: () => ({
    data: [
      { id: "g-7a", academicYearId: "y26", name: "7A", kind: "CLASS", gradeLevel: 7 },
      { id: "g-sv", academicYearId: "y26", name: "Svenska 7", kind: "TEACHING_GROUP", gradeLevel: 7 },
      { id: "g-old", academicYearId: "y25", name: "6A", kind: "CLASS", gradeLevel: 6 },
    ],
  }),
  usePeople: () => ({
    data: [
      { id: "t-anna", role: "TEACHER", firstName: "Anna", lastName: "Berg", isActive: true },
      { id: "t-bo", role: "TEACHER", firstName: "Bo", lastName: "Ek", isActive: true },
      { id: "t-old", role: "TEACHER", firstName: "Gammal", lastName: "Lärare", isActive: false },
      { id: "p-ada", role: "STUDENT", firstName: "Ada", lastName: "Lind", isActive: true, studentGroupId: "g-7a" },
      { id: "p-bert", role: "STUDENT", firstName: "Bertil", lastName: "Ås", isActive: true, studentGroupId: "g-7a" },
      { id: "p-cia", role: "STUDENT", firstName: "Cia", lastName: "Dal", isActive: true, studentGroupId: "g-old" },
    ],
  }),
  useRooms: () => ({ data: [{ id: "r-12", name: "Sal 12" }] }),
}));
vi.mock("@/i18n/navigation", () => ({ Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const SETTINGS: PublicationSettings = {
  publishMode: "DIRECT",
  stored: false,
  gateClashes: "WARN",
  gateParked: "WARN",
  gateUnplaced: "WARN",
  gateUnstaffed: "WARN",
  gateMissingTeacher: "WARN",
  gateMissingRoom: "WARN",
  gateStaffing: "WARN",
  gateTimplan: "WARN",
  gateOverlap: "WARN",
  gatePast: "WARN",
  gateLunch: "WARN",
  gateWeekSplit: "WARN",
  gateGap: "WARN",
  gateDayOpsLost: "WARN",
  gateEmptyHalf: "WARN",
  gateOtherSchool: "WARN",
  gateDeviations: "WARN",
  viewerAudience: "STAFF",
  viewerClassMode: "OFF",
  viewerGroupMode: "OFF",
  viewerTeacherMode: "OFF",
  viewerStudentMode: "OFF",
  viewerRoomMode: "OFF",
  publicTeacherDisplay: "NONE",
  publicShowMeals: true,
  publicMinGroupSize: 5,
  publicEmbedGroups: false,
  publicEmbedTeachers: false,
  publicEmbedRooms: false,
  publicEmbedOrigins: [],
  calendarFeedTeachers: false,
  calendarFeedStudents: false,
  calendarFeedGuardians: false,
};

/** A school that shows its classes from a list, teachers by code, and is open to everyone. */
const OPEN: PublicationSettings = {
  ...SETTINGS,
  stored: true,
  viewerAudience: "EVERYONE",
  viewerClassMode: "LIST",
  viewerTeacherMode: "CODE",
  viewerStudentMode: "CODE",
  publicTeacherDisplay: "NAME",
};

const link = (extra: Record<string, unknown>) => ({
  id: "k-1",
  academicYearId: "y26",
  kind: "GROUP",
  targetId: null,
  label: null,
  createdAt: "2026-10-01T08:00:00.000Z",
  revokedAt: null,
  lastUsedAt: null,
  notShownBecause: null,
  embeddable: false,
  ...extra,
});

const server = vi.hoisted(() => ({
  settings: null as unknown,
  links: [] as unknown[],
  hiddenTeachers: [] as string[],
  hidden: { groups: [] as string[], rooms: [] as string[], students: [] as string[] },
}));

function answer() {
  get.mockImplementation(async (path: string) => {
    if (path === "/api/v1/publication-settings") return server.settings;
    if (path.startsWith("/api/v1/public-links")) return server.links;
    if (path === "/api/v1/teacher-public-labels") return server.hiddenTeachers;
    if (path === "/api/v1/viewer-hidden") return server.hidden;
    throw new Error(`unexpected GET ${path}`);
  });
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
          <SchemavisarenPage />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    ),
  };
}

/** From now on the gateway refuses GETs to `path` (or paths starting with it). */
function failFrom(path: string) {
  const answering = get.getMockImplementation()!;
  get.mockImplementation(async (asked: string) => {
    if (asked.startsWith(path)) throw new ApiError(500, "boom");
    return answering(asked);
  });
}

const group = (name: string) => screen.getByRole("radiogroup", { name });
const card = async (name: string) => (await screen.findByRole("heading", { name })).closest("section") as HTMLElement;

beforeEach(() => {
  // reset, not clear: a row that fails before its queued answer is used
  // must not hand that answer to the next row.
  vi.resetAllMocks();
  server.settings = { ...SETTINGS };
  server.links = [];
  server.hiddenTeachers = [];
  server.hidden = { groups: [], rooms: [], students: [] };
  answer();
});

describe("/admin/schemavisaren › Vem och hur", () => {
  it("shows a school that never set anything: for staff, every kind off, and says nothing is shown", async () => {
    renderPage();
    const who = await card("Vem och hur");
    expect(within(who).getByRole("radio", { name: /^Bara inloggad personal/ })).toBeChecked();
    for (const kind of ["Klass", "Undervisningsgrupp", "Lärare", "Elev", "Sal"]) {
      expect(within(group(kind)).getByRole("radio", { name: "Av" })).toBeChecked();
    }
    expect(within(who).getByText(/Ingen sorts schema visas just nu/)).toBeInTheDocument();
    expect(within(who).getByText("En ändring syns för besökarna inom en minut.")).toBeInTheDocument();
    expect(within(who).getByRole("button", { name: "Spara" })).toBeDisabled();
  });

  it("offers a pupil Av and Fritext-ID and no list, and the others all three", async () => {
    renderPage();
    await card("Vem och hur");
    expect(within(group("Elev")).getAllByRole("radio").map((radio) => radio.getAttribute("value"))).toEqual(["OFF", "CODE"]);
    expect(within(group("Sal")).getAllByRole("radio").map((radio) => radio.getAttribute("value"))).toEqual(["OFF", "LIST", "CODE"]);
    expect(screen.getByText(/En elevs schema visar var eleven finns\. Bara med kod/)).toBeInTheDocument();
    expect(screen.getByText(/koderna delar skolan ut, de går inte att gissa/)).toBeInTheDocument();
  });

  it("saves only what was changed", async () => {
    put.mockImplementation(async (_path: string, body: object) => ({ ...(server.settings as object), ...body, stored: true }));
    const user = userEvent.setup();
    renderPage();
    const who = await card("Vem och hur");
    await user.click(within(who).getByRole("radio", { name: /^Alla som har länk eller kod/ }));
    await user.click(within(group("Klass")).getByRole("radio", { name: "Lista" }));
    await user.click(within(group("Elev")).getByRole("radio", { name: "Fritext-ID" }));
    await user.click(within(who).getByRole("button", { name: "Spara" }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("/api/v1/publication-settings", {
        viewerAudience: "EVERYONE",
        viewerClassMode: "LIST",
        viewerStudentMode: "CODE",
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Schemavisaren är sparad.");
  });

  it("holds a teacher back until the teacher is named, and says so before a save rather than after a refusal", async () => {
    const user = userEvent.setup();
    renderPage();
    const who = await card("Vem och hur");
    const teacher = group("Lärare");
    expect(within(teacher).getByRole("radio", { name: "Lista" })).toBeDisabled();
    expect(within(teacher).getByRole("radio", { name: "Fritext-ID" })).toBeDisabled();
    expect(within(teacher).getByRole("radio", { name: "Av" })).toBeEnabled();
    expect(screen.getByText(/Välj först hur läraren visas, nedan\./)).toBeInTheDocument();

    await user.selectOptions(within(who).getByRole("combobox", { name: "Läraren visas som" }), "SIGNATURE");
    expect(within(teacher).getByRole("radio", { name: "Fritext-ID" })).toBeEnabled();
    await user.click(within(teacher).getByRole("radio", { name: "Fritext-ID" }));
    expect(within(who).getByRole("button", { name: "Spara" })).toBeEnabled();

    // Turned back to nothing while teachers are shown: the combination the gateway refuses.
    await user.selectOptions(within(who).getByRole("combobox", { name: "Läraren visas som" }), "NONE");
    expect(within(who).getByText(/Lärare kan inte visas när läraren inte visas med signatur eller namn/)).toBeInTheDocument();
    expect(within(who).getByRole("button", { name: "Spara" })).toBeDisabled();
    await user.click(within(teacher).getByRole("radio", { name: "Av" }));
    expect(within(who).getByRole("button", { name: "Spara" })).toBeEnabled();
  });

  it("names the gateway's refusals in words", async () => {
    server.settings = { ...OPEN };
    put.mockRejectedValueOnce(new ApiError(400, "viewerStudentMode: …", "PUBLIC_STUDENTS_NOT_LISTED"));
    const user = userEvent.setup();
    renderPage();
    const who = await card("Vem och hur");
    await user.click(within(group("Sal")).getByRole("radio", { name: "Lista" }));
    await user.click(within(who).getByRole("button", { name: "Spara" }));
    expect(await within(who).findByRole("alert")).toHaveTextContent("En elevs schema visas bara med kod, aldrig i en lista");

    put.mockRejectedValueOnce(new ApiError(400, "publicTeacherDisplay: …", "PUBLIC_TEACHERS_UNNAMED"));
    await user.click(within(who).getByRole("button", { name: "Spara" }));
    expect(await within(who).findByRole("alert")).toHaveTextContent("Lärares veckor visar läraren som signatur eller namn.");
  });

  it("says the settings could not be read when the first read fails, and keeps them when a refetch fails", async () => {
    failFrom("/api/v1/publication-settings");
    renderPage();
    expect(
      await screen.findByRole("heading", { level: 2, name: "Inställningarna för Schemavisaren kunde inte hämtas" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Vem och hur" })).toBeNull();
  });

  it("keeps the settings it has read when a refetch fails, and says so above them", async () => {
    const { queryClient } = renderPage();
    await card("Vem och hur");
    failFrom("/api/v1/publication-settings");
    await act(() => queryClient.refetchQueries({ queryKey: PUBLICATION_KEYS.settings }));
    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("Inställningarna för Schemavisaren kunde inte hämtas");
    expect(notice).toHaveTextContent(sv.common.refetchFailedHint);
    expect(screen.getByRole("heading", { name: "Vem och hur" })).toBeInTheDocument();
  });

  it("marks every change as Publicering's, and keeps the choices on screen for a reader", async () => {
    renderPage();
    const who = await card("Vem och hur");
    const inert = (element: HTMLElement) => element.closest("[data-writes-inert]");
    expect(inert(within(who).getByRole("radio", { name: /^Alla som har länk eller kod/ }))).toHaveAttribute("data-writes-inert", "PUBLICERING");
    expect(inert(within(group("Klass")).getByRole("radio", { name: "Lista" }))).toHaveAttribute("data-writes-inert", "PUBLICERING");
    expect(inert(within(who).getByRole("combobox", { name: "Läraren visas som" }))).toHaveAttribute("data-writes-inert", "PUBLICERING");
    expect(inert(within(who).getByRole("spinbutton", { name: "Minsta gruppstorlek som visas med namn" }))).toHaveAttribute(
      "data-writes-inert",
      "PUBLICERING",
    );
    expect(inert(within(who).getByRole("switch", { name: "Måltider i klassens vecka" }))).toHaveAttribute("data-writes-inert", "PUBLICERING");
    expect(within(who).getByRole("button", { name: "Spara" })).toHaveAttribute("data-writes", "PUBLICERING");
  });
});

describe("/admin/schemavisaren › Dolda scheman", () => {
  beforeEach(() => {
    server.hiddenTeachers = ["t-bo"];
    server.hidden = { groups: [], rooms: [], students: ["p-bert"] };
  });

  it("lists the school's active teachers, the year's groups, the rooms and only the hidden pupils, each hidden as the gateway says", async () => {
    renderPage();
    const hidden = await card("Dolda scheman");
    expect(await within(hidden).findByRole("switch", { name: "Visa aldrig Bo Ek" })).toBeChecked();
    expect(within(hidden).getByRole("switch", { name: "Visa aldrig Anna Berg" })).not.toBeChecked();
    // An inactive teacher, and a group of another year, are not offered.
    expect(within(hidden).queryByRole("switch", { name: /Gammal/ })).toBeNull();
    expect(within(hidden).queryByRole("switch", { name: "Visa aldrig 6A" })).toBeNull();
    expect(within(hidden).getByRole("switch", { name: "Visa aldrig 7A" })).not.toBeChecked();
    expect(within(hidden).getByRole("switch", { name: "Visa aldrig Svenska 7" })).not.toBeChecked();
    expect(within(hidden).getByRole("switch", { name: "Visa aldrig Sal 12" })).not.toBeChecked();
    // A pupil is listed only once hidden.
    expect(within(hidden).getByRole("switch", { name: "Visa aldrig Bertil Ås" })).toBeChecked();
    expect(within(hidden).queryByRole("switch", { name: "Visa aldrig Ada Lind" })).toBeNull();
    expect(within(hidden).getByRole("heading", { name: /Lärare \(1 dold\)/ })).toBeInTheDocument();
    expect(within(hidden).getByRole("heading", { name: /Klasser och grupper \(ingen dold\)/ })).toBeInTheDocument();
  });

  it("hides a teacher, a class and a room, and shows a pupil again", async () => {
    put.mockResolvedValue({});
    const user = userEvent.setup();
    renderPage();
    const hidden = await card("Dolda scheman");
    await user.click(await within(hidden).findByRole("switch", { name: "Visa aldrig Anna Berg" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith("/api/v1/teacher-public-labels/t-anna", { hidden: true }));
    await user.click(within(hidden).getByRole("switch", { name: "Visa aldrig 7A" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith("/api/v1/viewer-hidden/group/g-7a", { hidden: true }));
    await user.click(within(hidden).getByRole("switch", { name: "Visa aldrig Sal 12" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith("/api/v1/viewer-hidden/room/r-12", { hidden: true }));
    await user.click(within(hidden).getByRole("switch", { name: "Visa aldrig Bertil Ås" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith("/api/v1/viewer-hidden/student/p-bert", { hidden: false }));
  });

  it("hides a pupil by class and then pupil, offering only the class's pupils who are not hidden already", async () => {
    put.mockResolvedValue({});
    const user = userEvent.setup();
    renderPage();
    const hidden = await card("Dolda scheman");
    const pupil = await within(hidden).findByRole("combobox", { name: "Elev" });
    expect(pupil).toBeDisabled();
    await user.selectOptions(within(hidden).getByRole("combobox", { name: "Klass" }), "g-7a");
    expect(within(pupil).getAllByRole("option").map((option) => option.textContent)).toEqual(["Välj elev", "Ada Lind"]);
    expect(within(hidden).getByRole("button", { name: "Dölj eleven" })).toBeDisabled();
    await user.selectOptions(pupil, "p-ada");
    expect(within(hidden).getByRole("button", { name: "Dölj eleven" })).toHaveAttribute("data-writes", "PUBLICERING");
    await user.click(within(hidden).getByRole("button", { name: "Dölj eleven" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith("/api/v1/viewer-hidden/student/p-ada", { hidden: true }));
  });

  it("marks the rows as Publicering's and the switches inert for the pointer of a reader", async () => {
    renderPage();
    const hidden = await card("Dolda scheman");
    const bo = (await within(hidden).findByRole("switch", { name: "Visa aldrig Bo Ek" })).closest("[data-writes-inert]");
    expect(bo).toHaveAttribute("data-writes-inert", "PUBLICERING");
    expect(bo).toHaveTextContent("Bo Ek");
  });

  it("draws no switch at all when a list could not be read: every one would read shown", async () => {
    failFrom("/api/v1/viewer-hidden");
    renderPage();
    const hidden = await card("Dolda scheman");
    expect(await within(hidden).findByText(/kunde inte hämtas/)).toBeInTheDocument();
    expect(within(hidden).queryAllByRole("switch")).toHaveLength(0);
  });
});

describe("/admin/schemavisaren › Koder och länkar", () => {
  beforeEach(() => {
    server.settings = { ...OPEN };
    server.links = [
      link({ id: "k-1", kind: "GROUP", targetId: "g-7a", lastUsedAt: "2026-10-09T06:00:00.000Z", embeddable: true }),
      link({ id: "k-2", kind: "ROOM", notShownBecause: "SCOPE_OFF" }),
      link({ id: "k-3", kind: "STUDENT", targetId: "p-ada", label: "Barn 1", notShownBecause: "PROTECTED" }),
      link({ id: "k-4", kind: "TEACHER", notShownBecause: "INDEX_NOT_LISTED" }),
    ];
  });

  it("lists the year's codes by what they show, and says why one shows nothing", async () => {
    renderPage();
    const links = await card("Koder och länkar 2026/27");
    expect(await within(links).findByRole("cell", { name: "7A Klass eller grupp" })).toBeInTheDocument();
    expect(within(links).getByRole("cell", { name: "Ada Lind Elev" })).toBeInTheDocument();
    expect(within(links).getByRole("cell", { name: "Lista Lärare" })).toBeInTheDocument();
    expect(within(links).getAllByText("Aktiv")).toHaveLength(1);
    expect(within(links).getByText("Visas inte: sorten står på Av, eller läraren visas inte med signatur eller namn")).toBeInTheDocument();
    expect(within(links).getByText("Visas inte: skyddad identitet")).toBeInTheDocument();
    expect(within(links).getByText("Visas inte: sorten står på Fritext-ID, inte på Lista")).toBeInTheDocument();
    expect(within(links).getByText("Kan bäddas in")).toBeInTheDocument();
    // The audience is not a reason of a link; for everyone there is no note about it.
    expect(within(links).queryByText(/bara öppen för inloggad personal/)).toBeNull();
  });

  it("says once, above the codes, that a viewer for staff works for nobody else", async () => {
    server.settings = { ...OPEN, viewerAudience: "STAFF" };
    renderPage();
    const links = await card("Koder och länkar 2026/27");
    expect(await within(links).findByText(/bara öppen för inloggad personal, så ingen kod eller länk fungerar för andra/)).toBeInTheDocument();
  });

  it("makes a pupil's code from a class and a pupil, with the page's title, and shows the code once as the gateway returned it", async () => {
    post.mockResolvedValueOnce({
      link: link({ id: "k-9", kind: "STUDENT", targetId: "p-ada", label: "Barn 2" }),
      token: "K7QM2-X9DRT-4V8WN-B5C3H",
    });
    const user = userEvent.setup();
    renderPage();
    const links = await card("Koder och länkar 2026/27");
    await user.selectOptions(await within(links).findByRole("combobox", { name: "Vad" }), "STUDENT");
    // Nothing to make until a pupil is chosen, and the pupils are the class's.
    expect(within(links).getByRole("button", { name: "Skapa kod" })).toBeDisabled();
    expect(within(links).getByRole("combobox", { name: "Vilken" })).toBeDisabled();
    await user.selectOptions(within(links).getByRole("combobox", { name: "Elevens klass" }), "g-7a");
    // Ada is hidden from nobody; Bertil is in the same class; Cia is in another year's.
    expect(
      within(within(links).getByRole("combobox", { name: "Vilken" })).getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["Välj elev", "Ada Lind", "Bertil Ås"]);
    await user.selectOptions(within(links).getByRole("combobox", { name: "Vilken" }), "p-ada");
    await user.type(within(links).getByRole("textbox", { name: /Egen benämning/ }), "Barn 2");
    expect(within(links).getByText(/Utan benämning heter sidan Elevens schema/)).toBeInTheDocument();
    await user.click(within(links).getByRole("button", { name: "Skapa kod" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/public-links", {
        academicYearId: "y26",
        kind: "STUDENT",
        targetId: "p-ada",
        label: "Barn 2",
      }),
    );
    expect(await within(links).findByRole("textbox", { name: "Koden" })).toHaveValue("K7QM2-X9DRT-4V8WN-B5C3H");
    expect(within(links).getByRole("textbox", { name: "Länkens adress" })).toHaveValue(`${window.location.origin}/v/K7QM2-X9DRT-4V8WN-B5C3H`);
    expect(within(links).getByText("Koden är skapad. Spara den nu, den visas inte igen.")).toBeInTheDocument();
    // A pupil's code is never framed: no embed code.
    expect(within(links).queryByRole("textbox", { name: "Inbäddningskod" })).toBeNull();
  });

  it("makes the list of teachers, with no label, and a class list that may be framed gets its embed code beside the code", async () => {
    post.mockResolvedValueOnce({ link: link({ id: "k-8", kind: "TEACHER" }), token: "A".repeat(20) });
    const user = userEvent.setup();
    renderPage();
    const links = await card("Koder och länkar 2026/27");
    await user.selectOptions(await within(links).findByRole("combobox", { name: "Vad" }), "TEACHER");
    expect(within(links).getByRole("combobox", { name: "Vilken" })).toHaveValue("index");
    expect(within(links).getByRole("textbox", { name: /Egen benämning/ })).toBeDisabled();
    await user.click(within(links).getByRole("button", { name: "Skapa kod" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/public-links", { academicYearId: "y26", kind: "TEACHER" }));

    post.mockResolvedValueOnce({
      link: link({ id: "k-7", kind: "GROUP", targetId: "g-7a", embeddable: true }),
      token: "B".repeat(20),
    });
    await user.selectOptions(within(links).getByRole("combobox", { name: "Vad" }), "GROUP");
    await user.selectOptions(within(links).getByRole("combobox", { name: "Vilken" }), "g-7a");
    await user.click(within(links).getByRole("button", { name: "Skapa kod" }));
    expect(await within(links).findByRole("textbox", { name: "Inbäddningskod" })).toHaveValue(
      `<iframe src="${window.location.origin}/v/${"B".repeat(20)}/embed" title="Schema – 7A" width="100%" height="680" style="border:0" loading="lazy" referrerpolicy="no-referrer"></iframe>`,
    );
  });

  it("never offers a hidden schedule, and a teacher is offered only while shown", async () => {
    server.hiddenTeachers = ["t-bo"];
    server.hidden = { groups: ["g-sv"], rooms: ["r-12"], students: [] };
    const user = userEvent.setup();
    renderPage();
    const links = await card("Koder och länkar 2026/27");
    const options = async (kind: string) => {
      await user.selectOptions(within(links).getByRole("combobox", { name: "Vad" }), kind);
      return within(within(links).getByRole("combobox", { name: "Vilken" })).getAllByRole("option").map((option) => option.textContent);
    };
    await waitFor(async () => expect(await options("GROUP")).toEqual(["Alla klasser och grupper (lista)", "7A"]));
    expect(await options("TEACHER")).toEqual(["Alla lärare (lista)", "Anna Berg"]);
    expect(await options("ROOM")).toEqual(["Alla salar (lista)"]);
  });

  it("tells, before a code is made, what the school's settings will make of it", async () => {
    server.settings = { ...OPEN, viewerRoomMode: "OFF", viewerTeacherMode: "CODE" };
    const user = userEvent.setup();
    renderPage();
    const links = await card("Koder och länkar 2026/27");
    await within(links).findByRole("combobox", { name: "Vad" });
    // A list of classes and groups: classes are on Lista, so nothing to say.
    expect(within(links).queryByText(/visar inget än|kräver att/)).toBeNull();
    await user.selectOptions(within(links).getByRole("combobox", { name: "Vad" }), "ROOM");
    expect(within(links).getByText('Koden visar inget än: "Sal" står på Av under Vem och hur.')).toBeInTheDocument();
    // Teachers are by code only, so a list of them shows nothing.
    await user.selectOptions(within(links).getByRole("combobox", { name: "Vad" }), "TEACHER");
    expect(within(links).getByText('En lista kräver att "Lärare" står på Lista under Vem och hur; nu står den på Fritext-ID.')).toBeInTheDocument();
    await user.selectOptions(within(links).getByRole("combobox", { name: "Vilken" }), "t-anna");
    expect(within(links).queryByText(/kräver att/)).toBeNull();
  });

  it("says that nothing is on when nothing is", async () => {
    server.settings = { ...SETTINGS };
    renderPage();
    const links = await card("Koder och länkar 2026/27");
    expect(await within(links).findByText("Koden visar inget än: ingen sorts schema är påslagen under Vem och hur.")).toBeInTheDocument();
  });

  it("revokes a code after saying it stops within a minute", async () => {
    post.mockResolvedValueOnce({});
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Återkalla koden till 7A" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Återkalla koden till 7A?");
    expect(dialog).toHaveTextContent("inom en minut");
    await user.click(within(dialog).getByRole("button", { name: "Återkalla" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/public-links/k-1/revoke"));
  });

  it("keeps the year's codes when a refetch fails, and says so above them", async () => {
    const { queryClient } = renderPage();
    const links = await card("Koder och länkar 2026/27");
    expect(await within(links).findByRole("cell", { name: "7A Klass eller grupp" })).toBeInTheDocument();
    failFrom("/api/v1/public-links");
    await act(() => queryClient.refetchQueries({ queryKey: PUBLICATION_KEYS.links }));
    const notice = await within(links).findByRole("alert");
    expect(notice).toHaveTextContent("Koderna kunde inte hämtas");
    expect(within(links).getByRole("cell", { name: "7A Klass eller grupp" })).toBeInTheDocument();
  });

  it("marks making and revoking as Publicering's, and a code's address as the one place to type it", async () => {
    renderPage();
    const links = await card("Koder och länkar 2026/27");
    expect(within(links).getByRole("button", { name: "Skapa kod" })).toHaveAttribute("data-writes", "PUBLICERING");
    expect(within(links).getByRole("combobox", { name: "Vad" }).closest("[data-writes]")).toHaveAttribute("data-writes", "PUBLICERING");
    expect((await within(links).findByRole("button", { name: "Återkalla koden till 7A" })).closest("[data-writes]")).toHaveAttribute(
      "data-writes",
      "PUBLICERING",
    );
    expect(await within(links).findByText(`Den som har en kod skriver in den på ${window.location.origin}/v, eller öppnar länken direkt.`)).toBeInTheDocument();
  });
});

describe("/admin/schemavisaren › Inbäddning", () => {
  beforeEach(() => {
    server.settings = { ...OPEN, publicEmbedOrigins: [] };
  });

  it("offers a kind only while the viewer is open to everyone and shows that kind, and says which it waits for", async () => {
    server.settings = { ...OPEN, viewerAudience: "STAFF" };
    const { unmount } = renderPage();
    const embed = await card("Inbäddning på skolans webbplats");
    expect(within(embed).getByText(/Inbäddning kräver att visaren är öppen för alla\. Välj Alla som har länk eller kod/)).toBeInTheDocument();
    expect(within(embed).getByRole("switch", { name: "Bädda in klasser och grupper" })).toBeDisabled();
    unmount();

    server.settings = { ...OPEN };
    renderPage();
    const open = await card("Inbäddning på skolans webbplats");
    expect(within(open).getByRole("switch", { name: "Bädda in klasser och grupper" })).toBeEnabled();
    // Teachers are shown (by code) so they can be framed; rooms are off, and say what to turn on.
    expect(within(open).getByRole("switch", { name: "Bädda in lärare" })).toBeEnabled();
    expect(within(open).getByRole("switch", { name: "Bädda in salar" })).toBeDisabled();
    expect(within(open).getByText("Slå först på sorten under Vem och hur.")).toBeInTheDocument();
    expect(within(open).queryByText(/Inbäddning kräver att visaren är öppen för alla\. Välj/)).toBeNull();
  });

  it("offers no pupil to embed: there is no such switch", async () => {
    renderPage();
    const embed = await card("Inbäddning på skolans webbplats");
    expect(within(embed).getAllByRole("switch").map((control) => control.getAttribute("aria-describedby"))).toEqual([
      "embed-publicEmbedGroups-hint",
      "embed-publicEmbedTeachers-hint",
      "embed-publicEmbedRooms-hint",
    ]);
  });

  it("saves only what changed, the websites as typed", async () => {
    put.mockImplementation(async (_path: string, body: object) => ({ ...(server.settings as object), ...body }));
    const user = userEvent.setup();
    renderPage();
    const embed = await card("Inbäddning på skolans webbplats");
    await user.click(within(embed).getByRole("switch", { name: "Bädda in klasser och grupper" }));
    // On, and no website yet: said, before saving.
    expect(within(embed).getByText(/ingen webbplats är angiven/)).toBeInTheDocument();
    await user.type(within(embed).getByRole("textbox", { name: /Webbplatser som får visa schemat/ }), "Skolan.se{Enter}https://www.skolan.se:8443");
    await user.click(within(embed).getByRole("button", { name: "Spara" }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("/api/v1/publication-settings", {
        publicEmbedGroups: true,
        publicEmbedOrigins: ["Skolan.se", "https://www.skolan.se:8443"],
      }),
    );
  });

  it("names a website the frame cannot take, and saves nothing until it is mended", async () => {
    const user = userEvent.setup();
    renderPage();
    const embed = await card("Inbäddning på skolans webbplats");
    await user.type(
      await within(embed).findByRole("textbox", { name: /Webbplatser som får visa schemat/ }),
      "http://skolan.se{Enter}https://skolan.se/schema",
    );
    expect(within(embed).getByText(/http:\/\/skolan\.se, https:\/\/skolan\.se\/schema/)).toBeInTheDocument();
    expect(within(embed).getByRole("button", { name: "Spara" })).toBeDisabled();
  });

  it("gives the code for an address the school already has, a code's too, and none for another site's", async () => {
    const user = userEvent.setup();
    renderPage();
    const embed = await card("Inbäddning på skolans webbplats");
    const field = await within(embed).findByRole("textbox", { name: /Inbäddningskod för en länk du redan har/ });
    await user.type(field, "https://schema.test.example/v/K7QM2-X9DRT-4V8WN-B5C3H");
    expect(within(embed).getByText("Det är ingen adress till Schemavisaren.")).toBeInTheDocument();
    await user.clear(field);
    await user.type(field, `${window.location.origin}/v/k7qm2-x9drt-4v8wn-b5c3h`);
    expect(within(embed).getByRole("textbox", { name: "Inbäddningskod" })).toHaveValue(
      `<iframe src="${window.location.origin}/v/K7QM2-X9DRT-4V8WN-B5C3H/embed" title="Schema" width="100%" height="680" style="border:0" loading="lazy" referrerpolicy="no-referrer"></iframe>`,
    );
  });
});

describe("/admin/schemavisaren › the page", () => {
  it("scopes the codes and the groups to the year chosen, the active one first", async () => {
    server.settings = { ...OPEN };
    const user = userEvent.setup();
    renderPage();
    const select = await screen.findByRole("combobox", { name: "Läsår" });
    expect(select).toHaveValue("y26");
    await screen.findByRole("heading", { name: "Koder och länkar 2026/27" });
    await user.selectOptions(select, "y25");
    expect(await screen.findByRole("heading", { name: "Koder och länkar 2025/26" })).toBeInTheDocument();
    await waitFor(() => expect(get).toHaveBeenCalledWith("/api/v1/public-links?academicYearId=y25"));
  });
});
