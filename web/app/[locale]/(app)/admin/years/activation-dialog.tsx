"use client";

// Aktivera läsåret: the preview of who moves where, then the move.
//
// The rollover in spring created next year's classes empty; the pupils are
// still in this year's, because attendance builds its rosters from a pupil's
// home class and the old year is still being taught. Activation is where they
// move — 7A's pupils into 8A, the nians out — so it is the one step in the
// rollover that changes what pupils and guardians see. Hence a preview first,
// the same plan the gateway will execute, named: the graduates and the pupils
// left without a class are listed by name (from usePeople — the gateway sends
// ids only, so no pupil's name ever sits in a response it logs), because
// "3 utan klass" is a number an admin can do nothing with.
//
// The execute takes the preview's hash. Anything that changed in between —
// a pupil moved, a class renamed — is a 409, nobody is moved, and the preview
// below is fetched again (useActivateYear invalidates it either way).

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowRight, TriangleAlert } from "lucide-react";
import { useGroups, usePeople } from "@/lib/queries";
import type { MessageLookup } from "@/lib/engine-message";
import type { ActivationPreview } from "@/lib/types";
import {
  useActivateYear,
  useActivationPreview,
} from "./use-year-activation";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { problemText, yearErrorText } from "./year-messages";

interface ActivationDialogProps {
  year: { id: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
}

export function ActivationDialog({ year, onOpenChange }: ActivationDialogProps) {
  const t = useTranslations("years");
  const tCommon = useTranslations("common");
  const tProblems = useTranslations("years.problems") as unknown as MessageLookup;
  const tErrors = useTranslations("years.errors") as unknown as MessageLookup;
  const preview = useActivationPreview(year?.id ?? null);
  const activate = useActivateYear();
  const pending = activate.isPending;
  const plan = preview.data;
  // A year that takes the flag but no pupils: made by hand on Kom igång, or
  // with a chain nobody's class is in. Its activation leaves every pupil in
  // the classes of a year that stops being the active one — their rosters,
  // their schedule, what guardians see — which is C1's harm without the
  // date check (no chain, no "too early"). Said in so many words, and
  // confirmed separately; rolling the active year over is usually what was
  // meant.
  const strands =
    plan !== undefined &&
    !plan.year.isActive &&
    plan.currentlyActive !== null &&
    plan.moves.length === 0 &&
    plan.graduates.count === 0 &&
    plan.unplaced.count === 0 &&
    plan.otherOrNone > 0;
  const [understood, setUnderstood] = useState(false);

  const confirm = async () => {
    if (!year || !plan) return;
    try {
      const result = await activate.mutateAsync({ yearId: year.id, planHash: plan.planHash });
      toast.success(
        t("activated", {
          name: result.year.name,
          moved: result.moved,
          graduated: result.graduated,
          unplaced: result.unplaced,
        }),
      );
      onOpenChange(false);
    } catch (error) {
      toast.error(yearErrorText(tErrors, error, tCommon("error")));
    }
  };

  return (
    <Dialog open={year !== null} onOpenChange={(open) => (!pending ? onOpenChange(open) : undefined)}>
      <DialogContent
        className="max-w-2xl"
        closeDisabled={pending}
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("activationTitle", { name: year?.name ?? "" })}</DialogTitle>
          <DialogDescription>
            {plan
              ? plan.year.isActive
                ? t("activationAlreadyActive", { name: plan.year.name })
                : strands && plan.currentlyActive
                  ? t("activationStrands", {
                      name: plan.year.name,
                      from: plan.currentlyActive.name,
                      count: plan.otherOrNone,
                    })
                  : plan.currentlyActive
                  ? t("activationHandOver", { name: plan.year.name, from: plan.currentlyActive.name })
                  : t("activationFirst", { name: plan.year.name })
              : t("activationIntro")}
          </DialogDescription>
        </DialogHeader>

        {preview.isLoading ? (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : preview.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {yearErrorText(tErrors, preview.error, t("previewFailed"))}
          </p>
        ) : plan ? (
          <ActivationPlanView plan={plan} problemText={(problem) => problemText(tProblems, problem)} />
        ) : null}

        {strands ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <input
              id="activation-strands"
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-primary"
              checked={understood}
              onChange={(event) => setUnderstood(event.target.checked)}
            />
            <label htmlFor="activation-strands">{t("activationStrandsConfirm", { count: plan!.otherOrNone })}</label>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {tCommon("cancel")}
          </Button>
          <Button
            onClick={() => void confirm()}
            disabled={!plan || plan.blocking || pending || preview.isFetching || (strands && !understood)}
          >
            {pending
              ? tCommon("saving")
              : plan?.year.isActive
                ? t("moveStragglersConfirm")
                : t("activateConfirm", { name: year?.name ?? "" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The plan, as the admin reads it: refusals first, then moves, then who leaves. */
export function ActivationPlanView({
  plan,
  problemText,
}: {
  plan: ActivationPreview;
  problemText: (problem: ActivationPreview["problems"][number]) => string;
}) {
  const t = useTranslations("years");
  const { data: people } = usePeople();
  const { data: groups } = useGroups();
  const [showGraduates, setShowGraduates] = useState(false);

  const nameOf = useMemo(() => {
    const byId = new Map((people ?? []).map((person) => [person.id, `${person.firstName} ${person.lastName}`]));
    return (id: string) => byId.get(id) ?? t("unknownPupil");
  }, [people, t]);
  const groupName = (id: string) => groups?.find((group) => group.id === id)?.name ?? "—";
  const byName = (a: string, b: string) => nameOf(a).localeCompare(nameOf(b), "sv");

  return (
    <div className="space-y-4 text-sm">
      {plan.problems.length > 0 ? (
        <ul className="space-y-2">
          {plan.problems.map((problem) =>
            problem.blocking ? (
              <li
                key={problem.code}
                role="alert"
                className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-destructive"
              >
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>{problemText(problem)}</span>
              </li>
            ) : (
              // A notice (MEMBERSHIPS_OUT_OF_DATE): it does not stop the activation.
              <li key={problem.code} className="flex gap-2 rounded-md border p-3 text-muted-foreground">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>{problemText(problem)}</span>
              </li>
            ),
          )}
        </ul>
      ) : null}

      <section aria-labelledby="activation-moves">
        <h3 id="activation-moves" className="mb-1 font-medium">
          {t("movesTitle")}
        </h3>
        {plan.moves.length === 0 ? (
          <p className="text-muted-foreground">{t("noMoves")}</p>
        ) : (
          <ul className="grid gap-1 sm:grid-cols-2">
            {plan.moves.map((move) => (
              <li key={`${move.fromGroupId}>${move.toGroupId}`}>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{move.fromGroupName}</span>
                  <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-label={t("becomes")} />
                  <span className="font-medium">{move.toGroupName}</span>
                  <span className="text-muted-foreground">{t("pupils", { count: move.count })}</span>
                </div>
                {/* An active year's moves are its stragglers, a few: named, so the
                    admin knows whom the move is about. A whole activation's are not. */}
                {plan.year.isActive ? (
                  <div className="text-muted-foreground">
                    {[...move.studentIds].sort(byName).map(nameOf).join(", ")}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {plan.graduates.count > 0 ? (
        <section aria-labelledby="activation-graduates">
          <h3 id="activation-graduates" className="font-medium">
            {t("graduatesTitle", { count: plan.graduates.count })}
          </h3>
          <p className="text-muted-foreground">{t("graduatesHint")}</p>
          <Button
            variant="link"
            size="sm"
            className="h-auto px-0"
            aria-expanded={showGraduates}
            onClick={() => setShowGraduates((shown) => !shown)}
          >
            {showGraduates ? t("hideNames") : t("showNames")}
          </Button>
          {showGraduates ? (
            <ul className="mt-1 columns-2 text-muted-foreground">
              {[...plan.graduates.studentIds].sort(byName).map((id) => (
                <li key={id}>{nameOf(id)}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {plan.unplaced.count > 0 ? (
        <section aria-labelledby="activation-unplaced">
          <h3 id="activation-unplaced" className="font-medium">
            {t("unplacedTitle", { count: plan.unplaced.count })}
          </h3>
          <p className="text-muted-foreground">{t("unplacedHint")}</p>
          <ul className="mt-1 space-y-0.5">
            {[...plan.unplaced.pupils]
              .sort((a, b) => byName(a.studentId, b.studentId))
              .map((pupil) => (
                <li key={pupil.studentId}>
                  <span className="font-medium">{nameOf(pupil.studentId)}</span>{" "}
                  <span className="text-muted-foreground">
                    — {t(`unplacedReason.${pupil.reason}`, { group: groupName(pupil.fromGroupId) })}
                  </span>
                </li>
              ))}
          </ul>
        </section>
      ) : null}

      <p className="text-xs text-muted-foreground">
        {t("untouched", {
          already: plan.alreadyInYear,
          later: plan.inLaterYear,
          other: plan.otherOrNone,
          inactive: plan.inactiveUntouched,
        })}
      </p>
    </div>
  );
}
