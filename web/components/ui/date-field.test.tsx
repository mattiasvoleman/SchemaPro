import * as React from "react";
import { describe, expect, it, vi, type Mock } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DateField } from "./date-field";
import { Dialog, DialogContent, DialogTitle } from "./dialog";

/*
 * The week column is the reason this component exists, so most of what is
 * asserted here is about that column being right — and about the keyboard being
 * able to reach it, because a calendar only a mouse can drive is half a
 * control.
 *
 * NOTHING HERE DERIVES ITS ANSWER FROM `isoWeek`. An earlier version of this
 * file built its expected column with `isoWeek(addDays(startOfIsoWeek(...)))`,
 * the same three functions the component renders with, and called it
 * "independently derived". It was not: a deliberately broken `isoWeek` left
 * that test green. The oracle below is the ISO-8601 rule written out — the week
 * holding the year's first Thursday is week 1 — so the two can disagree.
 */

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
  useLocale: () => "sv",
}));

/** ISO-8601 from first principles, sharing no code with the component. */
function isoWeekOracle(year: number, month: number, day: number): number {
  const date = Date.UTC(year, month, day);
  const weekday = (new Date(date).getUTCDay() + 6) % 7; // Monday = 0
  const thursday = date + (3 - weekday) * 86400000;
  const isoYear = new Date(thursday).getUTCFullYear();
  const jan4 = Date.UTC(isoYear, 0, 4);
  const jan4Weekday = (new Date(jan4).getUTCDay() + 6) % 7;
  const week1Monday = jan4 - jan4Weekday * 86400000;
  return Math.round((thursday - 3 * 86400000 - week1Monday) / (7 * 86400000)) + 1;
}

const renderField = (props: Partial<Parameters<typeof DateField>[0]> = {}) => {
  // Typed as a mock of the real signature, so a test can read `.mock.calls`
  // without casting at every use and TypeScript still checks the arguments.
  const onChange = (props.onChange ?? vi.fn()) as Mock<(value: string) => void>;
  render(<DateField id="d" value={props.value ?? "2027-02-24"} {...props} onChange={onChange} />);
  return { onChange };
};

const openCalendar = async () => {
  const user = userEvent.setup();
  await user.click(screen.getAllByRole("button", { name: /openCalendar/ })[0]!);
  return user;
};

const grid = () => screen.getByRole("grid");
const weekColumn = (): string[] =>
  within(grid())
    .getAllByRole("rowheader")
    .map((cell) => cell.textContent ?? "");
const dayButtons = () => within(grid()).getAllByRole("button");

describe("DateField", () => {
  describe("the week column", () => {
    it("prints the ISO week of every row, checked against the standard's own rule", async () => {
      renderField({ value: "2027-02-24" });
      await openCalendar();

      // February 2027 opens on a Monday and closes on a Sunday: four rows.
      expect(weekColumn()).toEqual(
        [1, 8, 15, 22].map((d) => String(isoWeekOracle(2027, 1, d))),
      );
    });

    it("carries the numbering across a year that has a week 53", async () => {
      // The seam, and the one place a hand-rolled week number goes wrong.
      renderField({ value: "2026-12-15" });
      await openCalendar();

      expect(weekColumn()).toEqual(["49", "50", "51", "52", "53"]);
      expect(isoWeekOracle(2026, 11, 28)).toBe(53);
    });

    it("starts every row on a Monday", async () => {
      /*
       * The row header names ONE week, so a row that straddles two is a lie
       * whatever number it carries. Dropping `startOfIsoWeek` from the grid's
       * first cell used to survive the entire suite — 1049 tests — while the
       * calendar started on a Tuesday.
       */
      renderField({ value: "2027-02-24" });
      await openCalendar();

      const headers = within(grid())
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent);
      // First column is the week, then the days in order from Monday.
      expect(headers[0]).toBe("weekAbbreviation");
      expect(headers.slice(1)).toEqual(["mån", "tis", "ons", "tors", "fre", "lör", "sön"]);

      // And the first day drawn in the first row is a Monday.
      const first = within(grid()).getAllByRole("row")[1]!;
      const firstDay = within(first).getAllByRole("button")[0]!;
      expect(firstDay).toHaveAttribute("aria-label", expect.stringContaining("1 februari"));
    });

    it("ties each week number to the days on its own row", async () => {
      renderField({ value: "2027-02-24" });
      await openCalendar();

      for (const row of within(grid()).getAllByRole("row").slice(1)) {
        const week = within(row).getByRole("rowheader").textContent;
        const days = within(row).getAllByRole("button");
        const first = Number(days[0]!.textContent);
        expect(week).toBe(String(isoWeekOracle(2027, 1, first)));
      }
    });

    it("draws no row that holds none of this month's days", async () => {
      /*
       * Six rows are generated so the popover keeps its height, and the tail is
       * dropped. Without that, 114 of 144 months over a decade ended in a lone
       * week number beside seven empty cells — a week that appears to exist and
       * to contain nothing.
       */
      renderField({ value: "2027-02-24" });
      await openCalendar();

      for (const row of within(grid()).getAllByRole("row").slice(1)) {
        expect(within(row).getAllByRole("button").length).toBeGreaterThan(0);
      }
    });

    it("reads the week aloud as a week, not as a loose number", async () => {
      renderField();
      await openCalendar();

      const [first] = within(grid()).getAllByRole("rowheader");
      expect(first!.tagName).toBe("TH");
      expect(first!.getAttribute("scope")).toBe("row");
      expect(first!.getAttribute("aria-label")).toBe("weekNumber(5)");
    });
  });

  describe("what leaves the field", () => {
    it("stays typable, and lets nothing half-typed out", async () => {
      // `<input type="date">` emits a complete date or nothing, and one call
      // site puts the value straight into a query key, where "2027-0" would
      // fetch a day that does not exist, once per keystroke.
      const { onChange } = renderField({ value: "", onChange: vi.fn() });
      const user = userEvent.setup();

      await user.type(screen.getByRole("textbox"), "2027-02-24");

      expect(onChange.mock.calls).toEqual([["2027-02-24"]]);
      expect(screen.getByRole("textbox")).toHaveValue("2027-02-24");
    });

    it("puts back what the form holds when a half-edit is abandoned", async () => {
      /*
       * Deleting a digit to fix it passes through "2026-08-1", which is not a
       * date, so the form still holds "2026-08-17". If the box kept showing the
       * fragment, it would say one thing while save sent another — and the save
       * button stayed enabled the whole time. A controlled native date input
       * snapped back here, which is why no call site guards against it.
       */
      renderField({ value: "2026-08-17" });
      const user = userEvent.setup();
      const box = screen.getByRole("textbox");

      await user.type(box, "{Backspace}");
      expect(box).toHaveValue("2026-08-1");
      expect(box).toHaveAttribute("aria-invalid", "true");

      await user.tab();
      expect(box).toHaveValue("2026-08-17");
    });

    it("reports a cleared field, which is how a date gets removed", async () => {
      const { onChange } = renderField({ value: "2027-02-24", onChange: vi.fn() });
      const user = userEvent.setup();

      await user.clear(screen.getByRole("textbox"));

      expect(onChange).toHaveBeenCalledWith("");
    });

    it("puts the date back when a call site refuses the clearing", async () => {
      /*
       * Six call sites guard with `value && setX(value)`, so an empty string is
       * refused and the parent keeps its date. The box was left showing empty
       * while the query behind it went on running on the old day — a native
       * date input snapped back here, which is why none of them guard against
       * it. Modelled with a parent that simply ignores "".
       */
      const Refusing = () => {
        const [value, setValue] = React.useState("2027-02-24");
        return (
          <DateField id="d" value={value} onChange={(next) => next && setValue(next)} />
        );
      };
      render(<Refusing />);
      const user = userEvent.setup();
      const box = screen.getByRole("textbox");

      await user.clear(box);
      expect(box).toHaveValue("");

      await user.tab();
      expect(box).toHaveValue("2027-02-24");
    });

    it("refuses a date that passes the pattern but is on no calendar", async () => {
      // 2027-02-30 matches yyyy-mm-dd and rolls over to 2 March in every parser
      // downstream — the hole is-calendar-date.ts closes on the API side.
      const { onChange } = renderField({ value: "", onChange: vi.fn() });
      const user = userEvent.setup();

      await user.type(screen.getByRole("textbox"), "2027-02-30");

      expect(onChange).not.toHaveBeenCalled();
    });

    it("hands back a picked day, closes, and returns focus", async () => {
      const { onChange } = renderField({ value: "2027-02-24", onChange: vi.fn() });
      const user = await openCalendar();

      await user.click(screen.getByRole("button", { name: /26 februari/ }));

      expect(onChange).toHaveBeenCalledWith("2027-02-26");
      expect(screen.queryByRole("grid")).toBeNull();
      expect(screen.getByRole("button", { name: /openCalendar/ })).toHaveFocus();
    });
  });

  describe("the keyboard", () => {
    it.each([
      ["{ArrowDown}", "3 mars"],
      ["{ArrowUp}", "17 februari"],
      ["{ArrowRight}", "25 februari"],
      ["{ArrowLeft}", "23 februari"],
      ["{PageDown}", "24 mars"],
      ["{PageUp}", "24 januari"],
      ["{Home}", "22 februari"],
      ["{End}", "28 februari"],
    ])("moves the focused day with %s", async (key, expected) => {
      const { onChange } = renderField({ value: "2027-02-24", onChange: vi.fn() });
      const user = await openCalendar();

      await user.keyboard(key);

      // Focus followed, and the grid is showing the day it moved to.
      expect(document.activeElement?.getAttribute("aria-label")).toContain(expected);
      // Moving is not choosing: a browser's own calendar commits once, when the
      // day is taken, and three call sites turn every commit into a fetch.
      expect(onChange).not.toHaveBeenCalled();
    });

    it("chooses the focused day with Enter", async () => {
      const { onChange } = renderField({ value: "2027-02-24", onChange: vi.fn() });
      const user = await openCalendar();

      await user.keyboard("{ArrowRight}{Enter}");

      expect(onChange).toHaveBeenCalledWith("2027-02-25");
    });

    it("keeps the keyboard in the grid when the month changes", async () => {
      // PageDown used to leave the tab stop on a day that had stopped existing,
      // and focus fell to <body>: the calendar stayed open with the keyboard
      // locked out of it.
      renderField({ value: "2027-02-24" });
      const user = await openCalendar();

      await user.keyboard("{PageDown}");

      expect(document.body).not.toHaveFocus();
      expect(within(grid()).getAllByRole("button")).toContain(document.activeElement);
    });

    it("moves focus when the month chevrons are clicked too", async () => {
      renderField({ value: "2027-02-24" });
      const user = await openCalendar();

      await user.click(screen.getByRole("button", { name: "nextMonth" }));

      expect(document.activeElement?.getAttribute("aria-label")).toContain("24 mars");
    });

    it("can be entered on an empty field", async () => {
      // With nothing selected there is no obvious day to put the tab stop on,
      // and without one the calendar opens with no way in at all.
      renderField({ value: "" });
      await openCalendar();

      expect(dayButtons()).toContain(document.activeElement);
    });

    it("starts on a day it is allowed to pick when the value is out of range", async () => {
      /*
       * A lov dated before the läsår begins. The only tab stop used to be the
       * held day, which is disabled — so the calendar could not be entered, and
       * the arrows had nothing to step from.
       */
      renderField({ value: "2026-01-01", min: "2026-08-17", max: "2027-06-11" });
      await openCalendar();

      const focused = document.activeElement as HTMLElement;
      expect(focused).not.toBeDisabled();
      expect(focused.getAttribute("aria-label")).toContain("17 augusti");
    });
  });

  describe("the bounds", () => {
    it("offers the first and last day the range allows", async () => {
      // Only the days OUTSIDE were checked before, so either bound could move a
      // day inward — making the läsår's own first day impossible to pick —
      // without a test falling.
      renderField({ value: "2027-02-24", min: "2027-02-22", max: "2027-02-26" });
      await openCalendar();

      expect(screen.getByRole("button", { name: /22 februari/ })).toBeEnabled();
      expect(screen.getByRole("button", { name: /26 februari/ })).toBeEnabled();
    });

    it("refuses the days just outside it", async () => {
      const { onChange } = renderField({
        value: "2027-02-24",
        min: "2027-02-22",
        max: "2027-02-26",
        onChange: vi.fn(),
      });
      const user = await openCalendar();

      const outside = screen.getByRole("button", { name: /27 februari/ });
      expect(outside).toBeDisabled();
      expect(screen.getByRole("button", { name: /21 februari/ })).toBeDisabled();
      await user.click(outside);
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe("what a screen reader is told", () => {
    it("marks the chosen day on the cell, where the attribute is allowed", async () => {
      // `aria-selected` on role=button is aria-allowed-attr, impact critical,
      // and simply ignored — so which day was chosen reached nobody.
      renderField({ value: "2027-02-24" });
      await openCalendar();

      const cells = within(grid()).getAllByRole("gridcell");
      const chosen = cells.filter((c) => c.getAttribute("aria-selected") === "true");
      expect(chosen).toHaveLength(1);
      expect(within(chosen[0]!).getByRole("button").textContent).toBe("24");
      for (const day of dayButtons()) {
        expect(day.hasAttribute("aria-selected")).toBe(false);
      }
    });

    it("names each day with its month and year, not with a loose number", async () => {
      renderField({ value: "2027-02-24" });
      await openCalendar();

      expect(dayButtons()[0]!.getAttribute("aria-label")).toBe("1 februari 2027");
    });

    it("tells two calendars in one dialog apart", async () => {
      render(
        <>
          <DateField id="a" label="Från och med" value="" onChange={vi.fn()} />
          <DateField id="b" label="Till och med" value="" onChange={vi.fn()} />
        </>,
      );

      expect(screen.getByRole("button", { name: "openCalendarFor(Från och med)" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "openCalendarFor(Till och med)" })).toBeTruthy();
    });

    it("marks the selection with a ring, not with a filled chip", async () => {
      // `primary-foreground` on `primary` measures 6.18 / 5.12 — under AAA on
      // the one cell that matters most.
      renderField({ value: "2027-02-24" });
      await openCalendar();

      const selected = screen.getByRole("button", { name: /24 februari/ });
      expect(selected.className).toContain("ring-primary");
      expect(selected.className).not.toContain("bg-primary");
      expect(selected.className).toContain("text-foreground");
    });

    it("leaves the neighbouring months' days blank rather than dimmed", async () => {
      // Greying them cannot be done at AAA: `muted-foreground` on `card` is
      // 4.83 / 6.17 on 14px numerals. February 2027 has 28 days and no more.
      renderField({ value: "2027-02-24" });
      await openCalendar();

      expect(dayButtons()).toHaveLength(28);
      expect(grid().innerHTML).not.toContain("text-muted-foreground");
    });
  });

  describe("the props the call sites pass", () => {
    it("takes the whole field out of reach when disabled", async () => {
      // Both halves, or the field is disabled in appearance only: the box
      // refuses typing while the button beside it still opens a calendar that
      // happily writes to it.
      const { onChange } = renderField({ value: "2027-02-24", disabled: true, onChange: vi.fn() });
      const user = userEvent.setup();

      const box = screen.getByRole("textbox");
      const trigger = screen.getByRole("button", { name: /openCalendar/ });
      expect(box).toBeDisabled();
      expect(trigger).toBeDisabled();

      await user.click(trigger);
      expect(screen.queryByRole("grid")).toBeNull();

      await user.type(box, "2027-03-01");
      expect(onChange).not.toHaveBeenCalled();
    });

    it("is not reachable by keyboard either when disabled", async () => {
      // A disabled control is out of the tab order; asserting the attribute
      // alone would pass on a `readonly` box that Tab still lands in.
      render(
        <>
          <button type="button">före</button>
          <DateField id="d" value="2027-02-24" disabled onChange={vi.fn()} />
          <button type="button">efter</button>
        </>,
      );
      const user = userEvent.setup();

      screen.getByRole("button", { name: "före" }).focus();
      await user.tab();

      expect(screen.getByRole("button", { name: "efter" })).toHaveFocus();
    });

    it("names the box with the aria-label it was given", async () => {
      // admin/lessons is the one field with no visible <Label> — it sits
      // between two chevrons as a day navigator — so this prop is the only
      // thing that names it at all.
      renderField({ value: "2027-02-24", "aria-label": "Datum" });

      expect(screen.getByRole("textbox", { name: "Datum" })).toBeTruthy();
    });

    it("passes aria-describedby through to the box", () => {
      // The hint or error a form puts beside a field is attached by id, and a
      // wrapper that swallowed the attribute would silence it without a trace.
      render(
        <>
          <DateField
            id="d"
            value=""
            onChange={vi.fn()}
            aria-label="Från"
            aria-describedby="hint"
          />
          <p id="hint">Lämna tomt för hela läsåret</p>
        </>,
      );

      expect(screen.getByRole("textbox", { name: "Från" })).toHaveAttribute(
        "aria-describedby",
        "hint",
      );
    });

    it("keeps its own aria-invalid rather than letting a caller's spread win", async () => {
      // `{...aria}` is spread last, so a prop added to the type later could
      // silently overwrite the state the component computes. The type allows
      // only label and describedby today; this pins the reason it should.
      renderField({ value: "", "aria-label": "Från" });
      const user = userEvent.setup();

      await user.type(screen.getByRole("textbox"), "2027-02-3");

      expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
    });
  });

  describe("dismissal", () => {
    it("closes on Escape and gives focus back to the button that opened it", async () => {
      renderField();
      const user = await openCalendar();

      await user.keyboard("{Escape}");

      expect(screen.queryByRole("grid")).toBeNull();
      expect(screen.getByRole("button", { name: /openCalendar/ })).toHaveFocus();
    });

    it("leaves focus where a click put it", async () => {
      /*
       * Clicking straight into the next field closes the calendar and leaves
       * the cursor in the box that was clicked — the app does not take it back.
       *
       * The dismiss handler DOES restore focus to the trigger, and the reason
       * this still holds is ordering: pointer-down dismisses, then the click
       * lands. A variant that skipped the restore for focus-outside was written
       * and removed — neither this test nor a tab trail could tell the two
       * apart, and a line whose justification nothing can check is the thing
       * this file has been correcting all along.
       */
      render(
        <>
          <DateField id="d" label="Från" value="2027-02-24" onChange={vi.fn()} />
          <input aria-label="annat fält" />
        </>,
      );
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /openCalendarFor/ }));

      await user.click(screen.getByRole("textbox", { name: "annat fält" }));

      expect(screen.queryByRole("grid")).toBeNull();
      expect(screen.getByRole("textbox", { name: "annat fält" })).toHaveFocus();
    });

    it("closes when a press lands outside it", async () => {
      renderField();
      const user = await openCalendar();

      await user.click(document.body);

      expect(screen.queryByRole("grid")).toBeNull();
    });

    it("gives Escape to the calendar first, and to the dialog around it second", async () => {
      /*
       * Most of the eighteen fields sit inside a Radix <Dialog>, which closes on
       * Escape. The first attempt listened on `document` in the capture phase
       * and stopped the event there, on the theory that it would beat Radix to
       * it. It does not — Radix is document-capture too and the dialog mounts
       * first — so one press closed the calendar AND threw away the half-filled
       * form, which reads as the app losing your work. DismissableLayer gives
       * the key to whichever layer is on top.
       */
      const onOpenChange = vi.fn();
      render(
        <Dialog open onOpenChange={onOpenChange}>
          <DialogContent>
            <DialogTitle>Lov</DialogTitle>
            <DateField id="d" value="2027-02-24" onChange={vi.fn()} />
          </DialogContent>
        </Dialog>,
      );
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /openCalendar/ }));

      await user.keyboard("{Escape}");
      expect(screen.queryByRole("grid")).toBeNull();
      expect(onOpenChange).not.toHaveBeenCalled();

      await user.keyboard("{Escape}");
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
