import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { uppdragLoad } from "@/lib/__fixtures__/staffing-fas3";
import type { TeacherDuty } from "@/lib/types";
import { Uppdragsbeskrivning } from "./uppdragsbeskrivning";

vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    `${namespace}.${key}${values ? `(${Object.values(values).join("|")})` : ""}`,
}));

const mentor: TeacherDuty = {
  id: "d1",
  userId: "t-anna",
  academicYearId: "y1",
  kind: "MENTORSKAP",
  label: "Mentor 7A",
  minutesPerWeek: 90,
  countsAsTeaching: false,
  subjectId: null,
  studentGroupId: "g-7a",
  validFrom: null,
  validTo: null,
  slots: [],
  note: null,
};

const renderPage = (overrides: Partial<React.ComponentProps<typeof Uppdragsbeskrivning>> = {}) =>
  render(
    <Uppdragsbeskrivning
      yearName="2026/27"
      schoolName="Norra skolan"
      teacherName="Anna Ek"
      load={uppdragLoad}
      loadModel="MINUTES"
      duties={[mentor]}
      subjectName={() => null}
      groupName={(id) => (id === "g-7a" ? "7A" : null)}
      version={{ version: 7, createdAt: "2026-10-09T12:02:00.000Z" }}
      timeZone="Europe/Stockholm"
      printedOn="2026-10-09"
      {...overrides}
    />,
  );

describe("Uppdragsbeskrivning", () => {
  it("heads the paper with the post as the load row states it, and blanks for rektor and arbetslag", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("uppdrag.title");
    const header = screen.getByText("uppdrag.employmentPercent").closest("dl")!;
    expect(header).toHaveTextContent("uppdrag.employmentPercent80 %");
    expect(header).toHaveTextContent("uppdrag.reductionPercent10 %");
    expect(header).toHaveTextContent("uppdrag.contractKindstaffing.contractFERIE");
    expect(header).toHaveTextContent("uppdrag.signatureANN");
    expect(within(header).getAllByLabelText("uppdrag.toFillIn")).toHaveLength(2);
  });

  it("prints a post that changes during the year as it is at the start, and each period with its own verdict", () => {
    const stretch = (overrides: Partial<NonNullable<typeof uppdragLoad.periods>[number]>) => ({
      from: "2026-08-17",
      to: "2027-01-10",
      kind: "BASE" as const,
      effectiveFrom: "2026-08-17",
      effectiveTo: "2027-01-10",
      employmentPercent: 100,
      reductionPercent: 0,
      ownTargetMinutesPerWeek: null,
      targetMinutesPerWeek: 600,
      teachingWeeks: 20,
      countedMinutesPerWeek: 580,
      balanceMinutesPerWeek: 20,
      percentOfTarget: 96.7,
      status: "OK" as const,
      ...overrides,
    });
    renderPage({
      load: {
        ...uppdragLoad,
        periods: [
          stretch({}),
          stretch({
            from: "2027-01-11",
            to: "2027-06-11",
            kind: "PERIOD",
            effectiveFrom: "2027-01-11",
            effectiveTo: "2027-06-11",
            employmentPercent: 50,
            reductionPercent: 10,
            targetMinutesPerWeek: 240,
            countedMinutesPerWeek: 580,
            status: "OVER",
          }),
          stretch({ from: "2027-06-12", to: "2027-06-13", kind: "PERIOD", effectiveFrom: null, effectiveTo: null, teachingWeeks: 0 }),
        ],
      },
    });
    // The header: the post on the läsår's first day, and said so — not the base row's 80 / 10.
    const header = screen.getByText("uppdrag.employmentPercentAtStart").closest("dl")!;
    expect(header).toHaveTextContent("uppdrag.employmentPercentAtStart100 %");
    expect(header).toHaveTextContent("uppdrag.reductionPercentAtStart0 %");
    const table = screen.getByRole("table", { name: "uppdrag.postPeriodsCaption" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent("50 %10 %240580staffing.statusOVER");
    // A stretch with no taught week: no counted minutes, no verdict.
    expect(rows[2]).toHaveTextContent("staffing.periodNoWeek");
    expect(rows[2]).not.toHaveTextContent("statusOK");
  });

  it("lists the teaching per subject, group and period, with the gateway's total and toppvecka", () => {
    renderPage();
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row").map((row) => row.textContent);
    expect(rows[1]).toBe("Matematik7Auppdrag.periodYear240152");
    expect(rows[2]).toMatch(/^Slöjd \(uppdrag\.coTeacher\)7B17 aug\. – 18 dec\. \(uppdrag\.periodOdd\)4213,3$/);
    expect(rows[3]).toBe("uppdrag.total660165,3");
    expect(screen.getByText("uppdrag.peak(720)")).toBeInTheDocument();
  });

  it("ticks the template's boxes from the uppdrag and lists them", () => {
    renderPage();
    expect(screen.getByRole("checkbox", { name: "uppdrag.box.MENTOR" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "uppdrag.box.VFU" })).not.toBeChecked();
    expect(screen.getByText("Mentor 7A")).toBeInTheDocument();
  });

  it("states an uppdrag's dates and times, and nothing for an undated uppdrag without times", () => {
    const rastvakt: TeacherDuty = {
      ...mentor,
      id: "d2",
      kind: "RASTVAKT",
      label: "Rastvakt",
      studentGroupId: null,
      validFrom: "2027-01-07",
      validTo: "2027-06-11",
      slots: [
        { dayOfWeek: 3, startTime: "10:00:00", endTime: "10:20:00" },
        { dayOfWeek: 1, startTime: "10:00:00", endTime: "10:20:00" },
      ],
    };
    renderPage({ duties: [mentor, rastvakt] });
    const row = screen.getByText("Rastvakt").closest("li")!;
    expect(row).toHaveTextContent("staffing.dutyRunsFromTo(2027-01-07|2027-06-11)");
    expect(row).toHaveTextContent(
      "staffing.dutyBlocksList(staffing.dutySlotTime(days.1|10:00|10:20), staffing.dutySlotTime(days.3|10:00|10:20))",
    );
    const mentorRow = screen.getByText("Mentor 7A").closest("li")!;
    expect(mentorRow).not.toHaveTextContent("dutyRuns");
    expect(mentorRow).not.toHaveTextContent("dutyBlocksList");
  });

  it("cites the tjänst's newest version in the school's time, or says there is none", () => {
    const { unmount } = renderPage();
    expect(screen.getByText("uppdrag.stamp(2026-10-09|7|2026-10-09 14:02)")).toBeInTheDocument();
    unmount();
    renderPage({ version: null });
    expect(screen.getByText("uppdrag.stampNoVersion(2026-10-09)")).toBeInTheDocument();
  });

  it("never says there is no version while the history is read or after it failed, and waits to print", () => {
    const { unmount } = renderPage({ version: "loading" });
    expect(screen.getByText("uppdrag.stampLoading(2026-10-09)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "uppdrag.print" })).toBeDisabled();
    unmount();
    renderPage({ version: "unreadable" });
    expect(screen.getByText("uppdrag.stampUnreadable(2026-10-09)")).toBeInTheDocument();
    expect(screen.queryByText(/stampNoVersion/)).toBeNull();
    expect(screen.getByRole("button", { name: "uppdrag.print" })).toBeEnabled();
  });

  it("prints on Skriv ut, and the button itself is not on the paper", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    const user = userEvent.setup();
    renderPage();
    const button = screen.getByRole("button", { name: "uppdrag.print" });
    expect(button).toHaveClass("print:hidden");
    await user.click(button);
    expect(print).toHaveBeenCalledTimes(1);
  });

  it("calls every charged figure räknad tid under the Faktor model, with the undervisningstid beside it", () => {
    // Ma at factor 1,5: 240 minutes taught are 360 charged.
    const factorLoad = {
      ...uppdragLoad,
      assignedMinutesPerWeek: 360,
      assignments: [{ ...uppdragLoad.assignments![0]!, timeMinutesPerWeek: 240, minutesPerWeek: 360, hoursPerYear: 228 }],
    };
    renderPage({ loadModel: "FACTOR", load: factorLoad });
    const headers = screen.getAllByRole("columnheader").map((header) => header.textContent);
    expect(headers).toEqual([
      "uppdrag.subject",
      "uppdrag.group",
      "uppdrag.period",
      "uppdrag.minutesTime",
      "uppdrag.minutesFactor",
      "uppdrag.hoursPerYearFactor",
    ]);
    const rows = within(screen.getByRole("table")).getAllByRole("row").map((row) => row.textContent);
    expect(rows[1]).toBe("Matematik7Auppdrag.periodYear240360228");
    expect(rows[2]).toMatch(/^uppdrag\.total240360/);
    expect(screen.getByText(`uppdrag.peakFactor(${uppdragLoad.peakMinutesPerWeek})`)).toBeInTheDocument();
    expect(screen.getByText("uppdrag.factorNote")).toBeInTheDocument();
    expect(screen.queryByText("uppdrag.hoursPerYear")).toBeNull();
  });
});

describe("the paper's theme", () => {
  it("prints the light scheme for native controls too, over next-themes' inline color-scheme", () => {
    const css = readFileSync(resolve(__dirname, "../../app/globals.css"), "utf8");
    const print = css.slice(css.indexOf("@media print"));
    // An inline `color-scheme: dark` on <html> beats a normal rule: only
    // !important puts the checkboxes back in the light scheme on paper.
    expect(print).toMatch(/:root\s*\{\s*color-scheme:\s*light\s*!important;/);
  });
});
