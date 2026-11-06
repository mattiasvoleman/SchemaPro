import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { ApiError, api } from "@/lib/api";
import { QUEUE_KEY, SNAPSHOT_KEY } from "@/lib/crisis-queue";
import type { MarkInput } from "@/lib/crisis-types";
import { mine, myAlarm, myCall, pupil } from "@/lib/__fixtures__/crisis";
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
vi.mock("@/components/profile-context", () => ({
  useProfile: () => ({ profile: { id: "t-me", role: "TEACHER" }, school: { timezone: "Europe/Stockholm" } }),
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
const queued = (): MarkInput[] => JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]");

beforeEach(() => {
  vi.resetAllMocks();
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
