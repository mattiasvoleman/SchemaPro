import { layoutDay } from "@/lib/day-lanes";
import { DAY_END_MINUTES, lessonsOfFilters, type BoardFilters, type BoardKept, type CardNames } from "@/lib/placement-board";
import { runsInWeek } from "@/lib/placement-weeks";

/*
 * THE LATEST SCHEDULE BEHIND THE WEEK ("Visa senaste schemat"): the lessons the last Generera laid, as pale outlines behind the
 * cards, for the school that wants to see where the solver put the rest before it lays a lesson of its own.
 *
 * What they are: the lessons the next Generera replaces (GET /teaching-requirements/placements/latest). They are drawn for what the
 * school has picked, as the lessons Generera keeps are (a school's whole machine-made schedule is no week to read), and for the week
 * that is shown when one is. They are not lessons of the week: inert, not in its lanes (the grid's `behind`, which gives a column to a
 * layer and not to lessons), and laid out among themselves so that the groups of one hour stand side by side.
 *
 * Where a förläggning stands on one, both show: the förläggning is not judged against it (nothing here is a rule), and the next Generera
 * lays it again wherever the solver puts it.
 *
 * Fetched with the week's other tools (lib/placement-week-tools.ts), one chunk for all of them.
 */

export interface GhostLesson {
  id: string;
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
  title: string;
  subtitle: string;
  color: string;
  /** What a screen reader hears: the lesson, where and when. */
  label: string;
}

const minutesOfClock = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/** The week of förläggningar's day: 08:00 to 18:00 (the grid starts at 08:00 and is told to draw to 18:00). A lesson wholly outside it has no place to be drawn. */
const DAY_START_MINUTES = 8 * 60;

/** The latest schedule as it is drawn for the filters and the week: nothing when no class, teacher or room is picked. */
export function ghostLessonsOf(input: {
  lessons: readonly BoardKept[];
  filters: BoardFilters;
  /** The Monday of the week shown, or null for every week. */
  week: string | null;
  names: CardNames;
  /** "Senaste schemat: {lesson}". */
  said: (lesson: string) => string;
}): GhostLesson[] {
  const { filters, week, names } = input;
  if (filters.groups.length === 0 && filters.teachers.length === 0 && filters.rooms.length === 0) return [];
  return lessonsOfFilters(input.lessons, filters)
    .filter((lesson) => week === null || runsInWeek(lesson, lesson.dayOfWeek, week))
    .filter((lesson) => minutesOfClock(lesson.endTime) > DAY_START_MINUTES && minutesOfClock(lesson.startTime) < DAY_END_MINUTES)
    .map((lesson) => {
      const subject = names.subject(lesson.subjectId);
      const classes = [lesson.studentGroupId, ...lesson.extraGroupIds].map((id) => names.group(id)).filter(Boolean).join(" + ");
      const subtitle = [classes, names.teacher(lesson.teacherId)].filter(Boolean).join(" · ");
      const title = subject?.name ?? "";
      const start = minutesOfClock(lesson.startTime);
      const end = minutesOfClock(lesson.endTime);
      return {
        id: `latest:${lesson.id}`,
        dayOfWeek: lesson.dayOfWeek,
        startMinutes: start,
        endMinutes: end,
        title,
        subtitle,
        color: names.color(lesson.subjectId, subject?.color),
        label: input.said([title, subtitle, names.room(lesson.roomId), `${lesson.startTime.slice(0, 5)}–${lesson.endTime.slice(0, 5)}`].filter(Boolean).join(", ")),
      };
    });
}

/** A length in pixels as a style says it, to a hundredth: 180 minutes of 1.1 px is 198, not 198.00000000000003. */
const px = (value: number): string => `${Math.round(value * 100) / 100}px`;

/** One day's column of the latest schedule: the grid's `behind` calls it for each day. */
export function GhostColumn({
  ghosts,
  day,
  scale,
}: {
  ghosts: readonly GhostLesson[];
  day: number;
  scale: { startMinutes: number; pxPerMinute: number };
}) {
  return (
    // Cut at the column's edges: a lesson that crosses 08:00 or 18:00 (ghostLessonsOf keeps it) would otherwise stand 33 px outside the
    // day's body, and the grid's scroll box, which is `overflow-x: auto` and so scrolls upright too, would get a vertical scroll for it.
    <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden" data-testid="placement-ghost-column">
      {layoutDay(ghosts.filter((ghost) => ghost.dayOfWeek === day)).map((ghost) => {
        const height = Math.max(14, (ghost.endMinutes - ghost.startMinutes) * scale.pxPerMinute);
        return (
          <div
            key={ghost.id}
            role="img"
            aria-label={ghost.label}
            data-testid="placement-ghost"
            // Inert, as a band is: a layer that took the pointer would take the empty slots of the column with it (timetable-grid.tsx).
            className="pointer-events-none absolute z-0 overflow-hidden rounded-sm border border-dashed border-border bg-muted/30 px-1 py-0.5 text-[10px] leading-tight text-muted-foreground"
            style={{
              top: px((ghost.startMinutes - scale.startMinutes) * scale.pxPerMinute),
              height: px(height),
              left: `calc(${(ghost.lane * 100) / ghost.laneCount}% + 2px)`,
              width: `calc(${100 / ghost.laneCount}% - 4px)`,
              borderLeft: `3px solid ${ghost.color}`,
            }}
          >
            <span className="block truncate font-medium">{ghost.title}</span>
            {height >= 26 && ghost.subtitle ? <span className="block truncate">{ghost.subtitle}</span> : null}
          </div>
        );
      })}
    </div>
  );
}
