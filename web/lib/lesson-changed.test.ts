import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "use-intl";
import sv from "@/messages/sv.json";
import en from "@/messages/en.json";
import type { MasterLesson } from "@/lib/types";
import { ApiError } from "@/lib/api";
import { changedBy, nowSaid, tellChanged, told } from "./lesson-changed";

/*
 * What is said when a write of a lesson is refused for somebody else's change (E9): the lesson as it has become, in the fields the gateway named,
 * and the change offered again.
 */
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));
const readOne = vi.hoisted(() => vi.fn());
vi.mock("@/lib/master-lesson-cache", () => ({ readOne }));

const say = (messages: typeof sv, locale: string) => createTranslator({ locale, messages, namespace: "timetable" }) as never;
const lesson = (over: Partial<MasterLesson> = {}): MasterLesson =>
  ({ id: "l-1", academicYearId: "y", subjectId: "s", studentGroupId: "g", teacherId: "anna", coTeacherId: null, roomId: "r-12", dayOfWeek: 2, startTime: "10:00:00", endTime: "11:00:00", isLocked: false, isParked: false, recurrence: "ALL_WEEKS", startDate: null, endDate: null, extraGroupIds: [], studentIds: [], ...over }) as MasterLesson;

function client() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["rooms"], [{ id: "r-12", name: "A12" }]);
  queryClient.setQueryData(["people"], [{ id: "anna", firstName: "Anna", lastName: "Ek" }]);
  return queryClient;
}

beforeEach(() => {
  toasts.error.mockClear();
  toasts.success.mockClear();
  readOne.mockReset();
  document.documentElement.lang = "sv";
});

describe("what the lesson has become, in the fields that were named", () => {
  it("says the day and the clock for any field that says when, the room and the teacher by name, and nothing of the fields that were not named", () => {
    const t = say(sv, "sv");
    expect(nowSaid(client(), lesson(), ["startTime"], t)).toBe("tisdag 10:00–11:00");
    expect(nowSaid(client(), lesson(), ["roomId", "teacherId"], t)).toBe("sal A12, lärare Anna Ek");
    expect(nowSaid(client(), lesson(), ["dayOfWeek", "roomId", "isLocked"], t)).toBe("tisdag 10:00–11:00, sal A12, upplåst");
    expect(nowSaid(client(), lesson({ isLocked: true, isParked: true }), ["isLocked", "isParked"], t)).toBe("låst, satt åt sidan");
  });

  it("says it without a name when the list of names has not come, and with a word for none", () => {
    const t = say(sv, "sv");
    expect(nowSaid(new QueryClient(), lesson(), ["roomId", "teacherId"], t)).toBe("i en annan sal, hos en annan lärare");
    expect(nowSaid(client(), lesson({ roomId: null, teacherId: null }), ["roomId", "teacherId"], t)).toBe("utan sal, utan lärare");
  });

  it("says the day in the reader's language", () => {
    document.documentElement.lang = "en";
    expect(nowSaid(client(), lesson(), ["dayOfWeek"], say(en as never, "en"))).toBe("Tuesday 10:00–11:00");
  });

  it("says other classes, pupils and a changed exemption", () => {
    expect(nowSaid(client(), lesson(), ["extraGroupIds", "studentIds", "exempt"], say(sv, "sv"))).toBe("med andra klasser eller elever, med ett ändrat undantag");
  });
});

describe("telling the refusal", () => {
  const input = (over: Record<string, unknown> = {}) => ({ queryClient: client(), fields: "dayOfWeek,startTime", lesson: lesson({ dayOfWeek: 1 }), t: say(sv, "sv"), again: vi.fn().mockResolvedValue(undefined), ...over });

  it("reads the lesson again, says that the change was not made and what the lesson is now, and offers the change once more", async () => {
    const queryClient = client();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    readOne.mockResolvedValue(lesson());
    const again = vi.fn().mockResolvedValue(undefined);
    await tellChanged(input({ queryClient, again }));
    expect(readOne).toHaveBeenCalledWith(queryClient, "l-1");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["masterLessons"] });
    const [text, options] = toasts.error.mock.calls[0]!;
    expect(text).toBe("Lektionen har ändrats av någon annan sedan du läste den, och din ändring gjordes inte. Nu är den: tisdag 10:00–11:00.");
    expect(options.action.label).toBe("Gör om min ändring");
    // The button is the reader's: pressed, it makes the change on the lesson as it is, and says so.
    await options.action.onClick();
    expect(again).toHaveBeenCalledWith(lesson());
    await vi.waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Din ändring är gjord."));
  });

  it("says when the change cannot be made again", async () => {
    readOne.mockResolvedValue(lesson());
    await tellChanged(input({ again: vi.fn().mockRejectedValue(new Error("no")) }));
    toasts.error.mock.calls[0]![1].action.onClick();
    await vi.waitFor(() => expect(toasts.error).toHaveBeenCalledWith("Din ändring gick inte att göra om."));
  });

  it("says a lesson that somebody removed is gone, with nothing to make again", async () => {
    readOne.mockResolvedValue(null);
    await tellChanged(input());
    expect(toasts.error).toHaveBeenCalledWith("Lektionen har tagits bort av någon annan, och din ändring gjordes inte.", { duration: 15000 });
  });

  it("says the refusal without a button when the lesson could not be read", async () => {
    readOne.mockResolvedValue(undefined);
    await tellChanged(input());
    const [text, options] = toasts.error.mock.calls[0]!;
    expect(text).toContain("din ändring gjordes inte");
    expect(options.action).toBeUndefined();
  });
});

describe("a write refused for somebody else's change", () => {
  const error = new ApiError(409, "changed", "LESSON_CHANGED", { fields: "roomId" });
  const catalogue = say(sv, "sv");
  const common = createTranslator({ locale: "sv", messages: sv, namespace: "common" }) as never;
  const again = vi.fn().mockResolvedValue(undefined);

  it("is said as the catalogue's sentence for a write the page does not remember, and as a step that cannot be taken back for an undo", async () => {
    await told({ queryClient: client(), error, asked: undefined, undo: false, t: catalogue, tCommon: common, again });
    expect(toasts.error.mock.calls[0]![0]).toBe(sv.common.codes.LESSON_CHANGED);
    await told({ queryClient: client(), error, asked: undefined, undo: true, t: catalogue, tCommon: common, again });
    expect(toasts.error.mock.calls[1]![0]).toBe(`Det går inte att ångra. ${sv.common.codes.LESSON_CHANGED} Lektionen ligger kvar där den är, och nästa Ångra tar steget före.`);
    expect(readOne).not.toHaveBeenCalled();
  });

  it("is told in full for a write the page remembers: the lesson is read, the fields named by the gateway are said, and the change is offered again with its patch", async () => {
    readOne.mockResolvedValue(lesson({ roomId: "r-12" }));
    await told({ queryClient: client(), error, asked: { lesson: lesson({ roomId: null }), patch: { roomId: "r-3" } }, undo: false, t: catalogue, tCommon: common, again });
    const [text, options] = toasts.error.mock.calls[0]!;
    expect(text).toContain("Nu är den: sal A12.");
    await options.action.onClick();
    expect(again).toHaveBeenCalledWith(lesson({ roomId: "r-12" }), { roomId: "r-3" });
  });

  it("offers again what the reader changed and not the fields a dialog save only restated: the colleague's teacher is not put back by the button (granskaren g515)", async () => {
    readOne.mockResolvedValue(lesson({ teacherId: "berit" }));
    again.mockClear();
    const dialog = { dayOfWeek: 2, startTime: "10:00", endTime: "11:00", roomId: "r-3", teacherId: "anna", isLocked: false, recurrence: "ALL_WEEKS", startDate: null, endDate: null };
    await told({ queryClient: client(), error: new ApiError(409, "changed", "LESSON_CHANGED", { fields: "teacherId" }), asked: { lesson: lesson(), patch: dialog }, undo: false, t: catalogue, tCommon: common, again });
    await toasts.error.mock.calls.at(-1)![1].action.onClick();
    expect(again).toHaveBeenCalledWith(lesson({ teacherId: "berit" }), { roomId: "r-3" });
  });
});

describe("what the reader changed", () => {
  it("is the fields of the patch that are not what the lesson held, the lists as sets, and the fields the lesson has no word for are kept", () => {
    expect(changedBy(lesson({ exemptFrom: ["FRAME", "LUNCH"] }), { roomId: "r-12", exempt: ["LUNCH", "FRAME"], dayOfWeek: 3, propagate: false })).toEqual({ dayOfWeek: 3, propagate: false });
    expect(changedBy(lesson(), { startTime: "10:00", endTime: "12:00", startDate: null })).toEqual({ endTime: "12:00" });
    expect(changedBy(lesson(), { exempt: [] })).toEqual({});
  });
});
