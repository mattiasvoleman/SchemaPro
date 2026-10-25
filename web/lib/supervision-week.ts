"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
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

export function useSupervisionWeek(from: string, to: string) {
  return useQuery({
    queryKey: ["supervisionWeek", from, to],
    retry: false,
    queryFn: () => api.get<{ from: string; to: string; passes: WeekPass[] }>(`/api/v1/supervision/week?from=${from}&to=${to}`),
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
 * The passes as blocks of the week's grid, on the reader's clock as the
 * lessons are (lib/lesson-mapper.ts): "Rastvakt" over the area, and the
 * skolområde as the room. A pass taken as vikarie says so under the area, as
 * a covered lesson says "Vikarie"; one the reader is relieved of says who has
 * it — a vikarie, or nobody — never which person.
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
      subtitle: marker ? `${pass.areaName} · ${marker}` : pass.areaName,
      ...(pass.siteName ? { room: pass.siteName } : {}),
      color: PASS_COLOR,
    };
  });
}
