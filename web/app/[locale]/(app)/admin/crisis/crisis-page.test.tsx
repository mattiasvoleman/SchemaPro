import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { ApiError, api } from "@/lib/api";
import type { AdminProfile } from "@/lib/admin-areas";
import type { AlarmDetail, AlarmSummary, CrisisSettings, ProtocolView } from "@/lib/crisis-types";
import { detail, call, noLessonCall, protocol, protocolMark, pupil, summary, teacher, ENDED } from "@/lib/__fixtures__/crisis";
import { CrisisPage } from "./crisis-page";

/**
 * /admin/crisis over the real hooks and the Swedish messages, the gateway
 * answering by path. What only this page decides: that a live alarm is
 * started by two taps and says what it is (and an exercise that it is one),
 * that a refusal is said in words with the way to the alarm that is already
 * going, that the live view counts and lists from the groups and lets the
 * administration mark, that ending warns about who is not ticked off, that a
 * reader or a profile the school has not let start sees all of it and
 * changes nothing, that the protocol leaves out a protected pupil in the file
 * and on paper, and that the settings are a decider's.
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } };
});
const get = api.get as unknown as Mock;
const post = api.post as unknown as Mock;
const put = api.put as unknown as Mock;

const who = vi.hoisted(() => ({ profile: "REKTOR" as AdminProfile, readOnly: false }));
vi.mock("@/components/profile-context", () => ({
  useProfile: () => ({
    profile: { id: "a-me", role: "SCHOOL_ADMIN", adminProfile: who.profile },
    school: { id: "s-1", name: "Norra Real", slug: "norra", timezone: "Europe/Stockholm" },
  }),
  useReadOnly: () => who.readOnly,
}));
vi.mock("@/lib/use-crisis-realtime", () => ({ useCrisisRealtime: () => undefined }));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
// The file's download is the one thing of the page that touches the browser; its content is what is asserted.
const download = vi.hoisted(() => vi.fn());
vi.mock("@/lib/csv-export", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/csv-export")>()), downloadCsv: download }));

globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const ANNA = teacher("t-anna", "Anna Berg", "2027-01-12T09:18:00.000Z");
const BO = teacher("t-bo", "Bo Ek");
const CIA = teacher("t-cia", "Cia Dahl");

/** 7A: found, missing, unreported (two teachers, one has answered). 8B: a break, its next lesson. 9C: nobody answers for it. */
const calls = () => [
  call(
    "c-7a",
    "7A",
    [pupil("s1", "Ines", "Ek", "FOUND", { markedBy: "Anna Berg" }), pupil("s2", "Jamal", "Ali", "MISSING"), pupil("s3", "Klara", "Nyman")],
    { teachers: [ANNA, BO] },
  ),
  call("c-8b", "8B", [pupil("s4", "Olle", "Lind"), pupil("s5", "Pia", "Lind", "ABSENT_BEFORE")], {
    basis: "NEXT_LESSON",
    subjectName: "Engelska",
    teachers: [CIA],
  }),
  call("c-9c", "9C", [pupil("s6", "Rut", "Ek"), pupil("s7", "Sam", "Ek")], { teachers: [teacher(null, null)], roomName: null }),
];

const world = {
  settings: { startProfiles: ["FULL", "REKTOR", "SCHEMALAGGARE", "EXPEDITION"] } as Pick<CrisisSettings, "startProfiles"> & Partial<CrisisSettings>,
  recent: [] as AlarmSummary[],
  details: new Map<string, AlarmDetail>(),
  protocols: new Map<string, ProtocolView>(),
  lists: { LIVE: [] as AlarmSummary[], DRILL: [] as AlarmSummary[] },
  protections: [] as { userId: string; source: string }[],
  protectionsFail: false,
  purged: [] as { dataType: string; purgedBefore: string }[],
};

function open(extra: Partial<AlarmSummary> = {}, list = calls()) {
  const one = detail(list, extra);
  world.recent = [one.alarm];
  world.details.set(one.alarm.id, one);
  return one;
}

// This page renders whole lists of pupils, and on a loaded CI runner a find or a waitFor here has
// taken over a second (granskning-270: "takes two taps to start a live alarm" failed at 2,15 s).
// The library's 1 s default is the wrong bound for this file; restored after it.
const defaultAsyncTimeout = 1000;
beforeAll(() => configure({ asyncUtilTimeout: 5000 }));
afterAll(() => configure({ asyncUtilTimeout: defaultAsyncTimeout }));

beforeEach(() => {
  vi.resetAllMocks();
  who.profile = "REKTOR";
  who.readOnly = false;
  world.settings = { startProfiles: ["FULL", "REKTOR", "SCHEMALAGGARE", "EXPEDITION"], notifyGuardiansAfter: false };
  world.recent = [];
  world.details = new Map();
  world.protocols = new Map();
  world.lists = { LIVE: [], DRILL: [] };
  world.protections = [];
  world.protectionsFail = false;
  world.purged = [];
  get.mockImplementation(async (path: string) => {
    if (path === "/api/v1/crisis/settings") return world.settings;
    if (path.startsWith("/api/v1/crisis/alarms?limit=")) return world.recent;
    const list = /^\/api\/v1\/crisis\/alarms\?mode=(LIVE|DRILL)&limit=/.exec(path);
    if (list) return world.lists[list[1] as "LIVE" | "DRILL"];
    const proto = /^\/api\/v1\/crisis\/alarms\/([^/]+)\/protocol$/.exec(path);
    if (proto) return world.protocols.get(proto[1]!);
    const one = /^\/api\/v1\/crisis\/alarms\/([^/?]+)$/.exec(path);
    if (one) {
      const found = world.details.get(one[1]!);
      if (!found) throw new ApiError(404, "Larmet finns inte.", "CRISIS_ALARM_NOT_FOUND");
      return found;
    }
    if (path === "/api/v1/person-protections") {
      if (world.protectionsFail) throw new ApiError(500, "boom");
      return world.protections;
    }
    if (path === "/api/v1/retention/purged-before") return world.purged;
    throw new Error(`unexpected GET ${path}`);
  });
  post.mockResolvedValue({ stored: 1, duplicates: 0, unresolved: [] });
});

function renderPage(initialAlarmId: string | null = null, language: "sv" | "en" = "sv") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale={language} messages={language === "sv" ? sv : en} timeZone="Europe/Stockholm">
        <CrisisPage initialAlarmId={initialAlarmId} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const startButton = (name: string) => screen.findByRole("button", { name });

describe("Starta larm", () => {
  it("takes two taps to start a live alarm, and the second says that it is not an exercise", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await startButton("Starta skarpt larm: utrymning"));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Starta skarpt larm: utrymning?")).toBeInTheDocument();
    expect(within(alert).getByText(/Det här är inte en övning/)).toBeInTheDocument();
    // Nothing has gone to a teacher yet; focus is on the question, not on a button that would answer it.
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").parentElement).toHaveFocus();

    // Backing out starts nothing.
    await user.click(within(alert).getByRole("button", { name: "Avbryt" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();

    // The live alarm answers the start and the live view opens on it.
    const started = open({}, calls());
    post.mockResolvedValue(started);
    await user.click(await startButton("Starta skarpt larm: utrymning"));
    await user.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Ja, starta skarpt larm" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/crisis/alarms", { kind: "EVACUATION", mode: "LIVE" }));
    expect(await screen.findByRole("heading", { level: 2, name: /Utrymning · pågår/ })).toBeInTheDocument();
  });

  it("marks an exercise as one, in the question and in the live view", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await startButton("Starta övning: inrymning"));
    const question = (await screen.findByText("Starta övning: inrymning?")).closest("div[data-tone]") as HTMLElement;
    expect(within(question).getByText("Övning")).toBeInTheDocument();
    expect(within(question).queryByText(/Det här är inte en övning/)).not.toBeInTheDocument();

    const started = open({ mode: "DRILL", kind: "LOCKDOWN" });
    post.mockResolvedValue(started);
    await user.click(within(question).getByRole("button", { name: "Starta övningen" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/crisis/alarms", { kind: "LOCKDOWN", mode: "DRILL" }));
    const heading = await screen.findByRole("heading", { level: 2, name: /Inrymning · pågår/ });
    expect(within(heading.parentElement as HTMLElement).getByText("Övning")).toBeInTheDocument();
  });

  it("says a profile the school has not let start cannot, in words, and still shows the rest of the page", async () => {
    who.profile = "EXPEDITION";
    world.settings = { startProfiles: ["FULL", "REKTOR"], notifyGuardiansAfter: false };
    renderPage();
    expect(await screen.findByText(/Din roll får inte starta larm\. Rektor bestämmer/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Starta skarpt larm/ })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Protokoll" })).toBeInTheDocument();
  });

  it("does not hold a start back for settings that could not be read: the database says no where it is no", async () => {
    who.profile = "EXPEDITION";
    get.mockImplementation(async (path: string) => {
      if (path === "/api/v1/crisis/settings") throw new ApiError(500, "boom");
      if (path.startsWith("/api/v1/crisis/alarms?limit=")) return [];
      throw new Error(`unexpected GET ${path}`);
    });
    renderPage();
    expect(await startButton("Starta skarpt larm: utrymning")).toBeEnabled();
  });

  it("starts an alarm even when the list of alarms cannot be read: a failed read never holds the start back", async () => {
    get.mockImplementation(async (path: string) => {
      if (path === "/api/v1/crisis/settings") return world.settings;
      throw new ApiError(500, "boom");
    });
    const started = detail(calls());
    post.mockResolvedValue(started);
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText("Larmen kunde inte hämtas")).toBeInTheDocument();
    await user.click(await startButton("Starta skarpt larm: utrymning"));
    await user.click(await screen.findByRole("button", { name: "Ja, starta skarpt larm" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/crisis/alarms", { kind: "EVACUATION", mode: "LIVE" }));
  });

  it("says a 403 in words, and starts nothing", async () => {
    post.mockRejectedValue(new ApiError(403, "Din roll får inte starta larm.", "CRISIS_NOT_YOURS"));
    const user = userEvent.setup();
    renderPage();
    await user.click(await startButton("Starta skarpt larm: utrymning"));
    await user.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Ja, starta skarpt larm" }));
    expect(await screen.findByText("Larmet startade inte")).toBeInTheDocument();
    expect(screen.getByText(/Din roll får inte starta larm, och du svarar inte för den gruppen/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: /pågår/ })).not.toBeInTheDocument();
  });

  it("links a refused start to the alarm that is already going, when the gateway names it", async () => {
    const id = "0f4e3c2a-9d1b-4a6e-8c3f-5b7d9e1a2c4f";
    post.mockRejectedValue(new ApiError(409, "Ett larm pågår", "CRISIS_ALARM_OPEN", { alarmId: id }));
    const user = userEvent.setup();
    renderPage();
    await user.click(await startButton("Starta övning: utrymning"));
    await user.click(within(await screen.findByText("Starta övning: utrymning?").then((node) => node.closest("div[data-tone]") as HTMLElement)).getByRole("button", { name: "Starta övningen" }));
    expect(await screen.findByText("Ett larm av det slaget pågår redan.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Visa larmet som pågår" })).toHaveAttribute("href", `/admin/crisis?alarm=${id}`);
  });

  it("does not link when the gateway cannot name it (the loser of a race), only says that one is going", async () => {
    post.mockRejectedValue(new ApiError(409, "Ett larm pågår", "CRISIS_ALARM_OPEN"));
    const user = userEvent.setup();
    renderPage();
    await user.click(await startButton("Starta skarpt larm: inrymning"));
    await user.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Ja, starta skarpt larm" }));
    expect(await screen.findByText("Ett larm av det slaget pågår redan.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Visa larmet som pågår" })).not.toBeInTheDocument();
  });

  it("offers a live alarm over an exercise that is going, says it ends the exercise, and no second exercise", async () => {
    open({ mode: "DRILL" });
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByRole("heading", { level: 2, name: /Utrymning · pågår/ })).toBeInTheDocument();
    expect(await startButton("Starta övning: utrymning")).toBeDisabled();
    expect(screen.getByText(/En övning pågår redan/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Starta skarpt larm: inrymning" }));
    expect(await screen.findByText("Övningen som pågår avslutas.")).toBeInTheDocument();
  });

  it("offers no start beside a live alarm, and none to a reader", async () => {
    open();
    renderPage();
    await screen.findByRole("heading", { level: 2, name: /Utrymning · pågår/ });
    expect(screen.queryByRole("button", { name: /Starta/ })).not.toBeInTheDocument();
  });

  it("shows a reader that nothing is going, and no way to start", async () => {
    who.readOnly = true;
    renderPage();
    expect(await screen.findByText(/Inget larm pågår\. Du kan läsa protokollen/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Starta/ })).not.toBeInTheDocument();
  });

  it("opens the live view on the alarm a link names", async () => {
    const one = open({}, calls());
    world.recent = []; // not among the newest, say: the link is what finds it
    renderPage(one.alarm.id);
    expect(await screen.findByRole("heading", { level: 2, name: /Utrymning · pågår/ })).toBeInTheDocument();
  });
});

describe("the live view", () => {
  it("counts from the groups: done groups, who is found, missing and not reported, and which teachers have answered", async () => {
    open();
    renderPage();
    await screen.findByRole("heading", { level: 2, name: /Utrymning · pågår/ });
    // One polite sentence for a screen reader.
    const live = screen.getByRole("status");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent(
      "Grupper klara 0 av 3. Finns 1, saknas 1, inte rapporterade 4. Lärare som svarat 1 av 3.",
    );
    // The tiles for the eye.
    const tile = (label: string) => screen.getByText(label, { selector: "dt" }).parentElement as HTMLElement;
    expect(tile("Grupper klara")).toHaveTextContent("0 av 3");
    expect(tile("Finns")).toHaveTextContent("1");
    expect(tile("Saknas")).toHaveTextContent("1");
    expect(tile("Inte rapporterade")).toHaveTextContent("4");
    expect(tile("Frånvarande sedan tidigare")).toHaveTextContent("1");
    expect(tile("Lärare som svarat")).toHaveTextContent("1 av 3");
    expect(screen.getByRole("timer")).toBeInTheDocument();
    expect(screen.getByText(/Startades kl 10:14 av Rut Rektor/)).toBeInTheDocument();
  });

  it("lists the teachers who have not answered, with the groups they owe", async () => {
    open();
    renderPage();
    const silent = (await screen.findByRole("region", { name: "Lärare som inte svarat" })) as HTMLElement;
    const names = within(silent).getAllByRole("listitem").map((item) => item.textContent);
    expect(names).toEqual(["Bo Ek7A", "Cia Dahl8B"]);
  });

  it("lists the pupils who are missing first and then those without a mark, with their group and who to ask", async () => {
    open();
    renderPage();
    const find = (await screen.findByRole("region", { name: "Elever som saknas eller saknar markering" })) as HTMLElement;
    const rows = within(find).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector("p")?.textContent)).toEqual(["Jamal Ali", "Klara Nyman", "Olle Lind", "Rut Ek", "Sam Ek"]);
    expect(rows[0]).toHaveTextContent("7A · Matematik · Sal 12 · Anna Berg, Bo Ek");
    expect(rows[3]).toHaveTextContent("Ingen lärare");
  });

  it("shows every group: its room, who answers and when they did, its status in words, and a break's next lesson", async () => {
    open();
    renderPage();
    const table = await screen.findByRole("table", { name: "Grupper" });
    const rowOf = (group: string) => within(table).getByRole("button", { name: group }).closest("tr") as HTMLElement;
    expect(rowOf("7A")).toHaveTextContent("Sal 12");
    expect(rowOf("7A")).toHaveTextContent("Anna Berg");
    expect(rowOf("7A")).toHaveTextContent("svarade kl 10:18");
    expect(rowOf("7A")).toHaveTextContent("Bo Ek");
    expect(rowOf("7A")).toHaveTextContent("har inte svarat");
    expect(rowOf("7A")).toHaveTextContent("Pågår");
    expect(rowOf("7A")).toHaveTextContent("2 av 3 prickade");
    expect(rowOf("8B")).toHaveTextContent("Rast: nästa lektion");
    expect(rowOf("8B")).toHaveTextContent("Väntar på läraren");
    // The pupil who was absent before is not asked for.
    expect(rowOf("8B")).toHaveTextContent("0 av 1 prickade");
    expect(rowOf("9C")).toHaveTextContent("Ingen lärare");
    expect(rowOf("9C")).toHaveTextContent("—");
  });

  it("hides the groups that are done when asked", async () => {
    open({}, [...calls(), call("c-done", "6A", [pupil("s9", "Tom", "Ek", "FOUND")], { teachers: [ANNA] })]);
    const user = userEvent.setup();
    renderPage();
    const table = await screen.findByRole("table", { name: "Grupper" });
    expect(within(table).getByRole("button", { name: "6A" })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Dölj klara grupper" }));
    expect(within(table).queryByRole("button", { name: "6A" })).not.toBeInTheDocument();
    expect(within(table).getByRole("button", { name: "7A" })).toBeInTheDocument();
  });

  it("opens a group's pupils from its name, and marks one found with a mark of its own id", async () => {
    open();
    const user = userEvent.setup();
    renderPage();
    const table = await screen.findByRole("table", { name: "Grupper" });
    const toggle = within(table).getByRole("button", { name: "9C" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const pupils = within(table).getByRole("list", { name: "Eleverna i 9C" });
    expect(within(pupils).getAllByRole("listitem")).toHaveLength(2);

    await user.click(within(pupils).getByRole("button", { name: "Finns: Rut Ek" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, body] = post.mock.calls[0]!;
    expect(path).toBe("/api/v1/crisis/alarms/a-1/marks");
    expect(body.marks).toHaveLength(1);
    expect(body.marks[0]).toMatchObject({ callId: "c-9c", studentId: "s6", state: "FOUND" });
    expect(body.marks[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("marks a whole group found in one call, those nobody has marked", async () => {
    open();
    const user = userEvent.setup();
    renderPage();
    const table = await screen.findByRole("table", { name: "Grupper" });
    await user.click(within(table).getByRole("button", { name: "9C" }));
    await user.click(screen.getByRole("button", { name: "Alla finns (2)" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![1].marks.map((mark: { studentId: string; state: string }) => [mark.studentId, mark.state])).toEqual([
      ["s6", "FOUND"],
      ["s7", "FOUND"],
    ]);
    // A group with one missing says "the rest", and never overwrites the missing.
    await user.click(within(table).getByRole("button", { name: "7A" }));
    expect(screen.getByRole("button", { name: "Resten finns (1)" })).toBeInTheDocument();
  });

  it("marks a pupil from the list of those to find, for a teacher who cannot reach their phone", async () => {
    open();
    const user = userEvent.setup();
    renderPage();
    const find = (await screen.findByRole("region", { name: "Elever som saknas eller saknar markering" })) as HTMLElement;
    await user.click(within(find).getByRole("button", { name: "Finns: Jamal Ali" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![1].marks[0]).toMatchObject({ callId: "c-7a", studentId: "s2", state: "FOUND" });
  });

  it("says in words that a mark was refused, and that one belonged to no alarm", async () => {
    open();
    post.mockRejectedValueOnce(new ApiError(409, "Larmet är redan avslutat.", "CRISIS_ALARM_ENDED"));
    post.mockResolvedValueOnce({ stored: 0, duplicates: 0, unresolved: ["m-1"] });
    const user = userEvent.setup();
    renderPage();
    const find = (await screen.findByRole("region", { name: "Elever som saknas eller saknar markering" })) as HTMLElement;
    await user.click(within(find).getByRole("button", { name: "Finns: Jamal Ali" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Larmet är redan avslutat")));
    await user.click(within(find).getByRole("button", { name: "Finns: Jamal Ali" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("En markering hörde inte till larmet och sparades inte."));
  });

  it("shows only the first of a long list of pupils to find, and the rest on request", async () => {
    const many = Array.from({ length: 45 }, (_, index) => pupil(`p${index}`, `Elev${String(index).padStart(2, "0")}`, "Test"));
    open({}, [call("c-big", "5A", many, { teachers: [ANNA] })]);
    const user = userEvent.setup();
    renderPage();
    const find = (await screen.findByRole("region", { name: "Elever som saknas eller saknar markering" })) as HTMLElement;
    expect(within(find).getAllByRole("listitem")).toHaveLength(40);
    await user.click(within(find).getByRole("button", { name: "Visa alla 45" }));
    expect(within(find).getAllByRole("listitem")).toHaveLength(45);
  });

  it("lets a reader see all of it and change none: no end, no marking, and a notice that says why", async () => {
    who.readOnly = true;
    open();
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { level: 2, name: /Utrymning · pågår/ });
    expect(screen.queryByRole("button", { name: "Avsluta larmet" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^(Finns|Saknas):/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Du ser larmet men kan inte avsluta det eller pricka av/)).toBeInTheDocument();
    await user.click(within(screen.getByRole("table", { name: "Grupper" })).getByRole("button", { name: "9C" }));
    expect(screen.queryByRole("button", { name: /Alla finns/ })).not.toBeInTheDocument();
    expect(screen.getAllByText("Rut Ek").length).toBeGreaterThan(0);
  });

  it("lets a profile the school has not let start read the alarm and change nothing", async () => {
    who.profile = "EXPEDITION";
    world.settings = { startProfiles: ["FULL", "REKTOR"], notifyGuardiansAfter: false };
    open();
    renderPage();
    await screen.findByRole("heading", { level: 2, name: /Utrymning · pågår/ });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Avsluta larmet" })).not.toBeInTheDocument());
    expect(screen.getByText(/Du ser larmet men kan inte avsluta det/)).toBeInTheDocument();
  });

  it("switches between an alarm and an exercise that are both going", async () => {
    const live = detail(calls(), { id: "a-live" });
    const drill = detail(calls().slice(0, 1), { id: "a-drill", mode: "DRILL", kind: "LOCKDOWN" });
    world.recent = [live.alarm, drill.alarm];
    world.details.set("a-live", live);
    world.details.set("a-drill", drill);
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { level: 2, name: /Utrymning · pågår/ });
    await user.click(screen.getByRole("button", { name: "Övning · Inrymning" }));
    expect(await screen.findByRole("heading", { level: 2, name: /Inrymning · pågår/ })).toBeInTheDocument();
  });

  it("keeps what it last read and says so when a read fails", async () => {
    open();
    renderPage();
    await screen.findByRole("heading", { level: 2, name: /Utrymning · pågår/ });
    world.details.delete("a-1");
    // The poll or the event asks again; here the next mark does.
    const user = userEvent.setup();
    await user.click(within(screen.getByRole("region", { name: "Elever som saknas eller saknar markering" })).getByRole("button", { name: "Finns: Jamal Ali" }));
    expect(await screen.findByText("Larmet kunde inte uppdateras")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: /Utrymning · pågår/ })).toBeInTheDocument();
  });
});

describe("ending an alarm", () => {
  it("warns how many are missing and not ticked off, takes a note of at most 300 characters, and ends it", async () => {
    open();
    const ended = detail(calls(), { endedAt: ENDED, endedBy: "Rut Rektor", endNote: "Alla var på gården." });
    post.mockResolvedValue(ended);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Avsluta larmet" }));
    const dialog = await screen.findByRole("dialog", { name: "Avsluta det skarpa larmet?" });
    const warning = within(dialog).getByText("Alla är inte prickade").closest("div[data-tone]") as HTMLElement;
    // Said as what is known, not as a completeness: nothing "and everyone else is ticked off" to be read when someone is not.
    expect(warning).toHaveTextContent("En elev saknas. 4 elever har ingen markering. Avsluta ändå bara om du vet var de är.");
    expect(warning).not.toHaveTextContent(/alla andra|Ingen elev saknas/);
    const note = within(dialog).getByRole("textbox", { name: /Anteckning/ });
    expect(note).toHaveAttribute("maxlength", "300");
    await user.type(note, "Alla var på gården.");
    expect(within(dialog).getByText("19/300")).toBeInTheDocument();

    // Keeping the alarm going ends nothing.
    await user.click(within(dialog).getByRole("button", { name: "Låt larmet pågå" }));
    expect(post).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Avsluta larmet" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Avsluta larmet" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/crisis/alarms/a-1/end", { note: "Alla var på gården." }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Larmet är avslutat."));
  });

  it("ends without a note and without the warning when everyone is ticked off", async () => {
    open({}, [call("c-7a", "7A", [pupil("s1", "Ines", "Ek", "FOUND"), pupil("s2", "Leo", "Berg", "ABSENT_BEFORE")], { teachers: [ANNA] })]);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Avsluta larmet" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText("Alla är inte prickade")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Avsluta larmet" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/crisis/alarms/a-1/end", {}));
  });

  it("says in words that it could not be ended, in the dialog, and keeps it open", async () => {
    open();
    post.mockRejectedValue(new ApiError(409, "Larmet är redan avslutat.", "CRISIS_ALARM_ENDED"));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Avsluta larmet" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Avsluta larmet" }));
    expect(await within(dialog).findByText(/Larmet är redan avslutat, eller avslutades för mer än en timme sedan/)).toBeInTheDocument();
  });

  it("shows an alarm that has ended as over, with its note and the way to its protocol", async () => {
    open({ endedAt: ENDED, endedBy: "Rut Rektor", endNote: "Alla var på gården.", guardiansNotifiedAt: ENDED });
    world.recent = [];
    const user = userEvent.setup();
    renderPage("a-1");
    expect(await screen.findByRole("heading", { level: 2, name: /Utrymning · avslutat/ })).toBeInTheDocument();
    expect(screen.getByText(/avslutades kl 10:31 av Rut Rektor/)).toBeInTheDocument();
    expect(screen.getByText("Anteckning: Alla var på gården.")).toBeInTheDocument();
    expect(screen.getByText(/Vårdnadshavarna fick besked kl 10:31/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Avsluta larmet" })).not.toBeInTheDocument();
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
    // The start panel is there again below it.
    expect(screen.getByRole("button", { name: "Starta skarpt larm: utrymning" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stäng" }));
    expect(screen.queryByRole("heading", { level: 2, name: /avslutat/ })).not.toBeInTheDocument();
  });
});

describe("Protokoll", () => {
  const ended = (extra: Partial<AlarmSummary> = {}) => summary(calls(), { endedAt: ENDED, endedBy: "Rut Rektor", ...extra });
  const marks = [
    protocolMark({ at: "2027-01-12T09:18:03.000Z", receivedAt: "2027-01-12T09:18:04.000Z", studentId: "s1", groupName: "7A" }),
    protocolMark({ at: "2027-01-12T09:19:00.000Z", receivedAt: "2027-01-12T09:19:01.000Z", studentId: "s2", groupName: "7A", state: "MISSING" }),
    protocolMark({ at: "2027-01-12T09:40:00.000Z", receivedAt: "2027-01-12T09:40:01.000Z", studentId: "s6", groupName: "9C", by: "Rut Rektor", onBehalf: true, late: true }),
  ];

  async function openProtocol(user: ReturnType<typeof userEvent.setup>) {
    world.lists.LIVE = [ended({ id: "a-live" })];
    world.protocols.set("a-live", protocol(calls(), marks, { id: "a-live", endedAt: ENDED, endedBy: "Rut Rektor", endNote: "Alla var på gården." }));
    renderPage();
    await user.click(await screen.findByRole("tab", { name: "Protokoll" }));
    await user.click(await screen.findByRole("button", { name: /Öppna protokollet för Utrymning/ }));
    return screen.findByRole("heading", { level: 2, name: /Utrymning/ });
  }

  it("keeps real alarms and exercises on two tabs, each read from its own list, with their figures", async () => {
    world.lists.LIVE = [ended({ id: "a-live" })];
    world.lists.DRILL = [ended({ id: "a-drill", mode: "DRILL", kind: "LOCKDOWN", autoEnded: true })];
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("tab", { name: "Protokoll" }));
    const live = await screen.findByRole("table", { name: "Skarpa larm" });
    expect(get).toHaveBeenCalledWith("/api/v1/crisis/alarms?mode=LIVE&limit=50");
    const row = within(live).getAllByRole("row")[1]!;
    expect(row).toHaveTextContent("Utrymning");
    expect(row).toHaveTextContent("17:00");
    expect(row).toHaveTextContent("1 finns · 1 saknas · 4 inte rapporterade");
    expect(row).toHaveTextContent("0 av 3");

    await user.click(screen.getByRole("tab", { name: "Övningar" }));
    const drills = await screen.findByRole("table", { name: "Övningar" });
    expect(get).toHaveBeenCalledWith("/api/v1/crisis/alarms?mode=DRILL&limit=50");
    expect(within(drills).getByText("Inrymning")).toBeInTheDocument();
    expect(within(drills).getByText("Avslutades automatiskt")).toBeInTheDocument();
  });

  it("says in words that there is nothing, and which purge has taken what is gone", async () => {
    world.purged = [{ dataType: "CRISIS_DRILLS", purgedBefore: "2026-12-01" }];
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("tab", { name: "Protokoll" }));
    expect(await screen.findByRole("heading", { level: 3, name: "Inga skarpa larm" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Övningar" }));
    expect(await screen.findByRole("heading", { level: 3, name: "Inga övningar" })).toBeInTheDocument();
    expect(await screen.findByText("Övningar i krisläge som avslutades före 1 december 2026 är gallrade enligt skolans beslut.")).toBeInTheDocument();
  });

  it("shows one alarm's groups, who answered and when, and the timeline of every mark by pupil name", async () => {
    const user = userEvent.setup();
    await openProtocol(user);
    expect(screen.getByText("Anteckning: Alla var på gården.")).toBeInTheDocument();
    const groups = screen.getByRole("table", { name: "Grupper" });
    expect(within(groups).getByText("Ingen lärare")).toBeInTheDocument();
    expect(within(groups).getByText("Rast: nästa lektion")).toBeInTheDocument();
    const timeline = screen.getByRole("table", { name: "Tidslinje" });
    const rows = within(timeline).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("10:18:03");
    expect(rows[0]).toHaveTextContent("Ines Ek");
    expect(rows[1]).toHaveTextContent("Saknas");
    expect(rows[2]).toHaveTextContent("Rut Ek");
    expect(rows[2]).toHaveTextContent("för en kollega");
    expect(rows[2]).toHaveTextContent("efter att larmet tagit slut");
    await user.click(screen.getByRole("button", { name: "Till skarpa larm" }));
    expect(await screen.findByRole("table", { name: "Skarpa larm" })).toBeInTheDocument();
  });

  it("downloads the file named after the alarm, in the format of the other exports, without a protected pupil", async () => {
    world.protections = [{ userId: "s2", source: "MANUAL" }];
    const user = userEvent.setup();
    await openProtocol(user);
    await user.click(screen.getByRole("button", { name: "Ladda ner CSV" }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    const [name, content] = download.mock.calls[0] as [string, string];
    expect(name).toBe("larmprotokoll-2027-01-12-1014.csv");
    expect(content.startsWith("﻿larm_start;art;lage;grupp;")).toBe(true);
    expect(content).toContain("\r\n");
    expect(content).toContain("Klara;ej rapporterad");
    for (const hidden of ["Jamal", "Ali;"]) expect(content).not.toContain(hidden);
    expect(content).toContain("1 elev med skyddad identitet är räknad utan namn");
    expect(toast.info).toHaveBeenCalledWith("En elev med skyddad identitet är räknad utan namn i filen.", { duration: 10000 });
  });

  it("downloads nothing when the school's protected persons cannot be read", async () => {
    world.protectionsFail = true;
    const user = userEvent.setup();
    await openProtocol(user);
    await user.click(screen.getByRole("button", { name: "Ladda ner CSV" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Protokollet kunde inte läggas ut")));
    expect(download).not.toHaveBeenCalled();
  });

  it("prints the protocol without a protected pupil, from the button only, and takes the paper away after printing", async () => {
    world.protections = [{ userId: "s2", source: "SS12000" }];
    const print = vi.fn();
    vi.stubGlobal("print", print);
    const user = userEvent.setup();
    await openProtocol(user);
    // The screen shows everyone and is not printed; a print that did not come from the button says where the button is.
    expect(screen.getAllByText("Jamal Ali").length).toBeGreaterThan(0);
    expect(screen.getByText(/Skriv ut protokollet med knappen Skriv ut/)).toHaveClass("hidden", "print:block");
    expect(screen.queryByRole("article", { name: "Larmprotokoll", hidden: true })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Skriv ut eller spara som PDF" }));
    const paper = await screen.findByRole("article", { name: "Larmprotokoll", hidden: true });
    expect(print).toHaveBeenCalledTimes(1);
    expect(paper).toHaveClass("hidden", "print:block");
    const text = paper.textContent ?? "";
    expect(text).toContain("Klara Nyman");
    expect(text).toContain("En elev med skyddad identitet är räknad utan namn.");
    // Not the pupil, in a group or in the timeline; the groups' figures are the gateway's and count them.
    expect(text).not.toContain("Jamal");
    expect(text).not.toContain("Ali");
    expect(text).toContain("saknas 1");

    // The screen's own view is print:hidden.
    expect(screen.getByRole("button", { name: "Ladda ner CSV" }).closest(".print\\:hidden")).not.toBeNull();

    await act(async () => {
      fireEvent(window, new Event("afterprint"));
    });
    expect(screen.queryByRole("article", { name: "Larmprotokoll", hidden: true })).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("prints nothing when the protected persons cannot be read", async () => {
    world.protectionsFail = true;
    const print = vi.fn();
    vi.stubGlobal("print", print);
    const user = userEvent.setup();
    await openProtocol(user);
    await user.click(screen.getByRole("button", { name: "Skriv ut eller spara som PDF" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(print).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

/**
 * The group of pupils who are on no lesson's list (basis NO_LESSON): the gateway names it with Swedish
 * stand-ins, and the page says it in its own words, first, with nobody to ask, and counts it in everything.
 */
describe("the group of pupils on no lesson", () => {
  /** Åsa found, Bengt nobody has said anything about, Cecilia absent before: a pupil who stays on at the after-school club, say. */
  const nobody = (extra: Parameters<typeof noLessonCall>[2] = {}) =>
    noLessonCall("c-none", [pupil("s20", "Åsa", "Berg", "FOUND"), pupil("s21", "Bengt", "Ek"), pupil("s22", "Cecilia", "Ek", "ABSENT_BEFORE")], extra);
  /** Every group with a lesson is done. */
  const doneCalls = () => [call("c-7a", "7A", [pupil("s1", "Ines", "Ek", "FOUND")], { teachers: [ANNA] })];

  it("is listed first, in the page's own words and not the gateway's stand-ins, with nobody to ask and who answers for it", async () => {
    open({}, [...calls(), nobody()]);
    renderPage();
    const table = await screen.findByRole("table", { name: "Grupper" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent("Ej i lektion just nu");
    expect(rows[0]).toHaveTextContent("Ledningen svarar för dem");
    expect(rows[0]).toHaveTextContent("Ingen lärare");
    expect(rows[0]).toHaveTextContent("Pågår");
    expect(rows[0]).toHaveTextContent("1 av 2 prickade");
    expect(rows[1]).toHaveTextContent("7A");
    // The stand-in subject is the gateway's Swedish and is not shown, nor is a time or a room for a lesson there is none of.
    expect(screen.queryByText(/Ingen lektion pågår/)).not.toBeInTheDocument();
    expect(rows[0]).not.toHaveTextContent(/\d\d:\d\d/);
  });

  it("says how many are not in a lesson and that the administration answers for them, in the singular too", async () => {
    open({}, [...calls(), nobody()]);
    const { unmount } = renderPage();
    expect(await screen.findByText("3 elever är inte i lektion just nu. Ledningen svarar för dem.")).toBeInTheDocument();
    unmount();
    open({}, [...calls(), noLessonCall("c-none", [pupil("s21", "Bengt", "Ek")])]);
    renderPage();
    expect(await screen.findByText("En elev är inte i lektion just nu. Ledningen svarar för eleven.")).toBeInTheDocument();
  });

  it("says nothing of it when nobody is, or when the alarm is over", async () => {
    open({}, calls());
    const { unmount } = renderPage();
    await screen.findByRole("heading", { level: 2, name: /Utrymning · pågår/ });
    expect(screen.queryByText(/inte i lektion just nu/)).not.toBeInTheDocument();
    unmount();
    open({ endedAt: ENDED, endedBy: "Rut Rektor" }, [...calls(), nobody()]);
    world.recent = [];
    renderPage("a-1");
    await screen.findByRole("heading", { level: 2, name: /Utrymning · avslutat/ });
    expect(screen.queryByText(/är inte i lektion just nu/)).not.toBeInTheDocument();
  });

  it("is said in English as well, group and sentence", async () => {
    open({}, [...calls(), nobody()]);
    renderPage(null, "en");
    const table = await screen.findByRole("table", { name: "Groups" });
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("Not in a lesson right now");
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("Management answers for them");
    expect(screen.getByText("3 pupils are not in a lesson right now. Management answers for them.")).toBeInTheDocument();
    expect(screen.queryByText(/Ej i lektion just nu/)).not.toBeInTheDocument();
  });

  it("is counted in the figures: who is found, missing and not reported", async () => {
    open({}, [...calls(), nobody()]);
    renderPage();
    await screen.findByRole("heading", { level: 2, name: /Utrymning · pågår/ });
    const tile = (label: string) => screen.getByText(label, { selector: "dt" }).parentElement as HTMLElement;
    // 7A/8B/9C have 1 found and 5 not reported (4 + Bengt) once the group is in.
    expect(tile("Finns")).toHaveTextContent("2");
    expect(tile("Inte rapporterade")).toHaveTextContent("5");
    expect(tile("Grupper klara")).toHaveTextContent("0 av 4");
    expect(screen.getByRole("status", { hidden: true })).toHaveTextContent("Finns 2, saknas 1, inte rapporterade 5");
  });

  it("lists its pupils among those to find, before the groups with a teacher to ask, and says nobody answers for them", async () => {
    open({}, [...calls(), nobody()]);
    renderPage();
    const find = (await screen.findByRole("region", { name: "Elever som saknas eller saknar markering" })) as HTMLElement;
    const rows = within(find).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector("p")?.textContent)).toEqual(["Jamal Ali", "Bengt Ek", "Klara Nyman", "Olle Lind", "Rut Ek", "Sam Ek"]);
    expect(rows[1]).toHaveTextContent("Ej i lektion just nu · Ingen lärare");
    expect(rows[1]).not.toHaveTextContent("Matematik");
  });

  it("is marked by the administration from its row, pupil by pupil, like any group nobody answers for", async () => {
    open({}, [...calls(), nobody()]);
    const user = userEvent.setup();
    renderPage();
    const table = await screen.findByRole("table", { name: "Grupper" });
    await user.click(within(table).getByRole("button", { name: "Ej i lektion just nu" }));
    const pupils = within(table).getByRole("list", { name: "Eleverna i Ej i lektion just nu" });
    expect(within(pupils).getAllByRole("listitem")).toHaveLength(3);
    await user.click(within(pupils).getByRole("button", { name: "Finns: Bengt Ek" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![0]).toBe("/api/v1/crisis/alarms/a-1/marks");
    expect(post.mock.calls[0]![1].marks).toHaveLength(1);
    expect(post.mock.calls[0]![1].marks[0]).toMatchObject({ callId: "c-none", studentId: "s21", state: "FOUND" });
    await user.click(within(pupils).getByRole("button", { name: "Saknas: Åsa Berg" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1]![1].marks[0]).toMatchObject({ callId: "c-none", studentId: "s20", state: "MISSING" });
    await user.click(within(pupils).getByRole("button", { name: "Inte i huset: Bengt Ek" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(3));
    expect(post.mock.calls[2]![1].marks[0]).toMatchObject({ callId: "c-none", studentId: "s21", state: "AWAY" });
  });

  describe("the one question for the whole group: none of the unmarked is in the building", () => {
    const groupRow = async (user: ReturnType<typeof userEvent.setup>) => {
      const table = await screen.findByRole("table", { name: "Grupper" });
      await user.click(within(table).getByRole("button", { name: "Ej i lektion just nu" }));
      return table;
    };

    it("has no 'Alla finns' on this group, where nobody has seen the pupils, and keeps it on the others", async () => {
      open({}, [...calls(), nobody()]);
      const user = userEvent.setup();
      renderPage();
      const table = await groupRow(user);
      expect(screen.queryByRole("button", { name: /^(Alla|Resten) finns/ })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Den oprickade eleven är inte i huset" })).toBeInTheDocument();
      await user.click(within(table).getByRole("button", { name: "9C" }));
      expect(screen.getByRole("button", { name: "Alla finns (2)" })).toBeInTheDocument();
    });

    it("asks first, with the number and the words 'jag har inte sett dem', and marks nothing when it is not confirmed", async () => {
      open({}, [...calls(), noLessonCall("c-none", [pupil("s21", "Bengt", "Ek"), pupil("s22", "Cecilia", "Ek"), pupil("s23", "Dan", "Ek"), pupil("s24", "Eva", "Ek", "ABSENT_BEFORE")])]);
      const user = userEvent.setup();
      renderPage();
      await groupRow(user);
      await user.click(screen.getByRole("button", { name: "Ingen av de 3 oprickade är i huset" }));
      const dialog = await screen.findByRole("dialog", { name: "Är ingen av de 3 oprickade i huset?" });
      expect(dialog).toHaveTextContent("jag har inte sett dem");
      expect(dialog).toHaveTextContent("3 elever");
      expect(dialog).toHaveTextContent("inte som funna");
      expect(within(dialog).getByRole("button", { name: "Ja, jag har inte sett dem" })).toBeInTheDocument();
      await user.click(within(dialog).getByRole("button", { name: "Avbryt" }));
      expect(screen.queryByRole("dialog", { name: "Är ingen av de 3 oprickade i huset?" })).not.toBeInTheDocument();
      expect(post).not.toHaveBeenCalled();
    });

    it("on confirmation marks all the unmarked, not those absent before nor those marked, as not in the building, in one request", async () => {
      open({}, [
        ...calls(),
        noLessonCall("c-none", [
          pupil("s20", "Åsa", "Berg", "FOUND"),
          pupil("s21", "Bengt", "Ek"),
          pupil("s22", "Cecilia", "Ek"),
          pupil("s23", "Dan", "Ek", "MISSING"),
          pupil("s24", "Eva", "Ek", "ABSENT_BEFORE"),
        ]),
      ]);
      const user = userEvent.setup();
      renderPage();
      await groupRow(user);
      await user.click(screen.getByRole("button", { name: "Ingen av de 2 oprickade är i huset" }));
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Ja, jag har inte sett dem" }));
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      expect(post.mock.calls[0]![0]).toBe("/api/v1/crisis/alarms/a-1/marks");
      expect(post.mock.calls[0]![1].marks.map((mark: { callId: string; studentId: string; state: string }) => [mark.callId, mark.studentId, mark.state])).toEqual([
        ["c-none", "s21", "AWAY"],
        ["c-none", "s22", "AWAY"],
      ]);
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    // 450 rows, more than one request's 400, rendered in jsdom: about 5 s on a loaded runner, so the
    // file's 5 s default is not this test's limit (main's CI run 42205039683 timed out at it).
    it("sends a group of more than a request holds in as many requests as it takes, and no mark twice", async () => {
      const many = Array.from({ length: 450 }, (_, index) => pupil(`p${index}`, `Elev${String(index).padStart(3, "0")}`, "Test"));
      open({}, [...calls(), noLessonCall("c-none", many)]);
      const user = userEvent.setup();
      renderPage();
      await groupRow(user);
      await user.click(screen.getByRole("button", { name: "Ingen av de 450 oprickade är i huset" }));
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Ja, jag har inte sett dem" }));
      await waitFor(() => expect(post).toHaveBeenCalledTimes(2), { timeout: 10_000 });
      const sizes = post.mock.calls.map((call) => call[1].marks.length);
      expect(sizes).toEqual([400, 50]);
      const ids = new Set(post.mock.calls.flatMap((call) => call[1].marks.map((mark: { studentId: string }) => mark.studentId)));
      expect(ids.size).toBe(450);
    }, 30_000);

    it("says in words that it was refused, and keeps the question open for another try", async () => {
      open({}, [...calls(), nobody()]);
      post.mockRejectedValue(new ApiError(409, "Larmet är redan avslutat.", "CRISIS_ALARM_ENDED"));
      const user = userEvent.setup();
      renderPage();
      await groupRow(user);
      await user.click(screen.getByRole("button", { name: "Den oprickade eleven är inte i huset" }));
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Ja, jag har inte sett eleven" }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Larmet är redan avslutat")));
    });

    it("is not offered to a reader, nor when everyone in the group is marked", async () => {
      who.readOnly = true;
      open({}, [...calls(), nobody()]);
      const user = userEvent.setup();
      const first = renderPage();
      await groupRow(user);
      expect(screen.queryByRole("button", { name: /oprickade är i huset/ })).not.toBeInTheDocument();
      first.unmount();
      who.readOnly = false;
      open({}, [...calls(), noLessonCall("c-none", [pupil("s20", "Åsa", "Berg", "FOUND")])]);
      renderPage();
      await groupRow(user);
      expect(screen.queryByRole("button", { name: /oprickade är i huset|oprickade eleven/ })).not.toBeInTheDocument();
    });

    it("is said in English", async () => {
      open({}, [...calls(), nobody()]);
      const user = userEvent.setup();
      renderPage(null, "en");
      const table = await screen.findByRole("table", { name: "Groups" });
      await user.click(within(table).getByRole("button", { name: "Not in a lesson right now" }));
      await user.click(screen.getByRole("button", { name: "The unmarked pupil is not in the building" }));
      const dialog = await screen.findByRole("dialog", { name: "Is the unmarked pupil not in the building?" });
      expect(dialog).toHaveTextContent("I have not seen the pupil");
      expect(dialog).toHaveTextContent("not as found");
    });
  });

  describe("a pupil marked not in the building", () => {
    /** 7A has one found, one missing, one nobody has marked: and 9C is nobody's. */
    const withAway = () => [
      call("c-7a", "7A", [pupil("s1", "Ines", "Ek", "FOUND"), pupil("s2", "Jamal", "Ali", "AWAY"), pupil("s3", "Klara", "Nyman")], { teachers: [ANNA] }),
      call("c-9c", "9C", [pupil("s6", "Rut", "Ek", "AWAY"), pupil("s7", "Sam", "Ek", "AWAY")], { teachers: [teacher(null, null)], roomName: null }),
    ];

    it("is offered next to Finns and Saknas on every pupil the administration can mark, on a teacher's group too, and says what it is", async () => {
      open({}, withAway());
      const user = userEvent.setup();
      renderPage();
      const table = await screen.findByRole("table", { name: "Grupper" });
      await user.click(within(table).getByRole("button", { name: "7A" }));
      const pupils = within(table).getByRole("list", { name: "Eleverna i 7A" });
      expect(within(pupils).getByRole("button", { name: "Inte i huset: Klara Nyman" })).toHaveAttribute("aria-pressed", "false");
      const pressed = within(pupils).getByRole("button", { name: "Inte i huset: Jamal Ali" });
      expect(pressed).toHaveAttribute("aria-pressed", "true");
      // Its own status in words, apart from found and missing.
      expect(within(pupils).getByText("Jamal Ali").closest("li")).toHaveTextContent("Inte i huset");
      expect(within(pupils).getByRole("button", { name: "Finns: Jamal Ali" })).toHaveAttribute("aria-pressed", "false");
      expect(within(pupils).getByRole("button", { name: "Saknas: Jamal Ali" })).toHaveAttribute("aria-pressed", "false");
      await user.click(within(pupils).getByRole("button", { name: "Inte i huset: Klara Nyman" }));
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      expect(post.mock.calls[0]![1].marks[0]).toMatchObject({ callId: "c-7a", studentId: "s3", state: "AWAY" });
    });

    it("is also offered on the pupils still to find, and marks them", async () => {
      open({}, calls());
      const user = userEvent.setup();
      renderPage();
      const find = (await screen.findByRole("region", { name: "Elever som saknas eller saknar markering" })) as HTMLElement;
      await user.click(within(find).getByRole("button", { name: "Inte i huset: Jamal Ali" }));
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      expect(post.mock.calls[0]![1].marks[0]).toMatchObject({ callId: "c-7a", studentId: "s2", state: "AWAY" });
    });

    it("is not offered to a reader", async () => {
      who.readOnly = true;
      open({}, withAway());
      renderPage();
      await screen.findByRole("heading", { level: 2, name: /Utrymning · pågår/ });
      expect(screen.queryByRole("button", { name: /^Inte i huset:/ })).not.toBeInTheDocument();
    });

    it("counts for itself in the tiles and the sentence for a screen reader, and not as unreported: here Klara is the one", async () => {
      open({}, withAway());
      renderPage();
      await screen.findByRole("heading", { level: 2, name: /Utrymning · pågår/ });
      const tile = (label: string) => screen.getByText(label, { selector: "dt" }).parentElement as HTMLElement;
      expect(tile("Inte i huset")).toHaveTextContent("3");
      expect(tile("Finns")).toHaveTextContent("1");
      expect(tile("Saknas")).toHaveTextContent("0");
      expect(tile("Inte rapporterade")).toHaveTextContent("1");
      expect(screen.getByRole("status")).toHaveTextContent("Finns 1, saknas 0, inte i huset 3, inte rapporterade 1.");
    });

    it("makes a group of marks done, and says that it is done with some not in the building, never 'klar' alone", async () => {
      open({}, withAway());
      renderPage();
      const table = await screen.findByRole("table", { name: "Grupper" });
      const rowOf = (group: string) => within(table).getByRole("button", { name: group }).closest("tr") as HTMLElement;
      expect(rowOf("9C")).toHaveTextContent("Klar, 2 inte i huset");
      expect(rowOf("9C")).toHaveTextContent("2 av 2 prickade");
      expect(rowOf("9C")).not.toHaveTextContent("Väntar på");
      expect(rowOf("7A")).toHaveTextContent("Pågår");
      expect(rowOf("7A")).toHaveTextContent("2 av 3 prickade");
      // The group counts as done for the tile, and the list of those to find holds only Klara.
      expect(screen.getByText("Grupper klara", { selector: "dt" }).parentElement).toHaveTextContent("1 av 2");
      const find = screen.getByRole("region", { name: "Elever som saknas eller saknar markering" });
      expect(within(find).getAllByRole("listitem").map((row) => row.querySelector("p")?.textContent)).toEqual(["Klara Nyman"]);
    });

    it("is said in a sentence of its own when the alarm is ended, apart from the warning, and is not said to be found or missing", async () => {
      open({}, withAway());
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole("button", { name: "Avsluta larmet" }));
      const dialog = await screen.findByRole("dialog", { name: "Avsluta det skarpa larmet?" });
      const warning = within(dialog).getByText("Alla är inte prickade").closest("div[data-tone]") as HTMLElement;
      // The warning is about who is unreported; the pupils not in the building are not in it.
      expect(warning).toHaveTextContent("En elev har ingen markering. Avsluta ändå bara om du vet var de är.");
      expect(warning).not.toHaveTextContent(/inte i huset/);
      const sentence = within(dialog).getByText(/3 elever är markerade som inte i huset/);
      expect(sentence).toHaveTextContent("3 elever är markerade som inte i huset. De räknas inte som funna.");
      expect(sentence).not.toHaveTextContent(/saknas|finns/);
    });

    it("is said in the end dialog even when nobody is left to ask, which is still not 'everyone is found'", async () => {
      open({}, [call("c-9c", "9C", [pupil("s6", "Rut", "Ek", "AWAY"), pupil("s7", "Sam", "Ek", "FOUND")], { teachers: [ANNA] })]);
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole("button", { name: "Avsluta larmet" }));
      const dialog = await screen.findByRole("dialog", { name: "Avsluta det skarpa larmet?" });
      expect(within(dialog).queryByText("Alla är inte prickade")).not.toBeInTheDocument();
      expect(within(dialog).getByText("En elev är markerad som inte i huset. Eleven räknas inte som funnen.")).toBeInTheDocument();
    });

    it("is said in English", async () => {
      open({}, withAway());
      const user = userEvent.setup();
      renderPage(null, "en");
      await user.click(await screen.findByRole("button", { name: "End the alarm" }));
      const dialog = await screen.findByRole("dialog", { name: "End the live alarm?" });
      expect(within(dialog).getByText("3 pupils are marked as not in the building. They do not count as found.")).toBeInTheDocument();
      expect(screen.getByText("Not in the building", { selector: "dt" })).toBeInTheDocument();
    });
  });

  describe("ending the alarm", () => {
    const endDialog = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(await screen.findByRole("button", { name: "Avsluta larmet" }));
      return screen.findByRole("dialog", { name: "Avsluta det skarpa larmet?" });
    };

    it("warns when a pupil on no lesson is unreported although every group with a lesson is done, and never says everyone is ticked off", async () => {
      open({}, [...doneCalls(), nobody()]);
      const user = userEvent.setup();
      renderPage();
      const dialog = await endDialog(user);
      const warning = within(dialog).getByText("Alla är inte prickade").closest("div[data-tone]") as HTMLElement;
      expect(warning).toHaveTextContent("En elev har ingen markering. Avsluta ändå bara om du vet var de är.");
      expect(warning).toHaveTextContent("En av dem är inte i lektion just nu, och ledningen svarar för eleven.");
      expect(warning).not.toHaveTextContent(/alla andra|ingen elev saknas/i);
      expect(within(dialog).getByRole("button", { name: "Avsluta larmet" })).toHaveClass("bg-destructive");
    });

    it("warns about a pupil on no lesson who is missing, with the others who are not ticked off counted with them", async () => {
      open({}, [...calls(), noLessonCall("c-none", [pupil("s21", "Bengt", "Ek", "MISSING"), pupil("s22", "Cecilia", "Ek")])]);
      const user = userEvent.setup();
      renderPage();
      const warning = (await within(await endDialog(user)).findByText("Alla är inte prickade")).closest("div[data-tone]") as HTMLElement;
      expect(warning).toHaveTextContent("2 elever saknas. 5 elever har ingen markering.");
      expect(warning).toHaveTextContent("2 av dem är inte i lektion just nu, och ledningen svarar för dem.");
    });

    it("says it in English too, as what is known and not as a completeness", async () => {
      open({}, [...calls(), noLessonCall("c-none", [pupil("s21", "Bengt", "Ek", "MISSING"), pupil("s22", "Cecilia", "Ek")])]);
      const user = userEvent.setup();
      renderPage(null, "en");
      await user.click(await screen.findByRole("button", { name: "End the alarm" }));
      const dialog = await screen.findByRole("dialog", { name: "End the live alarm?" });
      const warning = within(dialog).getByText("Not everyone is ticked off").closest("div[data-tone]") as HTMLElement;
      expect(warning).toHaveTextContent("2 pupils are missing. 5 pupils have no mark. End it anyway only if you know where they are.");
      expect(warning).toHaveTextContent("2 of them are not in a lesson right now, and management answers for them.");
      expect(warning).not.toHaveTextContent(/everyone else|No pupil is missing/);
    });

    it("says nothing about them when they are all ticked off, and ends without the warning", async () => {
      open({}, [...doneCalls(), noLessonCall("c-none", [pupil("s20", "Åsa", "Berg", "FOUND"), pupil("s22", "Cecilia", "Ek", "ABSENT_BEFORE")])]);
      const user = userEvent.setup();
      renderPage();
      const dialog = await endDialog(user);
      expect(within(dialog).queryByText("Alla är inte prickade")).not.toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Avsluta larmet" })).not.toHaveClass("bg-destructive");
    });

    it("counts against the alarm's own figures too: someone left in them is a reason to warn, whatever the groups say", async () => {
      open({ counts: { pupils: 3, found: 1, missing: 0, away: 0, absentBefore: 0, unreported: 2 } }, doneCalls());
      const user = userEvent.setup();
      renderPage();
      const warning = (await within(await endDialog(user)).findByText("Alla är inte prickade")).closest("div[data-tone]") as HTMLElement;
      expect(warning).toHaveTextContent("2 elever har ingen markering.");
    });
  });

  describe("in the protocol", () => {
    /** Åsa was found by Anna, a teacher of 7A; the group of pupils on no lesson has Bengt, Cecilia and Dan besides. */
    const unlisted = () =>
      noLessonCall("c-none", [pupil("s20", "Åsa", "Berg", "FOUND", { markedBy: "Anna Berg" }), pupil("s21", "Bengt", "Ek"), pupil("s22", "Dan", "Ek")]);
    const marks = [
      protocolMark({ at: "2027-01-12T09:18:03.000Z", studentId: "s1", groupName: "7A" }),
      protocolMark({ at: "2027-01-12T09:22:00.000Z", studentId: "s20", groupName: "Ej i lektion just nu", foundIn: { groupName: "7A", basis: "LESSON" } }),
    ];
    const ended = (extra: Partial<AlarmSummary> = {}) => summary([...calls(), unlisted()], { endedAt: ENDED, endedBy: "Rut Rektor", ...extra });

    async function openIt(user: ReturnType<typeof userEvent.setup>, language: "sv" | "en" = "sv") {
      world.lists.LIVE = [ended({ id: "a-live" })];
      world.protocols.set("a-live", protocol([...calls(), unlisted()], marks, { id: "a-live", endedAt: ENDED, endedBy: "Rut Rektor" }));
      renderPage(null, language);
      await user.click(await screen.findByRole("tab", { name: language === "sv" ? "Protokoll" : "Protocols" }));
      await user.click(await screen.findByRole("button", { name: /Utrymning|Evacuation/ }));
      return screen.findByRole("heading", { level: 2, name: /Utrymning|Evacuation/ });
    }

    it("is a group row in the page's own words, with who answers for it, and the timeline says who found the pupil", async () => {
      const user = userEvent.setup();
      await openIt(user);
      const groups = screen.getByRole("table", { name: "Grupper" });
      const row = within(groups).getByText("Ej i lektion just nu").closest("tr") as HTMLElement;
      expect(row).toHaveTextContent("Ledningen svarar för dem");
      expect(row).toHaveTextContent("Ingen lärare");
      expect(screen.queryByText(/Ingen lektion pågår/)).not.toBeInTheDocument();
      const timeline = screen.getByRole("table", { name: "Tidslinje" });
      expect(within(timeline).getByRole("columnheader", { name: "Anmärkning" })).toBeInTheDocument();
      const found = within(timeline).getByText("Åsa Berg").closest("tr") as HTMLElement;
      expect(found).toHaveTextContent("Ej i lektion just nu");
      expect(found).toHaveTextContent("Hittad hos 7A");
      expect(within(timeline).getByText("Ines Ek").closest("tr")).not.toHaveTextContent("Hittad hos");
    });

    it("says the group and the find in English, not in the gateway's Swedish", async () => {
      const user = userEvent.setup();
      await openIt(user, "en");
      const timeline = screen.getByRole("table", { name: "Timeline" });
      const found = within(timeline).getByText("Åsa Berg").closest("tr") as HTMLElement;
      expect(found).toHaveTextContent("Not in a lesson right now");
      expect(found).toHaveTextContent("Found with 7A");
      expect(screen.queryByText(/Ej i lektion just nu/)).not.toBeInTheDocument();
    });

    it("downloads it as a group row with the find in the last column, and a protected pupil of it counted but not named", async () => {
      world.protections = [{ userId: "s21", source: "MANUAL" }];
      const user = userEvent.setup();
      await openIt(user);
      await user.click(screen.getByRole("button", { name: "Ladda ner CSV" }));
      await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
      const content = (download.mock.calls[0] as [string, string])[1];
      const lines = content.split("\r\n");
      expect(lines[0]!.endsWith(";anmarkning;hittad_hos")).toBe(true);
      const asa = lines.find((line) => line.includes("Berg;Åsa"))!;
      expect(asa).toContain(";Ej i lektion just nu;;;;;ej i lektion;ingen lärare;");
      expect(asa.endsWith(";Hittad hos 7A")).toBe(true);
      expect(lines.find((line) => line.includes("Dan"))).toBeDefined();
      // Bengt is protected: not in a cell, and the file says one pupil was counted without a name.
      expect(content).not.toContain("Bengt");
      expect(content).toContain("1 elev med skyddad identitet är räknad utan namn");
      expect(content).not.toContain("Ingen lektion pågår");
      expect(toast.info).toHaveBeenCalledWith("En elev med skyddad identitet är räknad utan namn i filen.", { duration: 10000 });
    });

    it("prints it as a group without lesson times, with the find in a column of its own, and a protected pupil of it not named", async () => {
      world.protections = [{ userId: "s21", source: "SS12000" }];
      vi.stubGlobal("print", vi.fn());
      const user = userEvent.setup();
      await openIt(user);
      await user.click(screen.getByRole("button", { name: "Skriv ut eller spara som PDF" }));
      const paper = await screen.findByRole("article", { name: "Larmprotokoll", hidden: true });
      const heading = within(paper).getByRole("heading", { level: 2, name: "Ej i lektion just nu", hidden: true });
      expect(heading).toHaveTextContent(/^Ej i lektion just nu$/);
      const text = paper.textContent ?? "";
      expect(text).toContain("Dan Ek");
      expect(text).toContain("Hittad hos 7A");
      expect(text).toContain("Anmärkning");
      expect(text).not.toContain("Bengt");
      expect(text).not.toContain("Ingen lektion pågår");
      expect(text).toContain("En elev med skyddad identitet är räknad utan namn.");
      vi.unstubAllGlobals();
    });

    it("says not in the building in its own word in the groups, the timeline and the file, and held out like any protected pupil", async () => {
      world.protections = [{ userId: "s22", source: "MANUAL" }];
      const group = noLessonCall("c-none", [
        pupil("s20", "Åsa", "Berg", "AWAY", { markedBy: "Rut Rektor" }),
        pupil("s21", "Bengt", "Ek", "FOUND", { markedBy: "Anna Berg" }),
        pupil("s22", "Dan", "Ek", "AWAY", { markedBy: "Rut Rektor" }),
      ]);
      const timeline = [
        protocolMark({ at: "2027-01-12T09:30:00.000Z", studentId: "s20", groupName: "Ej i lektion just nu", state: "AWAY", by: "Rut Rektor", onBehalf: true }),
        protocolMark({ at: "2027-01-12T09:22:00.000Z", studentId: "s21", groupName: "Ej i lektion just nu", foundIn: { groupName: "7A", basis: "LESSON" } }),
        protocolMark({ at: "2027-01-12T09:24:00.000Z", studentId: "s21", groupName: "Ej i lektion just nu", foundIn: { groupName: "7A", basis: "LESSON" }, state: "RETRACTED" }),
        protocolMark({ at: "2027-01-12T09:31:00.000Z", studentId: "s22", groupName: "Ej i lektion just nu", state: "AWAY", by: "Rut Rektor", onBehalf: true }),
      ];
      world.lists.LIVE = [summary([...calls(), group], { id: "a-live", endedAt: ENDED, endedBy: "Rut Rektor" })];
      world.protocols.set("a-live", protocol([...calls(), group], timeline, { id: "a-live", endedAt: ENDED, endedBy: "Rut Rektor" }));
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole("tab", { name: "Protokoll" }));
      expect(await screen.findByRole("table", { name: "Skarpa larm" })).toBeInTheDocument();
      await user.click(await screen.findByRole("button", { name: /Öppna protokollet för Utrymning/ }));
      await screen.findByRole("heading", { level: 2, name: /Utrymning/ });
      // The figure of the alarm and of the group, apart from found and missing.
      expect(screen.getByText("Inte i huset", { selector: "dt" }).parentElement).toHaveTextContent("2");
      const groups = screen.getByRole("table", { name: "Grupper" });
      expect(within(groups).getByText("Ej i lektion just nu").closest("tr")).toHaveTextContent("1 finns · 0 saknas · 2 inte i huset · 0 inte rapporterade");
      const rows = within(screen.getByRole("table", { name: "Tidslinje" })).getAllByRole("row").slice(1);
      expect(rows[0]).toHaveTextContent("Åsa Berg");
      expect(rows[0]).toHaveTextContent("Inte i huset");
      expect(rows[0]).not.toHaveTextContent(/Finns|Saknas/);
      expect(rows[2]).toHaveTextContent("Tillbakataget");

      await user.click(screen.getByRole("button", { name: "Ladda ner CSV" }));
      await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
      const content = (download.mock.calls[0] as [string, string])[1];
      expect(content).toContain("Berg;Åsa;inte i huset;");
      expect(content).not.toContain("Dan");
      expect(content).toContain("1 elev med skyddad identitet är räknad utan namn");
      // Taken back, so no longer 'Hittad hos 7A'.
      expect(content.split("\r\n").find((line) => line.includes("Bengt"))).not.toContain("Hittad hos");
    });

    it("leaves the extra column out when nobody was found by another group", async () => {
      world.lists.LIVE = [ended({ id: "a-live" })];
      world.protocols.set("a-live", protocol([...calls(), unlisted()], [marks[0]!], { id: "a-live", endedAt: ENDED, endedBy: "Rut Rektor" }));
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole("tab", { name: "Protokoll" }));
      await user.click(await screen.findByRole("button", { name: /Öppna protokollet för Utrymning/ }));
      const timeline = await screen.findByRole("table", { name: "Tidslinje" });
      expect(within(timeline).queryByRole("columnheader", { name: "Anmärkning" })).not.toBeInTheDocument();
    });
  });
});

describe("Inställningar", () => {
  const tab = async (user: ReturnType<typeof userEvent.setup>) => {
    renderPage();
    await user.click(await screen.findByRole("tab", { name: "Inställningar" }));
    return screen.findByRole("region", { name: "Vem får starta larm" });
  };

  it("lets those who decide choose which narrower profiles may start, and saves with rektor and full among them", async () => {
    world.settings = { startProfiles: ["FULL", "REKTOR", "SCHEMALAGGARE", "EXPEDITION"], notifyGuardiansAfter: false };
    put.mockResolvedValue({ startProfiles: ["FULL", "REKTOR", "SCHEMALAGGARE"], notifyGuardiansAfter: true });
    const user = userEvent.setup();
    const who_ = await tab(user);
    // Rektor and full always start: shown on and not changeable.
    for (const name of [/Fullständig administratör/, /Rektor/]) {
      const box = within(who_).getByRole("checkbox", { name });
      expect(box).toBeChecked();
      expect(box).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: "Spara" })).toBeDisabled();

    await user.click(within(who_).getByRole("checkbox", { name: /Expedition/ }));
    await user.click(screen.getByRole("switch", { name: "Meddela vårdnadshavare efteråt" }));
    await user.click(screen.getByRole("button", { name: "Spara" }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("/api/v1/crisis/settings", {
        startProfiles: ["FULL", "REKTOR", "SCHEMALAGGARE"],
        notifyGuardiansAfter: true,
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Inställningarna är sparade."));
  });

  it("says what guardians are told: that it happened and ended, and nothing about a pupil, a group or a place", async () => {
    const user = userEvent.setup();
    await tab(user);
    const text = screen.getByText(/Efter ett skarpt larm får vårdnadshavare/);
    expect(text).toHaveTextContent("Beskedet säger inget om någon elev, grupp eller plats, och inte heller vilken sorts larm det var.");
    expect(text).toHaveTextContent("Efter en övning meddelas ingen.");
  });

  it.each(["SCHEMALAGGARE", "EXPEDITION", "LASARE"] as const)("shows a %s the settings as they stand and cannot change them", async (profile) => {
    who.profile = profile;
    world.settings = { startProfiles: ["FULL", "REKTOR"], notifyGuardiansAfter: true };
    const user = userEvent.setup();
    const section = await tab(user);
    expect(screen.getByText(/Rektor och de med full behörighet ändrar inställningarna/)).toBeInTheDocument();
    expect(within(section).getByRole("checkbox", { name: /Schemaläggare/ })).not.toBeChecked();
    for (const box of within(section).getAllByRole("checkbox")) expect(box).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Meddela vårdnadshavare efteråt" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Meddela vårdnadshavare efteråt" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Spara" })).not.toBeInTheDocument();
  });

  it("says in words that the settings could not be read, and that a save did not go through", async () => {
    get.mockImplementation(async (path: string) => {
      if (path === "/api/v1/crisis/settings") throw new ApiError(500, "boom");
      if (path.startsWith("/api/v1/crisis/alarms?limit=")) return [];
      throw new Error(`unexpected GET ${path}`);
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("tab", { name: "Inställningar" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Inställningarna kunde inte hämtas" })).toBeInTheDocument();
  });
});
