"use client";

import { useQuery } from "@tanstack/react-query";
import { ApiError, api } from "@/lib/api";
import { isoWeekdayOf } from "@/lib/lesson-mapper";
import type { TimetableLesson } from "@/components/schedule/timetable-grid";

/*
 * THE SIGNED-IN PERSON'S RASTVAKTSPASS in their own week (Rastvakt i
 * vardagen, 20261210090000): GET /api/v1/supervision/week, read as
 * themself. Their own passes on the dates they run, with what the board
 * decided while they were away, and the passes they take as vikarie for
 * somebody else — never whose, never why.
 *
 * Its own module, beside lib/queries.ts rather than in it (that one is in
 * every route's chunk graph): the teacher's week alone reads it.
 */

/** supervision.service.ts WeekPass. */
export interface WeekPass {
  kind: "OWN" | "COVER";
  shiftId: string;
  date: string;
  startsAt: string;
  endsAt: string;
  areaName: string;
  siteName: string | null;
  /** OWN only: a vikarie takes it that day, or it is left without one; null when it is theirs. */
  handover: "SUBSTITUTE" | "NO_COVER" | null;
}

/**
 * A 404 WITHOUT a code is a gateway that has no such route — one from before
 * Rastvakt i vardagen, or rolled back past it — and it has no passes to give:
 * an empty week, not "the passes could not be read" on every load. The
 * route's own refusals carry a code.
 */
export async function readSupervisionWeek(from: string, to: string): Promise<{ from: string; to: string; passes: WeekPass[] }> {
  try {
    return await api.get<{ from: string; to: string; passes: WeekPass[] }>(`/api/v1/supervision/week?from=${from}&to=${to}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && !error.code) return { from, to, passes: [] };
    throw error;
  }
}

export function useSupervisionWeek(from: string, to: string) {
  return useQuery({
    queryKey: ["supervisionWeek", from, to],
    retry: false,
    queryFn: () => readSupervisionWeek(from, to),
  });
}

/** The grid's id of a pass: never a lesson's, so a click on it opens no lesson page. */
export const PASS_ID_PREFIX = "pass:";

export const isPassEntry = (lesson: { id: string }) => lesson.id.startsWith(PASS_ID_PREFIX);

/** One colour for a pass, whatever the week's subjects: amber, the board's "needs action" family. */
export const PASS_COLOR = "#b45309";

const minutesOf = (timestamp: string) => {
  const date = new Date(timestamp);
  return date.getHours() * 60 + date.getMinutes();
};

/**
 * The passes as strips of the week's grid, on the reader's clock as the
 * lessons are (lib/lesson-mapper.ts), each one line (timetable-grid.tsx
 * `duty`; the amber edge says it is a pass, "Rastvakt" is the screen
 * reader's and the paper's). What a narrow column must keep comes first:
 *   - one taken as vikarie: the place, then "Vikarie" — where to go;
 *   - one the reader is relieved of: who has it — a vikarie, or nobody,
 *     never which person — then the place; drawn dashed, nothing to stand at;
 *   - their own: the place.
 * The skolområde is the room, after.
 */
export function weekPassesToGrid(
  passes: readonly WeekPass[],
  labels: { title: string; cover: string; handedOver: string; noCover: string },
): TimetableLesson[] {
  return passes.map((pass) => {
    const marker =
      pass.kind === "COVER"
        ? labels.cover
        : pass.handover === "SUBSTITUTE"
          ? labels.handedOver
          : pass.handover === "NO_COVER"
            ? labels.noCover
            : null;
    return {
      id: `${PASS_ID_PREFIX}${pass.kind}:${pass.shiftId}:${pass.date}`,
      dayOfWeek: isoWeekdayOf(pass.date),
      startMinutes: minutesOf(pass.startsAt),
      endMinutes: minutesOf(pass.endsAt),
      title: labels.title,
      subtitle:
        pass.kind === "COVER"
          ? `${pass.areaName} · ${marker}`
          : marker
            ? `${marker} · ${pass.areaName}`
            : pass.areaName,
      ...(pass.siteName ? { room: pass.siteName } : {}),
      color: PASS_COLOR,
      // A strip that opens nothing, and no length the grid is measured for.
      duty: true,
      ...(pass.kind === "OWN" && pass.handover !== null ? { relieved: true } : {}),
    };
  });
}
