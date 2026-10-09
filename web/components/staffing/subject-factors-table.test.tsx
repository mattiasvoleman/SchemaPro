import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SubjectFactorsTable } from "./subject-factors-table";

const patch = vi.hoisted(() => vi.fn());
const invalidate = vi.hoisted(() => vi.fn());
const subjects = vi.hoisted(() => ({
  data: [] as unknown[],
  isLoading: false,
  isError: false,
}));

vi.mock("@/lib/api", () => ({ api: { patch } }));
vi.mock("@/lib/queries", () => ({ useSubjects: () => subjects }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: invalidate }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

describe("SubjectFactorsTable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    patch.mockResolvedValue({});
    subjects.data = [
      { id: "s-ma", name: "Matematik", loadFactor: 1 },
      { id: "s-sl", name: "Slöjd", loadFactor: 0.8 },
    ];
  });

  it("shows every subject's stored factor with a decimal comma", () => {
    render(<SubjectFactorsTable />);
    expect(screen.getByLabelText("factorFor(Matematik)")).toHaveValue("1");
    expect(screen.getByLabelText("factorFor(Slöjd)")).toHaveValue("0,8");
    expect(screen.getByRole("button", { name: "save(0)" })).toBeDisabled();
  });

  it("PATCHes only the changed subject, with loadFactor alone, and refreshes the load", async () => {
    const user = userEvent.setup();
    render(<SubjectFactorsTable />);
    fireEvent.change(screen.getByLabelText("factorFor(Matematik)"), { target: { value: "1,2" } });
    await user.click(screen.getByRole("button", { name: "save(1)" }));
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith("/api/v1/subjects/s-ma", { loadFactor: 1.2 });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["subjects"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["staffingLoad"] });
  });

  it("refuses a factor outside 0,5..3 before anything is sent", () => {
    render(<SubjectFactorsTable />);
    fireEvent.change(screen.getByLabelText("factorFor(Slöjd)"), { target: { value: "3,5" } });
    expect(screen.getByRole("alert")).toHaveTextContent("invalid");
    expect(screen.getByLabelText("factorFor(Slöjd)")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: /^save/ })).toBeDisabled();
    expect(patch).not.toHaveBeenCalled();
  });
});
