import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { ApiError, api } from "@/lib/api";
import { StaffingProposalDialog, type StaffingProposalDialogProps } from "./staffing-proposal-dialog";
import type { StaffingApplyResult, StaffingProposal } from "./use-staffing-proposal";

/**
 * Föreslå bemanning over the real hooks and the real Swedish messages, with
 * the gateway mocked at lib/api: what is asked (the options, only the weights
 * that differ, the pins), what the answer shows (each teacher before → after,
 * each row with its reasons, the unstaffed rest and the engine's sentences),
 * what a selection does to the figures, and what apply and undo send — and
 * every refusal said in words.
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } };
});
const post = api.post as unknown as Mock;
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const PROPOSE = "/api/v1/optimization/staffing/proposal";
const APPLY = "/api/v1/optimization/staffing/apply";
const BASIS = "a".repeat(64);
const BASIS_AFTER = "b".repeat(64);

const names: Record<string, string> = {
  "t-anna": "Anna Berg",
  "t-bo": "Bo Alm",
  "t-cilla": "Cilla Öst",
  "t-gone": "Gun Gone",
};
const groups: Record<string, string> = { "g-7a": "7A", "g-8b": "8B" };
const subjects: Record<string, string> = { "s-ma": "Matematik", "s-no": "NO", "s-mu": "Musik" };

const point = (minutes: number, target: number | null, status: "UNDER" | "OK" | "OVER" | "NO_TARGET") => ({
  countedMinutesPerWeek: Math.round(minutes),
  countedExact: minutes,
  percentOfTarget: target ? Math.round((minutes / target) * 1000) / 10 : null,
  status,
});

/**
 * Anna (target 1000, limit 1100) takes Matematik 7A (open) and Musik 8B (from
 * Gun, who has left). Bo (target 600) takes NO 7A from Cilla, who has no
 * target and keeps or sheds. NO 8B stays unstaffed — only its co-teacher is
 * qualified — and Musik needs more than anybody has left.
 */
const proposal = (overrides: Partial<StaffingProposal> = {}): StaffingProposal => ({
  status: "FEASIBLE",
  unstaffedProven: true,
  basisSha256: BASIS,
  options: {
    onlyUnstaffed: false,
    respectQualifications: true,
    respectForcedByPolicy: false,
    qualificationsRecorded: true,
    pinnedRequirementIds: [],
  },
  loadModel: "MINUTES",
  counts: {
    freeRequirements: 4,
    openRequirements: 2,
    keptRequirements: 2,
    fixedRequirements: 3,
    vacated: 1,
    inconsistent: 0,
    teachersSent: 3,
    teachersWithTarget: 2,
    teachersWithZeroTarget: 0,
    teachersWithoutTarget: 1,
  },
  assignments: [
    {
      requirementId: "r-ma-7a",
      subjectId: "s-ma",
      studentGroupId: "g-7a",
      fromTeacherId: null,
      toTeacherId: "t-anna",
      chargeMinutesPerWeek: 180,
      reasons: { qualificationKind: "LEGITIMATION", familiarWithSubject: true, taughtLastYear: true, teachesGroupAlready: false },
    },
    {
      requirementId: "r-mu-8b",
      subjectId: "s-mu",
      studentGroupId: "g-8b",
      fromTeacherId: "t-gone",
      toTeacherId: "t-anna",
      chargeMinutesPerWeek: 60,
      reasons: { qualificationKind: null, familiarWithSubject: false, taughtLastYear: false, teachesGroupAlready: true },
    },
    {
      requirementId: "r-no-7a",
      subjectId: "s-no",
      studentGroupId: "g-7a",
      fromTeacherId: "t-cilla",
      toTeacherId: "t-bo",
      chargeMinutesPerWeek: 120,
      reasons: { qualificationKind: "BEHORIG", familiarWithSubject: false, taughtLastYear: false, teachesGroupAlready: true },
    },
  ],
  teachers: [
    {
      userId: "t-anna",
      targetMinutesPerWeek: 1000,
      limitMinutesPerWeek: 1100,
      keepOrShed: false,
      before: point(800, 1000, "UNDER"),
      after: point(1040, 1000, "OK"),
    },
    {
      userId: "t-bo",
      targetMinutesPerWeek: 600,
      limitMinutesPerWeek: 660,
      keepOrShed: false,
      before: point(480, 600, "UNDER"),
      after: point(600, 600, "OK"),
    },
    {
      // A full nedsättning: a target of 0, so she may only give rows up.
      userId: "t-cilla",
      targetMinutesPerWeek: 0,
      limitMinutesPerWeek: 0,
      keepOrShed: true,
      before: point(300, 0, "OVER"),
      after: point(180, 0, "OVER"),
    },
    {
      userId: "t-dan",
      targetMinutesPerWeek: 900,
      limitMinutesPerWeek: 990,
      keepOrShed: false,
      before: point(900, 900, "OK"),
      after: point(900, 900, "OK"),
    },
    {
      // No target: her rows are not the proposal's to move.
      userId: "t-eva",
      targetMinutesPerWeek: null,
      limitMinutesPerWeek: null,
      keepOrShed: true,
      before: point(240, null, "NO_TARGET"),
      after: point(240, null, "NO_TARGET"),
    },
  ],
  unstaffed: [
    {
      requirementId: "r-no-8b",
      subjectId: "s-no",
      studentGroupId: "g-8b",
      chargeMinutesPerWeek: 90,
      reason: "NO_QUALIFIED_TEACHER",
      onlyCoTeacherQualified: true,
    },
    {
      requirementId: "r-mu-7a",
      subjectId: "s-mu",
      studentGroupId: "g-7a",
      chargeMinutesPerWeek: 60,
      reason: "NO_CAPACITY_LEFT",
      onlyCoTeacherQualified: false,
    },
  ],
  conflicts: [
    {
      code: "STAFF_CAPACITY_EXHAUSTED_FOR_SUBJECT",
      params: { subject: "Musik", count: 1, demandedMinutes: 120, availableMinutes: 60, shortMinutes: 60 },
      message: "Musik needs 120 minutes a week",
      requirementIds: ["r-mu-7a"],
      requirementNames: ["Musik för 7A"],
      subjectIds: ["s-mu"],
      teacherIds: [],
    },
    {
      code: "STAFF_TEACHER_CAPACITY_ZERO",
      params: { fixedMinutes: 990, limitMinutes: 990 },
      message: "Already carries 990 minutes a week",
      requirementIds: [],
      requirementNames: [],
      subjectIds: [],
      teacherIds: ["t-dan"],
    },
  ],
  terms: null,
  ...overrides,
});

const applied = (overrides: Partial<StaffingApplyResult> = {}): StaffingApplyResult => ({
  updated: 3,
  basisSha256: BASIS_AFTER,
  warnings: [],
  logId: "log-1",
  ...overrides,
});

function renderDialog(props: Partial<StaffingProposalDialogProps> = {}) {
  const onOpenChange = vi.fn();
  const onOpenSettings = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidated = vi.spyOn(queryClient, "invalidateQueries");
  render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider
        locale="sv"
        messages={sv}
        timeZone="Europe/Stockholm"
        onError={(error) => {
          throw error;
        }}
      >
        <StaffingProposalDialog
          open
          onOpenChange={onOpenChange}
          academicYearId="y1"
          academicYearName="2026/27"
          teachersWithTarget={2}
          teachersTotal={4}
          qualificationsRecorded
          policy={{ qualificationMode: "WARN", overAllocationTolerancePercent: 10 }}
          teacherName={(id) => names[id] ?? id}
          groupName={(id) => groups[id] ?? "—"}
          subjectName={(id) => subjects[id] ?? "—"}
          onOpenSettings={onOpenSettings}
          {...props}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return { onOpenChange, onOpenSettings, invalidated };
}

const asks = () => post.mock.calls.filter(([path]) => path === PROPOSE).map(([, body]) => body);
const applies = () => post.mock.calls.filter(([path]) => path === APPLY).map(([, body]) => body);

async function computeProposal(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Beräkna förslag" }));
  return screen.findByText("Förslag per post");
}

/** The applied toast's Ångra, pressed. */
function pressUndo(kind: "success" | "warning" = "success") {
  const options = toast[kind].mock.calls.at(-1)?.[1] as { action: { label: string; onClick: () => void }; duration: number };
  expect(options.action.label).toBe("Ångra");
  expect(options.duration).toBe(15_000);
  return act(async () => options.action.onClick());
}

describe("StaffingProposalDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    post.mockImplementation(async (path: string) => (path === PROPOSE ? proposal() : applied()));
  });

  describe("the options", () => {
    it("asks for the unstaffed rows, respecting behörighet, and sends no weight nobody changed", async () => {
      const user = userEvent.setup();
      renderDialog();
      expect(screen.getByRole("heading", { name: "Föreslå bemanning för 2026/27" })).toBeInTheDocument();
      expect(screen.getByRole("checkbox", { name: /Bara obemannade poster/ })).toBeChecked();
      expect(screen.getByRole("checkbox", { name: /Respektera behörighet/ })).toBeChecked();
      expect(screen.getByText(/2 av 4 lärare har ett mål/)).toBeInTheDocument();
      expect(screen.getByText(/Grundschemat ändras inte/)).toBeInTheDocument();
      await computeProposal(user);
      expect(asks()).toEqual([{ academicYearId: "y1", onlyUnstaffed: true, respectQualifications: true }]);
    });

    it("sends the options as set, and only the weights that differ from the engine's defaults", async () => {
      const user = userEvent.setup();
      renderDialog();
      await user.click(screen.getByRole("checkbox", { name: /Bara obemannade poster/ }));
      await user.click(screen.getByRole("checkbox", { name: /Respektera behörighet/ }));
      expect(screen.getByText(/kan ge en post till en obehörig/)).toBeInTheDocument();
      await user.click(screen.getByText("Avancerat"));
      const balance = screen.getByRole("spinbutton", { name: "Jämn belastning mot målet" });
      await user.clear(balance);
      await user.type(balance, "250");
      expect(balance).toHaveValue(100);
      await computeProposal(user);
      expect(asks()).toEqual([
        { academicYearId: "y1", onlyUnstaffed: false, respectQualifications: false, weights: { balance: 100 } },
      ]);
    });

    it("puts the weights back with Återställ", async () => {
      const user = userEvent.setup();
      renderDialog();
      await user.click(screen.getByText("Avancerat"));
      const classTeachers = screen.getByRole("spinbutton", { name: "Få lärare per klass" });
      await user.clear(classTeachers);
      await user.type(classTeachers, "0");
      await user.click(screen.getByRole("button", { name: "Återställ" }));
      expect(classTeachers).toHaveValue(2);
      await computeProposal(user);
      expect(asks()[0]).not.toHaveProperty("weights");
    });

    it("forces behörighet on under REFUSE, and says so", async () => {
      const user = userEvent.setup();
      renderDialog({ policy: { qualificationMode: "REFUSE", overAllocationTolerancePercent: 10 } });
      const respect = screen.getByRole("checkbox", { name: /Respektera behörighet/ });
      expect(respect).toBeChecked();
      expect(respect).toBeDisabled();
      expect(screen.getByText(/Skolans inställning vägrar obehöriga tilldelningar/)).toBeInTheDocument();
      await computeProposal(user);
      expect(asks()[0]).toMatchObject({ respectQualifications: true });
    });

    it("cannot respect behörigheter nobody has recorded, and says what it prefers instead", async () => {
      const user = userEvent.setup();
      renderDialog({ qualificationsRecorded: false, policy: { qualificationMode: "REFUSE", overAllocationTolerancePercent: 10 } });
      const respect = screen.getByRole("checkbox", { name: /Respektera behörighet/ });
      expect(respect).not.toBeChecked();
      expect(respect).toBeDisabled();
      expect(
        screen.getByText("Inga behörigheter registrerade — förslaget föredrar lärare som redan undervisar i ämnet."),
      ).toBeInTheDocument();
      await computeProposal(user);
      expect(asks()[0]).toMatchObject({ respectQualifications: false });
    });

    it("does not ask while no teacher has a target, and points at the settings", async () => {
      const user = userEvent.setup();
      const { onOpenChange, onOpenSettings } = renderDialog({ teachersWithTarget: 0 });
      expect(screen.getByRole("button", { name: "Beräkna förslag" })).toBeDisabled();
      expect(screen.getByText(/Ingen lärare har ett mål än/)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Öppna inställningarna" }));
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(onOpenSettings).toHaveBeenCalled();
      expect(asks()).toEqual([]);
    });
  });

  describe("the answer", () => {
    it("states the status, and that no proposal staffs more rows when that was proven", async () => {
      const user = userEvent.setup();
      renderDialog();
      await computeProposal(user);
      expect(
        screen.getByText("Bästa hittills inom tidsgränsen · Inget förslag bemannar fler poster"),
      ).toBeInTheDocument();
      expect(screen.getByText(/Ett nytt försök kan ge ett lika bra förslag/)).toBeInTheDocument();
      expect(screen.getByText("3 poster får en ny lärare, och 2 blir kvar obemannade.")).toBeInTheDocument();
      expect(screen.getByText("1 post har en lärare som har slutat.")).toBeInTheDocument();
    });

    it("says an optimal answer that changes nothing without a zero", async () => {
      const user = userEvent.setup();
      post.mockResolvedValue(proposal({ status: "OPTIMAL", assignments: [], unstaffed: [], conflicts: [] }));
      renderDialog();
      await user.click(screen.getByRole("button", { name: "Beräkna förslag" }));
      expect(await screen.findByText("Optimalt · Inget förslag bemannar fler poster")).toBeInTheDocument();
      expect(screen.getByText("Ingen post får en ny lärare, och ingen blir kvar obemannad.")).toBeInTheDocument();
      expect(screen.queryByText(/Ett nytt försök/)).toBeNull();
      // The footer's Stäng beside the dialog's own: nothing to apply.
      expect(screen.getAllByRole("button", { name: "Stäng" })).toHaveLength(2);
      expect(screen.queryByRole("button", { name: /Tillämpa/ })).toBeNull();
    });

    it("lists each row with its proposed teacher, the one it has now, and why", async () => {
      const user = userEvent.setup();
      renderDialog();
      await computeProposal(user);
      const row = (name: string) => screen.getByRole("checkbox", { name: `Ta med ${name}` }).closest("tr") as HTMLElement;

      const ma = row("Matematik för 7A");
      expect(within(ma).getByText("Anna Berg")).toBeInTheDocument();
      expect(within(ma).getByText("Obemannad")).toBeInTheDocument();
      expect(within(ma).getByText("Legitimation")).toBeInTheDocument();
      expect(within(ma).getByText("Samma som förra läsåret")).toBeInTheDocument();
      expect(within(ma).getByText("180 min/v")).toBeInTheDocument();

      const mu = row("Musik för 8B");
      expect(within(mu).getByText("Gun Gone (har slutat)")).toBeInTheDocument();
      expect(within(mu).getByText("Saknar behörighet")).toBeInTheDocument();
      expect(within(mu).getByText("Har redan gruppen")).toBeInTheDocument();

      const no = row("NO för 7A");
      expect(within(no).getByText("Cilla Öst")).toBeInTheDocument();
      expect(within(no).getByText("Behörig")).toBeInTheDocument();
    });

    it("says 'undervisar redan i ämnet' where nothing is recorded, and never 'saknar behörighet'", async () => {
      const user = userEvent.setup();
      const base = proposal();
      post.mockResolvedValue(
        proposal({
          options: { ...base.options, qualificationsRecorded: false, respectQualifications: false },
          assignments: [
            {
              ...base.assignments[1]!,
              reasons: { qualificationKind: null, familiarWithSubject: true, taughtLastYear: false, teachesGroupAlready: false },
            },
          ],
        }),
      );
      renderDialog({ qualificationsRecorded: false });
      await computeProposal(user);
      const mu = screen.getByRole("checkbox", { name: "Ta med Musik för 8B" }).closest("tr") as HTMLElement;
      expect(within(mu).getByText("Undervisar redan i ämnet")).toBeInTheDocument();
      expect(within(mu).queryByText("Saknar behörighet")).toBeNull();
    });

    it("shows the changed teachers before → after in minutes and % of target, marking who only keeps or sheds", async () => {
      const user = userEvent.setup();
      renderDialog();
      await computeProposal(user);
      const teacherRow = (name: string) => screen.getByRole("rowheader", { name: new RegExp(name) }).closest("tr") as HTMLElement;
      const anna = teacherRow("Anna Berg");
      expect(within(anna).getByText("800 min/v · 80 %")).toBeInTheDocument();
      expect(within(anna).getByText("1040 min/v · 104 %")).toBeInTheDocument();
      expect(within(anna).getByText("I nivå")).toBeInTheDocument();
      const cilla = teacherRow("Cilla Öst");
      expect(within(cilla).getByText("Behåller eller lämnar bara sina egna poster")).toBeInTheDocument();
      expect(within(cilla).getByText("180 min/v")).toBeInTheDocument();
      // Dan is untouched: listed only after "Visa alla".
      expect(screen.queryByRole("rowheader", { name: /t-dan/ })).toBeNull();
      await user.click(screen.getByRole("button", { name: "Visa alla (5)" }));
      expect(screen.getByRole("rowheader", { name: /t-dan/ })).toBeInTheDocument();
      // A teacher with no target keeps every row: not "keeps or gives up".
      const eva = screen.getByRole("rowheader", { name: /t-eva/ });
      expect(within(eva).getByText("Har inget mål och behåller sina poster")).toBeInTheDocument();
      expect(within(eva).queryByText("Behåller eller lämnar bara sina egna poster")).toBeNull();
    });

    it("says why each remaining row stays unstaffed, and the engine's sentences in Swedish with the teacher named", async () => {
      const user = userEvent.setup();
      renderDialog();
      await computeProposal(user);
      expect(screen.getByRole("heading", { name: "Blir kvar obemannade (2)" })).toBeInTheDocument();
      expect(screen.getByText(/bara postens medlärare är behörig/)).toBeInTheDocument();
      expect(screen.getByText(/ingen som kan ta posten har plats kvar under sin gräns/)).toBeInTheDocument();
      expect(
        screen.getByText(
          "Musik behöver 120 min/v i 1 timplanspost, och lärarna som får ta dem har högst 60 min/v kvar under sina gränser, så minst 60 min/v förblir obemannade. Höj ett riktmärke eller toleransen, registrera fler behörigheter eller minska ämnets tid.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText("t-dan: Har redan 990 min/v mot gränsen 990 min/v, så ingen fler timplanspost ryms."),
      ).toBeInTheDocument();
    });
  });

  describe("the selection", () => {
    it("re-adds the rows left out to each teacher, and flags a selection that grows a teacher past the limit", async () => {
      const user = userEvent.setup();
      const base = proposal();
      // Bo gives up NO 7A to Anna and takes Matematik 7A; left out, Bo keeps
      // NO and still takes Matematik — over his limit.
      post.mockResolvedValue(
        proposal({
          assignments: [
            { ...base.assignments[0]!, toTeacherId: "t-bo" },
            { ...base.assignments[2]!, fromTeacherId: "t-bo", toTeacherId: "t-anna" },
          ],
          teachers: [
            { ...base.teachers[0]!, before: point(800, 1000, "UNDER"), after: point(920, 1000, "OK") },
            { ...base.teachers[1]!, before: point(540, 600, "OK"), after: point(600, 600, "OK") },
          ],
        }),
      );
      renderDialog();
      await computeProposal(user);
      expect(screen.getByRole("button", { name: "Tillämpa 2 valda" })).toBeEnabled();
      await user.click(screen.getByRole("checkbox", { name: "Ta med NO för 7A" }));
      const bo = screen.getByRole("rowheader", { name: /Bo Alm/ }).closest("tr") as HTMLElement;
      expect(within(bo).getByText("720 min/v · 120 %")).toBeInTheDocument();
      expect(within(bo).getByText("Över mål")).toBeInTheDocument();
      expect(within(bo).getByText(/Urvalet lägger läraren över gränsen/)).toBeInTheDocument();
      const anna = screen.getByRole("rowheader", { name: /Anna Berg/ }).closest("tr") as HTMLElement;
      // The row moving to Anna is left out: back where she started.
      expect(within(anna).getAllByText("800 min/v · 80 %")).toHaveLength(2);
      expect(within(anna).queryByText(/Urvalet lägger/)).toBeNull();
      expect(screen.getByRole("button", { name: "Tillämpa 1 vald" })).toBeEnabled();

      // Not all selected: the header box selects all, then none.
      await user.click(screen.getByRole("checkbox", { name: "Ta med alla förslag" }));
      expect(screen.getByRole("button", { name: "Tillämpa 2 valda" })).toBeEnabled();
      await user.click(screen.getByRole("checkbox", { name: "Ta med alla förslag" }));
      expect(screen.getByRole("button", { name: "Tillämpa 0 valda" })).toBeDisabled();
    });

    it("pins a row as it is and asks again without it", async () => {
      const user = userEvent.setup();
      renderDialog();
      await computeProposal(user);
      await user.click(screen.getByRole("button", { name: "Behåll Musik för 8B som nu och beräkna om" }));
      await waitFor(() => expect(asks()).toHaveLength(2));
      expect(asks()[1]).toEqual({
        academicYearId: "y1",
        onlyUnstaffed: true,
        respectQualifications: true,
        pinnedRequirementIds: ["r-mu-8b"],
      });
    });
  });

  describe("apply and undo", () => {
    it("applies the selected changes against the proposal's basis, and undoes them against the apply's", async () => {
      const user = userEvent.setup();
      const { onOpenChange, invalidated } = renderDialog();
      await computeProposal(user);
      await user.click(screen.getByRole("checkbox", { name: "Ta med NO för 7A" }));
      await user.click(screen.getByRole("button", { name: "Tillämpa 2 valda" }));
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
      expect(applies()).toEqual([
        {
          academicYearId: "y1",
          basisSha256: BASIS,
          changes: [
            { requirementId: "r-ma-7a", fromTeacherId: null, toTeacherId: "t-anna" },
            { requirementId: "r-mu-8b", fromTeacherId: "t-gone", toTeacherId: "t-anna" },
          ],
        },
      ]);
      expect(toast.success).toHaveBeenCalledWith("3 poster fick en ny lärare.", expect.anything());
      const keys = invalidated.mock.calls.map(([filters]) => (filters as { queryKey: unknown[] }).queryKey);
      expect(keys).toEqual(
        expect.arrayContaining([["staffingLoad"], ["staffingUnstaffed"], ["staffingSuggestions"], ["requirements"]]),
      );

      await pressUndo();
      expect(applies()[1]).toEqual({
        academicYearId: "y1",
        basisSha256: BASIS_AFTER,
        undo: true,
        changes: [
          { requirementId: "r-ma-7a", fromTeacherId: "t-anna", toTeacherId: null },
          { requirementId: "r-mu-8b", fromTeacherId: "t-anna", toTeacherId: "t-gone" },
        ],
      });
      expect(toast.success).toHaveBeenLastCalledWith("Bemanningen är som före förslaget.");
    });

    it("names the teacher and the rows a WARN is about, and still offers Ångra", async () => {
      const user = userEvent.setup();
      post.mockImplementation(async (path: string) =>
        path === PROPOSE
          ? proposal()
          : applied({
              warnings: [
                {
                  code: "STAFF_TEACHER_NOT_QUALIFIED",
                  params: { role: "TEACHER", subject: "Musik", grades: "8" },
                  userId: "t-anna",
                  requirementIds: ["r-mu-8b"],
                },
              ],
            }),
      );
      renderDialog();
      await computeProposal(user);
      await user.click(screen.getByRole("button", { name: "Tillämpa 3 valda" }));
      await waitFor(() => expect(toast.warning).toHaveBeenCalled());
      expect(toast.warning.mock.calls[0]?.[1]).toMatchObject({
        description: "Anna Berg (Musik för 8B): Läraren saknar behörighet i Musik för åk 8.",
      });
      await pressUndo("warning");
      expect(applies()[1]).toMatchObject({ undo: true, basisSha256: BASIS_AFTER });
    });

    it("goes back to the options on a stale basis, saying nothing was saved, and asks again from there", async () => {
      const user = userEvent.setup();
      post.mockImplementation(async (path: string) => {
        if (path === PROPOSE) return proposal();
        throw new ApiError(409, "Tjänstefördelningen har ändrats sedan förslaget beräknades.", "STAFF_PROPOSAL_STALE");
      });
      const { onOpenChange } = renderDialog();
      await computeProposal(user);
      await user.click(screen.getByRole("button", { name: "Tillämpa 3 valda" }));
      expect(await screen.findByText(/Ingenting sparades\. Beräkna ett nytt förslag\./)).toBeInTheDocument();
      expect(onOpenChange).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "Beräkna om" }));
      await waitFor(() => expect(asks()).toHaveLength(2));
    });

    it("says a REFUSE in the dialog with the teacher and the row named, and keeps the proposal", async () => {
      const user = userEvent.setup();
      post.mockImplementation(async (path: string) => {
        if (path === PROPOSE) return proposal();
        throw new ApiError(409, "Musik för 8B: Läraren saknar behörighet i Musik för åk 8.", "STAFF_TEACHER_NOT_QUALIFIED", {
          role: "TEACHER",
          subject: "Musik",
          grades: "8",
          userId: "t-anna",
          requirementId: "r-mu-8b",
        });
      });
      renderDialog();
      await computeProposal(user);
      await user.click(screen.getByRole("button", { name: "Tillämpa 3 valda" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Anna Berg, Musik för 8B: Läraren saknar behörighet i Musik för åk 8.",
      );
      expect(screen.getByText("Förslag per post")).toBeInTheDocument();
      expect(toast.error).not.toHaveBeenCalled();
    });

    it("says an undo the staffing has moved past, and an undo the policy refuses", async () => {
      const user = userEvent.setup();
      let undoError: ApiError = new ApiError(409, "stale", "STAFF_PROPOSAL_STALE");
      post.mockImplementation(async (path: string, body: { undo?: boolean }) => {
        if (path === PROPOSE) return proposal();
        if (body.undo) throw undoError;
        return applied();
      });
      renderDialog();
      await computeProposal(user);
      await user.click(screen.getByRole("button", { name: "Tillämpa 3 valda" }));
      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      await pressUndo();
      expect(toast.error).toHaveBeenLastCalledWith(
        "Kunde inte ångra: tjänstefördelningen har ändrats sedan dess. Byt tillbaka posterna för hand.",
      );
      undoError = new ApiError(409, "Musik för 8B: …", "STAFF_TEACHER_NOT_QUALIFIED", {
        role: "TEACHER",
        subject: "Musik",
        grades: "8",
        userId: "t-gone",
        requirementId: "r-mu-8b",
      });
      await pressUndo();
      expect(toast.error).toHaveBeenLastCalledWith(
        "Kunde inte ångra: Gun Gone, Musik för 8B: Läraren saknar behörighet i Musik för åk 8.",
      );
    });
  });

  describe("a proposal that could not be made", () => {
    it.each([
      ["an engine without /staff yet", new ApiError(503, "Motorn kan ännu inte …", "STAFF_ENGINE_UNAVAILABLE"), "Motorn kan inte föreslå bemanning just nu. Försök igen om en stund."],
      ["an answer the gateway refused", new ApiError(502, "Bad gateway"), "Motorn kan inte föreslå bemanning just nu. Försök igen om en stund."],
      ["a year that is gone", new ApiError(404, "Academic year not found."), "Läsåret finns inte längre. Välj ett annat läsår."],
      [
        "a school too large to weigh at once",
        new ApiError(400, "Det finns för många …", "STAFF_MODEL_TOO_LARGE", { variables: 1500000, limit: 1000000 }),
        "Det finns för många möjliga lärartilldelningar att väga på en gång: omkring 1500000 modellvariabler mot gränsen 1000000. Behåll de poster som är klara som de är, eller registrera behörigheter så att färre lärare är kandidater för varje post, och försök igen.",
      ],
    ])("says %s in words", async (_name, error, sentence) => {
      const user = userEvent.setup();
      post.mockRejectedValue(error);
      renderDialog();
      await user.click(screen.getByRole("button", { name: "Beräkna förslag" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(sentence);
      expect(screen.getByRole("button", { name: "Beräkna förslag" })).toBeEnabled();
    });

    it("drops an answer that arrives after the dialog was closed", async () => {
      const user = userEvent.setup();
      let resolve: (value: StaffingProposal) => void = () => {};
      post.mockImplementation(() => new Promise((done) => (resolve = done)));
      const { onOpenChange } = renderDialog();
      await user.click(screen.getByRole("button", { name: "Beräkna förslag" }));
      await user.click(screen.getByRole("button", { name: "Avbryt" }));
      expect(onOpenChange).toHaveBeenCalledWith(false);
      await act(async () => resolve(proposal()));
      expect(screen.queryByText("Förslag per post")).toBeNull();
    });
  });
});
