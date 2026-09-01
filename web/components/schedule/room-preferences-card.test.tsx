import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoomPreferencesCard } from "./room-preferences-card";

const create = vi.hoisted(() => vi.fn());
const remove = vi.hoisted(() => vi.fn());
const preferences = vi.hoisted(() => ({ data: [] as unknown[] }));

vi.mock("@/lib/queries", () => ({
  useRoomPreferences: () => preferences,
  useSubjects: () => ({
    data: [{ id: "s-no", name: "NO" }, { id: "s-ma", name: "Matematik" }],
  }),
  useRooms: () => ({
    data: [{ id: "r-a12", name: "A12" }, { id: "r-a14", name: "A14" }],
  }),
  useRoomTypes: () => ({ data: [{ id: "rt-lab", name: "Laborationssal" }] }),
  useRoomPreferenceActions: () => ({
    create: { mutateAsync: create, isPending: false },
    update: { mutateAsync: vi.fn(), isPending: false },
    remove: { mutateAsync: remove, isPending: false },
  }),
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

const openForm = async (
  user: ReturnType<typeof userEvent.setup>,
  // The two cards name their own button, which is half of what keeps a wish
  // from being read as a promise.
  name = "addPreference",
) => user.click(screen.getByRole("button", { name }));

const choose = async (
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  option: string,
) => {
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(screen.getByRole("option", { name: option }));
};

describe("RoomPreferencesCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    preferences.data = [];
  });

  it("says plainly when a school has stated no wishes", () => {
    render(<RoomPreferencesCard />);

    expect(screen.getByText("preferencesEmpty")).toBeInTheDocument();
  });

  it("cannot be saved until it points at something", async () => {
    const user = userEvent.setup();
    render(<RoomPreferencesCard />);
    await openForm(user);

    // The API refuses a wish with no target; the form must not turn that into
    // a 400 for the admin to decode.
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();

    await choose(user, "preferenceSubject", "NO");
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
  });

  it("sends a type wish with no rooms attached", async () => {
    const user = userEvent.setup();
    render(<RoomPreferencesCard />);
    await openForm(user);

    await choose(user, "preferenceSubject", "NO");
    await choose(user, "preferenceRoomType", "Laborationssal");
    await user.click(screen.getByRole("button", { name: "save" }));

    expect(create).toHaveBeenCalledWith({
      subjectId: "s-no",
      kind: "WISH",
      minGradeLevel: null,
      maxGradeLevel: null,
      roomTypeId: "rt-lab",
      weight: 5,
    });
  });

  it("sends a room wish with no type attached", async () => {
    const user = userEvent.setup();
    render(<RoomPreferencesCard />);
    await openForm(user);

    await choose(user, "preferenceSubject", "NO");
    await choose(user, "preferenceTarget", "preferenceByRooms");
    await user.click(screen.getByLabelText("A12"));
    await user.click(screen.getByLabelText("A14"));
    await user.click(screen.getByRole("button", { name: "save" }));

    // Exactly one target — never both, which the API rejects outright.
    expect(create).toHaveBeenCalledWith({
      subjectId: "s-no",
      kind: "WISH",
      minGradeLevel: null,
      maxGradeLevel: null,
      roomIds: ["r-a12", "r-a14"],
      weight: 5,
    });
  });

  it("lists a stated wish in words, not ids", async () => {
    preferences.data = [
      { id: "p1", subjectId: "s-no", kind: "WISH" as const, minGradeLevel: null, maxGradeLevel: null, roomTypeId: null, weight: 12, rooms: [{ roomId: "r-a12" }] },
    ];
    render(<RoomPreferencesCard />);

    expect(screen.getByText(/preferenceSummary\(NO\|A12\)/)).toBeInTheDocument();
    expect(screen.getByText("preferenceWeightBadge(12)")).toBeInTheDocument();
  });

  it("deletes the wish the button belongs to", async () => {
    preferences.data = [
      { id: "p1", subjectId: "s-no", kind: "WISH" as const, minGradeLevel: null, maxGradeLevel: null, roomTypeId: "rt-lab", weight: 5, rooms: [] },
    ];
    const user = userEvent.setup();
    render(<RoomPreferencesCard />);

    await user.click(within(screen.getByRole("list")).getByRole("button", { name: "delete" }));

    expect(remove).toHaveBeenCalledWith("p1");
  });
  it("offers the strength as a slider, not a number to type", async () => {
    const user = userEvent.setup();
    render(<RoomPreferencesCard />);
    await openForm(user);

    const slider = screen.getByLabelText("preferenceWeight");
    expect(slider).toHaveAttribute("type", "range");
    expect(slider).toHaveValue("5");
  });

  it("announces the word to a screen reader, not just the number", async () => {
    const user = userEvent.setup();
    render(<RoomPreferencesCard />);
    await openForm(user);

    // The visible word sits in a separate span the input never references, so
    // without aria-valuetext the announcement is a bare "50".
    expect(screen.getByLabelText("preferenceWeight")).toHaveAttribute(
      "aria-valuetext",
      "strength.normal (5)",
    );

    fireEvent.change(screen.getByLabelText("preferenceWeight"), {
      target: { value: "30" },
    });
    expect(screen.getByLabelText("preferenceWeight")).toHaveAttribute(
      "aria-valuetext",
      "strength.veryStrong (30)",
    );
  });

  it("says in words what the number means", async () => {
    const user = userEvent.setup();
    render(<RoomPreferencesCard />);
    await openForm(user);

    // A bare "50" tells an admin nothing about whether that is a lot.
    expect(screen.getByText(/strength\.normal/)).toBeInTheDocument();
  });

  it("moves the wording and the value together as the slider moves", async () => {
    const user = userEvent.setup();
    render(<RoomPreferencesCard />);
    await openForm(user);

    // A range input is driven by change events, not typing.
    fireEvent.change(screen.getByLabelText("preferenceWeight"), {
      target: { value: "30" },
    });

    expect(screen.getByText(/strength\.veryStrong/)).toBeInTheDocument();
    expect(screen.queryByText(/strength\.normal/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("preferenceWeight")).toHaveValue("30");
  });

  it("sends the value the slider was dragged to", async () => {
    const user = userEvent.setup();
    render(<RoomPreferencesCard />);
    await openForm(user);

    await choose(user, "preferenceSubject", "NO");
    await choose(user, "preferenceRoomType", "Laborationssal");
    fireEvent.change(screen.getByLabelText("preferenceWeight"), {
      target: { value: "12" },
    });
    await user.click(screen.getByRole("button", { name: "save" }));

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ weight: 12 }));
  });


  // -------------------------------------------------------------------------
  // Låset — samma kort, andra sorten
  // -------------------------------------------------------------------------

  describe("as a lock", () => {
    const wish = (id: string) => ({
      id,
      subjectId: "s-no",
      kind: "WISH" as const,
      minGradeLevel: null,
      maxGradeLevel: null,
      roomTypeId: null,
      weight: 12,
      rooms: [{ roomId: "r-a12" }],
    });
    const lock = (id: string, min: number | null = null, max: number | null = null) => ({
      ...wish(id),
      kind: "LOCK" as const,
      minGradeLevel: min,
      maxGradeLevel: max,
    });

    it("lists only its own kind, so a wish is never read as a promise", () => {
      preferences.data = [wish("p1"), lock("p2")];
      render(<RoomPreferencesCard kind="LOCK" />);

      expect(screen.getByText(/lockSummary/)).toBeInTheDocument();
      expect(screen.queryByText(/preferenceSummary/)).toBeNull();
    });

    it("shows no strength on a lock", () => {
      // A lock is a bound and no number can buy its way past one. The column
      // default beside it would read as a number the admin chose.
      preferences.data = [lock("p2")];
      render(<RoomPreferencesCard kind="LOCK" />);

      expect(screen.queryByText(/preferenceWeightBadge/)).toBeNull();
    });

    it("offers no strength slider either", async () => {
      const user = userEvent.setup();
      render(<RoomPreferencesCard kind="LOCK" />);
      await openForm(user, "addLock");

      expect(screen.queryByLabelText("preferenceWeight")).toBeNull();
    });

    it("sends the kind and no weight", async () => {
      // The weight column has a default and a lock never reaches the objective,
      // so sending the slider's value would put a strength on a rule with none.
      const user = userEvent.setup();
      render(<RoomPreferencesCard kind="LOCK" />);
      await openForm(user, "addLock");

      await choose(user, "preferenceSubject", "NO");
      await choose(user, "preferenceRoomType", "Laborationssal");
      await user.click(screen.getByRole("button", { name: "save" }));

      expect(create).toHaveBeenCalledWith({
        subjectId: "s-no",
        kind: "LOCK",
        minGradeLevel: null,
        maxGradeLevel: null,
        roomTypeId: "rt-lab",
      });
    });

    it("sends both year bounds or neither, never half a span", async () => {
      /*
       * The database refuses half a span and so does the API. Picking a lower
       * bound therefore has to bring an upper one with it — a save that greys
       * out with no explanation is worse than a value that follows.
       */
      const user = userEvent.setup();
      render(<RoomPreferencesCard kind="LOCK" />);
      await openForm(user, "addLock");

      await choose(user, "preferenceSubject", "NO");
      await choose(user, "preferenceRoomType", "Laborationssal");
      await choose(user, "ruleGrades", "grade(4)");
      await user.click(screen.getByRole("button", { name: "save" }));

      const body = create.mock.calls[0]?.[0];
      expect([body.minGradeLevel, body.maxGradeLevel]).toEqual([4, 4]);
    });

    it("shows a single year as one year, not as a range", () => {
      preferences.data = [lock("p2", 4, 4)];
      render(<RoomPreferencesCard kind="LOCK" />);

      expect(screen.getByText("ruleGradeBadgeOne(4)")).toBeInTheDocument();
    });

    it("shows a span as a range", () => {
      preferences.data = [lock("p2", 7, 9)];
      render(<RoomPreferencesCard kind="LOCK" />);

      expect(screen.getByText("ruleGradeBadge(7|9)")).toBeInTheDocument();
    });

    it("shows no year badge at all on a rule about every year", () => {
      /*
       * "Alla årskurser" as a badge would be noise on the common case — and a
       * badge saying so is exactly what a lazy implementation produces, so the
       * assertion names that string too rather than only the range keys.
       */
      preferences.data = [lock("p2")];
      render(<RoomPreferencesCard kind="LOCK" />);

      const row = screen.getByRole("listitem");
      expect(row.textContent).toBe("lockSummary(NO|A12)");
    });
  });
});
