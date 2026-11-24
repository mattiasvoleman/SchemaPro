"use client";

import { Fragment, useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { ApiError } from "@/lib/api";
import {
  ENGINE_RELEASE_POST_NOT_IN_YEAR,
  useEngineReleases,
  useSetEngineRelease,
} from "@/lib/engine-release-queries";
import {
  formatReleaseDay,
  idsToRelease,
  idsToTakeBack,
  releaseLines,
  releasedIn,
  staffedIn,
  type ReleaseGroup,
  type ReleaseLine,
  type ReleasePost,
} from "@/lib/engine-release";
import { profileWrites } from "@/lib/admin-areas";
import { useProfile, useReadOnly } from "@/components/profile-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { TableScroll } from "@/components/ui/table-scroll";
import { apiErrorText } from "@/lib/api-error-text";

/** The panel's anchor: Föreslå bemanning's "nothing to propose" sentence points here. */
export const ENGINE_RELEASE_ANCHOR = "engine-release";

export interface EngineReleaseCardProps {
  academicYearId: string;
  /** The year's posts, as the page holds them; undefined while they load. */
  requirements: readonly ReleasePost[] | undefined;
  /** The groups (any year: a post names its own), for the årskurs; undefined while they load. */
  groups: readonly ReleaseGroup[] | undefined;
  subjects: readonly { id: string; name: string }[];
  teacherName: (userId: string) => string;
  /** Who released a post, by name; null for a person the page cannot name. */
  personName: (userId: string) => string | null;
  /** Whether the teacher is still staff. A post whose teacher has left is always open to the engine, like an unstaffed one. */
  activeStaff: (userId: string) => boolean;
}

/**
 * "Släppta poster": which posts Föreslå bemanning may give to another teacher.
 *
 * THE ENGINE NEVER MOVES A TEACHER THE SCHOOL CHOSE. A post nobody teaches is always the proposal's to staff; a staffed
 * post is its own only once released, here, and only while "Bara obemannade" is off in the dialog. Nothing is written to
 * a post's teacher from this card: it sets and takes back the release, and the proposal still needs its approval.
 *
 * ONE WRITE PATH, BY POST ID. The row "Matematik · åk 7" is the page expanding the posts of that subject whose group is
 * in that årskurs into their ids (lib/engine-release.ts). "Släpp N bemannade" sends the line's staffed posts that are
 * not released yet (a post nobody teaches needs none); "Ta tillbaka alla" sends every post of the line, which the gateway
 * answers idempotently. Both are one PUT, all or nothing.
 *
 * READ-ONLY for a profile that does not write Planering (the läsare, whose style rule would otherwise hide the switch
 * and leave a post's state unsaid): the state is drawn as text and no control is offered. The gateway and the database
 * refuse the write under it either way.
 *
 * React.lazy from the page, like the drawer and the dialogs: nothing here is on the route's first load.
 */
export function EngineReleaseCard({
  academicYearId,
  requirements,
  groups,
  subjects,
  teacherName,
  personName,
  activeStaff,
}: EngineReleaseCardProps) {
  const t = useTranslations("staffing.engineRelease");
  const tCommon = useTranslations("common");
  const { profile, school } = useProfile();
  const readOnly = useReadOnly() || !profileWrites(profile?.adminProfile ?? "FULL", "PLANERING");
  const timeZone = school?.timezone ?? "Europe/Stockholm";
  const releases = useEngineReleases(academicYearId);
  const set = useSetEngineRelease();
  const base = useId();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  /** The sentence for what the last press did, spoken by the status region below. */
  const [done, setDone] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** Which button of which line was pressed, for its spinner; the switches show the card's busy state only. */
  const [working, setWorking] = useState<string | null>(null);
  /** The control focus returns to when the write has finished: a disabled control cannot keep it. */
  const focusAfter = useRef<string | null>(null);
  const pending = set.isPending;

  useEffect(() => {
    if (pending || focusAfter.current === null) return;
    const target = document.getElementById(focusAfter.current);
    focusAfter.current = null;
    target?.focus();
  }, [pending]);

  const subjectName = (subjectId: string) => subjects.find((subject) => subject.id === subjectId)?.name ?? "—";
  const releaseOf = new Map((releases.data?.releases ?? []).map((release) => [release.requirementId, release]));
  const lines =
    requirements && groups
      ? releaseLines({ posts: requirements, groups, subjectName, activeStaff, released: new Set(releaseOf.keys()) })
      : null;

  const gradeText = (line: ReleaseLine) =>
    line.gradeLevel === null ? t("gradeNone") : t("grade", { grade: line.gradeLevel });
  const lineName = (line: ReleaseLine) => t("lineName", { subject: line.subjectName, grade: gradeText(line) });
  const idOf = (line: ReleaseLine) => `${base}-${line.key.replace("|", "-")}`;

  /** A failed write as one sentence: the gateway's own, in Swedish, when the page has no better. */
  const failure = (error: unknown): string => {
    if (!(error instanceof ApiError)) return tCommon("error");
    if (error.code === ENGINE_RELEASE_POST_NOT_IN_YEAR) return t("notInYear");
    if (error.code === "SCHEDULE_BUSY") return t("busy");
    if (error.status === 404) return t("yearMissing");
    return apiErrorText(error, tCommon);
  };

  const write = async (ids: string[], released: boolean, focusId: string, line: string | null) => {
    setProblem(null);
    setDone(null);
    setWorking(line);
    focusAfter.current = focusId;
    try {
      const result = await set.mutateAsync({ academicYearId, requirementIds: ids, released });
      setDone(t(released ? "doneReleased" : "doneTakenBack", { count: result.changed }));
    } catch (error) {
      setProblem(failure(error));
    } finally {
      setWorking(null);
    }
  };

  const toggle = (key: string) =>
    setOpen((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const staffedTotal = lines?.reduce((sum, line) => sum + staffedIn(line), 0) ?? 0;
  const releasedStaffed = lines?.reduce((sum, line) => sum + line.posts.filter((post) => post.staffed && post.released).length, 0) ?? 0;

  return (
    <SectionCard
      id={ENGINE_RELEASE_ANCHOR}
      // Focusable by script only, like the unstaffed panel: a link to #engine-release can land focus here.
      tabIndex={-1}
      className="scroll-mt-4"
      title={t("title")}
      description={t("hint")}
    >
      {/* Always mounted, so what a press did is announced when it arrives. */}
      <div role="status" aria-live="polite" className="text-sm empty:hidden">
        {done}
      </div>
      {problem ? <Notice tone="destructive">{problem}</Notice> : null}

      {releases.isError ? (
        <LoadError variant="inline" title={t("loadFailed")} hint={t("loadFailedHint")} />
      ) : lines === null || releases.isLoading ? (
        <Skeleton className="h-32 w-full" aria-busy="true" />
      ) : lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <>
          <p className="text-sm">{t("summary", { released: releasedStaffed, staffed: staffedTotal })}</p>
          <TableScroll>
            <table className="w-full text-sm" aria-busy={pending}>
              <caption className="sr-only">{t("caption")}</caption>
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    {t("colLine")}
                  </th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                    {t("colPosts")}
                  </th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                    {t("colStaffed")}
                  </th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                    {t("colReleased")}
                  </th>
                  {readOnly ? null : (
                    <th scope="col" className="py-1.5 font-medium">
                      <span className="sr-only">{t("colActions")}</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => {
                  const expanded = open.has(line.key);
                  const lineId = idOf(line);
                  const toggleId = `${lineId}-toggle`;
                  const name = lineName(line);
                  const toRelease = idsToRelease(line);
                  const released = releasedIn(line);
                  return (
                    <Fragment key={line.key}>
                      <tr className="border-b last:border-0">
                        <th scope="row" className="py-1.5 pr-3 text-left font-medium">
                          <button
                            type="button"
                            id={toggleId}
                            className="inline-flex items-center gap-1.5 rounded-sm text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4 [&_svg]:shrink-0"
                            aria-expanded={expanded}
                            aria-controls={expanded ? `${lineId}-posts` : undefined}
                            onClick={() => toggle(line.key)}
                          >
                            {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                            {name}
                          </button>
                        </th>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{line.posts.length}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{staffedIn(line)}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{released}</td>
                        {readOnly ? null : (
                          <td className="py-1.5">
                            <div className="flex flex-wrap justify-end gap-2">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={pending || toRelease.length === 0}
                                aria-label={t("releaseAllNamed", { count: toRelease.length, line: name })}
                                onClick={() => void write(toRelease, true, toggleId, `${line.key}+`)}
                                data-writes="PLANERING"
                              >
                                {working === `${line.key}+` ? <Loader2 className="animate-spin" /> : null}
                                {t("releaseAll", { count: toRelease.length })}
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={pending || released === 0}
                                aria-label={t("takeBackAllNamed", { line: name })}
                                onClick={() => void write(idsToTakeBack(line), false, toggleId, `${line.key}-`)}
                                data-writes="PLANERING"
                              >
                                {working === `${line.key}-` ? <Loader2 className="animate-spin" /> : null}
                                {t("takeBackAll")}
                              </Button>
                            </div>
                          </td>
                        )}
                      </tr>
                      {expanded ? (
                        <tr className="border-b last:border-0">
                          <td colSpan={readOnly ? 4 : 5} className="pb-2 pl-6">
                            <ul id={`${lineId}-posts`} aria-label={t("postsOf", { line: name })} className="divide-y">
                              {line.posts.map((post) => {
                                const release = releaseOf.get(post.id);
                                const row = t("rowName", { subject: line.subjectName, group: post.groupName });
                                const switchId = `${base}-post-${post.id}`;
                                return (
                                  <li
                                    key={post.id}
                                    className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-1.5"
                                  >
                                    <div className="min-w-0">
                                      <span className="font-medium">{post.groupName}</span>
                                      <span className="block text-muted-foreground">
                                        {post.teacherId === null
                                          ? t("unstaffed")
                                          : post.staffed
                                            ? teacherName(post.teacherId)
                                            : t("teacherLeft", { teacher: teacherName(post.teacherId) })}
                                      </span>
                                      {release ? (
                                        <span className="block text-xs text-muted-foreground">
                                          {t("releasedBy", {
                                            name:
                                              release.releasedById === null
                                                ? t("releasedByRemoved")
                                                : (personName(release.releasedById) ?? t("releasedByUnknown")),
                                            date: formatReleaseDay(release.releasedAt, timeZone),
                                          })}
                                        </span>
                                      ) : null}
                                    </div>
                                    {!post.staffed ? null : readOnly ? (
                                      post.released ? (
                                        <Badge variant="secondary">{t("released")}</Badge>
                                      ) : (
                                        <span className="text-muted-foreground">{t("notReleased")}</span>
                                      )
                                    ) : (
                                      <label className="flex cursor-pointer items-center gap-2" data-writes="PLANERING">
                                        <Switch
                                          id={switchId}
                                          checked={post.released}
                                          disabled={pending}
                                          aria-label={t("releaseRow", { row })}
                                          onCheckedChange={(next) => void write([post.id], next, switchId, null)}
                                        />
                                        <span aria-hidden="true">{t("released")}</span>
                                      </label>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
        </>
      )}
    </SectionCard>
  );
}
