import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sv from "@/messages/sv.json";
import HuvudmanPage from "./page";

/**
 * /huvudman (Huvudman, 20261212090000), rendered as the server renders it:
 * what a kommunadministratör and a planner see and may do, every act a plain
 * form to ./act, and the answer's banner. The gateway is fetch.
 */

const H = "55555555-5555-4555-8555-555555555555";
const S = "66666666-6666-4666-8666-666666666666";

const state = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_BASE_URL = "https://api.example";
  return { role: "KOMMUNADMINISTRATOR" as "KOMMUNADMINISTRATOR" | "PLANERARE", schools: [] as unknown[] };
});
vi.mock("@/lib/auth", () => ({ getSession: async () => ({ accessToken: "token", schools: state.schools, profile: null }) }));
vi.mock("@/i18n/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => undefined, refresh: () => undefined }) }));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: keyof typeof sv) => {
    const messages = sv[namespace] as Record<string, string>;
    const t = (key: string, values?: Record<string, string>) =>
      Object.entries(values ?? {}).reduce((out, [name, value]) => out.replace(`{${name}}`, value), messages[key] ?? key);
    t.has = (key: string) => key in messages;
    return t;
  },
}));

const view = () => ({
  id: H,
  name: "Vimmerby kommun",
  organisationNumber: "2120000688",
  municipalityCode: "0884",
  role: state.role,
  memberId: "m1",
  schools: [
    { id: S, name: "Ekbacken", slug: "ekbacken", state: "OWNED", since: "2026-10-01T08:00:00.000Z", requestedBy: "m1" },
    { id: "77777777-7777-4777-8777-777777777777", name: "Granen", slug: "granen", state: "REQUESTED", since: "2026-10-02T08:00:00.000Z", requestedBy: "m1" },
  ],
  members: [{ id: "m1", email: "k@kommun.example", firstName: "Karin", lastName: "Kommun", role: "KOMMUNADMINISTRATOR", isActive: true, invited: true }],
  keys: state.role === "KOMMUNADMINISTRATOR" ? [{ id: "k1", name: "Elevregistret", scopes: ["persons.read"], createdAt: "2026-10-01T08:00:00.000Z", lastUsedAt: null, revokedAt: null }] : null,
  history: [{ at: "2026-10-01T08:00:00.000Z", kind: "JOINED", schoolId: S, schoolName: "Ekbacken", byMember: null, bySchool: true }],
});

describe("/huvudman", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    state.role = "KOMMUNADMINISTRATOR";
    state.schools = [];
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/api/v1/huvudman")
        ? new Response(JSON.stringify([{ id: H, name: "Vimmerby kommun", organisationNumber: null, municipalityCode: null, role: state.role, memberId: "m1" }]))
        : new Response(JSON.stringify(view())),
    );
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const page = async (query: Record<string, string> = {}) =>
    render(await HuvudmanPage({ params: Promise.resolve({ locale: "sv" }), searchParams: Promise.resolve(query) }));

  it("gives the kommunadministratör the schools to open and let go, the people, the keys and the history", async () => {
    await page();
    expect(screen.getByRole("heading", { level: 1, name: "Vimmerby kommun" })).toBeInTheDocument();
    const open = screen.getByRole("button", { name: "Öppna Ekbacken" });
    // Opened through the school switcher's route, as the huvudman's läsare there.
    expect(open.closest("form")).toHaveAttribute("action", "/sv/skola");
    expect(open).toHaveAttribute("value", S);
    expect(screen.getByRole("button", { name: "Släpp Ekbacken" }).closest("form")).toHaveAttribute("action", "/sv/huvudman/act");
    expect(screen.getByRole("button", { name: "Dra tillbaka förfrågan till Granen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skicka förfrågan" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skicka inbjudan" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "SS12000-nycklar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Återkalla Elevregistret" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Historik" })).toBeInTheDocument();
    const joined = screen.getByRole("cell", { name: "Skolan sa ja" });
    expect(within(joined.closest("tr")!).getByRole("cell", { name: "Skolan" })).toBeInTheDocument();
    // No school named on the huvudman's own reads.
    for (const [, init] of fetchMock.mock.calls) expect((init as { headers: Record<string, string> }).headers["x-school-id"]).toBeUndefined();
  });

  it("lets a planner open the schools and act on nothing, and shows no keys", async () => {
    state.role = "PLANERARE";
    await page();
    expect(screen.getByRole("button", { name: "Öppna Ekbacken" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Släpp|Dra tillbaka|Skicka|Återkalla|Avaktivera|Gör/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: "SS12000-nycklar" })).toBeNull();
  });

  it("says what was done, naming the school by its id from the page's own list", async () => {
    await page({ done: "doneRequested", school: "77777777-7777-4777-8777-777777777777" });
    expect(screen.getByRole("status")).toHaveTextContent("Förfrågan till Granen är skickad.");
    expect(screen.getByRole("status")).toHaveAttribute("id", "huvudman-result");
  });

  it("says nothing of words the address brings: a school that is no id, or a key that is no answer", async () => {
    await page({ done: "doneRequested", school: "Skolan har stängts, ring 0700-000000" });
    expect(screen.getByRole("status")).toHaveTextContent(sv.huvudman.doneRequestedUnnamed);
    expect(screen.getByRole("status")).not.toHaveTextContent("0700");
  });

  it("ignores a done key that is no answer of the act route's", async () => {
    await page({ done: "notMember" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says a refusal in the reader's words, and an unknown code in the general ones", async () => {
    await page({ error: "HUVUDMAN_SCHOOL_HAS_A_HUVUDMAN" });
    expect(screen.getByRole("alert")).toHaveTextContent("Skolan har redan en huvudman.");
  });

  it.each(["HUVUDMAN_NO_SUCH_THING", "notMember", "SCHOOL_NOT_AVAILABLE"])("says %s in the general words", async (error) => {
    await page({ error });
    expect(screen.getByRole("alert")).toHaveTextContent(sv.huvudman.errorOther);
  });

  it("asks before letting a school go, with a form that says yes and a way back", async () => {
    await page({ confirm: "release", target: S });
    const question = screen.getByRole("region", { name: sv.huvudman.confirmTitle });
    expect(question).toHaveTextContent("Huvudmannens personer och nycklar slutar läsa Ekbacken.");
    const yes = within(question).getByRole("button", { name: sv.huvudman.confirmYes });
    const form = yes.closest("form")!;
    expect(form).toHaveAttribute("action", "/sv/huvudman/act");
    const fields = Object.fromEntries(new FormData(form as HTMLFormElement));
    expect(fields).toEqual({ huvudman: H, confirmed: "yes", action: "release", school: S });
    expect(within(question).getByRole("link", { name: sv.huvudman.confirmNo })).toHaveAttribute("href", `/sv/huvudman?h=${H}`);
  });

  it.each([
    [{ confirm: "release", target: "77777777-7777-4777-8777-777777777777" }],
    [{ confirm: "revoke", target: S }],
    [{ confirm: "nothing", target: S }],
  ])("asks nothing for %o, which names nothing the page holds", async (query) => {
    await page(query);
    expect(screen.queryByRole("region", { name: sv.huvudman.confirmTitle })).toBeNull();
  });

  it("links back to the school for a login that has one", async () => {
    await page();
    expect(screen.queryByRole("link", { name: sv.huvudman.toSchool })).toBeNull();
    cleanup();
    state.schools = [{ schoolId: S }];
    await page();
    expect(screen.getByRole("link", { name: sv.huvudman.toSchool })).toHaveAttribute("href", "/sv");
  });

  it("tells a gateway that does not answer apart from a login that is no member", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 503 }));
    await page();
    expect(screen.getByRole("alert")).toHaveTextContent(sv.huvudman.loadFailed);
    expect(screen.queryByText(sv.huvudman.notMember)).toBeNull();
  });

  it("says so to a login that is no member", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify([])));
    await page();
    expect(screen.getByText(sv.huvudman.notMember)).toBeInTheDocument();
  });
});
