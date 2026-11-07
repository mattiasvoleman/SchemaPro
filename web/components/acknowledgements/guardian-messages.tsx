"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ClipboardCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { ApiError } from "@/lib/api";
import { useAckActions, useAckMine } from "@/lib/ack-queries";
import { ACK_CUSTODY_ENDED, ACK_NOT_FOUND, itemsOf, waitingFor, type AckMine } from "@/lib/ack";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { useAckText } from "./use-ack-text";

/** The id of a card's heading, so the page can hand focus to the first card of a page just loaded. */
const titleOf = (id: string) => `ack-mine-${id}`;

/**
 * The guardian's own messages from the school, each with the button that says
 * they have taken part of it, and after the tap the moment they did.
 *
 * ONLY THEIR OWN ROW. A guardian is never told whether the other guardian of
 * the child has confirmed, or that there is one: the list has no field for it
 * (AckMine), and when the school asks every guardian to confirm, the card says
 * only that, as a rule, not as a state. A request from before the guardian was
 * linked, or after their custody ended, is not in the list at all.
 *
 * A tap is one at a time and the button is closed while it is sent; a second tap
 * would be harmless (the gateway answers the first time), but the button should
 * not look as if nothing happened. When the gateway says the message is no
 * longer theirs (custody ended, or the message gone: 409 and 404) the list is
 * read again and the page says so, instead of a button that does nothing.
 *
 * The gateway answers a page at a time, newest first. "Visa äldre" asks for the
 * next and the cards come after the ones shown, and focus goes to the first of
 * them, since the button may be gone when the last page is in. Until then the
 * count of waiting messages is of the ones loaded and says so. A page that
 * cannot be read is said under the list, with a way to try again: the cards
 * already loaded stay.
 */
export function GuardianMessages() {
  const { t } = useAckText();
  const tCommon = useTranslations("common");
  const mine = useAckMine();
  const { confirm } = useAckActions();
  const items = itemsOf(mine.data);
  const [gone, setGone] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [justConfirmed, setJustConfirmed] = useState<string | null>(null);
  // The card that takes focus once the page asked for is in; a new object each time, so that asking twice moves it twice.
  const [focus, setFocus] = useState<{ id: string } | null>(null);

  useEffect(() => {
    if (focus) document.getElementById(titleOf(focus.id))?.focus();
  }, [focus]);

  const more = async () => {
    const shown = items.length;
    const next = itemsOf((await mine.fetchNextPage()).data)[shown];
    if (next) setFocus({ id: next.id });
  };

  const press = async (item: AckMine) => {
    if (confirm.isPending) return;
    setGone(false);
    setFailed(null);
    try {
      await confirm.mutateAsync(item.id);
      setAnnouncement(t("guardian.confirmedAnnounce", { title: item.title }));
      setJustConfirmed(item.id);
    } catch (error) {
      if (error instanceof ApiError && (error.code === ACK_CUSTODY_ENDED || error.code === ACK_NOT_FOUND)) {
        setGone(true);
        setAnnouncement("");
      } else {
        setFailed(item.id);
      }
    }
  };

  const list = () => {
    if (mine.isLoading) {
      return (
        <div aria-busy="true">
          <Skeleton className="h-40 w-full" />
        </div>
      );
    }
    // A page that failed has the cards loaded to show; any other failed read has nothing.
    if ((mine.isError && !mine.isFetchNextPageError) || !mine.data) {
      return <LoadError headingLevel={2} title={t("guardian.loadFailed")} hint={t("guardian.loadFailedHint")} />;
    }
    if (items.length === 0) {
      return (
        <EmptyState
          icon={ClipboardCheck}
          headingLevel={2}
          title={t("guardian.emptyTitle")}
          description={t("guardian.empty")}
        />
      );
    }
    return (
      <>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {t("guardian.summary", { count: waitingFor(items) })}
          {mine.hasNextPage ? ` ${t("guardian.summaryMore")}` : ""}
        </p>
        <ul className="space-y-3" aria-label={t("guardian.listTitle")}>
          {items.map((item) => (
            <li key={item.id}>
              <MessageCard
                item={item}
                pending={confirm.isPending}
                sending={confirm.isPending && confirm.variables === item.id}
                failed={failed === item.id}
                focusReceipt={justConfirmed === item.id}
                onConfirm={() => void press(item)}
              />
            </li>
          ))}
        </ul>
        {mine.isFetchNextPageError ? (
          <LoadError
            variant="inline"
            title={t("guardian.moreFailed")}
            hint={t("guardian.moreFailedHint")}
            action={
              <Button type="button" variant="outline" size="sm" disabled={mine.isFetchingNextPage} onClick={() => void more()}>
                {mine.isFetchingNextPage ? t("guardian.loadingMore") : tCommon("retry")}
              </Button>
            }
          />
        ) : mine.hasNextPage ? (
          <div>
            <Button type="button" variant="outline" disabled={mine.isFetchingNextPage} onClick={() => void more()}>
              {mine.isFetchingNextPage ? t("guardian.loadingMore") : t("guardian.more")}
            </Button>
          </div>
        ) : null}
      </>
    );
  };

  return (
    <>
      {/* Always on the page, so that a confirmation put into it is announced. */}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      {gone ? (
        <Notice tone="warning" role="alert" title={t("guardian.goneTitle")}>
          {t("guardian.gone")}
        </Notice>
      ) : null}
      {list()}
    </>
  );
}

function MessageCard({
  item,
  pending,
  sending,
  failed,
  focusReceipt,
  onConfirm,
}: {
  item: AckMine;
  /** Any confirmation is on its way: no button is open meanwhile. */
  pending: boolean;
  /** This one is. */
  sending: boolean;
  failed: boolean;
  /** The guardian has just tapped this card's button: the receipt that replaces it takes focus. */
  focusReceipt: boolean;
  onConfirm: () => void;
}) {
  const { t, moment, names } = useAckText();
  const receipt = useRef<HTMLParagraphElement>(null);
  const titleId = titleOf(item.id);

  // The button is gone when the tap has been answered; focus goes to what took its place.
  useEffect(() => {
    if (focusReceipt && item.ackedAt) receipt.current?.focus();
  }, [focusReceipt, item.ackedAt]);

  return (
    <article aria-labelledby={titleId} className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 id={titleId} tabIndex={-1} className="min-w-0 text-base font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {item.title}
        </h2>
        {item.ackedAt === null ? <Badge variant="warning">{t("guardian.waitingBadge")}</Badge> : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {t("guardian.from", { author: item.authorName, moment: moment(item.createdAt) })}
      </p>
      {item.children.length > 0 ? (
        <p className="text-sm">
          {t("guardian.about", { names: names(item.children.map((child) => child.name)) })}
        </p>
      ) : null}
      <p className="whitespace-pre-wrap text-sm">{item.body}</p>
      {item.rule === "ALL" ? <p className="text-sm text-muted-foreground">{t("guardian.allRule")}</p> : null}
      {item.ackedAt ? (
        <p ref={receipt} tabIndex={-1} className="flex items-center gap-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Check className="size-4 text-success-strong" aria-hidden="true" />
          {t("guardian.confirmedAt", { moment: moment(item.ackedAt) })}
        </p>
      ) : (
        <Button type="button" disabled={pending} onClick={onConfirm}>
          {sending ? t("guardian.confirming") : t("guardian.confirm")}
        </Button>
      )}
      {failed ? (
        <Notice tone="destructive" title={t("guardian.failedTitle")}>
          {t("guardian.failed")}
        </Notice>
      ) : null}
    </article>
  );
}
