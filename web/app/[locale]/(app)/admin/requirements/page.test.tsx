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

/** Ordered as the hook delivers them — Swedish, so Övrigt comes last. */
const subjects = [
  { id: "s-bi", name: "Bild", code: "BI", color: "#4f46e5", requiredRoomTypeId: null },
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
  it("keeps the columns in the order the subject hook delivers", () => {
    // The hook sorts in Swedish; the matrix must not reorder behind it, or the
    // two views a school ticks boxes across would disagree.
    render(<RequirementsPage />);

    const codes = within(matrix())
      .getAllByRole("columnheader")
      .slice(1)
      .map((cell) => cell.textContent?.trim());
    expect(codes).toEqual(["BI", "SL", "ÖV"]);
  });

  it("renders a column per subject and a row per group", () => {
    render(<RequirementsPage />);

    const headers = within(matrix()).getAllByRole("columnheader");
    expect(headers.map((cell) => cell.textContent?.trim())).toEqual([
      "group",
      "BI",
      "SL",
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
