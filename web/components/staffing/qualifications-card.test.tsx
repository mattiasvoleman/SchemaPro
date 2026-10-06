import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Subject, TeacherQualification } from "@/lib/types";
import { QualificationsCard } from "./qualifications-card";

globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const replace = vi.hoisted(() => vi.fn());

vi.mock("@/lib/staffing-queries", () => ({
  useReplaceTeacherQualifications: () => ({ mutateAsync: replace, isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

const teacher = { id: "t-anna", firstName: "Anna", lastName: "Ek" };
const subjects: Subject[] = [
  { id: "s-ma", name: "Matematik", code: "MA", color: null, requiredRoomTypeId: null },
  { id: "s-no", name: "NO", code: "NO", color: null, requiredRoomTypeId: null },
];
const stored: TeacherQualification[] = [
  {
    id: "q1",
    userId: "t-anna",
    subjectId: "s-ma",
    minGradeLevel: 7,
    maxGradeLevel: 9,
    kind: "LEGITIMATION",
    validFrom: null,
    validTo: null,
    note: null,
  },
  {
    id: "q2",
    userId: "t-anna",
    subjectId: "s-no",
    minGradeLevel: 4,
    maxGradeLevel: 4,
    kind: "TILLATEN",
    validFrom: null,
    validTo: "2026-06-30",
    note: null,
  },
];

const renderCard = (qualifications: TeacherQualification[] | undefined = stored) =>
  render(
    <QualificationsCard
      teacher={teacher}
      qualifications={qualifications}
      subjects={subjects}
      today="2026-10-06"
    />,
  );

describe("QualificationsCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    replace.mockResolvedValue([]);
  });

  it("shows each subject as a chip with its span, kind and an expiry warning", () => {
    renderCard();
    expect(screen.getByText("Matematik")).toBeInTheDocument();
    expect(screen.getByText("spanLabel(7|9)")).toBeInTheDocument();
    expect(screen.getByText("kindLEGITIMATION")).toBeInTheDocument();
    expect(screen.getByText("spanSingle(4)")).toBeInTheDocument();
    expect(screen.getByText("kindTILLATEN")).toBeInTheDocument();
    expect(screen.getByText("expired(2026-06-30)")).toBeInTheDocument();
  });

  it("says the fallback out loud when nothing is recorded", () => {
    renderCard([]);
    expect(screen.getByText("noQualifications")).toBeInTheDocument();
  });

  it("refuses two rows for one subject, naming both, and keeps the save disabled", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "editQualifications" }));
    await user.click(screen.getByRole("button", { name: "addQualification" }));
    // The new row has no subject yet.
    expect(screen.getByRole("alert")).toHaveTextContent("problem_subjectRequired(3)");
    await user.click(screen.getByRole("combobox", { name: "qualificationSubject 3" }));
    await user.click(screen.getByRole("option", { name: "Matematik" }));
    expect(screen.getByRole("alert")).toHaveTextContent("problem_duplicateSubject(3|1)");
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
  });

  it("keeps the span ordered as the admin picks", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "editQualifications" }));
    // Row 1 is 7–9; picking a lower bound of 10 drags the upper bound along,
    // so a reversed span never reaches the validator from this form.
    await user.click(screen.getByRole("combobox", { name: "qualificationSpanFrom 1" }));
    await user.click(screen.getByRole("option", { name: "grade(10)" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(replace.mock.calls[0]?.[0].items[0]).toMatchObject({
      subjectId: "s-ma",
      minGradeLevel: 10,
      maxGradeLevel: 10,
    });
  });

  it("replaces the whole list, blanks as null", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "editQualifications" }));
    await user.click(screen.getByRole("button", { name: "removeQualification(2)" }));
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(replace).toHaveBeenCalledWith({
      userId: "t-anna",
      items: [
        {
          subjectId: "s-ma",
          minGradeLevel: 7,
          maxGradeLevel: 9,
          kind: "LEGITIMATION",
          validFrom: null,
          validTo: null,
          note: null,
        },
      ],
    });
  });
});
