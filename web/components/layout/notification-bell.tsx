"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { Bell, CheckCheck } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/utils/supabase/client";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { Link } from "@/i18n/navigation";

interface NotificationRow {
  id: string;
  type:
    | "ABSENCE_UNREPORTED"
    | "LEAVE_DECIDED"
    | "LESSON_CANCELLED"
    | "LESSON_SUBSTITUTE"
    | "LESSON_ROOM_CHANGED"
    | "SCHEDULE_CHANGED"
    | "ROOM_BOOKING_DECIDED"
    | "TEACHER_ABSENCE_REPORTED"
    | "LESSON_COVER_WITHDRAWN";
  meta: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

/** In-app notification inbox. Reads own rows under RLS; marking read is a
 * single own-row column update, also RLS-guarded. Polls every 60s. */
export function NotificationBell() {
  const t = useTranslations("notifications");
  const queryClient = useQueryClient();

  const { data: notifications } = useQuery({
    queryKey: ["notifications"],
    refetchInterval: 60_000,
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("Notifications")
        .select("id, type, meta, readAt, createdAt")
        .order("createdAt", { ascending: false })
        .limit(20);
      if (error) throw new Error(error.message);
      return (data ?? []) as NotificationRow[];
    },
  });

  const markAllRead = useMutation({
    mutationFn: async () => {
      const supabase = createClient();
      const { error } = await supabase
        .from("Notifications")
        .update({ readAt: new Date().toISOString() })
        .is("readAt", null);
      if (error) throw new Error(error.message);
    },
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const unread = useMemo(
    () => (notifications ?? []).filter((entry) => entry.readAt === null).length,
    [notifications],
  );

  const render = (entry: NotificationRow): string => {
    const meta = entry.meta ?? {};
    const str = (key: string) => String(meta[key] ?? "");
    switch (entry.type) {
      case "ABSENCE_UNREPORTED":
        return t("absenceUnreported", {
          student: str("studentName"),
          subject: str("subjectName"),
          date: str("date"),
        });
      case "LEAVE_DECIDED":
        return t(
          str("status") === "APPROVED" ? "leaveApproved" : "leaveRejected",
          { student: str("studentName"), from: str("startDate"), to: str("endDate") },
        );
      case "LESSON_CANCELLED":
        return t("lessonCancelled", {
          subject: str("subjectName"),
          when: new Date(str("startsAt")).toLocaleString(),
        });
      case "LESSON_SUBSTITUTE":
      case "LESSON_COVER_WITHDRAWN": {
        // The substitute's own notice (`cover: true`) and its withdrawal name
        // the group and room; neither says whom they replace, or why.
        const when = new Date(str("startsAt")).toLocaleString();
        const own = { subject: str("subjectName"), when, group: str("groupName"), room: str("roomName") };
        if (entry.type === "LESSON_COVER_WITHDRAWN") return t("lessonCoverWithdrawn", own);
        return meta.cover === true ? t("lessonSubstituteCover", own) : t("lessonSubstitute", { subject: own.subject, when });
      }
      case "TEACHER_ABSENCE_REPORTED": {
        // Who and when; the reason is never in a notice. Whole days end at
        // the midnight after the last day, which is said as that last day.
        const days = meta.wholeDays === true;
        const at = (iso: string, end: boolean) =>
          days ? new Date(Date.parse(iso) - (end ? 1 : 0)).toLocaleDateString() : new Date(iso).toLocaleString();
        const from = at(str("startsAt"), false);
        const to = at(str("endsAt"), true);
        return t("teacherAbsenceReported", { teacher: str("teacherName") || "—", period: from === to ? from : `${from} – ${to}` });
      }
      case "LESSON_ROOM_CHANGED":
        return t("lessonRoomChanged", {
          subject: str("subjectName"),
          when: new Date(str("startsAt")).toLocaleString(),
        });
      case "SCHEDULE_CHANGED":
        return t("scheduleChanged", { subject: str("subjectName") });
      case "ROOM_BOOKING_DECIDED":
        return t(
          str("status") === "APPROVED" ? "roomBookingApproved" : "roomBookingRejected",
          { room: str("roomName"), when: new Date(str("startsAt")).toLocaleString() },
        );
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={t("title")}>
          <Bell />
          {unread > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
              {unread > 9 ? "9+" : unread}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-96 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-semibold">{t("title")}</span>
          {unread > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => markAllRead.mutate()}
              disabled={markAllRead.isPending}
            >
              <CheckCheck className="h-3.5 w-3.5" />
              {t("markAllRead")}
            </Button>
          ) : null}
        </div>
        <div className="max-h-96 overflow-y-auto">
          {(notifications ?? []).length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {t("empty")}
            </p>
          ) : (
            (notifications ?? []).map((entry) => (
              <div
                key={entry.id}
                className={cn(
                  "border-b px-3 py-2.5 text-sm last:border-b-0",
                  entry.readAt === null && "bg-accent/40",
                )}
              >
                <p>{render(entry)}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {new Date(entry.createdAt).toLocaleString()}
                </p>
              </div>
            ))
          )}
        </div>
        {/* What leaves SchemaPro as e-mail and push, chosen per type. The
            shell already carries next-intl's Link, so this costs no module;
            no icon, because every route pays for what the bell carries. */}
        <div className="border-t px-3 py-2">
          <Link href="/notifications" className="text-xs font-medium text-primary hover:underline">
            {t("settingsLink")}
          </Link>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
