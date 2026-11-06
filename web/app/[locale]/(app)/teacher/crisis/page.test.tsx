import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { ApiError, api } from "@/lib/api";
import { LEGACY_KEYS, queueKey, snapshotKey } from "@/lib/crisis-queue";
import type { MarkInput, OtherPupilView, QueuedMark } from "@/lib/crisis-types";
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

/**
 * The school's pupils as the gateway's search sees them (POST /crisis/mine/pupils, what was typed in the body
 * and never in a URL): the ones on none of the teacher's lists, a name or a class of at least two characters, at
 * most 25. `slow` holds an answer back. Its own function beside the marks' `post`, so that a search is not
 * counted among the marks sent.
 */
const school = vi.hoisted(() => {
  const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const state = {
    pupils: [] as OtherPupilView[],
    /** What was typed, in the order it was asked. */
    asked: [] as string[],
    /** Every search as it was sent: the path and the body. */
    requests: [] as { path: string; body: unknown }[],
    fail: false,
    slow: undefined as undefined | ((q: string) => Promise<void> | undefined),
    async search(path: string, body: unknown): Promise<OtherPupilView[]> {
      const { q } = body as { alarmId: string; q: string };
      state.requests.push({ path, body });
      state.asked.push(q);
      await state.slow?.(q);
      if (state.fail) throw new TypeError("Failed to fetch");
      const words = fold(q).split(/\s+/).filter(Boolean);
      return state.pupils
        .filter((one) => words.every((word) => fold(`${one.firstName} ${one.lastName} ${one.className ?? ""}`).includes(word)))
        .slice(0, 25);
    },
  };
  return state;
});
const SEARCH = "/api/v1/crisis/mine/pupils";
const marksPost = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      get: vi.fn(),
      post: (path: string, body?: unknown, signal?: AbortSignal) => (path === SEARCH ? school.search(path, body) : marksPost(path, body, signal)),
    },
  };
});
const get = api.get as unknown as Mock;
const post = marksPost as unknown as Mock;
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
/** The page's counters: the live region that says Finns, Saknas and the rest (the picker has a status of its own). */
const counters = () => screen.getAllByRole("status").find((one) => one.getAttribute("aria-live") === "polite" && /Finns/.test(one.textContent ?? ""))!;
const sentMarks = (): MarkInput[] => post.mock.calls.flatMap(([, body]) => (body as { marks: MarkInput[] }).marks);
const queuedOf = (id: string): QueuedMark[] => JSON.parse(localStorage.getItem(queueKey(id)) ?? "[]");
const queued = (): QueuedMark[] => queuedOf(who.id);
const QUEUE_KEY = queueKey("t-me");
const SNAPSHOT_KEY = snapshotKey("t-me");

beforeEach(() => {
  vi.resetAllMocks();
  who.id = "t-me";
  school.pupils = [];
  school.asked = [];
  school.requests = [];
  school.fail = false;
  school.slow = undefined;
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
    const live = counters();
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
    expect(await screen.findByText("Markeringen gick inte att ta emot: eleven står inte på gruppens lista", { exact: false })).toBeInTheDocument();
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
  // The school's other pupils, as the search sees them: not in the list the teacher is given, and held nowhere.
  const others = [
    other("o1", "Nils", "Holm", "9C"),
    other("o2", "Olga", "Dahl", "9C"),
    other("o3", "Åke", "Persson", "6B"),
    other("o4", "Nils", "Holmgren", null),
  ];
  const withFree = (calls = [sevenA(), nextLesson()], extra = {}) => mine([myAlarm(calls, extra)], asOf);
  const findButton = () => screen.getByRole("button", { name: "Hittat en elev som inte står på listan" });
  const searchbox = () => screen.getByRole("searchbox", { name: "Namn eller klass" });
  /** The picker's results; the groups' own Finns buttons are on the page beside them. */
  const results = () => within(screen.getByRole("list", { name: "Träffar" }));
  const labels = () => results().getAllByRole("button").map((button) => button.getAttribute("aria-label"));
  const open = async (user: ReturnType<typeof userEvent.setup>) => {
    await screen.findByRole("heading", { level: 2, name: "Utrymning" });
    await user.click(findButton());
  };
  /** Types into the search and waits for the answer to it. */
  const search = async (user: ReturnType<typeof userEvent.setup>, text: string) => {
    await user.clear(searchbox());
    await user.type(searchbox(), text);
    await screen.findByRole("list", { name: "Träffar" }, { timeout: 2000 });
  };

  beforeEach(() => {
    school.pupils = others;
  });

  it("offers it once per alarm that is going, below the groups, to a teacher who has a group", async () => {
    answerWith(withFree());
    renderPage();
    await screen.findByRole("region", { name: "7A" });
    expect(findButton()).toHaveAttribute("aria-expanded", "false");
    expect(screen.getAllByRole("button", { name: "Hittat en elev som inte står på listan" })).toHaveLength(1);
  });

  it("offers it to a teacher with no group right now as well, and not when the alarm is over", async () => {
    answerWith(withFree([]));
    const first = renderPage();
    await screen.findByText("Du svarar inte för någon grupp i det här larmet.");
    expect(findButton()).toBeInTheDocument();
    first.unmount();

    answerWith(withFree([sevenA()], { endedAt: "2027-01-12T09:31:00.000Z", endedBy: "Rut Rektor" }));
    renderPage();
    await screen.findByRole("region", { name: "7A" });
    expect(screen.queryByRole("button", { name: "Hittat en elev som inte står på listan" })).not.toBeInTheDocument();
  });

  describe("the search", () => {
    it("is on the gateway: nothing is asked for under two characters, and the page holds no roster of the school", async () => {
      answerWith(withFree());
      const user = userEvent.setup();
      renderPage();
      await open(user);
      expect(screen.getByText("Skriv minst två tecken av ett namn eller en klass.")).toBeInTheDocument();
      expect(searchbox()).toHaveFocus();
      await user.type(searchbox(), "o");
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(school.asked).toEqual([]);
      expect(screen.queryByRole("list", { name: "Träffar" })).not.toBeInTheDocument();
      // The list the teacher is given names nobody but their own pupils, and nothing else was read.
      expect(get.mock.calls.map(([path]) => path).filter((path) => path !== "/api/v1/crisis/mine")).toEqual([]);
      expect(school.requests).toEqual([]);
    });

    it("asks after a pause in the typing, once, for the alarm and what was typed, and shows what the gateway answers", async () => {
      answerWith(withFree());
      const user = userEvent.setup();
      renderPage();
      await open(user);
      await user.type(searchbox(), "nils");
      await screen.findByRole("list", { name: "Träffar" }, { timeout: 2000 });
      // Four keys, one question.
      expect(school.asked).toEqual(["nils"]);
      // A POST to a path with nothing in it: what was typed is in the body, and in no URL.
      expect(school.requests).toEqual([{ path: SEARCH, body: { alarmId: "a-1", q: "nils" } }]);
      expect(labels()).toEqual(["Finns: Nils Holm (9C)", "Finns: Nils Holmgren"]);
    });

    it("has accents and case forgiven by the gateway, and a class found as well as a name", async () => {
      answerWith(withFree());
      const user = userEvent.setup();
      renderPage();
      await open(user);
      await search(user, "9c");
      expect(labels()).toEqual(["Finns: Nils Holm (9C)", "Finns: Olga Dahl (9C)"]);
      await search(user, "ake pers");
      expect(labels()).toEqual(["Finns: Åke Persson (6B)"]);
    });

    it("sends what was typed in the body, whatever it holds, and never in a URL", async () => {
      answerWith(withFree());
      const user = userEvent.setup();
      renderPage();
      await open(user);
      await user.type(searchbox(), "a&b c");
      await waitFor(() => expect(school.asked).toEqual(["a&b c"]));
      expect(school.requests).toEqual([{ path: SEARCH, body: { alarmId: "a-1", q: "a&b c" } }]);
      // No request of the page carries a name in its URL.
      for (const [path] of [...get.mock.calls, ...post.mock.calls]) expect(String(path)).not.toMatch(/[?&]q=|nils|a&b/);
      expect(school.requests.every((one) => !one.path.includes("?"))).toBe(true);
    });

    it("says it is searching, and says that nobody matches", async () => {
      answerWith(withFree());
      const user = userEvent.setup();
      renderPage();
      await open(user);
      await user.type(searchbox(), "zzz");
      expect(screen.getByText("Söker…")).toBeInTheDocument();
      expect(await screen.findByText("Ingen träff bland eleverna som inte står på dina listor.", {}, { timeout: 2000 })).toBeInTheDocument();
    });

    it("does not let a slow answer to an earlier word overwrite the answer to the word in the box", async () => {
      answerWith(withFree());
      let release!: () => void;
      school.slow = (q) => (q === "ni" ? new Promise<void>((resolve) => (release = resolve)) : undefined);
      const user = userEvent.setup();
      renderPage();
      await open(user);
      await user.type(searchbox(), "ni");
      await waitFor(() => expect(school.asked).toEqual(["ni"]));
      await user.type(searchbox(), "ls");
      await screen.findByRole("list", { name: "Träffar" }, { timeout: 2000 });
      expect(labels()).toEqual(["Finns: Nils Holm (9C)", "Finns: Nils Holmgren"]);
      // Now the answer to "ni" comes, with other pupils in it: it is not the box's word any more.
      school.pupils = [other("o9", "Nina", "Berg", "5A")];
      release();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(labels()).toEqual(["Finns: Nils Holm (9C)", "Finns: Nils Holmgren"]);
      expect(screen.queryByRole("button", { name: /Nina/ })).not.toBeInTheDocument();
    });

    it("says that it needs a network, when there is none, and asks again on request", async () => {
      answerWith(withFree());
      school.fail = true;
      const user = userEvent.setup();
      renderPage();
      await open(user);
      await user.type(searchbox(), "olga");
      expect(await screen.findByText("Sökningen kräver nät. Försök igen när du har kontakt.", {}, { timeout: 2000 })).toBeInTheDocument();
      school.fail = false;
      const picker = screen.getByRole("alert");
      await user.click(within(picker).getByRole("button", { name: "Försök igen" }));
      expect(await screen.findByRole("list", { name: "Träffar" })).toBeInTheDocument();
      expect(labels()).toEqual(["Finns: Olga Dahl (9C)"]);
    });

    it("keeps no result on the device: the names of the pupils searched for are in no storage until one is picked", async () => {
      answerWith(withFree());
      const user = userEvent.setup();
      renderPage();
      await open(user);
      await search(user, "nils");
      const stored = JSON.stringify(Object.fromEntries(Object.entries(localStorage)));
      for (const name of ["Holm", "Holmgren", "Olga", "Persson"]) expect(stored).not.toContain(name);
    });

    it("shows at most what the gateway answers, and says there may be more behind it when it is the most it answers", async () => {
      school.pupils = Array.from({ length: 40 }, (_, index) => other(`p${index}`, `Elev${String(index).padStart(3, "0")}`, "Test", "5A"));
      answerWith(withFree());
      const user = userEvent.setup();
      renderPage();
      await open(user);
      await search(user, "elev");
      expect(labels()).toHaveLength(25);
      expect(screen.getByText("Visar de 25 första. Skriv mer för att begränsa.")).toBeInTheDocument();
      await search(user, "elev01");
      expect(labels()).toHaveLength(10);
      expect(screen.queryByText(/Visar de 25 första/)).not.toBeInTheDocument();
    });

    it("never offers Saknas for a pupil who is not on the list, and does not offer one already found with the teacher", async () => {
      answerWith(
        withFree([myCall("c-7a", "7A", sevenA().pupils, { foundHere: [foundHere("o1", "Nils", "Holm", "9C")] })], { foundFree: [foundHere("o4", "Nils", "Holmgren")] }),
      );
      const user = userEvent.setup();
      renderPage();
      await open(user);
      // Both Nilses are found already: the gateway names them (it does not know) and the page leaves them out.
      await user.type(searchbox(), "nils");
      expect(await screen.findByText("Ingen träff bland eleverna som inte står på dina listor.", {}, { timeout: 2000 })).toBeInTheDocument();
      await search(user, "9c");
      expect(labels()).toEqual(["Finns: Olga Dahl (9C)"]);
      expect(results().queryAllByRole("button", { name: /^Saknas/ })).toHaveLength(0);
      expect(screen.queryByRole("button", { name: /^Saknas: (Nils|Olga|Åke)/ })).not.toBeInTheDocument();
    });

    it("works from the keyboard: arrows from the search into the results and between them, Enter on a result, Escape closes", async () => {
      answerWith(withFree([sevenA()]));
      const user = userEvent.setup();
      renderPage();
      await open(user);
      await search(user, "nils");
      // Enter in the search marks nobody: it only moves to the first result.
      await user.type(searchbox(), "{Enter}");
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
      await search(user, "holmgren");
      await user.keyboard("{ArrowDown}{Enter}");
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      expect(post.mock.calls[0]![1].marks[0]).toMatchObject({ studentId: "o4", state: "FOUND" });
    });
  });

  describe("picking a pupil", () => {
    it("queues a FOUND mark for the group, carrying the pupil's name and class in the queue and not in what is sent, and draws the row at once as waiting", async () => {
      let answer!: (value: unknown) => void;
      post.mockReturnValue(new Promise((resolve) => (answer = resolve)));
      answerWith(withFree([sevenA()]));
      const user = userEvent.setup();
      renderPage();
      await open(user);
      await search(user, "olga");
      await user.click(results().getByRole("button", { name: "Finns: Olga Dahl (9C)" }));

      // At once, from the device, with no roster to look the name up in.
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
      expect(body.marks[0]).not.toHaveProperty("alarmId");
      // What the gateway is sent is the gateway's own shape, and nothing more.
      expect(Object.keys(body.marks[0]).sort()).toEqual(["at", "callId", "id", "state", "studentId"]);
      // What the device keeps while it waits has the name.
      expect(queued()).toHaveLength(1);
      expect(queued()[0]!.pupil).toEqual({ firstName: "Olga", lastName: "Dahl", className: "9C" });

      // The gateway has it: its next list holds the pupil under the group, and nothing waits.
      answerWith(mine([myAlarm([myCall("c-7a", "7A", sevenA().pupils, { foundHere: [foundHere("o2", "Olga", "Dahl", "9C")] })])], asOf));
      await act(async () => answer({ stored: 1, duplicates: 0, unresolved: [] }));
      await waitFor(() => expect(screen.queryByText("Väntar på att skickas")).not.toBeInTheDocument());
      expect(queued()).toEqual([]);
      // The name is gone from the queue with the mark; the gateway's list is what holds the pupil now.
      expect(localStorage.getItem(QUEUE_KEY)).toBeNull();
      expect(within(screen.getByRole("list", { name: "Hittade hos dig som inte står på listan" })).getByText("Olga Dahl")).toBeInTheDocument();
    });

    it("holds the find as waiting when there is no signal, keeps it on the device, and sends it when the network is back", async () => {
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ receivedAt: Date.now() - 60_000, data: withFree([sevenA()]) }));
      answerWith(new TypeError("Failed to fetch"));
      post.mockRejectedValue(new TypeError("Failed to fetch"));
      const user = userEvent.setup();
      renderPage();
      await screen.findByRole("region", { name: "7A" });
      // The search needs a network; the mark does not. A pupil found before the signal went can be marked from the answer already on the screen.
      answerWith(withFree([sevenA()]));
      await user.click(findButton());
      await search(user, "åke");
      await user.click(results().getByRole("button", { name: "Finns: Åke Persson (6B)" }));
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
      expect(post.mock.calls[0]![1].marks[0]).not.toHaveProperty("pupil");
      await waitFor(() => expect(queued()).toEqual([]));
    });

    it("keeps the row of a find that waits across a reload, from the name in the queue, with no roster and no search", async () => {
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ receivedAt: Date.now() - 60_000, data: withFree([sevenA()]) }));
      localStorage.setItem(
        QUEUE_KEY,
        JSON.stringify([{ id: "m-1", callId: "c-7a", studentId: "o2", state: "FOUND", at: "2027-01-12T09:21:00.000Z", pupil: { firstName: "Olga", lastName: "Dahl", className: "9C" } }]),
      );
      answerWith(new TypeError("Failed to fetch"));
      post.mockRejectedValue(new TypeError("Failed to fetch"));
      renderPage();
      const found = await screen.findByRole("list", { name: "Hittade hos dig som inte står på listan" });
      expect(within(found).getByText("Olga Dahl")).toBeInTheDocument();
      expect(within(found).getByText("Väntar på att skickas")).toBeInTheDocument();
      expect(school.asked).toEqual([]);
    });

    it("lets a teacher with several groups say which one the pupil was found with, the lesson going on first, and files the pupil under it", async () => {
      post.mockReturnValue(new Promise(() => {}));
      answerWith(withFree([nextLesson(), sevenA()]));
      const user = userEvent.setup();
      renderPage();
      await open(user);
      const which = screen.getByRole("combobox", { name: "Hittad tillsammans med" });
      // 8B is first in the list but the break's next lesson; 7A is the lesson going on.
      expect(which).toHaveValue("c-7a");
      await user.selectOptions(which, "c-8b");
      await search(user, "åke");
      await user.click(results().getByRole("button", { name: "Finns: Åke Persson (6B)" }));
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      expect(post.mock.calls[0]![1].marks[0]).toMatchObject({ callId: "c-8b", studentId: "o3", state: "FOUND" });
      expect(within(group("8B")).getByText("Åke Persson")).toBeInTheDocument();
      expect(within(group("8B")).getByText("Väntar på att skickas")).toBeInTheDocument();
      expect(within(group("7A")).queryByText("Åke Persson")).not.toBeInTheDocument();
    });

    it("asks for no choice of group when there is only one, nor when there is none", async () => {
      answerWith(withFree([sevenA()]));
      const user = userEvent.setup();
      const first = renderPage();
      await open(user);
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
      first.unmount();
      answerWith(withFree([]));
      renderPage();
      await open(user);
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    });
  });

  describe("a teacher with no group right now", () => {
    it("sends the find by the alarm, with alarmId in place of callId, and lists the pupil under the alarm as found by them, waiting", async () => {
      let answer!: (value: unknown) => void;
      post.mockReturnValue(new Promise((resolve) => (answer = resolve)));
      answerWith(withFree([]));
      const user = userEvent.setup();
      renderPage();
      await open(user);
      await search(user, "olga");
      await user.click(results().getByRole("button", { name: "Finns: Olga Dahl (9C)" }));

      const free = screen.getByRole("list", { name: "Hittade av dig" });
      expect(within(free).getByText("Olga Dahl")).toBeInTheDocument();
      expect(within(free).getByText("Väntar på att skickas")).toBeInTheDocument();
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      const body = post.mock.calls[0]![1];
      expect(body.marks).toHaveLength(1);
      expect(body.marks[0]).toMatchObject({ alarmId: "a-1", studentId: "o2", state: "FOUND" });
      expect(body.marks[0]).not.toHaveProperty("callId");
      expect(body.marks[0]).not.toHaveProperty("lessonId");
      expect(Object.keys(body.marks[0]).sort()).toEqual(["alarmId", "at", "id", "state", "studentId"]);

      answerWith(withFree([], { foundFree: [foundHere("o2", "Olga", "Dahl", "9C")] }));
      await act(async () => answer({ stored: 1, duplicates: 0, unresolved: [] }));
      await waitFor(() => expect(screen.queryByText("Väntar på att skickas")).not.toBeInTheDocument());
      expect(within(screen.getByRole("list", { name: "Hittade av dig" })).getByText("Olga Dahl")).toBeInTheDocument();
    });

    it("lists the pupils the gateway says this teacher found with no group, with a teacher's group beside them being theirs", async () => {
      answerWith(withFree([sevenA()], { foundFree: [foundHere("o4", "Nils", "Holmgren", "6B")] }));
      renderPage();
      await screen.findByRole("region", { name: "7A" });
      const free = screen.getByRole("list", { name: "Hittade av dig" });
      expect(within(free).getByText("Nils Holmgren").closest("li")).toHaveTextContent("6B");
    });
  });

  describe("taking a find back (Ta tillbaka)", () => {
    const heldBy = () => withFree([myCall("c-7a", "7A", sevenA().pupils, { foundHere: [foundHere("o1", "Nils", "Holm", "9C")] })], { foundFree: [foundHere("o4", "Nils", "Holmgren")] });

    it("is offered on each pupil found, while the alarm is going, and queues a RETRACTED mark for the group or the alarm it was made on, taking the row away at once", async () => {
      let answer!: (value: unknown) => void;
      post.mockReturnValue(new Promise((resolve) => (answer = resolve)));
      answerWith(heldBy());
      const user = userEvent.setup();
      renderPage();
      await screen.findByRole("region", { name: "7A" });
      expect(screen.getByRole("button", { name: "Ta tillbaka: Nils Holm" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Ta tillbaka: Nils Holmgren" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Ta tillbaka: Nils Holm" }));
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      const mark = post.mock.calls[0]![1].marks[0];
      expect(mark).toMatchObject({ callId: "c-7a", studentId: "o1", state: "RETRACTED" });
      expect(mark.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(Date.parse(mark.at)).not.toBeNaN();
      expect(Object.keys(mark).sort()).toEqual(["at", "callId", "id", "state", "studentId"]);
      // Gone from the list at once; the next read is the truth.
      expect(screen.queryByText("Nils Holm", { exact: true })).not.toBeInTheDocument();
      expect(screen.getByText("Nils Holmgren")).toBeInTheDocument();

      answerWith(withFree([sevenA()], { foundFree: [foundHere("o4", "Nils", "Holmgren")] }));
      await act(async () => answer({ stored: 1, duplicates: 0, unresolved: [] }));
      await waitFor(() => expect(queued()).toEqual([]));
      expect(screen.queryByText("Nils Holm", { exact: true })).not.toBeInTheDocument();
    });

    it("takes back a find made with no group by the alarm", async () => {
      answerWith(heldBy());
      const user = userEvent.setup();
      renderPage();
      await screen.findByRole("region", { name: "7A" });
      await user.click(screen.getByRole("button", { name: "Ta tillbaka: Nils Holmgren" }));
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      expect(post.mock.calls[0]![1].marks[0]).toMatchObject({ alarmId: "a-1", studentId: "o4", state: "RETRACTED" });
      expect(post.mock.calls[0]![1].marks[0]).not.toHaveProperty("callId");
    });

    it("is not offered once the alarm is over", async () => {
      answerWith(mine([myAlarm([myCall("c-7a", "7A", sevenA().pupils, { foundHere: [foundHere("o1", "Nils", "Holm", "9C")] })], { endedAt: "2027-01-12T09:31:00.000Z", endedBy: "Rut Rektor", foundFree: [foundHere("o4", "Nils", "Holmgren")] })], asOf));
      renderPage();
      await screen.findByRole("region", { name: "7A" });
      expect(screen.getByText("Nils Holm")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Ta tillbaka/ })).not.toBeInTheDocument();
    });

    it("sends nothing for a find that has not left the device: both marks are dropped from the queue", async () => {
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ receivedAt: Date.now() - 60_000, data: withFree([sevenA()]) }));
      answerWith(new TypeError("Failed to fetch"));
      post.mockRejectedValue(new TypeError("Failed to fetch"));
      localStorage.setItem(
        QUEUE_KEY,
        JSON.stringify([{ id: "m-1", callId: "c-7a", studentId: "o2", state: "FOUND", at: "2027-01-12T09:21:00.000Z", pupil: { firstName: "Olga", lastName: "Dahl", className: "9C" } }]),
      );
      const user = userEvent.setup();
      renderPage();
      // The mark is on the device and sending fails (no network): it waits.
      const found = await screen.findByRole("list", { name: "Hittade hos dig som inte står på listan" });
      await waitFor(() => expect(post).toHaveBeenCalled());
      post.mockClear();
      expect(within(found).getByText("Väntar på att skickas")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Ta tillbaka: Olga Dahl" }));
      expect(screen.queryByRole("list", { name: "Hittade hos dig som inte står på listan" })).not.toBeInTheDocument();
      expect(queued()).toEqual([]);
      expect(screen.queryByText(/väntar på att skickas/)).not.toBeInTheDocument();
      // Back online: there is nothing to send, neither the find nor its retraction.
      post.mockResolvedValue({ stored: 1, duplicates: 0, unresolved: [] });
      await act(async () => {
        window.dispatchEvent(new Event("online"));
      });
      expect(post).not.toHaveBeenCalled();
    });

    it("sends the retraction after a find that is on its way, and does not drop the find that may already be stored", async () => {
      let answer!: (value: unknown) => void;
      post.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
      post.mockResolvedValue({ stored: 1, duplicates: 0, unresolved: [] });
      school.pupils = others;
      answerWith(withFree([sevenA()]));
      const user = userEvent.setup();
      renderPage();
      await open(user);
      await search(user, "olga");
      await user.click(results().getByRole("button", { name: "Finns: Olga Dahl (9C)" }));
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      // The find is in the air.
      await user.click(screen.getByRole("button", { name: "Ta tillbaka: Olga Dahl" }));
      expect(queued().map((mark) => mark.state)).toEqual(["FOUND", "RETRACTED"]);
      await act(async () => answer({ stored: 1, duplicates: 0, unresolved: [] }));
      await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
      expect(post.mock.calls[1]![1].marks.map((mark: MarkInput) => [mark.state, mark.studentId])).toEqual([["RETRACTED", "o2"]]);
      await waitFor(() => expect(queued()).toEqual([]));
    });

    it("drops a retraction the gateway refuses (nothing of the teacher's to take back) and says so in words", async () => {
      answerWith(heldBy());
      post.mockRejectedValue(new ApiError(400, "Inget att ta tillbaka.", "CRISIS_MARK_INVALID"));
      const user = userEvent.setup();
      renderPage();
      await screen.findByRole("region", { name: "7A" });
      await user.click(screen.getByRole("button", { name: "Ta tillbaka: Nils Holm" }));
      expect(await screen.findByText("En markering kunde inte sparas")).toBeInTheDocument();
      expect(screen.getByText(/eller så fanns inget du hittat att ta tillbaka/)).toBeInTheDocument();
      expect(queued()).toEqual([]);
    });
  });

  it("never offers the administration's Inte i huset to a teacher, and shows a pupil the administration marked so in its own word", async () => {
    answerWith(mine([myAlarm([myCall("c-7a", "7A", [pupil("s1", "Ines", "Ek", "AWAY"), pupil("s2", "Jamal", "Ali"), pupil("s3", "Klara", "Nyman", "FOUND")])], { foundFree: [] })], asOf));
    renderPage();
    await screen.findByRole("region", { name: "7A" });
    expect(screen.queryByRole("button", { name: /^Inte i huset/ })).not.toBeInTheDocument();
    const row = screen.getByText("Ines Ek").closest("li") as HTMLElement;
    expect(row).toHaveTextContent("Inte i huset");
    expect(within(row).getByRole("button", { name: "Finns: Ines Ek" })).toHaveAttribute("aria-pressed", "false");
    expect(within(row).getByRole("button", { name: "Saknas: Ines Ek" })).toHaveAttribute("aria-pressed", "false");
    // Counted for itself, apart from the others.
    const live = counters();
    expect(live).toHaveTextContent("1 Finns");
    expect(live).toHaveTextContent("1 Inte i huset");
    expect(live).toHaveTextContent("1 Inte rapporterade");
  });

  it("lists the pupils the gateway says were found with the teacher under the group, with their class, also when the alarm is over", async () => {
    answerWith(
      mine([myAlarm([myCall("c-7a", "7A", sevenA().pupils, { foundHere: [foundHere("o1", "Nils", "Holm", "9C"), foundHere("o4", "Nils", "Holmgren")] })], { endedAt: "2027-01-12T09:31:00.000Z", endedBy: "Rut Rektor" })], asOf),
    );
    renderPage();
    await screen.findByRole("region", { name: "7A" });
    const found = screen.getByRole("list", { name: "Hittade hos dig som inte står på listan" });
    expect(within(found).getAllByRole("listitem")).toHaveLength(2);
    expect(within(found).getByText("Nils Holm").closest("li")).toHaveTextContent("9C");
    expect(within(found).queryByText("Väntar på att skickas")).not.toBeInTheDocument();
    expect(within(found).queryByRole("button")).not.toBeInTheDocument();
  });

  it("reads a list from a gateway that does not send the fields as having none, and offers the button all the same", async () => {
    const old = JSON.parse(JSON.stringify(withFree([sevenA()])));
    delete old.alarms[0].foundFree;
    delete old.alarms[0].calls[0].foundHere;
    answerWith(old);
    renderPage();
    await screen.findByRole("region", { name: "7A" });
    expect(screen.queryByText("Hittade hos dig som inte står på listan")).not.toBeInTheDocument();
    expect(screen.queryByText("Hittade av dig")).not.toBeInTheDocument();
    expect(findButton()).toBeInTheDocument();
  });

  it("keeps no roster of the school in the list it keeps on the device, though the gateway sent one", async () => {
    const withRoster = JSON.parse(JSON.stringify(withFree([sevenA()])));
    withRoster.alarms[0].others = [{ studentId: "z", firstName: "Zeb", lastName: "Wall", className: "9C" }];
    answerWith(withRoster);
    renderPage();
    await screen.findByRole("region", { name: "7A" });
    await waitFor(() => expect(localStorage.getItem(SNAPSHOT_KEY)).not.toBeNull());
    expect(localStorage.getItem(SNAPSHOT_KEY)).not.toContain("Zeb");
    expect(localStorage.getItem(SNAPSHOT_KEY)).toContain("7A");
  });
});
