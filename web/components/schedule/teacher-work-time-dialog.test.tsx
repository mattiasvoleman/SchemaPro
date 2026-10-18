import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { TeacherWorkRule } from "@/lib/types";
import { TeacherWorkTimeDialog } from "./teacher-work-time-dialog";

/**
 * What this file guards: WHAT GETS SENT, and what deliberately does not.
 *
 * lib/teacher-work-rules.ts owns the rules and is tested on its own. What only
 * the dialog can get wrong is the round trip, and every way it can go wrong here
 * is silent:
 *
 *   An EMPTY form that sends anything. Four nulls are a legitimate answer and
 *   the one every school is running today; a save that posted four zeroes would
 *   promise a lunch of nought minutes, which the solver honours by refusing the
 *   week.
 *
 *   A CLEARED form that sends a PATCH of the fields it still has. The body has
 *   to name every key or the old rule survives the clearing, and the school
 *   finds out at the next generation run.
 *
 *   A CAP OR A WISH LOST to an edit of something else (Lärarens dag). They sit
 *   on the same row as the lunch, so a save that did not carry them, or a
 *   cleared lunch that read the row as empty and deleted it, would take them
 *   away without anybody choosing to.
 *
 *   A REFUSAL the reader never sees. The gateway rejects a half-filled lunch
 *   trio in English prose written for a log; the form has to name the missing
 *   half in Swedish and refuse to send.
 */

const saveMock = vi.fn();
const removeMock = vi.fn();

vi.mock("@/lib/work-rule-queries", () => ({
  useTeacherWorkRuleActions: () => ({
    save: { mutateAsync: saveMock, isPending: false },
    remove: { mutateAsync: removeMock, isPending: false },
  }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

const teacher = { id: "t-1", firstName: "Karin", lastName: "Ek" };

/** A stored row as PostgREST returns it — note the seconds on the clocks. */
const rule = (overrides: Partial<TeacherWorkRule> = {}): TeacherWorkRule => ({
  id: "w-1",
  userId: "t-1",
  lunchMinutes: 30,
  lunchStartTime: "10:30:00",
  lunchEndTime: "13:30:00",
  minDailyRestMinutes: 660,
  maxTeachingMinutesPerDay: null,
  preferredFreeDayOfWeek: null,
  ...overrides,
});

const NO_LUNCH_OR_REST = {
  lunchMinutes: null,
  lunchStartTime: null,
  lunchEndTime: null,
  minDailyRestMinutes: null,
};

const onOpenChange = vi.fn();

const open = (stored?: TeacherWorkRule) =>
  render(
    <TeacherWorkTimeDialog
      open
      onOpenChange={onOpenChange}
      teacher={teacher}
      rule={stored}
    />,
  );

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const save = () => screen.getByRole("button", { name: "save" });
/**
 * `<input type="time">` is one of the controls user-event drives by typing
 * segments, which jsdom models only partially; the value change is what this
 * form reads, so it is set directly — the same choice the gaps page's test makes.
 */
const setTime = (label: string, value: string) =>
  fireEvent.change(field(label), { target: { value } });
const setNumber = (label: string, value: string) =>
  fireEvent.change(field(label), { target: { value } });

beforeEach(() => {
  saveMock.mockReset().mockResolvedValue({});
  removeMock.mockReset().mockResolvedValue({});
  onOpenChange.mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
});

describe("a teacher with no rule", () => {
  it("opens empty, and says so rather than showing four zeroes", () => {
    open(undefined);

    expect(field("lunchMinutes").value).toBe("");
    expect(field("windowStart").value).toBe("");
    expect(field("windowEnd").value).toBe("");
    expect(field("restMinutes").value).toBe("");
    expect(screen.getByText("emptyMeansNoRule")).toBeInTheDocument();
  });

  it("marks Spara as planering's write, the teacher's work rule (Läsbehörighet)", () => {
    open(undefined);
    expect(save()).toHaveAttribute("data-writes", "PLANERING");
  });

  it("sends nothing at all when it is saved untouched", async () => {
    // Not a POST of four nulls, and not a DELETE of a row that does not exist:
    // there is nothing to say, so nothing is said.
    const user = userEvent.setup();
    open(undefined);

    await user.click(save());

    expect(saveMock).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("warns that the rule is hard before anybody writes one", () => {
    open(undefined);

    expect(screen.getByText("hardRuleHint")).toBeInTheDocument();
  });
});

describe("the suggestion", () => {
  it("fills the draft when it is asked for, and saves nothing by itself", async () => {
    const user = userEvent.setup();
    open(undefined);

    await user.click(screen.getByRole("button", { name: "useSuggestion" }));

    expect(field("lunchMinutes").value).toBe("30");
    expect(field("windowStart").value).toBe("10:30");
    expect(field("windowEnd").value).toBe("13:30");
    expect(field("restMinutes").value).toBe("660");
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("is offered only while the row is still blank", async () => {
    const user = userEvent.setup();
    open(undefined);

    await user.click(screen.getByRole("button", { name: "useSuggestion" }));

    expect(screen.queryByRole("button", { name: "useSuggestion" })).toBeNull();
  });

  it("completes the lunch trio when somebody starts it", () => {
    // The trio is all-or-nothing in the table, and writing the minutes and
    // walking away is the commonest way to fail it.
    open(undefined);

    setNumber("lunchMinutes", "45");

    expect(field("windowStart").value).toBe("10:30");
    expect(field("windowEnd").value).toBe("13:30");
    // And no dygnsvila conjured: that rule stands alone and is legitimately
    // the only one a school sets.
    expect(field("restMinutes").value).toBe("");
  });

  it("does not come back when the last lunch field is cleared", () => {
    /*
     * Clearing the three fields is how a reader REMOVES the lunch rule. A
     * complement that fired on an empty value would find the trio empty and put
     * the suggestion straight back, and the rule could never be taken away.
     */
    open(rule());

    setNumber("lunchMinutes", "");
    setTime("windowStart", "");
    setTime("windowEnd", "");

    expect(field("lunchMinutes").value).toBe("");
    expect(field("windowStart").value).toBe("");
    expect(field("windowEnd").value).toBe("");
  });
});

describe("a half-filled lunch trio", () => {
  it("is refused with a reason, and the save is blocked", () => {
    open(undefined);

    setNumber("lunchMinutes", "30");
    setTime("windowEnd", "");

    expect(screen.getByRole("status")).toHaveTextContent(/lunchTrioIncomplete/);
    expect(save()).toBeDisabled();
  });

  it("is refused the other way round too — a window with no length", () => {
    open(rule());

    setNumber("lunchMinutes", "");

    expect(screen.getByRole("status")).toHaveTextContent(/lunchTrioIncomplete/);
    expect(save()).toBeDisabled();
  });

  it("sends nothing while it is refused", async () => {
    const user = userEvent.setup();
    open(undefined);

    setNumber("lunchMinutes", "30");
    setTime("windowStart", "");

    await user.click(save());

    expect(saveMock).not.toHaveBeenCalled();
  });
});

describe("the bounds", () => {
  it("refuses a lunch shorter than five minutes", () => {
    open(undefined);

    setNumber("lunchMinutes", "4");

    expect(screen.getByRole("status")).toHaveTextContent(/lunchMinutesOutOfRange\(5\|240\)/);
    expect(save()).toBeDisabled();
  });

  it("refuses a lunch longer than four hours", () => {
    open(undefined);

    setNumber("lunchMinutes", "245");

    expect(screen.getByRole("status")).toHaveTextContent(/lunchMinutesOutOfRange/);
  });

  it("refuses a lunch off the solver's five-minute grid", () => {
    open(undefined);

    setNumber("lunchMinutes", "32");

    expect(screen.getByRole("status")).toHaveTextContent(/lunchMinutesOffGrid\(5\)/);
  });

  it("refuses a window that cannot hold the lunch, and says how wide it is", () => {
    open(rule());

    setNumber("lunchMinutes", "45");
    setTime("windowStart", "11:00");
    setTime("windowEnd", "11:30");

    expect(screen.getByRole("status")).toHaveTextContent(
      /lunchWindowTooNarrow\(45\|30\)/,
    );
    expect(save()).toBeDisabled();
  });

  it("refuses a window that runs backwards", () => {
    open(rule());

    setTime("windowStart", "13:30");
    setTime("windowEnd", "10:30");

    expect(screen.getByRole("status")).toHaveTextContent(/lunchWindowBackwards/);
  });

  it("refuses a window edge off the five-minute grid", () => {
    // Nothing in the table forbids 10:32; the gateway does, and the form has to
    // say so first or the refusal arrives as English prose from a 400.
    open(rule());

    setTime("windowStart", "10:32");

    expect(screen.getByRole("status")).toHaveTextContent(/lunchWindowOffGrid\(5\)/);
    expect(save()).toBeDisabled();
  });

  it("refuses less than an hour of rest", () => {
    open(undefined);

    setNumber("restMinutes", "59");

    expect(screen.getByRole("status")).toHaveTextContent(/restOutOfRange\(60\|1320\)/);
    expect(save()).toBeDisabled();
  });

  it("refuses more than twenty-two hours of rest", () => {
    open(undefined);

    setNumber("restMinutes", "1321");

    expect(screen.getByRole("status")).toHaveTextContent(/restOutOfRange/);
  });
});

describe("what a full row sends", () => {
  it("round-trips a stored rule without changing it", async () => {
    /*
     * The seconds on the stored clocks are the trap. An `<input type="time">`
     * renders "10:30:00" as EMPTY rather than complaining, so a form that did
     * not cut them would look like a teacher with no lunch rule — and this save,
     * of something else entirely, would clear a rule the school set a term ago.
     */
    const user = userEvent.setup();
    open(rule());

    expect(field("windowStart").value).toBe("10:30");
    expect(field("windowEnd").value).toBe("13:30");

    await user.click(save());

    // Keyed by the TEACHER, which is how the endpoint is keyed. The row's own id
    // never leaves this component: PUT /api/v1/teacher-work-rules/:userId upserts
    // that teacher's row, and the row id would address nothing at that path.
    expect(saveMock).toHaveBeenCalledWith({
      userId: "t-1",
      lunchMinutes: 30,
      lunchStartTime: "10:30",
      lunchEndTime: "13:30",
      minDailyRestMinutes: 660,
      maxTeachingMinutesPerDay: null,
      preferredFreeDayOfWeek: null,
    });
  });

  it("round-trips a stored cap and wish too, as numbers", async () => {
    const user = userEvent.setup();
    open(rule({ maxTeachingMinutesPerDay: 270, preferredFreeDayOfWeek: 5 }));

    expect(field("dayCapMinutes").value).toBe("270");
    expect((screen.getByLabelText("freeDay") as HTMLSelectElement).value).toBe("5");

    await user.click(save());

    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ lunchMinutes: 30, maxTeachingMinutesPerDay: 270, preferredFreeDayOfWeek: 5 }),
    );
  });

  it("sends the same upsert for a teacher who had no row", async () => {
    // One request for both cases: at most one row per teacher, so there is no
    // create to tell apart from an update here.
    const user = userEvent.setup();
    open(undefined);

    await user.click(screen.getByRole("button", { name: "useSuggestion" }));
    await user.click(save());

    // The suggestion is the lunch and the rest, never a cap or a free day.
    expect(saveMock).toHaveBeenCalledWith({
      userId: "t-1",
      lunchMinutes: 30,
      lunchStartTime: "10:30",
      lunchEndTime: "13:30",
      minDailyRestMinutes: 660,
      maxTeachingMinutesPerDay: null,
      preferredFreeDayOfWeek: null,
    });
  });

  it("sends the rest rule on its own, with the lunch fields null", async () => {
    const user = userEvent.setup();
    open(undefined);

    setNumber("restMinutes", "660");
    await user.click(save());

    expect(saveMock).toHaveBeenCalledWith({
      userId: "t-1",
      lunchMinutes: null,
      lunchStartTime: null,
      lunchEndTime: null,
      minDailyRestMinutes: 660,
      maxTeachingMinutesPerDay: null,
      preferredFreeDayOfWeek: null,
    });
  });

  it("sends the lunch rule on its own, with the rest null", async () => {
    const user = userEvent.setup();
    open(rule({ minDailyRestMinutes: null }));

    await user.click(save());

    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ minDailyRestMinutes: null, lunchMinutes: 30 }),
    );
  });

  it("reports a rejected save rather than closing over it", async () => {
    saveMock.mockRejectedValue(
      new Error("Ange lunchens längd och hela fönstret, eller inget av dem."),
    );
    const user = userEvent.setup();
    open(rule());

    await user.click(save());

    expect(toast.error).toHaveBeenCalledWith(
      "Ange lunchens längd och hela fönstret, eller inget av dem.",
    );
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe("clearing a rule", () => {
  it("deletes the row instead of storing nulls", async () => {
    /*
     * A row of nulls is legal and would read back as "no rule", so this could
     * have been a PUT of nothing. It is a DELETE because the school's own
     * question is which of its teachers have a working time set, and a table
     * where half the rows mean nothing cannot answer it by counting.
     */
    const user = userEvent.setup();
    open(rule());

    setNumber("lunchMinutes", "");
    setTime("windowStart", "");
    setTime("windowEnd", "");
    setNumber("restMinutes", "");

    expect(screen.getByText("emptyMeansNoRule")).toBeInTheDocument();
    await user.click(save());

    // The teacher's id, not the row's "w-1": DELETE is keyed the same way PUT is.
    expect(removeMock).toHaveBeenCalledWith("t-1");
    expect(saveMock).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("cleared");
  });

  it("keeps the row, with its cap and wish, when only the lunch and the rest are cleared", async () => {
    // The row is not empty while a cap or a wish is on it: a DELETE here would
    // take the cap away with a lunch somebody meant to remove.
    const user = userEvent.setup();
    open(rule({ maxTeachingMinutesPerDay: 300, preferredFreeDayOfWeek: 3 }));

    setNumber("lunchMinutes", "");
    setTime("windowStart", "");
    setTime("windowEnd", "");
    setNumber("restMinutes", "");

    expect(screen.queryByText("emptyMeansNoRule")).toBeNull();
    await user.click(save());

    expect(removeMock).not.toHaveBeenCalled();
    expect(saveMock).toHaveBeenCalledWith({
      userId: "t-1",
      lunchMinutes: null,
      lunchStartTime: null,
      lunchEndTime: null,
      minDailyRestMinutes: null,
      maxTeachingMinutesPerDay: 300,
      preferredFreeDayOfWeek: 3,
    });
  });

  it("deletes the row once the cap and the wish are cleared too", async () => {
    const user = userEvent.setup();
    open(rule({ ...NO_LUNCH_OR_REST, maxTeachingMinutesPerDay: 300, preferredFreeDayOfWeek: 3 }));

    setNumber("dayCapMinutes", "");
    fireEvent.change(screen.getByLabelText("freeDay"), { target: { value: "" } });
    await user.click(save());

    expect(removeMock).toHaveBeenCalledWith("t-1");
    expect(saveMock).not.toHaveBeenCalled();
  });
});

describe("the day's cap", () => {
  it("is offered empty, with no suggested number, and says it is hard", () => {
    // A greyed number in the field would read as a value the school could just
    // accept; no cap should be accepted without choosing it.
    open(undefined);

    expect(field("dayCapMinutes").value).toBe("");
    expect(field("dayCapMinutes").placeholder).toBe("");
    // Its own group, named by the section title a screen reader announces on entry.
    expect(screen.getByRole("group", { name: "dayCapTitle" })).toContainElement(field("dayCapMinutes"));
    expect(screen.getByText("dayCapHint")).toBeInTheDocument();
    expect(screen.getByText("hardRuleHint")).toBeInTheDocument();
  });

  it("sends a cap on its own, with everything else null", async () => {
    const user = userEvent.setup();
    open(undefined);

    setNumber("dayCapMinutes", "270");
    await user.click(save());

    expect(saveMock).toHaveBeenCalledWith({
      userId: "t-1",
      lunchMinutes: null,
      lunchStartTime: null,
      lunchEndTime: null,
      minDailyRestMinutes: null,
      maxTeachingMinutesPerDay: 270,
      preferredFreeDayOfWeek: null,
    });
  });

  it("does not complete the lunch trio or offer the suggestion once a cap is written", () => {
    open(undefined);

    setNumber("dayCapMinutes", "300");

    expect(field("lunchMinutes").value).toBe("");
    expect(screen.queryByRole("button", { name: "useSuggestion" })).toBeNull();
  });

  it("refuses a cap outside half an hour to twelve hours, and the save with it", () => {
    open(undefined);

    setNumber("dayCapMinutes", "25");

    expect(screen.getByRole("status")).toHaveTextContent(/dayCapOutOfRange\(30\|720\)/);
    expect(save()).toBeDisabled();
  });

  it("refuses a cap off the five-minute grid", () => {
    open(undefined);

    setNumber("dayCapMinutes", "272");

    expect(screen.getByRole("status")).toHaveTextContent(/dayCapOffGrid\(5\)/);
    expect(save()).toBeDisabled();
  });

  it("reads 270 back as hours and minutes beside the field", () => {
    open(rule({ maxTeachingMinutesPerDay: 270 }));

    expect(screen.getByText("dayCapEqualsHoursMinutes(4|30)")).toBeInTheDocument();
  });

  it("reads a whole number of hours as hours alone", () => {
    open(rule({ maxTeachingMinutesPerDay: 300 }));

    expect(screen.getByText("dayCapEqualsHours(5)")).toBeInTheDocument();
  });

  it("reads a cap under an hour as minutes alone, never as nought hours", () => {
    open(rule({ maxTeachingMinutesPerDay: 45 }));

    expect(screen.getByText("dayCapEqualsMinutes(45)")).toBeInTheDocument();
    expect(screen.queryByText(/dayCapEqualsHours/)).toBeNull();
  });

  it("says nothing beside the field while the number would be refused", () => {
    open(undefined);

    setNumber("dayCapMinutes", "272");

    expect(screen.queryByText(/dayCapEquals/)).toBeNull();
  });
});

describe("the free-day wish", () => {
  const select = () => screen.getByLabelText("freeDay") as HTMLSelectElement;

  it("offers no wish first, then every weekday Monday to Sunday", () => {
    open(undefined);

    expect(select().value).toBe("");
    expect([...select().options].map((option) => [option.value, option.textContent])).toEqual([
      ["", "freeDayNone"],
      ["1", "1"],
      ["2", "2"],
      ["3", "3"],
      ["4", "4"],
      ["5", "5"],
      ["6", "6"],
      ["7", "7"],
    ]);
  });

  it("says where it is chosen that it is a wish, not a rule", () => {
    open(undefined);

    const group = screen.getByRole("group", { name: "freeDayTitle" });
    expect(group).toContainElement(select());
    expect(group).toHaveTextContent("freeDayHint");
  });

  it("sends a wish on its own as the weekday's number", async () => {
    const user = userEvent.setup();
    open(undefined);

    await user.selectOptions(select(), "5");
    await user.click(save());

    expect(saveMock).toHaveBeenCalledWith({
      userId: "t-1",
      lunchMinutes: null,
      lunchStartTime: null,
      lunchEndTime: null,
      minDailyRestMinutes: null,
      maxTeachingMinutesPerDay: null,
      preferredFreeDayOfWeek: 5,
    });
  });

  it("is taken away by choosing no wish, while the rest of the row is kept", async () => {
    const user = userEvent.setup();
    open(rule({ preferredFreeDayOfWeek: 5 }));

    await user.selectOptions(select(), "");
    await user.click(save());

    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ lunchMinutes: 30, minDailyRestMinutes: 660, preferredFreeDayOfWeek: null }),
    );
  });
});

describe("the rest field read back as hours", () => {
  it("shows 660 minutes as eleven hours", () => {
    open(rule());

    expect(screen.getByText(/restEqualsHours\(11\)/)).toBeInTheDocument();
  });

  it("shows a remainder as hours and minutes", () => {
    open(rule({ minDailyRestMinutes: 570 }));

    expect(screen.getByText(/restEqualsHoursMinutes\(9\|30\)/)).toBeInTheDocument();
  });

  it("says nothing while the number is out of range", () => {
    open(undefined);

    setNumber("restMinutes", "5");

    expect(screen.queryByText(/restEqualsHours/)).toBeNull();
  });
});

/*
 * The summary beside the form is its own module now, drawn on every staff row
 * while this dialog is fetched only when opened: its tests are in
 * teacher-work-time-summary.test.tsx.
 */
