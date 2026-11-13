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

  it("says that the lesson is over, and who can still correct a move that was made", async () => {
    const user = userEvent.setup();
    api.post.mockRejectedValue(new ApiError(409, "x", "LESSON_MOVE_LESSON_OVER"));
    renderIn(<MovePupilDialog lessonId={LESSON} studentId={PUPIL} open onOpenChange={() => {}} />);
    await user.click(await screen.findByRole("radio", { name: "Engelska · 7B" }));
    await user.click(screen.getByRole("button", { name: "Flytta" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("En flytt som redan gjorts kan samma dag ångras av en administratör med Drift eller en lärare på lektionen eleven flyttades från")),
    );
  });

  it("lists the lessons with the reason that the source is over, when it is, in both languages", async () => {
    const over = candidates();
    api.get.mockImplementation(async (path: string) => {
      if (path.includes("/candidates")) {
        return { ...over, candidates: over.candidates.map((candidate) => ({ ...candidate, refusal: { code: "LESSON_MOVE_LESSON_OVER", side: "FROM" } })) };
      }
      return { students: [] };
    });
    renderIn(<MovePupilDialog lessonId={LESSON} studentId={PUPIL} open onOpenChange={() => {}} />);
    expect((await screen.findAllByText("Lektionen eleven går från är slut")).length).toBe(4);
    expect(screen.getByRole("radio", { name: "Engelska · 7B" })).toBeDisabled();
    expect(en.lessonMoves.refusal.LESSON_MOVE_LESSON_OVER).toBe("The lesson the pupil leaves is over");
    // The sentence an error carries is true in both languages: who can still undo and who can move on.
    expect(en.lessonMoves.errors.LESSON_MOVE_LESSON_OVER).toContain("undone the same day by an administrator with Drift or a teacher of the lesson the pupil was moved from");
    expect(en.lessonMoves.errors.LESSON_MOVE_LESSON_OVER).toContain("moved on by an administrator with Drift or a teacher of the lesson the pupil is on");
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

    const [first] = await screen.findAllByRole("button", { name: /^Ångra/ });
    await user.click(first!);

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith("/api/v1/lesson-moves/m-1"));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Flytten är ångrad."));
  });

  it("says why Ångra is refused when the pupil already has a mark on the lesson they were moved to", async () => {
    const user = userEvent.setup();
    api.get.mockImplementation(async () => moves());
    api.delete.mockRejectedValue(new ApiError(409, "x", "LESSON_MOVE_HAS_ATTENDANCE"));
    renderIn(<LessonMovesSection lessonId={LESSON} moving={false} onMovingChange={() => {}} />);

    const [first] = await screen.findAllByRole("button", { name: /^Ångra/ });
    await user.click(first!);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Eleven har redan en närvaromarkering på lektionen de flyttats till. Läraren på den lektionen, eller en administratör, kan rensa markeringen i lektionens närvarolista. Sedan går det att ångra flytten eller flytta eleven vidare.",
      ),
    );
  });

  // LM415 left a pupil moved onto a lesson with a mark that only the API could take away (the register's buttons are
  // the four marks). "Rensa markering" saves UNKNOWN, which is no mark, so the move can be undone.
  describe("Rensa markering, for the pupil who was moved here and holds a mark", () => {
    const REPORT = "/api/v1/attendance/report";
    const records = (status: string) => ({
      records: [{ id: "r-1", calendarLessonId: LESSON, studentId: "p-2", status, recordedAt: "2026-11-10T07:10:00.000Z", note: null }],
    });
    const serve = (marks: unknown) =>
      api.get.mockImplementation(async (path: string) => (path === `/api/v1/attendance/lessons/${LESSON}/records` ? marks : moves()));

    it("saves UNKNOWN for that pupil alone, says so, and tells the page to forget what it had chosen", async () => {
      const user = userEvent.setup();
      const forget = vi.fn();
      serve(records("PRESENT"));
      api.post.mockResolvedValue({ created: 0, updated: 1 });
      renderIn(<LessonMovesSection lessonId={LESSON} moving={false} onMovingChange={() => {}} onMarkCleared={forget} />);

      await user.click(await screen.findByRole("button", { name: /^Rensa markering/ }));

      await waitFor(() =>
        expect(api.post).toHaveBeenCalledWith(REPORT, { calendarLessonId: LESSON, records: [{ studentId: "p-2", status: "UNKNOWN" }] }),
      );
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Markeringen för Bo Berg är rensad."));
      expect(forget).toHaveBeenCalledWith("p-2");
    });

    it("is on the arrival's row only: a pupil who was moved away has a mark here too, and no button", async () => {
      // Alva (moved away) and Bo (moved here) both hold a mark on this lesson.
      serve({
        records: [
          { id: "r-1", calendarLessonId: LESSON, studentId: PUPIL, status: "PRESENT", recordedAt: "2026-11-10T07:10:00.000Z", note: null },
          { id: "r-2", calendarLessonId: LESSON, studentId: "p-2", status: "LATE", recordedAt: "2026-11-10T07:10:00.000Z", note: null },
        ],
      });
      renderIn(<LessonMovesSection lessonId={LESSON} moving={false} onMovingChange={() => {}} />);

      const section = await screen.findByRole("region", { name: "Flyttade elever" });
      const buttons = await within(section).findAllByRole("button", { name: /^Rensa markering/ });
      expect(buttons).toHaveLength(1);
      const departure = within(section).getByText("Alva Andersson").closest("li")!;
      const arrival = within(section).getByText("Bo Berg").closest("li")!;
      expect(within(departure).queryByRole("button", { name: /^Rensa markering/ })).toBeNull();
      expect(within(arrival).getByRole("button", { name: "Rensa markering för Bo Berg" })).toBe(buttons[0]);
    });

    it("shows no button when nobody holds a mark", async () => {
      serve({ records: [] });
      renderIn(<LessonMovesSection lessonId={LESSON} moving={false} onMovingChange={() => {}} />);
      await screen.findByRole("region", { name: "Flyttade elever" });
      expect(screen.queryByRole("button", { name: /^Rensa markering/ })).toBeNull();
    });

    it("keeps Ångra on the arrival's row what it was while the row has Rensa markering: it takes the move back and clears nothing", async () => {
      const user = userEvent.setup();
      serve(records("PRESENT"));
      api.delete.mockResolvedValue(undefined);
      renderIn(<LessonMovesSection lessonId={LESSON} moving={false} onMovingChange={() => {}} />);

      const arrival = (await screen.findByText("Bo Berg")).closest("li")!;
      await within(arrival).findByRole("button", { name: /^Rensa markering/ });
      await user.click(within(arrival).getByRole("button", { name: "Ångra flytten av Bo Berg" }));

      await waitFor(() => expect(api.delete).toHaveBeenCalledWith("/api/v1/lesson-moves/m-2"));
      expect(api.post).not.toHaveBeenCalled();
    });

    it("names the pupil in both buttons, so a list of buttons can be told apart, and leaves the writes to Drift", async () => {
      serve(records("PRESENT"));
      renderIn(<LessonMovesSection lessonId={LESSON} moving={false} onMovingChange={() => {}} />);

      const arrival = (await screen.findByText("Bo Berg")).closest("li")!;
      const clear = await within(arrival).findByRole("button", { name: "Rensa markering för Bo Berg" });
      const undo = within(arrival).getByRole("button", { name: "Ångra flytten av Bo Berg" });
      // The visible words are the start of the name.
      expect(clear).toHaveTextContent("Rensa markering");
      expect(undo).toHaveTextContent("Ångra");
      for (const button of [clear, undo]) expect(button).toHaveAttribute("data-writes", "DRIFT");
      expect(within(screen.getByText("Alva Andersson").closest("li")!).getByRole("button", { name: "Ångra flytten av Alva Andersson" })).toHaveAttribute("data-writes", "DRIFT");
    });

    it("holds the button while the save is under way, and saves once", async () => {
      const user = userEvent.setup();
      serve(records("PRESENT"));
      api.post.mockReturnValue(new Promise(() => undefined));
      renderIn(<LessonMovesSection lessonId={LESSON} moving={false} onMovingChange={() => {}} />);

      const button = await screen.findByRole("button", { name: /^Rensa markering/ });
      await user.click(button);
      await waitFor(() => expect(button).toBeDisabled());
      await user.click(button);

      expect(api.post).toHaveBeenCalledTimes(1);
    });

    it("offers nothing for a mark that is already UNKNOWN, which is the state the button leaves", async () => {
      serve(records("UNKNOWN"));
      renderIn(<LessonMovesSection lessonId={LESSON} moving={false} onMovingChange={() => {}} />);
      await screen.findByRole("region", { name: "Flyttade elever" });
      await waitFor(() => expect(api.get).toHaveBeenCalledWith(`/api/v1/attendance/lessons/${LESSON}/records`));
      expect(screen.queryByRole("button", { name: /^Rensa markering/ })).toBeNull();
    });

    it("keeps the mark as it was, and says why, when the gateway refuses (a teacher who is not on this lesson)", async () => {
      const user = userEvent.setup();
      const forget = vi.fn();
      serve(records("ABSENT"));
      api.post.mockRejectedValue(new ApiError(403, "You are not assigned to this lesson and cannot record attendance for it."));
      renderIn(<LessonMovesSection lessonId={LESSON} moving={false} onMovingChange={() => {}} onMarkCleared={forget} />);

      await user.click(await screen.findByRole("button", { name: /^Rensa markering/ }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("You are not assigned to this lesson and cannot record attendance for it."));
      expect(forget).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
    });

    it("says it in English too: the button, the toast, and what to do about a refused Ångra", async () => {
      const user = userEvent.setup();
      serve(records("LATE"));
      api.post.mockResolvedValue({ created: 0, updated: 1 });
      api.delete.mockRejectedValue(new ApiError(409, "x", "LESSON_MOVE_HAS_ATTENDANCE"));
      renderIn(<LessonMovesSection lessonId={LESSON} moving={false} onMovingChange={() => {}} />, "en");

      const arrival = (await screen.findByText("Bo Berg")).closest("li")!;
      await user.click(await within(arrival).findByRole("button", { name: "Undo the move of Bo Berg" }));
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          "The pupil already has an attendance mark on the lesson they were moved to. The teacher on that lesson, or an administrator, can clear the mark in the lesson's attendance list. Then the move can be undone or the pupil moved on.",
        ),
      );
      await user.click(within(arrival).getByRole("button", { name: "Clear mark for Bo Berg" }));
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("The mark for Bo Berg is cleared."));
    });
  });

  it("draws nothing for a lesson nobody was moved from or to", async () => {
    api.get.mockImplementation(async () => ({ departures: [], arrivals: [] }));
    renderIn(<LessonMovesSection lessonId={LESSON} moving={false} onMovingChange={() => {}} />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "Flyttade elever" })).toBeNull();
  });
});
