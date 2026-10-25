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
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { Link } from "@/i18n/navigation";
import { useProfile } from "@/components/profile-context";

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
    | "LESSON_COVER_WITHDRAWN"
    | "LESSON_REINSTATED"
    | "LESSON_SUPERVISED_STUDY"
    | "CANCELLATION_DIGEST"
    | "LEAVE_REQUESTED"
    | "SUPERVISION_COVER"
    | "SUPERVISION_COVER_WITHDRAWN";
  meta: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

/** In-app notification inbox. Reads the signed-in person's own rows: RLS
 * alone does not, since an admin's notifications_admin_select reaches every
 * notice of the school, so both the read and the write name the recipient.
 * Marking read is a single own-row column update, also RLS-guarded. Polls
 * every 60s. */
/** The newest notices the bell reads. A full page may hide more unread behind it. */
const NOTICE_LIMIT = 20;

export function NotificationBell() {
  const t = useTranslations("notifications");
  const queryClient = useQueryClient();
  const { profile } = useProfile();

  const { data: notifications } = useQuery({
    queryKey: ["notifications"],
    refetchInterval: 60_000,
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("Notifications")
        .select("id, type, meta, readAt, createdAt")
        .eq("userId", profile.id)
        .order("createdAt", { ascending: false })
        .limit(NOTICE_LIMIT);
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
        .eq("userId", profile.id)
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
      case "LEAVE_DECIDED": {
        // A mentor's decision says so (20261023091000); an older notice has no decidedAs.
        const approved = str("status") === "APPROVED";
        const byMentor = meta.decidedAs === "MENTOR";
        const key = byMentor
          ? approved ? "leaveApprovedByMentor" : "leaveRejectedByMentor"
          : approved ? "leaveApproved" : "leaveRejected";
        return t(key, { student: str("studentName"), from: str("startDate"), to: str("endDate") });
      }
      case "LEAVE_REQUESTED":
        // To the mentor who decides it: the pupil and the days, never the reason.
        return t("leaveRequested", {
          student: str("studentName"),
          from: str("startDate"),
          to: str("endDate"),
          days: Number(meta.schoolDays ?? 0),
        });
      case "LESSON_CANCELLED":
        return t("lessonCancelled", {
          subject: str("subjectName"),
          when: new Date(str("startsAt")).toLocaleString(),
        });
      case "LESSON_REINSTATED":
        return t("lessonReinstated", {
          subject: str("subjectName"),
          when: new Date(str("startsAt")).toLocaleString(),
        });
      case "LESSON_SUPERVISED_STUDY":
        return t("lessonSupervisedStudy", {
          subject: str("subjectName"),
          when: new Date(str("startsAt")).toLocaleString(),
        });
      case "CANCELLATION_DIGEST": {
        // One per person per avbokning: how many of their lessons, and the
        // days; the reversal says they go ahead after all.
        const from = str("startDate");
        const to = str("endDate");
        const values = {
          name: str("name"),
          count: Number(meta.lessonCount ?? 0),
          span: from === to ? from : `${from} – ${to}`,
        };
        return t(meta.reversed === true ? "cancellationDigestReversed" : "cancellationDigest", values);
      }
      case "LESSON_SUBSTITUTE":
      case "LESSON_COVER_WITHDRAWN": {
        // The substitute's own notice (`cover: true`) and its withdrawal name
        // the group and room; neither says whom they replace, or why.
        const when = new Date(str("startsAt")).toLocaleString();
        const own = { subject: str("subjectName"), when, group: str("groupName"), room: str("roomName") };
        if (entry.type === "LESSON_COVER_WITHDRAWN") return t("lessonCoverWithdrawn", own);
        return meta.cover === true ? t("lessonSubstituteCover", own) : t("lessonSubstitute", { subject: own.subject, when });
      }
      case "SUPERVISION_COVER":
      case "SUPERVISION_COVER_WITHDRAWN": {
        // A rastvaktspass the reader takes as vikarie (Rastvakt i vardagen):
        // the place and the time, never whose pass it is or why.
        const clock = { hour: "2-digit", minute: "2-digit" } as const;
        const pass = {
          area: str("areaName"),
          when: new Date(str("startsAt")).toLocaleString([], { dateStyle: "short", timeStyle: "short" }),
          end: new Date(str("endsAt")).toLocaleTimeString([], clock),
        };
        return t(entry.type === "SUPERVISION_COVER" ? "supervisionCover" : "supervisionCoverWithdrawn", pass);
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
      default:
        // A type added after this build (the gateway's enum grows first): a
        // notice, said as one, rather than an empty line in the list.
        return t("fallback");
    }
  };

  return (
    <DropdownMenu>
      {/* The name carries the count: the badge is drawn for the eye, and an
          aria-label replaces the button's content, so a screen reader heard
          "Notiser" with three unread waiting. */}
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={
            unread === 0
              ? t("title")
              : // A full page of notices may have more unread behind it: the
                // name says "minst", as the badge says 9+ rather than a number.
                (notifications ?? []).length >= NOTICE_LIMIT
                ? t("titleUnreadAtLeast", { count: unread })
                : t("titleUnread", { count: unread })
          }
        >
          <Bell />
          {unread > 0 ? (
            <span
              aria-hidden="true"
              className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground"
            >
              {unread > 9 ? "9+" : unread}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-96 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-semibold">{t("title")}</span>
          {/* Menu items, all of it: in a Radix menu the arrow keys move
              between items only, so a button or a paragraph in it was out of
              reach for a keyboard and a screen reader in focus mode. Choosing
              one keeps the menu open — the notices are what it is for. */}
          {unread > 0 ? (
            <DropdownMenuItem
              className="h-7 gap-1.5 text-xs font-medium"
              disabled={markAllRead.isPending}
              onSelect={(event) => {
                event.preventDefault();
                markAllRead.mutate();
              }}
            >
              <CheckCheck className="h-3.5 w-3.5" />
              {t("markAllRead")}
            </DropdownMenuItem>
          ) : null}
        </div>
        <div className="max-h-96 overflow-y-auto">
          {(notifications ?? []).length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {t("empty")}
            </p>
          ) : (
            (notifications ?? []).map((entry) => (
              <DropdownMenuItem
                key={entry.id}
                onSelect={(event) => event.preventDefault()}
                className={cn(
                  "block rounded-none border-b px-3 py-2.5 text-sm last:border-b-0",
                  entry.readAt === null && "bg-accent/40",
                )}
              >
                {/* Unread said in words and in weight, not by the tint alone. */}
                {entry.readAt === null ? <span className="sr-only">{t("unreadMarker")}</span> : null}
                <p className={entry.readAt === null ? "font-medium" : undefined}>{render(entry)}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {new Date(entry.createdAt).toLocaleString()}
                </p>
              </DropdownMenuItem>
            ))
          )}
        </div>
        {/* What leaves SchemaPro as e-mail and push, chosen per type. The
            shell already carries next-intl's Link, so this costs no module;
            no icon, because every route pays for what the bell carries. A
            menu item, not a bare link: Radix's menu keeps Tab inside and
            moves the arrow keys between items only, and choosing an item
            closes the menu before the page changes under it. */}
        <div className="border-t p-1">
          <DropdownMenuItem asChild className="text-xs font-medium text-primary">
            <Link href="/notifications">{t("settingsLink")}</Link>
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
