import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { ProfileProvider } from "@/components/profile-context";
import { ApiError, api } from "@/lib/api";
import type { ActivityPreview, ActivityRemovePreview, ScheduleActivity } from "@/lib/schedule-activity-types";
import type { Profile, Subject } from "@/lib/types";
import ActivitiesPage from "./page";

/**
 * /admin/activities over the real hooks and the real Swedish messages, the
 * gateway answering by path. What only this page decides: nothing is
 * cancelled before a preview of the very selection on screen; the replacement
 * subject is chosen among subjects that do NOT count toward the timplan and
 * the credits among those that do; the responsible teachers are picked from
 * the preview's classes and a pick asks for a new preview, because the digest
 * covers it; a change opens on the activity and sends the whole description;
 * a removal says what comes back and what stays before it runs; and a reader
 * has no form and no buttons.
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } };
});
const get = api.get as unknown as Mock;
const post = api.post as unknown as Mock;
const patch = api.patch as unknown as Mock;

const SUBJECTS: Subject[] = [
  { id: "s-tema", name: "Temadag", countsTowardTimplan: false },
  { id: "s-mentor", name: "Mentorstid", countsTowardTimplan: false },
  { id: "s-idh", name: "Idrott och hälsa", countsTowardTimplan: true },
  { id: "s-sv", name: "Svenska", countsTowardTimplan: true },
] as Subject[];
const PEOPLE = [
  { id: "u-anna", role: "TEACHER", firstName: "Anna", lastName: "Berg", isActive: true },
  { id: "u-bo", role: "TEACHER", firstName: "Bo", lastName: "Carlsson", isActive: true },
  { id: "u-gone", role: "TEACHER", firstName: "Gunnar", lastName: "Borta", isActive: false },
  { id: "u-elev", role: "STUDENT", firstName: "Elsa", lastName: "Elev", isActive: true },
];
let subjects: Subject[] = SUBJECTS;
vi.mock("@/lib/queries", () => ({
  useAcademicYears: () => ({
    data: [{ id: "y26", name: "2026/27", startDate: "2026-08-17", endDate: "2027-06-11", isActive: true, predecessorId: null }],
  }),
  useGroups: () => ({
    data: [
      { id: "g-9a", academicYearId: "y26", name: "9A", kind: "CLASS", gradeLevel: 9, halfOfId: null },
      { id: "g-9b", academicYearId: "y26", name: "9B", kind: "CLASS", gradeLevel: 9, halfOfId: null },
    ],
  }),
  useRooms: () => ({ data: [{ id: "r-12", name: "Sal 12" }] }),
  useSubjects: () => ({ data: subjects }),
  usePeople: () => ({ data: PEOPLE }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const DIGEST = "c".repeat(64);
const DIGEST_WITH_TEACHER = "d".repeat(64);
const PREVIEW: ActivityPreview = {
  matched: 62,
  lessons: [
    {
      id: "cl-1",
      date: "2026-11-02",
      startsAt: "2026-11-02T08:00:00",
      endsAt: "2026-11-02T08:50:00",
      subjectName: "Matematik",
      groupName: "9A",
    },
  ],
  excluded: { started: 0, notScheduled: 2, attendance: 1 },
  ungradedGroups: ["Sva9"],
  expandedGroups: [{ id: "g-9a-1", name: "9A halva" }],
  classes: [
    { groupId: "g-9a", name: "9A", teachers: [], days: 2, firstDate: "2026-11-02", lastDate: "2026-11-03" },
    { groupId: "g-9b", name: "9B", teachers: [], days: 1, firstDate: "2026-11-02", lastDate: "2026-11-02" },
  ],
  replacementLessons: 3,
  warnings: {
    classesWithoutTeacher: ["9A", "9B"],
    continuing: [{ name: "Ma9", lessons: 4 }],
    uncoveredPupils: 3,
    teacherClashes: [],
  },
  creditDates: ["2026-11-02", "2026-11-03"],
  digest: DIGEST,
  audience: { pupils: 52, guardians: 87, teachers: 4 },
};
const ACTIVITY: ScheduleActivity = {
  id: "a-1",
  academicYearId: "y26",
  batchId: "b-1",
  name: "Friluftsdag",
  description: "Ta med matsäck.",
  fromDate: "2026-12-07",
  toDate: "2026-12-08",
  startTime: null,
  endTime: null,
  scope: "GRADES",
  minGradeLevel: 9,
  maxGradeLevel: 9,
  scopeGroupIds: [],
  replacementSubject: { id: "s-tema", name: "Temadag", countsTowardTimplan: false },
  cancelled: 62,
  replacementLessons: 3,
  credits: 2,
  creditLines: [{ subjectId: "s-idh", minutes: 300 }],
  teachers: [{ studentGroupId: "g-9a", teacherId: "u-anna", role: "LEAD" }],
  notifies: true,
  createdAt: "2026-10-01T08:00:00.000Z",
  createdByUserId: null,
  removedAt: null,
  reinstated: 0,
  doubleCounts: false,
  addedSince: 0,
};
/** Held already: its days are behind the pinned today. */
const FINISHED: ScheduleActivity = {
  ...ACTIVITY,
  id: "a-3",
  name: "Prao åk 7",
  description: null,
  fromDate: "2026-10-12",
  toDate: "2026-10-16",
  notifies: false,
  credits: 0,
  creditLines: [],
};
const REMOVED: ScheduleActivity = {
  ...ACTIVITY,
  id: "a-2",
  name: "Prao åk 8",
  fromDate: "2026-09-14",
  toDate: "2026-09-18",
  removedAt: "2026-09-20T08:00:00.000Z",
  reinstated: 12,
  credits: 0,
  creditLines: [],
};
const REMOVE_PREVIEW: ActivityRemovePreview = {
  reinstate: 58,
  notify: 412,
  replacementsDeleted: 3,
  replacementsKept: 1,
  creditsDeleted: 2,
  skippedRoomTaken: [{ lessonId: "cl-9", date: "2026-11-02", roomId: "r-12", by: "BOOKING" }],
  removedTemplateMoved: [{ lessonId: "cl-11", date: "2026-11-03" }],
  notReinstatable: 4,
};
let listed: ScheduleActivity[] = [ACTIVITY];

function renderPage(readOnly = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <ProfileProvider profile={{} as Profile} school={null} readOnly={readOnly}>
          <ActivitiesPage />
        </ProfileProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

// The whole form is drawn again on every key, so a test that types a name, two
// dates and a description into it takes seconds on a busy host. Text is set
// in one change event; only the fields whose keystrokes matter are typed.
vi.setConfig({ testTimeout: 30_000 });

/** The DateField is a text input that takes yyyy-mm-dd typed in full. */
const setValue = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const typeDate = setValue;

/** A new activity filled in as far as a preview can be asked for. */
async function fillIn(user: ReturnType<typeof userEvent.setup>) {
  setValue("Namn", "Friluftsdag åk 9");
  typeDate("Från och med", "2026-11-02");
  typeDate("Till och med", "2026-11-03");
  await user.selectOptions(screen.getByLabelText("Ämne för ersättningslektionen"), "Temadag");
}

describe("/admin/activities", () => {
  beforeEach(() => {
    // Only the clock is pinned (to a Thursday), not the timers: "held already" and the
    // credits ahead are judged against today, and the user-event delays stay real.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-05T09:00:00") });
    vi.resetAllMocks();
    subjects = SUBJECTS;
    listed = [ACTIVITY];
    get.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/v1/schedule-activities")) return listed;
      throw new Error(`unexpected GET ${path}`);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the form and the year's activities, with what each cancelled and put in its place", async () => {
    listed = [ACTIVITY, FINISHED, REMOVED];
    renderPage();
    expect(await screen.findByRole("heading", { level: 1, name: "Aktiviteter" })).toBeInTheDocument();
    // Every part of the form is Drift's: even its preview is a POST answered by area.
    expect(screen.getByRole("region", { name: "Ny aktivitet" })).toHaveAttribute("data-writes", "DRIFT");

    const row = (await screen.findByText("Friluftsdag")).closest("tr")!;
    expect(row).toHaveTextContent("Ersättning i Temadag");
    expect(row).toHaveTextContent("Ta med matsäck.");
    expect(row).toHaveTextContent("7–8 dec. 2026");
    expect(row).toHaveTextContent("Åk 9");
    expect(row).toHaveTextContent("62 inställda lektioner");
    expect(row).toHaveTextContent("3 ersättningslektioner");
    expect(row).toHaveTextContent("2 tillgodoräkningar");
    expect(row).toHaveTextContent("Gäller");
    expect(row).toHaveTextContent("Besked skickat");
    expect(within(row).getByRole("button", { name: "Ändra Friluftsdag" })).toHaveAttribute("data-writes", "DRIFT");
    expect(within(row).getByRole("button", { name: "Ta bort Friluftsdag" })).toHaveAttribute("data-writes", "DRIFT");

    // One whose days are behind is held, and can still be changed or taken away.
    const held = screen.getByText("Prao åk 7").closest("tr")!;
    expect(held).toHaveTextContent("Genomförd");
    expect(within(held).getByRole("button", { name: "Ändra Prao åk 7" })).toBeInTheDocument();

    // A removed activity stays as the record, dimmed and without buttons.
    const removed = screen.getByText("Prao åk 8").closest("tr")!;
    expect(removed).toHaveTextContent("Borttagen");
    expect(within(removed).queryByRole("button")).not.toBeInTheDocument();
  });

  it("warns on the row when the replacement subject has come to count toward the timplan", async () => {
    listed = [{ ...ACTIVITY, doubleCounts: true, replacementSubject: { id: "s-idh", name: "Idrott och hälsa", countsTowardTimplan: true } }];
    renderPage();
    const row = (await screen.findByText("Friluftsdag")).closest("tr")!;
    expect(row).toHaveTextContent("Ämnet räknas nu som undervisningstid, så dagens minuter räknas två gånger.");
  });

  it("gives a reader the list and nothing to change it with", async () => {
    renderPage(true);
    const row = (await screen.findByText("Friluftsdag")).closest("tr")!;
    expect(row).toHaveTextContent("62 inställda lektioner");
    expect(screen.queryByRole("region", { name: "Ny aktivitet" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Förhandsgranska" })).not.toBeInTheDocument();
    expect(within(row).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Åtgärder" })).not.toBeInTheDocument();
  });

  it("offers a replacement subject only among those that do not count, and credits only among those that do", async () => {
    const user = userEvent.setup();
    renderPage();
    const replacement = await screen.findByLabelText("Ämne för ersättningslektionen");
    expect(within(replacement).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Välj ämne",
      "Temadag",
      "Mentorstid",
    ]);

    await user.click(screen.getByRole("button", { name: "Lägg till ämne" }));
    const row = screen.getByRole("group", { name: "Rad 1" });
    expect(within(within(row).getByLabelText("Ämne")).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Välj ämne",
      "Idrott och hälsa",
      "Svenska",
    ]);
  });

  it("says how to make a replacement subject when none can be one, and links to Ämnen", async () => {
    subjects = SUBJECTS.filter((subject) => subject.countsTowardTimplan);
    renderPage();
    expect(await screen.findByText("Inget ämne kan vara ersättningslektionens")).toBeInTheDocument();
    expect(screen.queryByLabelText("Ämne för ersättningslektionen")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Till Ämnen" })).toHaveAttribute("href", expect.stringContaining("/admin/subjects"));
  });

  it("names the rules beside the form before anything is sent", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByLabelText("Namn");
    setValue("Namn", "Prao");
    typeDate("Från och med", "2026-11-02");
    typeDate("Till och med", "2026-12-10");
    const to = screen.getByLabelText("Till och med");
    expect(to).toHaveAccessibleDescription("En aktivitet gäller högst 31 dagar.");
    expect(to).toBeInvalid();
    expect(screen.getByLabelText("Ämne för ersättningslektionen")).toHaveAccessibleDescription(
      /Välj ämne för ersättningslektionen\./,
    );
    expect(screen.getByRole("button", { name: "Förhandsgranska" })).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
  });

  it("previews the selection on screen without a digest, shows every warning, and takes the teachers from its classes", async () => {
    post.mockImplementation(async (path: string, body: { teachers?: unknown[] }) => {
      if (path === "/api/v1/schedule-activities/preview") {
        return body.teachers
          ? {
              ...PREVIEW,
              digest: DIGEST_WITH_TEACHER,
              classes: [{ ...PREVIEW.classes[0]!, teachers: [{ teacherId: "u-anna", role: "LEAD" }] }, PREVIEW.classes[1]!],
              warnings: {
                ...PREVIEW.warnings,
                classesWithoutTeacher: ["9B"],
                teacherClashes: [{ teacherId: "u-anna", date: "2026-11-02", groupName: "9A", busyWith: "8C" }],
              },
            }
          : PREVIEW;
      }
      return { activity: ACTIVITY, cancelled: 62, replacementLessons: 3, credits: 0 };
    });
    const user = userEvent.setup();
    renderPage();
    await fillIn(user);
    setValue("Beskrivning (valfritt)", "Ta med matsäck.");
    // The create is at the end of the preview, so there is none before one.
    expect(screen.queryByRole("button", { name: "Skapa aktivitet" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Förhandsgranska" }));
    // The preview carries the selection and nothing else: the gateway refuses a field it does not know.
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/schedule-activities/preview", {
        academicYearId: "y26",
        name: "Friluftsdag åk 9",
        fromDate: "2026-11-02",
        toDate: "2026-11-03",
        scope: "GRADES",
        minGradeLevel: 9,
        maxGradeLevel: 9,
        replacementSubjectId: "s-tema",
        description: "Ta med matsäck.",
      }),
    );
    const preview = await screen.findByRole("region", { name: "Förhandsgranskning" });
    expect(preview).toHaveTextContent("62 lektioner ställs in.");
    expect(preview).toHaveTextContent("3 ersättningslektioner skapas, en per klass och dag.");
    expect(preview).toHaveTextContent("Lämnas orörda: 0 har börjat, 2 är redan inställda eller hållna, 1 har närvaro.");
    expect(preview).toHaveTextContent("Grupper utan egen årskurs, som inte räknas in: Sva9.");
    expect(preview).toHaveTextContent("Ytterligare 1 grupp ställs in med klasserna: 9A halva.");
    // The classes, with their days.
    const classes = within(preview).getByRole("list", { name: "Klasser med ersättningslektion" });
    expect(classes).toHaveTextContent("9A");
    expect(classes).toHaveTextContent("2 dagar, 2–3 nov. 2026");
    expect(classes).toHaveTextContent("1 dag");
    // The warnings, each as a list of what it names.
    expect(preview).toHaveTextContent("2 klasser saknar ansvarig lärare");
    expect(preview).toHaveTextContent("Ersättningslektionen räknas som lärarlös.");
    expect(preview).toHaveTextContent("Lektioner som pågår för några elever i klassen");
    expect(preview).toHaveTextContent("Ma9: 4 lektioner");
    expect(preview).toHaveTextContent("3 elever på de inställda lektionerna går i ingen av aktivitetens klasser");
    // First 50 lessons.
    expect(preview).toHaveTextContent("Matematik · 9A");
    expect(preview).toHaveTextContent("och 61 till");
    // The notice is ticked from the start, and says who it reaches.
    const notify = within(preview).getByRole("checkbox", { name: "Meddela elever, vårdnadshavare och lärare" });
    expect(notify).toBeChecked();
    expect(notify).toHaveAccessibleDescription(/^52 elever, 87 vårdnadshavare och 4 lärare får en notis var om aktiviteten/);
    expect(screen.getByRole("button", { name: "Skapa aktivitet" })).toBeEnabled();

    // Picking a teacher for 9A: the chip, the first one leads, and the digest no longer covers the form.
    await user.selectOptions(within(classes).getByLabelText("Lägg till lärare i 9A"), "Anna Berg");
    const chips = within(classes).getByRole("list", { name: "Ansvariga för 9A" });
    expect(chips).toHaveTextContent("Anna Berg");
    expect(chips).toHaveTextContent("(ledande)");
    // An inactive teacher, and a pupil, are not on offer.
    const offered = within(within(classes).getByLabelText("Lägg till lärare i 9B")).getAllByRole("option").map((option) => option.textContent);
    expect(offered).toEqual(["Lägg till lärare…", "Anna Berg", "Bo Carlsson"]);
    expect(
      screen.getByText(/Lärare, tillgodoräkning eller beskrivning har ändrats sedan förhandsgranskningen/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skapa aktivitet" })).toBeDisabled();

    // Asking again is beside the pickers, not up at the form.
    await user.click(within(preview).getByRole("button", { name: "Förhandsgranska igen" }));
    await waitFor(() =>
      expect(post).toHaveBeenLastCalledWith(
        "/api/v1/schedule-activities/preview",
        expect.objectContaining({ teachers: [{ studentGroupId: "g-9a", teacherId: "u-anna", role: "LEAD" }] }),
      ),
    );
    expect(await screen.findByText("1 klass saknar ansvarig lärare")).toBeInTheDocument();
    expect(screen.getByText("Anna Berg har lektion med 8C 2 nov. 2026, samtidigt som ersättningslektionen för 9A.")).toBeInTheDocument();

    // Unticking the notice is not part of the request, so the preview still holds.
    await user.click(screen.getByRole("checkbox", { name: "Meddela elever, vårdnadshavare och lärare" }));
    await user.click(screen.getByRole("button", { name: "Skapa aktivitet" }));
    await waitFor(() =>
      expect(post).toHaveBeenLastCalledWith("/api/v1/schedule-activities", {
        academicYearId: "y26",
        name: "Friluftsdag åk 9",
        fromDate: "2026-11-02",
        toDate: "2026-11-03",
        scope: "GRADES",
        minGradeLevel: 9,
        maxGradeLevel: 9,
        replacementSubjectId: "s-tema",
        description: "Ta med matsäck.",
        teachers: [{ studentGroupId: "g-9a", teacherId: "u-anna", role: "LEAD" }],
        expectedDigest: DIGEST_WITH_TEACHER,
        notify: false,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith(
      "Aktiviteten skapades: 62 lektioner ställdes in och 3 ersättningslektioner skapades.",
    );
    // The form is empty again for the next one, and the preview is gone.
    expect(screen.getByLabelText("Namn")).toHaveValue("");
    expect(screen.queryByRole("region", { name: "Förhandsgranskning" })).not.toBeInTheDocument();
  });

  it("sends a credit per subject with the preview and the create, for whole days only", async () => {
    post.mockImplementation(async (path: string) =>
      path.endsWith("/preview") ? PREVIEW : { activity: ACTIVITY, cancelled: 62, replacementLessons: 3, credits: 4 },
    );
    const user = userEvent.setup();
    renderPage();
    await fillIn(user);
    await user.click(screen.getByRole("button", { name: "Lägg till ämne" }));
    const row = screen.getByRole("group", { name: "Rad 1" });
    await user.selectOptions(within(row).getByLabelText("Ämne"), "Idrott och hälsa");
    // A row with no minutes yet is named, and holds the preview back.
    expect(screen.getByRole("button", { name: "Förhandsgranska" })).toBeDisabled();
    expect(screen.getByText("Ange minuter per dag, mellan 1 och 600.")).toBeInTheDocument();
    fireEvent.change(within(row).getByLabelText("Minuter per dag"), { target: { value: "300" } });
    expect(screen.getByRole("button", { name: "Förhandsgranska" })).toBeEnabled();

    // A time window and a credit do not go together: a partly held day credited in full counts the morning twice.
    setValue(/Från klockan/, "08:00");
    setValue(/Till klockan/, "12:00");
    expect(screen.getByText("En tillgodoräknad dag gäller hela dagar; ta bort tidsfönstret.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Förhandsgranska" })).toBeDisabled();
    setValue(/Från klockan/, "");
    setValue(/Till klockan/, "");

    await user.click(screen.getByRole("button", { name: "Förhandsgranska" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/api/v1/schedule-activities/preview",
        expect.objectContaining({ credits: [{ subjectId: "s-idh", minutes: 300 }] }),
      ),
    );
    expect(await screen.findByText("2 dagar tillgodoräknas: 2 nov. 2026, 3 nov. 2026.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Skapa aktivitet" }));
    await waitFor(() =>
      expect(post).toHaveBeenLastCalledWith(
        "/api/v1/schedule-activities",
        expect.objectContaining({ credits: [{ subjectId: "s-idh", minutes: 300 }], expectedDigest: DIGEST, notify: true }),
      ),
    );
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("Tillgodoräkningar: 4."));
  });

  it("will not confirm a form changed after its preview, and says a stale create in words", async () => {
    post.mockImplementation(async (path: string) => {
      if (path.endsWith("/preview")) return PREVIEW;
      throw new ApiError(409, "…", "CANCELLATION_STALE");
    });
    const user = userEvent.setup();
    renderPage();
    await fillIn(user);
    await user.click(screen.getByRole("button", { name: "Förhandsgranska" }));
    expect(await screen.findByRole("button", { name: "Skapa aktivitet" })).toBeEnabled();

    // Another day is another selection: the preview of the first is hidden, not left to be confirmed.
    typeDate("Till och med", "2026-11-04");
    expect(screen.getByText("Formuläret har ändrats sedan förhandsgranskningen. Förhandsgranska igen.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skapa aktivitet" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Förhandsgranskning" })).not.toBeInTheDocument();

    // The plan moved between the preview and the create: asked for again, not created unseen.
    await user.click(screen.getByRole("button", { name: "Förhandsgranska" }));
    await user.click(await screen.findByRole("button", { name: "Skapa aktivitet" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Lektionerna i urvalet har ändrats sedan förhandsgranskningen. Förhandsgranska igen innan du fortsätter.",
    );
    expect(screen.queryByRole("button", { name: "Skapa aktivitet" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Förhandsgranskning" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Förhandsgranska" })).toBeEnabled();
    expect(toast.success).not.toHaveBeenCalled();

    // A new preview gives a new digest, and the create goes through.
    post.mockImplementation(async (path: string) =>
      path.endsWith("/preview")
        ? { ...PREVIEW, digest: DIGEST_WITH_TEACHER }
        : { activity: ACTIVITY, cancelled: 62, replacementLessons: 3, credits: 0 },
    );
    await user.click(screen.getByRole("button", { name: "Förhandsgranska" }));
    await user.click(await screen.findByRole("button", { name: "Skapa aktivitet" }));
    await waitFor(() =>
      expect(post).toHaveBeenLastCalledWith(
        "/api/v1/schedule-activities",
        expect.objectContaining({ expectedDigest: DIGEST_WITH_TEACHER }),
      ),
    );
  });

  it("says the gateway's refusal of a subject in words the page owns", async () => {
    post.mockRejectedValue(new ApiError(400, "replacementSubjectId: …", "ACTIVITY_SUBJECT_COUNTS"));
    const user = userEvent.setup();
    renderPage();
    await fillIn(user);
    await user.click(screen.getByRole("button", { name: "Förhandsgranska" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Ämnet räknas som undervisningstid, så dagens minuter skulle räknas två gånger.");
  });

  it("opens a change on the activity, reads its credits back, previews by its own route and patches the whole description", async () => {
    post.mockImplementation(async (path: string) => {
      if (path === "/api/v1/schedule-activities/a-1/preview") {
        return { ...PREVIEW, matched: 65, digest: DIGEST_WITH_TEACHER, change: { released: 2, taken: 5 } };
      }
      throw new Error(`unexpected POST ${path}`);
    });
    patch.mockResolvedValue({ activity: ACTIVITY, released: 2, taken: 5 });
    const user = userEvent.setup();
    renderPage();
    const row = (await screen.findByText("Friluftsdag")).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Ändra Friluftsdag" }));

    const dialog = await screen.findByRole("dialog", { name: "Ändra Friluftsdag" });
    // The form is the activity's, with the teachers it has and the credit lines the school wrote for it.
    expect(await within(dialog).findByLabelText("Namn")).toHaveValue("Friluftsdag");
    expect(within(dialog).getByLabelText("Ämne för ersättningslektionen")).toHaveValue("s-tema");
    expect(within(dialog).getByLabelText("Beskrivning (valfritt)")).toHaveValue("Ta med matsäck.");
    const credit = within(dialog).getByRole("group", { name: "Rad 1" });
    expect(within(credit).getByLabelText("Ämne")).toHaveValue("s-idh");
    expect(within(credit).getByLabelText("Minuter per dag")).toHaveValue(300);
    expect(within(dialog).getByText(/Aktiviteten har tillgodoräkningar\. Sparar du skrivs de/)).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText("Namn"), { target: { value: "Friluftsdag åk 9" } });
    await user.click(within(dialog).getByRole("button", { name: "Förhandsgranska" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/schedule-activities/a-1/preview", {
        academicYearId: "y26",
        name: "Friluftsdag åk 9",
        fromDate: "2026-12-07",
        toDate: "2026-12-08",
        scope: "GRADES",
        minGradeLevel: 9,
        maxGradeLevel: 9,
        replacementSubjectId: "s-tema",
        description: "Ta med matsäck.",
        teachers: [{ studentGroupId: "g-9a", teacherId: "u-anna", role: "LEAD" }],
        credits: [{ subjectId: "s-idh", minutes: 300 }],
      }),
    );
    // What it puts back and what it newly cancels, and the notice the activity was made with, still ticked.
    expect(await within(dialog).findByText("Ändringen ställer in 5 lektioner till och sätter tillbaka 2 lektioner.")).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: "Meddela elever, vårdnadshavare och lärare" })).toBeChecked();

    await user.click(within(dialog).getByRole("button", { name: "Spara ändringen" }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        "/api/v1/schedule-activities/a-1",
        expect.objectContaining({
          name: "Friluftsdag åk 9",
          credits: [{ subjectId: "s-idh", minutes: 300 }],
          expectedDigest: DIGEST_WITH_TEACHER,
          notify: true,
        }),
      ),
    );
    expect(toast.success).toHaveBeenCalledWith("Ändringen sparades: 5 lektioner ställdes in till och 2 lektioner sattes tillbaka.");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // Focus goes back to the button that opened it.
    expect(within(row).getByRole("button", { name: "Ändra Friluftsdag" })).toHaveFocus();
  });

  it("opens a change of a finished activity without credit lines: none are written for days behind", async () => {
    listed = [{ ...FINISHED, credits: 2, creditLines: [] }];
    const user = userEvent.setup();
    renderPage();
    const row = (await screen.findByText("Prao åk 7")).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Ändra Prao åk 7" }));
    const dialog = await screen.findByRole("dialog", { name: "Ändra Prao åk 7" });
    expect(await within(dialog).findByLabelText("Namn")).toHaveValue("Prao åk 7");
    expect(within(dialog).queryByRole("group", { name: "Rad 1" })).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Aktiviteten har tillgodoräkningar/)).not.toBeInTheDocument();
  });

  it("warns when a change would take the credits away because the activity carries no lines for them", async () => {
    listed = [{ ...ACTIVITY, creditLines: [] }];
    const user = userEvent.setup();
    renderPage();
    const row = (await screen.findByText("Friluftsdag")).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Ändra Friluftsdag" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/men raderna här är tomma\. Sparar du så tas tillgodoräkningarna/)).toBeInTheDocument();
  });

  it("opens a change of an activity that names a class since deleted, without it and its teachers", async () => {
    // g-gone is not among the groups the page loaded (useGroups holds 9A and 9B).
    listed = [
      {
        ...ACTIVITY,
        scope: "GROUPS",
        minGradeLevel: null,
        maxGradeLevel: null,
        scopeGroupIds: ["g-9a", "g-gone"],
        teachers: [
          { studentGroupId: "g-9a", teacherId: "u-anna", role: "LEAD" },
          { studentGroupId: "g-gone", teacherId: "u-bo", role: "LEAD" },
        ],
      },
    ];
    post.mockResolvedValue({ ...PREVIEW, digest: DIGEST_WITH_TEACHER, change: { released: 0, taken: 0 } });
    const user = userEvent.setup();
    renderPage();
    const row = (await screen.findByText("Friluftsdag")).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Ändra Friluftsdag" }));
    const dialog = await screen.findByRole("dialog", { name: "Ändra Friluftsdag" });
    expect(await within(dialog).findByLabelText("Namn")).toHaveValue("Friluftsdag");
    await user.click(within(dialog).getByRole("button", { name: "Förhandsgranska" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/schedule-activities/a-1/preview", {
        academicYearId: "y26",
        name: "Friluftsdag",
        fromDate: "2026-12-07",
        toDate: "2026-12-08",
        scope: "GROUPS",
        groupIds: ["g-9a"],
        replacementSubjectId: "s-tema",
        description: "Ta med matsäck.",
        teachers: [{ studentGroupId: "g-9a", teacherId: "u-anna", role: "LEAD" }],
        credits: [{ subjectId: "s-idh", minutes: 300 }],
      }),
    );
  });

  it("says lessons have come into an activity's days since, and applies it again to cancel them", async () => {
    listed = [{ ...ACTIVITY, addedSince: 3 }];
    post.mockImplementation(async (path: string) => {
      if (path === "/api/v1/schedule-activities/a-1/reapply") {
        // The list is read again after the write: nothing waits any more.
        listed = [{ ...ACTIVITY, cancelled: 65, addedSince: 0 }];
        return { activity: listed[0], added: 3 };
      }
      throw new Error(`unexpected POST ${path}`);
    });
    const user = userEvent.setup();
    renderPage();
    const row = (await screen.findByText("Friluftsdag")).closest("tr")!;
    expect(row).toHaveTextContent("3 lektioner har tillkommit i aktivitetens dagar och är inte inställda än.");
    const button = within(row).getByRole("button", { name: "Tillämpa igen Friluftsdag" });
    expect(button).toHaveAttribute("data-writes", "DRIFT");

    await user.click(button);
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/schedule-activities/a-1/reapply"));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("3 lektioner till ställdes in."));
    await waitFor(() => expect(row).toHaveTextContent("65 inställda lektioner"));
    expect(row).not.toHaveTextContent("har tillkommit i aktivitetens dagar");
    expect(within(row).queryByRole("button", { name: "Tillämpa igen Friluftsdag" })).not.toBeInTheDocument();
  });

  it("says when applying again cancelled nothing, and a refusal in words", async () => {
    listed = [{ ...ACTIVITY, addedSince: 1 }];
    post.mockResolvedValueOnce({ activity: ACTIVITY, added: 0 });
    post.mockRejectedValueOnce(new ApiError(409, "…", "ACTIVITY_REMOVED"));
    const user = userEvent.setup();
    renderPage();
    const row = (await screen.findByText("Friluftsdag")).closest("tr")!;
    expect(row).toHaveTextContent("1 lektion har tillkommit i aktivitetens dagar och är inte inställd än.");
    await user.click(within(row).getByRole("button", { name: "Tillämpa igen Friluftsdag" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Inga nya lektioner ställdes in."));
    await user.click(within(row).getByRole("button", { name: "Tillämpa igen Friluftsdag" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Aktiviteten är redan borttagen."));
  });

  it("offers no re-apply where nothing has come into the days, nor on a removed activity", async () => {
    // A removed activity carries 0 from the gateway; the row does not trust that alone.
    listed = [ACTIVITY, { ...REMOVED, addedSince: 4 }];
    renderPage();
    const row = (await screen.findByText("Friluftsdag")).closest("tr")!;
    expect(row).not.toHaveTextContent("har tillkommit");
    expect(within(row).queryByRole("button", { name: /Tillämpa igen/ })).not.toBeInTheDocument();
    const removed = screen.getByText("Prao åk 8").closest("tr")!;
    expect(removed).not.toHaveTextContent("har tillkommit");
    expect(screen.queryByRole("button", { name: /Tillämpa igen/ })).not.toBeInTheDocument();
  });

  it("asks what a removal does before it removes, and says what stays", async () => {
    post.mockImplementation(async (path: string) => {
      if (path === "/api/v1/schedule-activities/a-1/remove/preview") return REMOVE_PREVIEW;
      if (path === "/api/v1/schedule-activities/a-1/remove") return { ...REMOVE_PREVIEW, notify: 412 };
      throw new Error(`unexpected POST ${path}`);
    });
    const user = userEvent.setup();
    renderPage();
    const row = (await screen.findByText("Friluftsdag")).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Ta bort Friluftsdag" }));

    const dialog = await screen.findByRole("dialog", { name: "Ta bort Friluftsdag?" });
    expect(await within(dialog).findByText("58 lektioner kommer tillbaka.")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("3 ersättningslektioner tas bort.");
    expect(dialog).toHaveTextContent("1 ersättningslektion behålls, eftersom de har hållits eller har närvaro.");
    expect(dialog).toHaveTextContent("1 lektion förblir inställd, eftersom salen har bokats");
    expect(dialog).toHaveTextContent("2 nov. 2026 · Sal 12 · en lokalbokning");
    expect(dialog).toHaveTextContent("1 lektion tas bort, eftersom schemat har flyttat lektionen");
    expect(dialog).toHaveTextContent("3 nov. 2026");
    expect(dialog).toHaveTextContent("4 lektioner har börjat eller ändrats sedan och lämnas som de är.");
    expect(dialog).toHaveTextContent("2 tillgodoräkningar tas bort.");
    expect(dialog).toHaveTextContent("412 personer får en notis om att lektionerna blir av som planerat");
    // Nothing has been removed yet.
    expect(post).not.toHaveBeenCalledWith("/api/v1/schedule-activities/a-1/remove");

    expect(within(dialog).getByRole("button", { name: "Ta bort aktiviteten" })).toHaveAttribute("data-writes", "DRIFT");
    await user.click(within(dialog).getByRole("button", { name: "Ta bort aktiviteten" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/schedule-activities/a-1/remove"));
    expect(toast.success).toHaveBeenCalledWith("Aktiviteten togs bort. 58 lektioner är tillbaka.");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps the removal's button off until the gateway has answered, and says a refusal", async () => {
    post.mockRejectedValue(new ApiError(409, "…", "ACTIVITY_REMOVED"));
    const user = userEvent.setup();
    renderPage();
    const row = (await screen.findByText("Friluftsdag")).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Ta bort Friluftsdag" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Aktiviteten är redan borttagen.");
    expect(within(dialog).getByRole("button", { name: "Ta bort aktiviteten" })).toBeDisabled();
  });
});
