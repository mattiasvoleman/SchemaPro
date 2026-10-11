import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { ApiError, api } from "@/lib/api";
import IntegrationsPage from "./page";
import type { ProviderKey, SourceView, SyncChange, SyncRun } from "./ss12000-types";

// Radix's Switch measures its thumb; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/**
 * /admin/integrations over the real hooks and the real Swedish messages (an
 * untranslated key or an unfilled ICU argument throws), with the gateway
 * answering by path. What only this page decides: that a credential is
 * write-only on screen too, that a change of register or skolenhet over
 * linked people is confirmed before it is sent, that the history says why a
 * run failed in words and never in the far side's, that the review applies
 * exactly what the admin chose (and nothing until every change is loaded),
 * that a guardian the register dropped holds the apply until the admin has
 * seen it, that the brake and a stale basis are answered, and that a new
 * key's scopes, its signing secret and its subscriptions are what the
 * gateway is sent.
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } };
});
const get = api.get as unknown as Mock;
const post = api.post as unknown as Mock;
const put = api.put as unknown as Mock;
const patch = api.patch as unknown as Mock;

vi.mock("@/lib/queries", () => ({
  usePeople: () => ({
    data: [
      { id: "u-pupil", role: "STUDENT", firstName: "Ada", lastName: "Lind", isActive: true },
      { id: "u-bo", role: "TEACHER", firstName: "Bo", lastName: "Ek", isActive: true },
    ],
  }),
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, href, className }: { children: React.ReactNode; href: string; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const SOURCE: SourceView = {
  id: "src-1",
  name: "IST",
  baseUrl: "https://api.ist.example/ss12000v2-api/source/abc/v2.0",
  authKind: "OAUTH2_CLIENT_CREDENTIALS",
  tokenUrl: "https://skolid.example/connect/token",
  clientId: "schemapro",
  tokenScope: null,
  tokenAuthStyle: "BASIC",
  organisationIds: [],
  schoolUnitCodes: [],
  pageSize: 1000,
  enabled: true,
  scheduleEnabled: false,
  scheduleAutoApply: false,
  scheduleHourLocal: 2,
  fullEveryDays: 7,
  incrementalUnsupported: false,
  modifiedCursor: null,
  deletedCursor: null,
  lastFullAt: null,
  lastAppliedAt: null,
  lastTestedAt: null,
  lastTestOutcome: null,
  secrets: {},
};

const run = (over: Partial<SyncRun>): SyncRun => ({
  id: "run-1",
  trigger: "MANUAL",
  mode: "FULL",
  status: "DIFF_READY",
  statusCode: null,
  startedAt: "2026-10-10T08:00:00.000Z",
  fetchedAt: "2026-10-10T08:00:20.000Z",
  finishedAt: null,
  appliedAt: null,
  autoApplied: false,
  counts: { PERSON: { fetched: 300, CREATE: 2, RELINK: 1 }, GROUP: { fetched: 12 }, RESPONSIBLE: { CONFLICT: 1 } },
  errors: [],
  basisHash: "a".repeat(64),
  autoApplyBlockedReason: null,
  ...over,
});

let seq = 0;
const change = (over: Partial<SyncChange>): SyncChange => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
  seq,
  entity: "PERSON",
  op: "CREATE",
  externalId: null,
  localId: null,
  before: null,
  after: null,
  conflictCode: null,
  selected: true,
  autoApplicable: false,
  protectedIdentity: false,
  applied: false,
  ...over,
});

const CREATE_CIA = change({ externalId: "ext-cia", after: { role: "STUDENT", firstName: "Cia", lastName: "Holm", email: "cia@skola.se" } });
const CREATE_DAN = change({ externalId: "ext-dan", after: { role: "STUDENT", firstName: "Dan", lastName: "Åberg", email: "dan@skola.se" } });
const RELINK_EVA = change({
  op: "RELINK",
  externalId: "ext-eva",
  localId: "u-eva",
  selected: false,
  conflictCode: "PERSON_MATCHES_INACTIVE",
  before: { isActive: false, firstName: "Eva", lastName: "Sund", email: "eva@skola.se" },
  after: { ss12000Id: "ext-eva", isActive: true, firstName: "Eva", lastName: "Sund" },
});
const GUARDIAN_ENDED = change({
  entity: "RESPONSIBLE",
  op: "CONFLICT",
  selected: false,
  conflictCode: "RESPONSIBLE_ENDED_AT_SOURCE",
  externalId: "ext-ada",
  localId: "u-pupil",
  after: { guardianLocalId: "u-gun", guardianName: "Gun Berg", origin: "MANUAL" },
});

const KEY: ProviderKey = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Vklass",
  scopes: ["ss12000.v1", "ss12000.v1.import"],
  lastUsedAt: null,
  revokedAt: null,
  createdAt: "2026-09-01T08:00:00.000Z",
  webhookSecret: null,
  subscriptions: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Vklass schema",
      targetHost: "hooks.vklass.example",
      resourceTypes: ["CalendarEvent"],
      expiresAt: "2099-01-01T00:00:00.000Z",
      suspendedAt: null,
      suspendedReason: null,
      lastNotifiedAt: null,
      failingSince: null,
      attempts: 0,
      createdAt: "2026-09-02T08:00:00.000Z",
    },
  ],
};

const server = vi.hoisted(() => ({
  source: null as unknown,
  runs: [] as unknown[],
  pages: [] as unknown[],
  provisioning: [] as unknown[],
  keys: [] as unknown[],
}));

function answer() {
  get.mockImplementation(async (path: string) => {
    if (path === "/api/v1/ss12000-source") {
      if (server.source === null) throw new ApiError(404, "Skolan har inget källsystem.", "SS12000_SOURCE_NOT_FOUND");
      return server.source;
    }
    if (path.startsWith("/api/v1/ss12000-sync/runs?")) return server.runs;
    if (path.startsWith("/api/v1/ss12000-sync/runs/")) {
      const cursor = /cursor=(\d+)/.exec(path)?.[1];
      return cursor ? server.pages[1] : server.pages[0];
    }
    if (path === "/api/v1/ss12000-sync/provisioning") return server.provisioning;
    if (path === "/api/v1/integration-keys/provider") return server.keys;
    throw new Error(`unexpected GET ${path}`);
  });
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <IntegrationsPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe("/admin/integrations — the register", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    server.source = null;
    server.runs = [];
    server.pages = [{ data: [], nextCursor: null }];
    server.provisioning = [];
    server.keys = [];
    answer();
  });

  it("offers a school without a source the form, and saves the configuration with no credential in it", async () => {
    const user = userEvent.setup();
    put.mockResolvedValueOnce({ ...SOURCE });
    renderPage();
    await user.type(await screen.findByLabelText("Namn"), "IST");
    const base = screen.getByLabelText("Adress till registrets API");
    await user.type(base, "http://api.ist.example/v2.0");
    expect(screen.getByText("Adressen måste börja med https://.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Spara källsystem" })).toBeDisabled();
    await user.clear(base);
    await user.type(base, SOURCE.baseUrl);
    await user.type(screen.getByLabelText("Tokenadress"), SOURCE.tokenUrl!);
    await user.type(screen.getByLabelText("Klient-id"), "schemapro");
    // Nothing else is offered until the source exists: no sync, no schedule.
    expect(screen.queryByRole("button", { name: "Synka nu" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Spara källsystem" }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("/api/v1/ss12000-source", {
        name: "IST",
        baseUrl: SOURCE.baseUrl,
        authKind: "OAUTH2_CLIENT_CREDENTIALS",
        tokenUrl: SOURCE.tokenUrl,
        clientId: "schemapro",
        tokenScope: null,
        tokenAuthStyle: "BASIC",
        pageSize: 1000,
        enabled: true,
      }),
    );
    // Saved, the source answers with itself and the rest of the tab appears.
    expect(await screen.findByRole("button", { name: "Testa anslutning" })).toBeInTheDocument();
  });

  it("keeps a credential write-only: the field empties once sent, and only when it was set comes back", async () => {
    const user = userEvent.setup();
    server.source = { ...SOURCE };
    put.mockImplementationOnce(async () => {
      server.source = { ...SOURCE, secrets: { CLIENT_SECRET: { setAt: "2026-10-10T09:00:00.000Z" } } };
      return { kind: "CLIENT_SECRET", setAt: "2026-10-10T09:00:00.000Z" };
    });
    renderPage();
    const field = await screen.findByLabelText("Klienthemlighet");
    expect(field).toHaveAttribute("type", "password");
    expect(screen.getByText("Saknas")).toBeInTheDocument();
    await user.type(field, "hemligt-123");
    const row = field.closest("form") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Spara" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith("/api/v1/ss12000-source/secrets/CLIENT_SECRET", { value: "hemligt-123" }));
    await waitFor(() => expect(screen.getByLabelText("Klienthemlighet")).toHaveValue(""));
    expect(await screen.findByText(/^Sparad /)).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("hemligt-123");
    expect(screen.getByRole("button", { name: "Ersätt" })).toBeDisabled();
  });

  it("lists the source's skolenheter after a test, and asks before moving linked people to another one", async () => {
    const user = userEvent.setup();
    server.source = { ...SOURCE, organisationIds: ["aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa"], secrets: { CLIENT_SECRET: { setAt: "2026-10-10T09:00:00.000Z" } } };
    post.mockImplementation(async (path: string) => {
      if (path === "/api/v1/ss12000-source/test") {
        return {
          ok: true,
          code: "OK",
          tokenOk: true,
          organisations: [
            { id: "aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa", displayName: "Ekskolan F–3", schoolUnitCode: "12345678", organisationType: "Skolenhet" },
            { id: "bbbbbbbb-bbbb-1bbb-8bbb-bbbbbbbbbbbb", displayName: "Ekskolan 4–9", schoolUnitCode: "87654321", organisationType: "Skolenhet" },
          ],
        };
      }
      throw new Error(`unexpected POST ${path}`);
    });
    put.mockRejectedValueOnce(new ApiError(409, "…", "SS12000_SOURCE_RELINK_REQUIRED", { linked: 42 })).mockResolvedValueOnce({ ...SOURCE });
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Testa anslutning" }));
    expect(await screen.findByText("Anslutningen fungerar. Registret har 2 skolenheter.")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Ekskolan F–3/ })).toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: /Ekskolan 4–9/ }));
    await user.click(screen.getByRole("button", { name: "Spara val av skolenhet" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("42 personer och grupper är kopplade");
    await user.click(within(dialog).getByRole("button", { name: "Byt ändå" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(put.mock.calls[1]![1]).toMatchObject({
      organisationIds: ["aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-1bbb-8bbb-bbbbbbbbbbbb"],
      confirmRelink: true,
    });
    expect(put.mock.calls[0]![1]).not.toHaveProperty("confirmRelink");
  });

  it("says why a test failed in its own words, never the far side's", async () => {
    const user = userEvent.setup();
    server.source = { ...SOURCE };
    post.mockResolvedValueOnce({ ok: false, code: "SS12000_TOKEN_REFUSED", tokenOk: false, organisations: [] });
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Testa anslutning" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Anslutningen misslyckades. Tokentjänsten nekade klient-id eller klienthemlighet.",
    );
  });

  it("starts a sync and names each run's status and reason in the history", async () => {
    const user = userEvent.setup();
    server.source = { ...SOURCE, organisationIds: ["aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa"] };
    server.runs = [
      run({ id: "r3", status: "SKIPPED", statusCode: "REVIEW_PENDING", trigger: "SCHEDULED", mode: "INCREMENTAL", fetchedAt: null, counts: {} }),
      run({ id: "r2", status: "FETCH_FAILED", statusCode: "SS12000_HTTP_503", fetchedAt: null, counts: {} }),
      run({ id: "r1", status: "APPLIED", counts: { PERSON: { fetched: 300, CREATE: 2 }, GROUP: { fetched: 12 }, applied: { admin: 2, skipped: 0 } } }),
    ];
    post.mockResolvedValue({ runId: "r4", mode: "INCREMENTAL" });
    renderPage();
    expect(await screen.findByText("Nattens synk hoppades över eftersom en manuell diff väntar på granskning.")).toBeInTheDocument();
    expect(screen.getByText("Registret svarade med HTTP 503.")).toBeInTheDocument();
    expect(screen.getByText("300 personer och 12 grupper lästa · 2 ändringar · 0 noteringar")).toBeInTheDocument();
    expect(screen.getByText("2 tillämpade, 0 överhoppade")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Synka nu" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/ss12000-sync/runs", { mode: "INCREMENTAL" }));
    await user.click(screen.getByRole("button", { name: "Full synk" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/ss12000-sync/runs", { mode: "FULL" }));
  });

  it("will not sync before a skolenhet is chosen", async () => {
    server.source = { ...SOURCE };
    renderPage();
    expect(await screen.findByRole("button", { name: "Synka nu" })).toBeDisabled();
    expect(screen.getByText("Testa anslutningen och välj skolenhet innan du synkar.")).toBeInTheDocument();
  });

  it("applies exactly what the admin chose, once every page is loaded and the dropped guardian has been seen", async () => {
    const user = userEvent.setup();
    server.source = { ...SOURCE, organisationIds: ["aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa"] };
    server.runs = [run({})];
    server.pages = [
      { data: [CREATE_CIA, RELINK_EVA], nextCursor: 2 },
      { data: [CREATE_DAN, GUARDIAN_ENDED], nextCursor: null },
    ];
    post.mockImplementation(async (path: string) => {
      if (path.endsWith("/apply")) return run({ status: "APPLIED", counts: { applied: { admin: 2, skipped: 0 } } });
      throw new Error(`unexpected POST ${path}`);
    });
    renderPage();
    await user.click((await screen.findAllByRole("button", { name: "Granska" }))[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("2 av 3 ändringar valda. 1 konflikter och noteringar tillämpas aldrig.")).toBeInTheDocument();
    // Both pages were read: the second page's pupil is listed.
    expect(within(dialog).getByText("Dan Åberg")).toBeInTheDocument();
    expect(within(dialog).getByText("Adressen tillhör en avaktiverad person. Koppla och återaktivera bara om det är samma människa.")).toBeInTheDocument();

    // The dropped guardian holds the apply, and links to the people register's guardian dialog.
    expect(within(dialog).getByRole("link", { name: "Gun Berg för Ada Lind" })).toHaveAttribute("href", "/admin/people?guardians=u-pupil");
    const applyButton = within(dialog).getByRole("button", { name: "Tillämpa 2" });
    expect(applyButton).toBeDisabled();
    await user.click(within(dialog).getByLabelText("Jag har sett barnet ovan."));

    await user.click(within(dialog).getByRole("checkbox", { name: "Cia Holm" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "Eva Sund" }));
    await user.click(within(dialog).getByRole("button", { name: "Tillämpa 2" }));
    const confirm = (await screen.findAllByRole("dialog")).at(-1)!;
    expect(confirm).toHaveTextContent("1 bortvald ändring kommer tillbaka vid nästa fulla synk, inom 7 dagar.");
    await user.click(within(confirm).getByRole("button", { name: "Tillämpa" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/ss12000-sync/runs/run-1/apply", {
        basisHash: "a".repeat(64),
        select: [RELINK_EVA.id],
        deselect: [CREATE_CIA.id],
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("2 ändringar tillämpades, 0 hoppades över.");
  });

  it("marks a run of conflicts only as reviewed: an apply of nothing, which moves the cursors (review 2026-10-11)", async () => {
    const user = userEvent.setup();
    server.source = { ...SOURCE, organisationIds: ["aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa"] };
    server.runs = [run({ counts: { PERSON: { fetched: 300, CONFLICT: 1 }, RESPONSIBLE: { CONFLICT: 1 } } })];
    const ambiguous = change({ op: "CONFLICT", conflictCode: "PERSON_AMBIGUOUS_MATCH", selected: false, externalId: "ext-x" });
    server.pages = [{ data: [ambiguous, GUARDIAN_ENDED], nextCursor: null }];
    post.mockImplementation(async (path: string) => {
      if (path.endsWith("/apply")) return run({ status: "APPLIED", counts: { applied: { admin: 0, skipped: 0 } } });
      throw new Error(`unexpected POST ${path}`);
    });
    renderPage();
    await user.click((await screen.findAllByRole("button", { name: "Granska" }))[0]!);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/0 av 0 ändringar valda/);
    const mark = within(dialog).getByRole("button", { name: "Markera som granskad" });
    // The dropped guardian still has to be seen first.
    expect(mark).toBeDisabled();
    await user.click(within(dialog).getByLabelText("Jag har sett barnet ovan."));
    expect(mark).toBeEnabled();
    await user.click(mark);
    const confirm = (await screen.findAllByRole("dialog")).at(-1)!;
    expect(confirm).toHaveTextContent("Markera synken som granskad utan ändringar?");
    expect(confirm).toHaveTextContent("Konflikterna står kvar");
    await user.click(within(confirm).getByRole("button", { name: "Tillämpa" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/ss12000-sync/runs/run-1/apply", { basisHash: "a".repeat(64), select: [], deselect: [] }),
    );
  });

  it("chooses all SHOWN rows, and never a flagged one (protected, a role for review) by the bulk tick", async () => {
    const user = userEvent.setup();
    server.source = { ...SOURCE, organisationIds: ["aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa"] };
    server.runs = [run({})];
    const rows = Array.from({ length: 205 }, (_, i) =>
      change({
        externalId: `ext-many-${i}`,
        selected: false,
        protectedIdentity: i === 1,
        conflictCode: i === 2 ? "DUTY_ROLE_REVIEW" : null,
        after: { role: "STUDENT", firstName: "Elev", lastName: String(i).padStart(3, "0"), email: `e${i}@skola.se` },
      }),
    );
    server.pages = [{ data: rows, nextCursor: null }];
    post.mockImplementation(async () => run({ status: "APPLIED" }));
    renderPage();
    await user.click((await screen.findAllByRole("button", { name: "Granska" }))[0]!);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/0 av 205 ändringar valda/);
    await user.click(within(dialog).getByRole("button", { name: "Välj alla visade utom flaggade" }));
    // 200 rendered, less the two flagged: the five behind "Visa fler" stay out.
    expect(await within(dialog).findByText(/198 av 205 ändringar valda/)).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: "Elev 001" })).not.toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "Elev 002" })).not.toBeChecked();
    // 205 rows rendered in jsdom: slow beside 190 other files, not a hang.
  }, 20_000);

  it("keeps every run reachable: older runs page by `before`, and a run's errors are named", async () => {
    const user = userEvent.setup();
    server.source = { ...SOURCE, organisationIds: ["aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa"] };
    server.runs = Array.from({ length: 20 }, (_, i) =>
      run({ id: `run-${i}`, status: "NO_CHANGES", basisHash: null, startedAt: `2026-10-${String(30 - i).padStart(2, "0")}T02:00:00.000Z` }),
    );
    const oldest = run({
      id: "run-old",
      status: "SUPERSEDED",
      trigger: "SCHEDULED",
      startedAt: "2026-09-01T02:00:00.000Z",
      appliedAt: "2026-09-01T02:01:00.000Z",
      autoApplied: true,
      autoApplyBlockedReason: "REVIEW_REQUIRED",
      errors: [
        { code: "INVALID_RECORD", entity: "PERSON", externalId: null },
        { code: "INVALID_RECORD", entity: "PERSON", externalId: null },
        { code: "SS12000_LOOKUP_REFUSED", entity: "PERSON", externalId: null },
      ],
    });
    get.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/v1/ss12000-sync/runs?limit=20&before=")) return [oldest];
      if (path === "/api/v1/ss12000-source") return server.source;
      if (path.startsWith("/api/v1/ss12000-sync/runs?")) return server.runs;
      if (path === "/api/v1/ss12000-sync/provisioning") return [];
      throw new Error(`unexpected GET ${path}`);
    });
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Visa äldre synkar" }));
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(`/api/v1/ss12000-sync/runs?limit=20&before=${encodeURIComponent("2026-10-11T02:00:00.000Z")}`),
    );
    expect(await screen.findByText(/^Delvis tillämpad /)).toBeInTheDocument();
    expect(screen.getByText("Natten tillämpade inget: allt som återstod kräver en administratör. Granska diffen.")).toBeInTheDocument();
    expect(screen.getByText(/^Fel: En post i registret hade inte rätt form och lästes inte\. \(2\) · Registret nekade uppslag/)).toBeInTheDocument();
    // A page shorter than 20 was the last.
    expect(screen.queryByRole("button", { name: "Visa äldre synkar" })).toBeNull();
  });

  it("lists a credential the sign-in type no longer uses, removable and never readable; Enter saves a field", async () => {
    const user = userEvent.setup();
    server.source = {
      ...SOURCE,
      authKind: "BEARER_TOKEN",
      tokenUrl: null,
      secrets: { CLIENT_SECRET: { setAt: "2026-10-01T09:00:00.000Z" } },
    };
    put.mockResolvedValueOnce({ kind: "BEARER_TOKEN", setAt: "2026-10-10T09:00:00.000Z" });
    renderPage();
    const token = await screen.findByLabelText("Token");
    expect(token).toHaveAttribute("autocomplete", "off");
    await user.type(token, "tok-123{Enter}");
    await waitFor(() => expect(put).toHaveBeenCalledWith("/api/v1/ss12000-source/secrets/BEARER_TOKEN", { value: "tok-123" }));
    const stale = screen.getByText("Används inte av det valda inloggningssättet. Ta bort den om den inte behövs.").closest("form") as HTMLElement;
    expect(within(stale).getByText("Klienthemlighet")).toBeInTheDocument();
    expect(within(stale).queryByRole("textbox")).toBeNull();
    expect(within(stale).getByRole("button", { name: "Ta bort" })).toBeEnabled();
  });

  it("asks for the mass deactivation to be confirmed, and sends the confirmation", async () => {
    const user = userEvent.setup();
    server.source = { ...SOURCE, organisationIds: ["aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa"] };
    server.runs = [run({})];
    const leavers = Array.from({ length: 6 }, (_, i) =>
      change({ op: "DEACTIVATE", localId: `u-${i}`, before: { firstName: "Elev", lastName: String(i), role: "STUDENT" }, after: { isActive: false, reason: "ABSENT_FROM_SOURCE" } }),
    );
    server.pages = [{ data: leavers, nextCursor: null }];
    post
      .mockRejectedValueOnce(new ApiError(409, "…", "SS12000_MASS_DEACTIVATION", { deactivations: 6, limit: 5 }))
      .mockResolvedValueOnce(run({ status: "APPLIED", counts: { applied: { admin: 6, skipped: 0 } } }));
    renderPage();
    await user.click((await screen.findAllByRole("button", { name: "Granska" }))[0]!);
    const dialog = await screen.findByRole("dialog");
    await user.click(await within(dialog).findByRole("button", { name: "Tillämpa 6" }));
    let confirm = (await screen.findAllByRole("dialog")).at(-1)!;
    expect(confirm).toHaveTextContent("6 personer avaktiveras. Ingen raderas, och historiken finns kvar.");
    await user.click(within(confirm).getByRole("button", { name: "Tillämpa" }));
    confirm = (await screen.findAllByRole("dialog")).at(-1)!;
    expect(await within(confirm).findByRole("alert")).toHaveTextContent("6 avaktiveringar är fler än gränsen 5.");
    const go = within(confirm).getByRole("button", { name: "Tillämpa" });
    expect(go).toBeDisabled();
    await user.click(within(confirm).getByLabelText("Jag bekräftar avaktiveringarna."));
    await user.click(go);
    await waitFor(() => expect(post).toHaveBeenLastCalledWith("/api/v1/ss12000-sync/runs/run-1/apply", expect.objectContaining({ confirmMassDeactivation: true })));
    expect(post.mock.calls[0]![1]).not.toHaveProperty("confirmMassDeactivation");
  });

  it("stops at a stale basis and says to sync again", async () => {
    const user = userEvent.setup();
    server.source = { ...SOURCE, organisationIds: ["aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa"] };
    server.runs = [run({})];
    server.pages = [{ data: [CREATE_CIA], nextCursor: null }];
    post.mockRejectedValueOnce(new ApiError(409, "…", "SS12000_DIFF_STALE"));
    renderPage();
    await user.click((await screen.findAllByRole("button", { name: "Granska" }))[0]!);
    const dialog = await screen.findByRole("dialog");
    await user.click(await within(dialog).findByRole("button", { name: "Tillämpa 1" }));
    await user.click(within((await screen.findAllByRole("dialog")).at(-1)!).getByRole("button", { name: "Tillämpa" }));
    expect(await within(dialog).findByText("Registret eller SchemaPro har ändrats sedan hämtningen. Stäng och synka igen.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Tillämpa 1" })).toBeDisabled();
  });

  it("applies nothing from a diff too large to load whole", async () => {
    const user = userEvent.setup();
    server.source = { ...SOURCE, organisationIds: ["aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa"] };
    server.runs = [run({})];
    // Every page says there is another: the review stops at 40 pages (20 000 changes).
    server.pages = [
      { data: [CREATE_CIA], nextCursor: 1 },
      { data: [], nextCursor: 2 },
    ];
    renderPage();
    await user.click((await screen.findAllByRole("button", { name: "Granska" }))[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Diffen har fler än 20 000 ändringar");
    expect(get.mock.calls.filter(([path]) => String(path).includes("/changes?")).length).toBe(40);
    expect(within(dialog).getByRole("button", { name: /^Tillämpa/ })).toBeDisabled();
  });

  it("shows an applied run read-only, with nothing to tick", async () => {
    const user = userEvent.setup();
    server.source = { ...SOURCE, organisationIds: ["aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa"] };
    server.runs = [run({ status: "APPLIED" })];
    server.pages = [{ data: [{ ...CREATE_CIA, after: null, applied: true }], nextCursor: null }];
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Visa" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Namn och adresser är rensade: de sparas bara medan en synk väntar på granskning.")).toBeInTheDocument();
    expect(within(dialog).getByText("Okänd person")).toBeInTheDocument();
    expect(within(dialog).queryByRole("checkbox", { name: "Okänd person" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /Tillämpa/ })).toBeNull();
  });

  it("turns the nightly sync on, and offers automatic apply only once it is on", async () => {
    const user = userEvent.setup();
    server.source = { ...SOURCE };
    patch.mockResolvedValueOnce({ ...SOURCE, scheduleEnabled: true });
    renderPage();
    expect(await screen.findByRole("switch", { name: "Tillämpa säkra ändringar automatiskt" })).toBeDisabled();
    await user.click(screen.getByRole("switch", { name: "Synka varje natt" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/api/v1/ss12000-source/schedule", { scheduleEnabled: true }));
    expect(await screen.findByRole("switch", { name: "Tillämpa säkra ändringar automatiskt" })).toBeEnabled();
  });

  it("invites only the people the admin chose", async () => {
    const user = userEvent.setup();
    server.source = { ...SOURCE };
    server.provisioning = [
      { id: "33333333-3333-4333-8333-333333333333", role: "STUDENT", firstName: "Cia", lastName: "Holm", email: "cia@skola.se", studentGroup: { id: "g", name: "7A" } },
      { id: "44444444-4444-4444-8444-444444444444", role: "GUARDIAN", firstName: "Gun", lastName: "Berg", email: "gun@hem.se", studentGroup: null },
    ];
    post.mockResolvedValueOnce({ sent: 1, alreadyRegistered: 0, errors: [] });
    renderPage();
    const cia = await screen.findByRole("checkbox", { name: /Cia Holm/ });
    expect(cia).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Bjud in valda (0)" })).toBeDisabled();
    await user.click(cia);
    await user.click(screen.getByRole("button", { name: "Bjud in valda (1)" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/users/invitations", { userIds: ["33333333-3333-4333-8333-333333333333"] }),
    );
    expect(await screen.findByText("1 skickade, 0 hade redan konto, 0 misslyckades.")).toBeInTheDocument();
  });
});

describe("/admin/integrations — API keys", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    server.source = null;
    server.runs = [];
    server.pages = [{ data: [], nextCursor: null }];
    server.provisioning = [];
    server.keys = [KEY];
    answer();
  });

  it("creates a key with the scopes chosen, starting from today's v1 reach, and shows it once", async () => {
    const user = userEvent.setup();
    post.mockResolvedValueOnce({ id: "k2", name: "Bibliotek", createdAt: "2026-10-10T10:00:00.000Z", key: "sp_abc123" });
    renderPage();
    await user.click(await screen.findByRole("tab", { name: "API-nycklar" }));
    const name = await screen.findByLabelText("Nyckelns namn");
    const card = name.closest("div.rounded-xl, div.rounded-lg, div[class*='card']") ?? document.body;
    expect(within(card as HTMLElement).getByRole("checkbox", { name: "ss12000.v1" })).toBeChecked();
    await user.type(name, "Bibliotek");
    await user.click(within(card as HTMLElement).getByRole("checkbox", { name: "ss12000.v1.import" }));
    await user.click(within(card as HTMLElement).getByRole("checkbox", { name: "persons.read" }));
    await user.click(screen.getByRole("button", { name: "Skapa nyckel" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/integration-keys", { name: "Bibliotek", scopes: ["ss12000.v1", "persons.read"] }),
    );
    expect(await screen.findByText("sp_abc123")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Jag har sparat den" }));
    expect(screen.queryByText("sp_abc123")).toBeNull();
  });

  it("makes a signing secret, shown once, and pauses a subscription", async () => {
    const user = userEvent.setup();
    post.mockImplementation(async (path: string) => {
      if (path.endsWith("/webhook-secret")) return { id: KEY.id, secret: "whsec_xyz", setAt: "2026-10-10T10:00:00.000Z" };
      if (path.endsWith("/pause")) return { id: "s", state: "PAUSED" };
      throw new Error(`unexpected POST ${path}`);
    });
    renderPage();
    await user.click(await screen.findByRole("tab", { name: "API-nycklar" }));
    expect(await screen.findByText("Ingen signeringshemlighet: systemet kan inte prenumerera på ändringar förrän en finns.")).toBeInTheDocument();
    expect(screen.getByText("hooks.vklass.example")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Skapa signeringshemlighet" }));
    expect(await screen.findByText("whsec_xyz")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pausa" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(`/api/v1/integration-keys/${KEY.id}/subscriptions/${KEY.subscriptions[0]!.id}/pause`),
    );
  });

  it("keeps a once-shown key and signing secret across a tab switch, also one that arrives after the switch", async () => {
    const user = userEvent.setup();
    let release: (value: unknown) => void = () => undefined;
    post.mockImplementation(async (path: string) => {
      if (path === "/api/v1/integration-keys") return { id: "k2", name: "Bibliotek", createdAt: "2026-10-10T10:00:00.000Z", key: "sp_abc123" };
      if (path.endsWith("/webhook-secret")) {
        await new Promise((resolve) => (release = resolve));
        return { id: KEY.id, secret: "whsec_late", setAt: "2026-10-10T10:00:00.000Z" };
      }
      throw new Error(`unexpected POST ${path}`);
    });
    renderPage();
    await user.click(await screen.findByRole("tab", { name: "API-nycklar" }));
    await screen.findByLabelText("Nyckelns namn");
    await user.click(screen.getByRole("button", { name: "Skapa nyckel" }));
    expect(await screen.findByText("sp_abc123")).toBeInTheDocument();
    // The secret is asked for, and the admin leaves before it answers.
    await user.click(screen.getByRole("button", { name: "Skapa signeringshemlighet" }));
    await user.click(screen.getByRole("tab", { name: "Elevregister" }));
    release(undefined);
    await user.click(screen.getByRole("tab", { name: "API-nycklar" }));
    expect(screen.getByText("sp_abc123")).toBeInTheDocument();
    expect(await screen.findByText("whsec_late")).toBeInTheDocument();
  });

  it("says when a copy failed, instead of 'copied'", async () => {
    const user = userEvent.setup();
    post.mockResolvedValueOnce({ id: "k2", name: "Bibliotek", createdAt: "2026-10-10T10:00:00.000Z", key: "sp_abc123" });
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) }, configurable: true });
    renderPage();
    await user.click(await screen.findByRole("tab", { name: "API-nycklar" }));
    await screen.findByLabelText("Nyckelns namn");
    await user.click(screen.getByRole("button", { name: "Skapa nyckel" }));
    await screen.findByText("sp_abc123");
    await user.click(screen.getByRole("button", { name: "Kopiera" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Kunde inte kopiera. Markera värdet och kopiera det själv."));
    expect(toast.success).not.toHaveBeenCalledWith("Kopierat till urklipp");
  });

  it("changes a key's scopes and refuses an empty set", async () => {
    const user = userEvent.setup();
    patch.mockResolvedValueOnce({ id: KEY.id, scopes: ["ss12000.v1"] });
    renderPage();
    await user.click(await screen.findByRole("tab", { name: "API-nycklar" }));
    await user.click(await screen.findByRole("button", { name: "Ändra omfång" }));
    const row = screen.getByText("Vklass").closest("li") as HTMLElement;
    await user.click(within(row).getByRole("checkbox", { name: "ss12000.v1.import" }));
    await user.click(within(row).getByRole("checkbox", { name: "ss12000.v1" }));
    expect(within(row).getByText("Välj minst ett omfång.")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Spara" })).toBeDisabled();
    await user.click(within(row).getByRole("checkbox", { name: "ss12000.v1" }));
    await user.click(within(row).getByRole("button", { name: "Spara" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith(`/api/v1/integration-keys/${KEY.id}`, { scopes: ["ss12000.v1"] }));
  });
});
