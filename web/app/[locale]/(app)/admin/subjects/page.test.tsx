import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NationalSubject, Subject } from "@/lib/types";
import SubjectsPage from "./page";

/**
 * What this file guards: WHICH NATIONAL CELL A SCHOOL SUBJECT FEEDS, AND
 * WHETHER IT IS TEACHING TIME AT ALL.
 *
 * Every timplan sum downstream filters on these two fields. A dialog that
 * sends the sentinel instead of null, forgets the flag, or opens an edit on
 * "Utanför timplanen" for a mapped subject would look exactly like one that
 * works — and the first symptom would be a coverage page saying matematik is
 * 400 hours short.
 */

const createMock = vi.fn();
const updateMock = vi.fn();

const state = vi.hoisted(() => ({
  subjects: [] as unknown[],
  national: undefined as { subjects: unknown[]; versions: unknown[] } | undefined,
  nationalError: false,
}));

vi.mock("@/lib/queries", () => ({
  useSubjects: () => ({ data: state.subjects, isLoading: false }),
  useRoomTypes: () => ({ data: [] }),
  useRoomTypeActions: () => ({ create: { mutateAsync: vi.fn(), isPending: false } }),
  useNationalTimplans: () => ({ data: state.national, isError: state.nationalError }),
  useCrudMutations: () => ({
    create: { mutateAsync: createMock, isPending: false },
    update: { mutateAsync: updateMock, isPending: false },
    remove: { mutateAsync: vi.fn(), isPending: false },
  }),
}));

// The CSV buttons bring the import machinery and its own queries; neither has
// anything to do with the mapping.
vi.mock("@/components/import/csv-import-dialog", () => ({ CsvImportDialog: () => null }));
vi.mock("@/components/import/csv-export-button", () => ({ CsvExportButton: () => null }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

const national = (
  code: string,
  name: string,
  parentCode: string | null = null,
  isGroup = false,
): NationalSubject => ({ code, name, parentCode, isGroup });

/** A slice of the seeded statute, out of order so grouping is what sorts it. */
const NATIONAL: NationalSubject[] = [
  national("KE", "Kemi", "NO"),
  national("MA", "Matematik"),
  national("SO", "Samhällsorienterande ämnen", null, true),
  national("BI", "Biologi", "NO"),
  national("NO", "Naturorienterande ämnen", null, true),
  national("HI", "Historia", "SO"),
  national("BL", "Bild"),
  national("FY", "Fysik", "NO"),
];

const subject = (
  id: string,
  name: string,
  nationalCode: string | null,
  countsTowardTimplan = true,
): Subject => ({
  id,
  name,
  code: null,
  color: null,
  requiredRoomTypeId: null,
  nationalCode,
  countsTowardTimplan,
});

beforeEach(() => {
  createMock.mockReset().mockResolvedValue({});
  updateMock.mockReset().mockResolvedValue({});
  state.subjects = [];
  state.national = { subjects: NATIONAL, versions: [] };
  state.nationalError = false;
});

/** The Nationell ämneskod cell of the row naming the subject. */
const nationalCellOf = (name: string) => {
  const row = screen
    .getAllByRole("row")
    .find((candidate) => within(candidate).queryAllByRole("cell")[0]?.textContent === name)!;
  return within(row).getAllByRole("cell")[2]!;
};

const openCreate = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getAllByRole("button", { name: "addSubject" })[0]!);
};

const nationalPicker = () => screen.getByRole("combobox", { name: "nationalCode" });
const teachingSwitch = () => screen.getByRole("switch", { name: "countsTowardTimplan" });

describe("the Nationell ämneskod column", () => {
  it("shows the code as a badge, a dash for a subject outside the timplan", () => {
    state.subjects = [subject("s-1", "Matematik", "MA"), subject("s-2", "Mentorstid", null)];
    render(<SubjectsPage />);

    expect(screen.getByRole("columnheader", { name: "nationalCode" })).toBeInTheDocument();
    expect(nationalCellOf("Matematik")).toHaveTextContent("MA");
    expect(nationalCellOf("Mentorstid")).toHaveTextContent("—");
  });

  it("flags only the subjects that are not teaching time", () => {
    state.subjects = [
      subject("s-1", "Matematik", "MA"),
      subject("s-2", "Mentorstid", null, false),
      subject("s-3", "Resurs", "MA", false),
    ];
    render(<SubjectsPage />);

    expect(nationalCellOf("Matematik")).not.toHaveTextContent("notTeachingTime");
    expect(nationalCellOf("Mentorstid")).toHaveTextContent("notTeachingTime");
    // Mapped AND excluded is a legal pair: the badge says both.
    expect(nationalCellOf("Resurs")).toHaveTextContent("MA");
    expect(nationalCellOf("Resurs")).toHaveTextContent("notTeachingTime");
  });

  it("names the statute's subject on hover, so the code is not the only clue", () => {
    state.subjects = [subject("s-1", "Matte", "MA")];
    render(<SubjectsPage />);

    expect(within(nationalCellOf("Matte")).getByText("MA")).toHaveAttribute("title", "Matematik");
  });
});

describe("the Nationell ämneskod picker", () => {
  it("lists the null option, the flat subjects, and one group per ämnesgrupp with the group pickable", async () => {
    const user = userEvent.setup();
    render(<SubjectsPage />);
    await openCreate(user);
    await user.click(nationalPicker());

    // Null option first, then the flat subjects in Swedish order.
    const options = await screen.findAllByRole("option");
    expect(options.slice(0, 3).map((option) => option.textContent)).toEqual([
      "nationalCodeNone",
      "Bild (BL)",
      "Matematik (MA)",
    ]);

    // NO: the group itself is an option — lågstadiet maps to it — and then
    // its children, each exactly once.
    const no = screen.getByRole("group", { name: "Naturorienterande ämnen" });
    expect(within(no).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Naturorienterande ämnen (NO)",
      "Biologi (BI)",
      "Fysik (FY)",
      "Kemi (KE)",
    ]);
    const so = screen.getByRole("group", { name: "Samhällsorienterande ämnen" });
    expect(within(so).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Samhällsorienterande ämnen (SO)",
      "Historia (HI)",
    ]);
    expect(screen.getAllByRole("option", { name: "Kemi (KE)" })).toHaveLength(1);
  });

  it("sends null for a new subject left outside the timplan, with the flag on", async () => {
    const user = userEvent.setup();
    render(<SubjectsPage />);
    await openCreate(user);

    expect(nationalPicker()).toHaveTextContent("nationalCodeNone");
    expect(teachingSwitch()).toBeChecked();

    await user.type(screen.getByLabelText("name"), "Mentorstid");
    await user.click(screen.getByRole("button", { name: "save" }));

    // null, not the sentinel and not an absent key: "Utanför timplanen" is a
    // decision the API must hear, and true is what the column defaults to.
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Mentorstid", nationalCode: null, countsTowardTimplan: true }),
    );
  });

  it("sends the chosen code, a child of a group included", async () => {
    const user = userEvent.setup();
    render(<SubjectsPage />);
    await openCreate(user);

    await user.type(screen.getByLabelText("name"), "Kemi");
    await user.click(nationalPicker());
    await user.click(await screen.findByRole("option", { name: "Kemi (KE)" }));
    await user.click(screen.getByRole("button", { name: "save" }));

    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ nationalCode: "KE" }));
  });

  it("lets the group itself be the code", async () => {
    const user = userEvent.setup();
    render(<SubjectsPage />);
    await openCreate(user);

    await user.type(screen.getByLabelText("name"), "NO");
    await user.click(nationalPicker());
    await user.click(await screen.findByRole("option", { name: "Naturorienterande ämnen (NO)" }));
    await user.click(screen.getByRole("button", { name: "save" }));

    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ nationalCode: "NO" }));
  });

  it("opens an edit on the subject's own code and flag, and clearing the code sends null", async () => {
    state.subjects = [subject("s-1", "Mentorstid", "MA", false)];
    const user = userEvent.setup();
    render(<SubjectsPage />);
    await user.click(screen.getByRole("button", { name: "editNamed(Mentorstid)" }));

    expect(nationalPicker()).toHaveTextContent("Matematik (MA)");
    expect(teachingSwitch()).not.toBeChecked();

    await user.click(nationalPicker());
    await user.click(await screen.findByRole("option", { name: "nationalCodeNone" }));
    await user.click(screen.getByRole("button", { name: "save" }));

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s-1", nationalCode: null, countsTowardTimplan: false }),
    );
  });

  it("shows the stored code even while the statute list is unavailable, and says so", async () => {
    // The gateway was unreachable: the picker cannot offer the list, but an
    // edit must still show what IS stored rather than an empty field that
    // looks like "outside the timplan".
    state.national = undefined;
    state.nationalError = true;
    state.subjects = [subject("s-1", "Matematik", "MA")];
    const user = userEvent.setup();
    render(<SubjectsPage />);
    await user.click(screen.getByRole("button", { name: "editNamed(Matematik)" }));

    expect(nationalPicker()).toHaveTextContent("MA");
    expect(screen.getByText("nationalCodeUnavailable")).toBeInTheDocument();
    expect(screen.queryByText("nationalCodeHint")).not.toBeInTheDocument();

    // Saving without touching the picker keeps the mapping.
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ nationalCode: "MA" }));
  });
});

describe("the Räknas som undervisningstid switch", () => {
  it("is on by default and sends false once turned off", async () => {
    const user = userEvent.setup();
    render(<SubjectsPage />);
    await openCreate(user);

    expect(teachingSwitch()).toBeChecked();
    expect(screen.getByText("countsTowardTimplanHint")).toBeInTheDocument();

    await user.type(screen.getByLabelText("name"), "Resurs");
    await user.click(teachingSwitch());
    expect(teachingSwitch()).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "save" }));

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Resurs", countsTowardTimplan: false }),
    );
  });

  it("starts a new subject on true again after editing one that was off", async () => {
    // Form state must not leak from the last edit: a Mentorstid edit followed
    // by "Lägg till ämne" would otherwise quietly create a subject that no
    // timplan sum ever counts.
    state.subjects = [subject("s-1", "Mentorstid", null, false)];
    const user = userEvent.setup();
    render(<SubjectsPage />);
    await user.click(screen.getByRole("button", { name: "editNamed(Mentorstid)" }));
    expect(teachingSwitch()).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "cancel" }));

    await openCreate(user);
    expect(teachingSwitch()).toBeChecked();
    expect(nationalPicker()).toHaveTextContent("nationalCodeNone");
  });
});

describe("the dialog's and the rows' accessible names", () => {
  it("names the room-type picker by its label, and each row's buttons by the subject", async () => {
    // Walk-through 2026-10-07: the picker had no name at all, and a screen
    // reader heard "Redigera, Ta bort" twenty times with no subject.
    state.subjects = [subject("s-1", "Matematik", "MA"), subject("s-2", "Bild", "BL")];
    const user = userEvent.setup();
    render(<SubjectsPage />);

    expect(screen.getByRole("button", { name: "editNamed(Matematik)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "deleteNamed(Bild)" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "editNamed(Matematik)" }));
    expect(screen.getByRole("combobox", { name: "requiredRoomType (optional)" })).toBeInTheDocument();
    // The text fields were already named by their labels (input.labels in
    // Chrome); the walk-through's tree printed the placeholder. Held here.
    expect(screen.getByRole("textbox", { name: "name" })).toHaveValue("Matematik");
    expect(screen.getByRole("textbox", { name: "code (optional)" })).toBeInTheDocument();
  });
});

describe("the national code the school's own code already is", () => {
  const coded = (id: string, name: string, code: string): Subject => ({ ...subject(id, name, null), code });

  it("is offered on an unmapped subject whose code is a national one, and never saved unasked", async () => {
    // Local stack and production 2026-10-07: Matematik "MA", Engelska "EN",
    // Svenska "SV" — every national code empty.
    state.subjects = [coded("s-1", "Matematik", "MA")];
    const user = userEvent.setup();
    render(<SubjectsPage />);
    await user.click(screen.getByRole("button", { name: "editNamed(Matematik)" }));

    expect(screen.getByRole("button", { name: "nationalCodeSuggestion(MA|Matematik)" })).toBeInTheDocument();
    expect(nationalPicker()).toHaveTextContent("nationalCodeNone");

    await user.click(screen.getByRole("button", { name: "save" }));
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ id: "s-1", nationalCode: null }));
  });

  it("takes a school's SV or SVA for the one national subject SV_SVA", async () => {
    state.national = {
      subjects: [...NATIONAL, national("SV_SVA", "Svenska eller svenska som andraspråk")],
      versions: [],
    };
    state.subjects = [coded("s-1", "Svenska", "SV"), coded("s-2", "Svenska som andraspråk", "SvA")];
    const user = userEvent.setup();
    render(<SubjectsPage />);
    await user.click(screen.getByRole("button", { name: "editNamed(Svenska)" }));
    expect(screen.getByText("nationalCodeSuggestion(SV_SVA|Svenska eller svenska som andraspråk)")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "cancel" }));
    await user.click(screen.getByRole("button", { name: "editNamed(Svenska som andraspråk)" }));
    await user.click(screen.getByRole("button", { name: "nationalCodeSuggestion(SV_SVA|Svenska eller svenska som andraspråk)" }));
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ id: "s-2", nationalCode: "SV_SVA" }));
  });

  it("is taken with one click, and then no longer offered", async () => {
    const user = userEvent.setup();
    render(<SubjectsPage />);
    await openCreate(user);
    await user.type(screen.getByLabelText("name"), "Bild");
    await user.type(screen.getByRole("textbox", { name: "code (optional)" }), "bl");

    await user.click(screen.getByRole("button", { name: /^nationalCodeSuggestion\(BL\|/ }));
    expect(nationalPicker()).toHaveTextContent("Bild (BL)");
    expect(screen.queryByText(/^nationalCodeSuggestion/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "save" }));
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ code: "bl", nationalCode: "BL" }));
  });

  it("is not offered for a code the statute does not have, or a subject already mapped", async () => {
    state.subjects = [coded("s-1", "Programmering", "PRG"), { ...subject("s-2", "Matte", "MA"), code: "MA" }];
    const user = userEvent.setup();
    render(<SubjectsPage />);
    await user.click(screen.getByRole("button", { name: "editNamed(Programmering)" }));
    expect(screen.queryByText(/^nationalCodeSuggestion/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "cancel" }));
    await user.click(screen.getByRole("button", { name: "editNamed(Matte)" }));
    expect(screen.queryByText(/^nationalCodeSuggestion/)).not.toBeInTheDocument();
  });
});
