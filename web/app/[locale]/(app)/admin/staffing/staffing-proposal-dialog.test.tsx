import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import en from "@/messages/en.json";
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
 * qualified — and Musik needs more than anybody has left. Cilla is staff, so
 * NO 7A is a post the school chose and has released; Gun has left, so Musik 8B
 * is open to the engine without a release.
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
    releasedRequirements: 0,
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
      // Off: the posts the school has released are proposed too. A teacher it chose never is, whichever this is.
      expect(screen.getByRole("checkbox", { name: /Bara obemannade poster/ })).not.toBeChecked();
      expect(screen.getByRole("checkbox", { name: /Respektera behörighet/ })).toBeChecked();
      expect(screen.getByText(/2 av 4 lärare har ett mål/)).toBeInTheDocument();
      expect(screen.getByText(/Grundschemat ändras inte/)).toBeInTheDocument();
      await computeProposal(user);
      expect(asks()).toEqual([{ academicYearId: "y1", onlyUnstaffed: false, respectQualifications: true }]);
    });

    it("says what each state of 'Bara obemannade poster' means: released posts are proposed, a chosen teacher never moves", async () => {
      const user = userEvent.setup();
      renderDialog();
      const box = screen.getByRole("checkbox", { name: /Bara obemannade poster/ });
      expect(box).toHaveAccessibleName(/^Bara obemannade poster/);
      expect(
        screen.getByText(
          "Poster utan lärare, och de poster du har släppt för motorn, får få en lärare föreslagen. Poster med en lärare som du har valt flyttas aldrig.",
        ),
      ).toBeInTheDocument();
      await user.click(box);
      expect(
        screen.getByText("Bara poster utan lärare, eller där läraren har slutat. Släppta poster lämnas som de är."),
      ).toBeInTheDocument();
    });

    it("sends the options as set, and only the weights that differ from the engine's defaults", async () => {
      const user = userEvent.setup();
      renderDialog();
      await user.click(screen.getByRole("checkbox", { name: /Bara obemannade poster/ }));
      expect(screen.getByRole("checkbox", { name: /Bara obemannade poster/ })).toBeChecked();
      await user.click(screen.getByRole("checkbox", { name: /Respektera behörighet/ }));
      expect(screen.getByText(/kan ge en post till en obehörig/)).toBeInTheDocument();
      await user.click(screen.getByText("Avancerat"));
      const balance = screen.getByRole("spinbutton", { name: "Jämn belastning mot målet" });
      await user.clear(balance);
      await user.type(balance, "250");
      expect(balance).toHaveValue(100);
      await computeProposal(user);
      expect(asks()).toEqual([
        { academicYearId: "y1", onlyUnstaffed: true, respectQualifications: false, weights: { balance: 100 } },
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

    it("names a post that changes during the year beside a dated row it was never offered, so 'no room' is not the whole story", async () => {
      const user = userEvent.setup();
      const base = proposal();
      post.mockResolvedValue(
        proposal({
          unstaffed: base.unstaffed.map((row) =>
            row.requirementId === "r-mu-7a" ? { ...row, excludedChanging: ["t-anna"] } : row,
          ),
        }),
      );
      renderDialog();
      await computeProposal(user);
      expect(
        screen.getByText(
          "Anna Berg föreslås inte: tjänsten ändras under läsåret, och posten belastar en av tjänstens perioder mer än förslaget kan räkna med. Bemanna posten för hand; skrivningen prövas mot varje period.",
        ),
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

    it("says to a reader without HR-läs that a part of the proposal is judged on save, and only for a part (Roller i skolan)", async () => {
      const user = userEvent.setup();
      post.mockResolvedValue(proposal({ hrHidden: true }));
      renderDialog();
      await computeProposal(user);
      const note = /Ett urval av förslaget prövas när du sparar/;
      // Everything selected: the figures are the apply's own.
      expect(screen.queryByText(note)).toBeNull();
      await user.click(screen.getByRole("checkbox", { name: "Ta med NO för 7A" }));
      expect(screen.getByText(note)).toBeInTheDocument();
      // Nothing selected: nothing to save.
      await user.click(screen.getByRole("checkbox", { name: "Ta med alla förslag" }));
      await user.click(screen.getByRole("checkbox", { name: "Ta med alla förslag" }));
      expect(screen.queryByText(note)).toBeNull();
    });

    it("says nothing of it to a reader who sees the posts", async () => {
      const user = userEvent.setup();
      renderDialog();
      await computeProposal(user);
      await user.click(screen.getByRole("checkbox", { name: "Ta med NO för 7A" }));
      expect(screen.queryByText(/Ett urval av förslaget prövas när du sparar/)).toBeNull();
    });

    it("pins a row as it is and asks again without it", async () => {
      const user = userEvent.setup();
      renderDialog();
      await computeProposal(user);
      await user.click(screen.getByRole("button", { name: "Behåll som nu och beräkna om: Musik för 8B" }));
      await waitFor(() => expect(asks()).toHaveLength(2));
      expect(asks()[1]).toEqual({
        academicYearId: "y1",
        onlyUnstaffed: false,
        respectQualifications: true,
        pinnedRequirementIds: ["r-mu-8b"],
      });
    });

    it("names the keep button by its visible words first, then the row (WCAG 2.5.3)", async () => {
      const user = userEvent.setup();
      renderDialog();
      await computeProposal(user);
      const button = screen.getByRole("button", { name: "Behåll som nu och beräkna om: Musik för 8B" });
      expect(button).toHaveTextContent("Behåll som nu och beräkna om");
      expect(button.getAttribute("aria-label")).toMatch(new RegExp(`^${button.textContent}`));
    });

    it("marks each write with its route's areas, for the läsare's style rule (Läsbehörighet)", async () => {
      // #propose opens the dialog from a link, so the page's own button is not the only way in.
      const user = userEvent.setup();
      renderDialog();
      expect(screen.getByRole("button", { name: "Beräkna förslag" })).toHaveAttribute(
        "data-writes",
        "SCHEMALAGGNING DRIFT",
      );
      await computeProposal(user);
      expect(screen.getByRole("button", { name: "Behåll som nu och beräkna om: Musik för 8B" })).toHaveAttribute(
        "data-writes",
        "SCHEMALAGGNING DRIFT",
      );
      expect(screen.getByRole("button", { name: /^Tillämpa/ })).toHaveAttribute(
        "data-writes",
        "SCHEMALAGGNING PLANERING",
      );
    });

    it("takes a kept row out of the selection at once, so a recompute that fails cannot apply it", async () => {
      const user = userEvent.setup();
      let asked = 0;
      post.mockImplementation(async (path: string) => {
        if (path === APPLY) return applied();
        asked += 1;
        if (asked === 1) return proposal();
        throw new ApiError(429, "ThrottlerException: Too Many Requests");
      });
      renderDialog();
      await computeProposal(user);
      await user.click(screen.getByRole("button", { name: "Behåll som nu och beräkna om: Musik för 8B" }));
      await screen.findByRole("alert");
      expect(screen.getByRole("checkbox", { name: "Ta med Musik för 8B" })).not.toBeChecked();
      await user.click(screen.getByRole("button", { name: "Tillämpa 2 valda" }));
      await waitFor(() => expect(applies()).toHaveLength(1));
      expect(applies()[0]!.changes.map((change: { requirementId: string }) => change.requirementId)).toEqual([
        "r-ma-7a",
        "r-no-7a",
      ]);
    });

    it("keeps a row the admin left out left out when another row is kept and the proposal asked again", async () => {
      const user = userEvent.setup();
      renderDialog();
      await computeProposal(user);
      await user.click(screen.getByRole("checkbox", { name: "Ta med NO för 7A" }));
      await user.click(screen.getByRole("button", { name: "Behåll som nu och beräkna om: Musik för 8B" }));
      await waitFor(() => expect(asks()).toHaveLength(2));
      // The same answer comes back (the stub ignores pins): NO 7A stays out.
      await waitFor(() => expect(screen.getByRole("checkbox", { name: "Ta med Matematik för 7A" })).toBeChecked());
      expect(screen.getByRole("checkbox", { name: "Ta med NO för 7A" })).not.toBeChecked();
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

    it("names the warnings an undo is saved with, as an apply's", async () => {
      const user = userEvent.setup();
      post.mockImplementation(async (path: string, body: { undo?: boolean }) => {
        if (path === PROPOSE) return proposal();
        if (!body.undo) return applied();
        return applied({
          warnings: [
            {
              code: "STAFF_TEACHER_NOT_QUALIFIED",
              params: { role: "TEACHER", subject: "Musik", grades: "8" },
              userId: "t-gone",
              requirementIds: ["r-mu-8b"],
            },
          ],
        });
      });
      renderDialog();
      await computeProposal(user);
      await user.click(screen.getByRole("button", { name: "Tillämpa 3 valda" }));
      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      await pressUndo();
      await waitFor(() => expect(toast.warning).toHaveBeenCalled());
      expect(toast.warning).toHaveBeenLastCalledWith("Bemanningen är som före förslaget.", {
        description: "Gun Gone (Musik för 8B): Läraren saknar behörighet i Musik för åk 8.",
      });
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

    /**
     * The body the gateway answers when an undo would leave a placed lesson nobody's: params exactly as the API's
     * e2e asserts them through the real exception filter (test/planning.e2e-spec.ts, "an undo that would leave a
     * förläggning nobody’s"), with this file's post id.
     */
    const placementRefused = () =>
      new ApiError(409, "Förläggningen tisdag 10:00–11:00 måste ändras först. …", "REQUIREMENT_PLACEMENTS_DO_NOT_FIT", {
        reason: "NO_TEACHER",
        day: 2,
        start: "10:00",
        end: "11:00",
        weeks: "ODD_WEEKS",
        requirementId: "r-mu-8b",
      });

    it("names the post and the placement to change first when an apply would leave a placed lesson without its teacher, and says no post was 'not saved'", async () => {
      const user = userEvent.setup();
      post.mockImplementation(async (path: string) => {
        if (path === PROPOSE) return proposal();
        throw placementRefused();
      });
      renderDialog();
      await computeProposal(user);
      await user.click(screen.getByRole("button", { name: "Tillämpa 3 valda" }));

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(
        "Musik för 8B: Förläggningen tisdag 10:00–11:00 (udda veckor) måste ändras eller tas bort först. ",
      );
      expect(alert).not.toHaveTextContent("sparades inte");
      expect(screen.getByText("Förslag per post")).toBeInTheDocument();
    });

    it("names the post and the placement when an undo is refused for a placed lesson", async () => {
      const user = userEvent.setup();
      post.mockImplementation(async (path: string, body: { undo?: boolean }) => {
        if (path === PROPOSE) return proposal();
        if (body.undo) throw placementRefused();
        return applied();
      });
      renderDialog();
      await computeProposal(user);
      await user.click(screen.getByRole("button", { name: "Tillämpa 3 valda" }));
      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      await pressUndo();
      const said = (toast.error as Mock).mock.calls.at(-1)![0] as string;
      expect(said).toMatch(/^Kunde inte ångra: Musik för 8B: Förläggningen tisdag 10:00–11:00 \(udda veckor\) måste ändras eller tas bort först\. /);
      expect(said).not.toContain("sparades inte");
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

  /**
   * Musik 8B (Gun has left) to Anna gives her a subject she does not teach and the years 8 and 9 of a mixed group;
   * NO 7A (a post Cilla leads, released) to Bo gives him year 7; Matematik 7A to Anna gives nothing new.
   */
  const withNewTeaching = (overrides: Partial<StaffingProposal> = {}) => {
    const base = proposal();
    return proposal({
      assignments: [
        base.assignments[0]!,
        { ...base.assignments[1]!, newTeaching: { subject: true, years: [8, 9] } },
        { ...base.assignments[2]!, newTeaching: { subject: false, years: [7] } },
      ],
      ...overrides,
    });
  };
  const useNewTeaching = () => post.mockImplementation(async (path: string) => (path === PROPOSE ? withNewTeaching() : applied()));
  const NEW_BODY = {
    academicYearId: "y1",
    basisSha256: BASIS,
    changes: [
      { requirementId: "r-ma-7a", fromTeacherId: null, toTeacherId: "t-anna" },
      { requirementId: "r-mu-8b", fromTeacherId: "t-gone", toTeacherId: "t-anna" },
      { requirementId: "r-no-7a", fromTeacherId: "t-cilla", toTeacherId: "t-bo" },
    ],
    confirmedNewTeaching: [
      { requirementId: "r-mu-8b", toTeacherId: "t-anna" },
      { requirementId: "r-no-7a", toTeacherId: "t-bo" },
    ],
  };

  describe("released posts, and what a row gives its teacher", () => {
    it("marks a post whose teacher the school chose with 'Släppt för motorn', and no post that is open anyway", async () => {
      const user = userEvent.setup();
      renderDialog();
      await computeProposal(user);
      const row = (name: string) => screen.getByRole("checkbox", { name: `Ta med ${name}` }).closest("tr") as HTMLElement;
      // Cilla is staff: her post is moved because the school released it.
      expect(within(row("NO för 7A")).getByText("Släppt för motorn")).toBeInTheDocument();
      // Gun has left, and Matematik 7A has nobody: open to the engine, nothing was released.
      expect(within(row("Musik för 8B")).queryByText("Släppt för motorn")).toBeNull();
      expect(within(row("Matematik för 7A")).queryByText("Släppt för motorn")).toBeNull();
    });

    it("marks a row that gives its teacher a new subject, new years, or both, and no row that gives nothing", async () => {
      const user = userEvent.setup();
      useNewTeaching();
      renderDialog();
      await computeProposal(user);
      const row = (name: string) => screen.getByRole("checkbox", { name: `Ta med ${name}` }).closest("tr") as HTMLElement;
      expect(within(row("Musik för 8B")).getByText("Nytt ämne")).toBeInTheDocument();
      expect(within(row("Musik för 8B")).getByText("Nya årskurser 8, 9")).toBeInTheDocument();
      expect(within(row("NO för 7A")).getByText("Ny årskurs 7")).toBeInTheDocument();
      expect(within(row("NO för 7A")).queryByText("Nytt ämne")).toBeNull();
      expect(within(row("Matematik för 7A")).queryByText(/Nytt ämne|Ny årskurs|Nya årskurser/)).toBeNull();
    });

    it("says how many selected changes are confirmed separately, following the selection", async () => {
      const user = userEvent.setup();
      useNewTeaching();
      renderDialog();
      await computeProposal(user);
      expect(
        screen.getByText("2 valda ändringar ger lärare ny undervisning och bekräftas särskilt innan de tillämpas."),
      ).toBeInTheDocument();
      await user.click(screen.getByRole("checkbox", { name: "Ta med NO för 7A" }));
      expect(
        screen.getByText("1 vald ändring ger en lärare ny undervisning och bekräftas särskilt innan den tillämpas."),
      ).toBeInTheDocument();
      await user.click(screen.getByRole("checkbox", { name: "Ta med Musik för 8B" }));
      expect(screen.queryByText(/bekräftas särskilt/)).toBeNull();
    });

    it("says how many posts are released, and that they were left as they are when only the unstaffed were asked for", async () => {
      const user = userEvent.setup();
      const base = proposal();
      post.mockResolvedValue(proposal({ counts: { ...base.counts, releasedRequirements: 3 } }));
      renderDialog();
      await computeProposal(user);
      expect(screen.getByText("3 poster är släppta för motorn.")).toBeInTheDocument();
      expect(screen.queryByText(/lämnas som de är/)).toBeNull();
      await user.click(screen.getByRole("button", { name: "Ändra val" }));

      post.mockResolvedValue(
        proposal({ options: { ...base.options, onlyUnstaffed: true }, counts: { ...base.counts, releasedRequirements: 1 } }),
      );
      await computeProposal(user);
      expect(
        screen.getByText("1 post är släppt för motorn men lämnas som den är, eftersom du valde bara obemannade poster."),
      ).toBeInTheDocument();
      expect(screen.queryByText("1 post är släppt för motorn.")).toBeNull();
    });

    it("says nothing of releases when none are made, and points to the card when there is nothing to propose", async () => {
      const user = userEvent.setup();
      const base = proposal();
      post.mockResolvedValue(
        proposal({ assignments: [], unstaffed: [], conflicts: [], counts: { ...base.counts, freeRequirements: 0 } }),
      );
      renderDialog();
      await user.click(screen.getByRole("button", { name: "Beräkna förslag" }));
      expect(await screen.findByText("Det finns inget att föreslå: varje post är bemannad eller låst.")).toBeInTheDocument();
      expect(screen.queryByText(/är släppt|är släppta/)).toBeNull();
      expect(screen.getByText(/släpp posten under Släppta poster på den här sidan/)).toBeInTheDocument();
    });

    it("does not point to the card once something is released", async () => {
      const user = userEvent.setup();
      const base = proposal();
      post.mockResolvedValue(
        proposal({ assignments: [], unstaffed: [], conflicts: [], counts: { ...base.counts, freeRequirements: 0, releasedRequirements: 2 } }),
      );
      renderDialog();
      await user.click(screen.getByRole("button", { name: "Beräkna förslag" }));
      expect(await screen.findByText("2 poster är släppta för motorn.")).toBeInTheDocument();
      expect(screen.getByText("Det finns inget att föreslå: varje post är bemannad eller låst.")).toBeInTheDocument();
      expect(screen.queryByText(/släpp posten under Släppta poster/)).toBeNull();
    });
  });

  describe("the second confirmation of new teaching", () => {
    it("writes nothing when Tillämpa is pressed over a row that gives new teaching: it asks first, row by row", async () => {
      const user = userEvent.setup();
      useNewTeaching();
      const { onOpenChange } = renderDialog();
      await computeProposal(user);
      await user.click(screen.getByRole("button", { name: "Tillämpa 3 valda" }));

      expect(applies()).toEqual([]);
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(await screen.findByRole("heading", { name: "Bekräfta ny undervisning" })).toBeInTheDocument();
      expect(
        screen.getByText(
          "Förslaget ger några lärare ett ämne eller en årskurs de inte undervisar i i dag. Ta det med läraren innan du godkänner.",
        ),
      ).toBeInTheDocument();
      const lines = within(screen.getByRole("list")).getAllByRole("listitem").map((item) => item.textContent);
      expect(lines).toEqual([
        "Anna Berg: Musik för 8B — nytt ämne och nya årskurser 8, 9",
        "Bo Alm: NO för 7A — ny årskurs 7",
      ]);
      // Matematik 7A gives nothing new and is not listed, but is applied in the same request: said, as a number.
      expect(screen.getByText("Ytterligare 1 vald ändring tillämpas samtidigt.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Tillbaka" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Bekräfta och tillämpa 3 valda" })).toBeEnabled();
      // The proposal's own table is behind the step.
      expect(screen.queryByText("Förslag per post")).toBeNull();
    });

    it("moves focus to the step's heading, so a screen reader starts at the question", async () => {
      const user = userEvent.setup();
      useNewTeaching();
      renderDialog();
      await computeProposal(user);
      await user.click(screen.getByRole("button", { name: "Tillämpa 3 valda" }));
      const heading = await screen.findByRole("heading", { name: "Bekräfta ny undervisning" });
      await waitFor(() => expect(heading).toHaveFocus());
      // The step is a region named by its heading.
      expect(screen.getByRole("region", { name: "Bekräfta ny undervisning" })).toBeInTheDocument();
    });

    it("sends the changes with confirmedNewTeaching only from its own button: exactly the rows that give new teaching", async () => {
      const user = userEvent.setup();
      useNewTeaching();
      const { onOpenChange } = renderDialog();
      await computeProposal(user);
      await user.click(screen.getByRole("button", { name: "Tillämpa 3 valda" }));
      await user.click(await screen.findByRole("button", { name: "Bekräfta och tillämpa 3 valda" }));
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
      // One request: the ordinary change rides along unconfirmed, the other two are named with the teacher they go to.
      expect(applies()).toEqual([NEW_BODY]);
      expect(toast.success).toHaveBeenCalledWith("3 poster fick en ny lärare.", expect.anything());
    });

    it("lists only the selected rows, and confirms only those", async () => {
      const user = userEvent.setup();
      useNewTeaching();
      renderDialog();
      await computeProposal(user);
      await user.click(screen.getByRole("checkbox", { name: "Ta med Musik för 8B" }));
      await user.click(screen.getByRole("button", { name: "Tillämpa 2 valda" }));
      const lines = within(await screen.findByRole("list")).getAllByRole("listitem").map((item) => item.textContent);
      expect(lines).toEqual(["Bo Alm: NO för 7A — ny årskurs 7"]);
      await user.click(screen.getByRole("button", { name: "Bekräfta och tillämpa 2 valda" }));
      await waitFor(() => expect(applies()).toHaveLength(1));
      expect(applies()[0]).toEqual({
        ...NEW_BODY,
        changes: [NEW_BODY.changes[0], NEW_BODY.changes[2]],
        confirmedNewTeaching: [NEW_BODY.confirmedNewTeaching[1]],
      });
    });

    it("applies at once, as before, when no selected row gives new teaching", async () => {
      const user = userEvent.setup();
      useNewTeaching();
      const { onOpenChange } = renderDialog();
      await computeProposal(user);
      await user.click(screen.getByRole("checkbox", { name: "Ta med Musik för 8B" }));
      await user.click(screen.getByRole("checkbox", { name: "Ta med NO för 7A" }));
      await user.click(screen.getByRole("button", { name: "Tillämpa 1 vald" }));
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
      expect(screen.queryByRole("heading", { name: "Bekräfta ny undervisning" })).toBeNull();
      // No confirmedNewTeaching at all: the request is what it was before the step existed.
      expect(applies()).toEqual([
        {
          academicYearId: "y1",
          basisSha256: BASIS,
          changes: [{ requirementId: "r-ma-7a", fromTeacherId: null, toTeacherId: "t-anna" }],
        },
      ]);
    });

    it("asks nothing of a proposal that gives nobody new teaching", async () => {
      const user = userEvent.setup();
      renderDialog();
      await computeProposal(user);
      expect(screen.queryByText(/bekräftas särskilt/)).toBeNull();
      await user.click(screen.getByRole("button", { name: "Tillämpa 3 valda" }));
      await waitFor(() => expect(applies()).toHaveLength(1));
      expect(applies()[0]).not.toHaveProperty("confirmedNewTeaching");
    });

    it("goes back with Tillbaka to the proposal as it was, the selection kept, nothing written, focus on Tillämpa", async () => {
      const user = userEvent.setup();
      useNewTeaching();
      const { onOpenChange } = renderDialog();
      await computeProposal(user);
      await user.click(screen.getByRole("checkbox", { name: "Ta med Matematik för 7A" }));
      await user.click(screen.getByRole("button", { name: "Tillämpa 2 valda" }));
      await user.click(await screen.findByRole("button", { name: "Tillbaka" }));

      expect(screen.getByText("Förslag per post")).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Bekräfta ny undervisning" })).toBeNull();
      expect(screen.getByRole("checkbox", { name: "Ta med Matematik för 7A" })).not.toBeChecked();
      expect(screen.getByRole("checkbox", { name: "Ta med Musik för 8B" })).toBeChecked();
      await waitFor(() => expect(screen.getByRole("button", { name: "Tillämpa 2 valda" })).toHaveFocus());
      expect(applies()).toEqual([]);
      expect(onOpenChange).not.toHaveBeenCalled();
    });

    it("goes back with Escape, and closes the dialog only on the next one", async () => {
      const user = userEvent.setup();
      useNewTeaching();
      const { onOpenChange } = renderDialog();
      await computeProposal(user);
      await user.click(screen.getByRole("button", { name: "Tillämpa 3 valda" }));
      await screen.findByRole("heading", { name: "Bekräfta ny undervisning" });

      await user.keyboard("{Escape}");
      expect(await screen.findByText("Förslag per post")).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Bekräfta ny undervisning" })).toBeNull();
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(applies()).toEqual([]);

      await user.keyboard("{Escape}");
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it("marks the confirming button with the areas of the apply, as Tillämpa is", async () => {
      const user = userEvent.setup();
      useNewTeaching();
      renderDialog();
      await computeProposal(user);
      await user.click(screen.getByRole("button", { name: "Tillämpa 3 valda" }));
      expect(await screen.findByRole("button", { name: "Bekräfta och tillämpa 3 valda" })).toHaveAttribute(
        "data-writes",
        "SCHEMALAGGNING PLANERING",
      );
    });

    it("holds both buttons while the apply is on its way", async () => {
      const user = userEvent.setup();
      let finish: (value: StaffingApplyResult) => void = () => {};
      post.mockImplementation((path: string) =>
        path === PROPOSE ? Promise.resolve(withNewTeaching()) : new Promise((done) => (finish = done)),
      );
      renderDialog();
      await computeProposal(user);
      await user.click(screen.getByRole("button", { name: "Tillämpa 3 valda" }));
      await user.click(await screen.findByRole("button", { name: "Bekräfta och tillämpa 3 valda" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Bekräfta och tillämpa 3 valda" })).toBeDisabled());
      expect(screen.getByRole("button", { name: "Tillbaka" })).toBeDisabled();
      finish(applied());
      await waitFor(() => expect(toast.success).toHaveBeenCalled());
    });

    it("leaves the undo as it was: the toast's Ångra puts back what was, with no confirmation", async () => {
      const user = userEvent.setup();
      useNewTeaching();
      renderDialog();
      await computeProposal(user);
      await user.click(screen.getByRole("button", { name: "Tillämpa 3 valda" }));
      await user.click(await screen.findByRole("button", { name: "Bekräfta och tillämpa 3 valda" }));
      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      await pressUndo();
      expect(applies()[1]).toEqual({
        academicYearId: "y1",
        basisSha256: BASIS_AFTER,
        undo: true,
        changes: [
          { requirementId: "r-ma-7a", fromTeacherId: "t-anna", toTeacherId: null },
          { requirementId: "r-mu-8b", fromTeacherId: "t-anna", toTeacherId: "t-gone" },
          { requirementId: "r-no-7a", fromTeacherId: "t-bo", toTeacherId: "t-cilla" },
        ],
      });
      expect(applies()[1]).not.toHaveProperty("confirmedNewTeaching");
      expect(toast.success).toHaveBeenLastCalledWith("Bemanningen är som före förslaget.");
    });

    it("says in words when the gateway still wants a confirmation, and stays in the step", async () => {
      const user = userEvent.setup();
      post.mockImplementation(async (path: string) => {
        if (path === PROPOSE) return withNewTeaching();
        throw new ApiError(409, "Förslaget ger 2 ändringar …", "STAFF_NEW_TEACHING_UNCONFIRMED", {
          count: 2,
          requirementId: "r-mu-8b",
          userId: "t-anna",
          newSubject: 1,
          newYears: "8,9",
        });
      });
      const { onOpenChange } = renderDialog();
      await computeProposal(user);
      await user.click(screen.getByRole("button", { name: "Tillämpa 3 valda" }));
      await user.click(await screen.findByRole("button", { name: "Bekräfta och tillämpa 3 valda" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Förslaget ger 2 ändringar ny undervisning som inte är bekräftad. Ingenting sparades. Gå tillbaka och beräkna ett nytt förslag.",
      );
      // Still the step: the admin chooses to go back, and nothing was closed or written.
      expect(screen.getByRole("heading", { name: "Bekräfta ny undervisning" })).toBeInTheDocument();
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Bekräfta och tillämpa 3 valda" })).toBeEnabled();
    });

    it("says a post the school chose and has not released, with its row named, and keeps the proposal", async () => {
      const user = userEvent.setup();
      post.mockImplementation(async (path: string) => {
        if (path === PROPOSE) return proposal();
        throw new ApiError(409, "NO för 7A har en lärare …", "STAFF_ROW_NOT_RELEASED", { requirementId: "r-no-7a" });
      });
      renderDialog();
      await computeProposal(user);
      await user.click(screen.getByRole("button", { name: "Tillämpa 3 valda" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "NO för 7A: Posten har en lärare som skolan valt och är inte släppt för motorn. Ingenting sparades.",
      );
      expect(screen.getByText("Förslag per post")).toBeInTheDocument();
      expect(toast.error).not.toHaveBeenCalled();
    });

    it("says it without a row when the gateway names none the dialog knows", async () => {
      const user = userEvent.setup();
      post.mockImplementation(async (path: string) => {
        if (path === PROPOSE) return proposal();
        throw new ApiError(409, "…", "STAFF_ROW_NOT_RELEASED", { requirementId: "r-elsewhere" });
      });
      renderDialog();
      await computeProposal(user);
      await user.click(screen.getByRole("button", { name: "Tillämpa 3 valda" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        /^Posten har en lärare som skolan valt och är inte släppt för motorn\. Ingenting sparades\.$/,
      );
    });

    it("goes back to the options on a stale basis from the step, saying nothing was saved", async () => {
      const user = userEvent.setup();
      post.mockImplementation(async (path: string) => {
        if (path === PROPOSE) return withNewTeaching();
        throw new ApiError(409, "Tjänstefördelningen har ändrats sedan förslaget beräknades.", "STAFF_PROPOSAL_STALE");
      });
      renderDialog();
      await computeProposal(user);
      await user.click(screen.getByRole("button", { name: "Tillämpa 3 valda" }));
      await user.click(await screen.findByRole("button", { name: "Bekräfta och tillämpa 3 valda" }));
      expect(await screen.findByText(/Ingenting sparades\. Beräkna ett nytt förslag\./)).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Bekräfta ny undervisning" })).toBeNull();
      expect(screen.getByRole("button", { name: "Beräkna om" })).toBeEnabled();
    });

    it("starts from the first step again when the dialog is closed from the step and opened for a new proposal", async () => {
      const user = userEvent.setup();
      useNewTeaching();
      const { onOpenChange } = renderDialog();
      await computeProposal(user);
      await user.click(screen.getByRole("button", { name: "Tillämpa 3 valda" }));
      await screen.findByRole("heading", { name: "Bekräfta ny undervisning" });
      // The X of the dialog: the step does not survive into the next proposal.
      await user.click(screen.getByRole("button", { name: "Stäng" }));
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(screen.queryByRole("heading", { name: "Bekräfta ny undervisning" })).toBeNull();
      expect(screen.getByRole("button", { name: "Beräkna förslag" })).toBeInTheDocument();
    });

    it("says it in English", async () => {
      const user = userEvent.setup();
      useNewTeaching();
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={queryClient}>
          <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Stockholm" onError={(error) => { throw error; }}>
            <StaffingProposalDialog
              open
              onOpenChange={vi.fn()}
              academicYearId="y1"
              academicYearName="2026/27"
              teachersWithTarget={2}
              teachersTotal={4}
              qualificationsRecorded
              policy={{ qualificationMode: "WARN", overAllocationTolerancePercent: 10 }}
              teacherName={(id) => names[id] ?? id}
              groupName={(id) => groups[id] ?? "—"}
              subjectName={(id) => subjects[id] ?? "—"}
              onOpenSettings={vi.fn()}
            />
          </NextIntlClientProvider>
        </QueryClientProvider>,
      );
      await user.click(screen.getByRole("button", { name: "Compute proposal" }));
      await screen.findByText("Proposal per entry");
      await user.click(screen.getByRole("button", { name: "Apply 3 selected" }));
      expect(await screen.findByRole("heading", { name: "Confirm new teaching" })).toBeInTheDocument();
      expect(
        within(screen.getByRole("list")).getAllByRole("listitem").map((item) => item.textContent),
      ).toEqual([
        "Anna Berg: Musik for 8B — new subject and new year groups 8, 9",
        "Bo Alm: NO for 7A — new year group 7",
      ]);
      expect(screen.getByRole("button", { name: "Confirm and apply 3 selected" })).toBeInTheDocument();
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
      [
        "the proposal throttle",
        new ApiError(429, "ThrottlerException: Too Many Requests"),
        "Du har beräknat många förslag på kort tid. Vänta en minut och försök igen.",
      ],
      [
        "a school with more staff than the engine takes",
        new ApiError(400, "Förslaget skulle väga …", "STAFF_PROPOSAL_TOO_MANY", {
          teachers: 1005,
          requirements: 12,
          limitTeachers: 1000,
          limitRequirements: 5000,
        }),
        "Förslaget skulle väga 1005 lärare och 12 timplansposter, men motorn tar högst 1000 lärare och 5000 poster åt gången. Behåll de poster som är klara som de är och försök igen.",
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
