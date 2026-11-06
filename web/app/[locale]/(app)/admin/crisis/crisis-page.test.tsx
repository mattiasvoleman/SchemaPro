import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { ApiError, api } from "@/lib/api";
import type { AdminProfile } from "@/lib/admin-areas";
import type { AlarmDetail, AlarmSummary, CrisisSettings, ProtocolView } from "@/lib/crisis-types";
import { detail, call, protocol, pupil, summary, teacher, ENDED } from "@/lib/__fixtures__/crisis";
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

function renderPage(initialAlarmId: string | null = null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
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
    expect(warning).toHaveTextContent("En elev saknas och 4 elever har ingen markering.");
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
    { at: "2027-01-12T09:18:03.000Z", receivedAt: "2027-01-12T09:18:04.000Z", studentId: "s1", groupName: "7A", state: "FOUND" as const, by: "Anna Berg", onBehalf: false, late: false },
    { at: "2027-01-12T09:19:00.000Z", receivedAt: "2027-01-12T09:19:01.000Z", studentId: "s2", groupName: "7A", state: "MISSING" as const, by: "Anna Berg", onBehalf: false, late: false },
    { at: "2027-01-12T09:40:00.000Z", receivedAt: "2027-01-12T09:40:01.000Z", studentId: "s6", groupName: "9C", state: "FOUND" as const, by: "Rut Rektor", onBehalf: true, late: true },
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
    expect(text).toHaveTextContent("Beskedet säger inget om någon elev, grupp eller plats.");
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
