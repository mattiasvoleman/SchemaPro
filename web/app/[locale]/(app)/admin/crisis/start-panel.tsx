"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Siren } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import type { MessageLookup } from "@/lib/engine-message";
import { useCrisisActions } from "@/lib/crisis-admin-queries";
import type { CrisisKind, CrisisMode } from "@/lib/crisis-types";
import { blockingAlarmId, crisisErrorText } from "@/lib/crisis-view";

/*
 * Starta larm: the two kinds (utrymning, inrymning) and the two modes (skarpt
 * larm, övning) as four buttons, one tap to choose and one to confirm. The
 * choice is made in one tap because a person starting an alarm is not helped
 * by a form; the confirmation is a second, deliberate tap because an alarm
 * that starts by mistake empties a school's attention. A live alarm is drawn
 * large and red and its confirmation says that it is not an exercise; an
 * exercise is marked "Övning" wherever it is named.
 *
 * Red on a trigger is an exception to the design system's rule that red
 * belongs on a confirm button only: this is the one button of the app that is
 * meant to look like an alarm.
 *
 * A refused start (409 CRISIS_ALARM_OPEN) links to the alarm that is going
 * when the gateway names it (params.alarmId, which its exception filter lets
 * through); when it cannot, the loser of a race, the page says that one is
 * going and does not link.
 *
 * Nothing about the school's settings gates the buttons here when the settings
 * could not be read (the page passes `allowed`): the database refuses a profile
 * that may not start (403 CRISIS_NOT_YOURS), and that answer is said in words.
 */

const KINDS: readonly CrisisKind[] = ["EVACUATION", "LOCKDOWN"];

interface Chosen {
  kind: CrisisKind;
  mode: CrisisMode;
}

export function StartPanel({
  allowed,
  drillOpen,
  onStarted,
}: {
  /** The profile may start an alarm; false shows why not instead of the buttons. */
  allowed: boolean;
  /** An exercise is going: a second one cannot start, and a live alarm ends it. */
  drillOpen: boolean;
  onStarted: (alarmId: string) => void;
}) {
  const t = useTranslations("crisis");
  const tErrors = useTranslations("crisis.errors") as unknown as MessageLookup;
  const { start } = useCrisisActions();
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [failed, setFailed] = useState<{ chosen: Chosen; error: unknown } | null>(null);
  const confirmation = useRef<HTMLDivElement>(null);

  // The confirmation is announced as an alert, and focus is put on it so a
  // keyboard starts from it: the first Tab reaches "Avbryt", not the page.
  useEffect(() => {
    if (chosen) confirmation.current?.focus();
  }, [chosen]);

  if (!allowed) {
    return (
      <SectionCard id="crisis-start" title={t("start.title")} icon={Siren}>
        <Notice tone="neutral">{t("start.notAllowed")}</Notice>
      </SectionCard>
    );
  }

  const submit = () => {
    if (!chosen || start.isPending) return;
    const attempt = chosen;
    setFailed(null);
    start.mutate(attempt, {
      onSuccess: (started) => {
        setChosen(null);
        onStarted(started.alarm.id);
      },
      onError: (error) => {
        setChosen(null);
        setFailed({ chosen: attempt, error });
      },
    });
  };

  const live = chosen?.mode === "LIVE";
  // The alarm that is going, when the gateway could name it (it cannot for the loser of a race).
  const blocking = failed ? blockingAlarmId(failed.error) : null;

  return (
    <SectionCard id="crisis-start" title={t("start.title")} icon={Siren} description={t("start.description")}>
      <div className="grid gap-4 sm:grid-cols-2">
        {KINDS.map((kind) => (
          <div key={kind} className="space-y-2 rounded-md border p-3">
            <h3 className="text-sm font-semibold">{t(`kind.${kind}`)}</h3>
            <p className="text-sm text-muted-foreground">{t(`start.about.${kind}`)}</p>
            <div className="grid gap-2">
              <Button
                type="button"
                variant="destructive"
                className="h-14 whitespace-normal text-base"
                disabled={start.isPending}
                onClick={() => setChosen({ kind, mode: "LIVE" })}
              >
                {t("start.buttonLive", { kind: t(`kind.${kind}`).toLowerCase() })}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-11 whitespace-normal"
                disabled={start.isPending || drillOpen}
                onClick={() => setChosen({ kind, mode: "DRILL" })}
              >
                {t("start.buttonDrill", { kind: t(`kind.${kind}`).toLowerCase() })}
              </Button>
            </div>
          </div>
        ))}
      </div>
      {drillOpen ? <p className="text-sm text-muted-foreground">{t("start.drillRunning")}</p> : null}

      {chosen ? (
        <div ref={confirmation} tabIndex={-1} className="outline-none">
          <Notice
            tone={live ? "destructive" : "neutral"}
            title={
              <span className="flex flex-wrap items-center gap-2">
                {live ? null : <Badge variant="warning">{t("mode.DRILL")}</Badge>}
                {t(live ? "start.confirmLiveTitle" : "start.confirmDrillTitle", { kind: t(`kind.${chosen.kind}`).toLowerCase() })}
              </span>
            }
          >
            <p>{t(live ? "start.confirmLiveBody" : "start.confirmDrillBody")}</p>
            {live && drillOpen ? <p className="mt-1">{t("start.confirmCutsDrill")}</p> : null}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" variant="outline" className="h-11" onClick={() => setChosen(null)}>
                {t("start.cancel")}
              </Button>
              <Button
                type="button"
                variant={live ? "destructive" : "default"}
                className={live ? "h-11 px-6 text-base font-semibold" : "h-11 px-6"}
                disabled={start.isPending}
                onClick={submit}
              >
                {start.isPending ? t("start.starting") : live ? t("start.confirmLive") : t("start.confirmDrill")}
              </Button>
            </div>
          </Notice>
        </div>
      ) : null}

      {failed ? (
        <Notice tone="destructive" title={t("start.failed")}>
          <p>{crisisErrorText(tErrors, failed.error, t("start.failedFallback"))}</p>
          {blocking ? (
            <p className="mt-1">
              <Link className="font-medium underline underline-offset-4" href={`/admin/crisis?alarm=${blocking}`}>
                {t("start.showRunning")}
              </Link>
            </p>
          ) : null}
        </Notice>
      ) : null}
    </SectionCard>
  );
}
