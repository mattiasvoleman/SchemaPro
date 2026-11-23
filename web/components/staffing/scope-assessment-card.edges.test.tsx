import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScopeAssessmentCard } from "./scope-assessment-card";

const save = vi.hoisted(() => vi.fn());
const remove = vi.hoisted(() => vi.fn());
const pending = vi.hoisted(() => ({ save: false }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/scope-assessment-queries", () => ({
  useScopeAssessmentActions: () => ({
    save: { mutateAsync: save, get isPending() { return pending.save; } },
    remove: { mutateAsync: remove, isPending: false },
  }),
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/components/profile-context", () => ({ useProfile: () => ({ profile: {}, school: null }) }));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key}(${Object.values(values).join("|")})` : key),
}));

const teacher = { id: "t-anna", firstName: "Anna", lastName: "Ek" };
const stored = { levelHours: 600, exceptionKind: null, ownInitiativeOn: null, note: null, decidedAt: "2027-03-05T08:00:00.000Z" };

/*
 * What the card's other tests leave to chance: the form's own attributes (the browser's last line before the gateway's), what the form does
 * once the write has gone through, a removal that is refused, and a save pressed twice while the first is on its way.
 */
describe("ScopeAssessmentCard: the edges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pending.save = false;
    save.mockResolvedValue(undefined);
    remove.mockResolvedValue(undefined);
  });

  it("holds the fields to the gateway's bounds in the browser too: whole hours 1..1500, a note of at most 500 characters", async () => {
    const user = userEvent.setup();
    render(<ScopeAssessmentCard teacher={teacher} academicYearId="y1" assessment={undefined} fullTimeHighestHours={650} />);
    await user.click(screen.getByRole("button", { name: "add" }));
    const level = screen.getByLabelText("level");
    expect(level).toHaveAttribute("min", "1");
    expect(level).toHaveAttribute("max", "1500");
    expect(level).toHaveAttribute("step", "1");
    expect(screen.getByLabelText("note")).toHaveAttribute("maxlength", "500");
  });

  it("draws the day only for the exception on the teacher's own initiative", async () => {
    const user = userEvent.setup();
    render(<ScopeAssessmentCard teacher={teacher} academicYearId="y1" assessment={stored} fullTimeHighestHours={650} />);
    await user.click(screen.getByRole("button", { name: "edit" }));
    expect(screen.queryByLabelText("day")).not.toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "exceptionLabel" }));
    await user.click(screen.getByRole("option", { name: "exceptionOptionSMALL_GROUP" }));
    expect(screen.queryByLabelText("day")).not.toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "exceptionLabel" }));
    await user.click(screen.getByRole("option", { name: "exceptionOptionOWN_INITIATIVE" }));
    expect(screen.getByLabelText("day")).toBeInTheDocument();
  });

  it("closes the form after a save and shows the summary and the edit button again", async () => {
    const user = userEvent.setup();
    render(<ScopeAssessmentCard teacher={teacher} academicYearId="y1" assessment={stored} fullTimeHighestHours={650} />);
    await user.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.change(screen.getByLabelText("level"), { target: { value: "580" } });
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(screen.queryByRole("button", { name: "save" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "edit" })).toBeInTheDocument();
  });

  it("says that there is no level of its own where an exception is all the assessment holds", () => {
    render(
      <ScopeAssessmentCard
        teacher={teacher}
        academicYearId="y1"
        assessment={{ levelHours: null, exceptionKind: "SMALL_GROUP", ownInitiativeOn: null, note: null, decidedAt: null }}
        fullTimeHighestHours={650}
      />,
    );
    expect(screen.getByText("summaryNoLevel")).toBeInTheDocument();
    expect(screen.queryByText(/summaryLevel/)).not.toBeInTheDocument();
  });

  it("keeps the form and says why when a removal is refused, with the gateway's own sentence", async () => {
    remove.mockRejectedValue(new Error("The requested resource does not exist."));
    const user = userEvent.setup();
    render(<ScopeAssessmentCard teacher={teacher} academicYearId="y1" assessment={stored} fullTimeHighestHours={650} />);
    await user.click(screen.getByRole("button", { name: "edit" }));
    await user.click(screen.getByRole("button", { name: "remove" }));
    const dialog = screen.getByRole("dialog", { name: /^removeTitle\(Anna Ek/ });
    await user.click(within(dialog).getByRole("button", { name: "remove" }));
    expect(toast.error).toHaveBeenCalledWith("The requested resource does not exist.");
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "save" })).toBeInTheDocument();
  });

  it("sends nothing from a form that has a problem, however it is submitted", async () => {
    const user = userEvent.setup();
    render(<ScopeAssessmentCard teacher={teacher} academicYearId="y1" assessment={undefined} fullTimeHighestHours={650} />);
    await user.click(screen.getByRole("button", { name: "add" }));
    expect(screen.getByRole("alert")).toHaveTextContent("problems.empty");
    fireEvent.submit(screen.getByRole("button", { name: "save" }).closest("form")!);
    expect(save).not.toHaveBeenCalled();
  });

  it("cannot be saved a second time while the first save is on its way", async () => {
    pending.save = true;
    const user = userEvent.setup();
    render(<ScopeAssessmentCard teacher={teacher} academicYearId="y1" assessment={stored} fullTimeHighestHours={650} />);
    await user.click(screen.getByRole("button", { name: "edit" }));
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
  });
});
