"use client";

/*
 * A date field that shows the week number, because a Swedish school runs on
 * week numbers.
 *
 * Every date input in this app used to be `<input type="date">`, which hands
 * the picking over to the browser. That is a good picker — typable, localised,
 * a proper wheel on a phone — and it is the one thing it cannot be told to do:
 * no browser shows ISO week numbers in it, and none can be styled into
 * showing them. So the calendar has to be ours.
 *
 * WHAT WAS KEPT FROM THE NATIVE FIELD. Typing. An administrator entering a
 * läsår's lov types four dates in a row and never reaches for a mouse, and a
 * calendar-only control would make that slower for the person who uses it
 * most. The text box is the field; the calendar is an affordance beside it.
 *
 * WHY NOT react-day-picker, which has `showWeekNumber` built in: it is ~30 KB
 * and /guardian sits 4 KB under its tier budget. Nor @radix-ui/react-popover,
 * for the same reason at a smaller scale.
 *
 * The dismissal that was hand-rolled in its place is gone: it got the Escape
 * ordering wrong against the <Dialog> most of these fields sit in, and one press
 * closed the whole half-filled form. That part is @radix-ui/react-dismissable-
 * layer now — already in the bundle underneath <Dialog>, and the thing that
 * actually knows which layer is on top. What remains ours is the grid, the week
 * column and the keyboard, and those are tested rather than trusted.
 *
 * CONTRAST, MEASURED. Computed from the HSL tokens in app/globals.css, rounded
 * to 8-bit the way a browser paints them. Light theme first, then dark:
 *
 *   foreground on card             18.69 / 15.43   AAA — every day, and the week
 *   foreground on muted (:hover)   17.00 / 13.19   AAA — a day under the pointer
 *   foreground/40 on card          2.61 /  3.39    exempt — a day out of range
 *
 * Two things were rejected for failing it. A filled selection chip
 * (`primary-foreground` on `primary`) measures 6.18 / 5.12, under AAA on the
 * one cell that matters most, so the selection is a ring and the numeral stays
 * on the card. Greyed neighbouring-month days (`muted-foreground` on `card`)
 * measure 4.83 / 6.17, so those cells are blank instead.
 *
 * THE WEEK NUMBERS COME FROM `isoWeek`, deliberately, and not from a second
 * implementation. That function already decides which weeks are udda and which
 * are jämna for every alternating lesson in the school, and a calendar that
 * disagreed with it by even one week at the new-year seam would be worse than
 * no calendar at all: the administrator would be reading one definition while
 * the timetable ran on another.
 */

import * as React from "react";
import { DismissableLayer } from "@radix-ui/react-dismissable-layer";
import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { addDays, cn, isoWeek, startOfIsoWeek, toDateString } from "@/lib/utils";

export interface DateFieldProps {
  id?: string;
  /** yyyy-mm-dd, or "" for empty — the same value `<input type="date">` gave. */
  value: string;
  onChange: (value: string) => void;
  /** Inclusive bounds, as yyyy-mm-dd. Out-of-range days are not selectable. */
  min?: string | undefined;
  max?: string | undefined;
  /**
   * Kept because `<input type="date">` had it and this is a drop-in for it, not
   * because anything passes it yet — a form that greys its fields while saving
   * would, and finding the prop missing then is a worse discovery than finding
   * it unused now. No call site exercises it, so date-field.test.tsx is the
   * only thing that does; the same goes for `aria-describedby`.
   */
  disabled?: boolean;
  /**
   * The field's visible label, used to tell one calendar button from another.
   *
   * A dialog with a från and a till field gave a screen-reader user two buttons
   * both called "Öppna kalender", with nothing to say which was which.
   */
  label?: string;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** yyyy-mm-dd at LOCAL midnight — the convention lib/ics.ts parses with. */
function parseDay(value: string): Date | null {
  if (!ISO_DATE.test(value)) return null;
  const day = new Date(`${value}T00:00:00`);
  // Rejects 2026-02-30, which passes the pattern and rolls over to March.
  return Number.isNaN(day.getTime()) || toDateString(day) !== value ? null : day;
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function DateField({
  id,
  value,
  onChange,
  min,
  max,
  disabled,
  label,
  className,
  ...aria
}: DateFieldProps) {
  const t = useTranslations("dateField");
  /*
   * A draft of what is being typed, so that only WHOLE dates leave this
   * component.
   *
   * `<input type="date">` emits a complete date or the empty string, never
   * anything in between, and the call sites were written against that: one of
   * them puts the value straight into a query key, and "2027-0" would send it
   * fetching a day that does not exist on every keystroke. A plain text box
   * bound to `onChange` would have handed them exactly that.
   *
   * So the box shows the draft, and `onChange` fires only when the draft is a
   * real date or has been cleared. The contract the eighteen call sites already
   * rely on is unchanged, which is why none of them needed a guard rewritten.
   */
  const [draft, setDraft] = React.useState(value);
  // Re-synced when the value is changed from outside — picking a day in the
  // calendar, or a form being reset for a different row.
  React.useEffect(() => setDraft(value), [value]);
  // The month and weekday names come from the ACTIVE locale, not from a string
  // in the catalog: twelve month names and seven weekday names translated by
  // hand is thirty-eight strings that Intl already has, in every language, with
  // the right capitalisation for each.
  const locale = useLocale();
  const [open, setOpen] = React.useState(false);
  const selected = parseDay(value);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const gridRef = React.useRef<HTMLTableElement>(null);

  /*
   * ONE state for the calendar, not three.
   *
   * The first version kept a `cursor` for the month on show, took the roving
   * tab stop from `value`, and let the arrows commit as they moved. The three
   * disagreed in every direction. On an empty field the focus ring sat on the
   * 1st while the arrows stepped from today, so the first press jumped
   * somewhere else entirely. PageUp changed the month, the day that held the
   * only tab stop stopped existing, and focus fell to <body> — the calendar
   * stayed open with the keyboard locked out of it. And a value already outside
   * min/max put the single tab stop on a disabled button, which is no tab stop
   * at all.
   *
   * `focusedDay` is now the only answer to "which day is the keyboard on". The
   * month shown is its month, the tab stop is on it, and DOM focus follows it.
   * `value` is what has been CHOSEN, which is a different question and changes
   * only on Enter, Space or a click.
   */
  const [focusedDay, setFocusedDay] = React.useState<Date>(() => new Date());
  const cursor = focusedDay;

  /*
   * Focus moves INTO the calendar when it opens, onto the selected day.
   *
   * It is announced as a dialog, and a dialog that opens behind the focus ring
   * is one a keyboard user has no way to reach: tab would walk them through the
   * rest of the form first, and the arrow keys they would reach for do nothing
   * because the grid never received the key event. The day buttons carry a
   * roving tabindex, so the selected one is the single stop the calendar adds
   * to the tab order.
   */
  React.useEffect(() => {
    if (!open) return;
    /*
     * Where the keyboard lands, and it must be a day it is allowed to pick.
     *
     * The field's own value first, then today, then the nearest bound — a lov
     * dated before the läsår starts would otherwise open on a disabled day,
     * with nothing to step to and no way out but the mouse.
     */
    const start = selected ?? new Date();
    setFocusedDay(clampToRange(start));
    // Only on open: re-running it while the popover is up would drag the
    // keyboard back every time a day is chosen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // DOM focus follows `focusedDay`, which is what makes PageUp and the arrows
  // keep the keyboard inside the grid instead of dropping it on <body>.
  React.useEffect(() => {
    if (!open) return;
    gridRef.current
      ?.querySelector<HTMLButtonElement>('button[tabindex="0"]')
      ?.focus();
  }, [open, focusedDay]);

  /*
   * Dismissal is Radix's, not ours, and the reason is a bug this replaced.
   *
   * The first version listened for Escape on `document` in the capture phase
   * and stopped the event there, on the theory that it would run before the
   * <Dialog> most of these fields sit inside. It does not: Radix's own listener
   * is also document-capture and the dialog mounts first, so it is registered
   * first and runs first. One press closed the calendar AND threw away the
   * half-filled form behind it, which reads as the app losing your work.
   *
   * DismissableLayer keeps a stack and attaches the key listener only for the
   * HIGHEST layer, which is exactly this problem solved properly. It also
   * carries the outside-pointer handling that was hand-rolled beside it. The
   * package was already in the bundle underneath <Dialog>; it is declared in
   * package.json now rather than imported as a phantom dependency.
   *
   * `disableOutsidePointerEvents` stays off: the form behind the calendar is
   * still the thing being filled in, and a click straight onto another field
   * should land there rather than being eaten by a dismissal.
   */
  const outOfRange = (day: string): boolean =>
    (min !== undefined && min !== "" && day < min) ||
    (max !== undefined && max !== "" && day > max);

  /** The nearest day the field is allowed to hold. */
  const clampToRange = (day: Date): Date => {
    const iso = toDateString(day);
    if (min !== undefined && min !== "" && iso < min) return parseDay(min) ?? day;
    if (max !== undefined && max !== "" && iso > max) return parseDay(max) ?? day;
    return day;
  };

  const choose = (day: Date) => {
    // No bounds check here on purpose. The only caller is a day button that
    // carries `disabled` when the day is out of range, and a disabled button
    // fires no click — so a guard on this line would be unreachable, which
    // means untestable, which means a second statement of the rule that can
    // drift from the first without anything noticing. The keyboard path has
    // its own check, in onGridKeyDown, because that one IS reachable.
    const iso = toDateString(day);
    onChange(iso);
    setOpen(false);
    triggerRef.current?.focus();
  };

  // Six rows always, so the popover does not change height between months and
  // move the button the user is about to click.
  const firstCell = startOfIsoWeek(startOfMonth(cursor));
  /*
   * Six rows are generated and the empty tail is dropped.
   *
   * Six is what keeps the popover a constant height so the button underneath
   * does not move between months. But with neighbouring months left blank, the
   * last row of most months held no day at all — 114 of 144 months over a
   * decade — and printed a lone week number beside seven empty cells, which
   * reads as a week that exists and has nothing in it. A row with no day of
   * this month is not a week of this month.
   */
  const weeks = Array.from({ length: 6 }, (_, row) =>
    Array.from({ length: 7 }, (_, col) => addDays(firstCell, row * 7 + col)),
  ).filter((week) => week.some((day) => day.getMonth() === cursor.getMonth()));

  const monthLabel = new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
  }).format(cursor);
  const weekdayName = new Intl.DateTimeFormat(locale, { weekday: "short" });
  const fullDate = new Intl.DateTimeFormat(locale, { dateStyle: "long" });

  /*
   * Moving is not choosing.
   *
   * The arrows used to commit every step, which meant a keyboard user could not
   * look at March without changing the value to a day in March — and on the
   * three call sites where the date drives a query, holding an arrow down fired
   * a fetch per keypress. A browser's own calendar commits once, when the day is
   * taken. Enter, Space and a click take the day; everything else only moves.
   */
  /**
   * A month back or forward, keeping the day where it exists.
   *
   * Shared by the chevrons and by PageUp/PageDown so the two cannot answer the
   * end-of-month question differently — and because it moves `focusedDay`, the
   * chevrons keep the keyboard inside the grid the way the keys do. Clicking
   * the chevron used to move only the month, leaving the tab stop on a day that
   * no longer existed.
   */
  const stepMonth = (months: number) => {
    const moved = new Date(focusedDay);
    moved.setMonth(moved.getMonth() + months, 1);
    const lastOfMonth = new Date(
      moved.getFullYear(),
      moved.getMonth() + 1,
      0,
    ).getDate();
    moved.setDate(Math.min(focusedDay.getDate(), lastOfMonth));
    setFocusedDay(moved);
  };

  const onGridKeyDown = (event: React.KeyboardEvent) => {
    const step: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    if (event.key in step) {
      event.preventDefault();
      setFocusedDay(addDays(focusedDay, step[event.key]!));
      return;
    }
    if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      stepMonth(event.key === "PageUp" ? -1 : 1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const monday = startOfIsoWeek(focusedDay);
      setFocusedDay(event.key === "Home" ? monday : addDays(monday, 6));
    }
  };

  const today = toDateString(new Date());
  const rovingDay = toDateString(focusedDay);

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <div className="flex gap-1">
        <Input
          id={id}
          // `text`, not `date`: a native date input paints the browser's own
          // picker icon, and two pickers on one field is one too many.
          type="text"
          /*
           * No `inputMode="numeric"`. It was there to bring up a number pad on
           * a phone, and an iOS number pad has no hyphen — so the placeholder
           * this very field shows, åååå-mm-dd, could not be typed on it. The
           * ordinary keyboard can type the whole thing, and the calendar beside
           * it is the faster path on a touch screen anyway.
           */
          placeholder={t("placeholder")}
          value={draft}
          disabled={disabled}
          aria-invalid={draft !== "" && parseDay(draft) === null ? true : undefined}
          onChange={(event) => {
            const next = event.target.value;
            setDraft(next);
            if (next === "" || parseDay(next) !== null) onChange(next);
          }}
          /*
           * Leaving the box shows what the form actually holds. Always, not
           * only when the draft is unparseable.
           *
           * Half-edited text is fine WHILE typing — deleting a digit to fix it
           * passes through "2026-08-1" — but it must not survive the blur, or
           * the box says one date while save sends another.
           *
           * The unconditional form covers a second case the narrow one missed.
           * Six call sites guard with `value && setX(value)`, so clearing the
           * box is REFUSED: `onChange("")` fires, the parent keeps its date, and
           * the draft — being a perfectly valid empty string — was left showing
           * empty while a query went on running on the old date. A controlled
           * `<input type="date">` put the value back in exactly that situation,
           * which is why no call site guards against it. If a draft is really
           * the value, this assignment is a no-op.
           */
          onBlur={() => setDraft(value)}
          {...aria}
        />
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={
            label ? t("openCalendarFor", { field: label }) : t("openCalendar")
          }
          onClick={() => setOpen((wasOpen) => !wasOpen)}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-input text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          <CalendarDays className="h-4 w-4" />
        </button>
      </div>

      {open ? (
        <DismissableLayer
          role="dialog"
          aria-label={t("calendarLabel")}
          /*
           * Dismissal puts focus back on the trigger, in every case.
           *
           * A separate `onFocusOutside` that closed WITHOUT restoring focus was
           * written first, on the theory that Tab out of the calendar is a
           * request to move forward and should not be answered by dragging
           * focus back. Measured, it changes nothing: the trigger sits before
           * the popover in the DOM, so Tab lands on it of its own accord and one
           * more Tab carries on — and a click into another field fires
           * pointer-down first, so that route restores and then moves on
           * regardless. Neither the tab trail nor a click could tell the two
           * apart, so the line was removed rather than kept as a claim nothing
           * can check.
           */
          onDismiss={() => {
            setOpen(false);
            triggerRef.current?.focus();
          }}
          className="absolute z-50 mt-1 rounded-md border bg-card p-2 shadow-md"
        >
          <div className="mb-1 flex items-center justify-between gap-2">
            <button
              type="button"
              aria-label={t("previousMonth")}
              onClick={() => stepMonth(-1)}
              className="inline-flex h-7 w-7 items-center justify-center rounded text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span aria-live="polite" className="text-sm font-medium text-foreground">
              {monthLabel}
            </span>
            <button
              type="button"
              aria-label={t("nextMonth")}
              onClick={() => stepMonth(1)}
              className="inline-flex h-7 w-7 items-center justify-center rounded text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {/*
            A real table, not a grid of divs. The week number is the row's
            HEADER — `th scope="row"` — which is what makes a screen reader
            announce "vecka 9" once for the row instead of reading a stray
            number before every date in it.
          */}
          <table
            ref={gridRef}
            role="grid"
            onKeyDown={onGridKeyDown}
            className="border-separate border-spacing-0 text-sm"
          >
            <thead>
              <tr>
                <th
                  scope="col"
                  className="w-8 pb-1 pr-1 text-right text-xs font-medium text-foreground"
                >
                  {t("weekAbbreviation")}
                </th>
                {weeks[0]!.map((day) => (
                  <th
                    key={toDateString(day)}
                    scope="col"
                    className="w-9 pb-1 text-center text-xs font-medium text-foreground"
                  >
                    {weekdayName.format(day)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeks.map((week) => (
                <tr key={toDateString(week[0]!)}>
                  <th
                    scope="row"
                    // Read as "vecka 9", written as "9". The bare numeral is
                    // what a Swedish calendar looks like; it is not what a
                    // screen reader can make sense of on its own.
                    aria-label={t("weekNumber", { week: isoWeek(week[0]!) })}
                    className="border-r pr-1 text-right text-xs font-normal tabular-nums text-foreground"
                  >
                    {isoWeek(week[0]!)}
                  </th>
                  {week.map((day) => {
                    const iso = toDateString(day);
                    /*
                     * Days belonging to the neighbouring months are left BLANK.
                     *
                     * Drawing them greyed is the usual thing and it cannot be
                     * done here at the contrast this repo holds itself to:
                     * `muted-foreground` on `card` measures 4.83 / 6.17, which
                     * is AA, and these are 14px numerals. Every way of dimming
                     * text is the same problem wearing a different name. An
                     * empty cell says "not this month" without saying it in a
                     * colour anybody has to be able to see, and the week number
                     * still anchors the row. The months are reached with the
                     * arrows or PageUp/PageDown.
                     */
                    if (day.getMonth() !== cursor.getMonth()) {
                      return <td key={iso} role="gridcell" className="h-8 w-9 p-0" />;
                    }
                    const disabledDay = outOfRange(iso);
                    return (
                      /*
                       * `aria-selected` sits on the CELL, not on the button.
                       * It is not an allowed attribute on role=button — axe
                       * calls that aria-allowed-attr, impact critical — and an
                       * ignored attribute meant no screen reader could tell
                       * which day was chosen. A gridcell is where the state
                       * belongs; the button is only how it is operated.
                       */
                      <td key={iso} role="gridcell" aria-selected={iso === value} className="p-0">
                        <button
                          type="button"
                          tabIndex={iso === rovingDay ? 0 : -1}
                          disabled={disabledDay}
                          aria-current={iso === today ? "date" : undefined}
                          // "24" alone says nothing about which month or year
                          // it belongs to, and the arrows cross both silently.
                          aria-label={fullDate.format(day)}
                          onClick={() => choose(day)}
                          className={cn(
                            "h-8 w-9 rounded text-center tabular-nums text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            /*
                             * The selection is a RING, not a filled chip.
                             * `primary-foreground` on `primary` is 6.18 / 5.12
                             * — under AAA in both themes, on the one cell that
                             * matters most. A ring leaves the numeral on the
                             * card at 18.69 / 15.43 and still marks it in the
                             * accent colour.
                             */
                            iso === value
                              ? "font-semibold ring-2 ring-primary"
                              : "hover:bg-muted",
                            // Today is marked underneath, so it survives being
                            // the selected day as well.
                            iso === today && "underline underline-offset-4",
                            // Dimmed on purpose: WCAG 1.4.3 exempts an inactive
                            // control, and this measures 2.61 / 3.39. Being
                            // unreadable IS the message, and the day cannot be
                            // reached by keyboard or pointer either way.
                            disabledDay && "cursor-not-allowed opacity-40",
                          )}
                        >
                          {day.getDate()}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </DismissableLayer>
      ) : null}
    </div>
  );
}
