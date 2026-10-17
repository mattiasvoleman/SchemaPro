"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { MapPin } from "lucide-react";
import {
  useRoomBookingActions,
  useRoomBookingRequests,
  useRooms,
  usePeople,
} from "@/lib/queries";
import { BOOKING_STATUS_VARIANT } from "@/lib/status-variants";
import type { RoomBookingStatus } from "@/lib/types";
import { DecisionList, type Decision, type DecisionRequest } from "@/components/admin/decision-list";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar } from "@/components/ui/filter-bar";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Filter = Extract<RoomBookingStatus, "PENDING" | "APPROVED" | "REJECTED">;

export default function RoomBookingsPage() {
  const t = useTranslations("adminRoomBookings");
  const tStatus = useTranslations("roomBooking");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const [filter, setFilter] = useState<Filter>("PENDING");
  const { data: bookings, isLoading, isError } = useRoomBookingRequests(filter);
  const roomsQuery = useRooms();
  const peopleQuery = usePeople();
  const actions = useRoomBookingActions();
  const namesFailed = roomsQuery.isError || peopleQuery.isError;

  const roomName = useMemo(() => {
    const byId = new Map((roomsQuery.data ?? []).map((room) => [room.id, room.name]));
    return (id: string) => byId.get(id) ?? "—";
  }, [roomsQuery.data]);

  const personName = useMemo(() => {
    const byId = new Map((peopleQuery.data ?? []).map((person) => [person.id, person]));
    return (id: string) => {
      const person = byId.get(id);
      return person ? `${person.firstName} ${person.lastName}` : "—";
    };
  }, [peopleQuery.data]);

  const when = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }), [locale]);
  const day = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }), [locale]);

  const decide = async (id: string, status: Decision, note: string | undefined) => {
    try {
      await actions.decide.mutateAsync({ id, status, note });
      toast.success(status === "APPROVED" ? t("approved") : t("rejected"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const requests: DecisionRequest[] = (bookings ?? []).map((booking) => {
    const room = roomName(booking.roomId);
    const period = when.formatRange(new Date(booking.startsAt), new Date(booking.endsAt));
    return {
      id: booking.id,
      title: (
        <>
          {room}{" "}
          <span className="ml-1 font-normal text-muted-foreground">{booking.title}</span>
        </>
      ),
      name: `${room}, ${period}`,
      details: [
        <span key="when" className="tabular-nums">
          {period}
        </span>,
        <span key="who" className="text-xs">
          {t("requestedBy", { name: personName(booking.bookedById) })} · {day.format(new Date(booking.createdAt))}
        </span>,
      ],
      open: booking.status === "PENDING",
      status: { label: tStatus(`status${booking.status}`), variant: BOOKING_STATUS_VARIANT[booking.status] },
    };
  });

  return (
    <Page>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <FilterBar>
        <Tabs value={filter} onValueChange={(value) => setFilter(value as Filter)}>
          <TabsList aria-label={t("filterLabel")}>
            <TabsTrigger value="PENDING">{tStatus("statusPENDING")}</TabsTrigger>
            <TabsTrigger value="APPROVED">{tStatus("statusAPPROVED")}</TabsTrigger>
            <TabsTrigger value="REJECTED">{tStatus("statusREJECTED")}</TabsTrigger>
          </TabsList>
        </Tabs>
      </FilterBar>

      {namesFailed ? <LoadError variant="inline" title={t("namesFailed")} hint={t("namesFailedHint")} /> : null}

      {isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : isError ? (
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
      ) : requests.length === 0 ? (
        <EmptyState
          icon={MapPin}
          title={t("emptyTitle", { status: filter })}
          description={t("emptyHint")}
          headingLevel={2}
        />
      ) : (
        <DecisionList
          id="room-booking-requests"
          title={t("listTitle", { status: filter })}
          requests={requests}
          labels={{ approve: t("approve"), reject: t("reject"), note: t("noteLabel") }}
          rejectCopy={(request) => {
            const booking = bookings?.find((candidate) => candidate.id === request.id);
            return {
              title: t("rejectTitle", { room: booking ? roomName(booking.roomId) : "—" }),
              body: t("rejectBody"),
            };
          }}
          deciding={actions.decide.isPending ? (actions.decide.variables?.id ?? null) : null}
          onDecide={decide}
          writes="DRIFT"
        />
      )}
    </Page>
  );
}
