import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RoomsPage from "./page";

/**
 * What this file guards: WHERE A ROOM IS.
 *
 * Building and floor change nothing on this page; they change what the room
 * optimisation counts as a walk, a week later and on another page. A form
 * that drops them, or sends an empty floor as 0, looks exactly like one that
 * works — and floor 0 is a real floor, so the second mistake would count a
 * climb from every unplaced room to every room upstairs.
 */

const createMock = vi.fn();
const updateMock = vi.fn();

const state = vi.hoisted(() => ({ rooms: [] as unknown[] }));

vi.mock("@/lib/queries", () => ({
  useRooms: () => ({ data: state.rooms, isLoading: false }),
  useRoomTypes: () => ({ data: [] }),
  useCrudMutations: () => ({
    create: { mutateAsync: createMock, isPending: false },
    update: { mutateAsync: updateMock, isPending: false },
    remove: { mutateAsync: vi.fn(), isPending: false },
  }),
}));

// The CSV buttons bring the import machinery and its own queries; neither has
// anything to do with where a room is.
vi.mock("@/components/import/csv-import-dialog", () => ({ CsvImportDialog: () => null }));
vi.mock("@/components/import/csv-export-button", () => ({ CsvExportButton: () => null }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

const room = (id: string, name: string, building: string | null, floor: number | null) => ({
  id,
  name,
  code: null,
  capacity: 30,
  roomTypeId: null,
  minGradeLevel: null,
  maxGradeLevel: null,
  requiresApproval: false,
  building,
  floor,
});

beforeEach(() => {
  createMock.mockReset().mockResolvedValue({});
  updateMock.mockReset().mockResolvedValue({});
  state.rooms = [];
});

/**
 * The Plats cell of the row naming the room — found by the first cell's text,
 * because a regex word boundary does not see the end of "Entré".
 */
const placeOf = (name: string) => {
  const row = screen
    .getAllByRole("row")
    .find((candidate) => within(candidate).queryAllByRole("cell")[0]?.textContent === name)!;
  const cells = within(row).getAllByRole("cell");
  return cells[cells.length - 2]!.textContent;
};

describe("the Plats column", () => {
  it("says building and floor, either one, or that it does not know", () => {
    state.rooms = [
      room("r-1", "Sal 1", "Hus A", 2),
      room("r-2", "Sal 2", null, 1),
      room("r-3", "Sal 3", "Hus B", null),
      room("r-4", "Sal 4", null, null),
    ];
    render(<RoomsPage />);

    expect(screen.getByRole("columnheader", { name: "placeColumn" })).toBeInTheDocument();
    expect(placeOf("Sal 1")).toBe("Hus A · floorShort(2)");
    expect(placeOf("Sal 2")).toBe("floorShort(1)");
    expect(placeOf("Sal 3")).toBe("Hus B");
    expect(placeOf("Sal 4")).toBe("—");
  });

  it("shows a ground floor numbered 0 as a floor", () => {
    state.rooms = [room("r-1", "Entré", null, 0)];
    render(<RoomsPage />);

    expect(placeOf("Entré")).toBe("floorShort(0)");
  });
});

describe("the Byggnad and Våning fields", () => {
  it("sends both with a new room", async () => {
    const user = userEvent.setup();
    render(<RoomsPage />);
    await user.click(screen.getAllByRole("button", { name: "addRoom" })[0]!);

    await user.type(screen.getByLabelText("name"), "Sal 10");
    await user.type(screen.getByLabelText("building (optional)"), "  Hus A ");
    await user.type(screen.getByLabelText("floor (optional)"), "2");
    await user.click(screen.getByRole("button", { name: "save" }));

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Sal 10", building: "Hus A", floor: 2 }),
    );
  });

  it("sends empty fields as null, never as 0 or an empty name", async () => {
    const user = userEvent.setup();
    render(<RoomsPage />);
    await user.click(screen.getAllByRole("button", { name: "addRoom" })[0]!);

    await user.type(screen.getByLabelText("name"), "Sal 10");
    await user.type(screen.getByLabelText("building (optional)"), "   ");
    await user.click(screen.getByRole("button", { name: "save" }));

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ building: null, floor: null }),
    );
  });

  it("opens an edit on the room's own place, and clearing it sends null", async () => {
    state.rooms = [room("r-1", "Sal 1", "Hus A", 2)];
    const user = userEvent.setup();
    render(<RoomsPage />);
    await user.click(screen.getByRole("button", { name: "edit" }));

    const building = screen.getByLabelText("building (optional)");
    const floor = screen.getByLabelText("floor (optional)");
    expect(building).toHaveValue("Hus A");
    expect(floor).toHaveValue(2);

    await user.clear(building);
    await user.clear(floor);
    await user.click(screen.getByRole("button", { name: "save" }));

    // Sent as null rather than left out: an absent key keeps the old place.
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "r-1", building: null, floor: null }),
    );
  });

  it("will not save a floor the database would refuse", async () => {
    const user = userEvent.setup();
    render(<RoomsPage />);
    await user.click(screen.getAllByRole("button", { name: "addRoom" })[0]!);

    await user.type(screen.getByLabelText("name"), "Tornet");
    await user.type(screen.getByLabelText("floor (optional)"), "51");

    expect(screen.getByText("floorInvalid")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();

    await user.clear(screen.getByLabelText("floor (optional)"));
    await user.type(screen.getByLabelText("floor (optional)"), "-5");
    expect(screen.getByRole("button", { name: "save" })).toBeEnabled();
  });
});
