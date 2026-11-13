"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { FilterPicker } from "@/components/schedule/filter-picker";
import { PlanningYearPicker, ProjectedRostersBanner } from "@/components/schedule/planning-year";
import { recurrenceBadge } from "@/components/schedule/recurrence-badge";
import { TimetableGrid, type TimetableLesson } from "@/components/schedule/timetable-grid";
import { Button } from "@/components/ui/button";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { usePlanningYear } from "@/lib/planning-year";
import {
  NO_FILTERS,
  dayEndMarkers,
  isFiltered,
  keptCardId,
  keptCards,
  mealBands,
  placementCardId,
  placementCards,
  reachOf,
  savedAt,
  summaryOf,
  teacherOfPlacement,
  totalsOf,
  visibleBoard,
  weekDay,
  type BoardFilters,
  type BoardPlacement,
  type BoardPost,
  type CardNames,
} from "@/lib/placement-board";
import { usePlacementBoard } from "@/lib/placement-board-queries";
import { useGroups, usePeople, useRooms, useSubjects } from "@/lib/queries";
import { fitSentence, verdictSentence } from "@/lib/requirement-placement-text";
import { compareSwedish } from "@/lib/sorting";
import { cn, subjectColor } from "@/lib/utils";

/*
 * FÖRLÄGG I VECKAN — what the school has placed by hand, in a week, before and
 * after Generera. Read only: the rows are written in the dialog Förlägg on
 * Timplansposter, and this page shows them where they stand with the verdict
 * the gateway gives each (placement-judge.ts), the lessons Generera keeps
 * that they are held against, and what is left of every post to lay.
 *
 * The gateway counts and judges; this page draws. A post's "kvar" is the
 * number Generera sends to the engine (optimization/post-demand.ts).
 *
 * The grid is the grundschema's, unchanged and without gestures. It shows
 * 08–16 when it holds nothing and ends at the hour of the last lesson it
 * holds, while a förläggning's day is 08:00 to 18:00; the end of the day is
 * therefore drawn as muted strips (dayEndMarkers) when nothing reaches it.
 */

/** "A. Ek". */
const shortName = (person: { firstName: string; lastName: string }): string => `${person.firstName[0] ?? ""}. ${person.lastName}`;

/** What the address may name: ?post=, the post to open on (the link in the Förlägg dialog). */
function postFromAddress(): string | null {
  return new URLSearchParams(window.location.search).get("post");
}

export default function PlacementsPage() {
  const t = useTranslations("placementWeek");
  const tTimetable = useTranslations("timetable");
  const tPlacements = useTranslations("requirements.placements");
  const tDays = useTranslations("days");
  const locale = useLocale();

  const { year, active, successor, choose, rosters, rostersFailed } = usePlanningYear();
  const board = usePlacementBoard(year?.id ?? null);
  const groupsQuery = useGroups();
  const subjectsQuery = useSubjects();
  const roomsQuery = useRooms();
  const peopleQuery = usePeople();

  const [filters, setFilters] = useState<BoardFilters>(NO_FILTERS);
  const [selected, setSelected] = useState<string | null>(null);
  const [focusPost, setFocusPost] = useState<string | null>(null);
  useEffect(() => setFocusPost(postFromAddress()), []);

  const groups = useMemo(
    () => (groupsQuery.data ?? []).filter((group) => !year || group.academicYearId === year.id),
    [groupsQuery.data, year],
  );
  const groupById = useMemo(() => new Map((groupsQuery.data ?? []).map((group) => [group.id, group])), [groupsQuery.data]);
  const subjectById = useMemo(() => new Map((subjectsQuery.data ?? []).map((subject) => [subject.id, subject])), [subjectsQuery.data]);
  const roomById = useMemo(() => new Map((roomsQuery.data ?? []).map((room) => [room.id, room])), [roomsQuery.data]);
  const teachers = useMemo(() => (peopleQuery.data ?? []).filter((person) => person.role === "TEACHER"), [peopleQuery.data]);
  const teacherById = useMemo(() => new Map(teachers.map((teacher) => [teacher.id, teacher])), [teachers]);

  const names: CardNames = useMemo(
    () => ({
      subject: (id) => {
        const subject = subjectById.get(id);
        return subject ? { name: subject.name, color: subject.color } : undefined;
      },
      group: (id) => groupById.get(id)?.name,
      teacher: (id) => {
        const teacher = id ? teacherById.get(id) : undefined;
        return teacher ? shortName(teacher) : undefined;
      },
      room: (id) => (id ? roomById.get(id)?.name : undefined),
      weeks: (lesson) => recurrenceBadge(lesson, tTimetable),
      color: (subjectId, color) => subjectColor(subjectId, color),
      keptNote: t("keptNote"),
    }),
    [subjectById, groupById, teacherById, roomById, tTimetable, t],
  );

  const everything = board.data;
  const shown = useMemo(() => (everything ? visibleBoard(everything, filters) : null), [everything, filters]);
  const postById = useMemo(() => new Map((everything?.posts ?? []).map((post) => [post.id, post])), [everything]);
  const summary = useMemo(() => (everything ? summaryOf(everything) : null), [everything]);

  const cards = useMemo(() => {
    if (!shown) return [];
    const lessons = [...placementCards(shown.placements, postById, names), ...keptCards(shown.kept, names)];
    return [...lessons, ...dayEndMarkers(reachOf(lessons), { title: t("dayEndTitle"), line: t("dayEnd") })];
  }, [shown, postById, names, t]);
  const bands = useMemo(
    () => (shown ? mealBands(shown.meals, (meal) => t("meal", { group: groupById.get(meal.studentGroupId)?.name ?? "" })) : []),
    [shown, groupById, t],
  );

  const postName = (post: BoardPost | undefined): string =>
    post ? [subjectById.get(post.subjectId)?.name, groupById.get(post.studentGroupId)?.name].filter(Boolean).join(" ") : "";
  const teacherText = (id: string | null): string => {
    const teacher = id ? teacherById.get(id) : undefined;
    return teacher ? shortName(teacher) : t("noTeacher");
  };
  const rowLine = (row: BoardPlacement): string =>
    [
      `${tDays(String(row.dayOfWeek))} ${row.startTime}–${row.endTime}`,
      row.roomName,
      names.weeks({ recurrence: row.recurrence, startDate: postById.get(row.requirementId)?.startDate ?? null, endDate: postById.get(row.requirementId)?.endDate ?? null }),
    ]
      .filter(Boolean)
      .join(" · ");

  const orderedPosts = useMemo(() => {
    if (!shown) return [];
    const text = (post: BoardPost) => `${groupById.get(post.studentGroupId)?.name ?? ""} ${subjectById.get(post.subjectId)?.name ?? ""}`;
    return [...shown.posts].sort((a, b) => compareSwedish(text(a), text(b)));
  }, [shown, groupById, subjectById]);
  const rowsOfPost = useMemo(() => {
    const byPost = new Map<string, BoardPlacement[]>();
    for (const row of shown?.placements ?? []) {
      const list = byPost.get(row.requirementId);
      if (list) list.push(row);
      else byPost.set(row.requirementId, [row]);
    }
    return byPost;
  }, [shown]);

  // The post the Förlägg dialog's link names: scrolled to and focused once the list is there.
  useEffect(() => {
    if (!focusPost || !shown) return;
    const element = document.getElementById(`post-${focusPost}`);
    if (!element) return;
    element.scrollIntoView({ block: "center" });
    element.focus({ preventScroll: true });
    setFocusPost(null);
  }, [focusPost, shown]);

  const failingShown = (shown?.placements ?? []).filter((row) => !row.verdict.ok);
  const loading = !year || board.isLoading || groupsQuery.isLoading || subjectsQuery.isLoading || roomsQuery.isLoading || peopleQuery.isLoading;
  const failed = board.isError && board.data === undefined;

  const selectedCard: TimetableLesson | undefined = cards.find((card) => card.id === selected);
  const selectedRow = shown?.placements.find((row) => placementCardId(row.id) === selected);
  const selectedKept = shown?.kept.find((lesson) => keptCardId(lesson.id) === selected);

  const filterSections = [{ label: undefined, options: groups.map((group) => ({ id: group.id, name: group.name })) }];
  const pick = (key: keyof BoardFilters) => (value: string[]) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setSelected(null);
  };

  return (
    <Page>
      <PageHeader
        title={t("title")}
        subtitle={year ? t("subtitle", { year: year.name }) : undefined}
        actions={
          <>
            {/* The two year buttons are wide ("2027/28 (nästa, inte aktiverat)"): wrapping keeps a phone's page from scrolling sideways. */}
            <PlanningYearPicker year={year} active={active} successor={successor} onChoose={choose} className="max-w-full flex-wrap" />
            <Button variant="outline" size="sm" asChild>
              <Link href="/admin/requirements">{t("toRequirements")}</Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href="/admin/generate">{t("toGenerate")}</Link>
            </Button>
          </>
        }
      />
      <ProjectedRostersBanner year={year} active={active} rosters={rosters} failed={rostersFailed} />

      {failed ? (
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} action={<Button variant="outline" size="sm" onClick={() => void board.refetch()}>{t("retry")}</Button>} />
      ) : loading || !everything || !shown || !summary ? (
        <div className="space-y-3" aria-busy="true">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        <>
          <p role="status" className="text-sm" data-testid="placement-summary">
            {t("summary", { rows: summary.rows, left: summary.left })}
          </p>

          {summary.rows === 0 ? (
            <Notice title={t("noneTitle")}>
              {t("noneBody")}{" "}
              <Link href="/admin/requirements" className="underline underline-offset-4">
                {t("toRequirements")}
              </Link>
            </Notice>
          ) : (
            <Notice tone="neutral">{t("beforeAfter")}</Notice>
          )}

          {summary.failing > 0 ? (
            <Notice tone="destructive" title={t("failingTitle", { count: summary.failing })} id="placement-failing">
              <p>{t("failingBody")}</p>
              {failingShown.length > 0 ? (
                <ul className="mt-2 space-y-1.5">
                  {failingShown.map((row) => (
                    <li key={row.id} data-testid="failing-row">
                      <span className="font-medium">
                        {postName(postById.get(row.requirementId))}, {rowLine(row)}
                      </span>
                      {": "}
                      {verdictSentence(tPlacements, row.verdict.reason, row.verdict.params)}
                    </li>
                  ))}
                </ul>
              ) : null}
              {failingShown.length < summary.failing ? <p className="mt-2">{t("failingHidden", { count: summary.failing - failingShown.length })}</p> : null}
            </Notice>
          ) : null}

          <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("filters")}>
            <FilterPicker
              sections={filterSections}
              value={[...filters.groups]}
              onChange={pick("groups")}
              label={tTimetable("filterGroup")}
              allLabel={tTimetable("allGroups")}
              countLabel={(count) => tTimetable("groupsSelected", { count })}
            />
            <FilterPicker
              sections={[{ options: teachers.map((teacher) => ({ id: teacher.id, name: `${teacher.firstName} ${teacher.lastName}` })) }]}
              value={[...filters.teachers]}
              onChange={pick("teachers")}
              label={tTimetable("filterTeacher")}
              allLabel={tTimetable("allTeachers")}
              countLabel={(count) => tTimetable("teachersSelected", { count })}
            />
            <FilterPicker
              sections={[{ options: (roomsQuery.data ?? []).map((room) => ({ id: room.id, name: room.name })) }]}
              value={[...filters.rooms]}
              onChange={pick("rooms")}
              label={tTimetable("filterRoom")}
              allLabel={tTimetable("allRooms")}
              countLabel={(count) => tTimetable("roomsSelected", { count })}
            />
            {isFiltered(filters) ? (
              <Button variant="ghost" size="sm" onClick={() => setFilters(NO_FILTERS)}>
                {t("clearFilters")}
              </Button>
            ) : null}
          </div>

          <SectionCard id="placement-week" title={t("weekTitle")} description={t("weekDescription")}>
            <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label={t("legend")}>
              <li>{t("legendPlaced")}</li>
              <li>{t("legendKept")}</li>
              <li>{t("legendFailing")}</li>
            </ul>
            <TimetableGrid
              lessons={cards}
              bands={bands}
              onLessonClick={(lesson) => setSelected((current) => (current === lesson.id ? null : lesson.id))}
              selectedIds={selected ? new Set([selected]) : undefined}
            />
            <div aria-live="polite" className="mt-3 text-sm" data-testid="placement-detail">
              {selectedCard ? (
                <div className="rounded-md border p-3">
                  <p className="font-medium">
                    {[selectedCard.title, selectedCard.subtitle, selectedCard.room].filter(Boolean).join(" · ")}
                  </p>
                  {selectedRow ? (
                    <>
                      <p>{rowLine(selectedRow)}</p>
                      <p>{selectedRow.verdict.ok ? t("holds") : verdictSentence(tPlacements, selectedRow.verdict.reason, selectedRow.verdict.params)}</p>
                      <p className="text-muted-foreground">{t("savedAt", { when: savedAt(selectedRow.changedAt, locale) })}</p>
                      <Button variant="outline" size="sm" className="mt-2" asChild>
                        <a href={`#post-${selectedRow.requirementId}`}>{t("toPost")}</a>
                      </Button>
                    </>
                  ) : selectedKept ? (
                    <>
                      <p>
                        {tDays(String(selectedKept.dayOfWeek))} {selectedKept.startTime}–{selectedKept.endTime}
                      </p>
                      <p>{selectedKept.locked ? t("keptLocked") : t("keptByHand")}</p>
                      <Button variant="outline" size="sm" className="mt-2" asChild>
                        <Link href="/admin/timetable">{t("toTimetable")}</Link>
                      </Button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          </SectionCard>

          <SectionCard id="placement-posts" title={t("postsTitle")} description={t("postsDescription")}>
            {orderedPosts.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noPosts")}</p>
            ) : (
              <ul className="divide-y">
                {orderedPosts.map((post) => {
                  const total = totalsOf(post);
                  const rows = rowsOfPost.get(post.id) ?? [];
                  return (
                    <li
                      key={post.id}
                      id={`post-${post.id}`}
                      tabIndex={-1}
                      className="scroll-mt-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      data-testid="placement-post"
                    >
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <h3 className="min-w-0 break-words text-sm font-semibold">{postName(post)}</h3>
                        <span className="text-sm text-muted-foreground">{teacherText(post.teacherId)}</span>
                      </div>
                      <p className="text-sm">
                        {t("postFigures", { placed: total.placed, count: total.count, locked: total.locked, left: total.left })}
                      </p>
                      {post.cannotPlace ? <p className="text-sm text-muted-foreground">{fitSentence(tPlacements, post.cannotPlace)}</p> : null}
                      {post.parts.length > 1 || post.parts.some((part) => part.cannotPlace) ? (
                        <ul className="mt-1 space-y-0.5 text-sm">
                          {post.parts.map((part) => (
                            <li key={`${part.teacherId ?? "none"}-${part.minutes}`}>
                              {t("part", {
                                teacher: teacherText(part.teacherId),
                                count: part.count,
                                minutes: part.minutes,
                                placed: part.placed,
                                locked: part.locked,
                                left: part.left,
                              })}
                              {part.cannotPlace ? ` ${fitSentence(tPlacements, part.cannotPlace)}` : ""}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {rows.length > 0 ? (
                        <ul className="mt-2 space-y-1 text-sm">
                          {rows.map((row) => (
                            <li key={row.id} className={cn("break-words", !row.verdict.ok && "font-medium")} data-testid="placement-row">
                              {rowLine(row)}
                              {post.parts.length > 1 || post.teacherId !== teacherOfPlacement(row, post) ? ` · ${teacherText(teacherOfPlacement(row, post))}` : ""}
                              {" — "}
                              {row.verdict.ok ? t("holds") : verdictSentence(tPlacements, row.verdict.reason, row.verdict.params)}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {rows.length > 0 ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t("savedAt", { when: savedAt(rows.map((row) => row.changedAt).sort().at(-1)!, locale) })}
                          {post.startDate || post.endDate
                            ? ` · ${t("postWindow", {
                                from: post.startDate ? weekDay(post.startDate, locale) : t("windowFromStart"),
                                to: post.endDate ? weekDay(post.endDate, locale) : t("windowToEnd"),
                              })}`
                            : ""}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </SectionCard>
        </>
      )}
    </Page>
  );
}
