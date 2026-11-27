"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Notice } from "@/components/ui/notice";
import { apiErrorText } from "@/lib/api-error-text";
import { hoursToInvite, inviteInParts, type InvitationReport, type MassProgress } from "@/lib/mass-invitation";

/**
 * The mass invitation of the people page: the people on screen who have never been invited, sent in parts with the progress said, and
 * taken up again where it stopped (lib/mass-invitation.ts says why that is safe).
 *
 * `scope` is who the run covers, fixed when the dialog opened: the people the search and the tab showed. What is left to do is asked
 * of the register each time (`readPending`), never remembered here, so a person invited by another administrator, another tab or the
 * run before this one is not invited again.
 */
export function InviteAllDialog({
  open,
  onClose,
  count,
  perHour,
  send,
  readPending,
  onRunEnded,
}: {
  open: boolean;
  onClose: () => void;
  /** How many people the dialog was opened for, said before it starts. */
  count: number;
  /** The mail limit of the project an hour, from the administrator's start page's setting, or null when nobody has said. */
  perHour: number | null;
  send: (ids: string[]) => Promise<InvitationReport>;
  /** The people of the scope who are still to be invited, read from the register now. */
  readPending: () => Promise<string[]>;
  /** Told when a run has ended, whatever way it ended: the page reads the register again once, and not after every part. */
  onRunEnded: () => void;
}) {
  const t = useTranslations("people.massInvite");
  const tCommon = useTranslations("common");
  const [progress, setProgress] = useState<MassProgress | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const stop = useRef(false);
  const mounted = useRef(true);
  const running = progress?.phase === "running";

  // A dialog that is gone (the page was left, or Avbryt was pressed while the register was being read) has no Stoppa to press and no
  // progress to show: a run that went on would send invitations nobody sees, and a second run started beside it would invite the same
  // people twice. Leaving stops the run after the part that is on its way, as Stoppa does.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop.current = true;
    };
  }, []);

  const start = async () => {
    setReadError(null);
    setReading(true);
    let pending: string[];
    try {
      pending = await readPending();
    } catch (error) {
      if (mounted.current) setReadError(apiErrorText(error, tCommon));
      return;
    } finally {
      if (mounted.current) setReading(false);
    }
    if (!mounted.current) return;
    stop.current = false;
    const carried = progress;
    // What an earlier part of the same run did stays in the sums: a run taken up again is one run on the screen.
    const result = await inviteInParts(pending, send, {
      onProgress: (now) => setProgress(carried ? addTo(carried, now) : now),
      shouldStop: () => stop.current,
    });
    setProgress(carried ? addTo(carried, result) : result);
    onRunEnded();
  };

  const hours = hoursToInvite(count, perHour);
  const done = progress?.phase === "done";
  // A run that went through every part is not a run that invited everybody: the people the gateway could not invite are still to do,
  // and Ta om asks the register for them.
  const complete = done && progress.failed.length === 0;
  const left = progress ? Math.max(progress.total - progress.handled, 0) : 0;

  return (
    <Dialog open={open} onOpenChange={(next) => (!next && !running ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title", { count })}</DialogTitle>
          <DialogDescription>{progress ? t("running") : t("intro")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3" aria-live="polite">
          {!progress && hours !== null ? (
            <Notice tone="warning">{t("slow", { count, perHour: perHour ?? 0, hours })}</Notice>
          ) : null}
          {!progress && perHour === null ? <Notice tone="neutral">{t("limitUnknown")}</Notice> : null}
          {readError ? <Notice tone="destructive">{readError}</Notice> : null}

          {progress ? (
            <>
              <div
                role="progressbar"
                aria-label={t("progressLabel")}
                aria-valuemin={0}
                aria-valuemax={progress.total}
                aria-valuenow={progress.handled}
                className="h-2 w-full overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full bg-primary transition-[width]"
                  style={{ width: `${progress.total === 0 ? 100 : Math.round((progress.handled / progress.total) * 100)}%` }}
                />
              </div>
              <p className="text-sm tabular-nums">{t("progress", { handled: progress.handled, total: progress.total })}</p>
              <ul className="space-y-1 text-sm text-muted-foreground">
                <li>{t("sent", { count: progress.sent })}</li>
                {progress.alreadyRegistered > 0 ? <li>{t("alreadyRegistered", { count: progress.alreadyRegistered })}</li> : null}
                {progress.alreadyInvited > 0 ? <li>{t("alreadyInvited", { count: progress.alreadyInvited })}</li> : null}
                {progress.noAddress > 0 ? <li>{t("noAddress", { count: progress.noAddress })}</li> : null}
              </ul>
              {progress.failed.length > 0 ? (
                <Notice tone="destructive" title={t("failed", { count: progress.failed.length })}>
                  <ul className="list-disc pl-4">
                    {[...new Set(progress.failed.map((failure) => failure.message))].slice(0, 3).map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                </Notice>
              ) : null}
              {progress.phase === "paused" && progress.pausedFor === "RATE_LIMITED" ? (
                <Notice tone="warning" title={t("pausedLimitTitle")}>
                  {t("pausedLimit", { left })}
                </Notice>
              ) : null}
              {progress.phase === "paused" && progress.pausedFor === "ERROR" ? (
                <Notice tone="destructive" title={t("pausedErrorTitle")}>
                  {t("pausedError", { message: apiErrorText(progress.error, tCommon) })}
                </Notice>
              ) : null}
              {progress.phase === "stopped" ? <Notice tone="neutral">{t("stopped", { left })}</Notice> : null}
              {complete ? <Notice tone="success">{t("done", { count: progress.sent })}</Notice> : null}
              {done && !complete ? (
                <Notice tone="warning">{t("doneWithFailures", { count: progress.sent, failed: progress.failed.length })}</Notice>
              ) : null}
            </>
          ) : null}
        </div>

        <DialogFooter>
          {running ? (
            <Button variant="outline" onClick={() => (stop.current = true)}>
              {t("stop")}
            </Button>
          ) : (
            <Button variant="outline" onClick={onClose}>
              {complete ? t("finish") : tCommon("cancel")}
            </Button>
          )}
          {!complete ? (
            <Button onClick={() => void start()} disabled={running || reading}>
              {progress ? t("resume") : t("start", { count })}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A run taken up again, as one on the screen: what the earlier parts did, and this one's, and what is left of the whole. */
function addTo(before: MassProgress, now: MassProgress): MassProgress {
  // The people who failed were handled once already and are asked for again from the register: they are in `now`, not twice in the sums,
  // and what they do this time is what is said of them.
  const settled = before.handled - before.failed.length;
  return {
    ...now,
    total: settled + now.total,
    handled: settled + now.handled,
    sent: before.sent + now.sent,
    alreadyRegistered: before.alreadyRegistered + now.alreadyRegistered,
    alreadyInvited: before.alreadyInvited + now.alreadyInvited,
    noAddress: before.noAddress + now.noAddress,
    failed: now.failed,
  };
}
