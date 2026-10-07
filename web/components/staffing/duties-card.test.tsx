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
  blockedConstraintId: null,
  blockedSlot: null,
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
  blockedConstraintId: "c-apt",
  blockedSlot: { dayOfWeek: 2, startTime: "15:00:00", endTime: "17:00:00" },
  note: "Varannan tisdag",
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

  it("reads one teacher's uppdrag for the year, and says so when there are none", () => {
    renderCard();
    expect(asked).toEqual({ year: "y1", user: "t-anna" });
    expect(screen.getByText("noDuties")).toBeInTheDocument();
  });

  it("lists an uppdrag without a slot and one with, naming the blocked time and what counts", () => {
    duties.data = [mentor, apt];
    renderCard();
    const mentorRow = screen.getByText("Mentor 7B").closest("li")!;
    expect(within(mentorRow).getByText("dutyKindMENTORSKAP")).toBeInTheDocument();
    expect(within(mentorRow).getByText("dutyMinutes(90) · 7B")).toBeInTheDocument();
    expect(within(mentorRow).queryByText(/dutyBlocks/)).toBeNull();

    const aptRow = screen.getByText("APT").closest("li")!;
    expect(within(aptRow).getByText("dutyMinutesCounted(120)")).toBeInTheDocument();
    // The slot is read back from the linked constraint, seconds cut.
    expect(within(aptRow).getByText("dutyBlocks(day2|15:00|17:00)")).toBeInTheDocument();
    expect(within(aptRow).getByText("Varannan tisdag")).toBeInTheDocument();
    expect(screen.getByText("dutiesTotal(210|2)")).toBeInTheDocument();
  });

  it("adds an uppdrag with a blocked slot, sending the slot and never a constraint id", async () => {
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
      blockedSlot: { dayOfWeek: 2, startTime: "15:00", endTime: "17:00" },
      note: null,
    });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("blockedConstraintId");
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
    expect(screen.getByRole("alert")).toHaveTextContent("problem_slotOffGrid(10:02|5)");
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
  });

  it("edits an uppdrag and, with the slot switched off, sends null so the constraint goes", async () => {
    const user = userEvent.setup();
    duties.data = [apt];
    renderCard();
    await user.click(screen.getByRole("button", { name: "editDuty(APT)" }));
    expect((screen.getByLabelText("dutyStart") as HTMLInputElement).value).toBe("15:00");
    await user.click(screen.getByRole("switch", { name: "dutyBlockTime" }));
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ id: "d-apt", label: "APT", countsAsTeaching: true, blockedSlot: null }),
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
