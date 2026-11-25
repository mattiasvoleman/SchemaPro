import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LessonJudgement } from "@/lib/lesson-judgement";
import type { MasterLesson } from "@/lib/types";
import { LessonEditDialog, type LessonEditDraft } from "./lesson-edit-dialog";

const post = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: { post } }));
// The real catalogue through the real translator: the sentences under test are the reader's.
vi.mock("next-intl", async () => {
  const { createTranslator } = await import("use-intl");
  const sv = (await import("@/messages/sv.json")).default;
  return {
    useLocale: () => "sv",
    useTranslations: (namespace: string) => createTranslator({ locale: "sv", messages: sv, namespace: namespace as never }),
  };
});

const NONE = "__none__";
const lesson = {
  id: "l-1",
  academicYearId: "y1",
  subjectId: "Ma",
  studentGroupId: "7A",
  teacherId: "anna",
  coTeacherId: null,
  roomId: null,
  dayOfWeek: 1,
  startTime: "10:00:00",
  endTime: "11:00:00",
  isLocked: false,
  isParked: false,
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  extraGroupIds: [],
  studentIds: [],
} as MasterLesson;
const standing: LessonEditDraft = {
  dayOfWeek: "1",
  startTime: "10:00",
  endTime: "11:00",
  roomId: NONE,
  teacherId: "anna",
  isLocked: false,
  recurrence: "ALL_WEEKS",
  startDate: "",
  endDate: "",
};

const answer = (refusals: LessonJudgement["moves"][number]["refusals"], extra: Partial<LessonJudgement["moves"][number]> = {}): LessonJudgement => ({
  ok: refusals.length === 0 && !extra.placed,
  moves: [{ lessonId: "l-1", ok: refusals.length === 0 && !extra.placed, refusals, ...extra }],
});

const draw = (draft: LessonEditDraft, open = true) =>
  render(
    <LessonEditDialog
      open={open}
      lesson={lesson}
      onOpenChange={() => {}}
      lessonName="Matematik 7A"
      draft={draft}
      onDraftChange={() => {}}
      rooms={[]}
      teachers={[]}
      onDelete={() => {}}
      deletePending={false}
      onDuplicate={() => {}}
      onPark={() => {}}
      onSuggestSwaps={() => {}}
      onCancel={() => {}}
      onSave={() => {}}
      savePending={false}
      none={NONE}
    />,
  );

const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(400)));

describe("Justera lektion asks the judge while its fields are filled in", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    post.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks nothing, and says nothing, for a lesson left as it stands", async () => {
    draw(standing);
    await settle();
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("says the reason in the refusal's sentence, naming the other lesson by class, subject, day and time, in the live region", async () => {
    post.mockResolvedValue(
      answer([
        {
          reason: "TEACHER",
          params: { otherKind: "LESSON", className: "8B", subjectName: "Kemi", day: 1, start: "13:10", end: "14:10" },
          text: "Läraren har redan Kemi 8B måndag 13:10–14:10.",
        },
      ]),
    );
    draw({ ...standing, startTime: "13:10", endTime: "14:10" });
    await settle();
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toContain("Det går inte att spara så här:");
    expect(status.textContent).toContain("Läraren har redan Kemi med 8B, måndag 13:10–14:10.");
    expect(post.mock.calls[0]![1]).toEqual({ moves: [{ lessonId: "l-1", startTime: "13:10", endTime: "14:10" }] });
  });

  it("marks the fields the reason is about, and Spara stays allowed: the save is the judge", async () => {
    post.mockResolvedValue(answer([{ reason: "LUNCH", params: {}, text: "Tiden ligger på klassens lunch." }]));
    draw({ ...standing, startTime: "12:00", endTime: "13:00" });
    await settle();
    for (const id of ["edit-day", "edit-start", "edit-end"]) {
      expect(document.getElementById(id)!.getAttribute("aria-invalid"), id).toBe("true");
      expect(document.getElementById(id)!.getAttribute("aria-describedby"), id).toBe("edit-judgement");
    }
    expect(document.getElementById("edit-room")!.getAttribute("aria-invalid")).toBeNull();
    expect(document.getElementById("edit-teacher")!.getAttribute("aria-invalid")).toBeNull();
    expect((screen.getByRole("button", { name: "Spara" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("marks the room for a room that is taken, and the teacher for a teacher who is", async () => {
    post.mockResolvedValue(
      answer([
        { reason: "ROOM", params: { otherKind: "LESSON", className: "8B", subjectName: "Kemi", day: 1, start: "10:00", end: "11:00" }, text: "x" },
        { reason: "AVAILABILITY", params: { resource: "TEACHER" }, text: "y" },
      ]),
    );
    draw({ ...standing, roomId: "r2" });
    await settle();
    expect(document.getElementById("edit-room")!.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById("edit-teacher")!.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById("edit-start")!.getAttribute("aria-invalid")).toBeNull();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Salen är redan upptagen av Kemi med 8B, måndag 10:00–11:00.",
      "Läraren är markerad som inte tillgänglig då.",
    ]);
  });

  it("says that the check finds nothing in the way, and marks no field", async () => {
    post.mockResolvedValue(answer([]));
    draw({ ...standing, dayOfWeek: "2" });
    await settle();
    expect(screen.getByRole("status").textContent).toBe("Kontrollen hittar inget som hindrar.");
    expect(document.getElementById("edit-day")!.getAttribute("aria-invalid")).toBeNull();
  });

  it("says a förlagd lesson in the sentence of a refused save", async () => {
    post.mockResolvedValue(answer([], { placed: true }));
    draw({ ...standing, dayOfWeek: "2" });
    await settle();
    expect(screen.getByRole("status").textContent).toContain("Lektionen är förlagd");
  });

  it("says the check did not answer, and nothing more, when the question fails", async () => {
    post.mockRejectedValue(new Error("offline"));
    draw({ ...standing, dayOfWeek: "2" });
    await settle();
    expect(screen.getByRole("status").textContent).toBe("Kontrollen svarade inte. Spara prövar ändå.");
  });

  it("asks nothing while it is closed", async () => {
    draw({ ...standing, dayOfWeek: "2" }, false);
    await settle();
    expect(post).not.toHaveBeenCalled();
  });
});
