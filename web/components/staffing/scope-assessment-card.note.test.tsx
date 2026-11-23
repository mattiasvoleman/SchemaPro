import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ScopeAssessmentCard } from "./scope-assessment-card";

vi.mock("@/lib/scope-assessment-queries", () => ({
  useScopeAssessmentActions: () => ({
    save: { mutateAsync: vi.fn(), isPending: false },
    remove: { mutateAsync: vi.fn(), isPending: false },
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/profile-context", () => ({ useProfile: () => ({ profile: {}, school: null }) }));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key}(${Object.values(values).join("|")})` : key),
}));

const teacher = { id: "t-anna", firstName: "Anna", lastName: "Ek" };

describe("ScopeAssessmentCard: the note", () => {
  it("tells the one who writes the note that the teacher reads it, beside the field", async () => {
    const user = userEvent.setup();
    render(<ScopeAssessmentCard teacher={teacher} academicYearId="y1" assessment={undefined} fullTimeHighestHours={650} />);
    await user.click(screen.getByRole("button", { name: "add" }));
    expect(screen.getByText("noteTeacherSees")).toBeInTheDocument();
    expect(screen.getByLabelText("note")).toBeInTheDocument();
  });
});
