"use client";

import { lazy, Suspense, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
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
import { BOOKING_STATUS_VARIANT } from "@/lib/status-variants";
import type { RoomBooking } from "@/lib/types";
import { toDateString } from "@/lib/utils";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { DialogLoadBoundary } from "@/components/schedule/dialog-load-boundary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { FilterBar, FilterField } from "@/components/ui/filter-bar";
import { Input } from "@/components/ui/input";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";

/*
 * The cancel confirmation, fetched on its first open: this route is in the
 * core tier and Radix Dialog is in none of its chunks, while most visits only
 * book. A chunk that does not arrive is said in a toast, and the next open
 * fetches afresh.
 */
const lazyConfirmDialog = () =>
  lazy(() => import("@/components/ui/confirm-dialog").then((module) => ({ default: module.ConfirmDialog })));
let ConfirmDialog = lazyConfirmDialog();

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export default function TeacherRoomsPage() {
  const t = useTranslations("teacherRooms");
  const tStatus = useTranslations("roomBooking");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const { profile } = useProfile();

  // The reader's own day, not UTC's: before 02:00 in Sweden UTC is still
  // yesterday, and the date field would offer a day that has passed.
  const today = toDateString(new Date());
  const [date, setDate] = useState(today);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("10:00");
  const [title, setTitle] = useState("");
  const [bookingRoomId, setBookingRoomId] = useState<string | null>(null);
  // The booking the confirmation is about stays set while the dialog closes,
  // so its title does not empty under the fade.
  const [cancelling, setCancelling] = useState<RoomBooking | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmUsed, setConfirmUsed] = useState(false);
  const [confirmLoad, setConfirmLoad] = useState(0);

  const roomsQuery = useRooms();
  const lessonsQuery = useCalendarLessons(date, date);
  const bookingsQuery = useRoomBookings(date, date);
  const myBookingsQuery = useMyRoomBookings(profile.id);
  const actions = useRoomBookingActions();
  const rooms = roomsQuery.data;
  const lessons = lessonsQuery.data;
  const bookings = bookingsQuery.data;
  const myBookings = myBookingsQuery.data ?? [];

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

  // Which rooms are free is only known once the rooms, the day's lessons and
  // the day's bookings have all arrived: until then every room would look
  // free, and after a failed read a busy one would.
  const freeLoading = roomsQuery.isLoading || lessonsQuery.isLoading || bookingsQuery.isLoading;
  const freeFailed = roomsQuery.isError || lessonsQuery.isError || bookingsQuery.isError;

  const tag = locale === "en" ? "en-GB" : "sv-SE";
  const when = useMemo(() => new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeStyle: "short" }), [tag]);
  const whenText = (booking: RoomBooking) =>
    when.formatRange(new Date(booking.startsAt), new Date(booking.endsAt));

  const book = async (roomId: string) => {
    if (!validWindow) return;
    const room = roomById.get(roomId);
    setBookingRoomId(roomId);
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
    } finally {
      setBookingRoomId(null);
    }
  };

  const cancel = async (id: string) => {
    try {
      await actions.cancel.mutateAsync(id);
      toast.success(t("cancelledToast"));
      setConfirmOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const askCancel = (booking: RoomBooking) => {
    setConfirmUsed(true);
    setCancelling(booking);
    setConfirmOpen(true);
  };

  const roomName = (roomId: string) => roomById.get(roomId)?.name ?? "—";

  return (
    <Page>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <FilterBar>
        <FilterField id="book-date" label={tCommon("date")}>
          <DateField
            label={tCommon("date")}
            id="book-date"
            className="w-40"
            value={date}
            min={today}
            onChange={(value) => value && setDate(value)}
          />
        </FilterField>
        <FilterField id="book-start" label={t("from")}>
          <Input
            id="book-start"
            type="time"
            className="w-32 tabular-nums"
            value={start}
            onChange={(e) => e.target.value && setStart(e.target.value)}
          />
        </FilterField>
        <FilterField id="book-end" label={t("to")}>
          <Input
            id="book-end"
            type="time"
            className="w-32 tabular-nums"
            value={end}
            aria-invalid={!validWindow || undefined}
            aria-describedby={!validWindow ? "book-window-error" : undefined}
            onChange={(e) => e.target.value && setEnd(e.target.value)}
          />
        </FilterField>
        <FilterField id="book-title" label={t("purpose")} className="min-w-48 flex-1">
          <Input
            id="book-title"
            value={title}
            placeholder={t("purposePlaceholder")}
            onChange={(e) => setTitle(e.target.value)}
          />
        </FilterField>
      </FilterBar>
      {!validWindow ? (
        <p id="book-window-error" role="alert" className="text-sm text-destructive">
          {t("invalidWindow")}
        </p>
      ) : null}

      <SectionCard id="free-rooms" title={t("freeRooms")} icon={Clock}>
        {!validWindow ? (
          <p className="text-sm text-muted-foreground">{t("freeRoomsNeedWindow")}</p>
        ) : freeLoading ? (
          <div aria-busy="true">
            <Skeleton className="h-24 w-full" />
          </div>
        ) : freeFailed ? (
          <LoadError variant="inline" title={t("loadFailed")} hint={t("loadFailedHint")} />
        ) : (rooms ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noRooms")}</p>
        ) : freeRooms.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noneFreeBody")}</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {freeRooms.map((room) => (
              <li
                key={room.id}
                className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5"
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="flex items-center gap-1.5 font-medium">
                    <MapPin className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    {room.name}
                  </p>
                  {room.capacity || room.requiresApproval ? (
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      {room.capacity ? <span>{t("seats", { count: room.capacity })}</span> : null}
                      {room.requiresApproval ? (
                        <Badge variant="secondary">{t("approvalRequired")}</Badge>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {/* Outline: a filled Boka on every free room was a row of primaries,
                    none of them the page's one next step. */}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void book(room.id)}
                  disabled={actions.book.isPending}
                  aria-label={tCommon("actionNamed", { action: t("book"), name: room.name })}
                >
                  {bookingRoomId === room.id ? (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Check aria-hidden="true" />
                  )}
                  {t("book")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard id="my-bookings" title={t("myBookings")}>
        {myBookingsQuery.isLoading ? (
          <div aria-busy="true">
            <Skeleton className="h-16 w-full" />
          </div>
        ) : myBookingsQuery.isError ? (
          <LoadError variant="inline" title={t("bookingsLoadFailed")} hint={t("bookingsLoadFailedHint")} />
        ) : myBookings.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noBookings")}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {myBookings.map((booking) => {
              const active =
                (booking.status === "APPROVED" || booking.status === "PENDING") &&
                Date.parse(booking.endsAt) > Date.now();
              return (
                <li
                  key={booking.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-sm"
                >
                  <div className="min-w-0 space-y-0.5">
                    <p>
                      <span className="font-medium">{roomName(booking.roomId)}</span>{" "}
                      <span className="text-muted-foreground">{booking.title}</span>
                    </p>
                    <p className="text-xs tabular-nums text-muted-foreground">{whenText(booking)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={BOOKING_STATUS_VARIANT[booking.status]}>
                      {tStatus(`status${booking.status}`)}
                    </Badge>
                    {active ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => askCancel(booking)}
                        disabled={actions.cancel.isPending}
                        aria-label={tCommon("actionNamed", {
                          action: t("cancel"),
                          name: `${roomName(booking.roomId)} ${whenText(booking)}`,
                        })}
                      >
                        {t("cancel")}
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      {confirmUsed ? (
        <DialogLoadBoundary
          key={confirmLoad}
          onError={() => {
            // A chunk that failed to load says so in the reader's language;
            // the error's own text is English and technical.
            toast.error(tCommon("confirmLoadFailed"));
            ConfirmDialog = lazyConfirmDialog();
            setConfirmOpen(false);
            setConfirmUsed(false);
            setConfirmLoad((attempt) => attempt + 1);
          }}
        >
          <Suspense fallback={null}>
            <ConfirmDialog
              open={confirmOpen}
              onOpenChange={setConfirmOpen}
              title={
                cancelling
                  ? t("cancelTitle", { room: roomName(cancelling.roomId), when: whenText(cancelling) })
                  : ""
              }
              description={t("cancelBody")}
              confirmLabel={t("cancel")}
              loading={actions.cancel.isPending}
              onConfirm={() => {
                if (cancelling) void cancel(cancelling.id);
              }}
            />
          </Suspense>
        </DialogLoadBoundary>
      ) : null}
    </Page>
  );
}
