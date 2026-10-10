import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GuardianPage from "./page";

/**
 * The guardian's start page and its "Undervisningstid" cards (timplan P4):
 * one card per child of the guardian's own, asked for by that child's id,
 * and none for any other role that opens the page. What a card says is
 * components/teaching-time-card.test.tsx's; which rows exist for the guardian
 * is RLS's (scripts/test/rls-policies.sql, section 26d).
 */

const state = vi.hoisted(() => ({
  role: "GUARDIAN",
  children: [] as { id: string; firstName: string; lastName: string; isActive: boolean }[],
}));

vi.mock("@/components/profile-context", () => ({
  useProfile: () => ({
    profile: {
      id: "g-1",
      authId: "a-1",
      schoolId: "s-1",
      role: state.role,
      firstName: "Gun",
      lastName: "Förälder",
      email: "gun@example.se",
      studentGroupId: null,
    },
    school: null,
  }),
}));
vi.mock("@/lib/guardian-queries", () => ({
  useMyChildren: () => ({ data: state.children, isLoading: false }),
  useAbsenceReports: () => ({ data: [] }),
  useLeaveRequests: () => ({ data: [] }),
  useAbsenceReportActions: () => ({ report: { isPending: false }, remove: { isPending: false } }),
  useLeaveRequestActions: () => ({ request: { isPending: false } }),
}));
vi.mock("@/components/teaching-time-card", () => ({
  TeachingTimeCard: ({ studentId, childName }: { studentId: string; childName?: string }) => (
    <p>teaching-time {studentId} {childName}</p>
  ),
}));
vi.mock("@/components/guardian/child-schedule", () => ({
  ChildSchedule: ({ childList }: { childList: { id: string; firstName: string }[] }) => (
    <p>child-schedule {childList.map((child) => child.id).join(",")}</p>
  ),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

beforeEach(() => {
  state.role = "GUARDIAN";
  state.children = [
    { id: "c-1", firstName: "Alva", lastName: "Elev", isActive: true },
    { id: "c-2", firstName: "Bo", lastName: "Elev", isActive: true },
  ];
});

describe("the guardian's Undervisningstid cards", () => {
  it("shows one card per child, each asked for by the child's own id", async () => {
    render(<GuardianPage />);
    expect(await screen.findByText("teaching-time c-1 Alva")).toBeInTheDocument();
    expect(screen.getByText("teaching-time c-2 Bo")).toBeInTheDocument();
  });

  it("asks for none when another role opens the page", async () => {
    state.role = "SCHOOL_ADMIN";
    render(<GuardianPage />);
    expect(await screen.findByText("guardian.reportTitle")).toBeInTheDocument();
    expect(screen.queryByText(/^teaching-time/)).not.toBeInTheDocument();
  });

  it("asks for none for a guardian without children, whose page says so", () => {
    state.children = [];
    render(<GuardianPage />);
    expect(screen.getByText("guardian.noChildrenTitle")).toBeInTheDocument();
    expect(screen.queryByText(/^teaching-time/)).not.toBeInTheDocument();
  });
});

/**
 * The "Schema" card (elev- och vårdnadshavarytan): one card for the
 * guardian's own children, lazily loaded, and none for any other role. What it
 * shows is components/guardian/child-schedule.test.tsx's.
 */
describe("the guardian's Schema card", () => {
  it("is given exactly the guardian's own children", async () => {
    render(<GuardianPage />);
    expect(await screen.findByText("child-schedule c-1,c-2")).toBeInTheDocument();
  });

  it("leaves out a child who has left, whose week the gateway never answers, and is not there when every child has", async () => {
    state.children = [
      { id: "c-1", firstName: "Alva", lastName: "Elev", isActive: false },
      { id: "c-2", firstName: "Bo", lastName: "Elev", isActive: true },
    ];
    const { unmount } = render(<GuardianPage />);
    expect(await screen.findByText("child-schedule c-2")).toBeInTheDocument();
    unmount();
    state.children = [{ id: "c-1", firstName: "Alva", lastName: "Elev", isActive: false }];
    render(<GuardianPage />);
    expect(await screen.findByText("guardian.reportTitle")).toBeInTheDocument();
    expect(screen.queryByText(/^child-schedule/)).not.toBeInTheDocument();
  });

  it("is not there for another role or for a guardian without children", async () => {
    state.role = "SCHOOL_ADMIN";
    const { unmount } = render(<GuardianPage />);
    expect(await screen.findByText("guardian.reportTitle")).toBeInTheDocument();
    expect(screen.queryByText(/^child-schedule/)).not.toBeInTheDocument();
    unmount();
    state.role = "GUARDIAN";
    state.children = [];
    render(<GuardianPage />);
    expect(screen.queryByText(/^child-schedule/)).not.toBeInTheDocument();
  });
});
