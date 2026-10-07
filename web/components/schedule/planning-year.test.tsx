import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import type { AcademicYear, YearRosters } from "@/lib/types";
import { PlanningYearPicker, ProjectedRostersBanner } from "./planning-year";

/**
 * The banner and the choice against the real message files, in both
 * languages, with a provider that throws on a missing key or a sentence that
 * does not parse — the page tests render them through an echo translator and
 * would not see either.
 */

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
}));

const A = {
  id: "y-1",
  name: "2026/27",
  isActive: true,
  predecessorId: null,
  startDate: "2026-08-17",
  endDate: "2027-06-11",
} as AcademicYear;
const B = {
  id: "y-2",
  name: "2027/28",
  isActive: false,
  predecessorId: "y-1",
  startDate: "2027-08-16",
  endDate: "2028-06-09",
} as AcademicYear;

const projected = (overrides: Partial<YearRosters> = {}): YearRosters => ({
  academicYearId: "y-2",
  basis: "PROJECTED",
  homeClasses: [],
  counts: { moved: 1, graduates: 3, unplaced: 2 },
  membershipsOutOfDate: { missing: 0, stale: 0 },
  ...overrides,
});

function inLocale(locale: "sv" | "en", ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "sv" ? sv : en}
      onError={(error) => {
        throw error;
      }}
    >
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("the förberäknade klasslistor banner", () => {
  it("says what the lists are, in Swedish, with every count inflected", () => {
    inLocale("sv", <ProjectedRostersBanner year={B} active={A} rosters={projected()} failed={false} />);

    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("2027/28 planeras på förberäknade klasslistor");
    expect(banner).toHaveTextContent(
      "1 elev flyttar in i sin nya klass, 3 elever går ut och 2 elever blir utan klass",
    );
    expect(banner).toHaveTextContent("eleverna går kvar i klasserna i 2026/27");
    expect(banner).toHaveTextContent("Byter en elev klass i 2026/27 ändras listorna direkt");
    expect(screen.getByRole("link", { name: "Aktivera läsåret på sidan Läsår" })).toHaveAttribute(
      "href",
      "/admin/years",
    );
  });

  it("says it in English too", () => {
    inLocale(
      "en",
      <ProjectedRostersBanner
        year={B}
        active={A}
        rosters={projected({ counts: { moved: 2, graduates: 1, unplaced: 1 } })}
        failed={false}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "2 pupils move into their new class, 1 pupil graduates and 1 pupil is left without a class",
    );
  });

  it("names the teaching-group memberships the activation preview calls out of date", () => {
    inLocale(
      "sv",
      <ProjectedRostersBanner
        year={B}
        active={A}
        rosters={projected({ membershipsOutOfDate: { missing: 1, stale: 2 } })}
        failed={false}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "1 medlemskap saknas för elever som flyttar in, och 2 medlemskap hör till elever som blir utan klass",
    );
  });

  it("shows nothing for a year read on its own rows", () => {
    const { container } = inLocale(
      "sv",
      <ProjectedRostersBanner year={B} active={A} rosters={projected({ basis: "CURRENT" })} failed={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("alerts when the lists could not be fetched, rather than planning quietly on empty classes", () => {
    inLocale("sv", <ProjectedRostersBanner year={B} active={A} rosters={null} failed />);

    expect(screen.getByRole("alert")).toHaveTextContent("Klasslistorna för 2027/28 kunde inte hämtas");
  });
});

describe("the year choice", () => {
  it("offers both years under one name, with the year on screen pressed", async () => {
    const onChoose = vi.fn();
    inLocale("sv", <PlanningYearPicker year={B} active={A} successor={B} onChoose={onChoose} />);

    const group = screen.getByRole("group", { name: "Läsår att planera" });
    expect(within(group).getByRole("button", { name: "2027/28 (nästa, inte aktiverat)" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.setup().click(within(group).getByRole("button", { name: "2026/27 (aktivt)" }));
    expect(onChoose).toHaveBeenCalledWith("y-1");
  });

  it("renders nothing without a next year", () => {
    const { container } = inLocale(
      "en",
      <PlanningYearPicker year={A} active={A} successor={null} onChoose={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
