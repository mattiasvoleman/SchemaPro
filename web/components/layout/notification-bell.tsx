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
import { Link, useRouter } from "@/i18n/navigation";
import { noticeHref, noticeText, useProfile } from "@/components/profile-context";
import type { NotificationRow } from "@/components/layout/notice-text";

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
  const router = useRouter();

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

  const render = (entry: NotificationRow): string => noticeText(entry, t);

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
                onSelect={(event) => {
                  // A notice with a page to go to closes the menu and goes there; the rest stay to be read.
                  const href = noticeHref(entry, profile.role);
                  if (href) router.push(href);
                  else event.preventDefault();
                }}
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
