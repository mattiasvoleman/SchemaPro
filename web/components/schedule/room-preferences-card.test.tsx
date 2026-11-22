import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoomPreferencesCard } from "./room-preferences-card";

const create = vi.hoisted(() => vi.fn());
const remove = vi.hoisted(() => vi.fn());
const preferences = vi.hoisted(() => ({ data: [] as unknown[], isError: false }));

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
    preferences.isError = false;
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

  it("deletes the wish the button belongs to, once the confirm is answered", async () => {
    // The button carries the rule's own sentence, and the click only asks: a
    // slip of the pointer used to remove the rule outright.
    preferences.data = [
      { id: "p1", subjectId: "s-no", kind: "WISH" as const, minGradeLevel: null, maxGradeLevel: null, roomTypeId: "rt-lab", weight: 5, rooms: [] },
    ];
    const user = userEvent.setup();
    render(<RoomPreferencesCard />);

    await user.click(
      within(screen.getByRole("list")).getByRole("button", {
        name: "actionNamed(delete|preferenceSummary(NO|Laborationssal))",
      }),
    );
    expect(remove).not.toHaveBeenCalled();

    const confirm = await screen.findByRole("dialog");
    expect(within(confirm).getByText("deletePreferenceBody(preferenceSummary(NO|Laborationssal))")).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "delete" }));

    expect(remove).toHaveBeenCalledWith("p1");
  });

  it("says a refused delete rather than leaving the row standing in silence", async () => {
    const { toast } = await import("sonner");
    remove.mockRejectedValueOnce(new Error("Regeln kunde inte tas bort."));
    preferences.data = [
      { id: "p1", subjectId: "s-no", kind: "WISH" as const, minGradeLevel: null, maxGradeLevel: null, roomTypeId: "rt-lab", weight: 5, rooms: [] },
    ];
    const user = userEvent.setup();
    render(<RoomPreferencesCard />);

    await user.click(within(screen.getByRole("list")).getByRole("button", { name: /^actionNamed\(delete/ }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "delete" }));

    expect(toast.error).toHaveBeenCalledWith("Regeln kunde inte tas bort.");
  });

  it("says the rules could not be read instead of claiming there are none", () => {
    // `data ?? []` made a failed request read as "no wishes", a claim a
    // school acts on.
    preferences.isError = true;
    preferences.data = undefined as unknown as unknown[];
    render(<RoomPreferencesCard />);

    expect(screen.getByRole("alert")).toHaveTextContent("roomRulesLoadFailed");
    expect(screen.queryByText("preferencesEmpty")).toBeNull();
  });

  it("keeps the rules it has read when a refetch fails, and says so above them", () => {
    preferences.data = [
      { id: "p1", subjectId: "s-no", kind: "WISH" as const, minGradeLevel: null, maxGradeLevel: null, roomTypeId: null, weight: 12, rooms: [{ roomId: "r-a12" }] },
    ];
    preferences.isError = true;
    render(<RoomPreferencesCard />);

    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent("roomRulesLoadFailed");
    expect(notice).toHaveTextContent("refetchFailedHint");
    expect(screen.getByText(/preferenceSummary\(NO\|A12\)/)).toBeInTheDocument();
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

/*
 * ?roomRule=<room rule id>, the link of Generera's card of what to change (Åtgärdsförslag vid vägran) for a lock the week cannot keep: the rule
 * is marked and the form opens for a rule beside it, of the same subject and years, with the rooms left to pick (a lock is widened by a rule
 * of its own: equally narrow rules are alternatives and their rooms are the union). Read from this card's own kind of rule in this school's
 * rules: an id that is none of them opens nothing and says nothing, so that an id from another school learns nobody anything.
 */
describe("the ?roomRule= deep link", () => {
  const lockRule = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    subjectId: "s-no",
    kind: "LOCK" as const,
    minGradeLevel: 7,
    maxGradeLevel: 9,
    roomTypeId: null,
    weight: 5,
    rooms: [{ roomId: "r-a12" }],
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    preferences.data = [lockRule("p-lock")];
    preferences.isError = false;
  });
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("scrolls to the marked rule once, and not again at every tick of a room in the form above it", async () => {
    const scrolled = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrolled;
    try {
      window.history.replaceState(null, "", "/?roomRule=p-lock");
      const user = userEvent.setup();
      render(<RoomPreferencesCard kind="LOCK" />);
      await screen.findByRole("button", { name: "save" });
      expect(scrolled).toHaveBeenCalledTimes(1);
      expect(scrolled.mock.contexts[0]).toBe(screen.getByRole("listitem"));

      await user.click(screen.getByLabelText("A14"));
      await user.click(screen.getByLabelText("A12"));
      expect(scrolled).toHaveBeenCalledTimes(1);
    } finally {
      if (original) Element.prototype.scrollIntoView = original;
      else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("marks the rule and opens the form for a rule beside it, saved as a lock of the same subject and years with the rooms picked", async () => {
    window.history.replaceState(null, "", "/?roomRule=p-lock");
    const user = userEvent.setup();
    render(<RoomPreferencesCard kind="LOCK" />);

    expect(await screen.findByRole("button", { name: "save" })).toBeDisabled();
    expect(screen.getByRole("listitem")).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("combobox", { name: "preferenceSubject" })).toHaveTextContent("NO");

    // The rooms are the change, and are left to the administrator: nothing is saved before one is picked.
    await user.click(screen.getByLabelText("A14"));
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(create).toHaveBeenCalledWith({ subjectId: "s-no", roomIds: ["r-a14"], kind: "LOCK", minGradeLevel: 7, maxGradeLevel: 9 });
  });

  it("opens nothing for an id that is none of this school's rules, and shows no error", () => {
    window.history.replaceState(null, "", "/?roomRule=an-id-from-another-school");
    render(<RoomPreferencesCard kind="LOCK" />);

    expect(screen.queryByRole("button", { name: "save" })).toBeNull();
    expect(screen.getByRole("listitem")).not.toHaveAttribute("aria-current");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("is read once in the address too: it is gone from it when the form opens, the rest of the address stays, and a reload does not open it again", async () => {
    window.history.replaceState(null, "", "/?roomRule=p-lock&other=kept#frag");
    const first = render(<RoomPreferencesCard kind="LOCK" />);
    await screen.findByRole("button", { name: "save" });

    expect(window.location.search).toBe("?other=kept");
    expect(window.location.hash).toBe("#frag");

    // A reload is a new mount that reads the address as it is now.
    first.unmount();
    render(<RoomPreferencesCard kind="LOCK" />);
    expect(screen.queryByRole("button", { name: "save" })).toBeNull();
    expect(screen.getByRole("listitem")).not.toHaveAttribute("aria-current");
  });

  it("takes an id that opens nothing out of the address too, so that it does not stay in it", async () => {
    window.history.replaceState(null, "", "/?roomRule=an-id-from-another-school");
    render(<RoomPreferencesCard kind="LOCK" />);

    await waitFor(() => expect(window.location.search).toBe(""));
  });

  it("still gives the card of wishes the id of a wish when both cards are on the page, as the constraints page has them", async () => {
    preferences.data = [lockRule("p-lock"), lockRule("p-wish", { kind: "WISH" as const })];
    window.history.replaceState(null, "", "/?roomRule=p-wish");
    render(
      <>
        <RoomPreferencesCard kind="LOCK" />
        <RoomPreferencesCard kind="WISH" />
      </>,
    );

    await screen.findByRole("button", { name: "save" });
    const marked = screen.getAllByRole("listitem").filter((item) => item.getAttribute("aria-current") === "true");
    expect(marked).toHaveLength(1);
    expect(marked[0]).toHaveTextContent("preferenceSummary");
    expect(window.location.search).toBe("");
  });

  it("leaves the wishes alone: a lock's id is read by the card of locks", () => {
    window.history.replaceState(null, "", "/?roomRule=p-lock");
    preferences.data = [lockRule("p-lock"), lockRule("p-wish", { kind: "WISH" as const })];
    render(<RoomPreferencesCard kind="WISH" />);

    expect(screen.queryByRole("button", { name: "save" })).toBeNull();
    expect(screen.getByRole("listitem")).not.toHaveAttribute("aria-current");
  });

  it("opens nothing before the rules have been read, and then the rule's form once they are", async () => {
    window.history.replaceState(null, "", "/?roomRule=p-lock");
    preferences.data = undefined as unknown as unknown[];
    const view = render(<RoomPreferencesCard kind="LOCK" />);
    expect(screen.queryByRole("button", { name: "save" })).toBeNull();

    preferences.data = [lockRule("p-lock")];
    view.rerender(<RoomPreferencesCard kind="LOCK" />);
    expect(await screen.findByRole("button", { name: "save" })).toBeInTheDocument();
  });

  it("writes nothing by itself: the form opens on the rule's subject and years, and nothing is created or removed until a room is picked and Spara pressed", async () => {
    window.history.replaceState(null, "", "/?roomRule=p-lock");
    const user = userEvent.setup();
    render(<RoomPreferencesCard kind="LOCK" />);
    await screen.findByRole("button", { name: "save" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(create).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "cancel" }));
    expect(create).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("marks nothing without the parameter", () => {
    render(<RoomPreferencesCard kind="LOCK" />);

    expect(screen.queryByRole("button", { name: "save" })).toBeNull();
    expect(screen.getByRole("listitem")).not.toHaveAttribute("aria-current");
  });
});

describe("RoomPreferencesCard under Läsbehörighet", () => {
  // The (app) layout's readOnlyStyle hides [data-writes~="PLANERING"] from a
  // profile that does not write planering (room-preferences.controller.ts
  // @Area); the stated rules stay to read.
  beforeEach(() => {
    preferences.data = [
      { id: "p1", subjectId: "s-no", kind: "LOCK" as const, minGradeLevel: null, maxGradeLevel: null, roomTypeId: "rt-lab", weight: 5, rooms: [] },
    ];
    preferences.isError = false;
  });

  it("marks Lägg till and each rule's Ta bort", () => {
    render(<RoomPreferencesCard kind="LOCK" />);
    expect(screen.getByRole("button", { name: "addLock" })).toHaveAttribute("data-writes", "PLANERING");
    const remove = within(screen.getByRole("list")).getByRole("button", { name: /^actionNamed\(delete\|/ });
    expect(remove.closest("[data-writes]")).toHaveAttribute("data-writes", "PLANERING");
    expect(screen.getByRole("listitem").closest("[data-writes]")).toBeNull();
  });
});

describe("RoomPreferencesCard's form under Läsbehörighet", () => {
  // The (app) layout's readOnlyStyle hides [data-writes~="PLANERING"] from a profile that does not write planering. The form is opened by
  // the button, which carries the mark, and by ?roomRule=, which opens it with no button: its Spara has to be under the mark too, or a
  // läsare is shown a form that can only answer 403.
  beforeEach(() => {
    vi.clearAllMocks();
    preferences.data = [
      { id: "p-lock", subjectId: "s-no", kind: "LOCK" as const, minGradeLevel: 7, maxGradeLevel: 9, roomTypeId: null, weight: 5, rooms: [{ roomId: "r-a12" }] },
    ];
    preferences.isError = false;
  });
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("is marked as planering's when ?roomRule= opens it", async () => {
    window.history.replaceState(null, "", "/?roomRule=p-lock");
    render(<RoomPreferencesCard kind="LOCK" />);

    const save = await screen.findByRole("button", { name: "save" });
    expect(save.closest("[data-writes]")).toHaveAttribute("data-writes", "PLANERING");
  });

  it("is marked as planering's when the button opens it", async () => {
    const user = userEvent.setup();
    render(<RoomPreferencesCard kind="LOCK" />);
    await user.click(screen.getByRole("button", { name: "addLock" }));

    expect(screen.getByRole("button", { name: "save" }).closest("[data-writes]")).toHaveAttribute("data-writes", "PLANERING");
  });
});
