import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { ApiError, api } from "@/lib/api";
import type { AcademicYear, ActivationPreview } from "@/lib/types";
import YearsPage from "./page";

/**
 * /admin/years and its activation dialog, over the real hooks and the real
 * Swedish messages (an untranslated key or an unfilled ICU argument throws).
 *
 * The chain under test is the one a school has between spring and summer:
 * 2025/26 finished, 2026/27 active and rolled, 2027/28 rolled from it with
 * its pupils still waiting. What only these two components decide: which
 * actions each year offers, what the pending column says (read from the
 * activation's own preview), that the dialog names the pupils the gateway
 * sends as ids, that a refusal disables the button, and that the execute
 * carries the preview's hash.
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } };
});
const post = api.post as unknown as Mock;
const del = api.delete as unknown as Mock;

const state = vi.hoisted(() => ({ years: [] as AcademicYear[] }));
const y25: AcademicYear = { id: "y25", name: "2025/26", startDate: "2025-08-18", endDate: "2026-06-12", isActive: false, predecessorId: null, graduatingGradeLevel: null };
const y26: AcademicYear = { id: "y26", name: "2026/27", startDate: "2026-08-17", endDate: "2027-06-11", isActive: true, predecessorId: "y25", graduatingGradeLevel: 9 };
const y27: AcademicYear = { id: "y27", name: "2027/28", startDate: "2027-08-16", endDate: "2028-06-09", isActive: false, predecessorId: "y26", graduatingGradeLevel: 9 };

vi.mock("@/lib/queries", () => ({
  useAcademicYears: () => ({ data: state.years, isLoading: false, isError: false }),
  useGroups: () => ({
    data: [{ id: "g-8b", academicYearId: "y26", name: "8B", kind: "CLASS", gradeLevel: 8 }],
  }),
  usePeople: () => ({
    data: [
      { id: "p-1", firstName: "Ada", lastName: "Berg" },
      { id: "p-2", firstName: "Bea", lastName: "Ek" },
      { id: "p-3", firstName: "Cid", lastName: "Falk" },
      { id: "p-4", firstName: "Dan", lastName: "Gran" },
    ],
  }),
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const HASH = "b".repeat(64);
const plan = (overrides: Partial<ActivationPreview> = {}): ActivationPreview => ({
  year: { id: "y27", name: "2027/28", isActive: false },
  currentlyActive: { id: "y26", name: "2026/27" },
  chain: [{ id: "y26", name: "2026/27", endDate: "2027-06-11" }],
  moves: [{ fromGroupId: "g-7a", fromGroupName: "7A", toGroupId: "g27-8a", toGroupName: "8A", count: 2 }],
  graduates: { count: 1, studentIds: ["p-3"] },
  unplaced: { count: 1, studentIds: ["p-4"], pupils: [{ studentId: "p-4", fromGroupId: "g-8b", reason: "NO_SUCCESSOR" }] },
  alreadyInYear: 0,
  inLaterYear: 0,
  otherOrNone: 3,
  inactiveUntouched: 1,
  problems: [],
  blocking: false,
  planHash: HASH,
  ...overrides,
});

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider
        locale="sv"
        messages={sv}
        timeZone="Europe/Stockholm"
        onError={(error) => {
          throw error;
        }}
      >
        <YearsPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const rowOf = (name: string) => screen.getByText(name, { selector: "div.font-medium" }).closest("tr")!;

describe("YearsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.years = [y25, y26, y27];
  });

  it("shows each year's status, its links, and what the coming year's activation waits for", async () => {
    post.mockResolvedValue(
      plan({
        problems: [{ code: "YEAR_ACTIVATION_TOO_EARLY", blocking: true, params: { year: "2026/27", endDate: "2027-06-11" } }],
        blocking: true,
      }),
    );
    renderPage();
    expect(within(rowOf("2025/26")).getByText("Avslutat")).toBeInTheDocument();
    expect(within(rowOf("2026/27")).getByText("Aktivt")).toBeInTheDocument();
    expect(within(rowOf("2026/27")).getByText("Rullat vidare till 2027/28")).toBeInTheDocument();
    expect(within(rowOf("2027/28")).getByText("Kommande")).toBeInTheDocument();
    expect(within(rowOf("2027/28")).getByText("Rullat från 2026/27")).toBeInTheDocument();

    // Moved, graduating and unplaced alike leave their class at activation.
    expect(await within(rowOf("2027/28")).findByText("4 elever flyttar hit vid aktiveringen")).toBeInTheDocument();
    expect(within(rowOf("2027/28")).getByText("Kan aktiveras när 2026/27 har slutat (2027-06-11)")).toBeInTheDocument();
    // Only the one year that has pupils to receive is previewed.
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/api/v1/academic-years/y27/activation/preview");
  });

  it("offers Rulla vidare only where a rollover can start", async () => {
    post.mockResolvedValue(plan());
    renderPage();
    // Already rolled: no second successor.
    expect(within(rowOf("2026/27")).queryByRole("link", { name: /Rulla vidare/ })).toBeNull();
    expect(within(rowOf("2026/27")).queryByRole("button", { name: /Rulla vidare/ })).toBeNull();
    // Rolled but not activated: its own classes are still empty.
    await waitFor(() => expect(within(rowOf("2027/28")).getByRole("button", { name: "Rulla vidare" })).toBeDisabled());
    // Finished years are history.
    expect(within(rowOf("2025/26")).queryByText("Rulla vidare")).toBeNull();
  });

  it("links the active year to the wizard when it has no successor yet", () => {
    state.years = [{ ...y26, predecessorId: null }];
    renderPage();
    expect(within(rowOf("2026/27")).getByRole("link", { name: /Rulla vidare/ })).toHaveAttribute(
      "href",
      "/admin/years/rollover?from=y26",
    );
    expect(within(rowOf("2026/27")).queryByRole("button", { name: "Aktivera" })).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it("previews the activation with the pupils named, then activates by the preview's hash", async () => {
    post.mockImplementation(async (path: string) =>
      path.endsWith("/preview") ? plan() : { year: { id: "y27", name: "2027/28", isActive: true }, moved: 2, graduated: 1, unplaced: 1 },
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(within(rowOf("2027/28")).getByRole("button", { name: "Aktivera" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("2027/28 blir skolans aktiva läsår i stället för 2026/27, och eleverna flyttar till sina nya klasser.")).toBeInTheDocument();
    expect(await within(dialog).findByText("2 elever")).toBeInTheDocument();
    expect(within(dialog).getByText("Går ut (1)")).toBeInTheDocument();
    // Graduates are a list to open; the unplaced are named at once, with why.
    expect(within(dialog).queryByText("Cid Falk")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Visa namn" }));
    expect(within(dialog).getByText("Cid Falk")).toBeInTheDocument();
    expect(within(dialog).getByText("Dan Gran")).toBeInTheDocument();
    expect(within(dialog).getByText(/8B rullades inte vidare/)).toBeInTheDocument();
    expect(within(dialog).getByText(/3 utan klass eller i ett annat läsår, 1 inaktiva/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Aktivera 2027/28" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/academic-years/y27/activation", { planHash: HASH }),
    );
    expect(toast.success).toHaveBeenCalledWith("2027/28 är aktivt. 2 elever flyttade, 1 gick ut och 1 saknar klass.");
  });

  it("will not activate while the old year runs, and says until when", async () => {
    post.mockResolvedValue(
      plan({
        problems: [{ code: "YEAR_ACTIVATION_TOO_EARLY", blocking: true, params: { year: "2026/27", endDate: "2027-06-11" } }],
        blocking: true,
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(within(rowOf("2027/28")).getByRole("button", { name: "Aktivera" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/2026\/27 pågår till och med 2027-06-11/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Aktivera 2027/28" })).toBeDisabled();
  });

  it("says nobody moved when the classes changed after the preview", async () => {
    post.mockImplementation(async (path: string) => {
      if (path.endsWith("/preview")) return plan();
      throw new ApiError(409, "Elevernas klasser har ändrats …", "ACTIVATION_PREVIEW_STALE");
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(within(rowOf("2027/28")).getByRole("button", { name: "Aktivera" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(await within(dialog).findByRole("button", { name: "Aktivera 2027/28" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Elevernas klasser ändrades efter förhandsvisningen. Ingen flyttades — granska igen.",
      ),
    );
  });

  it("refuses to delete a year that holds pupils' classes, in the reader's language", async () => {
    post.mockResolvedValue(plan());
    del.mockRejectedValue(new ApiError(409, "Läsåret har klasser …", "YEAR_HAS_HOME_PUPILS", { pupils: 34 }));
    const user = userEvent.setup();
    renderPage();
    await user.click(within(rowOf("2025/26")).getByRole("button", { name: "Ta bort 2025/26" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Ta bort" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "34 aktiva elever har sina klasser i läsåret. Flytta dem, eller aktivera ett läsår som tar över dem, innan läsåret tas bort.",
      ),
    );
    expect(del).toHaveBeenCalledWith("/api/v1/academic-years/y25");
    // The active year cannot be deleted from here at all.
    expect(within(rowOf("2026/27")).queryByRole("button", { name: "Ta bort 2026/27" })).toBeNull();
  });
});
