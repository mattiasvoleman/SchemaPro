import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { ApiError, api } from "@/lib/api";
import type { CancellationBatch, CancellationPreview } from "@/lib/publication-types";
import CancellationsPage from "./page";

/**
 * /admin/cancellations over the real hooks and the real Swedish messages,
 * the gateway answering by path. What only this page decides: nothing is
 * cancelled before a preview of the very selection on screen, the create
 * carries that preview's digest (and the credit only when asked), a form
 * changed after its preview cannot be confirmed, and a reversal shows what it
 * will leave cancelled — by room — before it runs.
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn() } };
});
const get = api.get as unknown as Mock;
const post = api.post as unknown as Mock;

vi.mock("@/lib/queries", () => ({
  useAcademicYears: () => ({
    data: [{ id: "y26", name: "2026/27", startDate: "2026-08-17", endDate: "2027-06-11", isActive: true, predecessorId: null }],
  }),
  useGroups: () => ({
    data: [
      { id: "g-9a", academicYearId: "y26", name: "9A", kind: "CLASS", gradeLevel: 9 },
      { id: "g-9b", academicYearId: "y26", name: "9B", kind: "CLASS", gradeLevel: 9 },
    ],
  }),
  useRooms: () => ({ data: [{ id: "r-12", name: "Sal 12" }] }),
  useSubjects: () => ({ data: [{ id: "s-idh", name: "Idrott och hälsa" }] }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const DIGEST = "c".repeat(64);
const PREVIEW: CancellationPreview = {
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
  creditDates: ["2026-11-02", "2026-11-03"],
  digest: DIGEST,
};
const BATCH: CancellationBatch = {
  id: "b-1",
  name: "Friluftsdag",
  cause: "EVENT",
  fromDate: "2026-10-20",
  toDate: "2026-10-20",
  startTime: null,
  endTime: null,
  scope: "SCHOOL",
  minGradeLevel: null,
  maxGradeLevel: null,
  groupIds: [],
  cancelled: 340,
  createdAt: "2026-10-01T08:00:00.000Z",
  createdByUserId: null,
  reversedAt: null,
  reinstated: 0,
  skippedRoomTaken: 0,
  credits: 1,
  addedSince: 4,
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <CancellationsPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

/** The DateField is a text input that takes yyyy-mm-dd typed in full. */
const typeDate = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("/admin/cancellations", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    get.mockImplementation(async () => [BATCH]);
  });

  it("previews the selection on screen and cancels with its digest and the credit", async () => {
    post.mockImplementation(async (path: string) =>
      path.endsWith("/preview") ? PREVIEW : { batch: BATCH, cancelled: 62, credits: 2 },
    );
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText("Namn"), "Prao åk 9");
    typeDate("Från och med", "2026-11-02");
    typeDate("Till och med", "2026-11-06");
    expect(screen.getByRole("button", { name: "Ställ in lektioner" })).toBeDisabled();
    await user.click(screen.getByRole("switch", { name: "Dagen räknas som undervisningstid" }));
    await user.type(screen.getByLabelText("Minuter per dag"), "300");

    await user.click(screen.getByRole("button", { name: "Förhandsgranska" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/cancellation-batches/preview", {
        academicYearId: "y26",
        name: "Prao åk 9",
        cause: "EVENT",
        fromDate: "2026-11-02",
        toDate: "2026-11-06",
        scope: "GRADES",
        minGradeLevel: 9,
        maxGradeLevel: 9,
      }),
    );
    expect(await screen.findByText("62 lektioner ställs in")).toBeInTheDocument();
    expect(screen.getByText("Lämnas orörda: 0 har börjat, 2 är redan inställda eller hållna, 1 har närvaro.")).toBeInTheDocument();
    expect(screen.getByText("Grupper utan egen årskurs, som inte räknas in: Sva9.")).toBeInTheDocument();
    expect(screen.getByText("2 dagar räknas som undervisningstid: 2026-11-02, 2026-11-03.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Ställ in 62 lektioner" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/cancellation-batches", {
        academicYearId: "y26",
        name: "Prao åk 9",
        cause: "EVENT",
        fromDate: "2026-11-02",
        toDate: "2026-11-06",
        scope: "GRADES",
        minGradeLevel: 9,
        maxGradeLevel: 9,
        expectedDigest: DIGEST,
        credit: { minutes: 300 },
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("62 lektioner ställdes in. Tillgodoräknade dagar: 2.");
  });

  it("will not confirm a form changed after its preview, and says a stale create in words", async () => {
    post.mockImplementation(async (path: string) => {
      if (path.endsWith("/preview")) return PREVIEW;
      throw new ApiError(409, "…", "CANCELLATION_STALE");
    });
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText("Namn"), "Studiedag");
    typeDate("Från och med", "2026-11-02");
    typeDate("Till och med", "2026-11-02");
    await user.click(screen.getByRole("button", { name: "Förhandsgranska" }));
    expect(await screen.findByRole("button", { name: "Ställ in 62 lektioner" })).toBeEnabled();

    typeDate("Till och med", "2026-11-03");
    expect(screen.getByText("Formuläret har ändrats sedan förhandsgranskningen. Förhandsgranska igen.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ställ in lektioner" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Förhandsgranska" }));
    await user.click(await screen.findByRole("button", { name: "Ställ in 62 lektioner" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Lektionerna i urvalet har ändrats sedan förhandsgranskningen.");
  });

  it("names the rules beside the form before anything is sent", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText("Namn"), "Prao");
    typeDate("Från och med", "2026-11-02");
    typeDate("Till och med", "2026-12-10");
    expect(screen.getByText("En avbokning gäller högst 31 dagar.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Förhandsgranska" })).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
  });

  it("lists the year's avbokningar, re-applies one to lessons added since, and reverses after saying which stay cancelled", async () => {
    post.mockImplementation(async (path: string) => {
      if (path.endsWith("/reapply")) return { batch: BATCH, added: 4 };
      if (path.endsWith("/reverse/preview")) {
        return { reinstate: 330, skippedRoomTaken: [{ lessonId: "cl-9", date: "2026-10-20", roomId: "r-12", by: "BOOKING" }], notReinstatable: 6, creditsDeleted: 1 };
      }
      return { reinstate: 330, skippedRoomTaken: [], notReinstatable: 6, creditsDeleted: 1 };
    });
    const user = userEvent.setup();
    renderPage();
    const row = (await screen.findByText("Friluftsdag")).closest("tr")!;
    expect(row).toHaveTextContent("4 lektioner har tillkommit sedan avbokningen.");
    expect(row).toHaveTextContent("1 tillgodoräknad dag");

    await user.click(within(row).getByRole("button", { name: "Tillämpa igen" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/cancellation-batches/b-1/reapply"));

    await user.click(within(row).getByRole("button", { name: "Ta tillbaka" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("330 lektioner återställs.")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("2026-10-20 · Sal 12 · en lokalbokning");
    expect(dialog).toHaveTextContent("6 lektioner har börjat eller ändrats sedan");
    expect(dialog).toHaveTextContent("1 tillgodoräknad dag tas bort.");
    await user.click(within(dialog).getByRole("button", { name: "Ta tillbaka" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/cancellation-batches/b-1/reverse"));
  });
});
