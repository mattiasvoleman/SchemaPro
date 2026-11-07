import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { LessonMoves, MoveCandidates } from "@/lib/lesson-moves";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { LessonMovesSection } from "./lesson-moves-section";
import { MovePupilDialog } from "./move-pupil-dialog";

// Environment shims for Radix in jsdom — not behaviour under test.
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};
Element.prototype.hasPointerCapture ??= () => false;

/**
 * Elevens lektion för dagen in the browser: the dialog that moves one pupil of
 * a lesson to a parallel lesson, and the list of the pupils a lesson lost and
 * gained, through the gateway's routes and the real messages (a key missing
 * from sv.json or en.json throws here instead of printing its path).
 *
 * What this guards: every lesson the pupil cannot go to is listed with its
 * reason and cannot be chosen; a full room is a warning on the lesson and the
 * move goes through; the POST names the pupil, the lesson they leave and the
 * lesson they go to; a refusal is said in words; Ångra is a DELETE; and the
 * list shows the pupil as moved, with where to and from.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const LESSON = "11111111-1111-4111-8111-111111111111";
const PUPIL = "55555555-5555-4555-8555-555555555555";
const ENGLISH = "22222222-2222-4222-8222-222222222222";
const SWEDISH = "33333333-3333-4333-8333-333333333333";
const GYM = "44444444-4444-4444-8444-444444444444";
const BUSY = "66666666-6666-4666-8666-666666666666";

const FROM = { id: LESSON, subject: "Matematik", className: "7A", start: "09:00", end: "10:00", room: "B204" };
const candidates = (): MoveCandidates => ({
  from: FROM,
  candidates: [
    { id: ENGLISH, subject: "Engelska", className: "7B", start: "09:00", end: "10:00", room: "A1", headcount: 12, roomCapacity: 30, refusal: null, warnings: [] },
    {
      id: SWEDISH,
      subject: "Svenska",
      className: "7C",
      start: "09:30",
      end: "10:30",
      room: "A2",
      headcount: 3,
      roomCapacity: 3,
      refusal: null,
      warnings: [{ code: "TARGET_ROOM_OVER_CAPACITY", headcount: 4, capacity: 3 }],
    },
    { id: GYM, subject: "Idrott", className: "7D", start: "09:00", end: "10:00", room: null, headcount: 20, roomCapacity: null, refusal: { code: "LESSON_MOVE_REPLACED_BY_ACTIVITY", side: "TO" }, warnings: [] },
    { id: BUSY, subject: "Bild", className: "7E", start: "09:45", end: "10:45", room: null, headcount: 8, roomCapacity: null, refusal: { code: "LESSON_MOVE_PUPIL_DOUBLE_BOOKED" }, warnings: [] },
  ],
});

function renderIn(ui: React.ReactElement, locale: "sv" | "en" = "sv") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider
        locale={locale}
        messages={locale === "sv" ? sv : en}
        timeZone="Europe/Stockholm"
        onError={(error) => {
          throw error;
        }}
      >
        {ui}
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockImplementation(async (path: string) => {
    if (path.includes("/candidates")) return candidates();
    if (path.endsWith("/pupils")) return { students: [] };
    throw new Error(`unexpected GET ${path}`);
  });
});

describe("the dialog that moves a pupil", () => {
  it("lists the lessons that overlap, the ones that cannot take the pupil with their reason and unchosen", async () => {
    renderIn(<MovePupilDialog lessonId={LESSON} studentId={PUPIL} open onOpenChange={() => {}} />);

    expect(await screen.findByText("Engelska · 7B")).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(`/api/v1/lesson-moves/lessons/${LESSON}/candidates?studentId=${PUPIL}`);
    // A lesson an activity has replaced, and one that would double-book the pupil: named, and not selectable.
    expect(screen.getByText("Är ersatt av en schemabrytande aktivitet")).toBeInTheDocument();
    expect(screen.getByText("Eleven har en annan lektion samtidigt")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Idrott · 7D" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Bild · 7E" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Engelska · 7B" })).toBeEnabled();
    // The way the pupil gets there is one that is chosen: Flytta waits for it.
    expect(screen.getByRole("button", { name: "Flytta" })).toBeDisabled();
  });

  it("moves the pupil to the chosen lesson, says so, and warns about a room that would be over its capacity", async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValue({ moved: true, moveId: "m-1", warnings: [{ code: "TARGET_ROOM_OVER_CAPACITY", headcount: 4, capacity: 3 }] });
    const closed = vi.fn();
    renderIn(<MovePupilDialog lessonId={LESSON} studentId={PUPIL} open onOpenChange={closed} />);

    await user.click(await screen.findByRole("radio", { name: "Svenska · 7C" }));
    // The warning is on the lesson before the choice is made.
    expect(screen.getByText("Salen rymmer 3 men får 4")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Flytta" }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/v1/lesson-moves", { studentId: PUPIL, fromLessonId: LESSON, toLessonId: SWEDISH }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Eleven är flyttad."));
    expect(toast.warning).toHaveBeenCalledWith("Salen rymmer 3 men får 4");
    expect(closed).toHaveBeenCalledWith(false);
  });

  it("says a refusal in words, from the code, and stays open", async () => {
    const user = userEvent.setup();
    api.post.mockRejectedValue(new ApiError(409, "x", "LESSON_MOVE_PUPIL_DOUBLE_BOOKED"));
    const closed = vi.fn();
    renderIn(<MovePupilDialog lessonId={LESSON} studentId={PUPIL} open onOpenChange={closed} />);

    await user.click(await screen.findByRole("radio", { name: "Engelska · 7B" }));
    await user.click(screen.getByRole("button", { name: "Flytta" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Eleven skulle få två lektioner samtidigt."));
    expect(closed).not.toHaveBeenCalled();
  });

  it("names the source or the target in a refusal that is about one of them", async () => {
    const user = userEvent.setup();
    api.post.mockRejectedValue(new ApiError(409, "x", "LESSON_MOVE_REPLACED_BY_ACTIVITY", { side: "FROM" }));
    renderIn(<MovePupilDialog lessonId={LESSON} studentId={PUPIL} open onOpenChange={() => {}} />);
    await user.click(await screen.findByRole("radio", { name: "Engelska · 7B" }));
    await user.click(screen.getByRole("button", { name: "Flytta" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Lektionen eleven går från är ersatt av en schemabrytande aktivitet."));
  });

  it("says in English as well, and has a sentence for every code the gateway can answer", async () => {
    renderIn(<MovePupilDialog lessonId={LESSON} studentId={PUPIL} open onOpenChange={() => {}} />, "en");
    expect(await screen.findByText("Is replaced by a schedule-breaking activity")).toBeInTheDocument();
    for (const code of Object.keys(sv.lessonMoves.errors)) expect(Object.keys(en.lessonMoves.errors)).toContain(code);
    expect(Object.keys(sv.lessonMoves.errors).sort()).toEqual(Object.keys(en.lessonMoves.errors).sort());
  });

  it("asks which pupil when the opener did not say, and says so when the caller may move none", async () => {
    renderIn(<MovePupilDialog lessonId={LESSON} open onOpenChange={() => {}} />);
    expect(await screen.findByText("Det finns ingen elev på lektionen som du får flytta.")).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(`/api/v1/lesson-moves/lessons/${LESSON}/pupils`);
    // No pupil, no candidates asked.
    expect(api.get.mock.calls.some(([path]) => String(path).includes("/candidates"))).toBe(false);
  });
});

describe("the list of the pupils a lesson lost and gained", () => {
  const moves = (): LessonMoves => ({
    departures: [
      {
        moveId: "m-1",
        studentId: PUPIL,
        studentName: "Alva Andersson",
        other: { id: ENGLISH, subject: "Engelska", className: "7B", start: "09:00", end: "10:00", room: "A1" },
        movedByName: "Rektor Rask",
        createdAt: "2026-11-10T07:00:00.000Z",
      },
    ],
    arrivals: [
      {
        moveId: "m-2",
        studentId: "p-2",
        studentName: "Bo Berg",
        other: { id: SWEDISH, subject: "Svenska", className: "7C", start: "09:00", end: "10:00", room: null },
        movedByName: null,
        createdAt: "2026-11-10T07:05:00.000Z",
      },
    ],
  });

  it("shows the pupil as moved, with where to and from and who moved them, not as absent", async () => {
    api.get.mockImplementation(async (path: string) => (path === `/api/v1/lesson-moves/lessons/${LESSON}` ? moves() : { students: [] }));
    renderIn(<LessonMovesSection lessonId={LESSON} moving={false} onMovingChange={() => {}} />);

    const section = await screen.findByRole("region", { name: "Flyttade elever" });
    expect(within(section).getByText("Alva Andersson")).toBeInTheDocument();
    expect(within(section).getByText(/Flyttad till Engelska \(7B, 09:00–10:00\) · flyttad av Rektor Rask/)).toBeInTheDocument();
    expect(within(section).getByText(/Kommer från Svenska \(7C, 09:00–10:00\)/)).toBeInTheDocument();
    // The intro says the pupils are not absent; no pupil's row does.
    for (const row of within(section).getAllByRole("listitem")) expect(within(row).queryByText(/frånvar/i)).toBeNull();
  });

  it("takes a move back with Ångra, and says so", async () => {
    const user = userEvent.setup();
    api.get.mockImplementation(async () => moves());
    api.delete.mockResolvedValue(undefined);
    renderIn(<LessonMovesSection lessonId={LESSON} moving={false} onMovingChange={() => {}} />);

    const [first] = await screen.findAllByRole("button", { name: "Ångra" });
    await user.click(first!);

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith("/api/v1/lesson-moves/m-1"));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Flytten är ångrad."));
  });

  it("says why Ångra is refused when the pupil already has a mark on the lesson they were moved to", async () => {
    const user = userEvent.setup();
    api.get.mockImplementation(async () => moves());
    api.delete.mockRejectedValue(new ApiError(409, "x", "LESSON_MOVE_HAS_ATTENDANCE"));
    renderIn(<LessonMovesSection lessonId={LESSON} moving={false} onMovingChange={() => {}} />);

    const [first] = await screen.findAllByRole("button", { name: "Ångra" });
    await user.click(first!);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Eleven har redan en närvaromarkering på lektionen de flyttats till. Ta bort markeringen först."),
    );
  });

  it("draws nothing for a lesson nobody was moved from or to", async () => {
    api.get.mockImplementation(async () => ({ departures: [], arrivals: [] }));
    renderIn(<LessonMovesSection lessonId={LESSON} moving={false} onMovingChange={() => {}} />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "Flyttade elever" })).toBeNull();
  });
});
