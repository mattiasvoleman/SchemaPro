import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { TeacherWorkRule } from "@/lib/types";
import {
  TeacherWorkTimeDialog,
  TeacherWorkTimeSummary,
} from "./teacher-work-time-dialog";

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
 *   to name all four keys or the old rule survives the clearing, and the school
 *   finds out at the next generation run.
 *
 *   A REFUSAL the reader never sees. The gateway rejects a half-filled lunch
 *   trio in English prose written for a log; the form has to name the missing
 *   half in Swedish and refuse to send.
 */

const saveMock = vi.fn();
const removeMock = vi.fn();

vi.mock("@/lib/queries", () => ({
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
  ...overrides,
});

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
    });
  });

  it("sends the same upsert for a teacher who had no row", async () => {
    // One request for both cases: at most one row per teacher, so there is no
    // create to tell apart from an update here.
    const user = userEvent.setup();
    open(undefined);

    await user.click(screen.getByRole("button", { name: "useSuggestion" }));
    await user.click(save());

    expect(saveMock).toHaveBeenCalledWith({
      userId: "t-1",
      lunchMinutes: 30,
      lunchStartTime: "10:30",
      lunchEndTime: "13:30",
      minDailyRestMinutes: 660,
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
  it("deletes the row instead of storing four nulls", async () => {
    /*
     * A row of four nulls is legal and would read back as "no rule", so this
     * could have been a PUT of nothing. It is a DELETE because the school's own
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

describe("the summary beside the form", () => {
  it("spells out that a teacher has no rule", () => {
    render(<TeacherWorkTimeSummary rule={undefined} />);

    expect(screen.getByText("noRule")).toBeInTheDocument();
  });

  it("spells it out for a row of four nulls too", () => {
    render(
      <TeacherWorkTimeSummary
        rule={rule({
          lunchMinutes: null,
          lunchStartTime: null,
          lunchEndTime: null,
          minDailyRestMinutes: null,
        })}
      />,
    );

    expect(screen.getByText("noRule")).toBeInTheDocument();
  });

  it("reads a full rule back without the seconds", () => {
    render(<TeacherWorkTimeSummary rule={rule()} />);

    expect(screen.getByText("summaryLunch(30|10:30|13:30)")).toBeInTheDocument();
    expect(screen.getByText("summaryRestHours(11)")).toBeInTheDocument();
  });

  it("names only the half a rest-only rule sets", () => {
    render(
      <TeacherWorkTimeSummary
        rule={rule({ lunchMinutes: null, lunchStartTime: null, lunchEndTime: null })}
      />,
    );

    expect(screen.queryByText(/summaryLunch/)).toBeNull();
    expect(screen.getByText("summaryRestHours(11)")).toBeInTheDocument();
  });
});
