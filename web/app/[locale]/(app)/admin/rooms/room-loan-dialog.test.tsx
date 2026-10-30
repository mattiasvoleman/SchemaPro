import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_WINDOWS, RoomLoanDialog, requestProblem } from "./room-loan-dialog";
import type { LendableSchool } from "./use-sharing";

/**
 * Låna en sal: one request, one loan per weekly time. The dialog refuses
 * what the database would (a time that ends before it starts, the same time
 * twice, dates the wrong way round or more than 400 days apart), and names
 * the school's own room for the loan only the first time a room is asked for.
 */

const state = vi.hoisted(() => ({ rooms: [] as LendableSchool[] }));
const requestLoan = vi.fn();

vi.mock("./use-sharing", async () => ({
  ...(await vi.importActual<typeof import("./use-sharing")>("./use-sharing")),
  useLendableRooms: () => ({ data: state.rooms, isLoading: false, isError: false }),
  useRequestRoomLoan: () => ({ mutateAsync: requestLoan, isPending: false }),
}));
vi.mock("@/components/ui/date-field", () => ({
  DateField: ({ id, value, onChange }: { id?: string; value: string; onChange: (value: string) => void }) => (
    <input id={id} value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}(${Object.values(values).join("|")})` : key;
    t.has = () => false;
    return t;
  },
}));

const HALL = "10000000-0000-4000-8000-000000000001";
const SLOJD = "20000000-0000-4000-8000-000000000002";

beforeEach(() => {
  requestLoan.mockReset().mockResolvedValue({ lent: [], borrowed: [] });
  state.rooms = [
    {
      id: "s1",
      name: "Rollerskolan",
      rooms: [
        { id: HALL, name: "Idrottshallen", capacity: 60, roomTypeName: "Idrottshall", localRoomId: null },
        { id: SLOJD, name: "Slöjdsalen", capacity: null, roomTypeName: null, localRoomId: "local" },
      ],
    },
  ];
});

describe("requestProblem", () => {
  const w = (dayOfWeek: string, startTime: string, endTime: string) => ({ dayOfWeek, startTime, endTime });
  it("accepts a request the database would take", () => {
    expect(requestProblem([w("2", "10:00", "11:30"), w("4", "10:00", "11:30")], "2030-08-19", "2031-06-13")).toBeNull();
    expect(requestProblem([w("2", "10:00", "11:30")], "2030-08-19", "2031-09-23")).toBeNull();
  });
  it("names what the database would refuse", () => {
    expect(requestProblem([w("2", "", "11:30")], "2030-08-19", "2031-06-13")).toBe("windowTimes");
    expect(requestProblem([w("2", "11:30", "11:30")], "2030-08-19", "2031-06-13")).toBe("windowOrder");
    expect(requestProblem([w("2", "10:00", "11:00"), w("2", "10:00", "12:00")], "2030-08-19", "2031-06-13")).toBe("windowTwice");
    expect(requestProblem([w("2", "10:00", "11:00")], "", "2031-06-13")).toBe("dates");
    expect(requestProblem([w("2", "10:00", "11:00")], "2031-06-13", "2030-08-19")).toBe("datesOrder");
    expect(requestProblem([w("2", "10:00", "11:00")], "2030-08-19", "2031-09-24")).toBe("datesTooLong");
  });
});

describe("RoomLoanDialog", () => {
  const fill = async () => {
    await userEvent.selectOptions(screen.getByLabelText("fields.room"), HALL);
    await userEvent.type(screen.getByLabelText("fields.start"), "10:00");
    await userEvent.type(screen.getByLabelText("fields.end"), "11:30");
    await userEvent.type(screen.getByLabelText("fields.from"), "2030-08-19");
    await userEvent.type(screen.getByLabelText("fields.to"), "2031-06-13");
  };

  it("sends one request with every time, the dates, the note and the local room's name", async () => {
    const onOpenChange = vi.fn();
    render(<RoomLoanDialog open onOpenChange={onOpenChange} />);
    const send = screen.getByRole("button", { name: "send" });
    expect(send).toBeDisabled();
    await fill();
    expect(screen.getByLabelText(/fields.localRoom/)).toHaveAttribute("placeholder", "Idrottshallen (Rollerskolan)");
    await userEvent.type(screen.getByLabelText(/fields.localRoom/), "Lånad hall");
    await userEvent.type(screen.getByLabelText(/fields.note/), "  Idrott åk 7 ");
    await userEvent.click(screen.getByRole("button", { name: "addWindow" }));
    const starts = screen.getAllByLabelText("fields.start");
    const ends = screen.getAllByLabelText("fields.end");
    await userEvent.selectOptions(screen.getAllByLabelText("fields.day")[1]!, "4");
    await userEvent.type(starts[1]!, "13:00");
    await userEvent.type(ends[1]!, "14:00");
    await userEvent.click(send);
    expect(requestLoan).toHaveBeenCalledWith({
      roomId: HALL,
      windows: [
        { dayOfWeek: 1, startTime: "10:00", endTime: "11:30" },
        { dayOfWeek: 4, startTime: "13:00", endTime: "14:00" },
      ],
      startDate: "2030-08-19",
      endDate: "2031-06-13",
      note: "Idrott åk 7",
      localRoomName: "Lånad hall",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("asks no name for a room the school already has a room of its own for", async () => {
    render(<RoomLoanDialog open onOpenChange={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText("fields.room"), SLOJD);
    expect(screen.queryByLabelText(/fields.localRoom/)).not.toBeInTheDocument();
  });

  it("holds the send back while a time ends before it starts, and says why", async () => {
    render(<RoomLoanDialog open onOpenChange={vi.fn()} />);
    await fill();
    await userEvent.clear(screen.getByLabelText("fields.end"));
    await userEvent.type(screen.getByLabelText("fields.end"), "09:00");
    expect(screen.getByText("problems.windowOrder")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "send" })).toBeDisabled();
  });

  it(`takes at most ${MAX_WINDOWS} times, and always keeps one`, async () => {
    render(<RoomLoanDialog open onOpenChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "removeWindow(1)" })).toBeDisabled();
    const add = screen.getByRole("button", { name: "addWindow" });
    for (let i = 1; i < MAX_WINDOWS; i++) await userEvent.click(add);
    expect(screen.getAllByLabelText("fields.day")).toHaveLength(MAX_WINDOWS);
    expect(add).toBeDisabled();
  });
});
