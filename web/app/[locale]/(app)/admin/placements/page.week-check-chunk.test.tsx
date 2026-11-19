import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlacementBoard } from "@/lib/placement-board";
import PlacementsPage from "./page";

/**
 * Kontrollera veckan on Förlägg i veckan when the chunk that draws the answer does not come (a dropped connection, a tab
 * left open across a deploy). Its own file: a lazy component that has once arrived stays arrived for the file, so a chunk that
 * does not come can only be tested before any test of this file has drawn the panel. The scaffolding is page.week-check.test.tsx's.
 */

const state = vi.hoisted(() => ({ board: undefined as unknown }));
const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));
// The module that draws the answer is the lazy import's, and it does not arrive.
vi.mock("@/components/schedule/week-check", () => {
  throw new Error("Failed to fetch dynamically imported module: /_next/static/chunks/week-check.js");
});
vi.mock("@/lib/planning-year", () => ({
  usePlanningYear: () => ({
    year: { id: "y1", name: "2026/27", startDate: "2026-08-15", endDate: "2027-06-11", isActive: true },
    active: { id: "y1" },
    successor: null,
    choose: vi.fn(),
    rosters: null,
    rostersFailed: false,
  }),
}));
vi.mock("@/components/profile-context", () => ({
  useProfile: () => ({ profile: { adminProfile: "SCHEMALAGGARE" } }),
  useReadOnly: () => false,
}));
vi.mock("@/lib/queries", () => ({
  useGroups: () => ({ data: [{ id: "g-7a", academicYearId: "y1", name: "7A", kind: "CLASS", gradeLevel: 7 }], isLoading: false }),
  useSubjects: () => ({ data: [{ id: "s-ma", name: "Matematik", color: "#2563eb" }], isLoading: false }),
  useRooms: () => ({ data: [{ id: "r-a12", name: "A12" }], isLoading: false }),
  usePeople: () => ({ data: [{ id: "anna", role: "TEACHER", firstName: "Anna", lastName: "Ek", isActive: true }], isLoading: false }),
  useConstraints: () => ({ data: [] }),
  useFrameTimes: () => ({ data: [] }),
  useGroupMemberships: () => ({ data: [] }),
  useRoomPreferences: () => ({ data: [] }),
  useOptimizationHistory: () => ({ data: [] }),
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
}));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () =>
    Object.assign(
      (key: string, values?: Record<string, unknown>) => (values ? `${key}(${Object.values(values).join("|")})` : key),
      { has: () => true },
    ),
}));

const board = (): PlacementBoard => ({
  academicYearId: "y1",
  timetable: { placedLessons: 1, writtenAt: "2026-11-16T09:00:00.000Z" },
  blocks: [],
  posts: [
    {
      id: "post-ma",
      studentGroupId: "g-7a",
      subjectId: "s-ma",
      teacherId: "anna",
      coTeacherId: null,
      recurrence: "ALL_WEEKS",
      startDate: null,
      endDate: null,
      cannotPlace: null,
      parts: [{ teacherId: "anna", minutes: 60, count: 3, locked: 0, placed: 1, left: 2, cannotPlace: null }],
      rowsKey: "k000000000000001",
    },
  ],
  placements: [
    {
      id: "row-1",
      requirementId: "post-ma",
      dayOfWeek: 2,
      startTime: "10:00",
      endTime: "11:00",
      minutes: 60,
      roomId: "r-a12",
      roomName: "A12",
      recurrence: "ALL_WEEKS",
      teacherId: null,
      changedAt: "2026-11-16T08:00:00.000Z",
      verdict: { ok: true },
    },
  ],
  kept: [],
  meals: [],
});

beforeEach(() => {
  state.board = board();
  api.get.mockReset().mockImplementation(async () => structuredClone(state.board));
  api.put.mockReset();
  api.post.mockReset().mockResolvedValue({ verdict: "OK", years: [], conflicts: null, skipped: ["LUNCH_STAGE"], elapsedMs: 4, checkedBy: "ENGINE" });
  // React reports the error a boundary catches; the test asserts on what the school sees.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  window.history.replaceState(null, "", "/sv/admin/placements");
  vi.restoreAllMocks();
});

describe("when the chunk that draws the answer does not come", () => {
  it("says in words that the page's tools could not be fetched, leaves the page and the button standing, and draws no answer", async () => {
    window.history.replaceState(null, "", "/sv/admin/placements");
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <PlacementsPage />
      </QueryClientProvider>,
    );
    await screen.findByTestId("placement-summary");

    await userEvent.setup().click(screen.getByRole("button", { name: /^(button|checking)$/ }));

    // The check itself went through, and what draws it is not there: a press that leaves nothing to read says why.
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(await screen.findByTestId("placement-message")).toHaveTextContent("toolsFailed");
    expect(screen.queryByRole("region", { name: "title" })).toBeNull();
    expect(screen.getByTestId("placement-summary")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "button" })).toBeEnabled();
  });
});
