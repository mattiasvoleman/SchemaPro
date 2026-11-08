import { render, screen, waitFor, within } from "@testing-library/react";
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

const start = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  isPending: false,
  variables: undefined as { mode?: string } | undefined,
}));
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
  start.variables = undefined;
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

  describe("Bästa möjliga schema", () => {
    const bestEffortButton = () => screen.getByRole("button", { name: "scheduleCandidates.section.startBestEffort" });
    const queryBestEffortButton = () => screen.queryByRole("button", { name: "scheduleCandidates.section.startBestEffort" });

    it("offers Ta fram bästa möjliga only while the school has the mode on", () => {
      const { unmount } = renderSection({ bestEffort: false });
      expect(queryBestEffortButton()).toBeNull();
      expect(screen.queryByText("scheduleCandidates.section.bestEffortHint")).toBeNull();
      unmount();

      // The prop is optional: a page that does not know the switch offers nothing.
      const second = renderSection();
      expect(queryBestEffortButton()).toBeNull();
      second.unmount();

      renderSection({ bestEffort: true });
      expect(bestEffortButton()).toBeEnabled();
      // The button says what it does: the hint is its description.
      expect(reasonOf(bestEffortButton())?.textContent).toBe("scheduleCandidates.section.bestEffortHint");
    });

    it("starts one candidate in the mode, with the page's profile and no count, and leaves the ordinary start as it was", async () => {
      start.mutateAsync.mockResolvedValue({ runId: "run-9" });
      renderSection({ bestEffort: true });
      const user = userEvent.setup();

      await user.click(bestEffortButton());
      expect(start.mutateAsync).toHaveBeenCalledTimes(1);
      expect(start.mutateAsync).toHaveBeenCalledWith({ academicYearId: "y-1", mode: "BEST_EFFORT", weights: WEIGHTS });
      expect(start.mutateAsync.mock.calls[0]![0]).not.toHaveProperty("count");
      expect(toast.success).toHaveBeenCalledWith("scheduleCandidates.section.startedBestEffort");

      // The ordinary start asks for the batch, without the mode.
      await user.click(startButton());
      expect(start.mutateAsync).toHaveBeenLastCalledWith({ academicYearId: "y-1", count: 3, weights: WEIGHTS });
      expect(start.mutateAsync.mock.calls[1]![0]).not.toHaveProperty("mode");
    });

    /*
     * A run of the mode that succeeds replaces the year's saved proposals (one
     * candidate against two to four), so the button asks first when there are
     * proposals to lose (review of #285, MEDEL-3).
     */
    describe("with a saved set of proposals", () => {
      const savedSet = (candidates = [candidate(1), candidate(2), candidate(3, "TIMEOUT")]) => ({
        data: overviewOf(run(), candidates),
        isLoading: false,
        isError: false,
      });
      const dialog = () => screen.queryByRole("dialog");

      it("asks before it replaces them, says how many there are, and starts only when the admin confirms", async () => {
        start.mutateAsync.mockResolvedValue({ runId: "run-9" });
        renderSection({ bestEffort: true, overview: savedSet() });
        const user = userEvent.setup();

        await user.click(bestEffortButton());
        // Nothing is sent, and the question says what is lost: the two that got a timetable, not the third.
        expect(start.mutateAsync).not.toHaveBeenCalled();
        expect(within(dialog()!).getByText("scheduleCandidates.section.replaceBestEffortTitle")).toBeInTheDocument();
        expect(within(dialog()!).getByText("scheduleCandidates.section.replaceBestEffortBody(2)")).toBeInTheDocument();

        // Saying no leaves everything as it was.
        await user.click(within(dialog()!).getByRole("button", { name: "common.cancel" }));
        expect(dialog()).toBeNull();
        expect(start.mutateAsync).not.toHaveBeenCalled();
        expect(toast.success).not.toHaveBeenCalled();

        await user.click(bestEffortButton());
        await user.click(within(dialog()!).getByRole("button", { name: "scheduleCandidates.section.replaceBestEffortConfirm" }));
        expect(start.mutateAsync).toHaveBeenCalledTimes(1);
        expect(start.mutateAsync).toHaveBeenCalledWith({ academicYearId: "y-1", mode: "BEST_EFFORT", weights: WEIGHTS });
        expect(toast.success).toHaveBeenCalledWith("scheduleCandidates.section.startedBestEffort");
        await waitFor(() => expect(dialog()).toBeNull());
      });

      it("asks also when the newest run failed but the set before it is still saved", async () => {
        // A run that fails leaves the older set (the gateway deletes it only when a newer one succeeds).
        const saved = overviewOf(run(), [candidate(1), candidate(2)]);
        const failed = { run: run({ id: "run-2", status: "FAILED", errorCode: "ENGINE_TIMEOUT" }), candidates: [] };
        renderSection({
          bestEffort: true,
          overview: { data: { ...saved, latest: failed } as unknown as CandidatesOverview, isLoading: false, isError: false },
        });

        await userEvent.setup().click(bestEffortButton());
        expect(start.mutateAsync).not.toHaveBeenCalled();
        expect(within(dialog()!).getByText("scheduleCandidates.section.replaceBestEffortBody(2)")).toBeInTheDocument();
      });

      it("keeps the dialog while the start is in flight and closes it when the start is answered", async () => {
        let answer: (value: unknown) => void = () => {};
        start.mutateAsync.mockReturnValue(new Promise((resolve) => (answer = resolve)));
        renderSection({ bestEffort: true, overview: savedSet() });
        const user = userEvent.setup();

        await user.click(bestEffortButton());
        await user.click(within(dialog()!).getByRole("button", { name: "scheduleCandidates.section.replaceBestEffortConfirm" }));
        expect(dialog()).not.toBeNull();
        answer({ runId: "run-9" });
        await waitFor(() => expect(dialog()).toBeNull());
      });

      it("holds both of the dialog's buttons while the start is in flight, as the page holds its own", async () => {
        const overview = savedSet();
        const view = renderSection({ bestEffort: true, overview });
        await userEvent.setup().click(bestEffortButton());
        expect(within(dialog()!).getByRole("button", { name: "common.cancel" })).toBeEnabled();

        start.isPending = true;
        start.variables = { mode: "BEST_EFFORT" };
        view.rerender(
          <CandidatesSection year={YEAR} overview={overview} canStart generating={false} weights={WEIGHTS} bestEffort />,
        );
        expect(within(dialog()!).getByRole("button", { name: "common.cancel" })).toBeDisabled();
        expect(
          within(dialog()!).getByRole("button", { name: "scheduleCandidates.section.replaceBestEffortConfirm" }),
        ).toBeDisabled();
      });

      it("does not ask for the ordinary start, whose behaviour is as it was", async () => {
        start.mutateAsync.mockResolvedValue({ runId: "run-9" });
        renderSection({ bestEffort: true, overview: savedSet() });

        await userEvent.setup().click(startButton());
        expect(dialog()).toBeNull();
        expect(start.mutateAsync).toHaveBeenCalledWith({ academicYearId: "y-1", count: 3, weights: WEIGHTS });
      });
    });

    /*
     * The picture on screen can be older than the click (fresh for 30 s, no
     * refetch on focus, polled only while a run is active): another tab or
     * administrator may have finished a run, whose set this start would delete
     * unasked. The button reads the runs again and decides on the answer
     * (review of #285, round 2, LÅG-R2-2).
     */
    describe("reads the runs again before it decides", () => {
      const noneSaved = { data: overviewOf(null), isLoading: false, isError: false };
      const savedTwo = { data: overviewOf(run(), [candidate(1), candidate(2)]), isLoading: false, isError: false };
      const refetch = vi.fn();
      beforeEach(() => refetch.mockReset());

      it("asks when the fresh read finds a set the cached picture did not know of", async () => {
        start.mutateAsync.mockResolvedValue({ runId: "run-9" });
        refetch.mockResolvedValue({ data: overviewOf(run(), [candidate(1), candidate(2), candidate(3)]) });
        renderSection({ bestEffort: true, overview: { ...noneSaved, refetch } });

        await userEvent.setup().click(bestEffortButton());
        expect(refetch).toHaveBeenCalledTimes(1);
        expect(start.mutateAsync).not.toHaveBeenCalled();
        // The question names what the fresh read found.
        expect(within(screen.getByRole("dialog")).getByText("scheduleCandidates.section.replaceBestEffortBody(3)")).toBeInTheDocument();
      });

      it("starts at once when the set the cached picture showed is gone", async () => {
        start.mutateAsync.mockResolvedValue({ runId: "run-9" });
        refetch.mockResolvedValue({ data: overviewOf(null) });
        renderSection({ bestEffort: true, overview: { ...savedTwo, refetch } });

        await userEvent.setup().click(bestEffortButton());
        expect(refetch).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(start.mutateAsync).toHaveBeenCalledWith({ academicYearId: "y-1", mode: "BEST_EFFORT", weights: WEIGHTS });
      });

      it("keeps the picture there is when the read fails", async () => {
        // A plain function and not the spy: with a spy (also one wrapped in a plain function) vitest reported the
        // rejected promise as the test's own failure although the component caught it; the cause was not looked into.
        let reads = 0;
        const failing = () => {
          reads += 1;
          return new Promise<never>((_, reject) => setTimeout(() => reject(new Error("offline")), 0));
        };
        renderSection({ bestEffort: true, overview: { ...savedTwo, refetch: failing } });

        await userEvent.setup().click(bestEffortButton());
        expect(reads).toBe(1);
        expect(start.mutateAsync).not.toHaveBeenCalled();
        expect(within(screen.getByRole("dialog")).getByText("scheduleCandidates.section.replaceBestEffortBody(2)")).toBeInTheDocument();
      });

      it.each([
        ["the read answers nothing", () => refetch.mockResolvedValue(undefined)],
        ["the read answers without data", () => refetch.mockResolvedValue({ data: undefined })],
      ])("keeps the picture there is when %s", async (_, arrange) => {
        arrange();
        renderSection({ bestEffort: true, overview: { ...savedTwo, refetch } });

        await userEvent.setup().click(bestEffortButton());
        expect(refetch).toHaveBeenCalledTimes(1);
        expect(start.mutateAsync).not.toHaveBeenCalled();
        expect(within(screen.getByRole("dialog")).getByText("scheduleCandidates.section.replaceBestEffortBody(2)")).toBeInTheDocument();
      });

      it("holds the button while it reads, so a second click cannot start a second read", async () => {
        let answer: (value: unknown) => void = () => {};
        refetch.mockReturnValue(new Promise((resolve) => (answer = resolve)));
        renderSection({ bestEffort: true, overview: { ...noneSaved, refetch } });
        const user = userEvent.setup();

        await user.click(bestEffortButton());
        expect(bestEffortButton()).toBeDisabled();
        await user.click(bestEffortButton());
        expect(refetch).toHaveBeenCalledTimes(1);

        start.mutateAsync.mockResolvedValue({ runId: "run-9" });
        answer({ data: overviewOf(null) });
        await waitFor(() => expect(start.mutateAsync).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(bestEffortButton()).toBeEnabled());
      });

      it("does not read for the ordinary start, which does not ask", async () => {
        start.mutateAsync.mockResolvedValue({ runId: "run-9" });
        renderSection({ bestEffort: true, overview: { ...savedTwo, refetch } });

        await userEvent.setup().click(startButton());
        expect(refetch).not.toHaveBeenCalled();
        expect(start.mutateAsync).toHaveBeenCalledTimes(1);
      });
    });

    describe("with no saved proposals to lose", () => {
      it.each([
        ["nothing saved at all", { data: overviewOf(null), isLoading: false, isError: false }],
        [
          "a saved run in which no candidate got a timetable",
          { data: overviewOf(run(), [candidate(1, "INFEASIBLE"), candidate(2, "TIMEOUT")]), isLoading: false, isError: false },
        ],
        ["the runs not read", { data: undefined, isLoading: false, isError: true }],
      ])("starts at once, with no question: %s", async (_, overview) => {
        start.mutateAsync.mockResolvedValue({ runId: "run-9" });
        renderSection({ bestEffort: true, overview });

        await userEvent.setup().click(bestEffortButton());
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(start.mutateAsync).toHaveBeenCalledWith({ academicYearId: "y-1", mode: "BEST_EFFORT", weights: WEIGHTS });
      });
    });

    it("waits for what the ordinary start waits for, with the same reason beside it", () => {
      const { unmount } = renderSection({ bestEffort: true, generating: true });
      expect(bestEffortButton()).toBeDisabled();
      expect(bestEffortButton().getAttribute("aria-describedby")).toContain(startButton().getAttribute("aria-describedby")!);
      unmount();

      const second = renderSection({ bestEffort: true, canStart: false });
      expect(bestEffortButton()).toBeDisabled();
      second.unmount();

      renderSection({
        bestEffort: true,
        overview: { data: overviewOf(run({ status: "RUNNING", progress: 0 })), isLoading: false, isError: false },
      });
      expect(bestEffortButton()).toBeDisabled();
    });

    it("says the mode being off in the school in words when the gateway refuses it", async () => {
      start.mutateAsync.mockRejectedValue(new ApiError(409, "Off.", "BEST_EFFORT_NOT_ENABLED"));
      renderSection({ bestEffort: true });

      await userEvent.setup().click(bestEffortButton());
      expect(toast.error).toHaveBeenCalledWith("scheduleCandidates.errors.BEST_EFFORT_NOT_ENABLED");
    });

    it("shows its own button as starting, not the ordinary one", () => {
      start.isPending = true;
      start.variables = { mode: "BEST_EFFORT" };
      renderSection({ bestEffort: true });

      // Both are held while a start is in flight; only the one pressed says so.
      expect(startButton()).toBeDisabled();
      expect(queryBestEffortButton()).toBeNull();
      expect(screen.getAllByText("scheduleCandidates.section.starting")).toHaveLength(1);
    });
  });
});
