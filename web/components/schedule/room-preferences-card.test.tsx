import { render, screen, within } from "@testing-library/react";
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
      weight: 50,
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
      weight: 50,
    });
  });

  it("lists a stated wish in words, not ids", async () => {
    preferences.data = [
      { id: "p1", subjectId: "s-no", roomTypeId: null, weight: 200, rooms: [{ roomId: "r-a12" }] },
    ];
    render(<RoomPreferencesCard />);

    expect(screen.getByText(/preferenceSummary\(NO\|A12\)/)).toBeInTheDocument();
    expect(screen.getByText("preferenceWeightBadge(200)")).toBeInTheDocument();
  });

  it("deletes the wish the button belongs to", async () => {
    preferences.data = [
      { id: "p1", subjectId: "s-no", roomTypeId: "rt-lab", weight: 50, rooms: [] },
    ];
    const user = userEvent.setup();
    render(<RoomPreferencesCard />);

    await user.click(within(screen.getByRole("list")).getByRole("button", { name: "delete" }));

    expect(remove).toHaveBeenCalledWith("p1");
  });
});
