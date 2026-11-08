"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Boxes, Check, Loader2, MapPin } from "lucide-react";
import { LazyDialog, loadConfirm } from "@/components/local/lazy-dialog";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { FilterBar, FilterField } from "@/components/ui/filter-bar";
import { Input } from "@/components/ui/input";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { bookingWindow, isCancellable, LIMITS, placeText, wantedQuantity, type ResourceBookingResponse } from "@/lib/local";
import {
  useMyResourceBookings,
  useResourceAvailability,
  useResourceBookingActions,
} from "@/lib/local-queries";
import { BOOKING_STATUS_VARIANT } from "@/lib/status-variants";
import { toDateString } from "@/lib/utils";

/**
 * Boka resurs: what the school lends out that is not a lokal (surfplattor, en
 * minibuss, aulan), for a date and a time. How many of each are free comes from
 * the gateway (/resources/availability: the quantity less the most that is held
 * at any minute of the window, a waiting request counted as held), not from this
 * page. A resource that needs Drift's yes is requested, not booked, and says so.
 *
 * Built as Boka lokal (/teacher/rooms) is, and fetches its cancel confirmation
 * the first time it is opened.
 */
export default function TeacherResourcesPage() {
  const t = useTranslations("teacherResources");
  const tStatus = useTranslations("roomBooking");
  const tCommon = useTranslations("common");
  const locale = useLocale();

  // The reader's own day, not UTC's: before 02:00 in Sweden UTC is still yesterday.
  const today = toDateString(new Date());
  const [date, setDate] = useState(today);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("10:00");
  const [quantity, setQuantity] = useState("1");
  const [title, setTitle] = useState("");
  const [bookingId, setBookingId] = useState<string | null>(null);
  // The booking the confirmation is about stays set while the dialog closes, so its title does not empty under the fade.
  const [cancelling, setCancelling] = useState<ResourceBookingResponse | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const slot = useMemo(() => bookingWindow(date, start, end), [date, start, end]);
  const wanted = wantedQuantity(quantity);
  const availability = useResourceAvailability(slot?.startsAt ?? null, slot?.endsAt ?? null);
  const mine = useMyResourceBookings();
  const actions = useResourceBookingActions();
  const resources = availability.data ?? [];
  const myBookings = mine.data ?? [];

  const tag = locale === "en" ? "en-GB" : "sv-SE";
  const when = useMemo(() => new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeStyle: "short" }), [tag]);
  const whenText = (booking: ResourceBookingResponse) => when.formatRange(new Date(booking.startsAt), new Date(booking.endsAt));

  const book = async (resourceId: string) => {
    if (!slot || wanted === null) return;
    setBookingId(resourceId);
    try {
      const result = await actions.book.mutateAsync({
        resourceId,
        title: title.trim() || t("defaultTitle"),
        quantity: wanted,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
      });
      // What the gateway decided, not what the page expected: an administrator's booking is never waiting.
      toast.success(result.status === "PENDING" ? t("requestedToast") : t("bookedToast"));
      setTitle("");
    } catch (error) {
      // Somebody took them while the list was on screen: say so in the reader's language, and the list is read again.
      toast.error(error instanceof ApiError && error.status === 409 ? t("takenToast") : error instanceof Error ? error.message : tCommon("error"));
    } finally {
      setBookingId(null);
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

  const askCancel = (booking: ResourceBookingResponse) => {
    setCancelling(booking);
    setConfirmOpen(true);
  };

  const quantityError = wanted === null;

  return (
    <Page>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <FilterBar>
        <FilterField id="resource-date" label={tCommon("date")}>
          <DateField
            label={tCommon("date")}
            id="resource-date"
            className="w-40"
            value={date}
            min={today}
            onChange={(value) => value && setDate(value)}
          />
        </FilterField>
        <FilterField id="resource-start" label={t("from")}>
          <Input
            id="resource-start"
            type="time"
            className="w-32 tabular-nums"
            value={start}
            onChange={(event) => event.target.value && setStart(event.target.value)}
          />
        </FilterField>
        <FilterField id="resource-end" label={t("to")}>
          <Input
            id="resource-end"
            type="time"
            className="w-32 tabular-nums"
            value={end}
            aria-invalid={!slot || undefined}
            aria-describedby={!slot ? "resource-window-error" : undefined}
            onChange={(event) => event.target.value && setEnd(event.target.value)}
          />
        </FilterField>
        <FilterField id="resource-quantity" label={t("quantity")}>
          <Input
            id="resource-quantity"
            type="number"
            inputMode="numeric"
            className="w-24 tabular-nums"
            min={1}
            max={LIMITS.quantity}
            step={1}
            value={quantity}
            aria-invalid={quantityError || undefined}
            aria-describedby={quantityError ? "resource-quantity-error" : undefined}
            onChange={(event) => setQuantity(event.target.value)}
          />
        </FilterField>
        <FilterField id="resource-title" label={t("purpose")} className="min-w-48 flex-1">
          <Input
            id="resource-title"
            value={title}
            maxLength={LIMITS.title}
            placeholder={t("purposePlaceholder")}
            onChange={(event) => setTitle(event.target.value)}
          />
        </FilterField>
      </FilterBar>
      {!slot ? (
        <p id="resource-window-error" role="alert" className="text-sm text-destructive">
          {t("invalidWindow")}
        </p>
      ) : null}
      {quantityError ? (
        <p id="resource-quantity-error" role="alert" className="text-sm text-destructive">
          {t("invalidQuantity", { max: LIMITS.quantity })}
        </p>
      ) : null}

      <SectionCard id="free-resources" title={t("freeResources")} icon={Boxes}>
        {!slot ? (
          <p className="text-sm text-muted-foreground">{t("needWindow")}</p>
        ) : availability.isLoading ? (
          <div aria-busy="true">
            <Skeleton className="h-24 w-full" />
          </div>
        ) : availability.isError ? (
          <LoadError variant="inline" title={t("loadFailed")} hint={t("loadFailedHint")} />
        ) : resources.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noResources")}</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {resources.map((resource) => {
              const place = placeText(resource);
              const enough = wanted !== null && resource.free >= wanted;
              const freeId = `resource-free-${resource.id}`;
              return (
                <li key={resource.id} className="flex items-start justify-between gap-3 rounded-md border px-3 py-2.5">
                  <div className="min-w-0 space-y-1">
                    <p className="font-medium">{resource.name}</p>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <Badge variant="outline">{resource.resourceTypeName}</Badge>
                      {resource.requiresApproval ? <Badge variant="secondary">{t("approvalRequired")}</Badge> : null}
                    </div>
                    <p id={freeId} className="text-xs tabular-nums text-muted-foreground">
                      {t("freeOf", { free: resource.free, total: resource.quantity })}
                      {wanted !== null && !enough ? ` · ${t("tooFew", { wanted })}` : null}
                    </p>
                    {place ? (
                      <p className="flex items-center gap-1 text-xs text-muted-foreground">
                        <MapPin className="size-3 shrink-0" aria-hidden="true" />
                        {place}
                      </p>
                    ) : null}
                  </div>
                  {/* Outline: a filled Boka on every resource was a column of primaries, none of them the page's one next step. */}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void book(resource.id)}
                    disabled={!enough || actions.book.isPending}
                    aria-describedby={freeId}
                    aria-label={tCommon("actionNamed", { action: resource.requiresApproval ? t("request") : t("book"), name: resource.name })}
                  >
                    {bookingId === resource.id ? (
                      <Loader2 className="animate-spin" aria-hidden="true" />
                    ) : (
                      <Check aria-hidden="true" />
                    )}
                    {resource.requiresApproval ? t("request") : t("book")}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      <SectionCard id="my-resource-bookings" title={t("myBookings")}>
        {mine.isLoading ? (
          <div aria-busy="true">
            <Skeleton className="h-16 w-full" />
          </div>
        ) : mine.isError ? (
          <LoadError variant="inline" title={t("bookingsLoadFailed")} hint={t("bookingsLoadFailedHint")} />
        ) : myBookings.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noBookings")}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {myBookings.map((booking) => (
              <li key={booking.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-sm">
                <div className="min-w-0 space-y-0.5">
                  <p>
                    <span className="font-medium">{booking.resourceName}</span>
                    {booking.quantity > 1 ? <span className="text-muted-foreground"> × {booking.quantity}</span> : null}{" "}
                    <span className="text-muted-foreground">{booking.title}</span>
                  </p>
                  <p className="text-xs tabular-nums text-muted-foreground">{whenText(booking)}</p>
                  {booking.decisionNote ? (
                    <p className="text-xs text-muted-foreground">{t("decisionNote", { note: booking.decisionNote })}</p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={BOOKING_STATUS_VARIANT[booking.status]}>{tStatus(`status${booking.status}`)}</Badge>
                  {isCancellable(booking, Date.now()) ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => askCancel(booking)}
                      disabled={actions.cancel.isPending}
                      aria-label={tCommon("actionNamed", {
                        action: t("cancel"),
                        name: `${booking.resourceName} ${whenText(booking)}`,
                      })}
                    >
                      {t("cancel")}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <LazyDialog
        load={loadConfirm}
        kind="confirm"
        props={{
          open: confirmOpen,
          onOpenChange: setConfirmOpen,
          title: cancelling ? t("cancelTitle", { resource: cancelling.resourceName, when: whenText(cancelling) }) : "",
          description: t("cancelBody"),
          confirmLabel: t("cancel"),
          loading: actions.cancel.isPending,
          onConfirm: () => {
            if (cancelling) void cancel(cancelling.id);
          },
        }}
      />
    </Page>
  );
}
