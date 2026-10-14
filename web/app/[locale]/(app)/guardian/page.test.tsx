import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GuardianChild } from "@/lib/guardian-queries";
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
  // The gateway's shape (GET /api/v1/family/children): no role, email or phone.
  children: [] as GuardianChild[],
  /** The guardian id each render asked useMyChildren for. */
  childrenAskedFor: [] as (string | null)[],
  reports: [] as Record<string, unknown>[],
  leaves: [] as Record<string, unknown>[],
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
// "Gallrat före": nothing gallrat in these rows.
vi.mock("@/lib/retention-queries", () => ({ usePurgedBefore: () => ({ of: () => null }) }));
vi.mock("@/lib/guardian-queries", () => ({
  useMyChildren: (guardianUserId: string | null) => {
    state.childrenAskedFor.push(guardianUserId);
    return { data: state.children, isLoading: false };
  },
  useAbsenceReports: () => ({ data: state.reports }),
  useLeaveRequests: () => ({ data: state.leaves }),
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
// The delete confirmation is a lazy chunk; here it never arrives.
vi.mock("@/components/ui/confirm-dialog", () => {
  throw new Error("Failed to fetch dynamically imported module: /_next/static/chunks/confirm-dialog.js");
});
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.reports = [];
  state.childrenAskedFor = [];
  state.leaves = [];
  state.role = "GUARDIAN";
  state.children = [
    { linkId: "l-1", id: "c-1", firstName: "Alva", lastName: "Elev", isActive: true, studentGroupId: "g-7a" },
    { linkId: "l-2", id: "c-2", firstName: "Bo", lastName: "Elev", isActive: true, studentGroupId: "g-7a" },
  ];
});

describe("the guardian's leave requests", () => {
  const leave = (id: string, status: string, decidedAs: string | null) => ({
    id,
    studentId: "c-1",
    requestedById: "g-1",
    startDate: "2026-10-19",
    endDate: "2026-10-21",
    reason: `Resa ${id}`,
    status,
    decidedById: null,
    decidedAt: null,
    decisionNote: null,
    decidedAs,
    createdAt: "2026-10-10T08:00:00.000Z",
  });

  it("says who decided: the mentor or rektor, and nothing while it waits or for an older decision", async () => {
    state.leaves = [
      leave("l-mentor", "APPROVED", "MENTOR"),
      leave("l-rektor", "REJECTED", "ADMIN"),
      leave("l-old", "APPROVED", null),
      leave("l-pending", "PENDING", null),
    ];
    render(<GuardianPage />);
    expect(await screen.findByText("Resa l-mentor")).toBeInTheDocument();
    expect(screen.getAllByText("guardian.decidedByMentor")).toHaveLength(1);
    expect(screen.getAllByText("guardian.decidedByRektor")).toHaveLength(1);
  });
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
 * The children come from the gateway (GET /api/v1/family/children), which
 * answers a guardian and refuses every other role. Another role that opens
 * the page must not ask, or it would read a refusal as a failed load.
 */
describe("the children read", () => {
  it("is asked as the signed-in guardian", () => {
    render(<GuardianPage />);
    expect(state.childrenAskedFor).not.toHaveLength(0);
    expect(state.childrenAskedFor.every((id) => id === "g-1")).toBe(true);
  });

  it("is not asked when another role opens the page", () => {
    state.role = "SCHOOL_ADMIN";
    render(<GuardianPage />);
    expect(state.childrenAskedFor).not.toHaveLength(0);
    expect(state.childrenAskedFor.every((id) => id === null)).toBe(true);
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
      { linkId: "l-1", id: "c-1", firstName: "Alva", lastName: "Elev", isActive: false, studentGroupId: "g-7a" },
      { linkId: "l-2", id: "c-2", firstName: "Bo", lastName: "Elev", isActive: true, studentGroupId: "g-7a" },
    ];
    const { unmount } = render(<GuardianPage />);
    expect(await screen.findByText("child-schedule c-2")).toBeInTheDocument();
    unmount();
    state.children = [
      { linkId: "l-1", id: "c-1", firstName: "Alva", lastName: "Elev", isActive: false, studentGroupId: "g-7a" },
    ];
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

describe("the guardian's delete confirmation", () => {
  it("says in the reader's language that it could not be opened when its chunk does not arrive", async () => {
    state.reports = [
      { id: "r-1", studentId: "c-1", reportedById: "g-1", date: "2099-03-02", startTime: null, endTime: null, type: "SICK", note: null, createdAt: "2099-03-01T08:00:00Z" },
    ];
    const user = userEvent.setup();
    render(<GuardianPage />);
    await user.click(screen.getByRole("button", { name: "guardian.deleteReportNamed" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("common.confirmLoadFailed"));
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringContaining("dynamically imported module"));
  });
});
