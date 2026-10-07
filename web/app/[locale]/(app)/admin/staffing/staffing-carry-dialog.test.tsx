import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { ApiError, api } from "@/lib/api";
import type { StaffingRolloverPreview } from "@/lib/types";
import { StaffingCarryDialog } from "./staffing-carry-dialog";

/**
 * The carry into an already rolled year, over the real hooks and the real
 * Swedish messages, with the gateway mocked at lib/api: what is previewed,
 * what is sent (the preview's hash and nothing else), a stale 409 said and
 * the preview fetched again, and the extra confirmation for the active year.
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } };
});
const post = api.post as unknown as Mock;
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const HASH = "b".repeat(64);
const names: Record<string, string> = { "t-bo": "Bo Alm", "t-cilla": "Cilla Öst" };

const preview = (overrides: Partial<StaffingRolloverPreview> = {}): StaffingRolloverPreview => ({
  source: { id: "y26", name: "2026/27" },
  target: { id: "y27", name: "2027/28" },
  employments: {
    carried: 1,
    withReduction: [],
    withTargetOverride: ["t-bo"],
    notCarried: [{ userId: "t-cilla", reason: "ALREADY_PRESENT" }],
    signaturesDropped: [],
  },
  duties: {
    carried: 2,
    slots: 1,
    followedGroup: 1,
    relabelled: [],
    groupDropped: [],
    slotDropped: [],
    overlapsTargetDuty: [],
    successorHasMentor: [{ sourceDutyId: "d-1", userId: "t-bo", kind: "MENTORSKAP", label: "Mentor 8A", groupName: "8A" }],
    notCarried: [],
  },
  teachers: [],
  problems: [{ code: "STAFFING_ALREADY_PRESENT", blocking: false, params: { teachers: 1, duties: 0 } }],
  blocking: false,
  planHash: HASH,
  ...overrides,
});

function renderDialog(year = { id: "y27", name: "2027/28", isActive: false }) {
  const onOpenChange = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider
        locale="sv"
        messages={sv}
        timeZone="Europe/Stockholm"
        onError={(error) => {
          throw error;
        }}
      >
        <StaffingCarryDialog year={year} onOpenChange={onOpenChange} teacherName={(id) => names[id] ?? id} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

const previews = () => post.mock.calls.filter(([path]) => String(path).endsWith("/staffing-rollover/preview"));
const executes = () => post.mock.calls.filter(([path]) => String(path).endsWith("/staffing-rollover"));

describe("StaffingCarryDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    post.mockImplementation(async (path: string) =>
      path.endsWith("/preview")
        ? preview()
        : { targetYearId: "y27", counts: { employments: 1, duties: 2, dutySlots: 1 }, planHash: HASH },
    );
  });

  it("previews the target year, names who is skipped and what to check, and carries with the preview's hash", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();
    expect(
      await screen.findByText(/Från 2026\/27 till 2027\/28\. Inget skrivs över/),
    ).toBeInTheDocument();
    expect(previews()[0]?.[0]).toBe("/api/v1/academic-years/y27/staffing-rollover/preview");
    expect(screen.getByText("Har redan en tjänst i läsåret och hoppas över helt, med sina uppdrag").nextElementSibling).toHaveTextContent(
      "Cilla Öst",
    );
    expect(screen.getByText("Det egna riktmärket följer med — gäller det även nästa läsår?").nextElementSibling).toHaveTextContent(
      "Bo Alm",
    );
    expect(screen.getByText("Klassen har redan en mentor i läsåret").nextElementSibling).toHaveTextContent(
      "Mentor 8A — Bo Alm",
    );
    expect(screen.getByText(/1 lärare har redan en tjänst i läsåret och hoppas över helt/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Ta med" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(executes()).toEqual([["/api/v1/academic-years/y27/staffing-rollover", { planHash: HASH }]]);
    expect(toast.success).toHaveBeenCalledWith("2027/28 fick 1 tjänst och 2 uppdrag.");
  });

  it("says a stale preview wrote nothing, and fetches it again", async () => {
    post.mockImplementation(async (path: string) => {
      if (path.endsWith("/preview")) return preview();
      throw new ApiError(409, "…", "STAFFING_ROLLOVER_PREVIEW_STALE");
    });
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();
    const button = await screen.findByRole("button", { name: "Ta med" });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Tjänster eller uppdrag ändrades efter förhandsvisningen. Inget skapades",
    );
    await waitFor(() => expect(previews().length).toBe(2));
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("asks once more before carrying into the active year", async () => {
    const user = userEvent.setup();
    renderDialog({ id: "y27", name: "2027/28", isActive: true });
    const confirm = await screen.findByRole("checkbox", { name: /2027\/28 är det aktiva läsåret/ });
    const button = screen.getByRole("button", { name: "Ta med" });
    expect(button).toBeDisabled();
    await user.click(confirm);
    expect(button).toBeEnabled();
  });

  it("has nothing to send when everything is already there", async () => {
    post.mockResolvedValue(
      preview({
        employments: {
          carried: 0,
          withReduction: [],
          withTargetOverride: [],
          notCarried: [{ userId: "t-cilla", reason: "ALREADY_PRESENT" }],
          signaturesDropped: [],
        },
        duties: { ...preview().duties, carried: 0, slots: 0, followedGroup: 0, successorHasMentor: [] },
      }),
    );
    renderDialog();
    expect(await screen.findByText("Allt som kan tas med finns redan i läsåret.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ta med" })).toBeDisabled();
  });

  it("says why a year that was not rolled has nothing to carry", async () => {
    post.mockRejectedValue(
      new ApiError(409, "…", "STAFFING_ROLLOVER_NO_PREDECESSOR", { year: "2027/28" }),
    );
    renderDialog();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Läsåret 2027/28 rullades inte vidare från något läsår, så det finns inga tjänster att ta med.",
    );
    expect(screen.getByRole("button", { name: "Ta med" })).toBeDisabled();
  });
});
