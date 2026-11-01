/**
 * SAMMANHÄNGANDE UNDERVISNING: HOW LONG A TEACHER TEACHES IN A ROW.
 *
 * The administrator sets, per teacher, "at most X minutes of teaching in a
 * row, then Y minutes free" on the work rule (migration 20261218090000).
 * Three places keep it, each in its own way: the generator TRIES (a wish in
 * the full model's objective, optimization-engine/app/solver/consecutive.py,
 * never a refusal), a hand edit of the grundschema is WARNED about
 * (master-lessons.service.ts), and the Vikarietavla never proposes a cover
 * that would break it (src/cover/cover-rules.ts). This module is the one
 * definition the gateway counts with; benchmarks/validate_schedule.py replays
 * __fixtures__/stretch-cases.json for the same arithmetic without sharing a
 * line with it, and the engine's model is held to it by a brute-force oracle
 * (tests/test_consecutive.py).
 *
 * A STRETCH IS TEACHING THAT THE TEACHER'S FREE TIME NEVER INTERRUPTS. Take a
 * teacher's lessons of one day in start order. A lesson belongs to the stretch
 * before it when it starts LESS than Y minutes after the stretch's latest end
 * — a gap of Y or more is a break and ends the stretch — and opens a new one
 * otherwise. A stretch is as long as from its first lesson's start to its last
 * lesson's end, the gaps shorter than Y inside it counted in: five minutes to
 * change room is not a rest, and a rule that let the teacher teach 08:00–10:00
 * and 10:05–12:00 as two stretches of two hours would be a rule about the
 * bell, not about the teacher. It is over the limit when it is LONGER than X;
 * exactly X is fine.
 *
 * THE SAME LESSONS AS THE CAP AND THE DAYS (teacher-day.ts), one definition
 * for all: every lesson the teacher is on, as lead or medlärare, in its own
 * minutes, start to end; a parked lesson occupies nothing; a lesson that does
 * not end after it starts takes no time; two lessons that overlap, a hand-made
 * pair the clash check let through or a block the teacher sits in twice, are
 * one stretch. A break is time with none of the teacher's lessons: an uppdrag,
 * a rastvakt or the lunch is work but is not what this rule is about, and a
 * teacher on the yard for twenty minutes between two lessons has had twenty
 * minutes without teaching.
 *
 * A NIGHT ENDS A STRETCH: stretches are per day, which the callers see to by
 * asking one weekday or one date at a time.
 *
 * PURE. Times are minutes since midnight.
 */

/** Bounds shared by the DTOs, the CHECKs (20261218090000) and the engine. */
export const MAX_CONSECUTIVE_TEACHING_MINUTES_MIN = 30;
export const MAX_CONSECUTIVE_TEACHING_MINUTES_MAX = 480;
export const CONSECUTIVE_BREAK_MINUTES_MIN = 5;
export const CONSECUTIVE_BREAK_MINUTES_MAX = 120;
/** The engine's grid, for both figures. */
export const CONSECUTIVE_STEP = 5;

/** A teacher's limit: both figures, or neither. */
export interface StretchRule {
  /** Null: no limit. */
  maxConsecutiveTeachingMinutes?: number | null;
  /** Null: no limit. */
  consecutiveBreakMinutes?: number | null;
}

/** Whether the rule limits anything: both figures set, which the table's CHECK keeps true or both null. */
export function hasStretchRule(rule: StretchRule): rule is {
  maxConsecutiveTeachingMinutes: number;
  consecutiveBreakMinutes: number;
} {
  return (
    (rule.maxConsecutiveTeachingMinutes ?? null) !== null && (rule.consecutiveBreakMinutes ?? null) !== null
  );
}

/** A span of one day: minutes since midnight. */
export interface StretchSpan {
  startMinutes: number;
  endMinutes: number;
}

/** One stretch: where it runs and the spans in it, in start order. */
export interface Stretch<S extends StretchSpan = StretchSpan> {
  startMinutes: number;
  endMinutes: number;
  /** end − start: the gaps inside it count. */
  minutes: number;
  spans: S[];
}

/**
 * The stretches of one day's spans, in time order. Spans that take no time are
 * left out; a span that starts less than `breakMinutes` after the stretch's
 * latest end (or before it) belongs to it.
 */
export function stretchesOf<S extends StretchSpan>(spans: readonly S[], breakMinutes: number): Stretch<S>[] {
  const sorted = spans
    .filter((span) => span.endMinutes > span.startMinutes)
    .slice()
    .sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes);
  const stretches: Stretch<S>[] = [];
  for (const span of sorted) {
    const last = stretches[stretches.length - 1];
    if (last !== undefined && span.startMinutes - last.endMinutes < breakMinutes) {
      last.spans.push(span);
      last.endMinutes = Math.max(last.endMinutes, span.endMinutes);
      last.minutes = last.endMinutes - last.startMinutes;
    } else {
      stretches.push({
        startMinutes: span.startMinutes,
        endMinutes: span.endMinutes,
        minutes: span.endMinutes - span.startMinutes,
        spans: [span],
      });
    }
  }
  return stretches;
}

/** The stretches of the day that are longer than `max`, in time order. */
export function overlongStretches<S extends StretchSpan>(
  spans: readonly S[],
  max: number,
  breakMinutes: number,
): Stretch<S>[] {
  return stretchesOf(spans, breakMinutes).filter((stretch) => stretch.minutes > max);
}
