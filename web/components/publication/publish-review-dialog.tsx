"use client";

/*
 * Publicera, reviewed: the validity range, the draft against what is
 * published (in utkastläge), what the calendar would get, and the school's
 * named checks — then publish, or "Publicera ändå" over warnings.
 *
 * Opened from the timetable (fetched lazily, in the lesson dialogs' chunk —
 * lesson-dialogs.ts) and from /admin/publishing. It replaces the old
 * Publicera dialog, which sent POST /calendar/publish with two dates and no
 * question asked; that route is unchanged for any other caller, and in direct
 * mode POST /publications writes the same lessons for the same window
 * (pinned by the gateway's golden test) and adds the checks and the log row.
 *
 * The preview is the gateway's own dry run — the publish materialised inside
 * a transaction it rolls back — so the counts and the checks are the ones the
 * publish will meet. Its digest goes back with the publish: if the
 * grundschema or the publications changed in between, the gateway answers
 * PUBLISH_STALE and the preview is fetched again rather than publishing
 * something nobody looked at.
 *
 * The lunch warning the old dialog drew is a check now (PUB_LUNCH_NOT_SET).
 */

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { MessageLookup } from "@/lib/engine-message";
import {
  useDraftState,
  usePublicationPreview,
  usePublicationSettings,
  usePublicationTimeline,
  usePublishTimetable,
} from "@/lib/publication-queries";
import { publicationErrorText } from "@/lib/publication-messages";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import {
  currentSegment,
  defaultPublishWindow,
  isWindowValid,
  type LessonNames,
  type PublishWindow,
} from "@/lib/publication-view";
import { GateList } from "@/components/publication/gate-list";
import { DraftDiff } from "@/components/publication/draft-diff";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Named {
  id: string;
  name: string;
}
interface PersonNamed {
  id: string;
  firstName: string;
  lastName: string;
}

export interface PublishReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  year: { id: string; startDate: string; endDate: string } | null;
  subjects?: readonly Named[];
  groups?: readonly Named[];
  teachers?: readonly PersonNamed[];
  rooms?: readonly Named[];
}

export function PublishReviewDialog({
  open,
  onOpenChange,
  year,
  subjects,
  groups,
  teachers,
  rooms,
}: PublishReviewDialogProps) {
  const t = useTranslations("publishing");
  const tErrors = useTranslations("publishing.errors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const tDays = useTranslations("days");

  const settings = usePublicationSettings(open);
  const timeline = usePublicationTimeline(open && year ? year.id : null);
  const mode = settings.data?.publishMode ?? null;
  const draft = useDraftState(year?.id ?? null, open && mode === "DRAFT");
  const publish = usePublishTimetable();

  const [edited, setEdited] = useState<Partial<PublishWindow>>({});
  const [problem, setProblem] = useState<string | null>(null);

  const defaults =
    mode && timeline.data && year ? defaultPublishWindow(mode, timeline.data.today, year) : null;
  const range: PublishWindow | null = defaults
    ? { validFrom: edited.validFrom ?? defaults.validFrom, validTo: edited.validTo ?? defaults.validTo }
    : null;
  const valid = range !== null && year !== null && isWindowValid(range, year);
  // The dry run follows the dates once they stand still (600 ms): typing a
  // date commits each parseable value, and each dry run in DRAFT holds the
  // school's publication lock and counts against the publish limit.
  const asked = useDebouncedValue(open && valid && year ? { academicYearId: year.id, ...range! } : null, 600);
  const preview = usePublicationPreview(asked);
  const previewIsForRange =
    asked !== null && range !== null && asked.validFrom === range.validFrom && asked.validTo === range.validTo;

  const names = useMemo<LessonNames>(() => {
    const byId = <T extends { id: string }>(rows: readonly T[] | undefined) =>
      new Map((rows ?? []).map((row) => [row.id, row]));
    const subjectById = byId(subjects);
    const groupById = byId(groups);
    const teacherById = byId(teachers);
    const roomById = byId(rooms);
    return {
      subject: (id) => subjectById.get(id)?.name ?? "?",
      group: (id) => groupById.get(id)?.name ?? "?",
      teacher: (id) => {
        const person = teacherById.get(id);
        return person ? `${person.firstName} ${person.lastName}` : "?";
      },
      room: (id) => roomById.get(id)?.name ?? "?",
      day: (dayOfWeek) => tDays(String(dayOfWeek)),
    };
  }, [subjects, groups, teachers, rooms, tDays]);

  const close = (next: boolean) => {
    if (!next) {
      setEdited({});
      setProblem(null);
    }
    onOpenChange(next);
  };

  const doPublish = async () => {
    if (!preview.data || !year || !range || !previewIsForRange) return;
    setProblem(null);
    try {
      const outcome = await publish.mutateAsync({
        academicYearId: year.id,
        validFrom: range.validFrom,
        validTo: range.validTo,
        ...(preview.data.needsAcknowledgement ? { acknowledgeWarnings: true } : {}),
        expectedDigest: preview.data.digest,
      });
      toast.success(t("publishedToast", { count: outcome.result.created }));
      close(false);
    } catch (error) {
      setProblem(publicationErrorText(tErrors, error, tCommon("error")));
    }
  };

  const current = timeline.data ? currentSegment(timeline.data) : null;
  const loadFailed = settings.isError || timeline.isError;
  const result = preview.data;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("reviewTitle")}</DialogTitle>
          <DialogDescription>
            {mode === "DRAFT" ? t("reviewBodyDraft") : t("reviewBodyDirect")}
          </DialogDescription>
        </DialogHeader>

        {loadFailed ? (
          <p role="alert" className="text-sm">
            {publicationErrorText(tErrors, settings.error ?? timeline.error, tCommon("error"))}
          </p>
        ) : null}

        {timeline.data ? (
          <p className="text-sm">
            {current
              ? t("validNow", { from: current.from, to: current.to })
              : t("validNowNone")}
          </p>
        ) : null}

        <div className="grid grid-cols-2 gap-4 [&>*]:min-w-0">
          <div className="space-y-2">
            <Label htmlFor="publish-valid-from">{t("validFrom")}</Label>
            <DateField
              id="publish-valid-from"
              label={t("validFrom")}
              value={range?.validFrom ?? ""}
              min={year?.startDate}
              max={year?.endDate}
              onChange={(value) => setEdited((previous) => ({ ...previous, validFrom: value }))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="publish-valid-to">{t("validTo")}</Label>
            <DateField
              id="publish-valid-to"
              label={t("validTo")}
              value={range?.validTo ?? ""}
              min={year?.startDate}
              max={year?.endDate}
              onChange={(value) => setEdited((previous) => ({ ...previous, validTo: value }))}
            />
          </div>
        </div>
        {mode === "DRAFT" ? <p className="text-xs">{t("validFromHintDraft")}</p> : null}
        {range && !valid ? (
          <p role="alert" className="text-sm">
            {t("windowInvalid")}
          </p>
        ) : null}

        {mode === "DRAFT" ? (
          <section aria-labelledby="publish-draft-title" className="space-y-2">
            <h3 id="publish-draft-title" className="text-sm font-semibold">
              {t("diffTitle")}
            </h3>
            {draft.data ? <DraftDiff state={draft.data} names={names} /> : <p className="text-sm">{t("loading")}</p>}
          </section>
        ) : null}

        <section aria-labelledby="publish-preview-title" className="space-y-2" aria-busy={preview.isFetching}>
          <h3 id="publish-preview-title" className="text-sm font-semibold">
            {t("previewTitle")}
          </h3>
          {preview.isFetching && !result ? <p className="text-sm">{t("previewLoading")}</p> : null}
          {preview.isError ? (
            <p role="alert" className="text-sm">
              {publicationErrorText(tErrors, preview.error, tCommon("error"))}
            </p>
          ) : null}
          {result ? (
            <>
              <p className="text-sm">
                {t("previewResult", {
                  created: result.result.created,
                  cancelled: result.result.cancelled,
                  skipped: result.result.skipped,
                })}
              </p>
              {result.draft ? (
                <p className="text-sm">
                  {t("previewDraft", {
                    moved: result.draft.moved,
                    removed: result.draft.removed,
                    adopted: result.draft.adopted,
                  })}
                </p>
              ) : null}
              <h3 className="pt-1 text-sm font-semibold">{t("gatesTitle")}</h3>
              <GateList gates={result.gates} />
              {result.refused ? (
                <p className="text-sm font-medium">{t("refusedHint")}</p>
              ) : result.needsAcknowledgement ? (
                <p className="text-sm">{t("acknowledgeHint")}</p>
              ) : null}
            </>
          ) : null}
        </section>

        {problem ? (
          <p role="alert" className="text-sm font-medium">
            {problem}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            {tCommon("cancel")}
          </Button>
          <Button
            onClick={doPublish}
            disabled={!result || result.refused || preview.isFetching || !previewIsForRange || publish.isPending}
          >
            {publish.isPending ? (
              <>
                <Loader2 className="animate-spin" />
                {t("publishing")}
              </>
            ) : result?.needsAcknowledgement ? (
              t("publishAnyway")
            ) : (
              t("publishConfirm")
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
