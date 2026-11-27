import { describe, expect, it } from "vitest";
import { columnStats, datesAsked, proposalFor } from "@/lib/pseudonym-headers";
import { parseText } from "@/lib/pseudonym-input";
import { planFile } from "@/lib/pseudonym-run";

/*
 * A COLUMN OF DATES THE TOOL CANNOT READ IS ASKED ABOUT, NOT KEPT (the review of #496).
 *
 * X1b asks about a column of dates that spans more than a year, reaches back more than three years, or is written as six or eight digits. A date with the year in two digits (14.02.13, 13-02-14, 14/02/13,
 * 2/14/13) is a date in shape (the column is "plain") but the tool does not read its day: no span, no age, and so no question. The column was kept whole, birth dates and all.
 */

const TODAY = Date.UTC(2026, 10, 26);
const column = (cells: string[]) => {
  const input = parseText(`Klass;F-datum\r\n${cells.map((cell) => `7A;${cell}`).join("\r\n")}\r\n`, "file", "UTF-8", false)!;
  return planFile(input, undefined, TODAY).columns[1]!;
};

describe("dates written with the year in two digits, or the month after a day over twelve", () => {
  it.each([
    ["D.M.YY", ["14.02.13", "03.05.13", "30.09.13"]],
    ["D/M/YY", ["14/02/13", "03/05/13", "30/09/13"]],
    ["YY-MM-DD", ["13-02-14", "13-05-03", "13-09-30"]],
    ["M/D/YY", ["2/14/13", "5/23/13", "9/30/13"]],
    ["M/D/YYYY with every day over twelve", ["2/14/2013", "5/23/2013", "9/30/2013"]],
  ])("%s: the column is asked about, and the reason is said", (_name, cells) => {
    const planned = column(cells);
    expect(planned.proposal).toBeNull();
    expect(planned.datesAsked).toBe("unread");
  });

  it("counts the cells the tool cannot read", () => {
    expect(columnStats(["14.02.13", "2013-02-14", "x"]).unreadDates).toBe(1);
    expect(columnStats(["2013-02-14", "3.5.2013"]).unreadDates).toBe(0);
  });

  it("leaves a column of lesson dates the tool reads, and a column of times with seconds that is asked, as they were", () => {
    expect(column(["2026-09-01", "2026-09-02", "2026-11-20"]).proposal?.reason).toBe("values");
    expect(datesAsked(columnStats(["2026-09-01", "2026-09-02"]), TODAY)).toBeNull();
    expect(proposalFor("F-datum", columnStats(["2026-09-01", "2026-09-02"]), TODAY)?.reason).toBe("values");
  });
});
