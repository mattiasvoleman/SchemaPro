"use client";

/*
 * Skrivsalar: the rooms the school lets exams be written in, and how many
 * seats an exam has in each. Every room of the school is listed (the gateway
 * answers all of them, seats null for one that is not a skrivsal); the room's
 * own capacity is the suggestion for the seats, since a classroom's capacity
 * is usually the number of desks and an exam sits further apart.
 *
 * The gateway answers every write with the whole list, which replaces the
 * cached one, so a row never shows a state the gateway did not give.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { validSeats } from "@/lib/exam-form";
import type { ExamRoom } from "@/lib/exam-types";
import { useReadOnly } from "@/components/profile-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCard } from "@/components/ui/table-card";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useErrorText } from "./exam-format";
import { useExamRooms, useMarkRoom, useUnmarkRoom } from "./use-exams";

export function ExamRoomsCard() {
  const t = useTranslations("exams");
  const tCommon = useTranslations("common");
  const readOnly = useReadOnly();
  const errorText = useErrorText();
  const rooms = useExamRooms();
  const mark = useMarkRoom();
  const unmark = useUnmarkRoom();
  // What is typed in a row, by room; a row not typed in shows the seats it has, else its capacity.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const busy = mark.isPending || unmark.isPending;

  const shown = (room: ExamRoom): string => drafts[room.roomId] ?? String(room.seats ?? room.capacity ?? "");
  const forget = (roomId: string) =>
    setDrafts((previous) => {
      const next = { ...previous };
      delete next[roomId];
      return next;
    });

  const doMark = async (room: ExamRoom) => {
    try {
      await mark.mutateAsync({ roomId: room.roomId, seats: Number(shown(room)) });
      forget(room.roomId);
      toast.success(t(room.seats === null ? "roomMarked" : "roomSeatsSaved", { name: room.name }));
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  const doUnmark = async (room: ExamRoom) => {
    try {
      await unmark.mutateAsync(room.roomId);
      forget(room.roomId);
      toast.success(t("roomUnmarked", { name: room.name }));
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  return (
    <SectionCard id="exam-rooms" title={t("roomsTitle")} description={t("roomsIntro")}>
      {rooms.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-32 w-full" />
        </div>
      ) : rooms.isError ? (
        <LoadError variant="inline" title={t("roomsLoadFailed")} hint={t("loadFailedHint")} />
      ) : !rooms.data || rooms.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("roomsNone")}{" "}
          <Link href="/admin/rooms" className="font-medium underline underline-offset-4">
            {t("goToRooms")}
          </Link>
        </p>
      ) : (
        <TableCard caption={t("roomsCaption")}>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t("roomName")}</TableHead>
              <TableHead scope="col">{tCommon("capacity")}</TableHead>
              <TableHead scope="col">{t("roomSeats")}</TableHead>
              {readOnly ? null : (
                <TableHead scope="col">
                  <span className="sr-only">{tCommon("actions")}</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rooms.data.map((room) => {
              const marked = room.seats !== null;
              const typed = shown(room);
              const working = busy && (mark.variables?.roomId === room.roomId || unmark.variables === room.roomId);
              return (
                <TableRow key={room.roomId}>
                  <TableCell className="font-medium">
                    {room.name}
                    {room.code ? <span className="block text-xs font-normal text-muted-foreground">{room.code}</span> : null}
                  </TableCell>
                  <TableCell className="tabular-nums">{room.capacity ?? "–"}</TableCell>
                  <TableCell className="tabular-nums">
                    {readOnly ? (
                      marked ? (
                        <Badge variant="secondary">{t("roomSeatsBadge", { seats: room.seats ?? 0 })}</Badge>
                      ) : (
                        "–"
                      )
                    ) : (
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={2000}
                        className="w-28"
                        aria-label={t("roomSeatsFor", { name: room.name })}
                        aria-invalid={typed !== "" && !validSeats(typed) ? true : undefined}
                        value={typed}
                        onChange={(event) => setDrafts((previous) => ({ ...previous, [room.roomId]: event.target.value }))}
                      />
                    )}
                  </TableCell>
                  {readOnly ? null : (
                    <TableCell className="text-right">
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button
                          variant={marked ? "outline" : "default"}
                          size="sm"
                          data-writes="DRIFT"
                          aria-label={tCommon("actionNamed", { action: marked ? tCommon("save") : t("roomMark"), name: room.name })}
                          disabled={busy || !validSeats(typed) || (marked && Number(typed) === room.seats)}
                          onClick={() => void doMark(room)}
                        >
                          {working && mark.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
                          {marked ? tCommon("save") : t("roomMark")}
                        </Button>
                        {marked ? (
                          <Button
                            variant="outline"
                            size="sm"
                            data-writes="DRIFT"
                            aria-label={tCommon("actionNamed", { action: t("roomUnmark"), name: room.name })}
                            disabled={busy}
                            onClick={() => void doUnmark(room)}
                          >
                            {working && unmark.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
                            {t("roomUnmark")}
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </TableCard>
      )}
    </SectionCard>
  );
}
