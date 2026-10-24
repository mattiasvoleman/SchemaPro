"use client";

import { useId, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { ClipboardCheck, Loader2 } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import {
  HOMEWORK_MAX,
  NOTE_MAX,
  TOPIC_MAX,
  cleanText,
  logChanged,
  noteChanged,
  textLength,
  type LessonLogLesson,
  type LessonLogText,
  type SubstituteNoteText,
} from "@/lib/lesson-log";
import { useLessonLogLesson, useSaveLessonLog, useSaveSubstituteNote } from "@/lib/lesson-log-queries";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

/*
 * /teacher/lektion/[lessonId]: one lesson as its teacher keeps it.
 *
 *   ÄMNE OCH LÄXA, which the pupils on the lesson and their guardians see
 *   beside it. The lesson's own teacher and its substitute write it; any
 *   other teacher of the school reads it, as the klassbok does.
 *
 *   NOTIS TILL VIKARIEN, which only the substitute and the school's
 *   administrators read. The lesson's own teacher writes it, before the
 *   absence or after; the substitute reads it here and does not answer it.
 *
 * Nobody is told that either was written, and nothing can be answered here:
 * messages between school and home stay in the school's lärplattform, which
 * the card says where it is written. Who may change what is the gateway's
 * answer (`may`), which asks the database's own rule.
 */

const STALE = new Set(["LESSON_LOG_STALE", "SUBSTITUTE_NOTE_STALE"]);

export function LessonLogPage({ lessonId }: { lessonId: string }) {
  const t = useTranslations("lessonLog");
  const locale = useLocale();
  const query = useLessonLogLesson(lessonId);
  const data = query.data;

  const tag = locale === "en" ? "en-GB" : "sv-SE";
  const subtitle = data
    ? [
        new Intl.DateTimeFormat(tag, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(
          new Date(`${data.lesson.date}T12:00:00Z`),
        ),
        `${data.lesson.start}–${data.lesson.end}`,
        data.lesson.groups.join(", "),
        data.lesson.room,
      ]
        .filter(Boolean)
        .join(" · ")
    : undefined;

  const header = (
    <PageHeader
      back={{ href: "/teacher", label: t("backToWeek") }}
      title={data?.lesson.subject ?? t("title")}
      subtitle={subtitle}
      meta={
        data ? (
          <span className="flex flex-wrap gap-1">
            {data.role === "SUBSTITUTE" ? <Badge variant="secondary">{t("youCover")}</Badge> : null}
            {data.lesson.status === "CANCELLED" ? <Badge variant="destructive">{t("cancelled")}</Badge> : null}
          </span>
        ) : null
      }
      actions={
        data && (data.role === "REGULAR" || data.role === "SUBSTITUTE") ? (
          <Button asChild variant="outline">
            <Link href={`/teacher/attendance/${lessonId}`}>
              <ClipboardCheck aria-hidden="true" />
              {t("attendance")}
            </Link>
          </Button>
        ) : null
      }
    />
  );

  if (query.isError) {
    const missing = query.error instanceof ApiError && (query.error.status === 404 || query.error.status === 403);
    return (
      <Page width="narrow">
        {header}
        <LoadError
          title={missing ? t("notFound") : t("loadFailed")}
          hint={missing ? t("notFoundHint") : t("loadFailedHint")}
          headingLevel={2}
        />
      </Page>
    );
  }

  if (!data) {
    return (
      <Page width="narrow">
        {header}
        <div aria-busy="true">
          <Skeleton className="h-48 w-full" />
        </div>
      </Page>
    );
  }

  return (
    <Page width="narrow">
      {header}
      {data.lesson.teachers.length > 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("teachers", {
            names: data.lesson.teachers
              .map((teacher) => (teacher.role === "SUBSTITUTE" ? t("substituteName", { name: teacher.name }) : teacher.name))
              .join(", "),
          })}
        </p>
      ) : null}
      <LogCard
        key={data.log?.updatedAt ?? "none"}
        lessonId={lessonId}
        saved={data.log}
        editable={data.may.writeLog}
        onStale={() => void query.refetch()}
      />
      {data.may.readNote ? (
        <NoteCard
          key={data.note?.updatedAt ?? "none"}
          lessonId={lessonId}
          saved={data.note}
          editable={data.may.writeNote}
          role={data.role}
          onStale={() => void query.refetch()}
        />
      ) : null}
    </Page>
  );
}

function useWrittenLine() {
  const t = useTranslations("lessonLog");
  const locale = useLocale();
  return (written: { writtenBy: string | null; updatedAt: string }) => {
    const when = new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "sv-SE", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(written.updatedAt));
    return written.writtenBy ? t("writtenBy", { name: written.writtenBy, when }) : t("writtenAt", { when });
  };
}

/** What a failed save says: a newer version is a notice with a reload, anything else a toast. */
function useSaveFailure(onStale: () => void) {
  const tCommon = useTranslations("common");
  const [stale, setStale] = useState(false);
  return {
    stale,
    fail(error: unknown) {
      if (error instanceof ApiError && error.code && STALE.has(error.code)) {
        setStale(true);
        return;
      }
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    },
    reload() {
      setStale(false);
      onStale();
    },
  };
}

function LogCard({
  lessonId,
  saved,
  editable,
  onStale,
}: {
  lessonId: string;
  saved: LessonLogText | null;
  editable: boolean;
  onStale: () => void;
}) {
  const t = useTranslations("lessonLog");
  const written = useWrittenLine();
  const ids = useId();
  const [topic, setTopic] = useState(saved?.topic ?? "");
  const [homework, setHomework] = useState(saved?.homework ?? "");
  const save = useSaveLessonLog(lessonId);
  const failure = useSaveFailure(onStale);

  const topicTooLong = textLength(topic) > TOPIC_MAX;
  const homeworkTooLong = textLength(homework) > HOMEWORK_MAX;
  const changed = logChanged(saved, topic, homework);
  const removing = changed && cleanText(topic) === null && cleanText(homework) === null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!changed || topicTooLong || homeworkTooLong || save.isPending) return;
    try {
      const result = await save.mutateAsync({
        topic: cleanText(topic.replace(/[\r\n]+/g, " ")),
        homework: cleanText(homework),
        basis: saved?.updatedAt ?? null,
      });
      toast.success(result.log ? t("logSaved") : t("logRemoved"));
    } catch (error) {
      failure.fail(error);
    }
  };

  return (
    <SectionCard id="lesson-log" title={t("logTitle")} description={editable ? t("logDescription") : t("logReadOnly")}>
      {failure.stale ? (
        <Notice
          tone="warning"
          title={t("logStale")}
          action={
            <Button variant="outline" size="sm" onClick={failure.reload}>
              {t("reload")}
            </Button>
          }
        >
          {t("staleHint")}
        </Notice>
      ) : null}
      {editable ? (
        <form className="space-y-4" onSubmit={submit} noValidate>
          <FormField
            id={`${ids}-topic`}
            label={t("topic")}
            optional
            hint={t("topicHint", { max: TOPIC_MAX })}
            error={topicTooLong ? t("tooLong", { max: TOPIC_MAX }) : undefined}
          >
            <Input value={topic} onChange={(event) => setTopic(event.target.value)} autoComplete="off" />
          </FormField>
          <FormField
            id={`${ids}-homework`}
            label={t("homework")}
            optional
            hint={t("homeworkHint", { max: HOMEWORK_MAX })}
            error={homeworkTooLong ? t("tooLong", { max: HOMEWORK_MAX }) : undefined}
          >
            <Textarea rows={4} value={homework} onChange={(event) => setHomework(event.target.value)} />
          </FormField>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={!changed || topicTooLong || homeworkTooLong || save.isPending}>
              {save.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              {removing ? t("removeLog") : t("saveLog")}
            </Button>
            {saved ? <span className="text-xs text-muted-foreground">{written(saved)}</span> : null}
          </div>
          <p className="text-xs text-muted-foreground">{t("notAMessage")}</p>
        </form>
      ) : saved ? (
        <div className="space-y-3 text-sm">
          <dl className="space-y-3">
            {saved.topic ? (
              <div>
                <dt className="font-medium">{t("topic")}</dt>
                <dd className="whitespace-pre-line">{saved.topic}</dd>
              </div>
            ) : null}
            {saved.homework ? (
              <div>
                <dt className="font-medium">{t("homework")}</dt>
                <dd className="whitespace-pre-line">{saved.homework}</dd>
              </div>
            ) : null}
          </dl>
          <p className="text-xs text-muted-foreground">{written(saved)}</p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("logEmpty")}</p>
      )}
    </SectionCard>
  );
}

function NoteCard({
  lessonId,
  saved,
  editable,
  role,
  onStale,
}: {
  lessonId: string;
  saved: SubstituteNoteText | null;
  editable: boolean;
  role: LessonLogLesson["role"];
  onStale: () => void;
}) {
  const t = useTranslations("lessonLog");
  const written = useWrittenLine();
  const ids = useId();
  const [body, setBody] = useState(saved?.body ?? "");
  const save = useSaveSubstituteNote(lessonId);
  const failure = useSaveFailure(onStale);
  const tooLong = textLength(body) > NOTE_MAX;
  const changed = noteChanged(saved, body);
  const removing = changed && cleanText(body) === null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!changed || tooLong || save.isPending) return;
    try {
      const result = await save.mutateAsync({ body: cleanText(body), basis: saved?.updatedAt ?? null });
      toast.success(result.note ? t("noteSaved") : t("noteRemoved"));
    } catch (error) {
      failure.fail(error);
    }
  };

  return (
    <SectionCard
      id="substitute-note"
      title={t("noteTitle")}
      description={role === "SUBSTITUTE" ? t("noteForYou") : t("noteDescription")}
    >
      {failure.stale ? (
        <Notice
          tone="warning"
          title={t("noteStale")}
          action={
            <Button variant="outline" size="sm" onClick={failure.reload}>
              {t("reload")}
            </Button>
          }
        >
          {t("staleHint")}
        </Notice>
      ) : null}
      {editable ? (
        <form className="space-y-4" onSubmit={submit} noValidate>
          <FormField
            id={`${ids}-note`}
            label={t("note")}
            optional
            hint={t("noteHint", { max: NOTE_MAX })}
            error={tooLong ? t("tooLong", { max: NOTE_MAX }) : undefined}
          >
            <Textarea rows={5} value={body} onChange={(event) => setBody(event.target.value)} />
          </FormField>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={!changed || tooLong || save.isPending}>
              {save.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              {removing ? t("removeNote") : t("saveNote")}
            </Button>
            {saved ? <span className="text-xs text-muted-foreground">{written(saved)}</span> : null}
          </div>
        </form>
      ) : saved ? (
        <div className="space-y-2 text-sm">
          <p className="whitespace-pre-line">{saved.body}</p>
          <p className="text-xs text-muted-foreground">{written(saved)}</p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("noteEmpty")}</p>
      )}
    </SectionCard>
  );
}
