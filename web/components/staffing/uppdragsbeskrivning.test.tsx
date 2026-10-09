import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  blockedConstraintId: null,
  blockedSlot: null,
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
