import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TeacherDuty } from "@/lib/types";
import { DutiesCard } from "./duties-card";

const create = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());
const remove = vi.hoisted(() => vi.fn());
const duties = vi.hoisted(() => ({ data: [] as unknown[], isLoading: false, isError: false }));
const asked = vi.hoisted(() => ({ year: null as unknown, user: null as unknown }));

vi.mock("@/lib/staffing-queries", () => ({
  useTeacherDuties: (year: unknown, user: unknown) => {
    asked.year = year;
    asked.user = user;
    return duties;
  },
  useTeacherDutyActions: () => ({
    create: { mutateAsync: create, isPending: false },
    update: { mutateAsync: update, isPending: false },
    remove: { mutateAsync: remove, isPending: false },
  }),
}));
// The year's bounds, for the date fields and the form's own check.
vi.mock("@/lib/queries", () => ({
  useAcademicYears: () => ({ data: [{ id: "y1", startDate: "2026-08-17", endDate: "2027-06-11" }] }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    `${namespace === "days" ? "day" : ""}${key}${values ? `(${Object.values(values).join("|")})` : ""}`,
}));

const teacher = { id: "t-anna", firstName: "Anna", lastName: "Ek" };
const mentor: TeacherDuty = {
  id: "d-mentor",
  userId: "t-anna",
  academicYearId: "y1",
  kind: "MENTORSKAP",
  label: "Mentor 7B",
  minutesPerWeek: 90,
  countsAsTeaching: false,
  subjectId: null,
  studentGroupId: "g-7b",
  validFrom: null,
  validTo: "2026-12-18",
  slots: [],
  note: null,
};
const apt: TeacherDuty = {
  ...mentor,
  id: "d-apt",
  kind: "APT_KONFERENS",
  label: "APT",
  minutesPerWeek: 120,
  countsAsTeaching: true,
  studentGroupId: null,
  validTo: null,
  slots: [{ dayOfWeek: 2, startTime: "15:00:00", endTime: "17:00:00" }],
  note: "Varannan tisdag",
};
const rastvakt: TeacherDuty = {
  ...mentor,
  id: "d-rast",
  kind: "RASTVAKT",
  label: "Rastvakt",
  minutesPerWeek: 60,
  studentGroupId: null,
  validFrom: "2027-01-07",
  validTo: null,
  slots: [
    { dayOfWeek: 1, startTime: "10:00:00", endTime: "10:20:00" },
    { dayOfWeek: 3, startTime: "10:00:00", endTime: "10:20:00" },
    { dayOfWeek: 5, startTime: "10:00:00", endTime: "10:20:00" },
  ],
};

const renderCard = () =>
  render(
    <DutiesCard
      teacher={teacher}
      academicYearId="y1"
      academicYearName="2026/2027"
      subjects={[{ id: "s-ma", name: "Matematik", code: "MA" }]}
      groups={[{ id: "g-7b", name: "7B" }]}
    />,
  );

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("DutiesCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    duties.data = [];
    duties.isLoading = false;
    duties.isError = false;
    create.mockResolvedValue(undefined);
    update.mockResolvedValue(undefined);
    remove.mockResolvedValue(undefined);
  });

  it("lists the uppdrag without add, edit or remove to a reader who does not write planering (Roller i skolan)", () => {
    duties.data = [mentor, apt];
    render(
      <DutiesCard
        teacher={teacher}
        academicYearId="y1"
        academicYearName="2026/2027"
        subjects={[{ id: "s-ma", name: "Matematik", code: "MA" }]}
        groups={[{ id: "g-7b", name: "7B" }]}
        readOnly
      />,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "addDuty" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^editDuty/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^removeDuty/ })).toBeNull();
  });

  it("marks add, edit and remove as planering's writes, which the läsare's style rule hides (Läsbehörighet)", () => {
    // The staffing drawer passes no readOnly: the marks are what spare a läsare the buttons there.
    duties.data = [mentor, apt];
    renderCard();
    expect(screen.getByRole("button", { name: "addDuty" })).toHaveAttribute("data-writes", "PLANERING");
    for (const button of [
      ...screen.getAllByRole("button", { name: /^editDuty/ }),
      ...screen.getAllByRole("button", { name: /^removeDuty/ }),
    ]) {
      expect(button.closest("[data-writes]")).toHaveAttribute("data-writes", "PLANERING");
    }
  });

  it("reads one teacher's uppdrag for the year, and says so when there are none", () => {
    renderCard();
    expect(asked).toEqual({ year: "y1", user: "t-anna" });
    expect(screen.getByText("noDuties")).toBeInTheDocument();
  });

  it("lists an uppdrag without a time and one with, naming the blocked time, the dates and what counts", () => {
    duties.data = [mentor, apt];
    renderCard();
    const mentorRow = screen.getByText("Mentor 7B").closest("li")!;
    expect(within(mentorRow).getByText("dutyKindMENTORSKAP")).toBeInTheDocument();
    expect(within(mentorRow).getByText("dutyMinutes(90) · 7B")).toBeInTheDocument();
    expect(within(mentorRow).queryByText(/dutyBlocks/)).toBeNull();
    // Until the jullov: the line says so; an undated uppdrag says nothing.
    expect(within(mentorRow).getByText("dutyRunsTo(2026-12-18)")).toBeInTheDocument();

    const aptRow = screen.getByText("APT").closest("li")!;
    expect(within(aptRow).getByText("dutyMinutesCounted(120)")).toBeInTheDocument();
    // The time is read back from the linked constraint, seconds cut.
    expect(within(aptRow).getByText("dutyBlocksList(dutySlotTime(day2|15:00|17:00))")).toBeInTheDocument();
    expect(within(aptRow).queryByText(/dutyRuns/)).toBeNull();
    expect(within(aptRow).getByText("Varannan tisdag")).toBeInTheDocument();
    expect(screen.getByText("dutiesTotal(210|2)")).toBeInTheDocument();
  });

  it("lists a rastvakt on Monday, Wednesday and Friday as one uppdrag with its three times, Monday first", () => {
    duties.data = [rastvakt];
    renderCard();
    const row = screen.getByText("Rastvakt").closest("li")!;
    expect(
      within(row).getByText(
        "dutyBlocksList(dutySlotTime(day1|10:00|10:20), dutySlotTime(day3|10:00|10:20), dutySlotTime(day5|10:00|10:20))",
      ),
    ).toBeInTheDocument();
    expect(within(row).getByText("dutyRunsFrom(2027-01-07)")).toBeInTheDocument();
    // Dated, with times: the generator holds them all läsår, and the row says so.
    expect(within(row).getByText("dutyTimesAllYear")).toBeInTheDocument();
  });

  it("marks the Rastvakt uppdrag as the ram where the teacher has passes, and totals the rest beside the passes", () => {
    duties.data = [mentor, rastvakt];
    // Passes in the spring: the ram still counts 30 min/v of the autumn's weeks.
    const passes = { userId: "t-anna", shiftCount: 2, minutesPerWeek: 50, countedMinutesPerWeek: 0, peakMinutesPerWeek: 50, hoursPerYear: 31.7, ramMinutesPerWeek: 60, ramCountedMinutesPerWeek: 30 };
    const { unmount } = render(
      <DutiesCard
        teacher={teacher}
        academicYearId="y1"
        academicYearName="2026/2027"
        subjects={[]}
        groups={[{ id: "g-7b", name: "7B" }]}
        supervision={passes}
      />,
    );
    const row = screen.getByText("Rastvakt").closest("li")!;
    expect(within(row).getByText("dutyRamBadge")).toBeInTheDocument();
    expect(within(row).getByText("dutyRamHint")).toBeInTheDocument();
    // 90 of mentorskap; the Rastvakt uppdrag's 60 are the ram, of which 30 still count, the passes' 50 on their own.
    expect(screen.getByText("dutiesTotalBesideSupervision(90|1|30|2|50)")).toBeInTheDocument();
    unmount();
    // Where the card does not know the passes (the people page), every minute
    // counts as typed, and the Rastvakt uppdrag still says what passes would do.
    renderCard();
    expect(screen.queryByText("dutyRamBadge")).toBeNull();
    expect(screen.getByText("dutyRamHint")).toBeInTheDocument();
    expect(screen.getByText("dutiesTotal(150|2)")).toBeInTheDocument();
  });

  it("says the generator holds the times all läsår only for an uppdrag both dated and timed", () => {
    duties.data = [
      mentor,
      apt,
      { ...apt, id: "d-whole", label: "APT hela året", validFrom: "2026-08-17", validTo: "2027-06-11" },
    ];
    renderCard();
    // Dated without a time, undated with one, and dated on the läsår's own bounds.
    expect(screen.queryByText("dutyTimesAllYear")).toBeNull();
  });

  it("tells the form, once it has dates and a time, that the generator holds the time all läsår", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "addDuty" }));
    await user.click(screen.getByRole("switch", { name: "dutyBlockTime" }));
    expect(screen.queryByText("dutyTimesAllYearNotice")).toBeNull();
    type("dutyValidFrom (optional)", "2027-01-07");
    expect(screen.getByText("dutyTimesAllYearNotice")).toBeInTheDocument();
    // The time switched off: nothing is held.
    await user.click(screen.getByRole("switch", { name: "dutyBlockTime" }));
    expect(screen.queryByText("dutyTimesAllYearNotice")).toBeNull();
  });

  it("adds an uppdrag with a blocked time, sending the times and never a constraint id", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "addDuty" }));
    type("dutyLabel", "APT");
    type("dutyMinutesLabel", "120");
    await user.click(screen.getByRole("switch", { name: "dutyBlockTime" }));
    await user.click(screen.getByRole("combobox", { name: "dutyDay" }));
    await user.click(screen.getByRole("option", { name: "day2" }));
    type("dutyStart", "15:00");
    type("dutyEnd", "17:00");
    await user.click(screen.getByRole("button", { name: "save" }));

    expect(create).toHaveBeenCalledWith({
      userId: "t-anna",
      academicYearId: "y1",
      kind: "MENTORSKAP",
      label: "APT",
      minutesPerWeek: 120,
      countsAsTeaching: false,
      subjectId: null,
      studentGroupId: null,
      validFrom: null,
      validTo: null,
      slots: [{ dayOfWeek: 2, startTime: "15:00", endTime: "17:00" }],
      note: null,
    });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("blockedConstraintId");
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("blockedSlot");
  });

  it("adds a second time on the next weekday at the same clock, and a mentorskap until the jullov", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "addDuty" }));
    type("dutyLabel", "Mentor 7B");
    type("dutyMinutesLabel", "90");
    fireEvent.change(screen.getByLabelText(/dutyValidTo/), { target: { value: "2026-12-18" } });
    await user.click(screen.getByRole("switch", { name: "dutyBlockTime" }));
    type("dutyStart", "08:00");
    type("dutyEnd", "08:30");
    await user.click(screen.getByRole("button", { name: "dutyAddSlot" }));
    // The removal of a row is offered once there are two.
    expect(screen.getByRole("button", { name: "dutyRemoveSlot(2)" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        validFrom: null,
        validTo: "2026-12-18",
        slots: [
          { dayOfWeek: 1, startTime: "08:00", endTime: "08:30" },
          { dayOfWeek: 2, startTime: "08:00", endTime: "08:30" },
        ],
      }),
    );
  });

  it("refuses a Till outside the läsår before anything is sent", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "addDuty" }));
    type("dutyLabel", "Mentor 7B");
    type("dutyMinutesLabel", "90");
    fireEvent.change(screen.getByLabelText(/dutyValidTo/), { target: { value: "2027-06-30" } });
    expect(screen.getByRole("alert")).toHaveTextContent("problem_dutyDateOutsideYear(2027-06-30|2026-08-17|2027-06-11)");
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
    expect((screen.getByLabelText(/dutyValidTo/) as HTMLInputElement).max).toBe("2027-06-11");
  });

  it("says nothing is wrong with a form nobody has typed in yet, and keeps Save off until it is whole", async () => {
    // Opening "Lägg till uppdrag" used to announce a role="alert" for the
    // empty label at once, and the minutes error as soon as the label was typed.
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "addDuty" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();

    type("dutyLabel", "Mentor 7B");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();

    type("dutyMinutesLabel", "0");
    expect(screen.getByRole("alert")).toHaveTextContent("problem_dutyMinutesOutOfRange");
    type("dutyMinutesLabel", "90");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "save" })).toBeEnabled();
  });

  it("refuses a slot off the five-minute grid before anything is sent", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "addDuty" }));
    type("dutyLabel", "Rastvakt");
    type("dutyMinutesLabel", "30");
    await user.click(screen.getByRole("switch", { name: "dutyBlockTime" }));
    type("dutyStart", "10:02");
    type("dutyEnd", "10:30");
    expect(screen.getByRole("alert")).toHaveTextContent("problem_slotOffGrid(1|10:02|5)");
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
  });

  it("edits an uppdrag and, with the times switched off, sends none so the constraints go", async () => {
    const user = userEvent.setup();
    duties.data = [apt];
    renderCard();
    await user.click(screen.getByRole("button", { name: "editDuty(APT)" }));
    expect((screen.getByLabelText("dutyStart") as HTMLInputElement).value).toBe("15:00");
    await user.click(screen.getByRole("switch", { name: "dutyBlockTime" }));
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ id: "d-apt", label: "APT", countsAsTeaching: true, slots: [] }),
    );
  });

  it("asks before removing, and says the blocked time is freed too", async () => {
    const user = userEvent.setup();
    duties.data = [apt];
    renderCard();
    await user.click(screen.getByRole("button", { name: "removeDuty(APT)" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("removeDutyBodySlot")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "delete" }));
    expect(remove).toHaveBeenCalledWith("d-apt");
  });
});
