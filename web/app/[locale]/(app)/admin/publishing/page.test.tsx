import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { ApiError, api } from "@/lib/api";
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
  publicViewerEnabled: false,
  publicGroups: false,
  publicTeachers: false,
  publicRooms: false,
  publicTeacherDisplay: "NONE",
  publicShowMeals: true,
  publicMinGroupSize: 5,
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
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <PublishingPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
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
      link: { id: "k-2", academicYearId: "y26", kind: "GROUP", targetId: null, label: null, createdAt: "", revokedAt: null, lastUsedAt: null },
      token: "T".repeat(43),
    });
    const user = userEvent.setup();
    await openViewerTab(user);
    expect(await screen.findByRole("cell", { name: "7A" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Skapa länk" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/public-links", { academicYearId: "y26", kind: "GROUP" }),
    );
    expect(await screen.findByRole("textbox", { name: "Länkens adress" })).toHaveValue(`${window.location.origin}/v/${"T".repeat(43)}`);
  });

  it("revokes a link after saying it stops within a minute", async () => {
    post.mockResolvedValueOnce({});
    const user = userEvent.setup();
    await openViewerTab(user);
    await user.click(await screen.findByRole("button", { name: "Återkalla" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("inom en minut");
    await user.click(within(dialog).getByRole("button", { name: "Återkalla" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/public-links/k-1/revoke"));
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
