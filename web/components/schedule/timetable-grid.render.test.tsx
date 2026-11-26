import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { TimetableGrid, type TimetableLesson } from "./timetable-grid";

/*
 * How many cards the grid draws, counted where a card says so: every card draws
 * its class list with `cn` exactly once per render, and that list begins with
 * the string below (the grid's own `cn` calls do not). So the counter is the
 * number of card renders, whatever the grid is made of inside.
 *
 * The count is what E2 promises ("inga kort ritas om vid en pekarrörelse") and
 * what a timing cannot: a render of 800 cards is fast on this Mac and slow on a
 * school's old laptop, and the same count on both.
 */
const CARD_CLASS = "absolute overflow-hidden rounded-md border-l-4";
const drawn = vi.hoisted(() => ({ cards: 0, base: "absolute overflow-hidden rounded-md border-l-4" }));

vi.mock("@/lib/utils", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/utils")>();
  return {
    ...original,
    cn: (...inputs: Parameters<typeof original.cn>) => {
      if (typeof inputs[0] === "string" && inputs[0].startsWith(drawn.base)) drawn.cards++;
      return original.cn(...inputs);
    },
  };
});

vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(" ")}` : key,
}));

/** 800 lessons: 40 classes of 20 a week, so a day holds 160 of them. */
function week(count: number, overrides: Partial<TimetableLesson> = {}): TimetableLesson[] {
  return Array.from({ length: count }, (_, index) => {
    const day = (index % 5) + 1;
    const slot = Math.floor(index / 5) % 7;
    return {
      id: `lesson-${index}`,
      dayOfWeek: day,
      startMinutes: 480 + slot * 60,
      endMinutes: 540 + slot * 60,
      title: `Ämne ${index}`,
      subtitle: `Klass ${index % 40}`,
      color: "#6366f1",
      ...overrides,
    };
  });
}

/** The first lesson's card. */
const first = () => document.querySelector<HTMLElement>('[data-lesson-id="lesson-0"]')!;

/** The same lessons as new objects: what the page's view builds again after any read. */
const again = (lessons: TimetableLesson[]) => lessons.map((lesson) => ({ ...lesson }));

const RECT = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 556,
  bottom: 528,
  width: 556,
  height: 528,
  toJSON: () => ({}),
} as DOMRect;

beforeEach(() => {
  drawn.cards = 0;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(RECT);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the cards of the grid are drawn when their lesson changes, and not otherwise", () => {
  it("counts a card where it is drawn", () => {
    render(<TimetableGrid lessons={week(10)} editable />);
    expect(CARD_CLASS).toBe(drawn.base);
    expect(drawn.cards).toBe(10);
  });

  it("draws no card at all while a pointer moves over a week of 800 lessons", () => {
    const validateChange = vi.fn().mockReturnValue(true);
    render(<TimetableGrid lessons={week(800)} editable validateChange={validateChange} onLessonChange={vi.fn()} />);
    expect(drawn.cards).toBe(800);

    // Press the first lesson, and let the press settle: starting a drag marks
    // ONE card (the one in hand), which is the only card the start may draw.
    drawn.cards = 0;
    fireEvent.pointerDown(first(), {
      pointerId: 1,
      button: 0,
      clientX: 100,
      clientY: 10,
    });
    expect(drawn.cards).toBeLessThanOrEqual(1);

    // Forty moves across the week, each to a new square. In the grid as it was,
    // each of them drew every card: 40 x 800 = 32 000 renders.
    drawn.cards = 0;
    for (let move = 0; move < 40; move++) {
      fireEvent.pointerMove(window, {
        pointerId: 1,
        clientX: 60 + (move % 5) * 100,
        clientY: 20 + move * 11,
      });
    }
    expect(validateChange).toHaveBeenCalled();
    expect(drawn.cards).toBe(0);
  });

  it("asks the page about a square once, however many pixels the pointer takes to cross it", () => {
    const validateChange = vi.fn().mockReturnValue(true);
    render(<TimetableGrid lessons={week(20)} editable validateChange={validateChange} onLessonChange={vi.fn()} />);
    fireEvent.pointerDown(first(), {
      pointerId: 1,
      button: 0,
      clientX: 100,
      clientY: 10,
    });
    // 1.1 px a minute and a step of five: a square is 5.5 px tall. Twenty
    // pixels in the same column are four squares at most.
    for (let y = 100; y < 120; y++) {
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 110, clientY: y });
    }
    expect(validateChange.mock.calls.length).toBeLessThanOrEqual(5);
    expect(validateChange.mock.calls.length).toBeGreaterThan(0);
  });

  it("draws only the card of a lesson that changed when the page reads the week again", () => {
    const lessons = week(800);
    const { rerender } = render(<TimetableGrid lessons={lessons} editable />);
    drawn.cards = 0;

    // The page's read gives the same week as new objects, one lesson moved.
    const next = again(lessons);
    next[7] = { ...next[7]!, startMinutes: 600, endMinutes: 660 };
    rerender(<TimetableGrid lessons={next} editable />);

    // The moved lesson, and the lessons that share its day's lanes: a lane is
    // the day's, so a card whose lane or the day's lane count changed is drawn
    // with it. Not the week.
    expect(drawn.cards).toBeGreaterThanOrEqual(1);
    expect(drawn.cards).toBeLessThan(800);
  });

  it("draws nothing when the page reads the same week again", () => {
    const lessons = week(800);
    const { rerender } = render(<TimetableGrid lessons={lessons} editable />);
    drawn.cards = 0;
    rerender(<TimetableGrid lessons={again(lessons)} editable />);
    expect(drawn.cards).toBe(0);
  });

  it("draws every card again when the grid's own scale changes, which is what the card is measured against", () => {
    const lessons = week(30);
    const { rerender } = render(<TimetableGrid lessons={lessons} editable />);
    drawn.cards = 0;
    // The usual length goes from 60 to 40 minutes: a minute is taller.
    rerender(
      <TimetableGrid
        lessons={lessons.map((lesson) => ({ ...lesson, endMinutes: lesson.startMinutes + 40 }))}
        editable
      />,
    );
    expect(drawn.cards).toBe(30);
  });
});
