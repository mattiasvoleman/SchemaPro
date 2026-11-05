"use client";

import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import type { MessageLookup } from "@/lib/engine-message";
import { requestErrorText } from "@/lib/cover-request-errors";
import type { MyCoverRequest, MyRequestState } from "@/lib/cover-request-types";
import { useAnswerCoverRequest } from "@/lib/my-cover-requests-queries";
import { toDateString } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";

/** How each state reads: a yes is the one good news, a taken one is plain information. */
const STATE_VARIANT: Record<MyRequestState, "success" | "warning" | "secondary" | "outline"> = {
  OPEN: "warning",
  ACCEPTED_BY_ME: "success",
  DECLINED_BY_ME: "outline",
  TAKEN: "secondary",
  WITHDRAWN: "outline",
  EXPIRED: "outline",
  CLOSED: "outline",
};

/** The answered and ended questions kept under the open ones. */
const EARLIER_SHOWN = 5;

/**
 * Open questions first, soonest lesson first; the rest after them, newest
 * first and not too many.
 */
export function orderRequests(requests: readonly MyCoverRequest[]): MyCoverRequest[] {
  const open = requests
    .filter((request) => request.state === "OPEN")
    .sort((a, b) => (a.lessons[0]?.startsAt ?? "").localeCompare(b.lessons[0]?.startsAt ?? "") || a.id.localeCompare(b.id));
  const earlier = requests
    .filter((request) => request.state !== "OPEN")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    .slice(0, EARLIER_SHOWN);
  return [...open, ...earlier];
}

/**
 * "Vikarieförfrågningar" on /teacher/franvaro (Vikariefrågan): the questions
 * the school asked this teacher, each with its lessons (when, subject, class,
 * room: NEVER who is away or why, which the gateway does not send), the time
 * it can be answered until, and "Ja, jag tar dem" / "Nej". The first yes
 * takes ALL the lessons; a colleague who comes second is told it is taken.
 *
 * A yes that breaks a hard rule of cover (the daily cap among them) is
 * refused with the gateway's own Swedish sentence, which names the rule, and
 * the request stays open and visible. Every other refusal (TAKEN, GONE, …) is
 * said in words, and the list is read again by the mutation that settles.
 *
 * Lazy and mounted only when there is something to show: most teachers open
 * the page to read, and the page's tier budget has no room for this.
 */
export function CoverRequestsSection({ requests, failed }: { requests: MyCoverRequest[]; failed: boolean }) {
  const t = useTranslations("coverRequests");
  const tErrors = useTranslations("coverRequests.errors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const { accept, decline } = useAnswerCoverRequest();
  const busy = accept.isPending || decline.isPending;

  const dayText = (date: string) =>
    new Date(`${date}T12:00:00`).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" });
  const time = new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "sv-SE", { hour: "2-digit", minute: "2-digit" });
  const timeText = (iso: string) => time.format(new Date(iso));
  /** "08:30", or "tis 14 okt 08:30" when it is not today. */
  const untilText = (iso: string) =>
    toDateString(new Date(iso)) === toDateString(new Date())
      ? timeText(iso)
      : `${dayText(toDateString(new Date(iso)))} ${timeText(iso)}`;

  const run = async (action: () => Promise<string>) => {
    try {
      toast.success(await action());
    } catch (error) {
      toast.error(requestErrorText(tErrors, error, tCommon("error")));
    }
  };

  const ordered = orderRequests(requests);

  return (
    <SectionCard id="teacher-cover-requests" title={t("teacherTitle")} description={t("teacherBody")}>
      {failed ? <LoadError variant="inline" title={t("teacherLoadFailed")} hint={t("teacherLoadFailedHint")} /> : null}
      {ordered.length > 0 ? (
        <ul className="divide-y rounded-md border">
          {ordered.map((request) => {
            const first = request.lessons[0];
            const what = first ? `${first.subjectName} ${first.groupName} ${dayText(first.date)} ${timeText(first.startsAt)}` : "";
            return (
              <li key={request.id} className="space-y-2 px-3 py-2 text-sm">
                <ul className="space-y-1">
                  {request.lessons.map((lesson) => (
                    <li key={lesson.lessonId} className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      <span className="w-28 capitalize">{dayText(lesson.date)}</span>
                      <span className="w-24 tabular-nums">
                        {timeText(lesson.startsAt)}–{timeText(lesson.endsAt)}
                      </span>
                      <span className="font-medium">{lesson.subjectName}</span>
                      <span>{lesson.groupName}</span>
                      {lesson.roomName ? <span className="text-muted-foreground">{lesson.roomName}</span> : null}
                      {lesson.cancelled ? <Badge variant="secondary">{t("cancelledLesson")}</Badge> : null}
                    </li>
                  ))}
                </ul>
                {request.state === "OPEN" ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      disabled={busy}
                      aria-label={tCommon("actionNamed", { action: t("yes", { count: request.lessons.length }), name: what })}
                      onClick={() =>
                        void run(async () =>
                          t("accepted", { count: (await accept.mutateAsync(request.id)).lessons }),
                        )
                      }
                    >
                      {t("yes", { count: request.lessons.length })}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      aria-label={tCommon("actionNamed", { action: t("no"), name: what })}
                      onClick={() =>
                        void run(async () => {
                          await decline.mutateAsync(request.id);
                          return t("declined");
                        })
                      }
                    >
                      {t("no")}
                    </Button>
                    <span className="text-muted-foreground">{t("answerBy", { time: untilText(request.expiresAt) })}</span>
                  </div>
                ) : (
                  <p>
                    <Badge variant={STATE_VARIANT[request.state]}>{t(`state.${request.state}`)}</Badge>
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </SectionCard>
  );
}
