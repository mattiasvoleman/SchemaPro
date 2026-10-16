"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CalendarOff } from "lucide-react";
import { toast } from "sonner";
import { useProfile } from "@/components/profile-context";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { feedUrl, useCalendarFeeds, useCreateCalendarFeed, useRevokeCalendarFeed, type CalendarFeed } from "@/lib/calendar-feed";
import { useMyChildren } from "@/lib/guardian-queries";

/**
 * "Kalenderprenumeration": a person's own published week in their calendar
 * app (20261112091000). Every role, each for themself; a guardian one per
 * child. Reached from the menu.
 *
 * The address is a secret: whoever has it reads the week without signing
 * in. It is shown once, right after it is made, and never again; a person
 * who lost it makes a new one, which stops the old. It is kept in this
 * page's state alone, with the feed it opens, not in a card (a list that
 * refetches or fails takes no card's address with it) and not in the query
 * cache (the mutation keeps no answer); it is shown while that feed is the
 * card's, so an address stopped elsewhere is not left on screen. Only the
 * https address is offered: a webcal:// link is fetched over plain http by
 * some calendar apps, and the token is in the path.
 */

const STAFF = new Set(["TEACHER", "SCHOOL_ADMIN"]);

/** An address made on this visit, and the feed it opens. */
interface Made {
  address: string;
  feedId: string;
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** A refusal said in the page's language, by the gateway's code, never its prose. */
function feedErrorText(error: unknown, t: Translate, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.code === "CALENDAR_FEEDS_OFF") return t("errors.off");
    if (error.code === "CALENDAR_FEED_NOT_FOUND") return t("errors.gone");
    if (error.code === "STUDENT_NOT_FOUND") return t("errors.notYours");
    if (error.status === 429) return t("errors.tooMany");
  }
  return fallback;
}

export default function CalendarFeedPage() {
  const t = useTranslations("calendarFeed");
  const { profile } = useProfile();
  const guardian = profile.role === "GUARDIAN";
  const feeds = useCalendarFeeds();
  const children = useMyChildren(guardian ? profile.id : null);
  const audience = guardian ? "GUARDIAN" : STAFF.has(profile.role) ? "TEACHER" : "STUDENT";
  // The addresses made on this visit, by whose week they are, with the feed
  // each opens: shown once.
  const [made, setMade] = useState<Record<string, Made>>({});
  const keep = (key: string) => (address: Made | null) =>
    setMade((current) => {
      const next = { ...current };
      if (address) next[key] = address;
      else delete next[key];
      return next;
    });
  const shown = (key: string, feed: CalendarFeed | null) => {
    const entry = made[key];
    return entry && feed && entry.feedId === feed.id ? entry.address : null;
  };

  const body = () => {
    if (feeds.isLoading || (guardian && children.isLoading)) {
      return <Skeleton className="h-40 w-full" />;
    }
    // A failed refetch keeps the list it had: only a list never read is an error.
    if (!feeds.data || (guardian && !children.data)) {
      return <LoadError title={t("loadFailed")} />;
    }
    if (!feeds.data.enabled) {
      return (
        <EmptyState
          icon={CalendarOff}
          title={t("offTitle")}
          description={t(`offBody.${profile.role === "SCHOOL_ADMIN" ? "ADMIN" : audience}`)}
        />
      );
    }
    const live = feeds.data.feeds;
    if (guardian) {
      const active = (children.data ?? []).filter((child) => child.isActive);
      if (active.length === 0) return <EmptyState icon={CalendarOff} title={t("noChildren")} />;
      return active.map((child) => {
        const feed = live.find((entry) => entry.studentId === child.id) ?? null;
        return (
          <FeedCard
            key={child.id}
            title={t("childTitle", { name: child.firstName })}
            studentId={child.id}
            feed={feed}
            address={shown(child.id, feed)}
            onAddress={keep(child.id)}
          />
        );
      });
    }
    const own = live[0] ?? null;
    return <FeedCard title={t("ownTitle")} studentId={undefined} feed={own} address={shown("own", own)} onAddress={keep("own")} />;
  };

  return (
    <Page>
      <PageHeader title={t("title")} subtitle={t(`subtitle.${audience}`)} />
      <div className="space-y-6">
        {body()}
        <SectionCard id="calendar-feed-how" title={t("howTitle")} headingLevel={2}>
          <ul className="list-disc space-y-2 pl-5 text-sm">
            <li>{t("howApple")}</li>
            <li>{t("howGoogle")}</li>
            <li>{t("howOutlook")}</li>
          </ul>
          <p className="mt-4 text-sm text-muted-foreground">{t("secret")}</p>
        </SectionCard>
      </div>
    </Page>
  );
}

function FeedCard({
  title,
  studentId,
  feed,
  address,
  onAddress,
}: {
  title: string;
  studentId: string | undefined;
  feed: CalendarFeed | null;
  address: string | null;
  onAddress: (address: Made | null) => void;
}) {
  const t = useTranslations("calendarFeed");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const create = useCreateCalendarFeed();
  const revoke = useRevokeCalendarFeed();
  // The dialog's kind outlives its closing, so the exit animation shows the
  // dialog that was open and not the other one.
  const [confirming, setConfirming] = useState(false);
  const [kind, setKind] = useState<"renew" | "stop">("renew");
  const [announcement, setAnnouncement] = useState("");
  // Where focus goes once the dialog has closed: the new address, or the
  // button that makes one after stopping.
  const afterClose = useRef<"address" | "make" | null>(null);
  // A new address made without a dialog takes the focus as soon as it is on screen.
  const focusAddress = useRef(false);
  const addressRef = useRef<HTMLInputElement>(null);
  const makeRef = useRef<HTMLButtonElement>(null);
  const id = `calendar-feed-${studentId ?? "own"}`;
  const when = new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "sv-SE", {
    timeZone: "Europe/Stockholm",
    dateStyle: "medium",
    timeStyle: "short",
  });

  useEffect(() => {
    if (address && focusAddress.current) {
      focusAddress.current = false;
      addressRef.current?.focus();
    }
  }, [address]);

  const ask = (next: "renew" | "stop") => {
    setKind(next);
    setConfirming(true);
  };
  const make = async (fromDialog: boolean) => {
    // Emptied first, so the same sentence after a second new address is a change, and heard.
    setAnnouncement("");
    try {
      const made = await create.mutateAsync({ studentId, locale: locale === "en" ? "en" : "sv" });
      if (fromDialog) {
        // The page is aria-hidden until the dialog has gone: focus and say it then.
        afterClose.current = "address";
      } else {
        focusAddress.current = true;
        setAnnouncement(t("madeStatus", { title }));
      }
      onAddress({ address: feedUrl(made.token), feedId: made.feed.id });
      // The answer held the token: nothing keeps it but the page.
      create.reset();
    } catch (error) {
      toast.error(feedErrorText(error, t, tCommon("error")));
    } finally {
      setConfirming(false);
    }
  };
  const stop = async () => {
    if (!feed) return;
    try {
      await revoke.mutateAsync(feed.id);
      onAddress(null);
      afterClose.current = "make";
      toast.success(t("stopped"));
    } catch (error) {
      toast.error(feedErrorText(error, t, tCommon("error")));
    } finally {
      setConfirming(false);
    }
  };
  const copy = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      toast.success(t("copied"));
    } catch {
      // The address is on screen and selected on focus: copying it by hand still works.
      toast.error(t("copyFailed"));
    }
  };

  return (
    <SectionCard id={id} title={title} headingLevel={2}>
      <div role="status" className="sr-only">
        {announcement}
      </div>
      {address ? (
        <div className="space-y-3">
          <p className="text-sm font-medium">{t("madeTitle")}</p>
          <p className="text-sm text-muted-foreground">{t("madeBody")}</p>
          <div className="space-y-1">
            <Label htmlFor={`${id}-address`}>{t("addressLabel")}</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id={`${id}-address`}
                ref={addressRef}
                readOnly
                value={address}
                className="max-w-xl font-mono text-xs"
                onFocus={(event) => event.target.select()}
              />
              <Button variant="outline" size="sm" onClick={() => void copy()}>
                {t("copy")}
              </Button>
            </div>
          </div>
        </div>
      ) : feed ? (
        <div className="space-y-1 text-sm">
          <p>{t("since", { date: when.format(new Date(feed.createdAt)) })}</p>
          <p className="text-muted-foreground">
            {feed.lastUsedAt ? t("lastUsed", { date: when.format(new Date(feed.lastUsedAt)) }) : t("neverUsed")}
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("none")}</p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {feed ? (
          <>
            <Button variant="outline" size="sm" onClick={() => ask("renew")}>
              {t("renew")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => ask("stop")}>
              {t("stop")}
            </Button>
          </>
        ) : (
          // Never disabled: it has focus when pressed, and a disabled button drops it to <body>.
          <Button
            ref={makeRef}
            size="sm"
            onClick={() => {
              if (!create.isPending) void make(false);
            }}
            aria-disabled={create.isPending}
            className={cn(create.isPending && "cursor-not-allowed opacity-50")}
          >
            {t("make")}
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open) setConfirming(false);
        }}
        title={kind === "stop" ? t("stopTitle") : t("renewTitle")}
        description={kind === "stop" ? t("stopBody") : t("renewBody")}
        confirmLabel={kind === "stop" ? t("stop") : t("renew")}
        destructive={kind === "stop"}
        loading={create.isPending || revoke.isPending}
        onConfirm={() => void (kind === "stop" ? stop() : make(true))}
        onCloseAutoFocus={(event) => {
          const target = afterClose.current;
          afterClose.current = null;
          if (target === "address" && addressRef.current) {
            event.preventDefault();
            addressRef.current.focus();
            setAnnouncement(t("madeStatus", { title }));
          } else if (target === "make" && makeRef.current) {
            event.preventDefault();
            makeRef.current.focus();
          }
        }}
      />
    </SectionCard>
  );
}
