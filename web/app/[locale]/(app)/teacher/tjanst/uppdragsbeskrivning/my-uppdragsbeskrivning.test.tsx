import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { uppdragLoad } from "@/lib/__fixtures__/staffing-fas3";
import { MyUppdragsbeskrivning } from "./my-uppdragsbeskrivning";

const state = vi.hoisted(() => ({
  teachers: [] as unknown[],
  loadArgs: [] as unknown[],
  dutyArgs: [] as unknown[][],
  historyArgs: [] as unknown[][],
}));

vi.mock("@/lib/queries", () => ({
  useActiveYear: () => ({
    data: [
      { id: "y0", name: "2025/26" },
      { id: "y1", name: "2026/27", isActive: true },
    ],
    activeYear: { id: "y1", name: "2026/27", isActive: true },
    isLoading: false,
    isError: false,
  }),
  useSubjects: () => ({ data: [] }),
  useGroups: () => ({ data: [] }),
}));
vi.mock("@/lib/staffing-queries", () => ({
  useStaffingLoad: (yearId: unknown) => {
    state.loadArgs.push(yearId);
    return { data: { loadModel: "MINUTES", teachers: state.teachers }, isLoading: false, isError: false };
  },
  useTeacherDuties: (...args: unknown[]) => {
    state.dutyArgs.push(args);
    return { data: [], isLoading: false, isError: false };
  },
}));
vi.mock("@/lib/staffing-history-queries", () => ({
  useEmploymentHistory: (...args: unknown[]) => {
    state.historyArgs.push(args);
    // A read still in flight.
    return { data: undefined, isSuccess: false, isError: false };
  },
}));
vi.mock("@/components/profile-context", () => ({
  useProfile: () => ({
    profile: { id: "t-anna", firstName: "Anna", lastName: "Ek", role: "TEACHER" },
    school: { name: "Norra skolan", timezone: "Europe/Stockholm" },
  }),
}));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    `${namespace}.${key}${values ? `(${Object.values(values).join("|")})` : ""}`,
}));

describe("the teacher's own uppdragsbeskrivning", () => {
  beforeEach(() => {
    state.loadArgs = [];
    state.dutyArgs = [];
    state.historyArgs = [];
    state.teachers = [uppdragLoad];
  });

  it("prints the session's own row, uppdrag and history, for the asked year", () => {
    render(<MyUppdragsbeskrivning yearId="y0" />);
    expect(state.loadArgs.at(-1)).toBe("y0");
    expect(state.dutyArgs.at(-1)).toEqual(["y0", "t-anna"]);
    expect(state.historyArgs.at(-1)).toEqual(["t-anna", "y0"]);
    expect(screen.getByText("uppdrag.subtitle(Anna Ek|2025/26)")).toBeInTheDocument();
    // The history has not answered: the paper does not claim there is no version.
    expect(screen.getByText(/uppdrag\.stampLoading/)).toBeInTheDocument();
    expect(screen.queryByText(/uppdrag\.stampNoVersion/)).toBeNull();
  });

  it("falls back on the active year for an unknown one, never on a person", () => {
    render(<MyUppdragsbeskrivning yearId="y-unknown" />);
    expect(state.loadArgs.at(-1)).toBe("y1");
  });

  it("says there is no post rather than printing an admin-who-teaches's colleague", () => {
    // An admin who teaches gets the whole school's report: only their own row prints.
    state.teachers = [{ ...uppdragLoad, userId: "t-bo" }];
    render(<MyUppdragsbeskrivning yearId={null} />);
    expect(screen.getByText("uppdrag.noOwnPost")).toBeInTheDocument();
    expect(screen.queryByText("ANN")).not.toBeInTheDocument();
  });
});
