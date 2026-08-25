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

const openForm = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: "addPreference" }));

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
      roomIds: ["r-a12", "r-a14"],
      weight: 5,
    });
  });

  it("lists a stated wish in words, not ids", async () => {
    preferences.data = [
      { id: "p1", subjectId: "s-no", roomTypeId: null, weight: 12, rooms: [{ roomId: "r-a12" }] },
    ];
    render(<RoomPreferencesCard />);

    expect(screen.getByText(/preferenceSummary\(NO\|A12\)/)).toBeInTheDocument();
    expect(screen.getByText("preferenceWeightBadge(12)")).toBeInTheDocument();
  });

  it("deletes the wish the button belongs to", async () => {
    preferences.data = [
      { id: "p1", subjectId: "s-no", roomTypeId: "rt-lab", weight: 5, rooms: [] },
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

});
