import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PeoplePage from "./page";

/**
 * Mounts the real page, for the same reason as the groups page test: the
 * filtering rules are covered in lib, but only rendering catches a render-time
 * crash — a `const` referenced from a useMemo above its own declaration throws
 * and TypeScript does not see it across the callback.
 */

const groups = [
  { id: "g-7a", academicYearId: "year-1", name: "7A", kind: "CLASS", gradeLevel: 7 },
  { id: "g-7b", academicYearId: "year-1", name: "7B", kind: "CLASS", gradeLevel: 7 },
  {
    id: "g-ma71",
    academicYearId: "year-1",
    name: "Ma71",
    kind: "TEACHING_GROUP",
    gradeLevel: null,
  },
  // Next year's 8A — this year's 7A, rolled over and not yet activated. Same
  // name as a class pupils will move into, in a year nobody is in yet.
  { id: "g-next-8a", academicYearId: "year-2", name: "8A", kind: "CLASS", gradeLevel: 8 },
];

const person = (
  id: string,
  firstName: string,
  lastName: string,
  role: string,
  studentGroupId: string | null,
  invitedAt: string | null = null,
) => ({
  id,
  role,
  firstName,
  lastName,
  email: `${firstName.toLowerCase()}@skolan.se`,
  phone: null,
  isActive: true,
  invitedAt,
  studentGroupId,
});

const people = [
  person("st-1", "Alma", "Berg", "STUDENT", "g-7a"),
  person("st-2", "Nils", "Ek", "STUDENT", "g-7b"),
  person("t-1", "Karin", "Ek", "TEACHER", null, "2026-08-01T10:00:00.000Z"),
  // Already invited, so the bulk-invitation count below keeps its meaning. She
  // is here for the undervisande rektor: SCHOOL_ADMIN in this schema, named by
  // the timplan like anybody else, and therefore owed a working time too.
  person("a-1", "Rita", "Nilsson", "SCHOOL_ADMIN", null, "2026-08-01T10:00:00.000Z"),
];

/** Alma takes Ma71 on top of her home class; Nils takes nothing extra. */
const memberships = [{ studentId: "st-1", studentGroupId: "g-ma71" }];

const requirements = [
  {
    id: "req-1",
    academicYearId: "year-1",
    subjectId: "sub-ma",
    studentGroupId: "g-ma71",
    teacherId: "t-1",
    coTeacherId: null,
    lessonsPerWeek: 3,
    minutesPerLesson: 60,
  },
];

/**
 * Karin's working time, when a test gives her one. Held outside the factory
 * because `vi.mock` is hoisted above every `const` in this file.
 */
const state = vi.hoisted(() => ({
  workRules: [] as unknown[],
  employments: [] as unknown[],
  qualifications: [] as unknown[],
  duties: [] as unknown[],
}));

const { saveEmployment, createPerson } = vi.hoisted(() => ({
  saveEmployment: vi.fn(),
  createPerson: vi.fn(),
}));

vi.mock("@/lib/queries", () => ({
  usePeople: () => ({ data: people, isLoading: false }),
  useTeacherWorkRules: () => ({ data: state.workRules }),
  useTeacherWorkRuleActions: () => ({
    save: { mutateAsync: vi.fn(), isPending: false },
    remove: { mutateAsync: vi.fn(), isPending: false },
  }),
  useGroups: () => ({ data: groups }),
  useGroupMemberships: () => ({ data: memberships }),
  useAcademicYears: () => ({
    data: [
      { id: "year-1", name: "2026/2027", isActive: true },
      { id: "year-2", name: "2027/2028", isActive: false },
    ],
  }),
  useRequirements: () => ({ data: requirements }),
  useSubjects: () => ({ data: [{ id: "sub-ma", name: "Matematik", code: "MA", color: "#123456", requiredRoomTypeId: null }] }),
  useStudentGuardians: () => ({ data: [] }),
  useGuardianLinkActions: () => ({
    create: { mutateAsync: vi.fn(), isPending: false },
    remove: { mutateAsync: vi.fn(), isPending: false },
  }),
  useInvitations: () => ({
    inviteOne: { mutateAsync: vi.fn(), isPending: false },
    inviteMany: { mutateAsync: vi.fn(), isPending: false },
  }),
  useCrudMutations: () => ({
    create: { mutateAsync: createPerson, isPending: false },
    update: { mutateAsync: vi.fn(), isPending: false },
    remove: { mutateAsync: vi.fn(), isPending: false },
  }),
}));

// The staffing hooks come from their own module, so the page's own chunk
// does not carry them onto routes that never read them.
vi.mock("@/lib/staffing-queries", () => ({
  useTeacherEmployments: () => ({ data: state.employments }),
  useTeacherQualifications: () => ({ data: state.qualifications }),
  useStaffingPolicy: () => ({ data: null, isSuccess: true }),
  useTeacherEmploymentActions: () => ({
    save: { mutateAsync: saveEmployment, isPending: false },
    remove: { mutateAsync: vi.fn(), isPending: false },
  }),
  useReplaceTeacherQualifications: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTeacherDuties: (academicYearId: string, userId: string) => ({
    data: userId === "t-1" ? state.duties : [],
    isLoading: false,
    isError: false,
  }),
  useTeacherDutyActions: () => ({
    create: { mutateAsync: vi.fn(), isPending: false },
    update: { mutateAsync: vi.fn(), isPending: false },
    remove: { mutateAsync: vi.fn(), isPending: false },
  }),
}));

vi.mock("@/components/import/csv-import-dialog", () => ({
  CsvImportDialog: () => null,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("next-intl", () => ({
  // DateField reads the active locale for its month and weekday names.
  useLocale: () => "sv",
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}(${Object.values(values).join("|")})` : key;
    return t;
  },
}));

const rowNames = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0]?.textContent ?? "");

const searchBox = () => screen.getByRole("textbox", { name: "searchPlaceholder" });

describe("People page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.workRules = [];
    state.employments = [];
    state.qualifications = [];
    state.duties = [];
    saveEmployment.mockResolvedValue(undefined);
    createPerson.mockResolvedValue({ id: "t-new" });
  });

  it("renders without crashing and lists everybody", () => {
    render(<PeoplePage />);

    expect(rowNames()).toHaveLength(4);
  });

  it("searches by name", async () => {
    const user = userEvent.setup();
    render(<PeoplePage />);

    await user.type(searchBox(), "alma");

    expect(rowNames()).toEqual(["Alma Berg"]);
  });

  it("searches by email", async () => {
    const user = userEvent.setup();
    render(<PeoplePage />);

    await user.type(searchBox(), "nils@skolan");

    expect(rowNames()).toEqual(["Nils Ek"]);
  });

  it("searches by class, so a whole class can be pulled up at once", async () => {
    const user = userEvent.setup();
    render(<PeoplePage />);

    await user.type(searchBox(), "7b");

    expect(rowNames()).toEqual(["Nils Ek"]);
  });

  it("combines terms across fields in any order", async () => {
    const user = userEvent.setup();
    render(<PeoplePage />);

    await user.type(searchBox(), "7a alma");

    expect(rowNames()).toEqual(["Alma Berg"]);
  });

  it("scopes the bulk invitation to what the search leaves on screen", async () => {
    // Deliberate: search a class, invite that class. The count in the label
    // has to follow the same list, or the button would lie about its reach.
    const user = userEvent.setup();
    render(<PeoplePage />);

    // Two of the three have never been invited; Karin has.
    expect(screen.getByText("inviteAll(2)")).toBeInTheDocument();

    await user.type(searchBox(), "alma");
    expect(screen.getByText("inviteAll(1)")).toBeInTheDocument();
  });
  describe("clicking a person's name", () => {
    /*
     * Anchored. The row's action buttons name the person too — "Ändra arbetstid
     * för Karin Ek" — so an unanchored pattern matches the expander and the
     * working-time button both, and every query through this helper fails with a
     * message about ambiguity rather than about the panel.
     */
    const nameButton = (name: string) =>
      screen.getByRole("button", { name: new RegExp(`^${name}$`) });

    it("reveals nothing until the name is clicked", () => {
      render(<PeoplePage />);

      expect(screen.queryByText("teachingGroupsLabel")).not.toBeInTheDocument();
    });

    it("shows a student's home class and teaching groups", async () => {
      const user = userEvent.setup();
      render(<PeoplePage />);

      await user.click(nameButton("Alma Berg"));

      // Scoped to the panel the button says it controls: "7A" also appears in
      // her class column, so an unscoped query would pass without the panel.
      const detail = document.getElementById("person-detail-st-1");
      expect(detail).not.toBeNull();
      expect(within(detail!).getByText("homeClassLabel")).toBeInTheDocument();
      expect(within(detail!).getByText("7A")).toBeInTheDocument();
      expect(within(detail!).getByText("Ma71")).toBeInTheDocument();
    });

    it("says plainly when a student is in no teaching group", async () => {
      const user = userEvent.setup();
      render(<PeoplePage />);

      await user.click(nameButton("Nils Ek"));

      expect(screen.getByText("noTeachingGroups")).toBeInTheDocument();
    });

    it("shows what a teacher teaches instead — the same question, staff side", async () => {
      const user = userEvent.setup();
      render(<PeoplePage />);

      await user.click(nameButton("Karin Ek"));

      expect(screen.getByText("teachesLabel")).toBeInTheDocument();
      expect(screen.getByText(/Ma71 · Matematik/)).toBeInTheDocument();
    });

    it("closes again on a second click", async () => {
      const user = userEvent.setup();
      render(<PeoplePage />);

      await user.click(nameButton("Alma Berg"));
      expect(screen.getByText("teachingGroupsLabel")).toBeInTheDocument();

      await user.click(nameButton("Alma Berg"));
      expect(screen.queryByText("teachingGroupsLabel")).not.toBeInTheDocument();
    });

    it("keeps only one row open at a time", async () => {
      const user = userEvent.setup();
      render(<PeoplePage />);

      await user.click(nameButton("Alma Berg"));
      await user.click(nameButton("Nils Ek"));

      // Alma's groups are gone; Nils's empty-state line is what shows now.
      expect(screen.queryByText("Ma71")).not.toBeInTheDocument();
      expect(screen.getByText("noTeachingGroups")).toBeInTheDocument();
    });

    it("marks the control as expanded for screen readers", async () => {
      const user = userEvent.setup();
      render(<PeoplePage />);

      const button = nameButton("Alma Berg");
      expect(button).toHaveAttribute("aria-expanded", "false");

      await user.click(button);
      expect(nameButton("Alma Berg")).toHaveAttribute("aria-expanded", "true");
    });

    it("stretches the panel across every column of the table", async () => {
      // colSpan is the one thing about this panel that neither TypeScript nor
      // the assertions above can catch: any number compiles, and a panel one
      // column short still renders its content. Read the count off the header
      // rather than writing it down, so an eighth column fails here instead of
      // quietly leaving the panel short of the table's edge again.
      const user = userEvent.setup();
      render(<PeoplePage />);

      await user.click(nameButton("Alma Berg"));

      const columns = within(screen.getAllByRole("row")[0]).getAllByRole(
        "columnheader",
      ).length;
      const panelCell = document
        .getElementById("person-detail-st-1")!
        .querySelector("td")!;
      expect(panelCell.colSpan).toBe(columns);
    });

    /**
     * A teacher's working time is administered from their own row, the way a
     * student's guardians are. What only this page can get wrong is the pairing:
     * the rule is looked up by userId out of a table that holds a row for almost
     * nobody, so an off-by-one lookup would show one teacher another's lunch.
     */
    describe("a teacher's working time", () => {
      const workRule = {
        id: "w-1",
        userId: "t-1",
        lunchMinutes: 30,
        lunchStartTime: "10:30:00",
        lunchEndTime: "13:30:00",
        minDailyRestMinutes: 660,
      };

      it("says plainly when a teacher has none — not four zeroes", async () => {
        const user = userEvent.setup();
        render(<PeoplePage />);

        await user.click(nameButton("Karin Ek"));

        expect(screen.getByText("workTimeLabel")).toBeInTheDocument();
        expect(screen.getByText("noRule")).toBeInTheDocument();
      });

      it("reads the stored rule back beside what the teacher teaches", async () => {
        state.workRules = [workRule];
        const user = userEvent.setup();
        render(<PeoplePage />);

        await user.click(nameButton("Karin Ek"));

        expect(screen.getByText("summaryLunch(30|10:30|13:30)")).toBeInTheDocument();
        expect(screen.getByText("summaryRestHours(11)")).toBeInTheDocument();
      });

      it("is reachable from a teacher's row and from no pupil's", () => {
        render(<PeoplePage />);

        expect(
          screen.getByRole("button", { name: "editFor(Karin Ek)" }),
        ).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "editFor(Alma Berg)" })).toBeNull();
      });

      it("is reachable from the undervisande rektor's row too", () => {
        /*
         * She carries SCHOOL_ADMIN in this schema and the timplan names her like
         * anybody else, so she has a last lesson for a night to follow. The
         * gateway's assertIsStaff admits her; offering the rule to TEACHER only
         * would leave her the one member of staff the UI cannot give one.
         */
        render(<PeoplePage />);

        expect(
          screen.getByRole("button", { name: "editFor(Rita Nilsson)" }),
        ).toBeInTheDocument();
      });

      it("shows the rektor's rule without claiming she has a timplan", async () => {
        state.workRules = [{ ...workRule, id: "w-2", userId: "a-1" }];
        const user = userEvent.setup();
        render(<PeoplePage />);

        await user.click(nameButton("Rita Nilsson"));

        expect(screen.getByText("workTimeLabel")).toBeInTheDocument();
        expect(screen.getByText("summaryRestHours(11)")).toBeInTheDocument();
        // "Undervisar" stays a teacher's heading: taughtGroupsOf reads the
        // timplan by teacherId and an admin row there is the exception, not the
        // rule, so the panel does not promise a list it cannot fill.
        expect(screen.queryByText("teachesLabel")).toBeNull();
      });

      it("offers no rule to a guardian or a pupil", async () => {
        const user = userEvent.setup();
        render(<PeoplePage />);

        await user.click(nameButton("Alma Berg"));

        expect(screen.queryByText("workTimeLabel")).toBeNull();
      });

      it("opens the form filled from that teacher's own row", async () => {
        state.workRules = [workRule];
        const user = userEvent.setup();
        render(<PeoplePage />);

        await user.click(screen.getByRole("button", { name: "editFor(Karin Ek)" }));

        expect(screen.getByText("title(Karin Ek)")).toBeInTheDocument();
        expect(screen.getByLabelText("lunchMinutes")).toHaveValue(30);
        expect(screen.getByLabelText("windowStart")).toHaveValue("10:30");
      });

      it("opens empty for a teacher the table says nothing about", async () => {
        // The row that exists belongs to somebody else; a lookup that ignored
        // userId would hand Karin their lunch.
        state.workRules = [{ ...workRule, id: "w-9", userId: "t-other" }];
        const user = userEvent.setup();
        render(<PeoplePage />);

        await user.click(screen.getByRole("button", { name: "editFor(Karin Ek)" }));

        expect(screen.getByLabelText("lunchMinutes")).toHaveValue(null);
        expect(screen.getByText("emptyMeansNoRule")).toBeInTheDocument();
      });
    });
  });

  /**
   * The post and the behörigheter, on the teacher's own row and in the dialog.
   * The cards' own behaviour is covered in components/staffing; what only this
   * page can get wrong is the pairing by userId and the dialog's write.
   */
  describe("a teacher's post", () => {
    const nameButton = (name: string) =>
      screen.getByRole("button", { name: new RegExp(`^${name}$`) });
    const employment = {
      id: "e-1",
      userId: "t-1",
      academicYearId: "year-1",
      employmentPercent: 80,
      reductionPercent: 0,
      contractKind: "FERIE",
      teachingTargetMinutesPerWeek: null,
      signature: "KEK",
      note: null,
    };

    it("shows the two cards on a teacher's row, with her own post", async () => {
      state.employments = [employment, { ...employment, id: "e-2", userId: "t-other", signature: "XXX" }];
      const user = userEvent.setup();
      render(<PeoplePage />);

      await user.click(nameButton("Karin Ek"));

      // The cards are fetched when the row opens (next/dynamic), so the first
      // look at each waits for it: a loader that never settled fails here,
      // by name, rather than leaving the row drawn without them.
      expect(await screen.findByText("employmentTitle")).toBeInTheDocument();
      expect(await screen.findByText("qualificationsTitle")).toBeInTheDocument();
      expect(await screen.findByText("employmentSummarySignature(KEK)")).toBeInTheDocument();
      expect(screen.queryByText("employmentSummarySignature(XXX)")).toBeNull();
    });

    it("shows the teacher's own uppdrag in a third card, fetched with the row like the other two", async () => {
      state.duties = [
        {
          id: "d-1",
          userId: "t-1",
          academicYearId: "year-1",
          kind: "MENTORSKAP",
          label: "Mentor 7A",
          minutesPerWeek: 90,
          countsAsTeaching: false,
          subjectId: null,
          studentGroupId: "g-7a",
          blockedConstraintId: null,
          blockedSlot: null,
          note: null,
        },
      ];
      const user = userEvent.setup();
      render(<PeoplePage />);

      await user.click(nameButton("Karin Ek"));

      expect(await screen.findByText("dutiesTitle")).toBeInTheDocument();
      expect(await screen.findByText("Mentor 7A")).toBeInTheDocument();
      // The mentorskap class is named from the active year's groups.
      expect(screen.getByText("dutyMinutes(90) · 7A")).toBeInTheDocument();
    });

    it("offers the active year's classes as a home class — not next year's, not a teaching group", async () => {
      const user = userEvent.setup();
      render(<PeoplePage />);

      await user.click(screen.getAllByRole("button", { name: "edit" })[0]!); // Alma, in 7A
      const dialog = screen.getByRole("dialog");
      const classPicker = within(dialog).getAllByRole("combobox")[1]!;
      expect(classPicker).toHaveTextContent("7A");
      await user.click(classPicker);
      expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["none", "7A", "7B"]);
    });

    it("offers no post card to a pupil", async () => {
      const user = userEvent.setup();
      render(<PeoplePage />);

      await user.click(nameButton("Alma Berg"));

      expect(screen.queryByText("employmentTitle")).toBeNull();
    });

    it("shows tjänst and signatur in the dialog for a teacher only", async () => {
      const user = userEvent.setup();
      render(<PeoplePage />);

      await user.click(screen.getAllByRole("button", { name: "edit" })[2]!); // Karin
      expect(screen.getByLabelText(/^employmentPercent/)).toHaveValue("");
      expect(screen.getByLabelText(/^signature/)).toBeInTheDocument();
    });

    it("prefills the dialog from the stored post and sends the whole row with the two fields replaced", async () => {
      state.employments = [{ ...employment, reductionPercent: 20, note: "Mentor 7B" }];
      const user = userEvent.setup();
      render(<PeoplePage />);

      await user.click(screen.getAllByRole("button", { name: "edit" })[2]!);
      const percent = screen.getByLabelText(/^employmentPercent/) as HTMLInputElement;
      expect(percent.value).toBe("80");
      await user.clear(percent);
      await user.type(percent, "100");
      await user.click(screen.getByRole("button", { name: "save" }));

      // The nedsättning and the note set on the card survive a change made here.
      expect(saveEmployment).toHaveBeenCalledWith({
        userId: "t-1",
        academicYearId: "year-1",
        employmentPercent: 100,
        reductionPercent: 20,
        contractKind: "FERIE",
        teachingTargetMinutesPerWeek: null,
        signature: "KEK",
        note: "Mentor 7B",
      });
    });

    it("writes nothing about the post when the fields are untouched", async () => {
      state.employments = [employment];
      const user = userEvent.setup();
      render(<PeoplePage />);

      await user.click(screen.getAllByRole("button", { name: "edit" })[2]!);
      await user.click(screen.getByRole("button", { name: "save" }));

      expect(saveEmployment).not.toHaveBeenCalled();
    });

    it("refuses a tjänst over 100 % in the dialog before anything is sent", async () => {
      const user = userEvent.setup();
      render(<PeoplePage />);

      await user.click(screen.getAllByRole("button", { name: "edit" })[2]!);
      await user.type(screen.getByLabelText(/^employmentPercent/), "101");

      expect(screen.getByRole("alert")).toHaveTextContent("problem_percentOutOfRange(3)");
      expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
    });

    it("creates the post for a new teacher after the person, keyed on the new id", async () => {
      const user = userEvent.setup();
      render(<PeoplePage />);

      await user.click(screen.getByRole("button", { name: "addPerson" }));
      await user.type(screen.getByLabelText("firstName"), "Ny");
      await user.type(screen.getByLabelText("lastName"), "Lärare");
      await user.type(screen.getByLabelText("email"), "ny@skolan.se");
      // The role select is the dialog's first combobox; the class select
      // (second) exists only while the role is STUDENT.
      await user.click(screen.getAllByRole("combobox")[0]!);
      await user.click(screen.getByRole("option", { name: "TEACHER" }));
      await user.type(screen.getByLabelText(/^employmentPercent/), "60");
      await user.type(screen.getByLabelText(/^signature/), "NYL");
      await user.click(screen.getByRole("button", { name: "save" }));

      expect(createPerson).toHaveBeenCalled();
      expect(saveEmployment).toHaveBeenCalledWith({
        userId: "t-new",
        academicYearId: "year-1",
        employmentPercent: 60,
        reductionPercent: 0,
        contractKind: "FERIE",
        teachingTargetMinutesPerWeek: null,
        signature: "NYL",
        note: null,
      });
    });
  });
});
