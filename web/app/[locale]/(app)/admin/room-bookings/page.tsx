"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Check, MapPin, Loader2, X } from "lucide-react";
import {
  useRoomBookingActions,
  useRoomBookingRequests,
  useRooms,
  usePeople,
} from "@/lib/queries";
import type { RoomBookingStatus } from "@/lib/types";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Filter = Extract<RoomBookingStatus, "PENDING" | "APPROVED" | "REJECTED">;

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export default function RoomBookingsPage() {
  const t = useTranslations("adminRoomBookings");
  const tStatus = useTranslations("roomBooking");
  const tCommon = useTranslations("common");
  const [filter, setFilter] = useState<Filter>("PENDING");
  const { data: bookings, isLoading } = useRoomBookingRequests(filter);
  const { data: rooms } = useRooms();
  const { data: people } = usePeople();
  const actions = useRoomBookingActions();
  const [notes, setNotes] = useState<Record<string, string>>({});

  const roomName = useMemo(() => {
    const byId = new Map((rooms ?? []).map((room) => [room.id, room.name]));
    return (id: string) => byId.get(id) ?? "—";
  }, [rooms]);

  const personName = useMemo(() => {
    const byId = new Map((people ?? []).map((person) => [person.id, person]));
    return (id: string) => {
      const person = byId.get(id);
      return person ? `${person.firstName} ${person.lastName}` : "—";
    };
  }, [people]);

  const decide = async (id: string, status: "APPROVED" | "REJECTED") => {
    try {
      await actions.decide.mutateAsync({
        id,
        status,
        note: notes[id]?.trim() || undefined,
      });
      toast.success(status === "APPROVED" ? t("approved") : t("rejected"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  return (
    <div>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <Tabs value={filter} onValueChange={(value) => setFilter(value as Filter)} className="mb-4">
        <TabsList>
          <TabsTrigger value="PENDING">{tStatus("statusPENDING")}</TabsTrigger>
          <TabsTrigger value="APPROVED">{tStatus("statusAPPROVED")}</TabsTrigger>
          <TabsTrigger value="REJECTED">{tStatus("statusREJECTED")}</TabsTrigger>
        </TabsList>
      </Tabs>

      {isLoading ? null : (bookings ?? []).length === 0 ? (
        <EmptyState icon={MapPin} title={tCommon("noResults")} description={t("empty")} />
      ) : (
        <div className="space-y-3">
          {(bookings ?? []).map((booking) => (
            <Card key={booking.id}>
              <CardContent className="pt-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium">
                      {roomName(booking.roomId)}
                      <span className="ml-2 text-sm text-muted-foreground">{booking.title}</span>
                    </div>
                    <p className="mt-1 text-sm tabular-nums text-muted-foreground">
                      {formatWhen(booking.startsAt)} – {formatWhen(booking.endsAt)}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("requestedBy", { name: personName(booking.bookedById) })} ·{" "}
                      {new Date(booking.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  {booking.status === "PENDING" ? (
                    <div className="flex flex-col items-end gap-2">
                      <Input
                        placeholder={t("notePlaceholder")}
                        className="h-8 w-64"
                        value={notes[booking.id] ?? ""}
                        onChange={(e) => setNotes({ ...notes, [booking.id]: e.target.value })}
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => void decide(booking.id, "APPROVED")}
                          disabled={actions.decide.isPending}
                        >
                          {actions.decide.isPending ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <Check />
                          )}
                          {t("approve")}
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => void decide(booking.id, "REJECTED")}
                          disabled={actions.decide.isPending}
                        >
                          <X />
                          {t("reject")}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Badge variant={booking.status === "APPROVED" ? "success" : "destructive"}>
                      {tStatus(`status${booking.status}`)}
                    </Badge>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
