import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { ApiError, api } from "@/lib/api";
import { LEGACY_KEYS, queueKey, snapshotKey } from "@/lib/crisis-queue";
import type { MarkInput } from "@/lib/crisis-types";
import { foundHere, mine, myAlarm, myCall, other, pupil } from "@/lib/__fixtures__/crisis";
import TeacherCrisisPage from "./page";

/**
 * /teacher/crisis over the real hooks, the real queue and the Swedish
 * messages, the gateway answering by path. What only this page decides: that
 * a teacher sees their groups of the alarm that is going, says Finns or
 * Saknas with a 44 px target and sees the mark as waiting until the gateway
 * has taken it; that the list stays when the signal is gone, with the time it
 * was fetched, and the marks are sent when it is back; and what is thrown away
 * (the gateway said no) and what is not (it could not answer).
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn() } };
});
const get = api.get as unknown as Mock;
const post = api.post as unknown as Mock;
// Who is signed in: the queue and the list kept on the device are theirs (lib/crisis-queue.ts).
const who = vi.hoisted(() => ({ id: "t-me" }));
vi.mock("@/components/profile-context", () => ({
  useProfile: () => ({ profile: { id: who.id, role: "TEACHER" }, school: { timezone: "Europe/Stockholm" } }),
}));
// The socket is its own test (lib/use-crisis-realtime.test.tsx); here the page polls.
vi.mock("@/lib/use-crisis-realtime", () => ({ useCrisisRealtime: () => undefined }));

const MARKS = "/api/v1/crisis/mine/marks";
const asOf = "2027-01-12T09:20:00.000Z";

const sevenA = () =>
  myCall(
    "c-7a",
    "7A",
    [
      pupil("s1", "Ines", "Ek"),
      pupil("s2", "Jamal", "Ali", "MISSING"),
      pupil("s3", "Klara", "Nyman"),
      pupil("s4", "Leo", "Berg", "ABSENT_BEFORE"),
      pupil("s5", "Maja", "Lind", "FOUND"),
    ],
    { colleagues: ["Bo Ek"] },
  );
const nextLesson = () =>
  myCall("c-8b", "8B", [pupil("s6", "Olle", "Lind")], {
    basis: "NEXT_LESSON",
    subjectName: "Engelska",
    lessonStartsAt: "2027-01-12T09:30:00.000Z",
    lessonEndsAt: "2027-01-12T10:20:00.000Z",
  });
const going = () => mine([myAlarm([sevenA(), nextLesson()])], asOf);

function answerWith(response: unknown) {
  get.mockImplementation(async (path: string) => {
    if (path === "/api/v1/crisis/mine") {
      if (response instanceof Error) throw response;
      return response;
    }
    throw new Error(`unexpected GET ${path}`);
  });
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <TeacherCrisisPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const group = (name: string) => screen.getByRole("region", { name });
const sentMarks = (): MarkInput[] => post.mock.calls.flatMap(([, body]) => (body as { marks: MarkInput[] }).marks);
const queuedOf = (id: string): MarkInput[] => JSON.parse(localStorage.getItem(queueKey(id)) ?? "[]");
const queued = (): MarkInput[] => queuedOf(who.id);
const QUEUE_KEY = queueKey("t-me");
const SNAPSHOT_KEY = snapshotKey("t-me");

beforeEach(() => {
  vi.resetAllMocks();
  who.id = "t-me";
  localStorage.clear();
  answerWith(going());
  post.mockResolvedValue({ stored: 1, duplicates: 0, unresolved: [] });
});
afterEach(() => vi.restoreAllMocks());

describe("/teacher/crisis with a network", () => {
  it("lists the groups of the alarm that is going: whether it is real, its kind, the break's next lesson and the colleagues", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { level: 2, name: "Utrymning" })).toBeInTheDocument();
    expect(screen.getByText("Skarpt larm")).toBeInTheDocument();
    expect(screen.getByText(/Startades kl 10:14/)).toBeInTheDocument();
    expect(within(group("7A")).getByText("Tillsammans med Bo Ek")).toBeInTheDocument();
    // In a break, the group the teacher has next lesson, said so.
    expect(within(group("8B")).getByText("Rast: du har gruppen nästa lektion (10:30)")).toBeInTheDocument();
    expect(within(group("7A")).queryByText(/Rast:/)).not.toBeInTheDocument();
    // Nothing says the list is old.
    expect(screen.queryByText("Ingen kontakt med servern")).not.toBeInTheDocument();
  });

  it("says an exercise is an exercise", async () => {
    answerWith(mine([myAlarm([sevenA()], { mode: "DRILL", kind: "LOCKDOWN" })], asOf));
    renderPage();
    expect(await screen.findByRole("heading", { level: 2, name: "Inrymning" })).toBeInTheDocument();
    expect(screen.getByText("Övning")).toBeInTheDocument();
    expect(screen.queryByText("Skarpt larm")).not.toBeInTheDocument();
  });

  it("counts the pupils of the alarm in a live region, and each group's own", async () => {
    renderPage();
    await screen.findByRole("heading", { level: 2, name: "Utrymning" });
    // 7A: 1 found, 1 missing, 2 not reported, 1 absent before; 8B: 1 not reported.
    const live = screen.getByRole("status");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent("1 Finns");
    expect(live).toHaveTextContent("1 Saknas");
    expect(live).toHaveTextContent("3 Inte rapporterade");
    expect(live).toHaveTextContent("1 Frånvarande sedan tidigare");
    expect(within(group("8B")).getByText("Inte rapporterade").closest("li")).toHaveTextContent("1 Inte rapporterade");
  });

  it("shows a pupil's status in words and gives Finns and Saknas a 44 px target, the pressed one pressed", async () => {
    renderPage();
    await screen.findByRole("region", { name: "7A" });
    const found = screen.getByRole("button", { name: "Finns: Maja Lind" });
    const missing = screen.getByRole("button", { name: "Saknas: Jamal Ali" });
    expect(found).toHaveAttribute("aria-pressed", "true");
    expect(missing).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Saknas: Maja Lind" })).toHaveAttribute("aria-pressed", "false");
    for (const button of [found, missing]) expect(button).toHaveClass("h-11");
    // The pupil who was absent before needs no mark, and says why.
    const pupils = within(screen.getByRole("list", { name: "Eleverna i 7A" }));
    expect(pupils.getByText("Frånvarande sedan tidigare")).toBeInTheDocument();
    expect(pupils.getByText("registrerad frånvaro")).toBeInTheDocument();
  });

  it("sends a mark with its own id, the group, the pupil and the time, shows it as waiting until the gateway has answered, and then not", async () => {
    let answer!: (value: unknown) => void;
    post.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("region", { name: "7A" });

    await user.click(screen.getByRole("button", { name: "Saknas: Klara Nyman" }));
    // At once, from the device: the mark is the pupil's status and it waits.
    expect(screen.getByRole("button", { name: "Saknas: Klara Nyman" })).toHaveAttribute("aria-pressed", "true");
    expect(within(group("7A")).getByText("Väntar på att skickas")).toBeInTheDocument();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, body] = post.mock.calls[0]!;
    expect(path).toBe(MARKS);
    expect(body.marks).toHaveLength(1);
    expect(body.marks[0]).toMatchObject({ callId: "c-7a", studentId: "s3", state: "MISSING" });
    expect(body.marks[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(body.marks[0].at)).not.toBeNaN();
    expect(queued()).toHaveLength(1);

    // The gateway has it: the list it answers next holds the mark, and nothing waits.
    answerWith(
      mine([myAlarm([myCall("c-7a", "7A", [pupil("s1", "Ines", "Ek"), pupil("s3", "Klara", "Nyman", "MISSING")]), nextLesson()])], asOf),
    );
    await act(async () => answer({ stored: 1, duplicates: 0, unresolved: [] }));
    await waitFor(() => expect(screen.queryByText("Väntar på att skickas")).not.toBeInTheDocument());
    expect(queued()).toEqual([]);
    expect(screen.getByRole("button", { name: "Saknas: Klara Nyman" })).toHaveAttribute("aria-pressed", "true");
  });

  it("does not send a mark that is already the pupil's status", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("region", { name: "7A" });
    await user.click(screen.getByRole("button", { name: "Finns: Maja Lind" }));
    await user.click(screen.getByRole("button", { name: "Saknas: Jamal Ali" }));
    expect(post).not.toHaveBeenCalled();
  });

  it("marks the whole group found in one call, those nobody has marked and nobody else", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("region", { name: "7A" });
    // Jamal is marked missing: one tap for the group must not overwrite that. The label says there is a rest.
    await user.click(within(group("7A")).getByRole("button", { name: "Resten finns (2)" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(sentMarks().map((mark) => [mark.studentId, mark.state]).sort()).toEqual([
      ["s1", "FOUND"],
      ["s3", "FOUND"],
    ]);
    // 8B has nobody missing: all of it.
    await user.click(within(group("8B")).getByRole("button", { name: "Alla finns (1)" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(sentMarks().map((mark) => mark.studentId)).toContain("s6");
  });

  it("leaves a group that has everything marked without the button", async () => {
    answerWith(mine([myAlarm([myCall("c-7a", "7A", [pupil("s1", "Ines", "Ek", "FOUND"), pupil("s4", "Leo", "Berg", "ABSENT_BEFORE")])])], asOf));
    renderPage();
    await screen.findByRole("region", { name: "7A" });
    expect(screen.queryByRole("button", { name: /^(Alla|Resten) finns/ })).not.toBeInTheDocument();
  });

  it("shows an alarm that has ended without buttons: what was ticked off is saved", async () => {
    answerWith(mine([myAlarm([sevenA()], { endedAt: "2027-01-12T09:31:00.000Z", endedBy: "Rut Rektor" })], asOf));
    renderPage();
    expect(await screen.findByRole("heading", { level: 2, name: "Utrymning · avslutat" })).toBeInTheDocument();
    expect(screen.getByText("Avslutades kl 10:31")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Finns:|Saknas:/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /finns \(/ })).not.toBeInTheDocument();
  });

  it("says in words that no alarm is going, rather than an empty page", async () => {
    answerWith(mine([], asOf));
    renderPage();
    expect(await screen.findByRole("heading", { level: 2, name: "Inget larm pågår" })).toBeInTheDocument();
  });
});

describe("/teacher/crisis on a bad network", () => {
  const snapshot = (receivedAt = Date.now() - 60_000) => JSON.stringify({ receivedAt, data: going() });
  const savedMark = (id: string): MarkInput => ({ id, callId: "c-7a", studentId: "s1", state: "MISSING", at: "2027-01-12T09:21:00.000Z" });

  it("shows the list it kept, with the time it was fetched, when the signal is gone", async () => {
    localStorage.setItem(SNAPSHOT_KEY, snapshot());
    answerWith(new TypeError("Failed to fetch"));
    renderPage();
    expect(await screen.findByRole("region", { name: "7A" })).toBeInTheDocument();
    expect(await screen.findByText("Ingen kontakt med servern")).toBeInTheDocument();
    expect(screen.getByText(/Listan hämtades kl 10:20\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Försök igen" })).toBeInTheDocument();
  });

  it("keeps the list when a read fails after one worked, and says how old it is", async () => {
    renderPage();
    await screen.findByRole("region", { name: "7A" });
    expect(screen.queryByText("Ingen kontakt med servern")).not.toBeInTheDocument();
    answerWith(new TypeError("Failed to fetch"));
    await userEvent.setup().click(within(group("7A")).getByRole("button", { name: "Finns: Ines Ek" }));
    // The next read fails (the tap's own invalidation, the poll): the list stays, the page says so.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(screen.getByRole("region", { name: "7A" })).toBeInTheDocument();
  });

  it("holds a mark made offline as waiting, and sends it with its own id when the network is back", async () => {
    localStorage.setItem(SNAPSHOT_KEY, snapshot());
    answerWith(new TypeError("Failed to fetch"));
    post.mockRejectedValue(new TypeError("Failed to fetch"));
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("region", { name: "7A" });

    await user.click(screen.getByRole("button", { name: "Saknas: Klara Nyman" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    // Still there: pressed, waiting, counted, and kept on the device.
    expect(screen.getByRole("button", { name: "Saknas: Klara Nyman" })).toHaveAttribute("aria-pressed", "true");
    expect(within(group("7A")).getByText("Väntar på att skickas")).toBeInTheDocument();
    expect(screen.getByText("1 markering väntar på att skickas.")).toBeInTheDocument();
    expect(queued()).toHaveLength(1);
    const id = queued()[0]!.id;

    // The network is back.
    post.mockReset();
    post.mockResolvedValue({ stored: 1, duplicates: 0, unresolved: [] });
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![1].marks[0].id).toBe(id);
    await waitFor(() => expect(queued()).toEqual([]));
    await waitFor(() => expect(screen.queryByText(/väntar på att skickas/)).not.toBeInTheDocument());
  });

  it("sends what an earlier visit left in the queue, at once, without a tap", async () => {
    localStorage.setItem(SNAPSHOT_KEY, snapshot());
    localStorage.setItem(QUEUE_KEY, JSON.stringify([savedMark("m-old")]));
    renderPage();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![1].marks.map((mark: MarkInput) => mark.id)).toEqual(["m-old"]);
    await waitFor(() => expect(queued()).toEqual([]));
  });

  it("does not throw a mark away because the network gave out: a lost answer is sent again, and stored once by its id", async () => {
    localStorage.setItem(QUEUE_KEY, JSON.stringify([savedMark("m-1")]));
    post.mockRejectedValue(new ApiError(503, "Service unavailable"));
    renderPage();
    await screen.findByRole("region", { name: "7A" });
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(queued().map((mark) => mark.id)).toEqual(["m-1"]);
    expect(screen.queryByText(/kunde inte sparas/)).not.toBeInTheDocument();
  });

  it("throws away a mark the alarm no longer takes, and says so with the group", async () => {
    localStorage.setItem(QUEUE_KEY, JSON.stringify([savedMark("m-1")]));
    post.mockRejectedValue(new ApiError(409, "Larmet är redan avslutat.", "CRISIS_ALARM_ENDED"));
    const user = userEvent.setup();
    renderPage();
    const notice = await screen.findByText("En markering kunde inte sparas");
    expect(notice).toBeInTheDocument();
    expect(screen.getByText(/Larmet är redan avslutat, eller avslutades för mer än en timme sedan/)).toBeInTheDocument();
    expect(screen.getByText(/\(7A\)/)).toBeInTheDocument();
    expect(queued()).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Stäng meddelandet" }));
    expect(screen.queryByText("En markering kunde inte sparas")).not.toBeInTheDocument();
  });

  it("says a 404 and a refused pupil in words of their own, and keeps the other marks", async () => {
    localStorage.setItem(QUEUE_KEY, JSON.stringify([{ ...savedMark("m-1"), studentId: "s9" }, savedMark("m-2")]));
    post.mockImplementation(async (_path: string, body: { marks: MarkInput[] }) => {
      if (body.marks.some((mark) => mark.studentId === "s9")) throw new ApiError(400, "Eleven står inte på gruppens lista.", "CRISIS_MARK_INVALID");
      return { stored: body.marks.length, duplicates: 0, unresolved: [] };
    });
    renderPage();
    expect(await screen.findByText("Eleven står inte på gruppens lista.", { exact: false })).toBeInTheDocument();
    expect(sentMarks().map((mark) => mark.id)).toContain("m-2");
    await waitFor(() => expect(queued()).toEqual([]));
  });

  it("works without a storage at all: the list, the marks and the sending", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("region", { name: "7A" });
    await user.click(screen.getByRole("button", { name: "Saknas: Klara Nyman" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  });

  it("says in words that the list could not be fetched, when there is none to show, and tries again on request", async () => {
    answerWith(new TypeError("Failed to fetch"));
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByRole("heading", { level: 2, name: "Larmen kunde inte hämtas" })).toBeInTheDocument();
    answerWith(going());
    await user.click(screen.getByRole("button", { name: "Försök igen" }));
    expect(await screen.findByRole("region", { name: "7A" })).toBeInTheDocument();
  });

  it("does not show a list that is hours old as the truth about an alarm", async () => {
    localStorage.setItem(SNAPSHOT_KEY, snapshot(Date.now() - 5 * 3_600_000));
    answerWith(new TypeError("Failed to fetch"));
    renderPage();
    expect(await screen.findByRole("heading", { level: 2, name: "Larmen kunde inte hämtas" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "7A" })).not.toBeInTheDocument();
  });
});

describe("/teacher/crisis on a browser several logins use", () => {
  const snapshotFor = (receivedAt = Date.now() - 60_000) => JSON.stringify({ receivedAt, data: going() });
  const markOf = (id: string, studentId = "s1"): MarkInput => ({ id, callId: "c-7a", studentId, state: "MISSING", at: "2027-01-12T09:21:00.000Z" });

  it("sends only the signed-in login's marks, and leaves another login's where they are", async () => {
    localStorage.setItem(queueKey("t-anna"), JSON.stringify([markOf("m-anna")]));
    localStorage.setItem(queueKey("t-me"), JSON.stringify([markOf("m-mine", "s3")]));
    renderPage();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(sentMarks().map((mark) => mark.id)).toEqual(["m-mine"]);
    await waitFor(() => expect(queuedOf("t-me")).toEqual([]));
    expect(queuedOf("t-anna").map((mark) => mark.id)).toEqual(["m-anna"]);
  });

  it("does not show another login's list when the signal is gone, and keeps its own", async () => {
    localStorage.setItem(snapshotKey("t-anna"), JSON.stringify({ receivedAt: Date.now() - 60_000, data: mine([myAlarm([myCall("c-x", "Annas grupp", [pupil("sx", "Xenia", "Ek")])])]) }));
    answerWith(new TypeError("Failed to fetch"));
    const first = renderPage();
    expect(await screen.findByRole("heading", { level: 2, name: "Larmen kunde inte hämtas" })).toBeInTheDocument();
    expect(screen.queryByText("Annas grupp")).not.toBeInTheDocument();
    first.unmount();

    // Their own list is shown, and what it holds is theirs alone.
    localStorage.setItem(SNAPSHOT_KEY, snapshotFor());
    renderPage();
    expect(await screen.findByRole("region", { name: "7A" })).toBeInTheDocument();
    expect(screen.queryByText("Annas grupp")).not.toBeInTheDocument();
  });

  it("takes the next login on the same browser to a page without the last one's marks or list", async () => {
    answerWith(new TypeError("Failed to fetch"));
    post.mockRejectedValue(new TypeError("Failed to fetch"));
    localStorage.setItem(SNAPSHOT_KEY, snapshotFor());
    const user = userEvent.setup();
    const first = renderPage();
    await screen.findByRole("region", { name: "7A" });
    await user.click(screen.getByRole("button", { name: "Saknas: Klara Nyman" }));
    await waitFor(() => expect(queuedOf("t-me")).toHaveLength(1));
    first.unmount();

    who.id = "t-bo";
    post.mockReset();
    post.mockResolvedValue({ stored: 1, duplicates: 0, unresolved: [] });
    renderPage();
    expect(await screen.findByRole("heading", { level: 2, name: "Larmen kunde inte hämtas" })).toBeInTheDocument();
    // Nothing of the last login was sent under this one's token, and nothing is waiting here.
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(post).not.toHaveBeenCalled();
    expect(screen.queryByText(/väntar på att skickas/)).not.toBeInTheDocument();
    expect(queuedOf("t-me")).toHaveLength(1);
  });

  it("removes the first version's un-keyed queue and list when it sees them, and sends nothing from them", async () => {
    localStorage.setItem(LEGACY_KEYS[0], JSON.stringify([markOf("m-old")]));
    localStorage.setItem(LEGACY_KEYS[1], snapshotFor());
    answerWith(new TypeError("Failed to fetch"));
    renderPage();
    expect(await screen.findByRole("heading", { level: 2, name: "Larmen kunde inte hämtas" })).toBeInTheDocument();
    expect(localStorage.getItem(LEGACY_KEYS[0])).toBeNull();
    expect(localStorage.getItem(LEGACY_KEYS[1])).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });
});

describe("/teacher/crisis when the gateway lost a write conflict", () => {
  const savedMark: MarkInput = { id: "m-1", callId: "c-7a", studentId: "s1", state: "MISSING", at: "2027-01-12T09:21:00.000Z" };

  it("keeps the mark on a 409 WRITE_CONFLICT, says nothing was lost, and sends it again with the same id", async () => {
    localStorage.setItem(QUEUE_KEY, JSON.stringify([savedMark]));
    post.mockRejectedValueOnce(new ApiError(409, "Konflikt, försök igen.", "WRITE_CONFLICT"));
    renderPage();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    await screen.findByRole("region", { name: "7A" });
    expect(queued().map((mark) => mark.id)).toEqual(["m-1"]);
    expect(screen.queryByText(/kunde inte sparas/)).not.toBeInTheDocument();
    expect(within(group("7A")).getByText("Väntar på att skickas")).toBeInTheDocument();
    // The next try (the page is looked at again) goes through, and it is the same mark.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1]![1].marks.map((mark: MarkInput) => mark.id)).toEqual(["m-1"]);
    await waitFor(() => expect(queued()).toEqual([]));
  });

  it("keeps a mark answered with a 404 or a 409 that says nothing about why", async () => {
    localStorage.setItem(QUEUE_KEY, JSON.stringify([savedMark]));
    post.mockRejectedValue(new ApiError(404, "Not found"));
    renderPage();
    await waitFor(() => expect(post).toHaveBeenCalled());
    await screen.findByRole("region", { name: "7A" });
    expect(queued()).toHaveLength(1);
    expect(screen.queryByText(/kunde inte sparas/)).not.toBeInTheDocument();
  });
});

describe("/teacher/crisis: a pupil found who is not on the list", () => {
  // 7A and 8B are the teacher's; the school's other pupils are who can be found. Olga is on no one's list but Dahl's.
  const others = [
    other("o1", "Nils", "Holm", "9C"),
    other("o2", "Olga", "Dahl", "9C"),
    other("o3", "Åke", "Persson", "6B"),
    other("o4", "Nils", "Holmgren", null),
  ];
  const withOthers = (calls = [sevenA(), nextLesson()], extra = {}) => mine([myAlarm(calls, { others, ...extra })], asOf);
  const findButton = () => screen.getByRole("button", { name: "Hittat en elev som inte står på listan" });
  /** The picker's results; the groups' own Finns buttons are on the page beside them. */
  const results = () => within(screen.getByRole("list", { name: "Träffar" }));
  const labels = () => results().getAllByRole("button").map((button) => button.getAttribute("aria-label"));

  it("offers it once per alarm, below the groups, to a teacher who has a group", async () => {
    answerWith(withOthers());
    renderPage();
    await screen.findByRole("region", { name: "7A" });
    expect(findButton()).toHaveAttribute("aria-expanded", "false");
    expect(screen.getAllByRole("button", { name: "Hittat en elev som inte står på listan" })).toHaveLength(1);
  });

  it("does not offer it to a teacher with no group of their own to attach the pupil to, nor when the alarm is over, nor with nobody to find", async () => {
    answerWith(withOthers([]));
    const first = renderPage();
    await screen.findByText("Du svarar inte för någon grupp i det här larmet.");
    expect(screen.queryByRole("button", { name: "Hittat en elev som inte står på listan" })).not.toBeInTheDocument();
    first.unmount();

    answerWith(withOthers([sevenA()], { endedAt: "2027-01-12T09:31:00.000Z", endedBy: "Rut Rektor" }));
    const second = renderPage();
    await screen.findByRole("region", { name: "7A" });
    expect(screen.queryByRole("button", { name: "Hittat en elev som inte står på listan" })).not.toBeInTheDocument();
    second.unmount();

    answerWith(withOthers([sevenA()], { others: [] }));
    renderPage();
    await screen.findByRole("region", { name: "7A" });
    expect(screen.queryByRole("button", { name: "Hittat en elev som inte står på listan" })).not.toBeInTheDocument();
  });

  it("searches the school's other pupils by name or class, with accents and case forgiven, and shows nobody until something is typed", async () => {
    answerWith(withOthers());
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("region", { name: "7A" });
    await user.click(findButton());
    expect(findButton()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Skriv ett namn eller en klass.")).toBeInTheDocument();
    const search = screen.getByRole("searchbox", { name: "Namn eller klass" });
    expect(search).toHaveFocus();
    expect(screen.queryByRole("list", { name: "Träffar" })).not.toBeInTheDocument();

    await user.type(search, "nils");
    expect(labels()).toEqual(["Finns: Nils Holm (9C)", "Finns: Nils Holmgren"]);
    await user.clear(search);
    await user.type(search, "9c");
    expect(labels()).toEqual(["Finns: Nils Holm (9C)", "Finns: Olga Dahl (9C)"]);
    await user.clear(search);
    await user.type(search, "ake pers");
    expect(labels()).toEqual(["Finns: Åke Persson (6B)"]);
    await user.clear(search);
    await user.type(search, "zzz");
    expect(screen.getByText("Ingen träff bland eleverna som inte står på dina listor.")).toBeInTheDocument();
  });

  it("never offers Saknas for a pupil who is not on the list, and does not list a pupil of the teacher's own groups", async () => {
    answerWith(mine([myAlarm([sevenA()], { others: [...others, ] })], asOf));
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("region", { name: "7A" });
    await user.click(findButton());
    await user.type(screen.getByRole("searchbox", { name: "Namn eller klass" }), "e");
    expect(labels().length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /^Saknas: (Nils|Olga|Åke)/ })).not.toBeInTheDocument();
    // Ines is on 7A's list (a pupil of the group, not an "other"), so she is not among the results.
    expect(labels().join()).not.toContain("Ines");
    expect(results().queryAllByRole("button", { name: /^Saknas/ })).toHaveLength(0);
  });

  it("queues a FOUND mark for the group with a mark of its own id, shows the pupil at once as waiting, and closes with focus back on the button", async () => {
    let answer!: (value: unknown) => void;
    post.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    answerWith(withOthers([sevenA()]));
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("region", { name: "7A" });
    await user.click(findButton());
    await user.type(screen.getByRole("searchbox", { name: "Namn eller klass" }), "olga");
    await user.click(screen.getByRole("button", { name: "Finns: Olga Dahl (9C)" }));

    // At once, from the device.
    const found = screen.getByRole("list", { name: "Hittade hos dig som inte står på listan" });
    expect(within(found).getByText("Olga Dahl")).toBeInTheDocument();
    expect(within(found).getByText("9C")).toBeInTheDocument();
    expect(within(found).getByText("Väntar på att skickas")).toBeInTheDocument();
    expect(within(found).getByText("Finns")).toBeInTheDocument();
    expect(screen.getByText("Olga Dahl är markerad som funnen hos dig.")).toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(findButton()).toHaveFocus();
    // A pupil of the group is not changed by it: not the pupil's list, not its counts.
    expect(within(group("7A")).getByRole("list", { name: "Eleverna i 7A" }).querySelectorAll("li")).toHaveLength(5);

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, body] = post.mock.calls[0]!;
    expect(path).toBe(MARKS);
    expect(body.marks).toHaveLength(1);
    expect(body.marks[0]).toMatchObject({ callId: "c-7a", studentId: "o2", state: "FOUND" });
    expect(body.marks[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(body.marks[0].at)).not.toBeNaN();
    expect(queued()).toHaveLength(1);

    // The gateway has it: its next list holds the pupil under the group, and nothing waits.
    answerWith(
      mine([myAlarm([myCall("c-7a", "7A", sevenA().pupils, { foundHere: [foundHere("o2", "Olga", "Dahl", "9C")] })], { others })], asOf),
    );
    await act(async () => answer({ stored: 1, duplicates: 0, unresolved: [] }));
    await waitFor(() => expect(screen.queryByText("Väntar på att skickas")).not.toBeInTheDocument());
    expect(queued()).toEqual([]);
    expect(within(screen.getByRole("list", { name: "Hittade hos dig som inte står på listan" })).getByText("Olga Dahl")).toBeInTheDocument();
  });

  it("holds the find as waiting when there is no signal, keeps it on the device, and sends it when the network is back", async () => {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ receivedAt: Date.now() - 60_000, data: withOthers([sevenA()]) }));
    answerWith(new TypeError("Failed to fetch"));
    post.mockRejectedValue(new TypeError("Failed to fetch"));
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("region", { name: "7A" });
    await user.click(findButton());
    await user.type(screen.getByRole("searchbox", { name: "Namn eller klass" }), "åke");
    await user.click(screen.getByRole("button", { name: "Finns: Åke Persson (6B)" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const found = screen.getByRole("list", { name: "Hittade hos dig som inte står på listan" });
    expect(within(found).getByText("Åke Persson")).toBeInTheDocument();
    expect(within(found).getByText("Väntar på att skickas")).toBeInTheDocument();
    expect(screen.getByText("1 markering väntar på att skickas.")).toBeInTheDocument();
    expect(queued()).toHaveLength(1);
    const id = queued()[0]!.id;

    post.mockReset();
    post.mockResolvedValue({ stored: 1, duplicates: 0, unresolved: [] });
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![1].marks[0]).toMatchObject({ id, callId: "c-7a", studentId: "o3", state: "FOUND" });
    await waitFor(() => expect(queued()).toEqual([]));
  });

  it("does not offer a pupil who is already found with the teacher", async () => {
    answerWith(withOthers([myCall("c-7a", "7A", sevenA().pupils, { foundHere: [foundHere("o1", "Nils", "Holm", "9C")] })]));
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("region", { name: "7A" });
    expect(within(screen.getByRole("list", { name: "Hittade hos dig som inte står på listan" })).getByText("Nils Holm")).toBeInTheDocument();
    await user.click(findButton());
    await user.type(screen.getByRole("searchbox", { name: "Namn eller klass" }), "nils");
    expect(labels()).toEqual(["Finns: Nils Holmgren"]);
  });

  it("lets a teacher with several groups say which one the pupil was found with, the lesson going on first", async () => {
    answerWith(withOthers([nextLesson(), sevenA()]));
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("region", { name: "7A" });
    await user.click(findButton());
    const which = screen.getByRole("combobox", { name: "Hittad tillsammans med" });
    // 8B is first in the list but the break's next lesson; 7A is the lesson going on.
    expect(which).toHaveValue("c-7a");
    await user.type(screen.getByRole("searchbox", { name: "Namn eller klass" }), "olga");
    await user.click(results().getByRole("button", { name: "Finns: Olga Dahl (9C)" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![1].marks[0]).toMatchObject({ callId: "c-7a", studentId: "o2" });
  });

  it("files the pupil under the group the teacher chose", async () => {
    post.mockReturnValue(new Promise(() => {}));
    answerWith(withOthers([nextLesson(), sevenA()]));
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("region", { name: "7A" });
    await user.click(findButton());
    await user.selectOptions(screen.getByRole("combobox", { name: "Hittad tillsammans med" }), "c-8b");
    await user.type(screen.getByRole("searchbox", { name: "Namn eller klass" }), "åke");
    await user.click(results().getByRole("button", { name: "Finns: Åke Persson (6B)" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![1].marks[0]).toMatchObject({ callId: "c-8b", studentId: "o3", state: "FOUND" });
    expect(within(group("8B")).getByText("Åke Persson")).toBeInTheDocument();
    expect(within(group("8B")).getByText("Väntar på att skickas")).toBeInTheDocument();
    expect(within(group("7A")).queryByText("Åke Persson")).not.toBeInTheDocument();
  });

  it("asks for no choice of group when there is only one", async () => {
    answerWith(withOthers([sevenA()]));
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("region", { name: "7A" });
    await user.click(findButton());
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("shows at most fifty results and says how many there are, so that a thousand names are not a thousand buttons", async () => {
    const many = Array.from({ length: 120 }, (_, index) => other(`p${index}`, `Elev${String(index).padStart(3, "0")}`, "Test", "5A"));
    answerWith(withOthers([sevenA()], { others: many }));
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("region", { name: "7A" });
    await user.click(findButton());
    await user.type(screen.getByRole("searchbox", { name: "Namn eller klass" }), "elev");
    expect(labels()).toHaveLength(50);
    expect(screen.getByText("Visar de 50 första av 120. Skriv mer för att begränsa.")).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "Namn eller klass" }), "01");
    expect(labels()).toHaveLength(10);
    expect(screen.queryByText(/Visar de 50 första/)).not.toBeInTheDocument();
  });

  it("works from the keyboard: arrows from the search into the results and between them, Enter on a result, Escape closes", async () => {
    answerWith(withOthers([sevenA()]));
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("region", { name: "7A" });
    await user.click(findButton());
    const search = screen.getByRole("searchbox", { name: "Namn eller klass" });
    await user.type(search, "nils");
    // Enter in the search marks nobody: it only moves to the first result.
    await user.keyboard("{Enter}");
    expect(results().getByRole("button", { name: "Finns: Nils Holm (9C)" })).toHaveFocus();
    expect(post).not.toHaveBeenCalled();
    await user.keyboard("{ArrowDown}");
    expect(results().getByRole("button", { name: "Finns: Nils Holmgren" })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(results().getByRole("button", { name: "Finns: Nils Holm (9C)" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(findButton()).toHaveFocus();
    expect(post).not.toHaveBeenCalled();

    await user.click(findButton());
    await user.type(screen.getByRole("searchbox", { name: "Namn eller klass" }), "holmgren");
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![1].marks[0]).toMatchObject({ studentId: "o4", state: "FOUND" });
  });

  it("lists the pupils the gateway says were found with the teacher under the group, with their class, also when the alarm is over", async () => {
    answerWith(
      mine(
        [
          myAlarm([myCall("c-7a", "7A", sevenA().pupils, { foundHere: [foundHere("o1", "Nils", "Holm", "9C"), foundHere("o4", "Nils", "Holmgren")] })], {
            others,
            endedAt: "2027-01-12T09:31:00.000Z",
            endedBy: "Rut Rektor",
          }),
        ],
        asOf,
      ),
    );
    renderPage();
    await screen.findByRole("region", { name: "7A" });
    const found = screen.getByRole("list", { name: "Hittade hos dig som inte står på listan" });
    expect(within(found).getAllByRole("listitem")).toHaveLength(2);
    expect(within(found).getByText("Nils Holm").closest("li")).toHaveTextContent("9C");
    expect(within(found).queryByText("Väntar på att skickas")).not.toBeInTheDocument();
    // No buttons to mark anyone on an alarm that is over.
    expect(within(found).queryByRole("button")).not.toBeInTheDocument();
  });

  it("says nothing about found pupils when none were, and reads a list from a gateway that does not send the fields as having none", async () => {
    const old = JSON.parse(JSON.stringify(withOthers([sevenA()])));
    delete old.alarms[0].others;
    delete old.alarms[0].calls[0].foundHere;
    answerWith(old);
    renderPage();
    await screen.findByRole("region", { name: "7A" });
    expect(screen.queryByText("Hittade hos dig som inte står på listan")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Hittat en elev som inte står på listan" })).not.toBeInTheDocument();
  });
});
