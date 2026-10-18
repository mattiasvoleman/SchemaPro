import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { CandidatesOverview } from "@/lib/candidates/types";
import { CandidatesSection, type CandidatesSectionProps } from "./candidates-section";

/*
 * The generate page's Schemaförslag section on its own: the page test covers
 * how the page feeds it (and how Generera waits for a run); this covers what
 * it says and sends.
 */

const start = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }));
vi.mock("./use-schedule-candidates", () => ({ useStartCandidates: () => start }));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
}));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: (namespace: string) => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${namespace}.${key}(${Object.values(values).join("|")})` : `${namespace}.${key}`;
    // Only the engine's catalogue is asked `has`; it knows nothing here.
    return Object.assign(t, { has: () => false });
  },
}));

const YEAR = {
  id: "y-1",
  name: "2026/27",
  isActive: true,
  predecessorId: null,
  graduatingGradeLevel: null,
  startDate: "2026-08-17",
  endDate: "2027-06-11",
};
const NEXT = { ...YEAR, id: "y-2", name: "2027/28", isActive: false, predecessorId: "y-1" };
const WEIGHTS = { preferredFree: 10, preferredBusy: 5, disruption: 8, spread: 3, teacherGap: 2 };

const run = (overrides: Record<string, unknown> = {}) => ({
  id: "run-1",
  status: "SUCCEEDED",
  requested: 3,
  progress: 3,
  createdAt: "2026-10-17T08:00:00.000Z",
  startedAt: "2026-10-17T08:00:01.000Z",
  finishedAt: "2026-10-17T08:01:30.000Z",
  error: null,
  errorCode: null,
  errorParams: null,
  createdById: "u-1",
  createdByName: "Ada Admin",
  appliedCandidateId: null,
  appliedAt: null,
  refreshOfId: null,
  ...overrides,
});
const candidate = (ordinal: number, solverStatus = "OPTIMAL") => ({
  id: `c-${ordinal}`,
  ordinal,
  variant: "KEEP",
  weights: null,
  solverStatus,
  lessonCount: 10,
  errorCode: null,
  errorParams: null,
  metrics: null,
  conflicts: [],
});

function overviewOf(latest: ReturnType<typeof run> | null, candidates = [candidate(1), candidate(2), candidate(3, "TIMEOUT")]) {
  const batch = latest ? { run: latest, candidates } : null;
  return { latest: batch, batch: latest?.status === "SUCCEEDED" ? batch : null, unplaced: null } as unknown as CandidatesOverview;
}

function renderSection(props: Partial<CandidatesSectionProps> = {}) {
  return render(
    <CandidatesSection
      year={YEAR}
      overview={{ data: overviewOf(null), isLoading: false, isError: false }}
      canStart
      generating={false}
      weights={WEIGHTS}
      {...props}
    />,
  );
}

const startButton = () => screen.getByRole("button", { name: "scheduleCandidates.section.start" });
const reasonOf = (element: HTMLElement) => document.getElementById(element.getAttribute("aria-describedby") ?? "");

beforeEach(() => {
  start.mutateAsync.mockReset();
  start.isPending = false;
  toast.success.mockReset();
  toast.error.mockReset();
});

describe("the Schemaförslag section on /admin/generate", () => {
  it("says the proposals are kept for 7 days, and starts three with the page's profile", async () => {
    start.mutateAsync.mockResolvedValue({ runId: "run-9" });
    renderSection();

    expect(screen.getByRole("region", { name: "scheduleCandidates.section.title" }).textContent).toContain(
      "scheduleCandidates.section.retention",
    );
    expect(screen.getByText("scheduleCandidates.status.none")).toBeInTheDocument();
    // Nothing to compare yet.
    expect(screen.queryByRole("link", { name: /section\.compare/ })).toBeNull();

    await userEvent.setup().click(startButton());
    expect(start.mutateAsync).toHaveBeenCalledWith({ academicYearId: "y-1", count: 3, weights: WEIGHTS });
    expect(toast.success).toHaveBeenCalledWith("scheduleCandidates.section.started");
  });

  it("asks for as many as the admin chooses, two to four", async () => {
    start.mutateAsync.mockResolvedValue({ runId: "run-9" });
    renderSection();
    const user = userEvent.setup();

    const count = screen.getByLabelText("scheduleCandidates.section.count");
    expect([...(count as HTMLSelectElement).options].map((option) => option.value)).toEqual(["2", "3", "4"]);
    await user.selectOptions(count, "4");
    await user.click(startButton());
    expect(start.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ count: 4 }));
  });

  it("shows a running run's progress, waits, and links to the comparison", () => {
    renderSection({ overview: { data: overviewOf(run({ status: "RUNNING", progress: 1 })), isLoading: false, isError: false } });

    expect(screen.getByText("scheduleCandidates.status.RUNNING(1|3)")).toBeInTheDocument();
    expect(startButton()).toBeDisabled();
    expect(reasonOf(startButton())?.textContent).toBe("scheduleCandidates.status.RUNNING(1|3)");
    expect(screen.getByRole("link", { name: "scheduleCandidates.section.compare" })).toHaveAttribute(
      "href",
      "/admin/generate/candidates",
    );
  });

  it("counts the proposals that got a timetable, and says which one was applied", () => {
    renderSection({
      overview: { data: overviewOf(run({ appliedCandidateId: "c-2" })), isLoading: false, isError: false },
    });

    const status = screen.getByText(/scheduleCandidates\.status\.SUCCEEDED/);
    expect(status.textContent).toMatch(/^scheduleCandidates\.status\.SUCCEEDED\(2\|.+\) scheduleCandidates\.status\.applied\(2\)$/);
  });

  it("says why the newest run failed, in this feature's words", () => {
    renderSection({
      overview: {
        data: overviewOf(run({ status: "FAILED", errorCode: "ENGINE_LACKS_CANDIDATES", error: "422 extra_forbidden" })),
        isLoading: false,
        isError: false,
      },
    });

    expect(screen.getByText(/scheduleCandidates\.status\.FAILED/).textContent).toContain(
      "scheduleCandidates.runErrors.ENGINE_LACKS_CANDIDATES",
    );
    expect(screen.queryByText(/extra_forbidden/)).toBeNull();
  });

  it.each([
    ["INFEASIBLE", "scheduleCandidates.runErrors.CANDIDATES_FIRST_FAILED_UNNAMED"],
    ["TIMEOUT", "scheduleCandidates.runErrors.CANDIDATES_FIRST_TIMEOUT"],
  ])("says a first candidate's %s without promising a list this page does not have", (solverStatus, sentence) => {
    renderSection({
      overview: {
        data: overviewOf(run({ status: "FAILED", errorCode: "CANDIDATES_FIRST_FAILED", progress: 1 }), [candidate(1, solverStatus)]),
        isLoading: false,
        isError: false,
      },
    });

    expect(screen.getByText(/scheduleCandidates\.status\.FAILED/).textContent).toContain(sentence);
  });

  it("waits while Generera runs, and says so beside the button", () => {
    renderSection({ generating: true });

    expect(startButton()).toBeDisabled();
    expect(reasonOf(startButton())?.textContent).toBe("scheduleCandidates.section.blockedGenerating");
  });

  it("waits for the checklist above, and says so", () => {
    renderSection({ canStart: false });

    expect(startButton()).toBeDisabled();
    expect(reasonOf(startButton())?.textContent).toBe("scheduleCandidates.section.blockedPrerequisites");
  });

  it("links next year's comparison with the year it is for", () => {
    renderSection({ year: NEXT, overview: { data: overviewOf(run()), isLoading: false, isError: false } });

    expect(screen.getByRole("link", { name: "scheduleCandidates.section.compare" })).toHaveAttribute(
      "href",
      "/admin/generate/candidates?year=y-2",
    );
  });

  it("says a refusal in Swedish rather than the gateway's English", async () => {
    start.mutateAsync.mockRejectedValue(new ApiError(409, "No draft.", "CANDIDATES_NEED_A_DRAFT"));
    renderSection();

    await userEvent.setup().click(startButton());
    expect(toast.error).toHaveBeenCalledWith("scheduleCandidates.errors.CANDIDATES_NEED_A_DRAFT");
  });

  it("waits for the runs, and says so when they could not be read", () => {
    const { container, unmount } = renderSection({ overview: { data: undefined, isLoading: true, isError: false } });
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    unmount();

    renderSection({ overview: { data: undefined, isLoading: false, isError: true } });
    expect(screen.getByRole("alert").textContent).toContain("scheduleCandidates.section.loadFailed");
  });
});
