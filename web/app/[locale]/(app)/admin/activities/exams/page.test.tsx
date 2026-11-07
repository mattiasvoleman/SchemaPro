import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { ProfileProvider } from "@/components/profile-context";
import { ApiError, api } from "@/lib/api";
import type {
  ApplyResult,
  Exam,
  ExamProposal,
  ExamRoom,
  ExamSettings,
  InvigilatorCounterRow,
} from "@/lib/exam-types";
import type { Profile, Subject } from "@/lib/types";
import ExamsPage from "./page";

// Radix's Switch measures its thumb; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/**
 * /admin/activities/exams over the real hooks and the real Swedish messages, the gateway
 * answering by path. What only this page decides: the planner is off until the
 * school turns it on and then there is no button, only the reason; an exam is
 * entered with the window or the fixed time it wants and sent as the gateway
 * takes it; a laid exam offers "Ta bort planeringen" and nothing else; a
 * proposal lays nothing and is read before it is used; "Använd valda" sends
 * back exactly what the proposal gave for the ticked exams and names the exam
 * that failed; the reasons an exam was not laid are said in Swedish from the
 * engine's catalogue or the gateway's own; no name appears that the gateway
 * did not give; and a reader has no form and no buttons.
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } };
});
const get = api.get as unknown as Mock;
const post = api.post as unknown as Mock;
const put = api.put as unknown as Mock;
const patch = api.patch as unknown as Mock;
const del = api.delete as unknown as Mock;

const SUBJECTS: Subject[] = [
  { id: "s-prov", name: "Prov", countsTowardTimplan: false },
  { id: "s-mentor", name: "Mentorstid", countsTowardTimplan: false },
  { id: "s-ma", name: "Matematik", countsTowardTimplan: true },
  { id: "s-sv", name: "Svenska", countsTowardTimplan: true },
] as Subject[];
let subjects: Subject[] = SUBJECTS;
vi.mock("@/lib/queries", () => ({
  useAcademicYears: () => ({
    data: [{ id: "y26", name: "2026/27", startDate: "2026-08-17", endDate: "2027-06-11", isActive: true, predecessorId: null }],
  }),
  useGroups: () => ({
    data: [
      { id: "g-9a", academicYearId: "y26", name: "9A", kind: "CLASS", gradeLevel: 9, halfOfId: null },
      { id: "g-9b", academicYearId: "y26", name: "9B", kind: "CLASS", gradeLevel: 9, halfOfId: null },
      { id: "g-old", academicYearId: "y25", name: "8A", kind: "CLASS", gradeLevel: 8, halfOfId: null },
    ],
  }),
  useSubjects: () => ({ data: subjects }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const SETTINGS_OFF: ExamSettings = {
  enabled: false,
  maxPerClassPerDay: 1,
  maxPerClassPerWeek: 3,
  writersPerInvigilator: 30,
  turnoverMinutes: 10,
  replacementSubject: null,
};
const SETTINGS_ON: ExamSettings = { ...SETTINGS_OFF, enabled: true, replacementSubject: { id: "s-prov", name: "Prov" } };
const ROOMS: ExamRoom[] = [
  { roomId: "r-aula", name: "Aulan", code: null, capacity: 120, seats: null },
  { roomId: "r-12", name: "Sal 12", code: "S12", capacity: 28, seats: 24 },
  { roomId: "r-13", name: "Sal 13", code: null, capacity: null, seats: null },
];
const BASE: Exam = {
  id: "e-ma",
  academicYearId: "y26",
  subjectId: "s-ma",
  subjectName: "Matematik",
  name: "Matematik, algebra",
  lengthMinutes: 80,
  writers: 56,
  windowKind: "WEEK",
  windowFrom: "2026-11-09",
  windowTo: "2026-11-13",
  fixedStart: null,
  earliestStart: "08:30",
  latestEnd: "15:00",
  groups: [
    { id: "g-9a", name: "9A" },
    { id: "g-9b", name: "9B" },
  ],
  version: "2026-10-01T08:00:00.000Z",
  plan: null,
  lastReason: null,
};
const LAID: Exam = {
  ...BASE,
  plan: {
    activityId: "a-1",
    date: "2026-11-10",
    start: "08:30",
    end: "09:50",
    sittings: [
      { roomId: "r-12", roomName: "Sal 12", writers: 28, invigilators: [{ teacherId: "u-anna", name: "Anna Berg" }] },
      { roomId: "r-aula", roomName: "Aulan", writers: 28, invigilators: [] },
    ],
  },
};
const NO_SEATS: Exam = {
  ...BASE,
  id: "e-sv",
  subjectId: "s-sv",
  subjectName: "Svenska",
  name: "Svenska, uppsats",
  lengthMinutes: 120,
  writers: 27,
  windowKind: "FIXED",
  windowFrom: "2026-11-17",
  windowTo: "2026-11-17",
  fixedStart: "08:30",
  earliestStart: null,
  latestEnd: null,
  groups: [{ id: "g-9a", name: "9A" }],
  lastReason: { code: "EXAM_NO_ROOM_SEATS", params: { writers: 27, seats: 24 }, at: "2026-10-02T09:00:00.000Z" },
};
const CLOSED: Exam = {
  ...BASE,
  id: "e-en",
  subjectId: "s-ma",
  name: "Engelska, glosor",
  groups: [{ id: "g-9b", name: "9B" }],
  lastReason: { code: "EXAM_WINDOW_CLOSED", params: {}, at: "2026-10-02T09:00:00.000Z" },
};
const FRESH: Exam = { ...BASE, id: "e-fresh", name: "Historia, källkritik", groups: [{ id: "g-9a", name: "9A" }] };

const COUNTER: InvigilatorCounterRow[] = [
  { teacherId: "u-anna", name: "Anna Berg", passes: 2, minutes: 160 },
  { teacherId: "u-bo", name: "Bo Carlsson", passes: 0, minutes: 0 },
];

const proposed = (examId: string, name: string, date: string, start: string, end: string, loss: number): ExamProposal["placed"][number] => ({
  examId,
  name,
  version: `v-${examId}`,
  date,
  start,
  end,
  loss,
  rooms: [
    { roomId: "r-12", roomName: "Sal 12", writers: 24, classes: ["9A"], invigilators: [{ teacherId: "u-anna", name: "Anna Berg" }] },
    { roomId: "r-aula", roomName: "Aulan", writers: 3, classes: ["9A", "9B"], invigilators: [{ teacherId: "u-bo", name: "Bo Carlsson" }] },
  ],
});
const PROPOSAL: ExamProposal = {
  status: "OPTIMAL",
  placed: [
    proposed("e-sv", "Svenska, uppsats", "2026-11-17", "08:30", "10:30", 240),
    proposed("e-fresh", "Historia, källkritik", "2026-11-17", "13:00", "14:00", 0),
    proposed("e-en", "Engelska, glosor", "2026-11-19", "09:00", "09:40", 80),
  ],
  unplaced: [
    {
      examId: "e-x1",
      name: "Fysik, rörelse",
      reason: "EXAM_CLASS_DAY_CAP",
      params: { limit: 1, class: "9A" },
      message: "The class already has 1 exam a day, which is its limit, on every day the exam could be held.",
    },
    { examId: "e-x2", name: "Kemi, syror", reason: "EXAM_NO_LESSON_TO_REPLACE", params: {}, message: null },
    { examId: "e-x3", name: "Biologi, cellen", reason: "EXAM_FROM_THE_FUTURE", params: {}, message: "A rule the web has not heard of." },
  ],
  counter: [
    { teacherId: "u-anna", name: "Anna Berg", passes: 2, minutes: 160, addedPasses: 3, addedMinutes: 280 },
    { teacherId: "u-bo", name: "Bo Carlsson", passes: 0, minutes: 0, addedPasses: 3, addedMinutes: 280 },
  ],
  metrics: { placed: 3, unplaced: 3, loss: 320, roomsUsed: 2, invigilatorPasses: 6, maxLoad: 440, minLoad: 280, solveSeconds: 4 },
};

let settings: ExamSettings = SETTINGS_OFF;
let rooms: ExamRoom[] = ROOMS;
let exams: Exam[] = [LAID, NO_SEATS, CLOSED, FRESH];
let counter: InvigilatorCounterRow[] = COUNTER;

function renderPage(readOnly = false, locale: "sv" | "en" = "sv") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale={locale} messages={locale === "sv" ? sv : en} timeZone="Europe/Stockholm">
        <ProfileProvider profile={{} as Profile} school={null} readOnly={readOnly}>
          <ExamsPage />
        </ProfileProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

// The whole form is drawn again on every key; text is set in one change event.
vi.setConfig({ testTimeout: 30_000 });
const setValue = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const region = (name: string) => screen.getByRole("region", { name });

describe("/admin/activities/exams", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    subjects = SUBJECTS;
    settings = SETTINGS_OFF;
    rooms = ROOMS;
    exams = [LAID, NO_SEATS, CLOSED, FRESH];
    counter = COUNTER;
    get.mockImplementation(async (path: string) => {
      if (path === "/api/v1/exams/settings") return settings;
      if (path === "/api/v1/exams/rooms") return rooms;
      if (path === "/api/v1/exams?academicYearId=y26") return exams;
      if (path === "/api/v1/exams/counter?academicYearId=y26") return counter;
      throw new Error(`unexpected GET ${path}`);
    });
  });

  // ---- the page, the settings and the rooms --------------------------------

  it("draws the four parts in order, with the planner off as the school has it", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { level: 1, name: "Prov och skrivsalar" })).toBeInTheDocument();
    const headings = await screen.findAllByRole("heading", { level: 2 });
    expect(headings.map((heading) => heading.textContent)).toEqual(["Inställningar", "Skrivsalar", "Nytt prov", "Prov i 2026/27", "Planera"]);
    expect(screen.getByRole("link", { name: "Till Aktiviteter" })).toHaveAttribute("href", expect.stringContaining("/admin/activities"));
    // Every part of the form is Drift's.
    expect(region("Nytt prov")).toHaveAttribute("data-writes", "DRIFT");
  });

  it("explains that the planner is off, and offers no Planera while it is", async () => {
    renderPage();
    const planner = await screen.findByRole("region", { name: "Planera" });
    expect(await within(planner).findByText(/Provplaneringen är avstängd, så inget förslag kan tas fram/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Provplanering på" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Provplanering på" })).toHaveAccessibleDescription(/ändå lägga in prov och märka skrivsalar/);
    expect(screen.queryByRole("button", { name: /^Planera/ })).not.toBeInTheDocument();
    // Exams and rooms work all the same.
    expect(screen.getByRole("button", { name: "Lägg in provet" })).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it("saves the settings as numbers, and offers a replacement subject only among those that do not count", async () => {
    put.mockImplementation(async (_path: string, body: Record<string, unknown>) => ({
      ...body,
      replacementSubject: { id: "s-prov", name: "Prov" },
    }));
    renderPage();
    const card = await screen.findByRole("region", { name: "Inställningar" });
    const subject = await within(card).findByLabelText("Ämne för ersättningslektionerna");
    expect(within(subject).getAllByRole("option").map((option) => option.textContent)).toEqual(["Välj ämne", "Prov", "Mentorstid"]);
    expect(within(card).getByRole("button", { name: "Spara" })).toBeDisabled();

    fireEvent.click(within(card).getByRole("switch", { name: "Provplanering på" }));
    setValue("Högst så många prov per klass och dag", "2");
    setValue("Högst så många prov per klass och vecka", "4");
    setValue("Skrivande per vakt", "25");
    setValue("Omställning i minuter", "15");
    fireEvent.change(subject, { target: { value: "s-prov" } });
    fireEvent.click(within(card).getByRole("button", { name: "Spara" }));

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("/api/v1/exams/settings", {
        enabled: true,
        maxPerClassPerDay: 2,
        maxPerClassPerWeek: 4,
        writersPerInvigilator: 25,
        turnoverMinutes: 15,
        replacementSubjectId: "s-prov",
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Inställningarna är sparade"));
  });

  it("says what is wrong with the settings before anything is sent, and shows the gateway's refusal beside the form", async () => {
    put.mockRejectedValue(new ApiError(400, "replacementSubjectId: Matematik räknas mot timplanen.", "EXAM_REPLACEMENT_SUBJECT_COUNTS"));
    renderPage();
    const card = await screen.findByRole("region", { name: "Inställningar" });
    await within(card).findByLabelText("Skrivande per vakt");
    setValue("Högst så många prov per klass och dag", "4");
    setValue("Högst så många prov per klass och vecka", "3");
    expect(screen.getByLabelText("Högst så många prov per klass och vecka")).toHaveAccessibleDescription("En vecka rymmer minst lika många prov som en dag.");
    expect(within(card).getByRole("button", { name: "Spara" })).toBeDisabled();

    setValue("Högst så många prov per klass och dag", "1");
    fireEvent.click(within(card).getByRole("switch", { name: "Provplanering på" }));
    fireEvent.click(within(card).getByRole("button", { name: "Spara" }));
    expect(await within(card).findByText("replacementSubjectId: Matematik räknas mot timplanen.")).toBeInTheDocument();
  });

  it("says how to make a replacement subject when none can be one", async () => {
    subjects = SUBJECTS.filter((subject) => subject.countsTowardTimplan);
    renderPage();
    const card = await screen.findByRole("region", { name: "Inställningar" });
    expect(await within(card).findByText("Inget ämne kan vara ersättningslektionens")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "Till Ämnen" })).toHaveAttribute("href", expect.stringContaining("/admin/subjects"));
  });

  it("lists every room with its capacity as the suggestion, and marks one with the seats typed", async () => {
    put.mockResolvedValue(ROOMS.map((room) => (room.roomId === "r-aula" ? { ...room, seats: 100 } : room)));
    renderPage();
    const card = await screen.findByRole("region", { name: "Skrivsalar" });
    const aula = (await within(card).findByText("Aulan")).closest("tr")!;
    // The capacity is the suggestion; a room without one starts empty and cannot be marked.
    expect(within(aula).getByLabelText("Platser för prov i Aulan")).toHaveValue(120);
    expect(within(card).getByLabelText("Platser för prov i Sal 13")).toHaveValue(null);
    expect(within(card).getByRole("button", { name: "Markera Sal 13" })).toBeDisabled();
    // A marked room shows its seats, and Spara waits for a change.
    expect(within(card).getByLabelText("Platser för prov i Sal 12")).toHaveValue(24);
    expect(within(card).getByRole("button", { name: "Spara Sal 12" })).toBeDisabled();
    expect(within(card).getByRole("button", { name: "Markera Aulan" })).toHaveAttribute("data-writes", "DRIFT");

    setValue("Platser för prov i Aulan", "100");
    fireEvent.click(within(card).getByRole("button", { name: "Markera Aulan" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith("/api/v1/exams/rooms/r-aula", { seats: 100 }));
    // The answer is the whole list, and the row now reads as marked.
    expect(await within(card).findByRole("button", { name: "Ta bort Aulan" })).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith("Aulan är nu skrivsal.");
  });

  it("changes the seats of a marked room and takes the mark away", async () => {
    put.mockResolvedValue(ROOMS.map((room) => (room.roomId === "r-12" ? { ...room, seats: 20 } : room)));
    del.mockResolvedValue(ROOMS.map((room) => (room.roomId === "r-12" ? { ...room, seats: null } : room)));
    renderPage();
    const card = await screen.findByRole("region", { name: "Skrivsalar" });
    await within(card).findByText("Sal 12");
    setValue("Platser för prov i Sal 12", "20");
    fireEvent.click(within(card).getByRole("button", { name: "Spara Sal 12" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith("/api/v1/exams/rooms/r-12", { seats: 20 }));
    expect(toast.success).toHaveBeenCalledWith("Platserna i Sal 12 är sparade.");

    fireEvent.click(await within(card).findByRole("button", { name: "Ta bort Sal 12" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/api/v1/exams/rooms/r-12"));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Sal 12 är inte längre skrivsal."));
    await waitFor(() => expect(within(card).queryByRole("button", { name: "Ta bort Sal 12" })).not.toBeInTheDocument());
  });

  // ---- the exams ------------------------------------------------------------

  it("lists the exams with where each stands and why one is not laid, in Swedish, without any name the gateway did not give", async () => {
    renderPage();
    const card = await screen.findByRole("region", { name: "Prov i 2026/27" });
    const laid = (await within(card).findByText("Matematik, algebra")).closest("tr")!;
    expect(laid).toHaveTextContent("Matematik");
    expect(laid).toHaveTextContent("9A, 9B");
    expect(laid).toHaveTextContent("9–13 nov. 2026");
    expect(laid).toHaveTextContent("tidigast 08:30, slut senast 15:00");
    expect(laid).toHaveTextContent("80 min");
    expect(laid).toHaveTextContent("56 skrivande");
    expect(laid).toHaveTextContent("Lagt");
    expect(laid).toHaveTextContent("tis 10 nov. 2026 kl. 08:30–09:50");
    // The room with its invigilator; the room the gateway named nobody for says so, and invents nobody.
    expect(laid).toHaveTextContent("Sal 12: 28 skrivande. Vakter: Anna Berg.");
    expect(laid).toHaveTextContent("Aulan: 28 skrivande.");
    expect(laid).not.toHaveTextContent("Bo Carlsson");

    // A laid exam offers one thing: to take its plan away.
    expect(within(laid).getByRole("button", { name: "Ta bort planeringen Matematik, algebra" })).toBeInTheDocument();
    expect(within(laid).queryByRole("button", { name: /^Ändra/ })).not.toBeInTheDocument();
    expect(within(laid).queryByRole("button", { name: /^Ta bort Matematik/ })).not.toBeInTheDocument();

    const fixed = screen.getByText("Svenska, uppsats").closest("tr")!;
    expect(fixed).toHaveTextContent("tis 17 nov. 2026");
    expect(fixed).toHaveTextContent("kl. 08:30");
    expect(fixed).toHaveTextContent("Ej lagt");
    // The engine's sentence, in Swedish, with the figures it was written from.
    expect(fixed).toHaveTextContent(/27 elever skriver provet, men skrivsalarna som är lediga för det rymmer högst 24/);
    expect(within(fixed).getByRole("button", { name: "Ändra Svenska, uppsats" })).toBeInTheDocument();
    expect(within(fixed).getByRole("button", { name: "Ta bort Svenska, uppsats" })).toBeInTheDocument();

    // The gateway's own reason.
    expect(screen.getByText("Engelska, glosor").closest("tr")).toHaveTextContent("Alla dagar i fönstret är lediga eller har redan passerat.");
    // An exam the planner has not been asked about yet.
    expect(screen.getByText("Historia, källkritik").closest("tr")).toHaveTextContent("Inte planerat ännu.");
  });

  it("says the reasons in English too, and the gateway's own sentence for a code the web does not know", async () => {
    exams = [
      { ...NO_SEATS, lastReason: { code: "EXAM_NO_ROOM_SEATS", params: { writers: 1, seats: 24 }, at: "" } },
      { ...CLOSED, lastReason: { code: "EXAM_OUTSIDE_HOURS", params: {}, at: "" } },
      { ...FRESH, lastReason: { code: "EXAM_FROM_THE_FUTURE", params: {}, at: "" } },
    ];
    renderPage(false, "en");
    const card = await screen.findByRole("region", { name: "Exams in 2026/27" });
    expect(await within(card).findByText(/1 pupil writes the exam, but the exam rooms that are free for it seat at most 24/)).toBeInTheDocument();
    expect(within(card).getByText("The exam does not fit within the day's times or limits.")).toBeInTheDocument();
    expect(within(card).getByText("The exam could not be laid.")).toBeInTheDocument();
  });

  it("shows an empty year as empty, and a failed list as failed", async () => {
    exams = [];
    const { unmount } = renderPage();
    expect(await screen.findByText("Inga prov för läsåret ännu.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Planera" })).not.toHaveTextContent("Planera de olagda proven");
    unmount();

    get.mockImplementation(async (path: string) => {
      if (path === "/api/v1/exams/settings") return settings;
      if (path === "/api/v1/exams/rooms") return rooms;
      throw new ApiError(500, "Boom");
    });
    renderPage();
    expect(await screen.findByText("Proven kunde inte hämtas")).toBeInTheDocument();
  });

  it("enters a window exam as the gateway takes it, and clears the form", async () => {
    post.mockResolvedValue({ ...BASE, id: "e-new" });
    renderPage();
    const card = await screen.findByRole("region", { name: "Nytt prov" });
    await within(card).findByLabelText("Namn");
    // Nothing is said before something is put in; the button waits.
    expect(within(card).getByRole("button", { name: "Lägg in provet" })).toBeDisabled();
    expect(within(card).queryByText("Välj provets ämne.")).not.toBeInTheDocument();

    // A subject that does not count is not offered.
    const subject = within(card).getByLabelText("Ämne");
    expect(within(subject).getAllByRole("option").map((option) => option.textContent)).toEqual(["Välj ämne", "Matematik", "Svenska"]);
    // Only the year's own classes.
    expect(within(card).queryByRole("checkbox", { name: "8A" })).not.toBeInTheDocument();

    setValue("Namn", "  Matematik, geometri ");
    fireEvent.change(subject, { target: { value: "s-ma" } });
    setValue("Längd i minuter", "60");
    setValue("Antal skrivande", "52");
    fireEvent.click(within(card).getByRole("checkbox", { name: "9A" }));
    fireEvent.click(within(card).getByRole("checkbox", { name: "9B" }));
    setValue("Första dag", "2026-11-23");
    setValue("Sista dag", "2026-11-27");
    setValue("Tidigaste start (valfritt)", "09:00");
    fireEvent.click(within(card).getByRole("button", { name: "Lägg in provet" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/exams", {
        academicYearId: "y26",
        subjectId: "s-ma",
        name: "Matematik, geometri",
        lengthMinutes: 60,
        writers: 52,
        windowKind: "WEEK",
        windowFrom: "2026-11-23",
        windowTo: "2026-11-27",
        earliestStart: "09:00",
        groupIds: ["g-9a", "g-9b"],
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Provet är inlagt."));
    expect(within(card).getByLabelText("Namn")).toHaveValue("");
    // The list is read again.
    await waitFor(() => expect(get.mock.calls.filter(([path]) => path === "/api/v1/exams?academicYearId=y26").length).toBeGreaterThan(1));
  });

  it("enters a fixed exam as one day with a start and no daily limits", async () => {
    post.mockResolvedValue({ ...NO_SEATS, id: "e-new" });
    renderPage();
    const card = await screen.findByRole("region", { name: "Nytt prov" });
    await within(card).findByLabelText("Namn");
    setValue("Namn", "Nationellt prov, svenska");
    fireEvent.change(within(card).getByLabelText("Ämne"), { target: { value: "s-sv" } });
    setValue("Längd i minuter", "120");
    setValue("Antal skrivande", "27");
    fireEvent.click(within(card).getByRole("checkbox", { name: "9A" }));
    fireEvent.change(within(card).getByLabelText("Tid"), { target: { value: "FIXED" } });
    expect(within(card).queryByLabelText("Sista dag")).not.toBeInTheDocument();
    setValue("Datum", "2026-11-17");
    setValue("Starttid", "08:30");
    fireEvent.click(within(card).getByRole("button", { name: "Lägg in provet" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/exams", {
        academicYearId: "y26",
        subjectId: "s-sv",
        name: "Nationellt prov, svenska",
        lengthMinutes: 120,
        writers: 27,
        windowKind: "FIXED",
        windowFrom: "2026-11-17",
        windowTo: "2026-11-17",
        fixedStart: "08:30",
        groupIds: ["g-9a"],
      }),
    );
  });

  it("names what is wrong in the form, and shows the gateway's refusal without clearing the form", async () => {
    post.mockRejectedValue(new ApiError(400, "windowFrom: fönstret ligger inom läsåret.", "EXAM_WINDOW"));
    renderPage();
    const card = await screen.findByRole("region", { name: "Nytt prov" });
    await within(card).findByLabelText("Namn");
    setValue("Namn", "Prov");
    setValue("Första dag", "2026-11-23");
    setValue("Sista dag", "2026-11-20");
    expect(within(card).getByLabelText("Sista dag")).toHaveAccessibleDescription("Sista dagen ligger före den första.");
    expect(within(card).getByText("Välj provets ämne.")).toBeInTheDocument();
    expect(within(card).getByText("Välj minst en klass eller grupp.")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Lägg in provet" })).toBeDisabled();

    fireEvent.change(within(card).getByLabelText("Ämne"), { target: { value: "s-ma" } });
    setValue("Längd i minuter", "60");
    setValue("Antal skrivande", "20");
    fireEvent.click(within(card).getByRole("checkbox", { name: "9A" }));
    setValue("Sista dag", "2026-11-27");
    fireEvent.click(within(card).getByRole("button", { name: "Lägg in provet" }));
    expect(await within(card).findByText("windowFrom: fönstret ligger inom läsåret.")).toBeInTheDocument();
    expect(within(card).getByLabelText("Namn")).toHaveValue("Prov");
  });

  it("opens a change on the exam and sends the whole description again", async () => {
    patch.mockResolvedValue({ ...NO_SEATS, writers: 24 });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Ändra Svenska, uppsats" }));
    const dialog = await screen.findByRole("dialog", { name: "Ändra Svenska, uppsats" });
    expect(within(dialog).getByLabelText("Namn")).toHaveValue("Svenska, uppsats");
    expect(within(dialog).getByLabelText("Tid")).toHaveValue("FIXED");
    expect(within(dialog).getByLabelText("Datum")).toHaveValue("2026-11-17");
    expect(within(dialog).getByLabelText("Starttid")).toHaveValue("08:30");
    expect(within(dialog).getByRole("checkbox", { name: "9A" })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "9B" })).not.toBeChecked();

    fireEvent.change(within(dialog).getByLabelText("Antal skrivande"), { target: { value: "24" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Spara" }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/api/v1/exams/e-sv", {
        subjectId: "s-sv",
        name: "Svenska, uppsats",
        lengthMinutes: 120,
        writers: 24,
        windowKind: "FIXED",
        windowFrom: "2026-11-17",
        windowTo: "2026-11-17",
        fixedStart: "08:30",
        groupIds: ["g-9a"],
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Provet är ändrat."));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("removes an exam after asking, and says why when the gateway refuses", async () => {
    del.mockRejectedValueOnce(new ApiError(409, "Provet är lagt: ta bort planeringen först, ta sedan bort provet.", "EXAM_IS_PLANNED"));
    del.mockResolvedValueOnce({ removed: true });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Ta bort Historia, källkritik" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Ta bort Historia, källkritik?");
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Ta bort" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/api/v1/exams/e-fresh"));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Provet är lagt: ta bort planeringen först, ta sedan bort provet."),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Ta bort Historia, källkritik" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Ta bort" }));
    await waitFor(() => expect(del).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Historia, källkritik är borttaget."));
  });

  it("takes the plan of a laid exam away only after asking", async () => {
    post.mockResolvedValue({ removed: true });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Ta bort planeringen Matematik, algebra" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Ta bort planeringen av Matematik, algebra?");
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Ta bort planeringen" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/exams/e-ma/unplan"));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Planeringen av Matematik, algebra är borttagen."));
  });

  // ---- the planner ------------------------------------------------------------

  describe("with the planner on", () => {
    beforeEach(() => {
      settings = SETTINGS_ON;
    });

    it("asks for the exams that are not laid, waits visibly while it works, and lays nothing", async () => {
      let answer!: (proposal: ExamProposal) => void;
      post.mockImplementation(
        (path: string) =>
          new Promise((resolve) => {
            if (path === "/api/v1/exams/plan") answer = resolve;
            else resolve(undefined);
          }),
      );
      renderPage();
      const planner = await screen.findByRole("region", { name: "Planera" });
      fireEvent.click(await within(planner).findByRole("button", { name: "Planera de olagda proven" }));
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      expect(post).toHaveBeenCalledWith("/api/v1/exams/plan", { academicYearId: "y26" });
      // It takes up to a minute: the button says so and cannot be pressed again, and the region is busy.
      expect(planner).toHaveAttribute("aria-busy", "true");
      expect(within(planner).getByRole("button", { name: "Planerar…" })).toBeDisabled();
      expect(within(planner).getByText("Det kan ta upp till en minut. Lämna inte sidan.")).toBeInTheDocument();

      answer(PROPOSAL);
      expect(await within(planner).findByText("3 av 6 prov kan läggas.")).toBeInTheDocument();
      expect(planner).not.toHaveAttribute("aria-busy");
      expect(post).toHaveBeenCalledTimes(1);
    });

    it("plans only the ticked exams when some are ticked", async () => {
      post.mockResolvedValue({ status: "NOTHING_TO_PLAN", placed: [], unplaced: [], counter: [], metrics: null });
      renderPage();
      const list = await screen.findByRole("region", { name: "Prov i 2026/27" });
      // A laid exam has no box.
      expect(within(list).queryByRole("checkbox", { name: "Planera Matematik, algebra" })).not.toBeInTheDocument();
      fireEvent.click(await within(list).findByRole("checkbox", { name: "Planera Svenska, uppsats" }));
      fireEvent.click(within(list).getByRole("checkbox", { name: "Planera Historia, källkritik" }));
      const planner = screen.getByRole("region", { name: "Planera" });
      fireEvent.click(within(planner).getByRole("button", { name: "Planera de 2 markerade proven" }));
      await waitFor(() =>
        expect(post).toHaveBeenCalledWith("/api/v1/exams/plan", { academicYearId: "y26", examIds: ["e-sv", "e-fresh"] }),
      );
      expect(await within(planner).findByText("Det fanns inga prov att planera.")).toBeInTheDocument();
    });

    it("reads the proposal: a table a day with time, rooms, classes, writers, invigilators and what it disturbs, the ones left out with their reasons, and the counter", async () => {
      post.mockResolvedValue(PROPOSAL);
      renderPage();
      const planner = await screen.findByRole("region", { name: "Planera" });
      fireEvent.click(await within(planner).findByRole("button", { name: "Planera de olagda proven" }));
      await within(planner).findByText("3 av 6 prov kan läggas.");

      expect(within(planner).getByRole("heading", { level: 3, name: "tis 17 nov. 2026" })).toBeInTheDocument();
      const first = within(planner).getByRole("table", { name: "Prov som kan läggas tis 17 nov. 2026" });
      expect(within(first).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
        "Använd",
        "Prov",
        "Tid",
        "Salar och vakter",
        "Påverkan",
      ]);
      const uppsats = within(first).getByText("Svenska, uppsats").closest("tr")!;
      expect(uppsats).toHaveTextContent("08:30–10:30");
      expect(uppsats).toHaveTextContent("Sal 12 (9A): 24 skrivande");
      expect(uppsats).toHaveTextContent("Vakter: Anna Berg.");
      expect(uppsats).toHaveTextContent("Aulan (9A, 9B): 3 skrivande");
      expect(uppsats).toHaveTextContent("Vakter: Bo Carlsson.");
      expect(uppsats).toHaveTextContent("Stör 240 min undervisning");
      expect(within(first).getByText("Historia, källkritik").closest("tr")).toHaveTextContent("Stör ingen undervisning");
      // All are ticked to begin with.
      expect(within(planner).getAllByRole("checkbox", { name: /^Använd förslaget för / })).toHaveLength(3);
      for (const box of within(planner).getAllByRole("checkbox", { name: /^Använd förslaget för / })) expect(box).toBeChecked();
      expect(within(planner).getByRole("heading", { level: 3, name: "tors 19 nov. 2026" })).toBeInTheDocument();

      // Left out, each with its reason in Swedish: the engine's, the gateway's, and the engine's own English for a code not known here.
      const left = within(planner).getByRole("heading", { level: 3, name: "Kunde inte läggas" }).parentElement!;
      expect(left).toHaveTextContent("Fysik, rörelse: Klassen har redan nått sin gräns på 1 prov per dag, på varje dag provet skulle kunna hållas.");
      expect(left).toHaveTextContent("Kemi, syror: Klassen har ingen lektion att ersätta inom fönstret.");
      expect(left).toHaveTextContent("Biologi, cellen: A rule the web has not heard of.");
      // The class's name is in the params, and is said after the sentence.
      expect(left).toHaveTextContent("Fysik, rörelse: Klassen har redan nått sin gräns på 1 prov per dag, på varje dag provet skulle kunna hållas. Gäller 9A.");

      // The counter: before, what the proposal adds, and after.
      const counterTable = within(planner).getByRole("table", { name: "Vakträknare" });
      expect(within(counterTable).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Lärare", "Före", "Nytt", "Efter"]);
      const anna = within(counterTable).getByText("Anna Berg").closest("tr")!;
      expect(anna).toHaveTextContent("2 pass, 160 min");
      expect(anna).toHaveTextContent("+3 pass, +280 min");
      expect(anna).toHaveTextContent("5 pass, 440 min");
      expect(within(counterTable).getByText("Bo Carlsson").closest("tr")).toHaveTextContent("3 pass, 280 min");
      // Nothing is laid by a proposal.
      expect(post).toHaveBeenCalledTimes(1);
    });

    it("says what the search could not settle when the proposal is not proven the best", async () => {
      post.mockResolvedValue({ ...PROPOSAL, status: "FEASIBLE" });
      renderPage();
      const planner = await screen.findByRole("region", { name: "Planera" });
      fireEvent.click(await within(planner).findByRole("button", { name: "Planera de olagda proven" }));
      expect(await within(planner).findByText(/Sökningen hann inte avgöra om förslaget är det bästa/)).toBeInTheDocument();
    });

    it("uses the ticked exams, sends exactly what the proposal gave, and names the exam that failed", async () => {
      const result: ApplyResult = {
        applied: 1,
        failed: 1,
        outcomes: [
          { examId: "e-sv", ok: true, activityId: "a-9" },
          { examId: "e-fresh", ok: false, code: "EXAM_STALE", message: "Provet har ändrats sedan förslaget gjordes: planera om." },
        ],
      };
      post.mockImplementation(async (path: string) => (path === "/api/v1/exams/plan" ? PROPOSAL : result));
      renderPage();
      const planner = await screen.findByRole("region", { name: "Planera" });
      fireEvent.click(await within(planner).findByRole("button", { name: "Planera de olagda proven" }));
      await within(planner).findByText("3 av 6 prov kan läggas.");

      // The third is left out; families are told unless the box is cleared.
      fireEvent.click(within(planner).getByRole("checkbox", { name: "Använd förslaget för Engelska, glosor" }));
      expect(within(planner).getByRole("checkbox", { name: /Meddela elever, vårdnadshavare och lärare/ })).toBeChecked();
      fireEvent.click(within(planner).getByRole("button", { name: "Använd valda (2)" }));

      await waitFor(() =>
        expect(post).toHaveBeenCalledWith("/api/v1/exams/plan/apply", {
          academicYearId: "y26",
          notify: true,
          items: [
            {
              examId: "e-sv",
              examVersion: "v-e-sv",
              date: "2026-11-17",
              start: "08:30",
              rooms: [
                { roomId: "r-12", writers: 24, teacherIds: ["u-anna"] },
                { roomId: "r-aula", writers: 3, teacherIds: ["u-bo"] },
              ],
            },
            {
              examId: "e-fresh",
              examVersion: "v-e-fresh",
              date: "2026-11-17",
              start: "13:00",
              rooms: [
                { roomId: "r-12", writers: 24, teacherIds: ["u-anna"] },
                { roomId: "r-aula", writers: 3, teacherIds: ["u-bo"] },
              ],
            },
          ],
        }),
      );
      const outcome = (await within(planner).findByRole("heading", { level: 3, name: "Resultat" })).parentElement!;
      expect(outcome).toHaveTextContent("Svenska, uppsats: Lagt.");
      expect(outcome).toHaveTextContent("Historia, källkritik: Provet har ändrats sedan förslaget gjordes: planera om. Planera om.");
      expect(toast.error).toHaveBeenCalledWith("Lagda prov: 1. Kunde inte läggas: 1.");
      // The one that was laid cannot be used twice; the one that failed can be tried again.
      expect(within(planner).queryByRole("checkbox", { name: "Använd förslaget för Svenska, uppsats" })).not.toBeInTheDocument();
      expect(within(planner).getByText("Svenska, uppsats", { selector: "td" }).closest("tr")).toHaveTextContent("Lagt");
    });

    it("can leave the families untold, and ticks all or none", async () => {
      post.mockImplementation(async (path: string) =>
        path === "/api/v1/exams/plan" ? PROPOSAL : { applied: 3, failed: 0, outcomes: PROPOSAL.placed.map((exam) => ({ examId: exam.examId, ok: true })) },
      );
      renderPage();
      const planner = await screen.findByRole("region", { name: "Planera" });
      fireEvent.click(await within(planner).findByRole("button", { name: "Planera de olagda proven" }));
      await within(planner).findByText("3 av 6 prov kan läggas.");
      fireEvent.click(within(planner).getByRole("button", { name: "Välj inga" }));
      expect(within(planner).getByRole("button", { name: "Använd valda (0)" })).toBeDisabled();
      fireEvent.click(within(planner).getByRole("button", { name: "Välj alla" }));
      fireEvent.click(within(planner).getByRole("checkbox", { name: /Meddela elever, vårdnadshavare och lärare/ }));
      fireEvent.click(within(planner).getByRole("button", { name: "Använd valda (3)" }));
      await waitFor(() =>
        expect(post).toHaveBeenCalledWith("/api/v1/exams/plan/apply", expect.objectContaining({ notify: false })),
      );
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Lagda prov: 3. Kunde inte läggas: 0."));
    });

    it("shows the gateway's refusal of a plan, and leaves the form alone", async () => {
      post.mockRejectedValue(new ApiError(400, "Ingen sal är markerad som skrivsal: markera de salar som får användas.", "EXAM_NO_ROOMS"));
      renderPage();
      const planner = await screen.findByRole("region", { name: "Planera" });
      fireEvent.click(await within(planner).findByRole("button", { name: "Planera de olagda proven" }));
      expect(await within(planner).findByText("Ingen sal är markerad som skrivsal: markera de salar som får användas.")).toBeInTheDocument();
      expect(within(planner).getByRole("button", { name: "Planera de olagda proven" })).toBeEnabled();
    });

    it("says the engine's refusal of a whole run in Swedish, with its figures, and not the English the engine sent", async () => {
      post.mockRejectedValue(
        new ApiError(400, "There are too many possible combinations of exam, room and invigilator.", "EXAM_MODEL_TOO_LARGE", {
          variables: 90000,
          limit: 60000,
        }),
      );
      renderPage();
      const planner = await screen.findByRole("region", { name: "Planera" });
      fireEvent.click(await within(planner).findByRole("button", { name: "Planera de olagda proven" }));
      expect(await within(planner).findByText(/Det blir för många möjliga kombinationer av prov, sal och vakt/)).toBeInTheDocument();
      expect(planner).not.toHaveTextContent("There are too many");
      expect(planner).toHaveTextContent(/omkring 90000 mot en gräns på 60000/);
    });

    it("shows the gateway's sentence when another exam is being laid at the moment, for the run as a whole and for one exam", async () => {
      post.mockImplementation(async (path: string) => {
        if (path === "/api/v1/exams/plan") return PROPOSAL;
        throw new ApiError(409, "Ett annat prov läggs just nu: försök igen.", "EXAM_BUSY");
      });
      renderPage();
      const planner = await screen.findByRole("region", { name: "Planera" });
      fireEvent.click(await within(planner).findByRole("button", { name: "Planera de olagda proven" }));
      await within(planner).findByText("3 av 6 prov kan läggas.");
      fireEvent.click(within(planner).getByRole("button", { name: "Använd valda (3)" }));
      expect(await within(planner).findByText("Ett annat prov läggs just nu: försök igen.")).toBeInTheDocument();
      // Nothing was laid, so the proposal can be used again.
      expect(within(planner).getByRole("button", { name: "Använd valda (3)" })).toBeEnabled();
    });

    it("says in words when the throttle answers", async () => {
      post.mockRejectedValue(new ApiError(429, "ThrottlerException: Too Many Requests"));
      renderPage();
      const planner = await screen.findByRole("region", { name: "Planera" });
      fireEvent.click(await within(planner).findByRole("button", { name: "Planera de olagda proven" }));
      expect(await within(planner).findByText("För många förfrågningar på kort tid. Vänta en stund och försök igen.")).toBeInTheDocument();
    });

    it("shows who has kept watch so far when no proposal is open, nobody the gateway left out", async () => {
      renderPage();
      const planner = await screen.findByRole("region", { name: "Planera" });
      const table = await within(planner).findByRole("table", { name: "Vaktpass i 2026/27" });
      expect(within(table).getByText("Anna Berg").closest("tr")).toHaveTextContent("2 pass, 160 min");
      // Someone with no pass is not listed.
      expect(within(table).queryByText("Bo Carlsson")).not.toBeInTheDocument();
    });

    it("says so when nobody has kept watch yet, and when every exam is laid", async () => {
      counter = COUNTER.map((row) => ({ ...row, passes: 0, minutes: 0 }));
      exams = [LAID];
      renderPage();
      const planner = await screen.findByRole("region", { name: "Planera" });
      expect(await within(planner).findByText("Alla prov för läsåret är lagda.")).toBeInTheDocument();
      expect(await within(planner).findByText("Ingen har haft vakt vid något prov i år ännu.")).toBeInTheDocument();
      expect(within(planner).queryByRole("button", { name: /^Planera/ })).not.toBeInTheDocument();
    });

    it("asks for a replacement subject and for an exam room before there is any button", async () => {
      settings = { ...SETTINGS_ON, replacementSubject: null };
      const { unmount } = renderPage();
      expect(await screen.findByText("Välj ersättningsämne först")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Planera/ })).not.toBeInTheDocument();
      unmount();

      settings = SETTINGS_ON;
      rooms = ROOMS.map((room) => ({ ...room, seats: null }));
      renderPage();
      expect(await screen.findByText("Markera en skrivsal först")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Planera/ })).not.toBeInTheDocument();
    });
  });

  // ---- the reader -----------------------------------------------------------------

  it("gives a reader everything to read and nothing to change it with", async () => {
    settings = SETTINGS_ON;
    renderPage(true);
    const list = await screen.findByRole("region", { name: "Prov i 2026/27" });
    expect(await within(list).findByText("Matematik, algebra")).toBeInTheDocument();
    expect(list).toHaveTextContent("Anna Berg");
    expect(screen.queryByRole("region", { name: "Nytt prov" })).not.toBeInTheDocument();
    expect(within(list).queryByRole("button")).not.toBeInTheDocument();
    expect(within(list).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(within(list).queryByRole("columnheader", { name: "Åtgärder" })).not.toBeInTheDocument();
    // The settings are read, not edited; the rooms show their seats and have no buttons.
    const card = region("Inställningar");
    await within(card).findByLabelText("Skrivande per vakt");
    expect(within(card).queryByRole("button", { name: "Spara" })).not.toBeInTheDocument();
    expect(within(card).getByLabelText("Skrivande per vakt")).toBeDisabled();
    expect(within(card).getByRole("switch", { name: "Provplanering på" })).toBeDisabled();
    const rooms = region("Skrivsalar");
    await within(rooms).findByText("Sal 12");
    expect(within(rooms).queryByRole("button")).not.toBeInTheDocument();
    expect(within(rooms).getByText("Skrivsal, 24 platser")).toBeInTheDocument();
    // And no Planera.
    const planner = region("Planera");
    await within(planner).findByRole("table", { name: "Vaktpass i 2026/27" });
    expect(within(planner).queryByRole("button")).not.toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});
