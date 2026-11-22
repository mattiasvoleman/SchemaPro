import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScopeAssessmentView } from "@/lib/assignment-scope";
import { ScopeAssessmentCard } from "./scope-assessment-card";

const save = vi.hoisted(() => vi.fn());
const remove = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("@/lib/scope-assessment-queries", () => ({
  useScopeAssessmentActions: () => ({
    save: { mutateAsync: save, isPending: false },
    remove: { mutateAsync: remove, isPending: false },
  }),
}));
vi.mock("sonner", () => ({ toast }));
// The reader's own profile (Roller i skolan): undefined renders as a full administrator.
const me = vi.hoisted(() => ({ adminProfile: undefined as string | undefined }));
vi.mock("@/components/profile-context", () => ({
  useProfile: () => ({ profile: me.adminProfile === undefined ? {} : { adminProfile: me.adminProfile }, school: null }),
}));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

const teacher = { id: "t-anna", firstName: "Anna", lastName: "Ek" };
const stored: ScopeAssessmentView = {
  levelHours: 600,
  exceptionKind: "OWN_INITIATIVE",
  ownInitiativeOn: "2027-05-02",
  note: "på begäran",
  decidedAt: "2027-03-05T08:00:00.000Z",
};

const renderCard = (props: Partial<React.ComponentProps<typeof ScopeAssessmentCard>> = {}) =>
  render(<ScopeAssessmentCard teacher={teacher} academicYearId="y1" assessment={undefined} fullTimeHighestHours={650} {...props} />);

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe("ScopeAssessmentCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    me.adminProfile = undefined;
    save.mockResolvedValue(undefined);
    remove.mockResolvedValue(undefined);
  });

  it("says that no assessment means the ordinance's edge, and offers to add one", () => {
    renderCard();
    expect(screen.getByText("none")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "add" })).toBeInTheDocument();
  });

  it("summarises a stored assessment: the level, the exception with its day, the note and when it was set", () => {
    renderCard({ assessment: stored });
    expect(screen.getByText("summaryLevel(600)")).toBeInTheDocument();
    expect(screen.getByText(/summaryException\(exceptionOWN_INITIATIVE\)/)).toHaveTextContent("summaryInitiativeOn(2027-05-02)");
    expect(screen.getByText("summaryNote(på begäran)")).toBeInTheDocument();
    expect(screen.getByText("summaryDecided(2027-03-05)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "edit" })).toBeInTheDocument();
  });

  it("is shown to those who decide only: a schemaläggare reads the summary in the scope card above and sees no card", () => {
    me.adminProfile = "SCHEMALAGGARE";
    const { container } = renderCard({ assessment: stored });
    expect(container).toBeEmptyDOMElement();
  });

  it("writes the whole row for the teacher and the year, with the day only for the exception that has one", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "add" }));
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("problems.empty");
    fireEvent.change(field("level"), { target: { value: "580" } });
    expect(screen.getByRole("button", { name: "save" })).toBeEnabled();
    fireEvent.change(field("note"), { target: { value: "  två grupper om 30  " } });
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(save).toHaveBeenCalledWith({
      userId: "t-anna",
      academicYearId: "y1",
      teachingLevelHours: 580,
      exceptionKind: null,
      ownInitiativeOn: null,
      note: "två grupper om 30",
    });
    expect(toast.success).toHaveBeenCalledWith("saved");
  });

  it("asks for the day when the exception is the teacher's own initiative, and saves only once it is there", async () => {
    const user = userEvent.setup();
    renderCard({ assessment: { levelHours: null, exceptionKind: "OWN_INITIATIVE", ownInitiativeOn: "2027-05-02", note: null, decidedAt: null } });
    await user.click(screen.getByRole("button", { name: "edit" }));
    expect(field("day").value).toBe("2027-05-02");
    fireEvent.change(field("day"), { target: { value: "" } });
    expect(screen.getByRole("alert")).toHaveTextContent("problems.initiativeNeedsDay");
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
    fireEvent.change(field("day"), { target: { value: "2027-06-01" } });
    expect(screen.getByRole("button", { name: "save" })).toBeEnabled();
  });

  it("leaves the form as it was and says why when the gateway refuses", async () => {
    save.mockRejectedValue(new Error("Nivån kan inte vara över förordningens högsta nivå, 650 timmar vid heltid (SFS 2026:1487 3 §)."));
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "add" }));
    fireEvent.change(field("level"), { target: { value: "700" } });
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("650 timmar"));
    expect(screen.getByRole("button", { name: "save" })).toBeInTheDocument();
  });

  it("offers no removal where nothing is stored", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "add" }));
    expect(screen.queryByRole("button", { name: "remove" })).not.toBeInTheDocument();
  });

  it("asks before it removes the assessment, then removes it for the teacher and the year", async () => {
    const user = userEvent.setup();
    renderCard({ assessment: stored });
    await user.click(screen.getByRole("button", { name: "edit" }));
    await user.click(screen.getByRole("button", { name: "remove" }));
    expect(remove).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: /^removeTitle\(Anna Ek/ });
    await user.click(within(dialog).getByRole("button", { name: "remove" }));
    expect(remove).toHaveBeenCalledWith({ userId: "t-anna", academicYearId: "y1" });
    expect(toast.success).toHaveBeenCalledWith("removed");
  });

  it("names the span's edge at full time in the hint, or says it generally where it is not known", async () => {
    const user = userEvent.setup();
    renderCard({ fullTimeHighestHours: 600 });
    await user.click(screen.getByRole("button", { name: "add" }));
    expect(screen.getByText("levelHint(600)")).toBeInTheDocument();
  });

  it("says it generally where the edge is not known", async () => {
    const user = userEvent.setup();
    renderCard({ fullTimeHighestHours: null });
    await user.click(screen.getByRole("button", { name: "add" }));
    expect(screen.getByText("levelHintNoEdge")).toBeInTheDocument();
  });
});

