import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import RequirementsPage from "./page";

/**
 * The matrix has to stay legible while an admin scrolls a hundred groups.
 *
 * jsdom computes no layout, so this cannot prove the header visually sticks —
 * that was checked in a browser against the same structure. What it does pin
 * is the arrangement that makes sticking possible at all: the container is
 * the scrolling element, and the header cells are positioned against it.
 * Reverting either silently returns the bug, and nothing else would notice.
 */

const groups = [
  { id: "g-7a", academicYearId: "y1", name: "7A", kind: "CLASS", gradeLevel: 7 },
  { id: "g-ma71", academicYearId: "y1", name: "Ma71", kind: "TEACHING_GROUP", gradeLevel: null },
];

/**
 * As the hook delivers them: sorted by NAME, in Swedish.
 *
 * SO and Slöjd are the pair that exposed the bug, and they are a school's real
 * subjects, not a contrivance: by name Samhällsorientering sorts before Slöjd,
 * so the hook hands over SO then SL — while the header shows codes, and an eye
 * reading codes sees SL before SO. Övrigt is kept for the Swedish collation.
 */
const subjects = [
  { id: "s-bi", name: "Bild", code: "BI", color: "#4f46e5", requiredRoomTypeId: null },
  { id: "s-so", name: "SO", code: "SO", color: "#0ea5e9", requiredRoomTypeId: null },
  { id: "s-sl", name: "Slöjd", code: "SL", color: "#db2777", requiredRoomTypeId: null },
  { id: "s-ov", name: "Övrigt", code: "ÖV", color: "#059669", requiredRoomTypeId: null },
];

vi.mock("@/lib/queries", () => ({
  useAcademicYears: () => ({ data: [{ id: "y1", name: "2026/2027", isActive: true }] }),
  useSubjects: () => ({ data: subjects, isLoading: false }),
  useGroups: () => ({ data: groups }),
  usePeople: () => ({ data: [] }),
  useGroupMemberships: () => ({ data: [] }),
  useRequirements: () => ({ data: [] }),
  useCrudMutations: () => ({
    create: { mutateAsync: vi.fn(), isPending: false },
    update: { mutateAsync: vi.fn(), isPending: false },
    remove: { mutateAsync: vi.fn(), isPending: false },
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

const matrix = () => screen.getByRole("table");

describe("Timplan matrix", () => {
  it("orders the columns by the label they actually show", () => {
    // The header shows the CODE while the hook sorts by NAME, and sorting one
    // string while displaying another reads as no order at all — the school's
    // own list came out "EN IDH MA MU NO SO SL SV". Each view is alphabetical
    // in what it shows: names in the dropdowns, codes here.
    render(<RequirementsPage />);

    const codes = within(matrix())
      .getAllByRole("columnheader")
      .slice(1)
      .map((cell) => cell.textContent?.trim());
    expect(codes).toEqual(["BI", "SL", "SO", "ÖV"]);
  });

  it("keeps every row's cells under the column they belong to", () => {
    // Counting cells is not enough: a header ordered one way and cells another
    // gives the same count and files every lesson under the wrong subject —
    // silently, in the one view a school uses to decide what it teaches. Each
    // cell names its own subject, so the two can be compared position by
    // position.
    render(<RequirementsPage />);

    const order = ["Bild", "Slöjd", "SO", "Övrigt"];
    for (const row of within(matrix()).getAllByRole("row").slice(1)) {
      const buttons = within(row).queryAllByRole("button");
      if (buttons.length === 0) continue; // section heading row
      // The mocked translator joins values in object order: group, then subject.
      expect(
        buttons.map((b) => b.getAttribute("aria-label")?.split("|")[1]?.replace(")", "")),
      ).toEqual(order);
    }
  });

  it("renders a column per subject and a row per group", () => {
    render(<RequirementsPage />);

    const headers = within(matrix()).getAllByRole("columnheader");
    expect(headers.map((cell) => cell.textContent?.trim())).toEqual([
      "group",
      "BI",
      "SL",
      "SO",
      "ÖV",
    ]);
  });

  it("scrolls inside its own container, which is what sticky resolves against", () => {
    render(<RequirementsPage />);

    // `overflow-x: auto` alone makes the element a scroll container whose
    // vertical extent never scrolls, so a sticky header would never engage.
    const container = matrix().parentElement;
    expect(container?.className).toContain("overflow-auto");
    expect(container?.className).toMatch(/max-h-/);
  });

  it("pins the subject header row to the top of that container", () => {
    render(<RequirementsPage />);

    for (const header of within(matrix()).getAllByRole("columnheader")) {
      expect(header.className).toContain("sticky");
      expect(header.className).toContain("top-0");
    }
  });

  it("keeps the group column pinned to the left as well", () => {
    render(<RequirementsPage />);

    const [corner] = within(matrix()).getAllByRole("columnheader");
    expect(corner?.className).toContain("left-0");

    // The name renders in a span inside the cell; the cell is what sticks.
    const groupCell = screen.getByText("7A").closest("td");
    expect(groupCell).not.toBeNull();
    expect(groupCell!.className).toContain("sticky");
    expect(groupCell!.className).toContain("left-0");
  });

  it("layers the corner above both header row and group column", () => {
    // Where the two sticky axes meet, one has to win or the corner is painted
    // over by whichever cell scrolls under it.
    render(<RequirementsPage />);

    const [corner, subject] = within(matrix()).getAllByRole("columnheader");
    const zOf = (element: Element | undefined) =>
      Number(/z-(\d+)/.exec(element?.className ?? "")?.[1] ?? 0);

    expect(zOf(corner)).toBeGreaterThan(zOf(subject));
    expect(zOf(subject)).toBeGreaterThan(
      zOf(screen.getByText("7A").closest("td") ?? undefined),
    );
  });
});
