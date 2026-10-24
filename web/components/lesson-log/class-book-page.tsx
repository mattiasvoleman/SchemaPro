"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { BookOpen, Printer, Trash2 } from "lucide-react";
import { usePathname, useRouter } from "@/i18n/navigation";
import {
  CLASS_BOOK_MAX_DAYS,
  byDate,
  daysBetween,
  isDay,
  type ClassBookLesson,
} from "@/lib/lesson-log";
import { useClassBook, useRemoveLessonLog } from "@/lib/lesson-log-queries";
import { useActiveYear, useGroups } from "@/lib/queries";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DateField } from "@/components/ui/date-field";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/ui/form-field";
import { LoadError } from "@/components/ui/load-error";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";

/*
 * KLASSBOKEN: one class's lessons over a period, each with what it was about
 * and its homework, to read on screen or print. /teacher/klassbok for every
 * teacher, /admin/klassbok for every administrator, one component.
 *
 * Which lessons are the gateway's (class-book.service.ts): the class's own,
 * and every other lesson the one roster reader puts one of its pupils on,
 * with how many. It carries no note to the substitute and no pupil.
 *
 * The class and the period are the URL's (?group=&from=&to=), so a printed
 * klassbok can be opened again as it was. The period opens on this week's
 * school days and holds at most 200 days, the gateway's limit.
 *
 * The administrator who writes drift may remove a log that should not stand;
 * the button is data-writes="DRIFT", so the läsare never sees it, and the
 * gateway and the database refuse it to anyone else.
 */

export interface ClassBookPageProps {
  audience: "teacher" | "admin";
  initialGroupId: string | null;
  /** The period as it opens: the URL's, or the route's default (lib/lesson-log.ts classBookPeriod), so server and client agree. */
  initialFrom: string;
  initialTo: string;
}

export function ClassBookPage({ audience, initialGroupId, initialFrom, initialTo }: ClassBookPageProps) {
  const t = useTranslations("classBook");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [groupId, setGroupId] = useState<string | null>(initialGroupId);
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);

  const { activeYear } = useActiveYear();
  const groups = useGroups();
  const choices = useMemo(() => {
    const ofYear = (groups.data ?? []).filter((group) => !activeYear || group.academicYearId === activeYear.id);
    return {
      classes: ofYear.filter((group) => group.kind !== "TEACHING_GROUP"),
      teaching: ofYear.filter((group) => group.kind === "TEACHING_GROUP"),
    };
  }, [groups.data, activeYear]);

  const span = daysBetween(from, to);
  const periodError = !isDay(from) || !isDay(to) || span === 0 ? t("periodBackwards") : span > CLASS_BOOK_MAX_DAYS ? t("periodTooLong", { max: CLASS_BOOK_MAX_DAYS }) : null;
  const book = useClassBook(groupId, from, to, periodError === null);

  const remember = (next: { group?: string | null; from?: string; to?: string }) => {
    const params = new URLSearchParams();
    const group = next.group !== undefined ? next.group : groupId;
    if (group) params.set("group", group);
    params.set("from", next.from ?? from);
    params.set("to", next.to ?? to);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const tag = locale === "en" ? "en-GB" : "sv-SE";
  const dayName = new Intl.DateTimeFormat(tag, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const shortDay = new Intl.DateTimeFormat(tag, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const dayOf = (date: string) => new Date(`${date}T12:00:00Z`);

  return (
    <Page>
      <div className="space-y-4 print:hidden">
        <PageHeader
          title={t("title")}
          subtitle={audience === "admin" ? t("subtitleAdmin") : t("subtitleTeacher")}
          actions={
            <Button variant="outline" onClick={() => window.print()} disabled={!book.data || book.data.lessons.length === 0}>
              <Printer aria-hidden="true" />
              {t("print")}
            </Button>
          }
        />
        <div className="grid gap-4 rounded-lg border bg-card p-4 sm:grid-cols-3 [&>*]:min-w-0">
          <FormField id="class-book-group" label={t("group")}>
            <NativeSelect
              value={groupId ?? ""}
              onChange={(event) => {
                const next = event.target.value === "" ? null : event.target.value;
                setGroupId(next);
                remember({ group: next });
              }}
            >
              <option value="">{t("chooseGroup")}</option>
              {choices.classes.length > 0 ? (
                <optgroup label={t("classes")}>
                  {choices.classes.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {choices.teaching.length > 0 ? (
                <optgroup label={t("teachingGroups")}>
                  {choices.teaching.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </NativeSelect>
          </FormField>
          <FormField id="class-book-from" label={t("from")} error={periodError ?? undefined}>
            <DateField
              id="class-book-from"
              label={t("from")}
              value={from}
              onChange={(value) => {
                setFrom(value);
                if (isDay(value)) remember({ from: value });
              }}
            />
          </FormField>
          <FormField id="class-book-to" label={t("to")}>
            <DateField
              id="class-book-to"
              label={t("to")}
              value={to}
              onChange={(value) => {
                setTo(value);
                if (isDay(value)) remember({ to: value });
              }}
            />
          </FormField>
        </div>
      </div>

      {groupId === null ? (
        <EmptyState icon={BookOpen} title={t("noGroupTitle")} description={t("noGroupHint")} headingLevel={2} />
      ) : periodError ? null : book.isError ? (
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
      ) : !book.data ? (
        <div aria-busy="true">
          <Skeleton className="h-48 w-full" />
        </div>
      ) : (
        <article aria-labelledby="class-book-heading" className="space-y-4">
          <header className="space-y-1">
            <h2 id="class-book-heading" className="text-lg font-semibold">
              {t("heading", { group: book.data.group.name })}
            </h2>
            <p className="text-sm text-muted-foreground">
              {[
                book.data.school,
                t("period", { from: shortDay.format(dayOf(book.data.from)), to: shortDay.format(dayOf(book.data.to)) }),
                book.data.group.kind === "CLASS" ? t("pupils", { count: book.data.pupils }) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </header>
          {book.data.lessons.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            byDate(book.data.lessons).map((day) => (
              <section key={day.date} aria-labelledby={`class-book-${day.date}`} className="space-y-2 print:break-inside-avoid">
                <h3 id={`class-book-${day.date}`} className="text-sm font-semibold capitalize">
                  {dayName.format(dayOf(day.date))}
                </h3>
                <ul className="divide-y rounded-md border">
                  {day.lessons.map((lesson) => (
                    <BookRow key={lesson.id} lesson={lesson} admin={audience === "admin"} />
                  ))}
                </ul>
              </section>
            ))
          )}
          <p className="text-xs text-muted-foreground">{t("footnote")}</p>
        </article>
      )}
    </Page>
  );
}

function BookRow({ lesson, admin }: { lesson: ClassBookLesson; admin: boolean }) {
  const t = useTranslations("classBook");
  const [confirming, setConfirming] = useState(false);
  const remove = useRemoveLessonLog();
  const teachers = lesson.teachers
    .map((teacher) => (teacher.substitute ? t("substituteName", { name: teacher.name }) : teacher.name))
    .join(", ");
  const written = lesson.topic !== null || lesson.homework !== null;

  return (
    <li className="grid gap-x-4 gap-y-1 px-3 py-2 text-sm sm:grid-cols-[7rem_minmax(0,1fr)]">
      <span className="tabular-nums text-muted-foreground">
        {lesson.start}–{lesson.end}
      </span>
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={lesson.status === "CANCELLED" ? "font-medium line-through" : "font-medium"}>{lesson.subject}</span>
          {lesson.status === "CANCELLED" ? <Badge variant="destructive">{t("cancelled")}</Badge> : null}
          {lesson.attending !== null ? (
            <span className="text-muted-foreground">{t("attending", { group: lesson.groups[0] ?? "", count: lesson.attending })}</span>
          ) : null}
        </div>
        <p className="text-muted-foreground">{[teachers || t("noTeacher"), lesson.room].filter(Boolean).join(" · ")}</p>
        {lesson.topic ? (
          <p>
            <span className="font-medium">{t("topic")}:</span> {lesson.topic}
          </p>
        ) : null}
        {lesson.homework ? (
          <p className="whitespace-pre-line">
            <span className="font-medium">{t("homework")}:</span> {lesson.homework}
          </p>
        ) : null}
        {!written ? <p className="text-muted-foreground print:hidden">{t("nothingWritten")}</p> : null}
        {admin && written ? (
          <div className="print:hidden">
            <Button
              variant="outline"
              size="sm"
              data-writes="DRIFT"
              aria-label={t("removeNamed", { lesson: `${lesson.subject} ${lesson.start}` })}
              onClick={() => setConfirming(true)}
            >
              <Trash2 aria-hidden="true" />
              {t("remove")}
            </Button>
            <ConfirmDialog
              open={confirming}
              onOpenChange={setConfirming}
              title={t("removeTitle")}
              description={t("removeDescription")}
              confirmLabel={t("remove")}
              loading={remove.isPending}
              onConfirm={() => {
                remove.mutate(lesson.id, {
                  onSuccess: () => {
                    setConfirming(false);
                    toast.success(t("removed"));
                  },
                  onError: (error) => toast.error(error instanceof Error ? error.message : t("removeFailed")),
                });
              }}
            />
          </div>
        ) : null}
      </div>
    </li>
  );
}
