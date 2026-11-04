import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DateField, placeCalendar } from "./date-field";
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

  describe("the edge it is found by", () => {
    it("draws the box and the calendar button in the 3:1 field token", () => {
      // SC 1.4.11. The two sit side by side as one control, so they share the
      // edge; the hairline border-input measures 1.27:1 on white.
      renderField();
      for (const part of [
        screen.getByRole("textbox"),
        screen.getByRole("button", { name: /openCalendar/ }),
      ]) {
        expect(part).toHaveClass("border-input-strong");
        expect(part).not.toHaveClass("border-input");
      }
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

  /*
   * Where the calendar opens. Reported on "Lägg till lov": Sista dagen sits in
   * the dialog's right column, the calendar hung under it wider than the room
   * left, and the dialog's overflow-x-hidden cut off its right third with Nästa
   * månad in it. e2e/date-field.smoke.spec.ts proves the fix in a browser,
   * which is the only place a box can be seen to be clipped; this block pins
   * the rule and the wiring, which jsdom can check.
   */
  describe("where it opens", () => {
    const calendar = { width: 302, height: 294 };
    const view = { width: 1280, height: 800 };

    describe("placeCalendar", () => {
      it("opens under its field with the left edges lined up when there is room", () => {
        expect(placeCalendar({ top: 320, bottom: 356, left: 648 }, calendar, view)).toEqual({ top: 360, left: 648 });
      });

      it("slides left off the window's right edge instead of running past it", () => {
        // A field in the right column of a phone-width form.
        expect(placeCalendar({ top: 320, bottom: 356, left: 200 }, calendar, { width: 375, height: 812 })).toEqual({
          top: 360,
          left: 375 - 8 - 302,
        });
      });

      it("keeps the left edge in the window when the window is narrower than the calendar", () => {
        expect(placeCalendar({ top: 320, bottom: 356, left: 0 }, calendar, { width: 300, height: 812 }).left).toBe(8);
      });

      it("fits exactly under the field, eight pixels from the window's bottom", () => {
        // 356 + 4 + 294 = 654 = 662 − 8: the last height that still opens under.
        expect(placeCalendar({ top: 320, bottom: 356, left: 25 }, calendar, { width: 375, height: 662 }).top).toBe(360);
      });

      it("opens over the field when there is no room under it but there is over it", () => {
        expect(placeCalendar({ top: 351, bottom: 387, left: 25 }, calendar, { width: 375, height: 600 })).toEqual({
          top: 351 - 4 - 294,
          left: 25,
        });
      });

      it("covers the field, as low as the window allows, when neither side has room", () => {
        expect(placeCalendar({ top: 200, bottom: 236, left: 25 }, calendar, { width: 375, height: 480 }).top).toBe(
          480 - 8 - 294,
        );
      });

      it("keeps its top in a window shorter than itself, and leaves the rest to scroll", () => {
        expect(placeCalendar({ top: 100, bottom: 136, left: 25 }, calendar, { width: 375, height: 250 }).top).toBe(8);
      });

      it("opens over the field right up to eight pixels from the top, and not one pixel closer", () => {
        // 306 − 4 − 294 = 8 fits over the field; at 305 it would be 7, so the
        // calendar goes as low as the window allows instead (600 − 8 − 294).
        const phone = { width: 375, height: 600 };
        expect(placeCalendar({ top: 306, bottom: 342, left: 25 }, calendar, phone).top).toBe(8);
        expect(placeCalendar({ top: 305, bottom: 341, left: 25 }, calendar, phone).top).toBe(298);
      });

      it("stays in the window when its field has scrolled out over the top", () => {
        // The dialog scrolled in a 300 px window: the field at −47…−11 put the
        // calendar's top at −7, outside the window.
        expect(placeCalendar({ top: -47, bottom: -11, left: 648 }, calendar, { width: 1280, height: 300 }).top).toBe(8);
      });

      it("stays in the window when its field has scrolled out under the bottom", () => {
        const short = { width: 302, height: 200 };
        // Over the field would be 400 − 4 − 200 = 196, running to 396 in a
        // 300 px window; the lowest place inside it is 300 − 8 − 200 = 92.
        expect(placeCalendar({ top: 400, bottom: 436, left: 25 }, short, { width: 375, height: 300 }).top).toBe(92);
      });
    });

    describe("in a browser with the top layer", () => {
      /*
       * jsdom has neither the Popover API nor layout, so both are stood in for:
       * showPopover and hidePopover as spies, and every box the component
       * measures given a size. The field stands where Sista dagen stands in a
       * dialog low in a 1280×800 window.
       */
      const FIELD = { top: 500, bottom: 536, left: 648 };
      // The calendar's height is its header plus 32 px a week, as in a browser:
      // 230 px for a four-week month, 294 px for a six-week one.
      const PANEL_WIDTH = 302;
      const HEADER = 102;
      const ROW = 32;
      let fieldBox = FIELD;
      const restore: Array<() => void> = [];

      const box = ({ top, left, width, height }: { top: number; left: number; width: number; height: number }) =>
        ({ top, left, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) }) as DOMRect;

      beforeEach(() => {
        fieldBox = FIELD;
        // jsdom's own stylesheet hides a [popover] that is not open, so the
        // stand-in shows the box the way the browser would.
        const showPopover = vi.fn(function (this: HTMLElement) {
          this.style.display = "block";
        });
        Object.assign(HTMLElement.prototype, { showPopover, hidePopover: vi.fn() });
        restore.push(() => {
          delete (HTMLElement.prototype as Partial<HTMLElement>).showPopover;
          delete (HTMLElement.prototype as Partial<HTMLElement>).hidePopover;
        });
        for (const [name, value] of [["clientWidth", 1280], ["clientHeight", 800]] as const) {
          Object.defineProperty(document.documentElement, name, { configurable: true, value });
          restore.push(() => delete (document.documentElement as unknown as Record<string, unknown>)[name]);
        }
        const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
          this: HTMLElement,
        ) {
          if (this.getAttribute("role") === "dialog") {
            const weeks = this.querySelectorAll("tbody tr").length;
            return box({ top: 0, left: 0, width: PANEL_WIDTH, height: HEADER + weeks * ROW });
          }
          if (this.tagName === "TR") return box({ top: 0, left: 0, width: PANEL_WIDTH, height: ROW });
          if (this.querySelector(":scope > div > input")) {
            return box({ top: fieldBox.top, left: fieldBox.left, width: 223, height: fieldBox.bottom - fieldBox.top });
          }
          return box({ top: 0, left: 0, width: 0, height: 0 });
        });
        restore.push(() => measure.mockRestore());
      });

      afterEach(() => {
        // Unmounted first: an open calendar's cleanup still calls hidePopover.
        cleanup();
        while (restore.length > 0) restore.pop()!();
      });

      const showPopover = () => HTMLElement.prototype.showPopover as Mock<() => void>;
      const hidePopover = () => HTMLElement.prototype.hidePopover as Mock<() => void>;
      const panel = () => screen.getByRole("dialog");

      it("lifts the calendar into the top layer as a manual popover", async () => {
        renderField({ value: "2027-02-24" });
        await openCalendar();

        expect(panel()).toHaveAttribute("popover", "manual");
        expect(showPopover()).toHaveBeenCalledTimes(1);
        expect(showPopover().mock.contexts[0]).toBe(panel());
      });

      it("places it by the tallest month, not by the four-week February on show", async () => {
        /*
         * February 2027 has four rows; a month can have six. 230 px as shown
         * would fit under the field (540 + 230 = 770, under 792), but the six
         * rows it may grow to would not (540 + 294 = 834). So it opens over the
         * field, at 500 − 4 − 294 = 202, where stepping to a long month cannot
         * push it out of the window or move its chevrons.
         *
         * Today is pinned in that February too. The calendar is placed before
         * it has moved to the field's own month, while it still shows the one
         * it last showed — today's, on a first open — and the test must not
         * pass or fail with the month the suite happens to run in.
         */
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2027-02-10T12:00:00"));
        restore.push(() => vi.useRealTimers());
        renderField({ value: "2027-02-24" });
        await openCalendar();

        expect(within(grid()).getAllByRole("rowheader")).toHaveLength(4);
        expect(panel().style.top).toBe("202px");
        expect(panel().style.left).toBe("648px");
      });

      it("follows its field when something it sits in scrolls", async () => {
        // The dialog scrolls, not the window: scroll does not bubble, so only a
        // capturing listener hears it.
        fieldBox = { top: 320, bottom: 356, left: 648 };
        render(
          <div data-testid="scroller">
            <DateField id="d" value="2027-03-10" onChange={vi.fn()} />
          </div>,
        );
        await openCalendar();
        expect(panel().style.top).toBe("360px");

        fieldBox = { top: 200, bottom: 236, left: 648 };
        screen.getByTestId("scroller").dispatchEvent(new Event("scroll"));

        expect(panel().style.top).toBe("240px");
      });

      it("stops following once closed, and leaves the top layer with its box", async () => {
        fieldBox = { top: 320, bottom: 356, left: 648 };
        renderField({ value: "2027-03-10" });
        const user = await openCalendar();
        const opened = panel();

        await user.keyboard("{Escape}");
        fieldBox = { top: 200, bottom: 236, left: 648 };
        window.dispatchEvent(new Event("resize"));

        expect(screen.queryByRole("dialog")).toBeNull();
        expect(opened.style.top).toBe("360px");
        // Removing the element takes it out of the top layer; a hidePopover on
        // a disconnected element would throw in a real browser.
        expect(hidePopover()).not.toHaveBeenCalled();
      });

      it("takes itself out of the top layer when the field goes while it is open", async () => {
        // Its dialog closing under it, or React hiding it in an <Activity>:
        // the box is still connected then, and still showing.
        const { unmount } = render(<DateField id="d" value="2027-03-10" onChange={vi.fn()} />);
        await openCalendar();
        const opened = panel();

        unmount();

        expect(hidePopover()).toHaveBeenCalledTimes(1);
        expect(hidePopover().mock.contexts[0]).toBe(opened);
      });

      /** The window `fixed` measures from, as `positionCalendar` reads it. */
      const setWindow = (width: number, height: number) => {
        Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: width });
        Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: height });
      };

      it("follows its field when the window changes size", async () => {
        // A window narrowed to a phone with the calendar open: the dialog drops
        // to one column, the field moves, and the calendar is placed again and
        // slid in from the new right edge (375 − 8 − 302 = 65).
        fieldBox = { top: 320, bottom: 356, left: 648 };
        renderField({ value: "2027-03-10" });
        await openCalendar();
        expect([panel().style.top, panel().style.left]).toEqual(["360px", "648px"]);

        setWindow(375, 812);
        fieldBox = { top: 280, bottom: 316, left: 200 };
        window.dispatchEvent(new Event("resize"));

        expect([panel().style.top, panel().style.left]).toEqual(["320px", "65px"]);
      });

      it("is capped at the window and scrolls inside it, under month chevrons that stay put", async () => {
        // A window lower than the calendar's six weeks (294 px): it gets the
        // top of the window, the window less its two edges as its height, and
        // scrolls. The chevrons' row is sticky, so scrolling to a day near the
        // bottom does not carry them out of the box.
        setWindow(1280, 200);
        renderField({ value: "2027-03-10" });
        await openCalendar();

        expect(panel().style.top).toBe("8px");
        expect(panel().style.maxHeight).toBe("184px");
        expect(panel().style.maxWidth).toBe("1264px");
        expect(panel()).toHaveClass("overflow-auto");
        expect(screen.getByRole("button", { name: "nextMonth" }).parentElement).toHaveClass("sticky", "top-0", "bg-card");
      });

      it("paints in the app's colours, not the browser's popover defaults", async () => {
        // The UA sheet gives a [popover] `color: CanvasText` and `background:
        // Canvas`, which in the dark theme is black text on the dark card.
        renderField({ value: "2027-03-10" });
        await openCalendar();

        expect(panel()).toHaveClass("bg-card", "text-foreground");
      });
    });

    it("keeps the old box under the field in a browser without the top layer", async () => {
      renderField();
      await openCalendar();

      const box = screen.getByRole("dialog");
      expect(box).not.toHaveAttribute("popover");
      expect(box).toHaveClass("absolute", "mt-1");
    });
  });
});
