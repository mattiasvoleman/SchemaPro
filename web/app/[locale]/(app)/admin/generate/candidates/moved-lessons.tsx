"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { MovedLesson, Slot } from "@/lib/candidates/moved";

/** Rows shown before the reader asks for the rest: enough to judge, few enough to read. */
const FIRST_ROWS = 25;

export interface MovedLessonsProps {
  moves: readonly MovedLesson[];
  /** The candidate's name, for the caption. */
  candidateName: string;
  names: {
    group: (id: string) => string;
    subject: (id: string) => string;
    room: (id: string) => string;
  };
}

/*
 * What a candidate changes, lesson by lesson: class, subject, from → to, and
 * the room. Every row says in words what kind of change it is ("Samma tid,
 * ny sal", "Ny lektion"); the badge is only a tint on top of the words.
 */
export function MovedLessons({ moves, candidateName, names }: MovedLessonsProps) {
  const t = useTranslations("scheduleCandidates");
  const tDays = useTranslations("days");
  const [all, setAll] = useState(false);

  // By class and subject as the school reads a timetable, then by where the
  // lesson was. moved.ts keeps clock order; the names are this page's.
  const sorted = useMemo(
    () =>
      [...moves].sort(
        (a, b) =>
          names.group(a.studentGroupId).localeCompare(names.group(b.studentGroupId), "sv") ||
          names.subject(a.subjectId).localeCompare(names.subject(b.subjectId), "sv"),
      ),
    [moves, names],
  );
  const shown = all ? sorted : sorted.slice(0, FIRST_ROWS);

  if (moves.length === 0) return <p className="text-sm text-foreground">{t("moved.none")}</p>;

  const slot = (value: Slot) =>
    t("moved.slot", { day: tDays(String(value.dayOfWeek)), start: value.startTime, end: value.endTime });
  const room = (id: string | null) => (id ? names.room(id) : t("moved.noRoom"));
  const roomText = (move: MovedLesson) => {
    const before = move.from ? room(move.from.roomId) : null;
    const after = move.to ? room(move.to.roomId) : null;
    if (before !== null && after !== null && before !== after) return `${before} → ${after}`;
    return after ?? before ?? "";
  };

  return (
    <div className="space-y-2">
      <Table>
        <caption className="caption-top pb-2 text-left text-sm text-muted-foreground">
          {t("moved.caption", { name: candidateName, count: moves.length })}
        </caption>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col">{t("moved.class")}</TableHead>
            <TableHead scope="col">{t("moved.subject")}</TableHead>
            <TableHead scope="col">{t("moved.from")}</TableHead>
            <TableHead scope="col">{t("moved.to")}</TableHead>
            <TableHead scope="col">{t("moved.room")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((move, index) => (
            <TableRow key={index}>
              <TableCell>{names.group(move.studentGroupId)}</TableCell>
              <TableCell>{names.subject(move.subjectId)}</TableCell>
              <TableCell className="whitespace-nowrap tabular-nums">
                {move.from ? slot(move.from) : <Badge variant="secondary">{t("moved.kindADDED")}</Badge>}
              </TableCell>
              <TableCell className="whitespace-nowrap tabular-nums">
                {move.kind === "ROOM" ? (
                  <Badge variant="secondary">{t("moved.kindROOM")}</Badge>
                ) : move.to ? (
                  slot(move.to)
                ) : (
                  <Badge variant="secondary">{t("moved.kindREMOVED")}</Badge>
                )}
              </TableCell>
              <TableCell>{roomText(move)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {sorted.length > FIRST_ROWS ? (
        // A toggle that stays where it is, so focus does not fall to the top
        // of the page when the rows it uncovers push it down.
        <Button variant="outline" size="sm" aria-expanded={all} onClick={() => setAll((value) => !value)}>
          {all ? t("moved.showFewer") : t("moved.showAll", { count: sorted.length })}
        </Button>
      ) : null}
    </div>
  );
}
