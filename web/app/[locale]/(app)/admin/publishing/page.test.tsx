import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { ApiError, api } from "@/lib/api";
import { PUBLICATION_KEYS } from "@/lib/publication-keys";
import type { PublicationSettings, PublicationTimeline } from "@/lib/publication-types";
import PublishingPage from "./page";

/**
 * /admin/publishing over the real hooks and the real Swedish messages (an
 * untranslated key or an unfilled ICU argument throws), with the gateway
 * answering by path. What only this page decides: which switch it offers and
 * what a refused switch says, that the policy and the viewer send only what
 * was changed, which segment is valid today, the refill's "Fyll på ändå"
 * after the lunch warning, and that a share link's address is shown once.
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
    data: [{ id: "y26", name: "2026/27", startDate: "2026-08-17", endDate: "2027-06-11", isActive: true, predecessorId: null }],
  }),
  useGroups: () => ({
    data: [
      { id: "g-7a", academicYearId: "y26", name: "7A", kind: "CLASS", gradeLevel: 7 },
      { id: "g-old", academicYearId: "y25", name: "6A", kind: "CLASS", gradeLevel: 6 },
    ],
  }),
  usePeople: () => ({
    data: [
      { id: "t-anna", role: "TEACHER", firstName: "Anna", lastName: "Berg", isActive: true },
      { id: "t-bo", role: "TEACHER", firstName: "Bo", lastName: "Ek", isActive: true },
      { id: "p-1", role: "STUDENT", firstName: "Ada", lastName: "Lind", isActive: true },
    ],
  }),
  useRooms: () => ({ data: [{ id: "r-12", name: "Sal 12" }] }),
  useSubjects: () => ({ data: [] }),
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
  publicViewerEnabled: false,
  publicGroups: false,
  publicTeachers: false,
  publicRooms: false,
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

const publication = (id: string, kind: string, validFrom: string, validTo: string) => ({
  id,
  kind,
  outcome: "PUBLISHED",
  publishMode: "DRAFT",
  validFrom,
  validTo,
  publishedAt: `${validFrom}T07:00:00.000Z`,
  publishedByUserId: null,
  created: 400,
  cancelled: 2,
  skipped: 0,
  moved: 0,
  removed: 0,
  adopted: 0,
  lessonCount: 40,
  gates: [{ code: "PUB_NO_ROOM", severity: "WARN", count: 1, items: [], params: {} }],
  acknowledgedWarnings: true,
});

const TIMELINE: PublicationTimeline = {
  academicYearId: "y26",
  today: "2026-10-10",
  publications: [
    publication("ht", "BASELINE", "2026-08-17", "2027-06-11"),
    publication("vt", "PUBLISH", "2027-01-11", "2027-06-11"),
  ] as PublicationTimeline["publications"],
  segments: [
    { publicationId: "ht", from: "2026-08-17", to: "2027-01-10" },
    { publicationId: "vt", from: "2027-01-11", to: "2027-06-11" },
  ],
  validNow: "ht",
};

const server = vi.hoisted(() => ({ settings: null as unknown, links: [] as unknown[], hidden: [] as string[], draft: null as unknown }));

function answer() {
  get.mockImplementation(async (path: string) => {
    if (path === "/api/v1/publication-settings") return server.settings;
    if (path.startsWith("/api/v1/publications/state")) return server.draft;
    if (path.startsWith("/api/v1/publications")) return TIMELINE;
    if (path.startsWith("/api/v1/public-links")) return server.links;
    if (path === "/api/v1/teacher-public-labels") return server.hidden;
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
          <PublishingPage />
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

describe("/admin/publishing", () => {
  beforeEach(() => {
    // reset, not clear: a row that fails before its queued answer is used
    // must not hand that answer to the next row.
    vi.resetAllMocks();
    server.settings = { ...SETTINGS };
    server.links = [];
    server.hidden = [];
    server.draft = {
      academicYearId: "y26",
      publishMode: "DRAFT",
      publicationId: "ht",
      added: [],
      changed: [],
      removed: [],
      pendingRemovals: 0,
    };
    answer();
  });

  it("says a school that never switched publishes directly, and lists which publication is valid when", async () => {
    renderPage();
    expect(await screen.findByText("Direkt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Byt till utkastläge" })).toBeInTheDocument();
    const rows = (await screen.findAllByRole("row")).map((row) => row.textContent);
    expect(rows).toContain("2026-08-172027-01-10Utgångsläge2026-08-17Gäller nu");
    expect(rows).toContain("2027-01-112027-06-11Publicering2027-01-11Kommande");
    // No draft actions in direct mode.
    expect(screen.queryByRole("button", { name: "Kassera utkast" })).toBeNull();
    expect(screen.queryByText("Fyll på publicerat schema")).toBeNull();
  });

  it("switches to utkastläge after a confirmation, and says why the way back is refused", async () => {
    const user = userEvent.setup();
    post.mockImplementationOnce(async () => {
      server.settings = { ...SETTINGS, publishMode: "DRAFT", stored: true };
      return { publishMode: "DRAFT", baselines: [] };
    });
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Byt till utkastläge" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Byt till utkastläge" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/publication-settings/mode", { publishMode: "DRAFT" }));

    post.mockRejectedValueOnce(new ApiError(409, "Utkastet för 2026/27 skiljer sig …", "PUBLISH_DRAFT_PENDING", { year: "2026/27" }));
    await user.click(await screen.findByRole("button", { name: "Byt till direkt publicering" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Byt till direkt publicering" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Utkastet skiljer sig från det publicerade schemat. Publicera utkastet från i dag till läsårets slut",
    );
  });

  it("refills the published timetable from today, and asks again when lunch is not set", async () => {
    server.settings = { ...SETTINGS, publishMode: "DRAFT", stored: true };
    post
      .mockRejectedValueOnce(new ApiError(409, "…", "PUBLISH_WARNINGS_UNACKNOWLEDGED", { warnings: "PUB_LUNCH_NOT_SET" }))
      .mockResolvedValueOnce({ result: { created: 12, cancelled: 0, skipped: 3 }, gates: [], publicationId: "r" });
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText("Utkastet är detsamma som det publicerade schemat.")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Fyll på" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/publications/refill", {
        academicYearId: "y26",
        validFrom: "2026-10-10",
        validTo: "2027-06-11",
      }),
    );
    // The warning is named before it can be acknowledged.
    expect(await screen.findByRole("status")).toHaveTextContent("Lunch är inte inställd");
    await user.click(await screen.findByRole("button", { name: "Fyll på ändå" }));
    await waitFor(() =>
      expect(post).toHaveBeenLastCalledWith("/api/v1/publications/refill", {
        academicYearId: "y26",
        validFrom: "2026-10-10",
        validTo: "2027-06-11",
        acknowledgeWarnings: true,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("12 lektioner skrevs i kalendern.");
  });

  it("forgets an acknowledgement when the refill's range changes", async () => {
    server.settings = { ...SETTINGS, publishMode: "DRAFT", stored: true };
    post.mockRejectedValueOnce(new ApiError(409, "…", "PUBLISH_WARNINGS_UNACKNOWLEDGED", { warnings: "PUB_LUNCH_NOT_SET" }));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Fyll på" }));
    expect(await screen.findByRole("button", { name: "Fyll på ändå" })).toBeInTheDocument();
    const to = screen.getByRole("textbox", { name: "Giltig t.o.m." });
    await user.clear(to);
    await user.type(to, "2027-05-31");
    expect(await screen.findByRole("button", { name: "Fyll på" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fyll på ändå" })).toBeNull();
  });

  it("discards a pending draft after a confirmation that names the safety version", async () => {
    server.settings = { ...SETTINGS, publishMode: "DRAFT", stored: true };
    server.draft = { ...(server.draft as object), removed: [{ id: "l" }] };
    post.mockResolvedValueOnce({ restored: 1, removed: 0, safetyVersionId: "v" });
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText("1 ändring i grundschemat väntar på att publiceras.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Kassera utkast" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Före kasserat utkast");
    await user.click(within(dialog).getByRole("button", { name: "Kassera utkast" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/publications/discard", { academicYearId: "y26" }));
  });

  it("says the settings could not be read when the first read fails", async () => {
    failFrom("/api/v1/publication-settings");
    renderPage();
    expect(
      await screen.findByRole("heading", { level: 2, name: "Publiceringsinställningarna kunde inte hämtas" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Publicering" })).toBeNull();
  });

  it("keeps the settings it has read when a refetch fails, and says so above them", async () => {
    const { queryClient } = renderPage();
    expect(await screen.findByText("Direkt")).toBeInTheDocument();

    failFrom("/api/v1/publication-settings");
    await act(() => queryClient.refetchQueries({ queryKey: PUBLICATION_KEYS.settings }));

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("Publiceringsinställningarna kunde inte hämtas");
    expect(notice).toHaveTextContent(sv.common.refetchFailedHint);
    expect(screen.getByText("Direkt")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Publicering" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "Publiceringsinställningarna kunde inte hämtas" })).toBeNull();
  });

  it("marks each write with the areas its route names, and keeps the checks' choices on screen without a pointer", async () => {
    server.settings = { ...SETTINGS, publishMode: "DRAFT", stored: true };
    server.draft = { ...(server.draft as object), removed: [{ id: "l" }] };
    const user = userEvent.setup();
    renderPage();
    // POST /publication-settings/mode and PUT /publication-settings: Publicering's.
    expect(await screen.findByRole("button", { name: "Byt till direkt publicering" })).toHaveAttribute("data-writes", "PUBLICERING");
    expect(screen.getByRole("button", { name: "Spara" })).toHaveAttribute("data-writes", "PUBLICERING");
    expect(screen.getByRole("combobox", { name: "Krockar (lärare, sal, grupp, tillgänglighet)" })).toHaveAttribute(
      "data-writes-inert",
      "PUBLICERING",
    );
    // POST /publications (the review's preview too) and /publications/refill: the class's two areas.
    expect(screen.getByRole("button", { name: "Granska och publicera utkastet" })).toHaveAttribute("data-writes", "PUBLICERING DRIFT");
    expect(screen.getByRole("region", { name: "Fyll på publicerat schema" })).toHaveAttribute("data-writes", "PUBLICERING DRIFT");
    // POST /publications/discard puts the grundschema back: Schemaläggning's as well.
    expect(await screen.findByRole("button", { name: "Kassera utkast" })).toHaveAttribute(
      "data-writes",
      "PUBLICERING SCHEMALAGGNING DRIFT",
    );
    // The log is read.
    const log = await screen.findByRole("button", { name: "Logg (2)" });
    expect(log).not.toHaveAttribute("data-writes");
    await user.click(screen.getByRole("button", { name: "Granska och publicera utkastet" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Publicera" })).toHaveAttribute("data-writes", "PUBLICERING DRIFT");
  });

  it("saves only the checks that were changed", async () => {
    put.mockResolvedValueOnce({ ...SETTINGS, gateClashes: "REFUSE", stored: true });
    const user = userEvent.setup();
    renderPage();
    const trigger = await screen.findByRole("combobox", { name: "Krockar (lärare, sal, grupp, tillgänglighet)" });
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "Stoppar" }));
    await user.click(screen.getByRole("button", { name: "Spara" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith("/api/v1/publication-settings", { gateClashes: "REFUSE" }));
  });
});

describe("/admin/publishing › Schemavisaren", () => {
  beforeEach(() => {
    // reset, not clear: a row that fails before its queued answer is used
    // must not hand that answer to the next row.
    vi.resetAllMocks();
    server.settings = { ...SETTINGS, publicViewerEnabled: true, publicGroups: true };
    server.links = [
      {
        id: "k-1",
        academicYearId: "y26",
        kind: "GROUP",
        targetId: "g-7a",
        label: null,
        createdAt: "2026-10-01T08:00:00.000Z",
        revokedAt: null,
        lastUsedAt: "2026-10-09T06:00:00.000Z",
        notShownBecause: null,
      },
      {
        id: "k-3",
        academicYearId: "y26",
        kind: "ROOM",
        targetId: null,
        label: null,
        createdAt: "2026-10-01T08:00:00.000Z",
        revokedAt: null,
        lastUsedAt: null,
        notShownBecause: "SCOPE_OFF",
      },
    ];
    server.hidden = ["t-bo"];
    answer();
  });

  const openViewerTab = async (user: ReturnType<typeof userEvent.setup>) => {
    renderPage();
    await user.click(await screen.findByRole("tab", { name: "Schemavisaren" }));
  };

  it("names the gateway's refusal of teachers shown as nothing", async () => {
    put.mockRejectedValueOnce(new ApiError(400, "publicTeacherDisplay: …", "PUBLIC_TEACHERS_UNNAMED"));
    const user = userEvent.setup();
    await openViewerTab(user);
    await user.click(await screen.findByRole("switch", { name: "Lärare" }));
    await user.click(screen.getAllByRole("button", { name: "Spara" })[0]!);
    await waitFor(() => expect(put).toHaveBeenCalledWith("/api/v1/publication-settings", { publicTeachers: true }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Lärares veckor visar läraren som signatur eller namn.");
  });

  it("shows a new link's address once, and lists the year's links by what they show", async () => {
    post.mockResolvedValueOnce({
      link: { id: "k-2", academicYearId: "y26", kind: "GROUP", targetId: null, label: null, createdAt: "", revokedAt: null, lastUsedAt: null, notShownBecause: null },
      token: "T".repeat(43),
    });
    const user = userEvent.setup();
    await openViewerTab(user);
    // The link's cell names its target, then its kind: the kind's own column
    // gives way on a phone and the line under the name carries it there.
    expect(await screen.findByRole("cell", { name: "7A Klass eller grupp" })).toBeInTheDocument();
    // A link that answers says so; one the viewer refuses says why, never "Aktiv".
    expect(screen.getAllByText("Aktiv")).toHaveLength(1);
    expect(screen.getByText("Visas inte: den här sortens länk är avstängd")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Skapa länk" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/public-links", { academicYearId: "y26", kind: "GROUP" }),
    );
    expect(await screen.findByRole("textbox", { name: "Länkens adress" })).toHaveValue(`${window.location.origin}/v/${"T".repeat(43)}`);
  });

  it("keeps the year's links when a refetch fails, and says so above them", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderPage();
    await user.click(await screen.findByRole("tab", { name: "Schemavisaren" }));
    expect(await screen.findByRole("cell", { name: "7A Klass eller grupp" })).toBeInTheDocument();

    failFrom("/api/v1/public-links");
    await act(() => queryClient.refetchQueries({ queryKey: PUBLICATION_KEYS.links }));

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("Länkarna kunde inte hämtas");
    expect(notice).toHaveTextContent(sv.common.refetchFailedHint);
    expect(screen.getByRole("cell", { name: "7A Klass eller grupp" })).toBeInTheDocument();
  });

  it("revokes a link after saying it stops within a minute", async () => {
    post.mockResolvedValueOnce({});
    const user = userEvent.setup();
    await openViewerTab(user);
    // The row's button names the link it revokes (a row action), and so does
    // the question it opens; the confirm itself is still the bare verb.
    await user.click(await screen.findByRole("button", { name: "Återkalla länken till 7A" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Återkalla länken till 7A?");
    expect(dialog).toHaveTextContent("inom en minut");
    await user.click(within(dialog).getByRole("button", { name: "Återkalla" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/public-links/k-1/revoke"));
  });

  it("keeps Schemavisaren's settings, links and hidden teachers on screen for a reader, and marks every change as Publicering's", async () => {
    const user = userEvent.setup();
    await openViewerTab(user);
    const viewer = (await screen.findByRole("heading", { name: "Schemavisaren" })).closest("section") as HTMLElement;
    // Rows and fields, labels and all: a press on a label presses its control.
    const inert = (element: HTMLElement) => element.closest("[data-writes-inert]");
    expect(inert(within(viewer).getByRole("switch", { name: "Lärare" }))).toHaveAttribute("data-writes-inert", "PUBLICERING");
    expect(inert(within(viewer).getByRole("combobox", { name: "Läraren visas som" }))).toHaveAttribute(
      "data-writes-inert",
      "PUBLICERING",
    );
    expect(inert(within(viewer).getByRole("spinbutton", { name: "Minsta gruppstorlek som visas med namn" }))).toHaveAttribute(
      "data-writes-inert",
      "PUBLICERING",
    );
    expect(within(viewer).getByRole("button", { name: "Spara" })).toHaveAttribute("data-writes", "PUBLICERING");
    const embed = screen.getByRole("heading", { name: "Inbäddning på skolans webbplats" }).closest("section") as HTMLElement;
    expect(inert(within(embed).getByRole("switch", { name: "Bädda in klasser och grupper" }))).toHaveAttribute(
      "data-writes-inert",
      "PUBLICERING",
    );
    // The sites stay scrollable: a reader gets them read-only (useReadOnly), not inert.
    expect(within(embed).getByRole("textbox", { name: /Webbplatser som får visa schemat/ })).not.toHaveAttribute(
      "data-writes-inert",
    );
    expect(within(embed).getByRole("button", { name: "Spara" })).toHaveAttribute("data-writes", "PUBLICERING");
    // The code for a link one already has writes nothing.
    expect(within(embed).getByRole("textbox", { name: /Inbäddningskod för en länk du redan har/ }).closest("[data-writes],[data-writes-inert]")).toBeNull();
    // A new link and a revocation: POST /public-links, POST /public-links/:id/revoke.
    expect(screen.getByRole("button", { name: "Skapa länk" })).toHaveAttribute("data-writes", "PUBLICERING");
    expect(screen.getByRole("combobox", { name: "Vad" }).closest("[data-writes]")).toHaveAttribute("data-writes", "PUBLICERING");
    expect((await screen.findByRole("button", { name: "Återkalla länken till 7A" })).closest("[data-writes]")).toHaveAttribute(
      "data-writes",
      "PUBLICERING",
    );
    expect(screen.getByRole("cell", { name: "7A Klass eller grupp" }).closest("[data-writes]")).toBeNull();
    // Who is never shown is read; the switch is PUT /teacher-public-labels/:id.
    const bo = inert(await screen.findByRole("switch", { name: "Visa aldrig Bo Ek" }));
    expect(bo).toHaveAttribute("data-writes-inert", "PUBLICERING");
    expect(bo).toHaveTextContent("Bo Ek");
  });

  it("never offers a hidden teacher a link, and hides a teacher with one switch", async () => {
    put.mockResolvedValueOnce({ userId: "t-anna", hidden: true });
    const user = userEvent.setup();
    await openViewerTab(user);
    expect(await screen.findByRole("switch", { name: "Visa aldrig Bo Ek" })).toBeChecked();
    await user.click(screen.getByRole("switch", { name: "Visa aldrig Anna Berg" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith("/api/v1/teacher-public-labels/t-anna", { hidden: true }));

    await user.click(screen.getByRole("combobox", { name: "Vad" }));
    await user.click(await screen.findByRole("option", { name: "Lärare" }));
    await user.click(screen.getByRole("combobox", { name: "Vilken" }));
    const options = (await screen.findAllByRole("option")).map((option) => option.textContent);
    expect(options).toEqual(["Anna Berg"]);
  });
});

describe("/admin/publishing › Inbäddning", () => {
  const TOKEN = "T".repeat(43);
  beforeEach(() => {
    vi.resetAllMocks();
    server.settings = { ...SETTINGS, publicViewerEnabled: true, publicGroups: true };
    server.links = [
      {
        id: "k-1",
        academicYearId: "y26",
        kind: "GROUP",
        targetId: "g-7a",
        label: null,
        createdAt: "2026-10-01T08:00:00.000Z",
        revokedAt: null,
        lastUsedAt: null,
        notShownBecause: null,
        embeddable: true,
      },
    ];
    server.hidden = [];
    answer();
  });

  const openViewerTab = async (user: ReturnType<typeof userEvent.setup>) => {
    renderPage();
    await user.click(await screen.findByRole("tab", { name: "Schemavisaren" }));
  };

  it("offers a kind's embedding only while the viewer shows that kind, and saves only what changed", async () => {
    put.mockImplementation(async (_path: string, body: object) => ({ ...(server.settings as object), ...body }));
    const user = userEvent.setup();
    await openViewerTab(user);
    expect(await screen.findByRole("switch", { name: "Bädda in lärare" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Bädda in salar" })).toBeDisabled();
    await user.click(screen.getByRole("switch", { name: "Bädda in klasser och grupper" }));
    // On, and no website yet: said, before saving.
    expect(screen.getByText(/ingen webbplats är angiven/)).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: /Webbplatser som får visa schemat/ }), "Skolan.se{Enter}https://www.skolan.se:8443{Enter}skolgården.se");
    const card = screen.getByRole("heading", { name: "Inbäddning på skolans webbplats" }).closest("section") as HTMLElement;
    await user.click(within(card).getByRole("button", { name: "Spara" }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("/api/v1/publication-settings", {
        publicEmbedGroups: true,
        publicEmbedOrigins: ["Skolan.se", "https://www.skolan.se:8443", "skolgården.se"],
      }),
    );
  });

  it("marks the links that may be framed as the saved settings say, without a reload", async () => {
    server.links = [{ ...(server.links[0] as object), embeddable: false }];
    put.mockImplementation(async (_path: string, body: object) => {
      // The gateway works the mark out when the list is read, from the settings just saved.
      server.links = [{ ...(server.links[0] as object), embeddable: true }];
      return { ...(server.settings as object), ...body };
    });
    const user = userEvent.setup();
    await openViewerTab(user);
    await user.click(await screen.findByRole("switch", { name: "Bädda in klasser och grupper" }));
    await user.type(screen.getByRole("textbox", { name: /Webbplatser som får visa schemat/ }), "https://www.skolan.se");
    expect(screen.queryByText("Kan bäddas in")).not.toBeInTheDocument();
    const card = screen.getByRole("heading", { name: "Inbäddning på skolans webbplats" }).closest("section") as HTMLElement;
    await user.click(within(card).getByRole("button", { name: "Spara" }));
    expect(await screen.findByText("Kan bäddas in")).toBeInTheDocument();
  });

  it("names a website the frame cannot take, and saves nothing until it is mended", async () => {
    const user = userEvent.setup();
    await openViewerTab(user);
    await user.type(
      await screen.findByRole("textbox", { name: /Webbplatser som får visa schemat/ }),
      "http://skolan.se{Enter}https://skolan.se/schema{Enter}https://skolan.se:65536",
    );
    expect(screen.getByText(/http:\/\/skolan\.se, https:\/\/skolan\.se\/schema, https:\/\/skolan\.se:65536/)).toBeInTheDocument();
    const card = screen.getByRole("heading", { name: "Inbäddning på skolans webbplats" }).closest("section") as HTMLElement;
    expect(within(card).getByRole("button", { name: "Spara" })).toBeDisabled();
  });

  it("gives the code for a link the school already has, and none for an address of another site", async () => {
    const user = userEvent.setup();
    await openViewerTab(user);
    const field = await screen.findByRole("textbox", { name: /Inbäddningskod för en länk du redan har/ });
    await user.type(field, `https://schema.test.example/v/${TOKEN}`);
    expect(screen.getByText("Det är ingen adress till Schemavisaren.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Inbäddningskod" })).not.toBeInTheDocument();
    await user.clear(field);
    await user.type(field, `${window.location.origin}/v/${TOKEN}`);
    expect(screen.getByRole("textbox", { name: "Inbäddningskod" })).toHaveValue(
      `<iframe src="${window.location.origin}/v/${TOKEN}/embed" title="Schema" width="100%" height="680" style="border:0" loading="lazy" referrerpolicy="no-referrer"></iframe>`,
    );
  });

  it("shows a new link's embed code beside its address when its kind may be embedded, and marks the links that may", async () => {
    post.mockResolvedValueOnce({
      link: { id: "k-2", academicYearId: "y26", kind: "GROUP", targetId: "g-7a", label: null, createdAt: "", revokedAt: null, lastUsedAt: null, notShownBecause: null, embeddable: true },
      token: TOKEN,
    });
    const user = userEvent.setup();
    await openViewerTab(user);
    expect(await screen.findByText("Kan bäddas in")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Skapa länk" }));
    const code = await screen.findByRole("textbox", { name: "Inbäddningskod" });
    expect(code).toHaveValue(
      `<iframe src="${window.location.origin}/v/${TOKEN}/embed" title="Schema – 7A" width="100%" height="680" style="border:0" loading="lazy" referrerpolicy="no-referrer"></iframe>`,
    );
  });

  it("leads to the print set from the page's header", async () => {
    renderPage();
    expect(await screen.findByText("Skriv ut scheman")).toBeInTheDocument();
  });
});
