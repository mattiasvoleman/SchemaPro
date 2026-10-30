import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SharingCard } from "./sharing-card";
import type { RoomLoan, RoomLoans, Sharing } from "./use-sharing";

/**
 * Delade lokaler och lärare: the card a school sees only when its huvudman
 * owns another school. It saves the minutes to each school that changed,
 * signs nothing itself (the gateway does), shows who is shared, and offers
 * each side of a loan its own answers: the owner approves, declines or
 * ends; the borrower withdraws.
 */

const state = vi.hoisted(() => ({
  sharing: undefined as Sharing | undefined,
  sharingError: false,
  loans: undefined as RoomLoans | undefined,
  loansEnabled: undefined as boolean | undefined,
}));
const saveTravel = vi.fn();
const loanAction = vi.fn();

vi.mock("./use-sharing", async () => {
  const actual = await vi.importActual<typeof import("./use-sharing")>("./use-sharing");
  return {
    ...actual,
    useSharing: () => ({ data: state.sharing, isError: state.sharingError }),
    useRoomLoans: (enabled: boolean) => {
      state.loansEnabled = enabled;
      return { data: enabled ? state.loans : undefined, isError: false };
    },
    useSaveSchoolTravel: () => ({ mutateAsync: saveTravel, isPending: false }),
    useRoomLoanAction: () => ({ mutateAsync: loanAction, isPending: false }),
  };
});
vi.mock("./room-loan-dialog", () => ({
  RoomLoanDialog: ({ open }: { open: boolean }) => (open ? <div role="dialog">loan dialog</div> : null),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const profile = vi.hoisted(() => ({ readOnly: false }));
vi.mock("@/components/profile-context", () => ({ useReadOnly: () => profile.readOnly }));
vi.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}(${Object.values(values).join("|")})` : key;
    t.has = () => false;
    return t;
  },
}));

const ROLLER = "10000000-0000-4000-8000-000000000001";
const NORRA = "20000000-0000-4000-8000-000000000002";

const loan = (patch: Partial<RoomLoan>): RoomLoan => ({
  id: "30000000-0000-4000-8000-000000000003",
  status: "PENDING",
  dayOfWeek: 2,
  startTime: "10:00",
  endTime: "11:30",
  startDate: "2030-08-19",
  endDate: "2031-06-13",
  note: null,
  createdAt: "2030-06-01T08:00:00.000Z",
  decidedAt: null,
  endedAt: null,
  room: { id: "40000000-0000-4000-8000-000000000004", name: "Idrottshallen" },
  school: { id: ROLLER, name: "Rollerskolan" },
  ownerRoomName: null,
  ...patch,
});

beforeEach(() => {
  state.sharing = undefined;
  state.sharingError = false;
  state.loans = { lent: [], borrowed: [] };
  state.loansEnabled = undefined;
  saveTravel.mockReset().mockResolvedValue({ schools: [], teachers: [] });
  loanAction.mockReset().mockResolvedValue({ lent: [], borrowed: [] });
  profile.readOnly = false;
});

const withSchools = () => {
  state.sharing = {
    schools: [
      { id: ROLLER, name: "Rollerskolan", travelMinutes: 15, travelSetByUs: false },
      { id: NORRA, name: "Norraskolan", travelMinutes: null, travelSetByUs: null },
    ],
    teachers: [{ teacherId: "t1", firstName: "Anna", lastName: "Berg", schools: [{ id: ROLLER, name: "Rollerskolan" }] }],
  };
};

describe("SharingCard", () => {
  it("shows nothing, and asks for no loans, at a school whose huvudman owns no other school", () => {
    state.sharing = { schools: [], teachers: [] };
    const { container } = render(<SharingCard />);
    expect(container).toBeEmptyDOMElement();
    expect(state.loansEnabled).toBe(false);
  });

  it("says it could not read rather than showing nothing when the gateway fails", () => {
    state.sharingError = true;
    render(<SharingCard />);
    expect(screen.getByText("loadFailed")).toBeInTheDocument();
  });

  it("lists the other schools with their travel time and shared teachers", () => {
    withSchools();
    render(<SharingCard />);
    const roller = screen.getByRole("row", { name: /Rollerskolan/ });
    expect(within(roller).getByRole("textbox")).toHaveValue("15");
    expect(within(roller).getByText("Anna Berg")).toBeInTheDocument();
    expect(within(roller).getByText("setByThem(Rollerskolan)")).toBeInTheDocument();
    const norra = screen.getByRole("row", { name: /Norraskolan/ });
    expect(within(norra).getByRole("textbox")).toHaveValue("");
    expect(within(norra).getByText("noTeachers")).toBeInTheDocument();
  });

  it("saves only the figures that changed, an emptied field as none, and refuses a figure out of range", async () => {
    withSchools();
    render(<SharingCard />);
    const save = screen.getByRole("button", { name: "saveTravel" });
    expect(save).toBeDisabled();
    const norra = within(screen.getByRole("row", { name: /Norraskolan/ })).getByRole("textbox");
    await userEvent.type(norra, "241");
    expect(screen.getByText("minutesInvalid")).toBeInTheDocument();
    expect(save).toBeDisabled();
    await userEvent.clear(norra);
    await userEvent.type(norra, "20");
    const roller = within(screen.getByRole("row", { name: /Rollerskolan/ })).getByRole("textbox");
    await userEvent.clear(roller);
    await userEvent.click(save);
    expect(saveTravel).toHaveBeenCalledTimes(2);
    expect(saveTravel).toHaveBeenCalledWith({ schoolId: ROLLER, minutes: null });
    expect(saveTravel).toHaveBeenCalledWith({ schoolId: NORRA, minutes: 20 });
  });

  it("lets the owner approve or decline a pending loan, and end an approved one after asking", async () => {
    withSchools();
    state.loans = {
      lent: [loan({ id: "p", status: "PENDING", note: "Idrott åk 7" }), loan({ id: "a", status: "APPROVED", dayOfWeek: 3 })],
      borrowed: [],
    };
    render(<SharingCard />);
    expect(screen.getByText("Idrott åk 7")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "actions.approve" }));
    expect(loanAction).toHaveBeenCalledWith({ id: "p", action: "approve" });
    await userEvent.click(screen.getByRole("button", { name: "actions.decline" }));
    expect(loanAction).toHaveBeenCalledWith({ id: "p", action: "decline" });
    await userEvent.click(screen.getByRole("button", { name: "actions.revoke" }));
    expect(loanAction).toHaveBeenCalledTimes(2);
    const confirm = await screen.findByRole("dialog");
    await userEvent.click(within(confirm).getByRole("button", { name: "actions.revoke" }));
    expect(loanAction).toHaveBeenLastCalledWith({ id: "a", action: "revoke" });
  });

  it("lets the borrower withdraw a live loan, names the owner's room, and offers nothing on an ended one", async () => {
    withSchools();
    state.loans = {
      lent: [],
      borrowed: [
        loan({ id: "b", status: "APPROVED", room: { id: "r", name: "Idrottshallen (Rollerskolan)" }, ownerRoomName: "Idrottshallen" }),
        loan({ id: "d", status: "DECLINED", createdAt: "2030-05-01T08:00:00.000Z" }),
      ],
    };
    render(<SharingCard />);
    expect(screen.getByText("ownerRoom(Idrottshallen|Rollerskolan)")).toBeInTheDocument();
    const withdraw = screen.getAllByRole("button", { name: "actions.withdraw" });
    expect(withdraw).toHaveLength(1);
    await userEvent.click(withdraw[0]!);
    const confirm = await screen.findByRole("dialog");
    await userEvent.click(within(confirm).getByRole("button", { name: "actions.withdraw" }));
    expect(loanAction).toHaveBeenCalledWith({ id: "b", action: "withdraw" });
  });

  it("opens the request dialog when asked, and not before", async () => {
    withSchools();
    render(<SharingCard />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "borrow" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("loan dialog");
  });

  it("marks every write for planering, and keeps the läsare's figures read-only", () => {
    profile.readOnly = true;
    withSchools();
    state.loans = { lent: [loan({ status: "PENDING" })], borrowed: [loan({ id: "b", status: "APPROVED" })] };
    render(<SharingCard />);
    for (const name of ["saveTravel", "borrow", "actions.approve", "actions.decline", "actions.withdraw"]) {
      expect(screen.getByRole("button", { name }).closest("[data-writes='PLANERING']")).not.toBeNull();
    }
    for (const field of screen.getAllByRole("textbox")) expect(field).toHaveAttribute("readonly");
  });
});
