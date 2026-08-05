"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Check, Clock, Loader2, MapPin } from "lucide-react";
import { useProfile } from "@/components/profile-context";
import {
  useCalendarLessons,
  useMyRoomBookings,
  useRoomBookingActions,
  useRoomBookings,
  useRooms,
} from "@/lib/queries";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

function toDateInput(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default function TeacherRoomsPage() {
  const t = useTranslations("teacherRooms");
  const tStatus = useTranslations("roomBooking");
  const tCommon = useTranslations("common");
  const { profile } = useProfile();

  const today = toDateInput(new Date());
  const [date, setDate] = useState(today);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("10:00");
  const [title, setTitle] = useState("");

  const { data: rooms } = useRooms();
  const { data: lessons } = useCalendarLessons(date, date);
  const { data: bookings } = useRoomBookings(date, date);
  const { data: myBookings, isLoading: myLoading } = useMyRoomBookings(profile.id);
  const actions = useRoomBookingActions();

  const roomById = useMemo(
    () => new Map((rooms ?? []).map((room) => [room.id, room])),
    [rooms],
  );

  const windowStart = useMemo(() => {
    const d = new Date(`${date}T${start}:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }, [date, start]);
  const windowEnd = useMemo(() => {
    const d = new Date(`${date}T${end}:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }, [date, end]);

  const validWindow = windowStart !== null && windowEnd !== null && windowEnd > windowStart;

  // Rooms with no scheduled lesson and no active booking overlapping the window.
  const freeRooms = useMemo(() => {
    if (!validWindow || !rooms) return [];
    const ws = windowStart!.getTime();
    const we = windowEnd!.getTime();
    const busyRoomIds = new Set<string>();
    for (const lesson of lessons ?? []) {
      if (lesson.status !== "SCHEDULED" || !lesson.roomId) continue;
      if (overlaps(ws, we, Date.parse(lesson.startsAt), Date.parse(lesson.endsAt))) {
        busyRoomIds.add(lesson.roomId);
      }
    }
    for (const booking of bookings ?? []) {
      if (booking.status !== "PENDING" && booking.status !== "APPROVED") continue;
      if (overlaps(ws, we, Date.parse(booking.startsAt), Date.parse(booking.endsAt))) {
        busyRoomIds.add(booking.roomId);
      }
    }
    return rooms.filter((room) => !busyRoomIds.has(room.id));
  }, [rooms, lessons, bookings, validWindow, windowStart, windowEnd]);

  const book = async (roomId: string) => {
    if (!validWindow) return;
    const room = roomById.get(roomId);
    try {
      await actions.book.mutateAsync({
        roomId,
        title: title.trim() || t("defaultTitle"),
        startsAt: windowStart!.toISOString(),
        endsAt: windowEnd!.toISOString(),
      });
      toast.success(room?.requiresApproval ? t("requestedToast") : t("bookedToast"));
      setTitle("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const cancel = async (id: string) => {
    try {
      await actions.cancel.mutateAsync(id);
      toast.success(t("cancelledToast"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const statusVariant = (status: string) =>
    status === "APPROVED"
      ? "success"
      : status === "PENDING"
        ? "secondary"
        : "destructive";

  return (
    <div>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <Card className="mb-6">
        <CardContent className="space-y-4 pt-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="book-date">{tCommon("date")}</Label>
              <Input
                id="book-date"
                type="date"
                className="w-40"
                value={date}
                min={today}
                onChange={(e) => e.target.value && setDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="book-start">{t("from")}</Label>
              <Input
                id="book-start"
                type="time"
                className="w-32"
                value={start}
                onChange={(e) => e.target.value && setStart(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="book-end">{t("to")}</Label>
              <Input
                id="book-end"
                type="time"
                className="w-32"
                value={end}
                onChange={(e) => e.target.value && setEnd(e.target.value)}
              />
            </div>
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="book-title">{t("purpose")}</Label>
              <Input
                id="book-title"
                value={title}
                placeholder={t("purposePlaceholder")}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
          </div>
          {!validWindow ? (
            <p className="text-sm text-destructive">{t("invalidWindow")}</p>
          ) : null}
        </CardContent>
      </Card>

      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
        <Clock className="h-4 w-4" />
        {t("freeRooms")}
      </h2>
      {!validWindow ? null : freeRooms.length === 0 ? (
        <EmptyState icon={MapPin} title={t("noneFreeTitle")} description={t("noneFreeBody")} />
      ) : (
        <div className="mb-8 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {freeRooms.map((room) => (
            <div
              key={room.id}
              className="flex items-center justify-between rounded-lg border bg-card px-3 py-2.5"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 font-medium">
                  <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
                  {room.name}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  {room.capacity ? <span>{t("seats", { count: room.capacity })}</span> : null}
                  {room.requiresApproval ? (
                    <Badge variant="secondary">{t("approvalRequired")}</Badge>
                  ) : null}
                </div>
              </div>
              <Button size="sm" onClick={() => book(room.id)} disabled={actions.book.isPending}>
                {actions.book.isPending ? <Loader2 className="animate-spin" /> : <Check />}
                {t("book")}
              </Button>
            </div>
          ))}
        </div>
      )}

      <h2 className="mb-2 text-sm font-semibold text-muted-foreground">{t("myBookings")}</h2>
      {myLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : (myBookings ?? []).length === 0 ? (
        <EmptyState icon={MapPin} title={tCommon("noResults")} description={t("noBookings")} />
      ) : (
        <div className="space-y-2">
          {(myBookings ?? []).map((booking) => {
            const room = roomById.get(booking.roomId);
            const active =
              (booking.status === "APPROVED" || booking.status === "PENDING") &&
              Date.parse(booking.endsAt) > Date.now();
            return (
              <Card key={booking.id}>
                <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <div className="font-medium">
                      {room?.name ?? "—"}
                      <span className="ml-2 text-sm text-muted-foreground">{booking.title}</span>
                    </div>
                    <div className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                      {formatWhen(booking.startsAt)} – {formatWhen(booking.endsAt)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={statusVariant(booking.status)}>
                      {tStatus(`status${booking.status}`)}
                    </Badge>
                    {active ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => cancel(booking.id)}
                        disabled={actions.cancel.isPending}
                      >
                        {t("cancel")}
                      </Button>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
