import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { uppdragLoad } from "@/lib/__fixtures__/staffing-fas3";
import { AdminUppdragsbeskrivning } from "./admin-uppdragsbeskrivning";

const state = vi.hoisted(() => ({
  teachers: [] as unknown[],
  dutyArgs: [] as unknown[][],
  historyArgs: [] as unknown[][],
  history: { isSuccess: true, isError: false, data: { entries: [] as unknown[], truncated: false } } as Record<string, unknown>,
}));

vi.mock("@/lib/queries", () => ({
  useAcademicYears: () => ({ data: [{ id: "y1", name: "2026/27" }], isLoading: false, isError: false }),
  usePeople: () => ({
    data: [
      { id: "t-anna", firstName: "Anna", lastName: "Ek" },
      { id: "t-bo", firstName: "Bo", lastName: "Alm" },
    ],
  }),
  useSubjects: () => ({ data: [] }),
  useGroups: () => ({ data: [] }),
}));
vi.mock("@/lib/staffing-queries", () => ({
  useStaffingLoad: () => ({
    data: { loadModel: "MINUTES", teachers: state.teachers },
    isLoading: false,
    isError: false,
  }),
  useTeacherDuties: (...args: unknown[]) => {
    state.dutyArgs.push(args);
    return { data: [], isLoading: false, isError: false };
  },
}));
vi.mock("@/lib/staffing-history-queries", () => ({
  useEmploymentHistory: (...args: unknown[]) => {
    state.historyArgs.push(args);
    return state.history;
  },
}));
vi.mock("@/components/profile-context", () => ({
  useProfile: () => ({ profile: { id: "u-admin" }, school: { name: "Norra skolan", timezone: "Europe/Stockholm" } }),
}));
// The back link is next-intl's Link, which needs the app's provider; a plain anchor here.
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    `${namespace}.${key}${values ? `(${Object.values(values).join("|")})` : ""}`,
}));

describe("the admin's uppdragsbeskrivning", () => {
  beforeEach(() => {
    state.dutyArgs = [];
    state.historyArgs = [];
    state.history = { isSuccess: true, isError: false, data: { entries: [], truncated: false } };
    state.teachers = [{ ...uppdragLoad, userId: "t-bo", employment: { ...uppdragLoad.employment!, userId: "t-bo", signature: "BOA" } }];
  });

  it("never falls back to another teacher's row when the asked one is missing (C18)", () => {
    render(<AdminUppdragsbeskrivning teacherId="t-anna" yearId="y1" />);
    expect(screen.getByText("uppdrag.noTeacher")).toBeInTheDocument();
    expect(screen.queryByText("BOA")).not.toBeInTheDocument();
    expect(screen.queryByText(/Bo Alm/)).not.toBeInTheDocument();
  });

  it("links back to the tjänstefördelning on the year the paper was opened for, in every state", () => {
    // No row for the asked teacher: the page's own header, with the link above its h1.
    render(<AdminUppdragsbeskrivning teacherId="t-anna" yearId="y1" />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("uppdrag.title");
    expect(screen.getByRole("link", { name: "uppdrag.backAdmin" })).toHaveAttribute("href", "/admin/staffing?year=y1");
  });

  it("says so without a teacher in the link, and reads nobody's uppdrag", () => {
    render(<AdminUppdragsbeskrivning teacherId={null} yearId="y1" />);
    expect(screen.getByText("uppdrag.noTeacher")).toBeInTheDocument();
    expect(state.dutyArgs.at(-1)).toEqual([null, null]);
  });

  it("prints the asked teacher's row, their uppdrag and their history's version", () => {
    state.teachers = [
      state.teachers[0],
      uppdragLoad,
    ];
    render(<AdminUppdragsbeskrivning teacherId="t-anna" yearId="y1" />);
    expect(screen.getByText("uppdrag.subtitle(Anna Ek|2026/27)")).toBeInTheDocument();
    expect(screen.getByText("ANN")).toBeInTheDocument();
    expect(screen.queryByText("BOA")).not.toBeInTheDocument();
    expect(state.dutyArgs.at(-1)).toEqual(["y1", "t-anna"]);
    expect(state.historyArgs.at(-1)).toEqual(["t-anna", "y1"]);
  });

  it("does not print \"no version\" when the history read failed (an old API in the deploy window)", () => {
    state.teachers = [uppdragLoad];
    state.history = { isSuccess: false, isError: true, data: undefined };
    render(<AdminUppdragsbeskrivning teacherId="t-anna" yearId="y1" />);
    expect(screen.getByText(/uppdrag\.stampUnreadable/)).toBeInTheDocument();
    expect(screen.queryByText(/uppdrag\.stampNoVersion/)).toBeNull();
  });
});
