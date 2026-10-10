import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { ApiError, api } from "@/lib/api";
import type { Absence, AbsenceReason } from "@/lib/cover-types";
import { AbsenceDialog } from "@/components/cover/absence-dialog";
import { AbsenceRegister } from "./absence-register";

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/**
 * The absence register on Lärarfrånvaro over the real hooks and the Swedish
 * messages. What it decides: the body a registration sends (whole days
 * without times, part of a day with them, a category or none — never free
 * text), that an end or a withdrawal which would drop decided lessons asks
 * before undoing them, and that the reason is read here, on the admin's page.
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } };
});
const get = api.get as unknown as Mock;
const post = api.post as unknown as Mock;
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const TEACHERS = [
  { id: "t-anna", name: "Anna Lind" },
  { id: "t-bo", name: "Bo Ek" },
];
const REASONS: AbsenceReason[] = [
  { id: "r-sick", builtin: "SICK", label: null, sortOrder: 10, archived: false },
  { id: "r-vab", builtin: "CHILD_CARE", label: null, sortOrder: 20, archived: false },
  { id: "r-old", builtin: null, label: "Gammal", sortOrder: 30, archived: true },
];

const local = (date: string, time: string) => new Date(`${date}T${time}:00`).toISOString();
const ONGOING: Absence = {
  id: "a-1",
  userId: "t-anna",
  startsAt: local("2026-10-01", "00:00"),
  endsAt: local("2030-10-03", "00:00"),
  wholeDays: true,
  reasonId: "r-vab",
  status: "ACTIVE",
  phase: "ONGOING",
  selfReported: true,
  createdAt: local("2026-10-01", "07:10"),
  counts: { open: 2, covered: 1, cancelled: 0, handled: 0, passedOpen: 0 },
};

function wrap(children: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        {children}
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  get.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/v1/teacher-absences")) return [ONGOING];
    if (path === "/api/v1/teacher-absence-reasons") return REASONS;
    throw new Error(`unexpected GET ${path}`);
  });
});

describe("the absence register", () => {
  it("lists an absence with its reason, its lessons' cover state and a link to its day on the board", async () => {
    wrap(<AbsenceRegister teachers={TEACHERS} />);
    const row = (await screen.findByText("Anna Lind")).closest("tr")!;
    expect(within(row).getByText("Vård av barn")).toBeInTheDocument();
    expect(within(row).getByText("Anmäld av läraren")).toBeInTheDocument();
    expect(within(row).getByText("Pågår")).toBeInTheDocument();
    expect(within(row).getByText("2 behöver vikarie")).toBeInTheDocument();
    expect(within(row).getByText("1 med vikarie")).toBeInTheDocument();
    const link = within(row).getByRole("link", { name: /Vikarietavlan/ });
    expect(link.getAttribute("href")).toMatch(/^\/sv\/admin\/cover\?date=\d{4}-\d{2}-\d{2}$/);
  });

  it("ends an absence early, and undoes the decisions after the new end only when the admin says so", async () => {
    post
      .mockRejectedValueOnce(new ApiError(409, "Det finns beslut…", "ABSENCE_HAS_DECISIONS", { count: 2, lessonId: "l-1", decision: "SUBSTITUTE" }))
      .mockResolvedValueOnce({ ...ONGOING, phase: "ENDED" });
    const user = userEvent.setup();
    wrap(<AbsenceRegister teachers={TEACHERS} />);
    const row = (await screen.findByText("Anna Lind")).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Avsluta i förtid" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Dag"), { target: { value: "2030-10-02" } });
    fireEvent.change(within(dialog).getByLabelText("Klockan"), { target: { value: "12:00" } });
    await user.click(within(dialog).getByRole("button", { name: "Avsluta" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/teacher-absences/a-1/end", { at: local("2030-10-02", "12:00") }),
    );
    expect(await screen.findByText("Ångra besluten efter den nya sluttiden?")).toBeInTheDocument();
    expect(screen.getByText(/^2 lektioner efter tidpunkten/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ångra och avsluta" }));
    await waitFor(() =>
      expect(post).toHaveBeenLastCalledWith("/api/v1/teacher-absences/a-1/end", {
        at: local("2030-10-02", "12:00"),
        undoDecisions: true,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Frånvaron är avslutad");
  });

  it("withdraws an absence, asking first to undo what is decided on it", async () => {
    post
      .mockRejectedValueOnce(new ApiError(409, "…", "ABSENCE_HAS_DECISIONS", { count: 1, lessonId: "l-1", decision: "CANCELLED" }))
      .mockResolvedValueOnce({ ...ONGOING, status: "WITHDRAWN", phase: "WITHDRAWN" });
    const user = userEvent.setup();
    wrap(<AbsenceRegister teachers={TEACHERS} />);
    const row = (await screen.findByText("Anna Lind")).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Återkalla" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Återkalla" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/teacher-absences/a-1/withdraw", {}));
    await user.click(await screen.findByRole("button", { name: "Ångra och återkalla" }));
    await waitFor(() =>
      expect(post).toHaveBeenLastCalledWith("/api/v1/teacher-absences/a-1/withdraw", { undoDecisions: true }),
    );
  });

  it("says a held decision blocks a withdrawal in words, and does not offer to undo it", async () => {
    post.mockRejectedValueOnce(
      new ApiError(409, "Beslut finns på lektioner som redan hållits.", "ABSENCE_HAS_HELD_DECISIONS", { count: 1 }),
    );
    const user = userEvent.setup();
    wrap(<AbsenceRegister teachers={TEACHERS} />);
    const row = (await screen.findByText("Anna Lind")).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Återkalla" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Återkalla" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Det finns beslut på lektioner som redan har hållits. Avsluta frånvaron i förtid i stället.",
      ),
    );
    expect(screen.queryByRole("button", { name: "Ångra och återkalla" })).not.toBeInTheDocument();
  });
});

describe("Registrera frånvaro", () => {
  const openDialog = () =>
    wrap(
      <AbsenceDialog
        open
        onOpenChange={() => {}}
        mode="ADMIN"
        teachers={TEACHERS}
        initial={{ userId: "t-anna", from: "2030-10-14", to: "2030-10-15" }}
      />,
    );

  it("registers whole days without times or a reason when none is chosen", async () => {
    post.mockResolvedValue(ONGOING);
    const user = userEvent.setup();
    openDialog();
    await user.click(screen.getByRole("button", { name: "Registrera" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/teacher-absences", {
        userId: "t-anna",
        from: "2030-10-14",
        to: "2030-10-15",
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Frånvaron är registrerad");
  });

  it("registers part of a day with its times and a category, and offers no free-text field", async () => {
    post.mockResolvedValue(ONGOING);
    const user = userEvent.setup();
    openDialog();
    fireEvent.change(screen.getByLabelText("Till och med"), { target: { value: "2030-10-14" } });
    await user.click(screen.getByRole("checkbox", { name: "Del av dag" }));
    fireEvent.change(screen.getByLabelText("Från klockan (första dagen)"), { target: { value: "08:00" } });
    fireEvent.change(screen.getByLabelText("Till klockan (sista dagen)"), { target: { value: "12:00" } });
    await user.click(screen.getByRole("combobox", { name: "Orsak" }));
    // An archived reason is not offered for a new absence.
    expect(screen.queryByRole("option", { name: "Gammal" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: "Vård av barn" }));
    // The only text fields are the two dates: no note, no free-text reason.
    expect(document.querySelector("textarea")).toBeNull();
    expect(screen.getAllByRole("textbox")).toEqual([
      screen.getByLabelText("Från och med"),
      screen.getByLabelText("Till och med"),
    ]);
    await user.click(screen.getByRole("button", { name: "Registrera" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/teacher-absences", {
        userId: "t-anna",
        from: "2030-10-14",
        to: "2030-10-14",
        startTime: "08:00",
        endTime: "12:00",
        reasonId: "r-vab",
      }),
    );
  });

  it("says what is wrong before a round trip: an end before the start on one day", async () => {
    const user = userEvent.setup();
    openDialog();
    fireEvent.change(screen.getByLabelText("Till och med"), { target: { value: "2030-10-14" } });
    await user.click(screen.getByRole("checkbox", { name: "Del av dag" }));
    fireEvent.change(screen.getByLabelText("Från klockan (första dagen)"), { target: { value: "12:00" } });
    fireEvent.change(screen.getByLabelText("Till klockan (sista dagen)"), { target: { value: "08:00" } });
    await user.click(screen.getByRole("button", { name: "Registrera" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Ange minst en tid – och samma dag en sluttid efter starttiden.");
    expect(post).not.toHaveBeenCalled();
  });

  it("says an overlap in words", async () => {
    post.mockRejectedValue(new ApiError(409, "…", "ABSENCE_OVERLAPS", { otherAbsenceId: "a-9" }));
    const user = userEvent.setup();
    openDialog();
    await user.click(screen.getByRole("button", { name: "Registrera" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Läraren är redan registrerad som frånvarande under en del av perioden."),
    );
  });
});
