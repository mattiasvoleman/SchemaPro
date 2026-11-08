"use client";

import { useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Boxes } from "lucide-react";
import { DecisionList, type Decision, type DecisionRequest } from "@/components/admin/decision-list";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { useResourceBookingActions, useResourceBookings } from "@/lib/local-queries";
import { BOOKING_STATUS_VARIANT } from "@/lib/status-variants";
import type { RoomBookingStatus } from "@/lib/types";

/**
 * The bookings of resources, in the list Lokalbokningar draws for the rooms:
 * the same states, the same decision and note, through /resource-bookings.
 * Fetched when the Resurser tab is first opened, so a visit to the rooms pays
 * for none of it.
 *
 * A day of an external hire (`external`) is a booking with no booker and no
 * request: it is listed under Godkända and decided by nobody.
 */
export default function ResourceRequests({ filter }: { filter: Extract<RoomBookingStatus, "PENDING" | "APPROVED" | "REJECTED"> }) {
  const t = useTranslations("adminRoomBookings");
  const tStatus = useTranslations("roomBooking");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const { data: bookings, isLoading, isError } = useResourceBookings(filter);
  const actions = useResourceBookingActions();

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
    const period = when.formatRange(new Date(booking.startsAt), new Date(booking.endsAt));
    return {
      id: booking.id,
      title: (
        <>
          {booking.resourceName}
          {booking.quantity > 1 ? ` × ${booking.quantity}` : ""}{" "}
          <span className="ml-1 font-normal text-muted-foreground">{booking.title}</span>
        </>
      ),
      name: `${booking.resourceName}, ${period}`,
      details: [
        <span key="when" className="tabular-nums">
          {period}
        </span>,
        <span key="who" className="text-xs">
          {booking.external ? t("externalDay") : t("requestedBy", { name: booking.bookedByName ?? "—" })} ·{" "}
          {day.format(new Date(booking.createdAt))}
        </span>,
      ],
      open: booking.status === "PENDING" && !booking.external,
      status: { label: tStatus(`status${booking.status}`), variant: BOOKING_STATUS_VARIANT[booking.status] },
    };
  });

  return isLoading ? (
    <div aria-busy="true">
      <Skeleton className="h-64 w-full" />
    </div>
  ) : isError ? (
    <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
  ) : requests.length === 0 ? (
    <EmptyState icon={Boxes} title={t("emptyTitle", { status: filter })} description={t("resourceEmptyHint")} headingLevel={2} />
  ) : (
    <DecisionList
      id="resource-booking-requests"
      title={t("listTitle", { status: filter })}
      requests={requests}
      labels={{ approve: t("approve"), reject: t("reject"), note: t("noteLabel") }}
      rejectCopy={(request) => {
        const booking = bookings?.find((candidate) => candidate.id === request.id);
        return { title: t("rejectTitle", { room: booking?.resourceName ?? "—" }), body: t("rejectBody") };
      }}
      deciding={actions.decide.isPending ? (actions.decide.variables?.id ?? null) : null}
      onDecide={decide}
      writes="DRIFT"
    />
  );
}
